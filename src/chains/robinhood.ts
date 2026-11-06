import { EvmAdapter } from './evm.js';
import { evmNetworks } from './networks.js';
import type { Config } from '../config.js';
import type { Wallets } from '../wallets.js';
import type { HttpClient } from '../infra/http.js';
import type { MarketData } from '../providers/market.js';

export { erc20Delta, validateClassicCalldata } from './evm.js';
export const ROBINHOOD_CHAIN_ID: number = evmNetworks.robinhood.chainId;
export const ROBINHOOD_WETH = evmNetworks.robinhood.wrappedNative;

export class RobinhoodAdapter extends EvmAdapter {
  constructor(config: Config, wallets: Wallets, http: HttpClient, market: MarketData) {
    super(config, wallets, http, market, 'robinhood');
  }
}
