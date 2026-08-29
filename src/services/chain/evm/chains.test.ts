// Tests for the EVM chain registry (phase 1). Every value is hard-coded here
// deliberately: this suite is the pin that catches an accidental edit to the
// registry data, not a mirror of chains.ts's own logic.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EVM_CHAIN_KEY,
  EVM_CHAINS,
  evmChainByKey,
  evmChainById,
  evmChainIdHex,
  evmExplorerTxUrl,
  isEvmChainKey,
  type EvmChain,
} from './chains';

describe('1. registry shape', () => {
  it('holds exactly four chains, keys base, bsc, ethereum, epix in that order (base stays first: it is the default)', () => {
    expect(EVM_CHAINS).toHaveLength(4);
    expect(EVM_CHAINS.map((c) => c.key)).toEqual(['base', 'bsc', 'ethereum', 'epix']);
  });
});

describe('2. chain ids', () => {
  it('base is 8453, bsc is 56, ethereum is 1, epix is 1916, all unique', () => {
    const base = evmChainByKey('base');
    const bsc = evmChainByKey('bsc');
    expect(base?.chainId).toBe(8453);
    expect(bsc?.chainId).toBe(56);
    expect(evmChainByKey('ethereum')?.chainId).toBe(1);
    expect(evmChainByKey('epix')?.chainId).toBe(1916);
  });

  it('chainIds are unique across the registry', () => {
    const ids = EVM_CHAINS.map((c) => c.chainId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('keys are unique across the registry', () => {
    const keys = EVM_CHAINS.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('3. fee models and L1 data fee', () => {
  it('base is eip1559 and bsc is legacy: the two fee models differ', () => {
    const base = evmChainByKey('base');
    const bsc = evmChainByKey('bsc');
    expect(base?.feeModel).toBe('eip1559');
    expect(bsc?.feeModel).toBe('legacy');
    expect(base?.feeModel).not.toBe(bsc?.feeModel);
  });

  it('only base carries l1DataFee: "optimism"', () => {
    const base = evmChainByKey('base');
    const bsc = evmChainByKey('bsc');
    expect(base?.l1DataFee).toBe('optimism');
    expect(bsc?.l1DataFee).toBeUndefined();
    expect(evmChainByKey('ethereum')?.l1DataFee).toBeUndefined();
    expect(evmChainByKey('epix')?.l1DataFee).toBeUndefined();
  });

  it('epix is eip1559 (base fee read live 2026-08-20, 20 gwei on every block)', () => {
    expect(evmChainByKey('epix')?.feeModel).toBe('eip1559');
  });
});

describe('3b. epix: the first row that is NOT on Alchemy (phase 6)', () => {
  it('carries its own RPC and a Blockscout indexer, and no Alchemy/token-list/mark source', () => {
    const epix = evmChainByKey('epix');
    if (!epix) throw new Error('epix chain missing from registry');
    expect(epix.displayName).toBe('Epix');
    expect(epix.nativeTicker).toBe('EPIX');
    expect(epix.nativeDecimals).toBe(18);
    expect(epix.rpc).toEqual(['https://evmrpc.epix.zone']);
    expect(epix.indexer).toEqual({ family: 'blockscout', baseUrl: 'https://scan.epix.zone/api/v1' });
    expect(epix.explorerTxUrl).toBe('https://scan.epix.zone/tx/{txid}');
    // The absences are the point: no alchemy_* on this route, no Trust Wallet
    // folder, no CoinGecko list, and no ERC-20 contracts on the chain yet.
    expect(epix.alchemyNetwork).toBeUndefined();
    expect(epix.trustWalletChain).toBeUndefined();
    expect(epix.tokenListSlug).toBeUndefined();
    expect(epix.defaultTokens).toEqual([]);
  });

  it('every other row still names an Alchemy network (epix is the only direct-upstream chain so far)', () => {
    expect(EVM_CHAINS.filter((c) => !c.alchemyNetwork).map((c) => c.key)).toEqual(['epix']);
  });
});

describe('3c. native staking is a per-chain capability, carried by epix alone', () => {
  it('epix carries the cosmos/evm staking row, verified live 2026-08-24', () => {
    const epix = evmChainByKey('epix');
    if (!epix) throw new Error('epix chain missing from registry');
    expect(epix.staking).toEqual({
      kind: 'cosmos-evm',
      // The cosmos/evm STATIC precompile addresses. eth_call of
      // delegation(address,string) and eth_estimateGas of
      // delegate(address,string,uint256) both answered on 0x...800, and
      // withdrawDelegatorRewards reached the module's own logic on 0x...801.
      stakingPrecompile: '0x0000000000000000000000000000000000000800',
      distributionPrecompile: '0x0000000000000000000000000000000000000801',
      valoperPrefix: 'epixvaloper',
      accountPrefix: 'epix',
      // /cosmos/staking/v1beta1/params answered bond_denom "aepix".
      bondDenom: 'aepix',
      restBaseUrl: 'https://api.epix.zone',
    });
  });

  it('NO other chain has a staking row: the feature is opt-in per chain, never a default', () => {
    expect(EVM_CHAINS.filter((c) => c.staking).map((c) => c.key)).toEqual(['epix']);
    for (const chain of EVM_CHAINS) {
      if (chain.key === 'epix') continue;
      expect(chain.staking, `${chain.key} must not carry a staking row`).toBeUndefined();
    }
  });

  it('the staking row is frozen with the rest of the chain', () => {
    const epix = evmChainByKey('epix');
    expect(Object.isFrozen(epix?.staking)).toBe(true);
  });
});

describe('4. every row is well-formed', () => {
  it.each(EVM_CHAINS)('$key: decimals, rpc, explorer, indexer', (chain: EvmChain) => {
    expect(chain.nativeDecimals).toBe(18);

    expect(chain.rpc.length).toBeGreaterThan(0);
    for (const url of chain.rpc) {
      expect(url.startsWith('https://')).toBe(true);
    }

    const occurrences = chain.explorerTxUrl.split('{txid}').length - 1;
    expect(occurrences).toBe(1);

    // An indexer is optional (BNB Chain has none this build can use without a
    // key); when present it must be an https host.
    if (chain.indexer) expect(chain.indexer.baseUrl.startsWith('https://')).toBe(true);
  });
});

describe('5. lookup helpers', () => {
  it('evmChainByKey resolves a known key and rejects an unknown one', () => {
    expect(evmChainByKey('base')?.chainId).toBe(8453);
    expect(evmChainByKey('nope')).toBeUndefined();
  });

  it('evmChainById resolves a known id and rejects an unknown one', () => {
    expect(evmChainById(56)?.key).toBe('bsc');
    expect(evmChainById(999999)).toBeUndefined();
  });

  it('isEvmChainKey reflects registry membership', () => {
    expect(isEvmChainKey('base')).toBe(true);
    expect(isEvmChainKey('bsc')).toBe(true);
    expect(isEvmChainKey('ethereum')).toBe(true);
    expect(isEvmChainKey('epix')).toBe(true);
    expect(isEvmChainKey('polygon')).toBe(false);
  });
});

describe('6. evmExplorerTxUrl', () => {
  it('builds the basescan URL and keeps the 0x prefix as given', () => {
    const base = evmChainByKey('base');
    if (!base) throw new Error('base chain missing from registry');
    const url = evmExplorerTxUrl(base, '0xabc123');
    expect(url).toBe('https://basescan.org/tx/0xabc123');
  });

  it('builds the bscscan URL the same way', () => {
    const bsc = evmChainByKey('bsc');
    if (!bsc) throw new Error('bsc chain missing from registry');
    const url = evmExplorerTxUrl(bsc, '0xdeadbeef');
    expect(url).toBe('https://bscscan.com/tx/0xdeadbeef');
  });
});

describe('7. evmChainIdHex', () => {
  it('base 8453 -> 0x2105', () => {
    const base = evmChainByKey('base');
    if (!base) throw new Error('base chain missing from registry');
    expect(evmChainIdHex(base)).toBe('0x2105');
  });

  it('bsc 56 -> 0x38', () => {
    const bsc = evmChainByKey('bsc');
    if (!bsc) throw new Error('bsc chain missing from registry');
    expect(evmChainIdHex(bsc)).toBe('0x38');
  });

  it('epix 1916 -> 0x77c (what the chain itself answered to eth_chainId on 2026-08-20)', () => {
    const epix = evmChainByKey('epix');
    if (!epix) throw new Error('epix chain missing from registry');
    expect(evmChainIdHex(epix)).toBe('0x77c');
  });
});

describe('8. registry is frozen', () => {
  it('EVM_CHAINS itself is frozen', () => {
    expect(Object.isFrozen(EVM_CHAINS)).toBe(true);
  });

  it('each row is frozen', () => {
    for (const chain of EVM_CHAINS) {
      expect(Object.isFrozen(chain)).toBe(true);
    }
  });

  it('assigning a field on a row throws in strict mode', () => {
    const base = evmChainByKey('base');
    if (!base) throw new Error('base chain missing from registry');
    expect(() => {
      // Not a readonly field in the type (only the array element and the
      // array itself are typed readonly), so this compiles; Object.freeze at
      // runtime is what makes the assignment throw, which is what this
      // asserts.
      base.displayName = 'Tampered';
    }).toThrow(TypeError);
  });

  it('pushing onto EVM_CHAINS throws in strict mode', () => {
    expect(() => {
      // @ts-expect-error intentional mutation of a frozen, readonly array
      EVM_CHAINS.push(EVM_CHAINS[0]);
    }).toThrow(TypeError);
  });
});

describe('9. default chain', () => {
  it('DEFAULT_EVM_CHAIN_KEY resolves to a registry row', () => {
    expect(DEFAULT_EVM_CHAIN_KEY).toBe('base');
    const row = evmChainByKey(DEFAULT_EVM_CHAIN_KEY);
    expect(row).toBeDefined();
    expect(row?.key).toBe(DEFAULT_EVM_CHAIN_KEY);
  });
});

describe('10. default tokens (phase 2)', () => {
  it('each chain lists exactly one default token, checksummed, with the live-read decimals', () => {
    const base = evmChainByKey('base')!;
    const bsc = evmChainByKey('bsc')!;
    expect(base.defaultTokens).toEqual([
      { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', decimals: 6 },
    ]);
    expect(bsc.defaultTokens).toEqual([
      { address: '0x55d398326f99059fF775485246999027B3197955', symbol: 'USDT', decimals: 18 },
    ]);
  });
  it('default token rows are frozen', () => {
    for (const chain of EVM_CHAINS) {
      expect(Object.isFrozen(chain.defaultTokens)).toBe(true);
      for (const t of chain.defaultTokens ?? []) expect(Object.isFrozen(t)).toBe(true);
    }
  });
});
