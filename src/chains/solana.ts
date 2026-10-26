import { z } from 'zod';
import bs58 from 'bs58';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackMint } from '@solana/spl-token';
import type { Config } from '../config.js';
import type { Wallets } from '../wallets.js';
import {
  PendingTrade,
  ReviewRequired,
  TradeRejected,
  parseAmount,
  type ChainSettings,
  type Operation,
  type Quote,
  type SolanaStep,
  type SwapResult,
  type TokenInfo,
} from '../domain.js';
import { HttpClient } from '../infra/http.js';
import { MarketData } from '../providers/market.js';
import type { ChainAdapter } from './types.js';

export const SOL_MINT = 'So11111111111111111111111111111111111111112';
const unsignedRaw = z.string().regex(/^\d+$/);
const instructionSchema = z.object({
  programId: z.string(),
  accounts: z.array(
    z.object({ pubkey: z.string(), isSigner: z.boolean(), isWritable: z.boolean() }),
  ),
  data: z.string(),
});
const buildSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: unsignedRaw,
  outAmount: unsignedRaw,
  otherAmountThreshold: unsignedRaw,
  slippageBps: z.number(),
  transactionVersion: z.number().optional(),
  computeBudgetInstructions: z.array(instructionSchema),
  setupInstructions: z.array(instructionSchema),
  swapInstruction: instructionSchema,
  cleanupInstruction: instructionSchema.nullable(),
  otherInstructions: z.array(instructionSchema).default([]),
  tipInstruction: instructionSchema.nullable().optional(),
  addressesByLookupTableAddress: z.record(z.string(), z.array(z.string())).nullable(),
  blockhashWithMetadata: z.object({
    blockhash: z.array(z.number()),
    lastValidBlockHeight: z.number(),
  }),
  priceImpactPct: z.string().optional(),
});
const orderSchema = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  inAmount: unsignedRaw,
  outAmount: unsignedRaw,
  otherAmountThreshold: unsignedRaw,
  inUsdValue: z.number().nullable().optional(),
  outUsdValue: z.number().nullable().optional(),
  priceImpact: z.number().optional(),
  priceImpactPct: z.string().optional(),
  router: z.string().optional(),
});
const makeInstruction = (value: z.infer<typeof instructionSchema>): TransactionInstruction =>
  new TransactionInstruction({
    programId: new PublicKey(value.programId),
    keys: value.accounts.map((account) => ({
      pubkey: new PublicKey(account.pubkey),
      isSigner: account.isSigner,
      isWritable: account.isWritable,
    })),
    data: Buffer.from(value.data, 'base64'),
  });

export function solanaTokenDelta(
  receipt: VersionedTransactionResponse,
  mint: string,
  owner: string,
): bigint {
  const before = receipt.meta?.preTokenBalances ?? [];
  const after = receipt.meta?.postTokenBalances ?? [];
  const owned = new Set(
    [...before, ...after]
      .filter((balance) => balance.mint === mint && balance.owner === owner)
      .map((balance) => balance.accountIndex),
  );
  const sum = (balances: typeof before): bigint =>
    balances
      .filter((balance) => balance.mint === mint && owned.has(balance.accountIndex))
      .reduce((total, balance) => total + BigInt(balance.uiTokenAmount.amount), 0n);
  return sum(after) - sum(before);
}

export class SolanaAdapter implements ChainAdapter {
  readonly chain = 'solana' as const;
  readonly address: string;
  private readonly connection: Connection | null;
  constructor(
    private readonly config: Config,
    private readonly wallets: Wallets,
    private readonly http: HttpClient,
    private readonly market: MarketData,
  ) {
    this.address = wallets.solana.publicKey.toBase58();
    this.connection = config.solanaRpc
      ? new Connection(config.solanaRpc, {
          commitment: 'confirmed',
          disableRetryOnRateLimit: true,
          confirmTransactionInitialTimeout: config.httpTimeoutMs,
          fetch: (input, init) =>
            fetch(input, { ...init, signal: AbortSignal.timeout(config.httpTimeoutMs) }),
        })
      : null;
  }
  private rpc(): Connection {
    if (!this.connection) throw new Error('QUICKNODE_SOLANA_RPC_URL is missing');
    return this.connection;
  }
  readiness(settings: ChainSettings): string[] {
    const missing: string[] = [];
    if (!this.config.solanaRpc) missing.push('QUICKNODE_SOLANA_RPC_URL');
    if (!this.config.jupiterKey) missing.push('JUPITER_API_KEY');
    if (settings.mevProtection && !settings.jitoTipNative)
      missing.push('Jito tip in Solana settings');
    return missing;
  }
  async verifyNetwork(): Promise<void> {
    if ((await this.rpc().getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d')
      throw new Error('QuickNode endpoint is not Solana mainnet');
  }
  async balance(): Promise<{ nativeRaw: string; wrappedRaw: null }> {
    return {
      nativeRaw: (
        await this.rpc().getBalance(this.wallets.solana.publicKey, 'confirmed')
      ).toString(),
      wrappedRaw: null,
    };
  }
  async tokenInfo(address: string): Promise<TokenInfo> {
    const publicKey = new PublicKey(address);
    const account = await this.rpc().getAccountInfo(publicKey, 'confirmed');
    if (
      !account ||
      (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      throw new TradeRejected('Address is not a supported Solana token mint');
    const mint = unpackMint(publicKey, account, account.owner);
    if (!mint.isInitialized || mint.decimals > 36)
      throw new TradeRejected('Unsupported token mint precision or state');
    const data = await this.market.solana(address);
    return {
      chain: this.chain,
      address,
      symbol: data?.symbol ?? address.slice(0, 8),
      decimals: mint.decimals,
      marketCapUsd: data?.mcap ?? null,
      liquidityUsd: data?.liquidity ?? null,
      usdPrice: data?.usdPrice ?? null,
      fetchedAt: Date.now(),
    };
  }
  async quoteSell(address: string, amountRaw: string, settings: ChainSettings): Promise<Quote> {
    if (settings.sellSlippagePercent === null) throw new Error('Sell slippage is not configured');
    const query = new URLSearchParams({
      inputMint: address,
      outputMint: SOL_MINT,
      amount: amountRaw,
      slippageBps: String(Math.round(settings.sellSlippagePercent * 100)),
      excludeRouters: 'jupiterz,dflow,okx',
      maxSupportedTransactionVersion: '0',
    });
    const order = await this.http.json(
      'Jupiter quote',
      `https://api.jup.ag/swap/v2/order?${query}`,
      orderSchema,
      { headers: { 'x-api-key': this.config.jupiterKey } },
    );
    if (
      order.inputMint !== address ||
      order.outputMint !== SOL_MINT ||
      order.inAmount !== amountRaw ||
      BigInt(order.outAmount) <= 0n
    )
      throw new Error('Jupiter quote does not match the requested sale');
    return {
      inputRaw: amountRaw,
      outputRaw: order.outAmount,
      minOutputRaw: order.otherAmountThreshold,
      nativeUsd:
        typeof order.outUsdValue === 'number' && BigInt(order.outAmount) > 0n
          ? order.outUsdValue / (Number(order.outAmount) / 1e9)
          : null,
      priceImpactPercent:
        order.priceImpact ??
        (order.priceImpactPct === undefined ? null : Math.abs(Number(order.priceImpactPct) * 100)),
      receivedAt: Date.now(),
    };
  }
  async advance(
    operation: Operation,
    persist: () => void,
    beforeSwap: () => Promise<void>,
    beforeSpend: () => void,
  ): Promise<SwapResult> {
    await this.verifyNetwork();
    let step = operation.steps.find(
      (candidate): candidate is SolanaStep => candidate.type === 'solana',
    );
    if (!step) {
      await beforeSwap();
      step = await this.prepare(operation, beforeSpend);
      operation.steps.push(step);
      persist();
    }
    const receipt = await this.rpc().getTransaction(step.signature, {
      commitment: 'confirmed',
      maxSupportedTransactionVersion: 0,
    });
    if (receipt?.meta) {
      if (receipt.meta.err) throw new TradeRejected('Solana swap reverted on chain');
      const tokenDelta = solanaTokenDelta(receipt, operation.address, this.address);
      const keys = receipt.transaction.message.getAccountKeys({
        accountKeysFromLookups: receipt.meta.loadedAddresses,
      });
      let walletIndex = -1;
      for (let index = 0; index < keys.length; index++)
        if (keys.get(index)?.toBase58() === this.address) walletIndex = index;
      const before = receipt.meta.preBalances[walletIndex];
      const after = receipt.meta.postBalances[walletIndex];
      if (
        before === undefined ||
        after === undefined ||
        !Number.isSafeInteger(before) ||
        !Number.isSafeInteger(after)
      )
        throw new ReviewRequired('Could not reconcile the confirmed Solana balance change');
      const nativeDelta = BigInt(after) - BigInt(before);
      const tokenRaw = operation.kind === 'buy' ? tokenDelta : -tokenDelta;
      const nativeRaw = operation.kind === 'buy' ? -nativeDelta : nativeDelta;
      if (tokenRaw <= 0n || (operation.kind === 'buy' && nativeRaw <= 0n))
        throw new ReviewRequired('Confirmed Solana swap has unexpected balance changes');
      operation.swapHash = step.signature;
      return {
        tokenRaw: tokenRaw.toString(),
        nativeRaw: nativeRaw.toString(),
        feeNativeRaw: receipt.meta.fee.toString(),
        signature: step.signature,
        nativeUsd: operation.quote?.nativeUsd ?? null,
      };
    }
    const status = (
      await this.rpc().getSignatureStatuses([step.signature], { searchTransactionHistory: true })
    ).value[0];
    if (status?.err) throw new TradeRejected('Solana swap failed on chain');
    const height = await this.rpc().getBlockHeight('confirmed');
    if (height > step.lastValidBlockHeight + 32) {
      if (status)
        throw new ReviewRequired(
          'Solana signature exists but transaction accounting is unavailable',
        );
      throw new TradeRejected('Solana transaction expired without confirmation');
    }
    if (step.submittedAt === null || Date.now() - step.submittedAt > 15_000) {
      if (height > step.lastValidBlockHeight)
        throw new PendingTrade('Waiting for expired Solana transaction reconciliation');
      if (step.jito) {
        const bundleId = await this.http.rpc(
          'QuickNode Lil JIT',
          this.config.solanaJitoRpc,
          'sendBundle',
          [[bs58.encode(Buffer.from(step.serialized, 'base64'))]],
          z.string(),
        );
        step.bundleId = bundleId;
      } else
        await this.rpc().sendRawTransaction(Buffer.from(step.serialized, 'base64'), {
          skipPreflight: false,
          maxRetries: 0,
        });
      step.submittedAt = Date.now();
      persist();
    }
    throw new PendingTrade('Waiting for Solana confirmation');
  }
  private async prepare(operation: Operation, beforeSpend: () => void): Promise<SolanaStep> {
    const settings = operation.settings;
    const slippage =
      operation.kind === 'buy' ? settings.buySlippagePercent : settings.sellSlippagePercent;
    if (slippage === null || settings.maxNetworkFeeNative === null)
      throw new TradeRejected('Set slippage and the maximum network fee');
    const inputMint = operation.kind === 'buy' ? SOL_MINT : operation.address;
    const outputMint = operation.kind === 'buy' ? operation.address : SOL_MINT;
    const query = new URLSearchParams({
      inputMint,
      outputMint,
      amount: operation.amountRaw,
      taker: this.address,
      slippageBps: String(Math.round(slippage * 100)),
      transactionVersion: '0',
      wrapAndUnwrapSol: 'true',
      forJitoBundle: String(settings.mevProtection),
    });
    const built = await this.http.json(
      'Jupiter build',
      `https://api.jup.ag/swap/v2/build?${query}`,
      buildSchema,
      { headers: { 'x-api-key': this.config.jupiterKey } },
    );
    if (built.swapInstruction.programId !== 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4')
      throw new TradeRejected('Unexpected Jupiter swap program');
    if (
      built.inputMint !== inputMint ||
      built.outputMint !== outputMint ||
      built.inAmount !== operation.amountRaw ||
      built.transactionVersion === 1 ||
      BigInt(built.otherAmountThreshold) <= 0n ||
      built.slippageBps > Math.round(slippage * 100)
    )
      throw new TradeRejected('Jupiter build does not match the configured trade');
    const impact =
      built.priceImpactPct === undefined ? null : Math.abs(Number(built.priceImpactPct) * 100);
    if (
      operation.kind === 'buy' &&
      settings.filters.maxPriceImpactPercent !== null &&
      (impact === null ||
        !Number.isFinite(impact) ||
        impact > settings.filters.maxPriceImpactPercent)
    )
      throw new TradeRejected('Price impact is unknown or exceeds the configured limit');
    const tip = settings.mevProtection ? parseAmount(settings.jitoTipNative ?? '0', 9) : 0n;
    if (settings.mevProtection && tip < 1000n)
      throw new TradeRejected('Jito requires a tip of at least 0.000001 SOL');
    const maximumFee = parseAmount(settings.maxNetworkFeeNative, 9);
    if (
      operation.kind === 'sell' &&
      operation.minimumNativeRaw !== null &&
      BigInt(built.outAmount) < BigInt(operation.minimumNativeRaw)
    )
      throw new TradeRejected('Exit price changed; waiting for the configured profit');
    if (tip >= maximumFee) throw new TradeRejected('Jito tip exceeds the network fee limit');
    const instructions = [
      ...built.computeBudgetInstructions.map(makeInstruction),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ...built.setupInstructions.map(makeInstruction),
      ...built.otherInstructions.map(makeInstruction),
      makeInstruction(built.swapInstruction),
      ...(built.cleanupInstruction ? [makeInstruction(built.cleanupInstruction)] : []),
    ];
    if (built.tipInstruction) throw new TradeRejected('Unexpected Jupiter tip instruction');
    if (settings.mevProtection) {
      const accounts = await this.http.rpc(
        'QuickNode Lil JIT',
        this.config.solanaJitoRpc,
        'getTipAccounts',
        [],
        z.array(z.string()).min(1),
      );
      const destination = accounts[0];
      if (!destination) throw new TradeRejected('Jito tip accounts are unavailable');
      const transfer = SystemProgram.transfer({
        fromPubkey: this.wallets.solana.publicKey,
        toPubkey: new PublicKey(destination),
        lamports: tip,
      });
      transfer.keys.push({
        pubkey: new PublicKey('jitodontfront111111111111111111111111111111'),
        isSigner: false,
        isWritable: false,
      });
      instructions.push(transfer);
    }
    for (const instruction of instructions)
      for (const account of instruction.keys)
        if (account.isSigner && !account.pubkey.equals(this.wallets.solana.publicKey))
          throw new TradeRejected('Jupiter build requires an unexpected signer');
    const lookupTables: AddressLookupTableAccount[] = [];
    for (const address of Object.keys(built.addressesByLookupTableAddress ?? {})) {
      const table = (await this.rpc().getAddressLookupTable(new PublicKey(address))).value;
      if (!table) throw new TradeRejected('Swap lookup table is unavailable');
      lookupTables.push(table);
    }
    const lifetime = await this.rpc().getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: this.wallets.solana.publicKey,
      recentBlockhash: lifetime.blockhash,
      instructions,
    }).compileToV0Message(lookupTables);
    const fee = (await this.rpc().getFeeForMessage(message, 'confirmed')).value;
    if (fee === null || BigInt(fee) + tip > maximumFee)
      throw new TradeRejected('Solana network fee exceeds your limit');
    const transaction = new VersionedTransaction(message);
    beforeSpend();
    transaction.sign([this.wallets.solana]);
    if (transaction.serialize().length > 1232)
      throw new TradeRejected('Swap transaction exceeds the Solana size limit');
    const simulation = await this.rpc().simulateTransaction(transaction, {
      sigVerify: true,
      commitment: 'confirmed',
    });
    if (simulation.value.err)
      throw new TradeRejected('QuickNode simulation rejected the Solana swap');
    const balance = await this.rpc().getBalance(this.wallets.solana.publicKey, 'confirmed');
    if (operation.kind === 'buy' && BigInt(balance) <= BigInt(operation.amountRaw) + maximumFee)
      throw new TradeRejected('Insufficient SOL for the buy and network fee reserve');
    operation.quote = {
      inputRaw: built.inAmount,
      outputRaw: built.outAmount,
      minOutputRaw: built.otherAmountThreshold,
      nativeUsd: operation.quote?.nativeUsd ?? null,
      priceImpactPercent: impact,
      receivedAt: Date.now(),
    };
    beforeSpend();
    return {
      type: 'solana',
      key: 'swap',
      signature: bs58.encode(transaction.signatures[0]!),
      serialized: Buffer.from(transaction.serialize()).toString('base64'),
      lastValidBlockHeight: lifetime.lastValidBlockHeight,
      submittedAt: null,
      bundleId: null,
      jito: settings.mevProtection,
    };
  }
}
