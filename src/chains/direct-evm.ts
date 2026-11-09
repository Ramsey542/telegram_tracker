import {
  BaseError,
  ContractFunctionRevertedError,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { TradeRejected, type DirectEvmPlan, type EvmChain } from '../domain.js';
import { evmNetworks } from './networks.js';
import { logger } from '../logging/logger.js';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { InfinityRouter, SmartRouter } =
  require('@pancakeswap/smart-router/evm') as typeof import('@pancakeswap/smart-router/evm');
const { Token, CurrencyAmount, Percent, TradeType, Native } =
  require('@pancakeswap/sdk') as typeof import('@pancakeswap/sdk');
const { PancakeSwapUniversalRouter } =
  require('@pancakeswap/universal-router-sdk') as typeof import('@pancakeswap/universal-router-sdk');
type Provider = NonNullable<Parameters<typeof InfinityRouter.getInfinityClPoolsWithoutTicks>[1]>;

const log = logger.child({ component: 'trading.direct_evm' });
export const directNetworks = {
  bnb: {
    portal: '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0',
    v2: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
    smart: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
    quoter: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
    infinity: '0xd9c500dff816a1da21a48a732d3498bf09dc9aeb',
    bases: [
      '0x55d398326f99059ff775485246999027b3197955',
      '0xe9e7cea3dedca5984780bafc599bd69add087d56',
    ],
  },
  robinhood: {
    portal: '0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09',
    v2: '0x8cfe327cec66d1c090dd72bd0ff11d690c33a2eb',
    smart: '0x13f4ea83d0bd40e75c8222255bc855a974568dd4',
    quoter: '0x8553aa1615549a86882151784b329b017aa7c832',
    infinity: '0x57fc55f719df19b4b90a03f9d78e1177d002e504',
    bases: [],
  },
} as const;

export const portalAbi = parseAbi([
  'function getTokenV7(address token) view returns ((uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID,uint256 taxRate,address pool,uint256 progress,uint8 lpFeeProfile,uint8 dexId) state)',
  'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount) params) returns (uint256 outputAmount)',
  'function swapExactInput((address inputToken,address outputToken,uint256 inputAmount,uint256 minOutputAmount,bytes permitData) params) payable returns (uint256 outputAmount)',
]);
const v2Abi = parseAbi([
  'function getAmountsOut(uint256 amountIn,address[] path) view returns (uint256[] amounts)',
  'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)',
]);
const v3Abi = parseAbi([
  'function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)',
  'function exactInput((bytes path,address recipient,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)',
  'function multicall(uint256 deadline,bytes[] data) payable returns (bytes[] results)',
]);
export function directMinimum(output: bigint, slippage: number): bigint {
  if (output <= 0n || !Number.isFinite(slippage) || slippage < 0 || slippage > 100)
    throw new TradeRejected('Direct quote amount or slippage is invalid');
  const minimum = (output * BigInt(10_000 - Math.round(slippage * 100))) / 10_000n;
  if (minimum <= 0n) throw new TradeRejected('Direct quote minimum output rounds to zero');
  return minimum;
}
function isRevert(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ContractFunctionRevertedError) instanceof
      ContractFunctionRevertedError
  );
}

export class DirectEvmRoutes {
  constructor(
    private readonly chain: EvmChain,
    private readonly client: PublicClient,
    private readonly owner: Address,
  ) {}
  async flapState(token: Address) {
    try {
      const state = await this.client.readContract({
        address: directNetworks[this.chain].portal as Address,
        abi: portalAbi,
        functionName: 'getTokenV7',
        args: [token],
      });
      return state.status === 0 ? null : state;
    } catch (error) {
      if (isRevert(error)) return null;
      throw error;
    }
  }
  async quote(
    token: Address,
    amount: bigint,
    buy: boolean,
    slippage: number,
  ): Promise<DirectEvmPlan | null> {
    if (amount <= 0n) throw new TradeRejected('Direct swap amount must be positive');
    const state = await this.flapState(token);
    if (state) {
      if (![1, 4].includes(state.status))
        throw new TradeRejected(`Flap token is not tradable (status ${state.status})`);
      if (buy && state.quoteTokenAddress !== zeroAddress && !state.nativeToQuoteSwapEnabled)
        throw new TradeRejected(
          'Flap native conversion is disabled for this quote token; native-funded buying is unavailable',
        );
      const inputToken = buy ? zeroAddress : token;
      const outputToken = buy ? token : zeroAddress;
      const quoted = await this.client.call({
        account: this.owner,
        to: directNetworks[this.chain].portal as Address,
        data: encodeFunctionData({
          abi: portalAbi,
          functionName: 'quoteExactInput',
          args: [{ inputToken, outputToken, inputAmount: amount }],
        }),
      });
      if (!quoted.data) throw new TradeRejected('Flap returned an empty quote');
      const output = decodeFunctionResult({
        abi: portalAbi,
        functionName: 'quoteExactInput',
        data: quoted.data,
      });
      const minimum = directMinimum(output, slippage);
      log.info('route.selected', {
        chain: this.chain,
        token,
        venue: 'flap',
        quoteToken: state.quoteTokenAddress,
        nativeConversion: state.quoteTokenAddress !== zeroAddress,
        inputRaw: amount.toString(),
        outputRaw: output.toString(),
      });
      return {
        venue: 'flap',
        flapQuoteToken: state.quoteTokenAddress,
        to: directNetworks[this.chain].portal,
        spender: buy ? null : directNetworks[this.chain].portal,
        inputToken,
        outputToken,
        value: buy ? amount.toString() : '0',
        data: encodeFunctionData({
          abi: portalAbi,
          functionName: 'swapExactInput',
          args: [
            {
              inputToken,
              outputToken,
              inputAmount: amount,
              minOutputAmount: minimum,
              permitData: '0x',
            },
          ],
        }),
        outputRaw: output.toString(),
        minimumRaw: minimum.toString(),
        receivedAt: Date.now(),
      };
    }
    return this.quotePancake(token, amount, buy, slippage);
  }
  async quotePancake(
    token: Address,
    amount: bigint,
    buy: boolean,
    slippage: number,
  ): Promise<DirectEvmPlan | null> {
    const network = directNetworks[this.chain];
    const wrapped = evmNetworks[this.chain].wrappedNative as Address;
    const input = buy ? wrapped : token;
    const output = buy ? token : wrapped;
    const paths: Address[][] = [
      [input, output],
      ...network.bases
        .filter((base) => base !== token)
        .map((base) => [input, base as Address, output]),
    ];
    const fees = [100, 500, 2500, 10000];
    const v3Paths: Hex[] = [];
    for (const path of paths) {
      for (const first of fees) {
        if (path.length === 2)
          v3Paths.push(encodePacked(['address', 'uint24', 'address'], [path[0]!, first, path[1]!]));
        else
          for (const second of fees)
            v3Paths.push(
              encodePacked(
                ['address', 'uint24', 'address', 'uint24', 'address'],
                [path[0]!, first, path[1]!, second, path[2]!],
              ),
            );
      }
    }
    const [v2Results, v3Results] = await Promise.all([
      this.client.multicall({
        batchSize: 64_000,
        contracts: paths.map((path) => ({
          address: network.v2 as Address,
          abi: v2Abi,
          functionName: 'getAmountsOut' as const,
          args: [amount, path] as const,
        })),
      }),
      this.client.multicall({
        batchSize: 64_000,
        contracts: v3Paths.map((path) => ({
          address: network.quoter as Address,
          abi: v3Abi,
          functionName: 'quoteExactInput' as const,
          args: [path, amount] as const,
        })),
      }),
    ]);
    const candidates: {
      venue: 'pancake-v2' | 'pancake-v3';
      output: bigint;
      path: Address[] | Hex;
    }[] = [];
    v2Results.forEach((result, i) => {
      if (result.status === 'success' && result.result.length > 1)
        candidates.push({ venue: 'pancake-v2', output: result.result.at(-1)!, path: paths[i]! });
    });
    v3Results.forEach((result, i) => {
      if (result.status === 'success')
        candidates.push({ venue: 'pancake-v3', output: result.result[0], path: v3Paths[i]! });
    });
    candidates.sort((a, b) => (a.output > b.output ? -1 : a.output < b.output ? 1 : 0));
    const best = candidates[0];
    const infinity = await this.infinity(token, amount, buy, slippage);
    if (infinity && (!best || BigInt(infinity.outputRaw) > best.output)) return infinity;
    if (!best || best.output <= 0n) return null;
    const minimum = directMinimum(best.output, slippage);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
    const to = best.venue === 'pancake-v2' ? network.v2 : network.smart;
    const inner =
      best.venue === 'pancake-v3'
        ? encodeFunctionData({
            abi: v3Abi,
            functionName: 'exactInput',
            args: [
              {
                path: best.path as Hex,
                recipient: this.owner,
                amountIn: amount,
                amountOutMinimum: minimum,
              },
            ],
          })
        : null;
    log.info('route.selected', {
      chain: this.chain,
      token,
      venue: best.venue,
      inputRaw: amount.toString(),
      outputRaw: best.output.toString(),
    });
    return {
      venue: best.venue,
      to,
      spender: to,
      inputToken: input,
      outputToken: output,
      value: '0',
      data: inner
        ? encodeFunctionData({ abi: v3Abi, functionName: 'multicall', args: [deadline, [inner]] })
        : encodeFunctionData({
            abi: v2Abi,
            functionName: 'swapExactTokensForTokensSupportingFeeOnTransferTokens',
            args: [amount, minimum, best.path as Address[], this.owner, deadline],
          }),
      outputRaw: best.output.toString(),
      minimumRaw: minimum.toString(),
      receivedAt: Date.now(),
    };
  }
  private async infinity(
    token: Address,
    amount: bigint,
    buy: boolean,
    slippage: number,
  ): Promise<DirectEvmPlan | null> {
    const chainId = evmNetworks[this.chain].chainId;
    const decimalsAbi = parseAbi(['function decimals() view returns (uint8)']);
    const decimals = await this.client.readContract({
      address: token,
      abi: decimalsAbi,
      functionName: 'decimals',
    });
    const base = new Token(chainId, token, decimals, 'TOKEN');
    const wrapped = new Token(
      chainId,
      evmNetworks[this.chain].wrappedNative,
      18,
      evmNetworks[this.chain].wrappedSymbol,
    );
    const native = Native.onChain(chainId);
    const pairs: [typeof base | typeof native, typeof base | typeof native][] = [
      [base, wrapped],
      [base, native],
    ];
    const provider = (() => this.client) as unknown as Provider;
    try {
      const [cl, bin] = await Promise.all([
        InfinityRouter.getInfinityClPoolsWithoutTicks(pairs, provider),
        InfinityRouter.getInfinityBinPoolsWithoutBins(pairs, provider),
      ]);
      if (!cl.length && !bin.length) return null;
      const trade = await SmartRouter.getBestTrade(
        CurrencyAmount.fromRawAmount(buy ? wrapped : base, amount.toString()),
        buy ? base : wrapped,
        TradeType.EXACT_INPUT,
        {
          poolProvider: SmartRouter.createStaticPoolProvider([...cl, ...bin]),
          quoteProvider: SmartRouter.createQuoteProvider({
            onChainProvider: provider,
            account: this.owner,
          }),
          gasPriceWei: async () => 0n,
          maxHops: 2,
          maxSplits: 0,
        },
      );
      if (!trade) return null;
      const built = PancakeSwapUniversalRouter.swapERC20CallParameters(trade, {
        recipient: this.owner,
        slippageTolerance: new Percent(Math.round(slippage * 100), 10000),
        deadlineOrPreviousBlockhash: Math.floor(Date.now() / 1000) + 120,
      });
      if (BigInt(built.value) !== 0n)
        throw new TradeRejected('Infinity route unexpectedly requires native funding');
      const output = BigInt(trade.outputAmount.quotient.toString());
      return {
        venue: 'pancake-infinity',
        to: directNetworks[this.chain].infinity,
        spender: '0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768',
        permit2: '0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768',
        inputToken: buy ? wrapped.address : token,
        outputToken: buy ? token : wrapped.address,
        value: '0',
        data: built.calldata,
        outputRaw: output.toString(),
        minimumRaw: directMinimum(output, slippage).toString(),
        receivedAt: Date.now(),
      };
    } catch (error) {
      if (
        error instanceof Error &&
        /^(Cannot find a valid swap route|No valid route found(?: for .*)?)$/.test(error.message)
      ) {
        log.info('route.infinity_unavailable', { chain: this.chain, token, reason: error.message });
        return null;
      }
      log.error('route.infinity_failed', error, { chain: this.chain, token });
      throw error;
    }
  }
}
