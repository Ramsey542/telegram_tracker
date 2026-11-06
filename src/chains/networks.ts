import type { EvmChain } from '../domain.js';

export const evmNetworks = {
  robinhood: {
    chainId: 4663,
    dexChain: 'robinhood',
    name: 'Robinhood Chain',
    symbol: 'ETH',
    wrappedSymbol: 'WETH',
    wrappedNative: '0x0bd7d308f8e1639fab988df18a8011f41eacad73',
    rpcVariable: 'QUICKNODE_ROBINHOOD_RPC_URL',
    explorer: 'https://robinhoodchain.blockscout.com/tx/',
  },
  bnb: {
    chainId: 56,
    dexChain: 'bsc',
    name: 'BNB Smart Chain',
    symbol: 'BNB',
    wrappedSymbol: 'WBNB',
    wrappedNative: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c',
    rpcVariable: 'QUICKNODE_BNB_RPC_URL',
    explorer: 'https://bscscan.com/tx/',
  },
} as const satisfies Record<
  EvmChain,
  {
    chainId: number;
    dexChain: string;
    name: string;
    symbol: string;
    wrappedSymbol: string;
    wrappedNative: `0x${string}`;
    rpcVariable: string;
    explorer: string;
  }
>;
