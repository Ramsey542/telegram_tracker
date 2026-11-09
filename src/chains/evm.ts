import { z } from 'zod';
import { createRequire } from 'node:module';
import {
  createPublicClient,
  defineChain,
  http as viemHttp,
  encodeFunctionData,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  parseAbi,
  parseAbiParameters,
  erc20Abi,
  keccak256,
  zeroAddress,
  RpcRequestError,
  type Address,
  type Hex,
  type TransactionReceipt,
  type TypedData,
} from 'viem';
import type { Config } from '../config.js';
import type { Wallets } from '../wallets.js';
import { withdrawalAddress } from '../trading/withdrawal.js';
import { insufficientFunds } from '../trading/funds.js';
import { HttpClient, HttpError, safeError } from '../infra/http.js';
import { MarketData } from '../providers/market.js';
import {
  PendingTrade,
  ReviewRequired,
  TradeRejected,
  type ChainSettings,
  type EvmStep,
  type Operation,
  type OrderStep,
  type Quote,
  type SwapResult,
  type TokenInfo,
  type Position,
  parseAmount,
} from '../domain.js';
import type { ChainAdapter } from './types.js';
import { robinhoodGasFees } from './fees.js';
import { logger } from '../logging/logger.js';
import { evmNetworks } from './networks.js';
import type { EvmChain } from '../domain.js';
import { DirectEvmRoutes, directNetworks } from './direct-evm.js';
import { NativePrices } from '../providers/native-prices.js';
import { tracedNativeDelta } from './native-flow.js';

// The router SDK's ESM build uses extensionless imports that native Node cannot resolve.
const require = createRequire(import.meta.url);
const { CommandParser, UniversalRouterVersion, UNIVERSAL_ROUTER_ADDRESS } =
  require('@uniswap/universal-router-sdk') as typeof import('@uniswap/universal-router-sdk');
const { UnsignedV3DutchOrder, REACTOR_ADDRESS_MAPPING, OrderType, PERMIT2_MAPPING } =
  require('@uniswap/uniswapx-sdk') as typeof import('@uniswap/uniswapx-sdk');

const wethAbi = [
  { type: 'function', name: 'deposit', stateMutability: 'payable', inputs: [], outputs: [] },
  {
    type: 'function',
    name: 'withdraw',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const;
const permit2Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'nonceBitmap',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'wordPos', type: 'uint256' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;
const raw = z.string().regex(/^\d+$/);
const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const permitDataSchema = z.object({
  domain: z.object({
    name: z.string(),
    chainId: z.coerce.number().int(),
    verifyingContract: addressSchema,
    version: z.string().optional(),
  }),
  types: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string() }))),
  values: z.object({
    details: z.object({
      token: addressSchema,
      amount: z.union([raw, z.number().int().nonnegative().safe()]),
      expiration: z.union([raw, z.number().int().nonnegative().safe()]),
      nonce: z.union([raw, z.number().int().nonnegative().safe()]),
    }),
    spender: addressSchema,
    sigDeadline: z.union([raw, z.number().int().nonnegative().safe()]),
  }),
});
const tokenAmountSchema = z.object({ token: addressSchema, amount: raw });
const quoteResponseSchema = z.object({
  routing: z.string(),
  quote: z.record(z.string(), z.unknown()),
  permitData: z.unknown().optional(),
});
type ApiQuote = z.infer<typeof quoteResponseSchema>;
const classicSchema = z.object({
  input: tokenAmountSchema,
  output: tokenAmountSchema,
  swapper: addressSchema,
  chainId: z.number(),
  slippage: z.number(),
  priceImpact: z.number().optional(),
  aggregatedOutputs: z
    .array(
      z.object({
        token: addressSchema,
        amount: raw,
        minAmount: raw.optional(),
        recipient: addressSchema,
        fee: z.string().optional(),
      }),
    )
    .optional(),
});
const dutchSchema = z.object({
  encodedOrder: z.string().regex(/^0x[0-9a-fA-F]+$/),
  orderId: z.string(),
  expectedAmountOut: raw.optional(),
  expectedAmountIn: raw.optional(),
});
const transactionSchema = z.object({
  to: addressSchema,
  from: addressSchema.optional(),
  data: z.string().regex(/^0x[0-9a-fA-F]+$/),
  value: z
    .string()
    .regex(/^(?:\d+|0x[0-9a-fA-F]+)$/)
    .transform((value) => BigInt(value).toString()),
  chainId: z.number(),
  gasLimit: z.unknown().optional(),
  gasPrice: z.unknown().optional(),
  maxFeePerGas: z.unknown().optional(),
  maxPriorityFeePerGas: z.unknown().optional(),
});
export function uniswapHeaders(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'x-universal-router-version': '2.1.2',
    'x-agent-info': JSON.stringify({
      integration_name: 'swap-integration',
      decision_origin: 'autonomous',
      version: '1.5.0',
    }),
  };
}
export function requestUniswapQuote(
  http: HttpClient,
  apiKey: string,
  chain: EvmChain,
  wallet: string,
  input: string,
  output: string,
  amountRaw: string,
  settings: ChainSettings,
) {
  if (settings.slippagePercent === null) throw new TradeRejected('Configure slippage first');
  return http.json(
    'Uniswap quote',
    'https://trade-api.gateway.uniswap.org/v1/quote',
    quoteResponseSchema,
    {
      method: 'POST',
      headers: uniswapHeaders(apiKey),
      body: {
        tokenIn: input,
        tokenOut: output,
        tokenInChainId: evmNetworks[chain].chainId,
        tokenOutChainId: evmNetworks[chain].chainId,
        type: 'EXACT_INPUT',
        amount: amountRaw,
        swapper: wallet,
        recipient: wallet,
        slippageTolerance: settings.slippagePercent,
        routingPreference: 'BEST_PRICE',
        protocols: settings.mevProtection ? ['UNISWAPX_V3'] : ['V2', 'V3', 'V4'],
        integratorFees: [],
        enforceExactIn: true,
        permitAmount: 'EXACT',
      },
    },
  );
}
export function requestUniswapSwap(
  http: HttpClient,
  apiKey: string,
  body: Record<string, unknown>,
) {
  return http.json(
    'Uniswap swap build',
    'https://trade-api.gateway.uniswap.org/v1/swap',
    z.object({ swap: transactionSchema }),
    { method: 'POST', headers: uniswapHeaders(apiKey), body },
  );
}
const strictSwapSchema = transactionSchema
  .extend({
    gasLimit: raw.refine((value) => BigInt(value) > 0n),
    maxFeePerGas: raw.refine((value) => BigInt(value) > 0n),
    maxPriorityFeePerGas: raw,
  })
  .refine((swap) => BigInt(swap.maxFeePerGas) >= BigInt(swap.maxPriorityFeePerGas));
const routeTokenSchema = z.object({
  address: addressSchema,
  chainId: z.number().int(),
  symbol: z.string().trim().min(1).max(64),
  decimals: z
    .union([raw, z.number().int()])
    .transform(Number)
    .pipe(z.number().int().min(0).max(36)),
});
type EvmParameters = {
  gas: bigint;
  nonce: number;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
};
const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
function signingValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if ('_isBigNumber' in value && value._isBigNumber === true) return String(value);
  if (Array.isArray(value)) return value.map(signingValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, signingValue(entry)]),
  );
}

export function erc20Delta(receipt: TransactionReceipt, token: string, owner: string): bigint {
  let delta = 0n;
  for (const log of receipt.logs) {
    if (!same(log.address, token)) continue;
    try {
      const event = decodeEventLog({
        abi: erc20Abi,
        eventName: 'Transfer',
        data: log.data,
        topics: log.topics,
      });
      if (same(event.args.to, owner)) delta += event.args.value;
      if (same(event.args.from, owner)) delta -= event.args.value;
    } catch {
      continue;
    }
  }
  return delta;
}

export function validateClassicCalldata(
  data: string,
  owner: string,
  router: string = UNIVERSAL_ROUTER_ADDRESS(UniversalRouterVersion.V2_1_2, 4663),
): void {
  const call = CommandParser.parseCalldata(data, UniversalRouterVersion.V2_1_2);
  const permitted = new Set([
    'V2_SWAP_EXACT_IN',
    'V3_SWAP_EXACT_IN',
    'V4_SWAP',
    'PERMIT2_TRANSFER_FROM',
    'PERMIT2_PERMIT',
    'SWEEP',
    'TRANSFER',
    'BALANCE_CHECK_ERC20',
  ]);
  const recipients = [
    owner,
    router,
    '0x0000000000000000000000000000000000000001',
    '0x0000000000000000000000000000000000000002',
  ];
  const inspect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) inspect(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (
      item.name === 'recipient' &&
      typeof item.value === 'string' &&
      !recipients.some((recipient) => same(recipient, item.value as string))
    )
      throw new TradeRejected('Swap calldata sends tokens to an unexpected recipient');
    for (const nested of Object.values(item))
      if (nested && typeof nested === 'object') inspect(nested);
  };
  if (call.commands.length === 0) throw new TradeRejected('Empty Uniswap swap');
  for (const command of call.commands) {
    if (!permitted.has(command.commandName))
      throw new TradeRejected(`Unsupported swap command: ${command.commandName}`);
    inspect(command.params);
  }
}

export class EvmAdapter implements ChainAdapter {
  readonly chain: EvmChain;
  private readonly network;
  private readonly rpcUrl: string;
  private readonly account: Wallets[EvmChain];
  private readonly router: Address;
  private readonly permit2: Address;
  private readonly reactor: string | undefined;
  private readonly log;
  readonly address: Address;
  private readonly client;
  private beforeSpend: () => void = () => {};
  private networkVerification: Promise<void> | null = null;
  private readonly metadataCache = new Map<string, { decimals: number; expiresAt: number }>();
  private readonly metadataRequests = new Map<string, Promise<number>>();
  private readonly nativePrices: NativePrices;
  private nativeTraceSupport: Promise<void> | null = null;
  private directRoutes(): DirectEvmRoutes {
    return new DirectEvmRoutes(this.chain, this.rpc(), this.address);
  }
  constructor(
    private readonly config: Config,
    wallets: Wallets,
    private readonly http: HttpClient,
    private readonly market: MarketData,
    chainKey: EvmChain,
  ) {
    this.chain = chainKey;
    this.nativePrices = new NativePrices(http);
    this.network = evmNetworks[chainKey];
    this.rpcUrl = (chainKey === 'bnb' ? config.bnbRpc : config.robinhoodRpc) ?? '';
    this.account = wallets[chainKey];
    this.address = this.account.address;
    this.router = UNIVERSAL_ROUTER_ADDRESS(
      UniversalRouterVersion.V2_1_2,
      this.network.chainId,
    ) as Address;
    this.permit2 = PERMIT2_MAPPING[this.network.chainId] as Address;
    this.reactor = REACTOR_ADDRESS_MAPPING[this.network.chainId]?.[OrderType.Dutch_V3];
    this.log = logger.child({ component: `trading.${chainKey}`, chain: chainKey });
    const chain = defineChain({
      id: this.network.chainId,
      name: this.network.name,
      nativeCurrency: { name: this.network.symbol, symbol: this.network.symbol, decimals: 18 },
      contracts: {
        multicall3: {
          address:
            chainKey === 'bnb'
              ? '0xca11bde05977b3631167028862be2a173976ca11'
              : '0xd59aae32bcf95aae58119751d5e355c9855cdc31',
        },
      },
      rpcUrls: { default: { http: this.rpcUrl ? [this.rpcUrl] : [] } },
    });
    this.client = this.rpcUrl
      ? createPublicClient({
          chain,
          transport: viemHttp(this.rpcUrl, {
            retryCount: 0,
            timeout: config.httpTimeoutMs,
            fetchFn: (input, init) =>
              this.http.fetch(`QuickNode ${this.network.name} RPC`, input, init),
          }),
        })
      : null;
  }
  private rpc() {
    if (!this.client) throw new Error(`${this.network.rpcVariable} is missing`);
    return this.client;
  }
  private headers(): Record<string, string> {
    return uniswapHeaders(this.config.uniswapKey);
  }
  readiness(settings: ChainSettings): string[] {
    return [
      !this.rpcUrl ? this.network.rpcVariable : '',
      !settings.directTradingEnabled && !this.config.uniswapKey ? 'UNISWAP_API_KEY' : '',
    ].filter(Boolean);
  }
  async verifyNetwork(): Promise<void> {
    this.networkVerification ??= this.rpc()
      .getChainId()
      .then((chainId) => {
        if (chainId !== this.network.chainId)
          throw new Error(`${this.network.name} RPC endpoint has the wrong chain ID`);
      })
      .catch((error: unknown) => {
        this.networkVerification = null;
        throw error;
      });
    await this.networkVerification;
  }
  async balance(): Promise<{ nativeRaw: string; wrappedRaw: string }> {
    const [native, wrapped] = await Promise.all([
      this.rpc().getBalance({ address: this.address }),
      this.rpc().readContract({
        address: this.network.wrappedNative,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [this.address],
      }),
    ]);
    return { nativeRaw: native.toString(), wrappedRaw: wrapped.toString() };
  }
  async tokenInfo(address: string, settings?: ChainSettings): Promise<TokenInfo> {
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(address) ||
      same(address, this.network.wrappedNative) ||
      same(address, zeroAddress)
    )
      throw new TradeRejected('Invalid project token address');
    const tokenAddress = address as Address;
    if (settings?.directTradingEnabled && !settings.mevProtection) {
      const state = await this.directRoutes().flapState(tokenAddress);
      if (state && state.quoteTokenAddress === zeroAddress && state.price > 0n) {
        const [decimals, supply, rate, symbol] = await Promise.all([
          this.tokenDecimals(tokenAddress),
          this.rpc().readContract({
            address: tokenAddress,
            abi: erc20Abi,
            functionName: 'totalSupply',
          }),
          this.nativePrices.get(this.chain),
          this.rpc().readContract({ address: tokenAddress, abi: erc20Abi, functionName: 'symbol' }),
        ]);
        const price = (Number(state.price) / 1e18) * rate.value;
        return {
          chain: this.chain,
          address: address.toLowerCase(),
          symbol,
          decimals,
          marketCapUsd: (Number(supply) / 10 ** decimals) * price,
          usdPrice: price,
          liquidityUsd:
            state.status === 1
              ? (Number(state.reserve) / 1e18) * rate.value
              : ((await this.market.evm(this.chain, address, false))?.liquidity?.usd ?? null),
          marketSource: 'flap-onchain',
          fetchedAt: Date.now(),
        };
      }
    }
    const classicBuy = settings !== undefined && !settings.mevProtection;
    const needsMarket =
      !classicBuy || settings.filters.marketCapEnabled || settings.filters.minLiquidityUsd !== null;
    const [decimals, metadata] = await Promise.all([
      classicBuy ? Promise.resolve(null) : this.tokenDecimals(tokenAddress),
      needsMarket ? this.market.evm(this.chain, address, !classicBuy) : Promise.resolve(null),
    ]);
    return {
      chain: this.chain,
      address: address.toLowerCase(),
      symbol: metadata?.baseToken.symbol ?? address.slice(0, 8),
      decimals,
      marketCapUsd: metadata?.marketCap ?? null,
      liquidityUsd: metadata?.liquidity?.usd ?? null,
      usdPrice:
        metadata?.priceUsd && Number.isFinite(Number(metadata.priceUsd))
          ? Number(metadata.priceUsd)
          : null,
      fetchedAt: Date.now(),
    };
  }
  private classicBuyMetadata(
    response: ApiQuote,
    address: string,
  ): { symbol: string; decimals: number } {
    const route = z
      .object({ route: z.array(z.array(z.object({ tokenOut: z.unknown() }))).min(1) })
      .safeParse(response.quote);
    if (!route.success)
      throw new TradeRejected(
        'Uniswap quote is missing output token metadata (symbol and decimals)',
      );
    const tokens = route.data.route.flat().flatMap(({ tokenOut }) => {
      if (
        !tokenOut ||
        typeof tokenOut !== 'object' ||
        !('address' in tokenOut) ||
        typeof tokenOut.address !== 'string' ||
        !same(tokenOut.address, address)
      )
        return [];
      const parsed = routeTokenSchema.safeParse(tokenOut);
      if (!parsed.success || parsed.data.chainId !== this.network.chainId)
        throw new TradeRejected('Uniswap quote has invalid output token metadata');
      return [parsed.data];
    });
    const token = tokens[0];
    if (!token)
      throw new TradeRejected(
        'Uniswap quote is missing output token metadata (symbol and decimals)',
      );
    if (tokens.some((item) => item.decimals !== token.decimals || item.symbol !== token.symbol))
      throw new TradeRejected('Uniswap quote has conflicting output token metadata');
    return { symbol: token.symbol, decimals: token.decimals };
  }
  private async tokenDecimals(address: Address): Promise<number> {
    const key = address.toLowerCase();
    const cached = this.metadataCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.log.info('token.metadata_reused', {
        token: key,
        validForMs: cached.expiresAt - Date.now(),
      });
      return cached.decimals;
    }
    const pending = this.metadataRequests.get(key);
    if (pending) return pending;
    const request = Promise.all([
      this.rpc().getCode({ address }),
      this.rpc().readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
    ]).then(([code, decimals]) => {
      if (!code || code === '0x' || decimals > 36)
        throw new TradeRejected('Address is not a supported ERC-20 token');
      if (this.metadataCache.size >= 512)
        this.metadataCache.delete(this.metadataCache.keys().next().value!);
      this.metadataCache.set(key, { decimals, expiresAt: Date.now() + 60_000 });
      return decimals;
    });
    this.metadataRequests.set(key, request);
    try {
      return await request;
    } finally {
      this.metadataRequests.delete(key);
    }
  }
  private async fetchQuote(
    input: string,
    output: string,
    amountRaw: string,
    settings: ChainSettings,
  ): Promise<ApiQuote> {
    const slippage = settings.slippagePercent;
    if (slippage === null) throw new TradeRejected('Configure slippage first');
    const response = await requestUniswapQuote(
      this.http,
      this.config.uniswapKey,
      this.chain,
      this.address,
      input,
      output,
      amountRaw,
      settings,
    );
    this.validateQuote(response, input, output, amountRaw, slippage);
    if (settings.mevProtection && response.routing !== 'DUTCH_V3')
      throw new TradeRejected('A protected UniswapX route is unavailable');
    if (!settings.mevProtection && response.routing !== 'CLASSIC')
      throw new TradeRejected('Unsupported Uniswap route');
    return response;
  }
  private validateQuote(
    response: ApiQuote,
    input: string,
    output: string,
    amountRaw: string,
    slippage: number,
  ): { outputRaw: bigint; minimumRaw: bigint; impact: number | null } {
    if (response.routing === 'CLASSIC') {
      const quote = classicSchema.parse(response.quote);
      if (
        quote.chainId !== this.network.chainId ||
        !same(quote.swapper, this.address) ||
        !same(quote.input.token, input) ||
        !same(quote.output.token, output) ||
        quote.input.amount !== amountRaw ||
        quote.slippage > slippage
      )
        throw new TradeRejected('Uniswap quote does not match the requested trade');
      const allocations = quote.aggregatedOutputs;
      if (
        allocations?.some(
          (allocation) =>
            !same(allocation.recipient, this.address) ||
            !same(allocation.token, output) ||
            allocation.fee,
        )
      )
        throw new TradeRejected('Uniswap quote contains an unexpected output allocation');
      const outputRaw = allocations?.length
        ? allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount), 0n)
        : BigInt(quote.output.amount);
      const minimumRaw =
        allocations?.length && allocations.every((allocation) => allocation.minAmount !== undefined)
          ? allocations.reduce((sum, allocation) => sum + BigInt(allocation.minAmount!), 0n)
          : (outputRaw * BigInt(10_000 - Math.round(slippage * 100))) / 10_000n;
      if (outputRaw <= 0n || minimumRaw <= 0n)
        throw new TradeRejected('Uniswap returned an empty quote');
      return { outputRaw, minimumRaw, impact: quote.priceImpact ?? null };
    }
    if (response.routing !== 'DUTCH_V3') throw new TradeRejected('Unsupported Uniswap quote type');
    const quote = dutchSchema.parse(response.quote);
    const order = UnsignedV3DutchOrder.parse(
      quote.encodedOrder,
      this.network.chainId,
      this.permit2,
    );
    if (
      !this.reactor ||
      !same(order.info.reactor, this.reactor) ||
      !same(order.info.swapper, this.address) ||
      !same(order.info.input.token, input) ||
      BigInt(order.info.input.maxAmount.toString()) > BigInt(amountRaw) ||
      order.info.input.startAmount.toString() !== amountRaw ||
      order.info.deadline <= Date.now() / 1000 + 5 ||
      order.info.deadline > Date.now() / 1000 + 3600 ||
      !same(order.info.additionalValidationContract, zeroAddress)
    )
      throw new TradeRejected('UniswapX order permissions do not match the trade');
    if (
      order.info.outputs.length === 0 ||
      order.info.outputs.some(
        (item) => !same(item.token, output) || !same(item.recipient, this.address),
      )
    )
      throw new TradeRejected('UniswapX order has unexpected recipients or output tokens');
    if (!same(order.hash(), quote.orderId))
      throw new TradeRejected('UniswapX order identity does not match its encoding');
    const outputRaw = order.info.outputs.reduce(
      (sum, item) => sum + BigInt(item.startAmount.toString()),
      0n,
    );
    const minimumRaw = order.info.outputs.reduce(
      (sum, item) => sum + BigInt(item.minAmount.toString()),
      0n,
    );
    if (
      minimumRaw <= 0n ||
      minimumRaw * 10_000n < outputRaw * BigInt(10_000 - Math.round(slippage * 100))
    )
      throw new TradeRejected('UniswapX auction exceeds your slippage tolerance');
    return { outputRaw, minimumRaw, impact: null };
  }
  async quoteSell(address: string, amountRaw: string, settings: ChainSettings): Promise<Quote> {
    if (settings.directTradingEnabled && !settings.mevProtection) {
      const direct = await this.directRoutes().quote(
        address as Address,
        BigInt(amountRaw),
        false,
        settings.slippagePercent!,
      );
      if (direct)
        return {
          inputRaw: amountRaw,
          outputRaw: direct.outputRaw,
          minOutputRaw: direct.minimumRaw,
          nativeUsd: null,
          priceImpactPercent: null,
          receivedAt: direct.receivedAt,
          source: `direct:${direct.venue}`,
        };
    }
    const response = await this.fetchQuote(
      address,
      this.network.wrappedNative,
      amountRaw,
      settings,
    );
    const quote = this.validateQuote(
      response,
      address,
      this.network.wrappedNative,
      amountRaw,
      settings.slippagePercent!,
    );
    const result: Quote = {
      inputRaw: amountRaw,
      outputRaw: quote.outputRaw.toString(),
      minOutputRaw: quote.minimumRaw.toString(),
      nativeUsd: null,
      priceImpactPercent: quote.impact,
      receivedAt: Date.now(),
    };
    return result;
  }
  async advance(
    operation: Operation,
    persist: () => void,
    beforeSwap: () => Promise<void>,
    beforeSpend: () => void,
  ): Promise<SwapResult> {
    if (operation.chain !== this.chain)
      throw new TradeRejected('Operation belongs to another chain');
    if (this.config.listenOnly)
      throw new TradeRejected(`LISTEN_ONLY=true: ${this.network.name} execution is blocked`);
    this.beforeSpend = beforeSpend;
    await this.verifyNetwork();
    const classicBuy = operation.kind === 'buy' && !operation.settings.mevProtection;
    if (
      operation.settings.directTradingEnabled &&
      operation.settings.mevProtection &&
      (operation.kind === 'buy' || operation.kind === 'sell')
    )
      throw new TradeRejected('Direct EVM routes require UniswapX protection to be disabled');
    if (operation.kind === 'buy' || operation.kind === 'sell') {
      if (operation.directEvmPlan) return this.advanceDirect(operation, persist, beforeSwap);
      if (
        operation.settings.directTradingEnabled &&
        !operation.settings.mevProtection &&
        operation.steps.length === 0 &&
        !operation.preparedQuote
      ) {
        const plan = await this.directRoutes().quote(
          operation.address as Address,
          BigInt(operation.amountRaw),
          operation.kind === 'buy',
          operation.settings.slippagePercent!,
        );
        if (plan) {
          operation.directEvmPlan = plan;
          persist();
          return this.advanceDirect(operation, persist, beforeSwap);
        }
      }
    }
    if (operation.kind === 'withdraw') {
      if (!operation.withdrawal) throw new TradeRejected('Withdrawal destination is missing');
      const recipient = withdrawalAddress(this.chain, operation.withdrawal.recipient, this.address);
      if (BigInt(operation.amountRaw) <= 0n)
        throw new TradeRejected('Withdrawal amount must be greater than zero');
      const receipt = await this.evmStep(
        operation,
        'withdraw',
        recipient as Address,
        '0x',
        BigInt(operation.amountRaw),
        persist,
      );
      operation.swapHash = receipt.transactionHash;
      return {
        tokenRaw: '0',
        nativeRaw: (BigInt(operation.amountRaw) + this.fees(operation)).toString(),
        feeNativeRaw: this.fees(operation).toString(),
        signature: receipt.transactionHash,
        nativeUsd: null,
      };
    }
    if (operation.kind === 'wrap' || operation.kind === 'unwrap') {
      const wrap = operation.kind === 'wrap';
      const receipt = await this.evmStep(
        operation,
        operation.kind,
        this.network.wrappedNative,
        wrap
          ? encodeFunctionData({ abi: wethAbi, functionName: 'deposit' })
          : encodeFunctionData({
              abi: wethAbi,
              functionName: 'withdraw',
              args: [BigInt(operation.amountRaw)],
            }),
        wrap ? BigInt(operation.amountRaw) : 0n,
        persist,
      );
      if (wrap) await this.approveToken(operation, this.network.wrappedNative, persist);
      operation.swapHash = receipt.transactionHash;
      return {
        tokenRaw: '0',
        nativeRaw: (wrap
          ? BigInt(operation.amountRaw) + this.fees(operation)
          : BigInt(operation.amountRaw) - this.fees(operation)
        ).toString(),
        feeNativeRaw: this.fees(operation).toString(),
        signature: receipt.transactionHash,
        nativeUsd: null,
      };
    }
    if (operation.kind === 'buy' && !classicBuy && operation.wrapAmountRaw === undefined) {
      let shortfall = operation.steps.some((step) => step.type === 'evm' && step.key === 'wrap')
        ? BigInt(operation.amountRaw)
        : 0n;
      if (shortfall === 0n && operation.settings.wrapMyEth) {
        const wrapped = await this.rpc().readContract({
          address: this.network.wrappedNative,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [this.address],
        });
        shortfall =
          BigInt(operation.amountRaw) > wrapped ? BigInt(operation.amountRaw) - wrapped : 0n;
      }
      operation.wrapAmountRaw = shortfall.toString();
      persist();
    }
    const input =
      operation.kind === 'buy' ? this.network.wrappedNative : (operation.address as Address);
    const output =
      operation.kind === 'buy' ? (operation.address as Address) : this.network.wrappedNative;
    let swapReceipt: TransactionReceipt;
    if (operation.swapHash) swapReceipt = await this.confirmReceipt(operation.swapHash as Hex);
    else {
      const pending = operation.steps.find((step) => step.key === 'swap');
      if (pending?.type === 'evm')
        swapReceipt = await this.evmStep(operation, 'swap', this.router, '0x', 0n, persist);
      else if (pending?.type === 'order')
        swapReceipt = await this.orderStep(operation, pending, persist);
      else {
        let swapNonce: number | undefined;
        if (!operation.preparedQuote) {
          const [quoted, , nonce] = await Promise.all([
            this.fetchQuote(input, output, operation.amountRaw, operation.settings).then(
              (response) => ({ response, receivedAt: Date.now() }),
            ),
            beforeSwap(),
            classicBuy
              ? this.rpc().getTransactionCount({ address: this.address, blockTag: 'pending' })
              : Promise.resolve(undefined),
          ]);
          swapNonce = nonce;
          operation.preparedQuote = {
            provider: 'uniswap',
            response: quoted.response,
            receivedAt: quoted.receivedAt,
            inputRaw: operation.amountRaw,
            slippagePercent: operation.settings.slippagePercent!,
            priorityFee: operation.settings.priorityFee,
          };
          persist();
        } else if (operation.kind === 'buy') {
          const [, nonce] = await Promise.all([
            beforeSwap(),
            classicBuy
              ? this.rpc().getTransactionCount({ address: this.address, blockTag: 'pending' })
              : Promise.resolve(undefined),
          ]);
          swapNonce = nonce;
        }
        const prepared = operation.preparedQuote;
        if (
          prepared.provider !== 'uniswap' ||
          prepared.inputRaw !== operation.amountRaw ||
          prepared.slippagePercent !== operation.settings.slippagePercent ||
          Date.now() - prepared.receivedAt > 30_000
        )
          throw new TradeRejected(
            'The original Uniswap quote expired or no longer matches the trade',
          );
        const response = quoteResponseSchema.parse(prepared.response);
        if (classicBuy) {
          if (response.routing !== 'CLASSIC')
            throw new TradeRejected('Classic buys require a Uniswap CLASSIC quote');
          const failures = response.quote.txFailureReasons;
          if (Array.isArray(failures) && failures.length > 0)
            throw new TradeRejected(`Uniswap quote simulation failed: ${failures.join(', ')}`);
          operation.token = {
            ...operation.token,
            ...this.classicBuyMetadata(response, operation.address),
          };
        }
        const quote = this.validateQuote(
          response,
          input,
          output,
          operation.amountRaw,
          operation.settings.slippagePercent!,
        );
        const limit = operation.settings.filters.maxPriceImpactPercent;
        if (
          operation.kind === 'buy' &&
          limit !== null &&
          (quote.impact === null || Math.abs(quote.impact) > limit)
        )
          throw new TradeRejected('Price impact is unknown or exceeds the maximum');
        operation.quote = {
          inputRaw: operation.amountRaw,
          outputRaw: quote.outputRaw.toString(),
          minOutputRaw: quote.minimumRaw.toString(),
          nativeUsd: null,
          priceImpactPercent: quote.impact,
          receivedAt: prepared.receivedAt,
        };
        persist();
        if (
          operation.kind === 'buy' &&
          !classicBuy &&
          BigInt(operation.wrapAmountRaw ?? operation.amountRaw) > 0n
        )
          await this.evmStep(
            operation,
            'wrap',
            this.network.wrappedNative,
            encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
            BigInt(operation.wrapAmountRaw ?? operation.amountRaw),
            persist,
          );
        if (classicBuy) {
          // Reconcile preparation transactions saved by older versions without creating new ones.
          for (const step of operation.steps)
            if (step.type === 'evm' && step.key !== 'swap')
              await this.evmStep(operation, step.key, input, '0x', 0n, persist);
          if (operation.steps.length > 0)
            swapNonce = await this.rpc().getTransactionCount({
              address: this.address,
              blockTag: 'pending',
            });
        } else {
          await this.approveToken(operation, input, persist);
          if (!operation.settings.mevProtection && response.permitData === undefined)
            await this.approveRouter(operation, input, persist);
        }
        if (Date.now() - prepared.receivedAt > 30_000)
          throw new TradeRejected(
            'The original Uniswap quote expired during transaction preparation',
          );
        if (response.routing === 'DUTCH_V3') {
          const dutch = dutchSchema.parse(response.quote);
          const order = UnsignedV3DutchOrder.parse(
            dutch.encodedOrder,
            this.network.chainId,
            this.permit2,
          );
          const permit = order.permitData();
          const domain = {
            name: 'Permit2',
            chainId: this.network.chainId,
            verifyingContract: this.permit2,
          };
          const primaryType = Object.keys(permit.types).find((key) =>
            key.startsWith('PermitWitness'),
          );
          if (!primaryType) throw new TradeRejected('UniswapX signing schema is unsupported');
          const message = signingValue(permit.values) as Record<string, unknown>;
          this.beforeSpend();
          const signature = await this.account.signTypedData({
            domain,
            types: permit.types as unknown as TypedData,
            primaryType,
            message,
          });
          this.beforeSpend();
          const step: OrderStep = {
            type: 'order',
            key: 'swap',
            orderId: dutch.orderId,
            body: { quote: response.quote, routing: response.routing, signature },
            deadline: order.info.deadline,
            submittedAt: null,
            txHash: null,
          };
          operation.steps.push(step);
          persist();
          swapReceipt = await this.orderStep(operation, step, persist);
        } else {
          const permit = await this.signPermit(response, input, operation.amountRaw);
          const result = await requestUniswapSwap(this.http, this.config.uniswapKey, {
            quote: response.quote,
            ...permit,
            simulateTransaction: true,
            refreshGasPrice: true,
            ...(classicBuy && this.chain !== 'bnb' && operation.settings.priorityFee !== null
              ? {
                  urgency: {
                    level: 'normal',
                    overrides: {
                      maxPriorityFeePerGas: parseAmount(
                        operation.settings.priorityFee,
                        9,
                      ).toString(),
                    },
                  },
                }
              : {}),
            deadline: Math.floor(Date.now() / 1000) + 120,
          });
          if (
            !same(result.swap.to, this.router) ||
            result.swap.chainId !== this.network.chainId ||
            (result.swap.from && !same(result.swap.from, this.address)) ||
            BigInt(result.swap.value) !== 0n
          )
            throw new TradeRejected(
              'Uniswap swap transaction has an unexpected destination or value',
            );
          validateClassicCalldata(result.swap.data, this.address, this.router);
          if (Date.now() - prepared.receivedAt > 30_000)
            throw new TradeRejected('The original Uniswap quote expired during swap construction');
          let parameters: EvmParameters | undefined;
          if (classicBuy && this.chain === 'bnb') {
            const gas = raw.parse(result.swap.gasLimit);
            const automatic = raw.parse(result.swap.gasPrice ?? result.swap.maxFeePerGas);
            const gasPrice =
              operation.settings.priorityFee === null
                ? BigInt(automatic)
                : parseAmount(operation.settings.priorityFee, 9);
            if (BigInt(gas) <= 0n || gasPrice <= 0n || swapNonce === undefined)
              throw new TradeRejected('Uniswap BNB gas fields or pending nonce are invalid');
            parameters = { gas: BigInt(gas), nonce: swapNonce, gasPrice };
          } else if (classicBuy) {
            const parsed = strictSwapSchema.safeParse(result.swap);
            if (!parsed.success)
              throw new TradeRejected(
                'Uniswap swap is missing or has invalid gas fields (gasLimit, maxFeePerGas, maxPriorityFeePerGas)',
              );
            const swap = parsed.data;
            if (swapNonce === undefined)
              throw new TradeRejected('The pending transaction nonce is unavailable');
            const priority =
              operation.settings.priorityFee === null
                ? BigInt(swap.maxPriorityFeePerGas)
                : parseAmount(operation.settings.priorityFee, 9);
            if (BigInt(swap.maxFeePerGas) < priority)
              throw new TradeRejected(
                'Uniswap maximum gas fee is below the configured priority fee',
              );
            if (Date.now() - prepared.receivedAt > 30_000)
              throw new TradeRejected(
                'The original Uniswap quote expired during swap construction',
              );
            parameters = {
              gas: BigInt(swap.gasLimit),
              nonce: swapNonce,
              maxFeePerGas: BigInt(swap.maxFeePerGas),
              maxPriorityFeePerGas: priority,
            };
          }
          swapReceipt = await this.evmStep(
            operation,
            'swap',
            this.router,
            result.swap.data as Hex,
            0n,
            persist,
            parameters,
          );
        }
      }
      operation.swapHash = swapReceipt.transactionHash;
      const actualInput = -erc20Delta(swapReceipt, input, this.address);
      const actualOutput = erc20Delta(swapReceipt, output, this.address);
      if (actualInput !== BigInt(operation.amountRaw) || actualOutput <= 0n)
        throw new ReviewRequired(
          `Confirmed ${this.network.name} swap has unexpected token transfers`,
        );
      operation.outputRaw = actualOutput.toString();
      persist();
    }
    const outputRaw = operation.outputRaw;
    if (!outputRaw) throw new ReviewRequired('Confirmed swap output is missing');
    let fundsError: string | undefined;
    if (operation.kind === 'sell')
      try {
        await this.evmStep(
          operation,
          'unwrap',
          this.network.wrappedNative,
          encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [BigInt(outputRaw)] }),
          0n,
          persist,
        );
      } catch (error) {
        if (!insufficientFunds(error)) throw error;
        fundsError = safeError(error);
        this.log.error('transaction.unwrap_insufficient_funds', error, {
          operationId: operation.id,
          swapHash: operation.swapHash,
        });
      }
    const fees = this.fees(operation);
    return {
      tokenRaw: operation.kind === 'buy' ? outputRaw : operation.amountRaw,
      nativeRaw: (operation.kind === 'buy'
        ? BigInt(operation.amountRaw) + fees
        : BigInt(outputRaw) - fees
      ).toString(),
      feeNativeRaw: fees.toString(),
      signature: swapReceipt.transactionHash,
      nativeUsd: null,
      ...(fundsError ? { fundsError } : {}),
    };
  }
  async directReference(position: Position): Promise<Quote> {
    const unit = 10n ** BigInt(position.decimals);
    const state = await this.directRoutes().flapState(position.address as Address);
    if (state && state.quoteTokenAddress === zeroAddress && state.price > 0n) {
      const output = (BigInt(position.remainingTokenRaw) * state.price) / unit;
      return {
        inputRaw: position.remainingTokenRaw,
        outputRaw: output.toString(),
        minOutputRaw: output.toString(),
        nativeUsd: null,
        priceImpactPercent: null,
        receivedAt: Date.now(),
        source: 'direct:flap',
        estimated: true,
      };
    }
    const plan = await this.directRoutes().quote(position.address as Address, unit, false, 0.1);
    if (!plan) throw new Error('No direct route is available for this position');
    const value = (BigInt(plan.outputRaw) * BigInt(position.remainingTokenRaw)) / unit;
    return {
      inputRaw: position.remainingTokenRaw,
      outputRaw: value.toString(),
      minOutputRaw: value.toString(),
      nativeUsd: null,
      priceImpactPercent: null,
      receivedAt: Date.now(),
      source: `direct:${plan.venue}`,
      estimated: true,
    };
  }
  private async advanceDirect(
    operation: Operation,
    persist: () => void,
    beforeSwap: () => Promise<void>,
  ): Promise<SwapResult> {
    const plan = operation.directEvmPlan!;
    const network = directNetworks[this.chain];
    const permitted = [network.portal, network.v2, network.smart, network.infinity].map((value) =>
      value.toLowerCase(),
    );
    if (
      plan.permit2 &&
      (plan.venue !== 'pancake-infinity' ||
        plan.permit2.toLowerCase() !== '0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768')
    )
      throw new TradeRejected('Direct Permit2 contract is not trusted');
    if (
      !permitted.includes(plan.to.toLowerCase()) ||
      BigInt(plan.value) < 0n ||
      BigInt(plan.value) > BigInt(operation.amountRaw) ||
      (operation.kind === 'sell' && plan.value !== '0')
    )
      throw new TradeRejected('Direct transaction destination or value is invalid');
    const buy = operation.kind === 'buy';
    if (!operation.steps.some((step) => step.key === 'swap')) {
      if (plan.venue === 'flap' && plan.flapQuoteToken && !same(plan.flapQuoteToken, zeroAddress))
        await this.ensureNativeTraceSupport();
      await beforeSwap();
      operation.token.decimals = await this.tokenDecimals(operation.address as Address);
      if (buy && operation.settings.filters.maxPriceImpactPercent !== null) {
        const reference = await this.directReference({
          address: operation.address,
          decimals: operation.token.decimals,
          remainingTokenRaw: (10n ** BigInt(operation.token.decimals)).toString(),
        } as Position);
        const expected =
          (Number(operation.amountRaw) / Number(reference.outputRaw)) *
          10 ** operation.token.decimals;
        const impact = Math.max(0, (1 - Number(plan.outputRaw) / expected) * 100);
        if (!Number.isFinite(impact) || impact > operation.settings.filters.maxPriceImpactPercent)
          throw new TradeRejected('Direct route price impact exceeds the configured entry filter');
      }
      if (
        buy &&
        plan.venue !== 'flap' &&
        operation.settings.wrapMyEth &&
        operation.wrapAmountRaw === undefined
      ) {
        const balance = await this.rpc().readContract({
          address: this.network.wrappedNative,
          abi: erc20Abi,
          functionName: 'balanceOf',
          args: [this.address],
        });
        operation.wrapAmountRaw = (
          BigInt(operation.amountRaw) > balance ? BigInt(operation.amountRaw) - balance : 0n
        ).toString();
        persist();
      }
      if (buy && plan.venue !== 'flap' && BigInt(operation.wrapAmountRaw ?? '0') > 0n)
        await this.evmStep(
          operation,
          'wrap',
          this.network.wrappedNative,
          encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
          BigInt(operation.wrapAmountRaw!),
          persist,
        );
      if (plan.spender) {
        const spender = plan.spender as Address;
        if (spender.toLowerCase() !== (plan.permit2 ?? plan.to).toLowerCase())
          throw new TradeRejected('Direct token approval has an unexpected spender');
        for (const key of ['direct-approve-reset', 'direct-approve'])
          if (operation.steps.some((step) => step.key === key))
            await this.evmStep(operation, key, plan.inputToken as Address, '0x', 0n, persist);
        const allowance = await this.rpc().readContract({
          address: plan.inputToken as Address,
          abi: erc20Abi,
          functionName: 'allowance',
          args: [this.address, spender],
        });
        if (allowance < BigInt(operation.amountRaw)) {
          if (operation.steps.some((step) => step.key === 'direct-approve'))
            throw new TradeRejected('Direct token allowance changed after approval');
          if (allowance > 0n)
            await this.evmStep(
              operation,
              'direct-approve-reset',
              plan.inputToken as Address,
              encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, 0n] }),
              0n,
              persist,
            );
          await this.evmStep(
            operation,
            'direct-approve',
            plan.inputToken as Address,
            encodeFunctionData({
              abi: erc20Abi,
              functionName: 'approve',
              args: [spender, BigInt(operation.amountRaw)],
            }),
            0n,
            persist,
          );
        }
      }
      if (Date.now() - plan.receivedAt > 30_000)
        throw new TradeRejected('The original direct quote expired during preparation');
      if (plan.permit2 && !plan.permitSigned) {
        const [, , nonce] = await this.rpc().readContract({
          address: plan.permit2 as Address,
          abi: permit2Abi,
          functionName: 'allowance',
          args: [this.address, plan.inputToken as Address, plan.to as Address],
        });
        const details = {
          token: plan.inputToken as Address,
          amount: BigInt(operation.amountRaw),
          expiration: Math.floor(Date.now() / 1000) + 120,
          nonce,
        };
        const sigDeadline = BigInt(details.expiration);
        if (details.amount >= 1n << 160n)
          throw new TradeRejected('Direct Permit2 amount is out of range');
        this.beforeSpend();
        const signature = await this.account.signTypedData({
          domain: {
            name: 'Permit2',
            chainId: this.network.chainId,
            verifyingContract: plan.permit2 as Address,
          },
          types: {
            PermitDetails: [
              { name: 'token', type: 'address' },
              { name: 'amount', type: 'uint160' },
              { name: 'expiration', type: 'uint48' },
              { name: 'nonce', type: 'uint48' },
            ],
            PermitSingle: [
              { name: 'details', type: 'PermitDetails' },
              { name: 'spender', type: 'address' },
              { name: 'sigDeadline', type: 'uint256' },
            ],
          },
          primaryType: 'PermitSingle',
          message: { details, spender: plan.to as Address, sigDeadline },
        });
        const abi = parseAbi([
          'function execute(bytes commands,bytes[] inputs,uint256 deadline) payable',
        ]);
        const decoded = decodeFunctionData({ abi, data: plan.data as Hex });
        const permitInput = encodeAbiParameters(
          parseAbiParameters(
            '((address token,uint160 amount,uint48 expiration,uint48 nonce) details,address spender,uint256 sigDeadline) permitSingle,bytes signature',
          ),
          [{ details, spender: plan.to as Address, sigDeadline }, signature],
        );
        plan.data = encodeFunctionData({
          abi,
          functionName: 'execute',
          args: [
            `0x0a${decoded.args[0].slice(2)}`,
            [permitInput, ...decoded.args[1]],
            decoded.args[2],
          ],
        });
        plan.permitSigned = true;
        persist();
      }
      operation.quote = {
        inputRaw: operation.amountRaw,
        outputRaw: plan.outputRaw,
        minOutputRaw: plan.minimumRaw,
        nativeUsd: null,
        priceImpactPercent: null,
        receivedAt: plan.receivedAt,
        source: `direct:${plan.venue}`,
      };
      persist();
    }
    const receipt = await this.evmStep(
      operation,
      'swap',
      plan.to as Address,
      plan.data as Hex,
      BigInt(plan.value),
      persist,
    );
    operation.swapHash = receipt.transactionHash;
    persist();
    const delta = erc20Delta(receipt, operation.address as Address, this.address);
    const tokens = buy ? delta : -delta;
    if (tokens <= 0n || (!buy && tokens !== BigInt(operation.amountRaw)))
      throw new ReviewRequired('Confirmed direct token transfers do not match the position');
    let native: bigint;
    let fundsError: string | undefined;
    if (plan.venue === 'flap' && plan.flapQuoteToken && !same(plan.flapQuoteToken, zeroAddress)) {
      let trace: unknown;
      try {
        trace = await this.rpc().request({
          method: 'debug_traceTransaction',
          params: [
            receipt.transactionHash,
            { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } },
          ],
        } as never);
      } catch (error) {
        this.log.error('transaction.flap_native_trace_failed', error, {
          operationId: operation.id,
          hash: receipt.transactionHash,
          quoteToken: plan.flapQuoteToken,
        });
        throw new ReviewRequired(
          'Confirmed Flap swap needs its native transfer trace; restore QuickNode tracing and reconcile this operation',
        );
      }
      const delta = tracedNativeDelta(trace, this.address, plan.to, plan.value);
      native = buy ? -delta : delta;
      if (
        native <= 0n ||
        (buy && native > BigInt(operation.amountRaw)) ||
        (!buy && native < BigInt(plan.minimumRaw))
      )
        throw new ReviewRequired(
          'Confirmed Flap native transfers disagree with the buy budget or minimum sale proceeds',
        );
      this.log.info('transaction.flap_native_accounted', {
        operationId: operation.id,
        hash: receipt.transactionHash,
        quoteToken: plan.flapQuoteToken,
        nativeRaw: native.toString(),
        tokenRaw: tokens.toString(),
        source: 'quicknode_call_trace',
      });
    } else if (plan.venue === 'flap') {
      const abi = parseAbi([
        'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
        'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
      ]);
      let found: bigint | null = null;
      for (const event of receipt.logs) {
        if (!same(event.address, network.portal)) continue;
        try {
          const decoded = decodeEventLog({ abi, topics: event.topics, data: event.data });
          const trader =
            decoded.eventName === 'TokenBought' ? decoded.args.buyer : decoded.args.seller;
          if (
            !same(decoded.args.token, operation.address) ||
            !same(trader, this.address) ||
            buy !== (decoded.eventName === 'TokenBought')
          )
            continue;
          if (found !== null)
            throw new ReviewRequired('Multiple Flap fills require reconciliation');
          if (buy) {
            const budget = BigInt(plan.value);
            if (decoded.args.eth + decoded.args.fee === budget) found = budget;
            else if (decoded.args.eth === budget) found = budget;
            else throw new ReviewRequired('Flap buy spend differs from the exact input budget');
          } else found = decoded.args.eth;
        } catch (error) {
          if (error instanceof ReviewRequired) throw error;
        }
      }
      if (found === null || found <= 0n || (buy && found > BigInt(plan.value)))
        throw new ReviewRequired('Confirmed Flap native fill could not be reconciled');
      native = found;
    } else {
      native = erc20Delta(receipt, this.network.wrappedNative, this.address) * (buy ? -1n : 1n);
      if (native <= 0n || (buy && native !== BigInt(operation.amountRaw)))
        throw new ReviewRequired('Confirmed PancakeSwap input/output could not be reconciled');
      if (!buy) {
        try {
          await this.evmStep(
            operation,
            'unwrap',
            this.network.wrappedNative,
            encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [native] }),
            0n,
            persist,
          );
        } catch (error) {
          if (!insufficientFunds(error)) throw error;
          fundsError = safeError(error);
        }
      }
    }
    const fee = this.fees(operation);
    return {
      tokenRaw: tokens.toString(),
      nativeRaw: (buy ? native + fee : native - fee).toString(),
      feeNativeRaw: fee.toString(),
      swapNativeRaw: native.toString(),
      signature: receipt.transactionHash,
      nativeUsd: null,
      ...(fundsError ? { fundsError } : {}),
    };
  }
  private fees(operation: Operation): bigint {
    return operation.steps.reduce(
      (sum, step) => sum + (step.type === 'evm' ? BigInt(step.gasPaidRaw ?? '0') : 0n),
      0n,
    );
  }
  private async ensureNativeTraceSupport(): Promise<void> {
    this.nativeTraceSupport ??= (async () => {
      try {
        const result: unknown = await this.rpc().request({
          method: 'debug_traceCall',
          params: [
            { from: this.address, to: this.address, value: '0x0', data: '0x' },
            'latest',
            { tracer: 'callTracer', tracerConfig: { onlyTopCall: false } },
          ],
        } as never);
        const frame = z
          .object({ type: z.literal('CALL'), error: z.string().optional() })
          .parse(result);
        if (frame.error) throw new Error(frame.error);
      } catch (error) {
        this.nativeTraceSupport = null;
        this.log.error('transaction.flap_tracing_unavailable', error, {
          service: `QuickNode ${this.network.name} RPC`,
        });
        throw new TradeRejected(
          'ERC20-quoted Flap swaps require QuickNode debug tracing for native-cost accounting; no swap was submitted',
        );
      }
    })();
    await this.nativeTraceSupport;
  }
  private async signPermit(
    response: ApiQuote,
    input: Address,
    amountRaw: string,
  ): Promise<{ signature: Hex; permitData: unknown } | Record<string, never>> {
    if (response.permitData == null) return {};
    const permit = permitDataSchema.parse(response.permitData);
    if (
      permit.domain.name !== 'Permit2' ||
      permit.domain.chainId !== this.network.chainId ||
      !same(permit.domain.verifyingContract, this.permit2) ||
      !same(permit.values.details.token, input) ||
      !same(permit.values.spender, this.router) ||
      BigInt(permit.values.details.amount) !== BigInt(amountRaw) ||
      BigInt(permit.values.details.expiration) <= BigInt(Math.floor(Date.now() / 1000)) ||
      BigInt(permit.values.sigDeadline) <= BigInt(Math.floor(Date.now() / 1000)) ||
      !permit.types.PermitSingle
    )
      throw new TradeRejected('Uniswap Permit2 permissions do not match the requested trade');
    this.beforeSpend();
    const signature = await this.account.signTypedData({
      domain: { ...permit.domain, verifyingContract: this.permit2 },
      types: permit.types as unknown as TypedData,
      primaryType: 'PermitSingle',
      message: signingValue(permit.values) as Record<string, unknown>,
    });
    this.log.info('transaction.permit_signed', { token: input, amountRaw, spender: this.router });
    return { signature, permitData: response.permitData };
  }
  private async approveToken(
    operation: Operation,
    token: Address,
    persist: () => void,
  ): Promise<void> {
    const approvalAmount = BigInt(operation.approvalAmountRaw ?? operation.amountRaw);
    if (approvalAmount < BigInt(operation.amountRaw) || approvalAmount >= 1n << 160n)
      throw new TradeRejected('Token amount exceeds the Permit2 allowance range');
    for (const key of ['approve-reset', 'approve-token'])
      if (operation.steps.some((step) => step.key === key))
        await this.evmStep(operation, key, token, '0x', 0n, persist);
    const allowance = await this.rpc().readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [this.address, this.permit2],
    });
    if (allowance >= BigInt(operation.amountRaw)) return;
    if (operation.steps.some((step) => step.key === 'approve-token'))
      throw new TradeRejected('Token allowance changed after the confirmed approval');
    if (allowance > 0n)
      await this.evmStep(
        operation,
        'approve-reset',
        token,
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [this.permit2, 0n] }),
        0n,
        persist,
      );
    await this.evmStep(
      operation,
      'approve-token',
      token,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [this.permit2, approvalAmount],
      }),
      0n,
      persist,
    );
  }
  private async approveRouter(
    operation: Operation,
    token: Address,
    persist: () => void,
  ): Promise<void> {
    if (operation.steps.some((step) => step.key === 'approve-router'))
      await this.evmStep(operation, 'approve-router', this.permit2, '0x', 0n, persist);
    const [amount, expiration] = await this.rpc().readContract({
      address: this.permit2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [this.address, token, this.router],
    });
    if (amount >= BigInt(operation.amountRaw) && expiration > Date.now() / 1000 + 120) return;
    if (operation.steps.some((step) => step.key === 'approve-router'))
      throw new TradeRejected('Router allowance expired or changed after approval');
    await this.evmStep(
      operation,
      'approve-router',
      this.permit2,
      encodeFunctionData({
        abi: permit2Abi,
        functionName: 'approve',
        args: [
          token,
          this.router,
          BigInt(operation.amountRaw),
          Math.floor(Date.now() / 1000) + 3600,
        ],
      }),
      0n,
      persist,
    );
  }
  private async evmStep(
    operation: Operation,
    key: string,
    to: Address,
    data: Hex,
    value: bigint,
    persist: () => void,
    parameters?: EvmParameters,
  ): Promise<TransactionReceipt> {
    const classicBuySwap =
      operation.kind === 'buy' &&
      !operation.settings.mevProtection &&
      !operation.directEvmPlan &&
      key === 'swap';
    const savedDirectSwap = operation.directEvmPlan !== undefined && key === 'swap';
    let step = operation.steps.find(
      (candidate): candidate is EvmStep => candidate.type === 'evm' && candidate.key === key,
    );
    const created = !step;
    if (!step) {
      if (classicBuySwap && !parameters)
        throw new TradeRejected('Classic buy requires Uniswap gas fields and a pending nonce');
      if (!parameters && this.chain === 'bnb') {
        const [gasPrice, estimatedGas, nonce] = await Promise.all([
          operation.settings.priorityFee == null
            ? this.rpc().getGasPrice()
            : Promise.resolve(parseAmount(operation.settings.priorityFee, 9)),
          this.rpc().estimateGas({ account: this.address, to, data, value }),
          this.rpc().getTransactionCount({ address: this.address, blockTag: 'pending' }),
        ]);
        if (gasPrice <= 0n) throw new TradeRejected('BNB gas price must be greater than zero');
        parameters = { gas: (estimatedGas * 120n) / 100n, nonce, gasPrice };
      }
      if (!parameters) {
        const [block, automatic, estimatedGas, nonce] = await Promise.all([
          this.rpc().getBlock(),
          operation.settings.priorityFee == null
            ? this.rpc().estimateFeesPerGas({ type: 'eip1559' })
            : Promise.resolve(null),
          this.rpc().estimateGas({ account: this.address, to, data, value }),
          this.rpc().getTransactionCount({ address: this.address, blockTag: 'pending' }),
        ]);
        if (block.baseFeePerGas === null)
          throw new TradeRejected(`${this.network.name} base fee is unavailable`);
        const fees = robinhoodGasFees(
          block.baseFeePerGas,
          operation.settings.priorityFee,
          automatic,
        );
        parameters = { gas: (estimatedGas * 120n) / 100n, nonce, ...fees };
      }
      const { gas, nonce, maxFeePerGas, maxPriorityFeePerGas: priority, gasPrice } = parameters;
      this.log.info('transaction.fee_selected', {
        operationId: operation.id,
        step: key,
        source:
          operation.settings.priorityFee != null
            ? 'user_override'
            : classicBuySwap
              ? 'uniswap'
              : 'rpc_estimate',
        priorityFeeGwei: operation.settings.priorityFee ?? null,
        maxPriorityFeePerGasWei: priority,
        maxFeePerGasWei: maxFeePerGas,
        gasPriceWei: gasPrice,
        gasLimit: gas,
        maximumEstimatedFeeWei: gas * (gasPrice ?? maxFeePerGas ?? 0n),
      });
      this.beforeSpend();
      const serialized = await this.account.signTransaction({
        chainId: this.network.chainId,
        ...(gasPrice !== undefined
          ? { type: 'legacy' as const, gasPrice }
          : {
              type: 'eip1559' as const,
              maxFeePerGas: maxFeePerGas!,
              maxPriorityFeePerGas: priority!,
            }),
        to,
        data,
        value,
        gas,
        nonce,
      });
      this.beforeSpend();
      step = {
        type: 'evm',
        key,
        hash: keccak256(serialized),
        serialized,
        submittedAt: null,
        gasPaidRaw: null,
      };
      operation.steps.push(step);
      if (operation.kind === 'withdraw') operation.swapHash = step.hash;
      persist();
    }
    let receipt: TransactionReceipt | null = null;
    if (!created)
      try {
        receipt = await this.rpc().getTransactionReceipt({ hash: step.hash as Hex });
      } catch (error) {
        if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError') {
          if (classicBuySwap || savedDirectSwap)
            throw new PendingTrade(
              `${this.network.name} receipt lookup failed; the saved swap will be reconciled`,
            );
          throw error;
        }
      }
    if (receipt) {
      if (receipt.status !== 'success')
        throw new TradeRejected(`${this.network.name} transaction reverted (${key})`);
      let blockNumber: bigint;
      try {
        blockNumber = await this.rpc().getBlockNumber({ cacheTime: 0 });
      } catch (error) {
        if (classicBuySwap || savedDirectSwap)
          throw new PendingTrade(
            `${this.network.name} confirmation lookup failed; the saved swap will be reconciled`,
          );
        throw error;
      }
      if (blockNumber < receipt.blockNumber + 1n)
        throw new PendingTrade(`Waiting for ${this.network.name} confirmations`);
      step.gasPaidRaw = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      persist();
      return receipt;
    }
    if (
      step.submittedAt === null ||
      (!classicBuySwap && !savedDirectSwap && Date.now() - step.submittedAt > 30_000)
    ) {
      if (step.submittedAt === null) this.beforeSpend();
      if (classicBuySwap || savedDirectSwap) {
        step.submittedAt = Date.now();
        persist();
      }
      try {
        await this.rpc().request({
          method: 'eth_sendRawTransaction',
          params: [step.serialized as Hex],
        });
      } catch (error) {
        if (insufficientFunds(error)) throw error;
        if (classicBuySwap || savedDirectSwap) {
          let cause: unknown = error;
          for (let depth = 0; depth < 8 && cause instanceof Error; depth++) {
            if (
              cause instanceof RpcRequestError &&
              /intrinsic gas too low|gas required exceeds allowance|max fee per gas less than block base fee|fee cap (?:less than|too low)|max priority fee per gas higher than max fee per gas|exceeds block gas limit|invalid (?:sender|signature|chain id)|transaction type not supported/i.test(
                cause.details,
              )
            )
              throw new TradeRejected(
                `${this.network.name} transaction rejected: ${safeError(new Error(cause.details))}`,
              );
            cause = cause.cause;
          }
        }
        this.log.error('transaction.submission_uncertain', error, {
          service: `QuickNode ${this.network.name} RPC`,
          operationId: operation.id,
          hash: step.hash,
          step: key,
        });
        throw new PendingTrade(
          `${this.network.name} submission outcome is uncertain (${key}); the saved transaction will be reconciled`,
        );
      }
      step.submittedAt = Date.now();
      persist();
    }
    throw new PendingTrade(`Waiting for ${this.network.name} confirmation (${key})`);
  }
  private async confirmReceipt(hash: Hex): Promise<TransactionReceipt> {
    let receipt: TransactionReceipt;
    try {
      receipt = await this.rpc().getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError')
        this.log.info('transaction.receipt_pending', { hash, reason: 'not_yet_available' });
      else
        this.log.error('transaction.receipt_failed', error, {
          service: `QuickNode ${this.network.name} RPC`,
          hash,
        });
      throw new PendingTrade('Waiting for the swap receipt');
    }
    if (receipt.status !== 'success') throw new TradeRejected(`${this.network.name} swap reverted`);
    if ((await this.rpc().getBlockNumber({ cacheTime: 0 })) < receipt.blockNumber + 1n)
      throw new PendingTrade(`Waiting for ${this.network.name} confirmations`);
    return receipt;
  }
  private async orderStep(
    operation: Operation,
    step: OrderStep,
    persist: () => void,
  ): Promise<TransactionReceipt> {
    if (step.txHash) return this.confirmReceipt(step.txHash as Hex);
    const query = new URLSearchParams({ orderId: step.orderId, swapper: this.address });
    const responseSchema = z.object({
      orders: z.array(
        z.object({ orderId: z.string(), orderStatus: z.string(), txHash: z.string().optional() }),
      ),
    });
    let result: z.infer<typeof responseSchema>;
    try {
      result = await this.http.json(
        'UniswapX order status',
        `https://trade-api.gateway.uniswap.org/v1/orders?${query}`,
        responseSchema,
        { headers: this.headers() },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) result = { orders: [] };
      else throw error;
    }
    const order = result.orders.find((item) => same(item.orderId, step.orderId));
    this.log.info('order.status', {
      operationId: operation.id,
      orderId: step.orderId,
      status: order?.orderStatus ?? 'not_found',
      txHash: order?.txHash,
      deadline: step.deadline,
      submittedAt: step.submittedAt,
    });
    if (order?.txHash) {
      step.txHash = order.txHash;
      persist();
      return this.confirmReceipt(order.txHash as Hex);
    }
    if (Date.now() / 1000 > step.deadline + 30) {
      const quote = dutchSchema.parse(step.body.quote);
      const parsed = UnsignedV3DutchOrder.parse(
        quote.encodedOrder,
        this.network.chainId,
        this.permit2,
      );
      const nonce = BigInt(parsed.info.nonce.toString());
      const used = await this.rpc().readContract({
        address: this.permit2,
        abi: permit2Abi,
        functionName: 'nonceBitmap',
        args: [this.address, nonce >> 8n],
      });
      const block = await this.rpc().getBlock();
      if (block.timestamp <= BigInt(step.deadline + 30))
        throw new PendingTrade('Waiting for the order expiry block');
      if ((used & (1n << (nonce & 255n))) !== 0n)
        throw new ReviewRequired('UniswapX nonce was consumed but the fill receipt is unavailable');
      throw new TradeRejected('UniswapX order expired without a fill');
    }
    if (
      Date.now() / 1000 < step.deadline - 3 &&
      (step.submittedAt === null || Date.now() - step.submittedAt > 20_000)
    ) {
      try {
        const created = await this.http.json(
          'UniswapX order submission',
          'https://trade-api.gateway.uniswap.org/v1/order',
          z.object({ orderId: z.string(), orderStatus: z.string() }),
          { method: 'POST', headers: this.headers(), body: step.body },
        );
        if (!same(created.orderId, step.orderId))
          throw new ReviewRequired('UniswapX returned an unexpected order ID');
        step.submittedAt = Date.now();
        persist();
      } catch (error) {
        if (error instanceof ReviewRequired) throw error;
        this.log.error('order.submission_uncertain', error, {
          service: 'UniswapX order submission',
          operationId: operation.id,
          orderId: step.orderId,
        });
        throw new PendingTrade('UniswapX submission will be reconciled using the saved order ID');
      }
    }
    operation.status = 'active';
    throw new PendingTrade('Waiting for a protected UniswapX fill');
  }
}
