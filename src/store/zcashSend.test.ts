import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryStorageAdapter, setStorageForTests } from '../services/storage';
import type { ZcashSnapshot } from '../services/chain/zcash/reader';
import type { ZcashSignedTx } from '../services/chain/zcash/builder';

const hoisted = vi.hoisted(() => ({
  activeWalletId: 'w1' as string | null,
  snapshot: null as unknown,
  status: 'ready' as string,
  chain: null as unknown,
  keysError: null as Error | null,
  keys: { primary: { address: 't1primary' } } as unknown,
}));

vi.mock('./liveStore', () => ({
  useLiveStore: {
    getState: () => ({
      activeWalletId: hoisted.activeWalletId,
      zcash: { snapshot: hoisted.snapshot, chain: hoisted.chain, status: hoisted.status },
      zcashKeysOfActive: () => {
        if (hoisted.keysError) throw hoisted.keysError;
        return hoisted.keys;
      },
    }),
  },
}));

const zeroZcashKeysMock = vi.fn();
vi.mock('../services/chain/zcash/keys', () => ({
  zeroZcashKeys: (...args: unknown[]) => zeroZcashKeysMock(...args),
}));

const zcashRpcMock = vi.fn();
const sendMock = vi.fn();
vi.mock('../services/chain/zcash/rpc', () => {
  class ZcashRpcError extends Error {
    code: 'unknown' | 'network' | 'timeout' | 'aborted' | 'http' | 'format' | 'refused';
    constructor(code: ZcashRpcError['code'], message: string) {
      super(message);
      this.name = 'ZcashRpcError';
      this.code = code;
    }
  }
  return {
    ZcashRpcError,
    zcashRpc: (...args: unknown[]) => {
      zcashRpcMock(...args);
      return { send: sendMock };
    },
  };
});

vi.mock('../services/chain/zcash/address', () => {
  class ZcashAddressError extends Error {
    code: 'shielded' | 'unified' | 'testnet' | 'checksum' | 'format';
    constructor(code: ZcashAddressError['code'], message: string) {
      super(message);
      this.code = code;
    }
  }
  // Real messages (address.ts MESSAGES map), so this stands in faithfully for
  // Set A's actual per-code wording without importing the real module (which
  // would pull in its own real dependencies unmocked here).
  const SHIELDED_MESSAGE =
    'This is a shielded Zcash address. Satori GO sends to transparent addresses only (t1, t3 or tex1). Ask the recipient for a transparent address.';
  return {
    ZcashAddressError,
    isValidZcashRecipient: (a: string) => a.startsWith('t1') || a.startsWith('t3') || a.startsWith('tex1'),
    decodeZcashAddress: (a: string) => {
      if (a.startsWith('u1')) throw new ZcashAddressError('unified', SHIELDED_MESSAGE);
      if (a.startsWith('zs1') || a.startsWith('zc')) throw new ZcashAddressError('shielded', SHIELDED_MESSAGE);
      if (a.startsWith('tm') || a.startsWith('t2') || a.startsWith('textest')) {
        throw new ZcashAddressError('testnet', 'This is a Zcash testnet address. Satori GO sends on the Zcash main network only.');
      }
      if (a === 'badchecksum') {
        throw new ZcashAddressError('checksum', 'This Zcash address has a typo: its checksum does not match. Check it and paste it again.');
      }
      if (a.startsWith('t1') || a.startsWith('t3') || a.startsWith('tex1')) return { net: 'main', kind: 'p2pkh', hash: new Uint8Array(), script: new Uint8Array() };
      throw new ZcashAddressError('format', 'This is not a valid Zcash address.');
    },
  };
});

const buildZcashTxMock = vi.fn();
vi.mock('../services/chain/zcash/builder', () => {
  class ZcashBuildError extends Error {
    code: 'insufficient' | 'dust' | 'fee-cap' | 'expiry' | 'recipient' | 'coinbase';
    constructor(code: ZcashBuildError['code'], message: string) {
      super(message);
      this.code = code;
    }
  }
  return {
    ZcashBuildError,
    buildZcashTx: (...args: unknown[]) => buildZcashTxMock(...args),
  };
});

const assertZcashFeeSaneMock = vi.fn();
vi.mock('../services/chain/zcash/fees', () => ({
  assertZcashFeeSane: (fee: bigint) => assertZcashFeeSaneMock(fee),
  formatZec: (zat: bigint) => {
    const s = zat.toString().padStart(9, '0');
    const whole = s.slice(0, -8) || '0';
    const frac = s.slice(-8).replace(/0+$/, '');
    return frac ? `${whole}.${frac}` : whole;
  },
  parseZec: (text: string) => {
    const t = text.trim();
    if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') throw new Error('Enter a valid amount.');
    const [w, f = ''] = t.split('.');
    if (f.length > 8) throw new Error('Too many decimal places.');
    return BigInt((w || '0') + f.padEnd(8, '0'));
  },
}));

import { buildZcashSendPlan, broadcastZcashPlan, dropLocalZcashSends, loadLocalZcashSends, ZcashSendError, type ZcashSendPlan } from './zcashSend';
import { ZcashBuildError } from '../services/chain/zcash/builder';
import { ZcashRpcError } from '../services/chain/zcash/rpc';

function fakeSnapshot(overrides: Partial<ZcashSnapshot> = {}): ZcashSnapshot {
  return {
    info: { chainName: 'main', height: 3_500_000, estimatedHeight: 3_500_000, consensusBranchId: 0x37a5165b, upgradeName: '', upgradeHeight: 0, taddrSupport: true },
    confirmed: 100_000_000n,
    pendingIn: 0n,
    pendingOut: 0n,
    spendable: [{ txid: 'u1', index: 0, valueZat: 100_000_000n, script: new Uint8Array(), height: 1, address: 't1primary', coinbase: false }],
    unspendable: [],
    utxosTruncated: false,
    history: [],
    mempool: [],
    pending: [],
    cache: { v: 1, scannedTo: 0, activeAddresses: [], txs: [] },
    ...overrides,
  } as ZcashSnapshot;
}

function fakeSigned(overrides: Partial<ZcashSignedTx> = {}): ZcashSignedTx {
  return {
    hex: 'deadbeef',
    txid: 'thetxid',
    fee: 10_000n,
    amount: 1_000_000n,
    change: 0n,
    expiryHeight: 3_500_041,
    inputs: [],
    sizeBytes: 241,
    ...overrides,
  } as ZcashSignedTx;
}

describe('buildZcashSendPlan', () => {
  beforeEach(() => {
    hoisted.activeWalletId = 'w1';
    hoisted.snapshot = fakeSnapshot();
    hoisted.status = 'ready';
    hoisted.chain = null;
    hoisted.keysError = null;
    buildZcashTxMock.mockReset();
    assertZcashFeeSaneMock.mockReset();
    zeroZcashKeysMock.mockReset();
    setStorageForTests(new MemoryStorageAdapter());
  });

  it('refuses to build from a stale snapshot after a failed refresh (refresh first)', async () => {
    hoisted.status = 'error';
    buildZcashTxMock.mockReturnValue(fakeSigned());
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false })).rejects.toMatchObject({
      code: 'build-failed',
      message: expect.stringContaining('Refresh first'),
    });
    expect(buildZcashTxMock).not.toHaveBeenCalled();
  });

  it('requires a recipient', async () => {
    await expect(buildZcashSendPlan({ to: '  ', amount: '1', sweep: false })).rejects.toMatchObject({ code: 'invalid-address' });
  });

  it('refuses a unified address with the exact §3.3 wording', async () => {
    await expect(buildZcashSendPlan({ to: 'u1something', amount: '1', sweep: false })).rejects.toMatchObject({
      code: 'invalid-address',
      message: expect.stringContaining('shielded Zcash address'),
    });
    expect(buildZcashTxMock).not.toHaveBeenCalled();
  });

  it('refuses a shielded (zs1/zc) address', async () => {
    await expect(buildZcashSendPlan({ to: 'zs1something', amount: '1', sweep: false })).rejects.toMatchObject({ code: 'invalid-address' });
  });

  it('refuses a testnet address with a testnet-specific message', async () => {
    await expect(buildZcashSendPlan({ to: 'tmSomething', amount: '1', sweep: false })).rejects.toMatchObject({
      code: 'invalid-address',
      message: expect.stringContaining('testnet'),
    });
  });

  it('refuses a bad-checksum address', async () => {
    await expect(buildZcashSendPlan({ to: 'badchecksum', amount: '1', sweep: false })).rejects.toMatchObject({ code: 'invalid-address' });
  });

  it('rejects an unparsable amount (non-sweep) before touching the builder', async () => {
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: 'garbage', sweep: false })).rejects.toMatchObject({ code: 'invalid-amount' });
    expect(buildZcashTxMock).not.toHaveBeenCalled();
  });

  it('rejects a zero amount', async () => {
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '0', sweep: false })).rejects.toMatchObject({ code: 'invalid-amount' });
  });

  it('sweep ignores the amount text and still builds', async () => {
    buildZcashTxMock.mockReturnValue(fakeSigned());
    await buildZcashSendPlan({ to: 't1recipient', amount: 'garbage', sweep: true });
    expect(buildZcashTxMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 't1recipient', amountZat: 0n, sweep: true }),
    );
  });

  it('throws no-wallet when no snapshot has loaded yet', async () => {
    hoisted.snapshot = null;
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false })).rejects.toMatchObject({ code: 'no-wallet' });
  });

  it('throws no-wallet when zcashKeysOfActive() throws (locked / not active)', async () => {
    hoisted.keysError = new Error('Wallet is locked.');
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false })).rejects.toMatchObject({
      code: 'no-wallet',
      message: 'Wallet is locked.',
    });
  });

  it('builds against the live snapshot: branch id, tip, utxos, keys, upgradeHeight undefined when 0', async () => {
    buildZcashTxMock.mockReturnValue(fakeSigned());
    const snapshot = hoisted.snapshot as ZcashSnapshot;
    await buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false });
    expect(buildZcashTxMock).toHaveBeenCalledWith({
      utxos: snapshot.spendable,
      keys: hoisted.keys,
      to: 't1recipient',
      amountZat: 100_000_000n,
      sweep: false,
      branchId: 0x37a5165b,
      tip: 3_500_000,
      upgradeHeight: undefined,
    });
  });

  it('passes upgradeHeight through when /info reports a pending one', async () => {
    hoisted.snapshot = fakeSnapshot({
      info: { chainName: 'main', height: 3_500_000, estimatedHeight: 3_500_000, consensusBranchId: 1, upgradeName: 'NU7', upgradeHeight: 3_600_000, taddrSupport: true },
    });
    buildZcashTxMock.mockReturnValue(fakeSigned());
    await buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false });
    expect(buildZcashTxMock).toHaveBeenCalledWith(expect.objectContaining({ upgradeHeight: 3_600_000 }));
  });

  it('wraps a ZcashBuildError fee-cap as fee-unsafe', async () => {
    buildZcashTxMock.mockImplementation(() => {
      throw new ZcashBuildError('fee-cap', 'Fee exceeds the maximum.');
    });
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false })).rejects.toMatchObject({ code: 'fee-unsafe' });
  });

  it('wraps a ZcashBuildError insufficient as build-failed', async () => {
    buildZcashTxMock.mockImplementation(() => {
      throw new ZcashBuildError('insufficient', 'Not enough funds.');
    });
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false })).rejects.toMatchObject({ code: 'build-failed' });
  });

  it('zeros the keys after use even when the builder throws (§9: never held longer than the build)', async () => {
    buildZcashTxMock.mockImplementation(() => {
      throw new ZcashBuildError('insufficient', 'Not enough funds.');
    });
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false })).rejects.toBeTruthy();
    expect(zeroZcashKeysMock).toHaveBeenCalledWith(hoisted.keys);
  });

  it('REFUSES (never clamps) when the built fee fails the second, defense-in-depth cap check', async () => {
    buildZcashTxMock.mockReturnValue(fakeSigned());
    assertZcashFeeSaneMock.mockImplementation(() => {
      throw new Error('Fee is unreasonably high; refusing to send.');
    });
    await expect(buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false })).rejects.toMatchObject({ code: 'fee-unsafe' });
  });

  it('computes feeZec/amountZec/totalZec/expiresInBlocks from the signed tx', async () => {
    buildZcashTxMock.mockReturnValue(fakeSigned({ fee: 10_000n, amount: 1_000_000n, expiryHeight: 3_500_041 }));
    const plan = await buildZcashSendPlan({ to: 't1recipient', amount: '0.01', sweep: false });
    expect(plan.feeZec).toBe('0.0001');
    expect(plan.amountZec).toBe('0.01');
    expect(plan.totalZec).toBe('0.0101');
    expect(plan.expiresInBlocks).toBe(41);
    expect(plan.warnings).toEqual([]);
  });

  it('zeros the keys after a successful build too', async () => {
    buildZcashTxMock.mockReturnValue(fakeSigned());
    await buildZcashSendPlan({ to: 't1recipient', amount: '1', sweep: false });
    expect(zeroZcashKeysMock).toHaveBeenCalledWith(hoisted.keys);
  });
});

describe('broadcastZcashPlan', () => {
  beforeEach(() => {
    hoisted.activeWalletId = 'w1';
    hoisted.chain = null;
    sendMock.mockReset();
    zcashRpcMock.mockClear();
    setStorageForTests(new MemoryStorageAdapter());
  });

  const plan: ZcashSendPlan = {
    signed: fakeSigned({ txid: 'final-txid', expiryHeight: 3_500_041, hex: 'cafebabe' }),
    feeZec: '0',
    amountZec: '0',
    totalZec: '0',
    expiresInBlocks: 41,
    warnings: [],
  };

  it('throws no-wallet with no active wallet id', async () => {
    hoisted.activeWalletId = null;
    await expect(broadcastZcashPlan(plan)).rejects.toMatchObject({ code: 'no-wallet' });
  });

  it('relays through the gateway and returns the LOCALLY COMPUTED txid, recording the local send', async () => {
    sendMock.mockResolvedValue({ ok: true, errorCode: 0, errorMessage: '' });
    const result = await broadcastZcashPlan(plan);
    expect(sendMock).toHaveBeenCalledWith('cafebabe');
    expect(result).toEqual({ txid: 'final-txid' });
    const local = await loadLocalZcashSends('w1');
    expect(local).toEqual([
      { txid: 'final-txid', expiryHeight: 3_500_041, sentAt: expect.any(Number), hex: 'cafebabe', amountZec: '0', feeZec: '0', spent: [] },
    ]);
  });

  it('records the spent outpoints and the typed recipient on the local send (held back from spendable; shown in Activity)', async () => {
    sendMock.mockResolvedValue({ ok: true, errorCode: 0, errorMessage: '' });
    const withInputs: ZcashSendPlan = {
      ...plan,
      signed: fakeSigned({
        txid: 'final-txid',
        hex: 'cafebabe',
        inputs: [
          { txid: 'aa'.repeat(32), index: 1, value: 5n, address: 't1a', height: 1, script: '', coinbase: false },
          { txid: 'bb'.repeat(32), index: 0, value: 5n, address: 't1a', height: 1, script: '', coinbase: false },
        ] as unknown as ZcashSignedTx['inputs'],
      }),
    };
    await broadcastZcashPlan(withInputs, { to: 't1recipient' });
    const [local] = await loadLocalZcashSends('w1');
    expect(local.spent).toEqual([`${'aa'.repeat(32)}:1`, `${'bb'.repeat(32)}:0`]);
    expect(local.to).toBe('t1recipient');
  });

  it('dropLocalZcashSends forgets exactly the given txids', async () => {
    sendMock.mockResolvedValue({ ok: true, errorCode: 0, errorMessage: '' });
    await broadcastZcashPlan({ ...plan, signed: fakeSigned({ txid: 'keep' }) });
    await broadcastZcashPlan({ ...plan, signed: fakeSigned({ txid: 'gone' }) });
    await dropLocalZcashSends('w1', ['GONE']);
    expect((await loadLocalZcashSends('w1')).map((s) => s.txid)).toEqual(['keep']);
  });

  it('a definite application rejection throws broadcast-failed and records NOTHING (§7 final-answer rule)', async () => {
    sendMock.mockResolvedValue({ ok: false, errorCode: -25, errorMessage: 'incorrect consensus branch id' });
    await expect(broadcastZcashPlan(plan)).rejects.toMatchObject({ code: 'broadcast-failed', message: 'incorrect consensus branch id' });
    expect(await loadLocalZcashSends('w1')).toEqual([]);
  });

  it('an ambiguous outcome (ZcashRpcError code "unknown": the 504 gateway deviation) records the local send anyway and throws broadcast-unknown', async () => {
    sendMock.mockRejectedValue(new ZcashRpcError('unknown', 'gateway timeout after the request left'));
    await expect(broadcastZcashPlan(plan)).rejects.toMatchObject({ code: 'broadcast-unknown' });
    const local = await loadLocalZcashSends('w1');
    expect(local).toHaveLength(1);
    expect(local[0].txid).toBe('final-txid');
  });

  it('fails closed: any error other than a pre-flight refusal is unknown, recorded and never re-sent', async () => {
    for (const err of [new ZcashRpcError('network', 'offline'), new ZcashRpcError('timeout', 'slow'), new ZcashRpcError('format', 'odd'), new Error('boom')]) {
      setStorageForTests(new MemoryStorageAdapter());
      sendMock.mockReset();
      sendMock.mockRejectedValue(err);
      await expect(broadcastZcashPlan(plan)).rejects.toMatchObject({ code: 'broadcast-unknown' });
      expect(sendMock).toHaveBeenCalledTimes(1);
      expect((await loadLocalZcashSends('w1')).map((s) => s.txid)).toEqual(['final-txid']);
    }
  });

  it('a pre-flight refusal (refused, or a precheck http answer) is definite: broadcast-failed, nothing recorded', async () => {
    for (const err of [new ZcashRpcError('refused', 'only v5 or v6', 400), new ZcashRpcError('http', 'busy', 429)]) {
      sendMock.mockReset();
      sendMock.mockRejectedValue(err);
      await expect(broadcastZcashPlan(plan)).rejects.toMatchObject({ code: 'broadcast-failed' });
      expect(await loadLocalZcashSends('w1')).toEqual([]);
    }
  });

  it('builds the rpc client from the gateway and the active chain default node set', async () => {
    sendMock.mockResolvedValue({ ok: true, errorCode: 0, errorMessage: '' });
    await broadcastZcashPlan(plan);
    expect(zcashRpcMock).toHaveBeenCalledWith(expect.any(String), expect.any(String), 'main');
  });

  it('ZcashSendError is a real Error subclass', () => {
    const err = new ZcashSendError('no-wallet', 'x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ZcashSendError');
  });
});
