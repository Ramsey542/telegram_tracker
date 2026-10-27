import { z } from 'zod';
import { Connection, PublicKey } from '@solana/web3.js';
import {
  unpackMint,
  getExtensionTypes,
  ExtensionType,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { Config } from '../config.js';
import type { ChainSettings, TokenInfo } from '../domain.js';
import { HttpClient } from '../infra/http.js';
import { logger } from '../logging/logger.js';
import { GoPlusClient } from './goplus.js';

const log = logger.child({ component: 'risk.filters' });

export class RiskFilters {
  private readonly goplus: GoPlusClient;
  constructor(
    private readonly config: Config,
    private readonly http: HttpClient,
  ) {
    this.goplus = new GoPlusClient(config, http);
  }
  async check(token: TokenInfo, settings: ChainSettings): Promise<void> {
    log.info('risk.check_started', {
      chain: token.chain,
      token: token.address,
      marketCapUsd: token.marketCapUsd,
      liquidityUsd: token.liquidityUsd,
      dataAgeMs: Date.now() - token.fetchedAt,
      filters: settings.filters,
    });
    try {
      await this.checkCurrent(token, settings);
      log.info('risk.check_passed', {
        chain: token.chain,
        token: token.address,
        marketCapUsd: token.marketCapUsd,
        liquidityUsd: token.liquidityUsd,
      });
    } catch (error) {
      log.error('risk.check_failed', error, {
        chain: token.chain,
        token: token.address,
        filters: settings.filters,
        marketCapUsd: token.marketCapUsd,
        liquidityUsd: token.liquidityUsd,
      });
      throw error;
    }
  }
  private async checkCurrent(token: TokenInfo, settings: ChainSettings): Promise<void> {
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
    if (token.chain === 'solana') await this.solana(token, settings);
    else await this.robinhood(token.address, settings);
  }
  private async solana(token: TokenInfo, settings: ChainSettings): Promise<void> {
    const address = token.address;
    const filters = settings.filters;
    if (
      filters.rejectMintAuthority ||
      filters.rejectFreezeAuthority ||
      filters.rejectTokenExtensions
    ) {
      const connection = new Connection(this.config.solanaRpc, {
        commitment: 'confirmed',
        disableRetryOnRateLimit: true,
        fetch: (input, init) => this.http.fetch('QuickNode Solana RPC', input, init),
      });
      const publicKey = new PublicKey(address);
      const account = await connection.getAccountInfo(publicKey, 'confirmed');
      if (
        !account ||
        (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID))
      )
        throw new Error('Token mint account is unavailable or has an unsupported owner');
      const mint = unpackMint(publicKey, account, account.owner);
      if (!mint.isInitialized || mint.decimals > 36)
        throw new Error('Token mint state is unsupported');
      log.info('risk.mint_authorities', {
        token: address,
        mintAuthority: mint.mintAuthority?.toBase58() ?? null,
        freezeAuthority: mint.freezeAuthority?.toBase58() ?? null,
        extensions: getExtensionTypes(mint.tlvData).map((type) => ExtensionType[type]),
      });
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
      log.info('risk.rugcheck_result', {
        service: 'Rugcheck',
        token: address,
        report,
        maximumScore: filters.maxRugcheckScore,
      });
      if (
        report.error ||
        filters.maxRugcheckScore === null ||
        report.score_normalised > filters.maxRugcheckScore
      )
        throw new Error('Rugcheck score is unavailable or exceeds the maximum');
    }
    if (filters.maxTopHoldersPercent !== null) {
      const concentration = token.topHoldersPercent;
      log.info('risk.holder_concentration', {
        service: 'Jupiter token data',
        token: address,
        observedPercent: concentration,
        maximumPercent: filters.maxTopHoldersPercent,
      });
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
    if (!enabled) {
      log.info('risk.goplus_skipped', { token: address, reason: 'security_filters_disabled' });
      return;
    }
    const report = await this.goplus.security(address);
    log.info('risk.goplus_result', { service: 'GoPlus', token: address, report });
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
