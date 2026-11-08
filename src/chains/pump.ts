import BN from 'bn.js';
import { createRequire } from 'node:module';
import type { OnlinePumpSdk as OnlinePumpSdkInstance } from '@pump-fun/pump-sdk';
import type { OnlinePumpAmmSdk as OnlinePumpAmmSdkInstance } from '@pump-fun/pump-swap-sdk';
import { ReviewRequired } from '../domain.js';
import { TradeRejected, type Quote, type TokenInfo } from '../domain.js';
import { logger } from '../logging/logger.js';

import {
  Connection,
  PublicKey,
  type TransactionInstruction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token';
const require = createRequire(import.meta.url);
const {
  PUMP_PROGRAM_ID,
  PUMP_SDK,
  OnlinePumpSdk,
  bondingCurvePda,
  getBuyV3TokenAmountFromQuoteAmount,
  getSellSolAmountFromTokenAmount,
  pumpIdl,
} = require('@pump-fun/pump-sdk') as typeof import('@pump-fun/pump-sdk');
const {
  OnlinePumpAmmSdk,
  PUMP_AMM_SDK,
  canonicalPumpPoolPda,
  buyQuoteInput,
  sellBaseInput,
  pumpAmmJson,
  PUMP_AMM_PROGRAM_ID,
} = require('@pump-fun/pump-swap-sdk') as typeof import('@pump-fun/pump-swap-sdk');

export { PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID };

const SOL = new PublicKey('So11111111111111111111111111111111111111112');
const log = logger.child({ component: 'trading.pump', chain: 'solana' });
export interface PumpQuote {
  venue: 'pump' | 'pump-amm';
  quote: Quote;
  token: TokenInfo;
  instructions: TransactionInstruction[];
}
export class PumpRoutes {
  private readonly online: OnlinePumpSdkInstance;
  private readonly amm: OnlinePumpAmmSdkInstance;
  private globals: {
    global: Awaited<ReturnType<OnlinePumpSdkInstance['fetchGlobal']>>;
    fees: Awaited<ReturnType<OnlinePumpSdkInstance['fetchFeeConfig']>>;
    at: number;
  } | null = null;
  constructor(
    private readonly connection: Connection,
    private readonly owner: PublicKey,
  ) {
    this.online = new OnlinePumpSdk(connection);
    this.amm = new OnlinePumpAmmSdk(connection);
  }
  async inspect(address: string) {
    const mint = new PublicKey(address);
    const [mintAccount, curveAccount] = await this.connection.getMultipleAccountsInfo(
      [mint, bondingCurvePda(mint)],
      'confirmed',
    );
    if (!curveAccount || !curveAccount.owner.equals(PUMP_PROGRAM_ID)) return null;
    if (
      !mintAccount ||
      (!mintAccount.owner.equals(TOKEN_PROGRAM_ID) &&
        !mintAccount.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      throw new TradeRejected('Pump token has an unsupported mint owner');
    const curve = PUMP_SDK.decodeBondingCurve(curveAccount);
    const info = unpackMint(mint, mintAccount, mintAccount.owner);
    return { mint, mintAccount, curve, info };
  }
  async tokenInfo(address: string, nativeUsd: number): Promise<TokenInfo | null> {
    const inspected = await this.inspect(address);
    if (!inspected) return null;
    const { curve, info, mint } = inspected;
    if (!curve.quoteMint.equals(PublicKey.default) && !curve.quoteMint.equals(SOL)) return null;
    let ratio =
      Number(curve.virtualQuoteReserves.toString()) / Number(curve.virtualTokenReserves.toString());
    let liquid = (Number(curve.realQuoteReserves.toString()) / 1e9) * nativeUsd;
    if (curve.complete) {
      const state = await this.amm.swapSolanaState(canonicalPumpPoolPda(mint), this.owner);
      ratio =
        Number(state.poolQuoteAmount.add(state.pool.virtualQuoteReserves).toString()) /
        Number(state.poolBaseAmount.toString());
      liquid =
        (Number(state.poolQuoteAmount.add(state.pool.virtualQuoteReserves).toString()) / 1e9) *
        nativeUsd *
        2;
    }
    const price = ((ratio * 10 ** info.decimals) / 1e9) * nativeUsd;
    if (!Number.isFinite(price) || price <= 0)
      throw new TradeRejected('Pump native price is invalid');
    return {
      chain: 'solana',
      address,
      symbol: address.slice(0, 8),
      decimals: info.decimals,
      usdPrice: price,
      marketCapUsd: (price * Number(info.supply)) / 10 ** info.decimals,
      liquidityUsd: Math.max(0, liquid),
      marketSource: curve.complete ? 'pump-amm-onchain' : 'pump-curve-onchain',
      fetchedAt: Date.now(),
    };
  }
  async reference(address: string, tokenRaw: string): Promise<Quote> {
    const inspected = await this.inspect(address);
    if (!inspected) throw new Error('Pump reference token is unavailable');
    const { curve, mint } = inspected;
    if (!curve.quoteMint.equals(PublicKey.default) && !curve.quoteMint.equals(SOL))
      throw new Error('Pump reference quote asset is unsupported');
    let base = BigInt(curve.virtualTokenReserves.toString());
    let quote = BigInt(curve.virtualQuoteReserves.toString());
    if (curve.complete) {
      const state = await this.amm.swapSolanaState(canonicalPumpPoolPda(mint), this.owner);
      base = BigInt(state.poolBaseAmount.toString());
      quote = BigInt(state.poolQuoteAmount.add(state.pool.virtualQuoteReserves).toString());
    }
    if (base <= 0n || quote <= 0n) throw new Error('Pump reference reserves are invalid');
    const output = (BigInt(tokenRaw) * quote) / base;
    return {
      inputRaw: tokenRaw,
      outputRaw: output.toString(),
      minOutputRaw: output.toString(),
      nativeUsd: null,
      priceImpactPercent: null,
      receivedAt: Date.now(),
      source: curve.complete ? 'direct:pump-amm' : 'direct:pump',
      estimated: true,
    };
  }
  async quote(
    address: string,
    input: bigint,
    buy: boolean,
    slippage: number,
    build: boolean,
  ): Promise<PumpQuote | null> {
    if (input <= 0n || !Number.isFinite(slippage) || slippage < 0 || slippage >= 100)
      throw new TradeRejected('Pump amount or slippage is invalid');
    const inspected = await this.inspect(address);
    if (!inspected) return null;
    const { mint, mintAccount, info, curve } = inspected;
    if (!curve.quoteMint.equals(PublicKey.default) && !curve.quoteMint.equals(SOL)) {
      log.info('route.pump_quote_asset_unsupported', {
        token: address,
        quoteMint: curve.quoteMint.toBase58(),
      });
      return null;
    }
    if (!curve.complete && curve.isCashbackCoin) {
      log.info('route.pump_legacy_cashback', { token: address });
      return null;
    }
    let output: BN;
    let instructions: TransactionInstruction[] = [];
    let spot: number;
    let venue: PumpQuote['venue'];
    const amount = new BN(input.toString());
    if (!curve.complete) {
      venue = 'pump';
      if (!this.globals || Date.now() - this.globals.at > 30_000) {
        const [global, fees] = await Promise.all([
          this.online.fetchGlobal(),
          this.online.fetchFeeConfig(),
        ]);
        this.globals = { global, fees, at: Date.now() };
      }
      const { global, fees } = this.globals;
      if (buy) {
        const state = await this.online.fetchBuyState(mint, this.owner, mintAccount.owner);
        if (state.bondingCurve.complete)
          throw new TradeRejected('Pump token migrated during preparation; wait for a fresh call');
        output = getBuyV3TokenAmountFromQuoteAmount({
          global,
          feeConfig: fees,
          mintSupply: new BN(info.supply.toString()),
          bondingCurve: state.bondingCurve,
          amount,
          curveBaseTokenBalance: state.curveBaseTokenBalance,
          quoteTransferFee: state.quoteTransferFee,
        });
        if (output.gt(state.bondingCurve.realTokenReserves))
          throw new TradeRejected(
            'Pump buy crosses the migration boundary; wait for a fresh call after migration',
          );
        if (build)
          instructions = await PUMP_SDK.buyExactQuoteInV3Instructions({
            bondingCurve: state.bondingCurve,
            associatedUserAccountInfo: state.associatedUserAccountInfo,
            mint,
            user: this.owner,
            amount: output,
            quoteAmount: amount,
            slippage,
            tokenProgram: mintAccount.owner,
            quoteTokenProgram: state.quoteTokenProgram,
            partialFill: false,
          });
      } else {
        const state = await this.online.fetchSellState(mint, this.owner, mintAccount.owner);
        if (state.bondingCurve.complete)
          throw new TradeRejected('Pump token migrated during sell preparation');
        output = getSellSolAmountFromTokenAmount({
          global,
          feeConfig: fees,
          mintSupply: new BN(info.supply.toString()),
          bondingCurve: state.bondingCurve,
          amount,
          quoteTransferFee: state.quoteTransferFee,
        });
        if (build)
          instructions = await PUMP_SDK.sellV3Instructions({
            bondingCurve: state.bondingCurve,
            mint,
            user: this.owner,
            amount,
            quoteAmount: output,
            slippage,
            tokenProgram: mintAccount.owner,
            quoteTokenProgram: state.quoteTokenProgram,
          });
      }
      spot =
        ((Number(curve.virtualQuoteReserves.toString()) /
          Number(curve.virtualTokenReserves.toString())) *
          10 ** info.decimals) /
        1e9;
    } else {
      venue = 'pump-amm';
      const state = await this.amm.swapSolanaState(canonicalPumpPoolPda(mint), this.owner);
      if (!state.pool.baseMint.equals(mint) || !state.pool.quoteMint.equals(SOL))
        throw new TradeRejected('PumpSwap canonical pool does not match the requested SOL trade');
      if (state.pool.isCashbackCoin) {
        log.info('route.pump_legacy_cashback', { token: address });
        return null;
      }
      const common = {
        baseReserve: state.poolBaseAmount,
        quoteReserve: state.poolQuoteAmount,
        virtualQuoteReserves: state.pool.virtualQuoteReserves,
        globalConfig: state.globalConfig,
        baseMintAccount: state.baseMintAccount,
        baseMint: mint,
        coinCreator: state.pool.coinCreator,
        creator: state.pool.creator,
        feeConfig: state.feeConfig,
        quoteMint: state.pool.quoteMint,
        isMayhemMode: state.pool.isMayhemMode,
        creatorFeeBps: state.pool.creatorFeeBps,
        quoteTransferFee: state.quoteTransferFee,
      };
      if (buy) {
        output = buyQuoteInput({ ...common, quote: amount, slippage, tradeV2: true }).base;
        if (build)
          instructions = await PUMP_AMM_SDK.buyExactQuoteInV2Instructions(
            state,
            amount,
            new BN(
              (
                (BigInt(output.toString()) * BigInt(10_000 - Math.round(slippage * 100))) /
                10_000n
              ).toString(),
            ),
          );
      } else {
        output = sellBaseInput({
          ...common,
          base: amount,
          slippage,
          feeBucketsTotal: state.pool.protocolFees.add(state.pool.creatorFees),
        }).uiQuote;
        if (build)
          instructions = await PUMP_AMM_SDK.sellV2Instructions(
            state,
            amount,
            new BN(
              (
                (BigInt(output.toString()) * BigInt(10_000 - Math.round(slippage * 100))) /
                10_000n
              ).toString(),
            ),
          );
      }
      spot =
        ((Number(state.poolQuoteAmount.add(state.pool.virtualQuoteReserves).toString()) /
          Number(state.poolBaseAmount.toString())) *
          10 ** info.decimals) /
        1e9;
    }
    const outputRaw = BigInt(output.toString());
    const minimum = (outputRaw * BigInt(10_000 - Math.round(slippage * 100))) / 10_000n;
    if (outputRaw <= 0n || minimum <= 0n || !Number.isFinite(spot) || spot <= 0)
      throw new TradeRejected('Pump quote is empty or invalid');
    const expected = buy
      ? (Number(input) / 1e9 / spot) * 10 ** info.decimals
      : (Number(input) / 10 ** info.decimals) * spot * 1e9;
    const impact = Math.max(0, (1 - Number(outputRaw) / expected) * 100);
    return {
      venue,
      quote: {
        inputRaw: input.toString(),
        outputRaw: outputRaw.toString(),
        minOutputRaw: minimum.toString(),
        nativeUsd: null,
        priceImpactPercent: impact,
        receivedAt: Date.now(),
        source: `direct:${venue}`,
      },
      token: {
        chain: 'solana',
        address,
        symbol: address.slice(0, 8),
        decimals: info.decimals,
        marketCapUsd: null,
        liquidityUsd: null,
        usdPrice: null,
        fetchedAt: Date.now(),
      },
      instructions,
    };
  }
}

export function pumpFill(
  receipt: VersionedTransactionResponse,
  owner: string,
  mint: string,
  venue: 'pump' | 'pump-amm',
  buy: boolean,
): { native: bigint; tokens: bigint } {
  const program = venue === 'pump' ? PUMP_PROGRAM_ID : PUMP_AMM_PROGRAM_ID;
  const eventName = venue === 'pump' ? 'TradeEvent' : buy ? 'BuyEvent' : 'SellEvent';
  const idl = (venue === 'pump' ? pumpIdl : pumpAmmJson) as {
    events: readonly { name: string; discriminator: readonly number[] }[];
  };
  const definition = idl.events.find((event) => event.name === eventName);
  if (!definition) throw new ReviewRequired(`Pump SDK event definition is missing: ${eventName}`);
  const discriminator = Buffer.from(definition.discriminator);
  const stack: string[] = [];
  let native = 0n;
  let tokens = 0n;
  const value = (data: Record<string, unknown>, field: string): bigint => {
    const raw = String(data[field]);
    if (!/^\d+$/.test(raw)) throw new ReviewRequired(`Pump fill is missing ${field}`);
    return BigInt(raw);
  };
  for (const line of receipt.meta?.logMessages ?? []) {
    const invoked = /^Program (\S+) invoke/.exec(line)?.[1];
    if (invoked) {
      stack.push(invoked);
      continue;
    }
    if (/^Program \S+ (?:success|failed:)/.test(line)) {
      stack.pop();
      continue;
    }
    if (stack.at(-1) !== program.toBase58() || !line.startsWith('Program data: ')) continue;
    const encoded = Buffer.from(line.slice(14), 'base64');
    if (!encoded.subarray(0, discriminator.length).equals(discriminator)) continue;
    let data: Record<string, unknown>;
    try {
      const body = encoded.subarray(discriminator.length);
      data = (venue === 'pump'
        ? PUMP_SDK.decodeTradeEventBc(body)
        : buy
          ? PUMP_SDK.decodeBuyEventAmm(body)
          : PUMP_SDK.decodeSellEventAmm(body)) as unknown as Record<string, unknown>;
    } catch (error) {
      log.error('receipt.pump_event_decode_failed', error, { mint, venue, eventName });
      throw new ReviewRequired(`Confirmed ${eventName} could not be decoded by the Pump SDK`);
    }
    if (String(data.user) !== owner) continue;
    if (venue === 'pump') {
      if (String(data.mint) !== mint || data.isBuy !== buy) continue;
      const quote = value(data, 'solAmount');
      const fee = value(data, 'fee') + value(data, 'creatorFee');
      native += buy ? quote + fee : quote - fee;
      tokens += value(data, 'tokenAmount');
    } else {
      if (String(data.pool) !== canonicalPumpPoolPda(new PublicKey(mint)).toBase58()) continue;
      native += value(data, buy ? 'userQuoteAmountIn' : 'userQuoteAmountOut');
      tokens += value(data, buy ? 'baseAmountOut' : 'baseAmountIn');
    }
  }
  if (native <= 0n || tokens <= 0n)
    throw new ReviewRequired('Confirmed Pump fill events are unavailable');
  return { native, tokens };
}
