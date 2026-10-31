import { z } from 'zod';
import { createRequire } from 'node:module';
import {
  createPublicClient,
  defineChain,
  http as viemHttp,
  encodeFunctionData,
  decodeEventLog,
  erc20Abi,
  keccak256,
  zeroAddress,
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
} from '../domain.js';
import type { ChainAdapter } from './types.js';
import { robinhoodGasFees } from './fees.js';
import { logger } from '../logging/logger.js';

const log = logger.child({ component: 'trading.robinhood', chain: 'robinhood' });

// The router SDK's ESM build uses extensionless imports that native Node cannot resolve.
const require = createRequire(import.meta.url);
const { CommandParser, UniversalRouterVersion, UNIVERSAL_ROUTER_ADDRESS, WETH_ADDRESS } =
  require('@uniswap/universal-router-sdk') as typeof import('@uniswap/universal-router-sdk');
const { UnsignedV3DutchOrder, REACTOR_ADDRESS_MAPPING, OrderType, PERMIT2_MAPPING } =
  require('@uniswap/uniswapx-sdk') as typeof import('@uniswap/uniswapx-sdk');

export const ROBINHOOD_CHAIN_ID = 4663;
export const ROBINHOOD_WETH = WETH_ADDRESS(ROBINHOOD_CHAIN_ID) as Address;
const PERMIT2 = PERMIT2_MAPPING[ROBINHOOD_CHAIN_ID] as Address;
const ROUTER = UNIVERSAL_ROUTER_ADDRESS(
  UniversalRouterVersion.V2_1_2,
  ROBINHOOD_CHAIN_ID,
) as Address;
const REACTOR = REACTOR_ADDRESS_MAPPING[ROBINHOOD_CHAIN_ID]?.[OrderType.Dutch_V3];
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
});
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

export function validateClassicCalldata(data: string, owner: string): void {
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
    ROUTER,
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

export class RobinhoodAdapter implements ChainAdapter {
  readonly chain = 'robinhood' as const;
  readonly address: Address;
  private readonly client;
  private beforeSpend: () => void = () => {};
  private networkVerification: Promise<void> | null = null;
  private readonly metadataCache = new Map<string, { decimals: number; expiresAt: number }>();
  private readonly metadataRequests = new Map<string, Promise<number>>();
  constructor(
    private readonly config: Config,
    private readonly wallets: Wallets,
    private readonly http: HttpClient,
    private readonly market: MarketData,
  ) {
    this.address = wallets.robinhood.address;
    const chain = defineChain({
      id: ROBINHOOD_CHAIN_ID,
      name: 'Robinhood Chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: config.robinhoodRpc ? [config.robinhoodRpc] : [] } },
    });
    this.client = config.robinhoodRpc
      ? createPublicClient({
          chain,
          transport: viemHttp(config.robinhoodRpc, {
            retryCount: 0,
            timeout: config.httpTimeoutMs,
            fetchFn: (input, init) => this.http.fetch('QuickNode Robinhood RPC', input, init),
          }),
        })
      : null;
  }
  private rpc() {
    if (!this.client) throw new Error('QUICKNODE_ROBINHOOD_RPC_URL is missing');
    return this.client;
  }
  private headers(): Record<string, string> {
    return {
      'x-api-key': this.config.uniswapKey,
      'x-universal-router-version': '2.1.2',
      'x-agent-info': JSON.stringify({
        integration_name: 'swap-integration',
        decision_origin: 'autonomous',
        version: '1.5.0',
      }),
    };
  }
  readiness(_settings: ChainSettings): string[] {
    return [
      !this.config.robinhoodRpc ? 'QUICKNODE_ROBINHOOD_RPC_URL' : '',
      !this.config.uniswapKey ? 'UNISWAP_API_KEY' : '',
    ].filter(Boolean);
  }
  async verifyNetwork(): Promise<void> {
    this.networkVerification ??= this.rpc()
      .getChainId()
      .then((chainId) => {
        if (chainId !== ROBINHOOD_CHAIN_ID)
          throw new Error('QuickNode endpoint is not Robinhood mainnet');
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
        address: ROBINHOOD_WETH,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [this.address],
      }),
    ]);
    return { nativeRaw: native.toString(), wrappedRaw: wrapped.toString() };
  }
  async tokenInfo(address: string): Promise<TokenInfo> {
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(address) ||
      same(address, ROBINHOOD_WETH) ||
      same(address, zeroAddress)
    )
      throw new TradeRejected('Invalid project token address');
    const tokenAddress = address as Address;
    const [decimals, metadata] = await Promise.all([
      this.tokenDecimals(tokenAddress),
      this.market.robinhood(address),
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
  private async tokenDecimals(address: Address): Promise<number> {
    const key = address.toLowerCase();
    const cached = this.metadataCache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      log.info('token.metadata_reused', { token: key, validForMs: cached.expiresAt - Date.now() });
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
    const response = await this.http.json(
      'Uniswap quote',
      'https://trade-api.gateway.uniswap.org/v1/quote',
      quoteResponseSchema,
      {
        method: 'POST',
        headers: this.headers(),
        body: {
          tokenIn: input,
          tokenOut: output,
          tokenInChainId: ROBINHOOD_CHAIN_ID,
          tokenOutChainId: ROBINHOOD_CHAIN_ID,
          type: 'EXACT_INPUT',
          amount: amountRaw,
          swapper: this.address,
          recipient: this.address,
          slippageTolerance: slippage,
          routingPreference: 'BEST_PRICE',
          protocols: settings.mevProtection ? ['UNISWAPX_V3'] : ['V2', 'V3', 'V4'],
          integratorFees: [],
          enforceExactIn: true,
          permitAmount: 'EXACT',
        },
      },
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
        quote.chainId !== ROBINHOOD_CHAIN_ID ||
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
    const order = UnsignedV3DutchOrder.parse(quote.encodedOrder, ROBINHOOD_CHAIN_ID, PERMIT2);
    if (
      !REACTOR ||
      !same(order.info.reactor, REACTOR) ||
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
    const response = await this.fetchQuote(address, ROBINHOOD_WETH, amountRaw, settings);
    const quote = this.validateQuote(
      response,
      address,
      ROBINHOOD_WETH,
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
    if (this.config.listenOnly)
      throw new TradeRejected('LISTEN_ONLY=true: Robinhood execution is blocked');
    this.beforeSpend = beforeSpend;
    await this.verifyNetwork();
    if (operation.kind === 'withdraw') {
      if (!operation.withdrawal) throw new TradeRejected('Withdrawal destination is missing');
      const recipient = withdrawalAddress(
        'robinhood',
        operation.withdrawal.recipient,
        this.address,
      );
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
        ROBINHOOD_WETH,
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
      if (wrap) await this.approveToken(operation, ROBINHOOD_WETH, persist);
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
    if (operation.kind === 'buy' && operation.wrapAmountRaw === undefined) {
      let shortfall = operation.steps.some((step) => step.type === 'evm' && step.key === 'wrap')
        ? BigInt(operation.amountRaw)
        : 0n;
      if (shortfall === 0n && operation.settings.wrapMyEth) {
        const wrapped = await this.rpc().readContract({
          address: ROBINHOOD_WETH,
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
    const input = operation.kind === 'buy' ? ROBINHOOD_WETH : (operation.address as Address);
    const output = operation.kind === 'buy' ? (operation.address as Address) : ROBINHOOD_WETH;
    let swapReceipt: TransactionReceipt;
    if (operation.swapHash) swapReceipt = await this.confirmReceipt(operation.swapHash as Hex);
    else {
      const pending = operation.steps.find((step) => step.key === 'swap');
      if (pending?.type === 'evm')
        swapReceipt = await this.evmStep(operation, 'swap', ROUTER, '0x', 0n, persist);
      else if (pending?.type === 'order')
        swapReceipt = await this.orderStep(operation, pending, persist);
      else {
        if (!operation.preparedQuote) {
          const [quoted] = await Promise.all([
            this.fetchQuote(input, output, operation.amountRaw, operation.settings).then(
              (response) => ({ response, receivedAt: Date.now() }),
            ),
            beforeSwap(),
          ]);
          operation.preparedQuote = {
            provider: 'uniswap',
            response: quoted.response,
            receivedAt: quoted.receivedAt,
            inputRaw: operation.amountRaw,
            slippagePercent: operation.settings.slippagePercent!,
            priorityFee: operation.settings.priorityFee,
          };
          persist();
        } else if (operation.kind === 'buy') await beforeSwap();
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
        if (
          operation.kind === 'sell' &&
          operation.minimumNativeRaw !== null &&
          quote.outputRaw < BigInt(operation.minimumNativeRaw)
        )
          throw new TradeRejected('Exit execution quote is more than 3% below the target price');
        operation.quote = {
          inputRaw: operation.amountRaw,
          outputRaw: quote.outputRaw.toString(),
          minOutputRaw: quote.minimumRaw.toString(),
          nativeUsd: null,
          priceImpactPercent: quote.impact,
          receivedAt: prepared.receivedAt,
        };
        persist();
        if (operation.kind === 'buy' && BigInt(operation.wrapAmountRaw ?? operation.amountRaw) > 0n)
          await this.evmStep(
            operation,
            'wrap',
            ROBINHOOD_WETH,
            encodeFunctionData({ abi: wethAbi, functionName: 'deposit' }),
            BigInt(operation.wrapAmountRaw ?? operation.amountRaw),
            persist,
          );
        await this.approveToken(operation, input, persist);
        if (!operation.settings.mevProtection && response.permitData === undefined)
          await this.approveRouter(operation, input, persist);
        if (Date.now() - prepared.receivedAt > 30_000)
          throw new TradeRejected(
            'The original Uniswap quote expired during transaction preparation',
          );
        if (response.routing === 'DUTCH_V3') {
          const dutch = dutchSchema.parse(response.quote);
          const order = UnsignedV3DutchOrder.parse(dutch.encodedOrder, ROBINHOOD_CHAIN_ID, PERMIT2);
          const permit = order.permitData();
          const domain = {
            name: 'Permit2',
            chainId: ROBINHOOD_CHAIN_ID,
            verifyingContract: PERMIT2,
          };
          const primaryType = Object.keys(permit.types).find((key) =>
            key.startsWith('PermitWitness'),
          );
          if (!primaryType) throw new TradeRejected('UniswapX signing schema is unsupported');
          const message = signingValue(permit.values) as Record<string, unknown>;
          this.beforeSpend();
          const signature = await this.wallets.robinhood.signTypedData({
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
          const result = await this.http.json(
            'Uniswap swap build',
            'https://trade-api.gateway.uniswap.org/v1/swap',
            z.object({ swap: transactionSchema }),
            {
              method: 'POST',
              headers: this.headers(),
              body: {
                quote: response.quote,
                ...permit,
                simulateTransaction: true,
                refreshGasPrice: true,
                deadline: Math.floor(Date.now() / 1000) + 120,
              },
            },
          );
          if (
            !same(result.swap.to, ROUTER) ||
            result.swap.chainId !== ROBINHOOD_CHAIN_ID ||
            (result.swap.from && !same(result.swap.from, this.address)) ||
            BigInt(result.swap.value) !== 0n
          )
            throw new TradeRejected(
              'Uniswap swap transaction has an unexpected destination or value',
            );
          validateClassicCalldata(result.swap.data, this.address);
          swapReceipt = await this.evmStep(
            operation,
            'swap',
            ROUTER,
            result.swap.data as Hex,
            0n,
            persist,
          );
        }
      }
      operation.swapHash = swapReceipt.transactionHash;
      const actualInput = -erc20Delta(swapReceipt, input, this.address);
      const actualOutput = erc20Delta(swapReceipt, output, this.address);
      if (actualInput !== BigInt(operation.amountRaw) || actualOutput <= 0n)
        throw new ReviewRequired('Confirmed Robinhood swap has unexpected token transfers');
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
          ROBINHOOD_WETH,
          encodeFunctionData({ abi: wethAbi, functionName: 'withdraw', args: [BigInt(outputRaw)] }),
          0n,
          persist,
        );
      } catch (error) {
        if (!insufficientFunds(error)) throw error;
        fundsError = safeError(error);
        log.error('transaction.unwrap_insufficient_funds', error, {
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
  private fees(operation: Operation): bigint {
    return operation.steps.reduce(
      (sum, step) => sum + (step.type === 'evm' ? BigInt(step.gasPaidRaw ?? '0') : 0n),
      0n,
    );
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
      permit.domain.chainId !== ROBINHOOD_CHAIN_ID ||
      !same(permit.domain.verifyingContract, PERMIT2) ||
      !same(permit.values.details.token, input) ||
      !same(permit.values.spender, ROUTER) ||
      BigInt(permit.values.details.amount) !== BigInt(amountRaw) ||
      BigInt(permit.values.details.expiration) <= BigInt(Math.floor(Date.now() / 1000)) ||
      BigInt(permit.values.sigDeadline) <= BigInt(Math.floor(Date.now() / 1000)) ||
      !permit.types.PermitSingle
    )
      throw new TradeRejected('Uniswap Permit2 permissions do not match the requested trade');
    this.beforeSpend();
    const signature = await this.wallets.robinhood.signTypedData({
      domain: { ...permit.domain, verifyingContract: PERMIT2 },
      types: permit.types as unknown as TypedData,
      primaryType: 'PermitSingle',
      message: signingValue(permit.values) as Record<string, unknown>,
    });
    log.info('transaction.permit_signed', { token: input, amountRaw, spender: ROUTER });
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
      args: [this.address, PERMIT2],
    });
    if (allowance >= BigInt(operation.amountRaw)) return;
    if (operation.steps.some((step) => step.key === 'approve-token'))
      throw new TradeRejected('Token allowance changed after the confirmed approval');
    if (allowance > 0n)
      await this.evmStep(
        operation,
        'approve-reset',
        token,
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [PERMIT2, 0n] }),
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
        args: [PERMIT2, approvalAmount],
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
      await this.evmStep(operation, 'approve-router', PERMIT2, '0x', 0n, persist);
    const [amount, expiration] = await this.rpc().readContract({
      address: PERMIT2,
      abi: permit2Abi,
      functionName: 'allowance',
      args: [this.address, token, ROUTER],
    });
    if (amount >= BigInt(operation.amountRaw) && expiration > Date.now() / 1000 + 120) return;
    if (operation.steps.some((step) => step.key === 'approve-router'))
      throw new TradeRejected('Router allowance expired or changed after approval');
    await this.evmStep(
      operation,
      'approve-router',
      PERMIT2,
      encodeFunctionData({
        abi: permit2Abi,
        functionName: 'approve',
        args: [token, ROUTER, BigInt(operation.amountRaw), Math.floor(Date.now() / 1000) + 3600],
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
  ): Promise<TransactionReceipt> {
    let step = operation.steps.find(
      (candidate): candidate is EvmStep => candidate.type === 'evm' && candidate.key === key,
    );
    const created = !step;
    if (!step) {
      const [block, automatic, estimatedGas, nonce] = await Promise.all([
        this.rpc().getBlock(),
        operation.settings.priorityFee == null
          ? this.rpc().estimateFeesPerGas({ type: 'eip1559' })
          : Promise.resolve(null),
        this.rpc().estimateGas({ account: this.address, to, data, value }),
        this.rpc().getTransactionCount({ address: this.address, blockTag: 'pending' }),
      ]);
      if (block.baseFeePerGas === null)
        throw new TradeRejected('Robinhood base fee is unavailable');
      const { maxFeePerGas, maxPriorityFeePerGas: priority } = robinhoodGasFees(
        block.baseFeePerGas,
        operation.settings.priorityFee,
        automatic,
      );
      const gas = (estimatedGas * 120n) / 100n;
      log.info('transaction.fee_selected', {
        operationId: operation.id,
        step: key,
        source: operation.settings.priorityFee == null ? 'rpc_estimate' : 'user_override',
        priorityFeeGwei: operation.settings.priorityFee ?? null,
        maxPriorityFeePerGasWei: priority,
        maxFeePerGasWei: maxFeePerGas,
        gasLimit: gas,
        maximumEstimatedFeeWei: gas * maxFeePerGas,
      });
      this.beforeSpend();
      const serialized = await this.wallets.robinhood.signTransaction({
        chainId: ROBINHOOD_CHAIN_ID,
        type: 'eip1559',
        to,
        data,
        value,
        gas,
        nonce,
        maxFeePerGas,
        maxPriorityFeePerGas: priority,
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
        if (!(error instanceof Error) || error.name !== 'TransactionReceiptNotFoundError')
          throw error;
      }
    if (receipt) {
      if (receipt.status !== 'success')
        throw new TradeRejected(`Robinhood transaction reverted (${key})`);
      if ((await this.rpc().getBlockNumber()) < receipt.blockNumber + 1n)
        throw new PendingTrade('Waiting for Robinhood confirmations');
      step.gasPaidRaw = (receipt.gasUsed * receipt.effectiveGasPrice).toString();
      persist();
      return receipt;
    }
    if (step.submittedAt === null || Date.now() - step.submittedAt > 30_000) {
      if (step.submittedAt === null) this.beforeSpend();
      try {
        await this.rpc().request({
          method: 'eth_sendRawTransaction',
          params: [step.serialized as Hex],
        });
      } catch (error) {
        if (insufficientFunds(error)) throw error;
        log.error('transaction.submission_uncertain', error, {
          service: 'QuickNode Robinhood RPC',
          operationId: operation.id,
          hash: step.hash,
          step: key,
        });
        throw new PendingTrade(
          `Robinhood submission outcome is uncertain (${key}); the saved transaction will be reconciled`,
        );
      }
      step.submittedAt = Date.now();
      persist();
    }
    throw new PendingTrade(`Waiting for Robinhood confirmation (${key})`);
  }
  private async confirmReceipt(hash: Hex): Promise<TransactionReceipt> {
    let receipt: TransactionReceipt;
    try {
      receipt = await this.rpc().getTransactionReceipt({ hash });
    } catch (error) {
      if (error instanceof Error && error.name === 'TransactionReceiptNotFoundError')
        log.info('transaction.receipt_pending', { hash, reason: 'not_yet_available' });
      else
        log.error('transaction.receipt_failed', error, {
          service: 'QuickNode Robinhood RPC',
          hash,
        });
      throw new PendingTrade('Waiting for the swap receipt');
    }
    if (receipt.status !== 'success') throw new TradeRejected('Robinhood swap reverted');
    if ((await this.rpc().getBlockNumber()) < receipt.blockNumber + 1n)
      throw new PendingTrade('Waiting for Robinhood confirmations');
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
    log.info('order.status', {
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
      const parsed = UnsignedV3DutchOrder.parse(quote.encodedOrder, ROBINHOOD_CHAIN_ID, PERMIT2);
      const nonce = BigInt(parsed.info.nonce.toString());
      const used = await this.rpc().readContract({
        address: PERMIT2,
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
        log.error('order.submission_uncertain', error, {
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
