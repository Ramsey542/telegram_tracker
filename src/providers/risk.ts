import { z } from 'zod';
import { Connection, PublicKey } from '@solana/web3.js';
import { unpackMint, getExtensionTypes, ExtensionType } from '@solana/spl-token';
import type { Config } from '../config.js';
import type { ChainSettings, TokenInfo } from '../domain.js';
import { HttpClient } from '../infra/http.js';
import { MarketData } from './market.js';

const riskFlag = z.string().optional();
const securitySchema = z.object({
  is_honeypot: riskFlag,
  is_mintable: riskFlag,
  is_blacklisted: riskFlag,
  transfer_pausable: riskFlag,
  is_proxy: riskFlag,
  buy_tax: riskFlag,
  sell_tax: riskFlag,
});
export class RiskFilters {
  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
    private readonly market: MarketData,
  ) {}
  async check(token: TokenInfo, settings: ChainSettings): Promise<void> {
    const filters = settings.filters;
    if (Date.now() - token.fetchedAt > 30_000) throw new Error('Entry market data is stale');
    if (filters.marketCapEnabled) {
      if (token.marketCapUsd === null || token.marketCapUsd <= 0)
        throw new Error('Current market cap is unavailable');
      if (filters.minMarketCapUsd !== null && token.marketCapUsd < filters.minMarketCapUsd)
        throw new Error('Current market cap is below the minimum');
      if (filters.maxMarketCapUsd !== null && token.marketCapUsd > filters.maxMarketCapUsd)
        throw new Error('Current market cap is above the maximum');
    }
    if (
      filters.minLiquidityUsd !== null &&
      (token.liquidityUsd === null || token.liquidityUsd < filters.minLiquidityUsd)
    )
      throw new Error('Liquidity is unavailable or below the minimum');
    if (token.chain === 'solana') await this.solana(token.address, settings);
    else await this.robinhood(token.address, settings);
  }
  private async solana(address: string, settings: ChainSettings): Promise<void> {
    const filters = settings.filters;
    if (
      filters.rejectMintAuthority ||
      filters.rejectFreezeAuthority ||
      filters.rejectTokenExtensions
    ) {
      const connection = new Connection(this.config.solanaRpc, {
        commitment: 'confirmed',
        fetch: (input, init) =>
          fetch(input, { ...init, signal: AbortSignal.timeout(this.config.httpTimeoutMs) }),
      });
      const publicKey = new PublicKey(address);
      const account = await connection.getAccountInfo(publicKey, 'confirmed');
      if (!account) throw new Error('Token mint account is unavailable');
      const mint = unpackMint(publicKey, account, account.owner);
      if (filters.rejectMintAuthority && mint.mintAuthority !== null)
        throw new Error('Mint authority is enabled');
      if (filters.rejectFreezeAuthority && mint.freezeAuthority !== null)
        throw new Error('Freeze authority is enabled');
      const metadataOnly = [
        ExtensionType.MetadataPointer,
        ExtensionType.TokenMetadata,
        ExtensionType.GroupPointer,
        ExtensionType.TokenGroup,
        ExtensionType.GroupMemberPointer,
        ExtensionType.TokenGroupMember,
      ];
      if (
        filters.rejectTokenExtensions &&
        getExtensionTypes(mint.tlvData).some((type) => !metadataOnly.includes(type))
      )
        throw new Error('Token has a privileged or unsupported Token-2022 extension');
    }
    if (filters.rugcheckEnabled) {
      const report = await this.http.json(
        'Rugcheck',
        `https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`,
        z.object({
          score_normalised: z.number().min(0).max(100),
          error: z.string().optional(),
          risks: z.array(z.unknown()).optional(),
        }),
        {
          headers: this.config.rugcheckKey
            ? { Authorization: `Bearer ${this.config.rugcheckKey}` }
            : {},
        },
      );
      if (
        report.error ||
        filters.maxRugcheckScore === null ||
        report.score_normalised > filters.maxRugcheckScore
      )
        throw new Error('Rugcheck score is unavailable or exceeds the maximum');
    }
    if (filters.maxTopHoldersPercent !== null) {
      const metadata = await this.market.solana(address);
      const concentration = metadata?.audit?.topHoldersPercentage;
      if (typeof concentration !== 'number' || concentration > filters.maxTopHoldersPercent)
        throw new Error('Holder concentration is unavailable or exceeds the maximum');
    }
  }
  private async robinhood(address: string, settings: ChainSettings): Promise<void> {
    const filters = settings.filters;
    const enabled =
      filters.rejectHoneypot ||
      filters.rejectMintAuthority ||
      filters.rejectBlacklist ||
      filters.rejectPausable ||
      filters.rejectProxy ||
      filters.maxTaxPercent !== null;
    if (!enabled) return;
    const response = await this.http.json(
      'GoPlus',
      `https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${address}`,
      z.object({ code: z.number(), result: z.record(z.string(), securitySchema) }),
      {
        headers: this.config.goplusToken
          ? { Authorization: `Bearer ${this.config.goplusToken}` }
          : {},
      },
    );
    if (response.code !== 1) throw new Error('GoPlus security data is incomplete');
    const report = response.result[address.toLowerCase()];
    if (!report) throw new Error('GoPlus has no analysis for this token');
    const checks: [boolean, string | undefined, string][] = [
      [filters.rejectHoneypot, report.is_honeypot, 'Honeypot'],
      [filters.rejectMintAuthority, report.is_mintable, 'Minting'],
      [filters.rejectBlacklist, report.is_blacklisted, 'Blacklist'],
      [filters.rejectPausable, report.transfer_pausable, 'Pausable transfers'],
      [filters.rejectProxy, report.is_proxy, 'Upgradeable proxy'],
    ];
    for (const [active, flag, label] of checks)
      if (active && flag !== '0')
        throw new Error(`${label}: ${flag === '1' ? 'detected' : 'unknown'}`);
    if (filters.maxTaxPercent !== null) {
      for (const value of [report.buy_tax, report.sell_tax])
        if (
          value === undefined ||
          value === '' ||
          !Number.isFinite(Number(value)) ||
          Number(value) < 0 ||
          Number(value) * 100 > filters.maxTaxPercent
        )
          throw new Error('Token tax is unknown or exceeds the maximum');
    }
  }
}
