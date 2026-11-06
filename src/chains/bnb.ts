import { EvmAdapter } from './evm.js';
import type { Config } from '../config.js';
import type { Wallets } from '../wallets.js';
import type { HttpClient } from '../infra/http.js';
import type { MarketData } from '../providers/market.js';

export class BnbAdapter extends EvmAdapter {
  constructor(config: Config, wallets: Wallets, http: HttpClient, market: MarketData) {
    super(config, wallets, http, market, 'bnb');
  }
}
