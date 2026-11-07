import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomInt } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { config as loadEnv } from 'dotenv';
import {
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { createPublicClient, defineChain, http as rpcHttp, type Address } from 'viem';
import {
  channelRulesSchema,
  settingsSchema,
  parseAmount,
  type Chain,
  type ChainSettings,
} from '../src/domain.js';
import { readWalletAddresses } from '../src/wallets.js';
import { HttpClient } from '../src/infra/http.js';
import { redact, registerSecrets } from '../src/logging/redaction.js';
import { requestJupiterOrder, SOL_MINT } from '../src/chains/solana.js';
import { requestUniswapQuote, requestUniswapSwap } from '../src/chains/evm.js';
import { PumpRoutes } from '../src/chains/pump.js';
import { DirectEvmRoutes } from '../src/chains/direct-evm.js';
import { evmNetworks } from '../src/chains/networks.js';

const help = `Usage:
  npm run check:route -- jup <CA> [options]
  npm run check:route -- pump <CA> [options]
  npm run check:route -- uniswap <bnb|rh> <CA> [options]
  npm run check:route -- flap <bnb|rh> <CA> [options]
  npm run check:route -- pancake <bnb|rh> <CA> [options]

Options:
  --env <file>         Default: .env.test
  --data <directory>   Override DATA_DIRECTORY; existing wallet and tracker.sqlite required
  --channel <id>       Read this channel's chain settings instead of global chain settings
  --amount <values>    Native buy amounts, comma-separated; use random for a sample amount
  --slippage <percent> Override saved slippage; fallback is 10 when not configured
  --quote-only        Skip transaction construction
  --simulate          Uniswap only: ask /swap to simulate; never submits a transaction
  --help              Print usage

No transactions or permits are signed. No approvals, wraps or swaps are submitted.
No Telegram client, bot lock or trade engine is started. The database is opened read-only.
Uniswap uses WETH/WBNB and Classic V2/V3/V4 routes. Flap and Pump use native funds.
Uniswap builds omit permit signatures. Simulation can fail on missing funds or approvals.
Direct SDK builds do not prove a transaction will execute successfully on-chain.
`;

function print(event: string, fields: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify(redact({ event, ...fields }))}\n`);
}

function savedSettings(directory: string, chain: Chain, channel?: string): ChainSettings {
  const path = join(directory, 'tracker.sqlite');
  if (!existsSync(path)) throw new Error(`Existing test database not found: ${path}`);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const row = channel
      ? db
          .prepare('SELECT payload FROM call_channels WHERE id = ? OR channel_id = ?')
          .get(channel, channel)
      : db.prepare('SELECT payload FROM configuration WHERE id = 1').get();
    if (!row || typeof row.payload !== 'string')
      throw new Error(
        channel
          ? 'Channel settings not found; use its stored id or numeric channel id'
          : 'Saved configuration not found',
      );
    const payload = JSON.parse(row.payload);
    return channel
      ? channelRulesSchema.parse(payload.settings ?? {})[chain]
      : settingsSchema.parse(payload).chains[chain];
  } finally {
    db.close();
  }
}

function installNetworkGuard(rpcUrl: string, chain: Chain, timeout: number) {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (
      init?.method ?? (input instanceof Request ? input.method : 'GET')
    ).toUpperCase();
    const rpc = rpcUrl !== '' && url.href === new URL(rpcUrl).href;
    const jup =
      url.origin === 'https://api.jup.ag' && url.pathname === '/swap/v2/order' && method === 'GET';
    const uni =
      url.origin === 'https://trade-api.gateway.uniswap.org' &&
      ['/v1/quote', '/v1/swap'].includes(url.pathname) &&
      method === 'POST';
    if (!rpc && !jup && !uni)
      throw new Error('Diagnostic blocked a network request outside quote/build endpoints');
    let rpcMethods: string[] = [];
    if (rpc) {
      if (typeof init?.body !== 'string') throw new Error('Diagnostic requires a JSON RPC body');
      const parsed = JSON.parse(init.body);
      const calls: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
      rpcMethods = calls.map((call) => {
        if (
          !call ||
          typeof call !== 'object' ||
          !('method' in call) ||
          typeof call.method !== 'string'
        )
          throw new Error('Diagnostic blocked an invalid RPC request');
        const allowed =
          chain === 'solana'
            ? /^get[A-Z]/.test(call.method)
            : /^(eth_call|eth_estimateGas|eth_chainId|net_version|eth_get[A-Z]\w*)$/.test(
                call.method,
              );
        if (!allowed) throw new Error(`Diagnostic blocked RPC method: ${call.method}`);
        return call.method;
      });
    }
    const index = ++requests;
    const started = performance.now();
    const service = rpc
      ? `QuickNode ${chain}`
      : jup
        ? 'Jupiter order'
        : `Uniswap ${url.pathname.split('/').at(-1)}`;
    try {
      const response = await original(input, {
        ...init,
        signal: init?.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
      });
      print('request.completed', {
        index,
        service,
        rpcMethods,
        status: response.status,
        durationMs: Math.round(performance.now() - started),
      });
      return response;
    } catch (error) {
      print('request.failed', {
        index,
        service,
        rpcMethods,
        durationMs: Math.round(performance.now() - started),
        error,
      });
      throw error;
    }
  };
  return {
    count: () => requests,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function solanaTransaction(transaction: VersionedTransaction) {
  return {
    version: transaction.version,
    bytes: transaction.serialize().length,
    instructionCount: transaction.message.compiledInstructions.length,
    requiredSigners: transaction.message.staticAccountKeys
      .slice(0, transaction.message.header.numRequiredSignatures)
      .map((key) => key.toBase58()),
    signedByDiagnostic: false,
    submitted: false,
  };
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      env: { type: 'string', default: '.env.test' },
      data: { type: 'string' },
      channel: { type: 'string' },
      amount: { type: 'string' },
      slippage: { type: 'string' },
      'quote-only': { type: 'boolean', default: false },
      simulate: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help || !positionals.length) {
    process.stdout.write(help);
    return;
  }
  const provider = positionals[0];
  const solana = provider === 'jup' || provider === 'pump';
  if (!['jup', 'pump', 'uniswap', 'flap', 'pancake'].includes(provider!))
    throw new Error('Unknown provider; use --help');
  if (positionals.length !== (solana ? 2 : 3)) throw new Error('Invalid arguments; use --help');
  const chain: Chain = solana
    ? 'solana'
    : positionals[1] === 'bnb'
      ? 'bnb'
      : ['rh', 'robinhood'].includes(positionals[1]!)
        ? 'robinhood'
        : (() => {
            throw new Error('EVM chain must be bnb or rh');
          })();
  const address = positionals[solana ? 1 : 2]!;
  if (solana) new PublicKey(address);
  else if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Invalid EVM contract address');
  if (values.simulate && (provider !== 'uniswap' || values['quote-only']))
    throw new Error('--simulate requires uniswap without --quote-only');
  const envPath = resolve(values.env!);
  if (!existsSync(envPath)) throw new Error(`Environment file not found: ${envPath}`);
  const environment = loadEnv({ path: envPath, override: true, quiet: true });
  if (environment.error) throw environment.error;
  registerSecrets(
    Object.entries(process.env)
      .filter(([key]) => /KEY|SECRET|TOKEN|RPC_URL|API_HASH|PHONE/i.test(key))
      .map(([, value]) => value ?? ''),
  );
  const directory = resolve(values.data ?? process.env.DATA_DIRECTORY ?? '.data/test');
  const settings = savedSettings(directory, chain, values.channel);
  const wallets = readWalletAddresses({
    dataDirectory: directory,
    walletEncryptionKey: process.env.WALLET_ENCRYPTION_KEY?.trim() ?? '',
  });
  const owner = wallets[chain];
  if (!owner) throw new Error(`No existing ${chain} wallet; diagnostic will not create one`);
  settings.mevProtection = false;
  settings.slippagePercent =
    values.slippage === undefined ? (settings.slippagePercent ?? 10) : Number(values.slippage);
  if (
    !Number.isFinite(settings.slippagePercent) ||
    settings.slippagePercent < 0 ||
    settings.slippagePercent >= 100
  )
    throw new Error('Slippage must be at least 0 and less than 100');
  const samples =
    chain === 'robinhood'
      ? ['0.0001', '0.0005', '0.001', '0.0048']
      : ['0.001', '0.005', '0.01', '0.02'];
  const amounts = (values.amount ?? settings.buySizeNative ?? 'random').split(',').map((amount) => {
    const value = amount.trim();
    return value === 'random' ? samples[randomInt(samples.length)]! : value;
  });
  if (!amounts.length || amounts.length > 10) throw new Error('Supply between 1 and 10 amounts');
  const rawAmounts = amounts.map((amount) => {
    if (!/^\d+(?:\.\d+)?$/.test(amount))
      throw new Error('Amounts must be plain positive decimal numbers or random');
    const raw = parseAmount(amount, solana ? 9 : 18);
    if (raw <= 0n) throw new Error('Amount must be greater than zero');
    return raw;
  });
  const rpcVariable =
    chain === 'solana' ? 'QUICKNODE_SOLANA_RPC_URL' : evmNetworks[chain].rpcVariable;
  const rpcUrl = process.env[rpcVariable]?.trim() ?? '';
  if (rpcUrl && new URL(rpcUrl).protocol !== 'https:')
    throw new Error(`${rpcVariable} must use HTTPS`);
  if (provider !== 'jup' && provider !== 'uniswap' && !rpcUrl)
    throw new Error(`Missing ${rpcVariable}`);
  const jupiterKey = process.env.JUPITER_API_KEY?.trim() ?? '';
  const uniswapKey = process.env.UNISWAP_API_KEY?.trim() ?? '';
  if (provider === 'jup' && !jupiterKey) throw new Error('Missing JUPITER_API_KEY');
  if (provider === 'uniswap' && !uniswapKey) throw new Error('Missing UNISWAP_API_KEY');
  const timeout = Number(process.env.HTTP_TIMEOUT_SECONDS ?? 15) * 1000;
  const rps = Number(process.env.JUPITER_REQUESTS_PER_SECOND ?? 1);
  if (
    !Number.isFinite(timeout) ||
    timeout < 3000 ||
    timeout > 120000 ||
    !Number.isFinite(rps) ||
    rps <= 0 ||
    rps > 150
  )
    throw new Error('Invalid HTTP_TIMEOUT_SECONDS or JUPITER_REQUESTS_PER_SECOND');
  const http = new HttpClient(timeout, rps);
  print('diagnostic.started', {
    provider,
    chain,
    address,
    wallet: owner,
    environment: envPath,
    dataDirectory: directory,
    channel: values.channel ?? null,
    amounts,
    slippagePercent: settings.slippagePercent,
    priorityFee: settings.priorityFee,
    build: !values['quote-only'],
    simulate: values.simulate,
    signing: false,
    submission: false,
    filtersApplied: false,
  });
  const guard = installNetworkGuard(rpcUrl, chain, timeout);
  const started = performance.now();
  let failures = 0;
  try {
    for (let index = 0; index < rawAmounts.length; index++) {
      const amount = rawAmounts[index]!;
      const attemptStarted = performance.now();
      const requestStart = guard.count();
      let quoteAvailable = false;
      try {
        print('attempt.started', { amount: amounts[index], amountRaw: amount.toString() });
        if (provider === 'jup') {
          const order = await requestJupiterOrder(
            http,
            jupiterKey,
            SOL_MINT,
            address,
            amount.toString(),
            owner,
            settings,
          );
          if (
            order.inputMint !== SOL_MINT ||
            order.outputMint !== address ||
            order.inAmount !== amount.toString() ||
            BigInt(order.outAmount) <= 0n ||
            BigInt(order.otherAmountThreshold) <= 0n
          )
            throw new Error('Jupiter order does not match the requested buy');
          quoteAvailable = true;
          print('quote.available', {
            provider,
            inputRaw: order.inAmount,
            outputRaw: order.outAmount,
            minimumRaw: order.otherAmountThreshold,
            router: order.router,
            requestId: order.requestId,
            inUsdValue: order.inUsdValue,
            outUsdValue: order.outUsdValue,
            errorCode: order.errorCode,
            errorMessage: order.errorMessage,
          });
          if (!values['quote-only']) {
            if (!order.transaction)
              throw new Error(
                `Jupiter returned no transaction: ${order.errorMessage ?? order.error ?? 'unknown build error'}`,
              );
            const transaction = VersionedTransaction.deserialize(
              Buffer.from(order.transaction, 'base64'),
            );
            print('transaction.built', { provider, ...solanaTransaction(transaction) });
          }
        } else if (provider === 'pump') {
          const connection = new Connection(rpcUrl, {
            commitment: 'confirmed',
            disableRetryOnRateLimit: true,
            fetch: globalThis.fetch,
          });
          if (
            (await connection.getGenesisHash()) !== '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
          )
            throw new Error('RPC is not Solana mainnet');
          const route = await new PumpRoutes(connection, new PublicKey(owner)).quote(
            address,
            amount,
            true,
            settings.slippagePercent,
            !values['quote-only'],
          );
          if (!route)
            throw new Error(
              'No supported direct Pump route; no automatic Jupiter fallback in this diagnostic',
            );
          quoteAvailable = true;
          print('quote.available', { provider, venue: route.venue, quote: route.quote });
          if (!values['quote-only']) {
            const { blockhash } = await connection.getLatestBlockhash('confirmed');
            const transaction = new VersionedTransaction(
              new TransactionMessage({
                payerKey: new PublicKey(owner),
                recentBlockhash: blockhash,
                instructions: [
                  ComputeBudgetProgram.setComputeUnitLimit({ units: 600000 }),
                  ...route.instructions,
                ],
              }).compileToV0Message(),
            );
            print('transaction.built', {
              provider,
              ...solanaTransaction(transaction),
              priorityFeeIncluded: false,
            });
          }
        } else if (chain !== 'solana') {
          const network = evmNetworks[chain];
          if (provider === 'uniswap') {
            const response = await requestUniswapQuote(
              http,
              uniswapKey,
              chain,
              owner,
              network.wrappedNative,
              address,
              amount.toString(),
              settings,
            );
            quoteAvailable = true;
            print('quote.available', {
              provider,
              routing: response.routing,
              quote: response.quote,
              permitRequired: response.permitData != null,
            });
            if (!values['quote-only']) {
              if (response.routing !== 'CLASSIC')
                throw new Error(
                  'Only Classic calldata construction is supported by this unsigned diagnostic',
                );
              const built = await requestUniswapSwap(http, uniswapKey, {
                quote: response.quote,
                simulateTransaction: values.simulate,
                refreshGasPrice: true,
                deadline: Math.floor(Date.now() / 1000) + 120,
              });
              if (
                built.swap.chainId !== network.chainId ||
                (built.swap.from && built.swap.from.toLowerCase() !== owner.toLowerCase())
              )
                throw new Error('Uniswap transaction chain or wallet mismatch');
              print('transaction.built', {
                provider,
                to: built.swap.to,
                value: built.swap.value,
                calldataBytes: (built.swap.data.length - 2) / 2,
                gasLimit: built.swap.gasLimit,
                permitSignatureIncluded: false,
                permitRequired: response.permitData != null,
                simulate: values.simulate,
                signedByDiagnostic: false,
                submitted: false,
                warning:
                  response.permitData != null
                    ? 'Permit signature omitted; this build does not prove existing authorization is sufficient'
                    : undefined,
              });
            }
          } else {
            const client = createPublicClient({
              chain: defineChain({
                id: network.chainId,
                name: network.name,
                nativeCurrency: { name: network.symbol, symbol: network.symbol, decimals: 18 },
                contracts: {
                  multicall3: {
                    address:
                      chain === 'bnb'
                        ? '0xca11bde05977b3631167028862be2a173976ca11'
                        : '0xd59aae32bcf95aae58119751d5e355c9855cdc31',
                  },
                },
                rpcUrls: { default: { http: [rpcUrl] } },
              }),
              transport: rpcHttp(rpcUrl, { retryCount: 0, timeout, fetchFn: globalThis.fetch }),
            });
            if ((await client.getChainId()) !== network.chainId)
              throw new Error('RPC chain ID mismatch');
            const routes = new DirectEvmRoutes(chain, client, owner as Address);
            if (provider === 'flap' && !(await routes.flapState(address as Address)))
              throw new Error('Token is not registered with this chain Flap Portal');
            const plan =
              provider === 'pancake'
                ? await routes.quotePancake(
                    address as Address,
                    amount,
                    true,
                    settings.slippagePercent,
                  )
                : await routes.quote(address as Address, amount, true, settings.slippagePercent);
            if (!plan || (provider === 'flap' && plan.venue !== 'flap'))
              throw new Error('No supported direct route was found');
            quoteAvailable = true;
            print('quote.available', {
              provider,
              venue: plan.venue,
              outputRaw: plan.outputRaw,
              minimumRaw: plan.minimumRaw,
              inputToken: plan.inputToken,
              outputToken: plan.outputToken,
            });
            if (!values['quote-only'])
              print('transaction.built', {
                provider,
                venue: plan.venue,
                to: plan.to,
                value: plan.value,
                calldataBytes: (plan.data.length - 2) / 2,
                approvalSpender: plan.spender,
                permit2SignatureRequired: Boolean(plan.permit2),
                wrappingSubmitted: false,
                approvalsSubmitted: false,
                signedByDiagnostic: false,
                submitted: false,
                warning:
                  'Unsigned route payload only; gas, allowance, funds and Permit2 signing are not validated',
              });
          }
        }
        print('attempt.completed', {
          amount: amounts[index],
          durationMs: Math.round(performance.now() - attemptStarted),
          requests: guard.count() - requestStart,
          quoteAvailable,
          submitted: false,
        });
      } catch (error) {
        failures++;
        print('attempt.failed', {
          amount: amounts[index],
          quoteAvailable,
          durationMs: Math.round(performance.now() - attemptStarted),
          requests: guard.count() - requestStart,
          error,
        });
      }
    }
  } finally {
    guard.restore();
    print('diagnostic.finished', {
      attempts: amounts.length,
      failures,
      requests: guard.count(),
      durationMs: Math.round(performance.now() - started),
      signed: false,
      submitted: false,
    });
  }
  if (failures) process.exitCode = 1;
}

main().catch((error: unknown) => {
  print('diagnostic.failed', { error, signed: false, submitted: false });
  process.exitCode = 1;
});
