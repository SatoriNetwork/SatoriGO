import { describe, expect, it } from 'vitest';
import { TaoRpcError, type TaoRpc, type TaoRuntimeDigest } from './rpc';
import {
  TaoRuntimeChangedError,
  checkRuntime,
  parseBlockNumber,
  profileForSigning,
  readTaoAccount,
  spendableOf,
} from './reader';
import { encodeAccountInfo, systemAccountKey, type AccountInfo } from './scale';
import { ss58Encode, Ss58Error } from './ss58';
import { TAO_EXISTENTIAL_DEPOSIT, TAO_PROFILE } from './tao';

const PUB = new Uint8Array(32).map((_, i) => i + 1);
const ADDRESS = ss58Encode(PUB, 42);
const HEAD = `0x${'ab'.repeat(32)}`;

type Handler = (params: unknown[]) => unknown;

function fakeRpc(handlers: Record<string, Handler>, runtime?: () => Promise<TaoRuntimeDigest>) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  let runtimeCalls = 0;
  const rpc: TaoRpc = {
    nodeSet: 'main',
    async call<T>(method: string, params: unknown[]): Promise<T> {
      calls.push({ method, params });
      const h = handlers[method];
      if (!h) throw new Error(`unexpected call ${method}`);
      return (await h(params)) as T;
    },
    async runtime() {
      runtimeCalls++;
      if (!runtime) throw new Error('unexpected runtime()');
      return runtime();
    },
  };
  return { rpc, calls, runtimeCalls: () => runtimeCalls };
}

function info(over: Partial<AccountInfo> = {}): AccountInfo {
  return { nonce: 7, consumers: 0, providers: 1, sufficients: 0, free: 35_639n, reserved: 0n, frozen: 0n, flags: 0n, ...over };
}

const headHandlers = (storage: Handler): Record<string, Handler> => ({
  chain_getFinalizedHead: () => HEAD,
  chain_getHeader: () => ({ number: '0x8be5a4', parentHash: `0x${'00'.repeat(32)}` }),
  state_getStorage: storage,
});

describe('substrate/reader readTaoAccount', () => {
  it('reads System.Account at the finalized head (80-byte key) and decodes u64 balances', async () => {
    const { rpc, calls } = fakeRpc(headHandlers(() => encodeAccountInfo(info({ free: 107_487_775_289n, nonce: 41393 }))));
    const s = await readTaoAccount(rpc, ADDRESS, TAO_EXISTENTIAL_DEPOSIT);
    expect(s.exists).toBe(true);
    expect(s.info?.free).toBe(107_487_775_289n);
    expect(s.info?.nonce).toBe(41393);
    expect(s.spendable).toBe(107_487_775_289n - 500n);
    expect(s.finalizedHash).toBe(HEAD);
    expect(s.finalizedNumber).toBe(0x8be5a4);
    const storage = calls.find((c) => c.method === 'state_getStorage')!;
    expect(storage.params[0]).toBe(systemAccountKey(PUB));
    expect(((storage.params[0] as string).length - 2) / 2).toBe(80);
    expect(storage.params[1]).toBe(HEAD);
    expect(calls.map((c) => c.method)).toEqual(['chain_getFinalizedHead', 'chain_getHeader', 'state_getStorage']);
  });

  it('an absent key is an account that does not exist: 0 TAO, not an error', async () => {
    const { rpc } = fakeRpc(headHandlers(() => null));
    const s = await readTaoAccount(rpc, ADDRESS, TAO_EXISTENTIAL_DEPOSIT);
    expect(s).toMatchObject({ exists: false, info: null, spendable: 0n });
  });

  it('a 72-byte entry (u128 balances) is refused, never decoded as a number', async () => {
    const { rpc } = fakeRpc(headHandlers(() => `0x${'00'.repeat(72)}`));
    await expect(readTaoAccount(rpc, ADDRESS, TAO_EXISTENTIAL_DEPOSIT)).rejects.toBeInstanceOf(TaoRpcError);
  });

  it('a Polkadot address (prefix 0) is refused before any request', async () => {
    const { rpc, calls } = fakeRpc(headHandlers(() => null));
    const dot = ss58Encode(PUB, 0);
    await expect(readTaoAccount(rpc, dot, TAO_EXISTENTIAL_DEPOSIT)).rejects.toBeInstanceOf(Ss58Error);
    expect(calls).toHaveLength(0);
  });

  it('spendable = free - max(frozen, ED), clamped at 0', () => {
    expect(spendableOf(null, 500n)).toBe(0n);
    expect(spendableOf(info({ free: 10_000n, frozen: 0n }), 500n)).toBe(9_500n);
    expect(spendableOf(info({ free: 10_000n, frozen: 4_000n }), 500n)).toBe(6_000n);
    expect(spendableOf(info({ free: 400n }), 500n)).toBe(0n);
    expect(spendableOf(info({ free: 500n }), 500n)).toBe(0n);
  });

  it('parseBlockNumber takes the header hex and refuses junk', () => {
    expect(parseBlockNumber('0x8be5a4')).toBe(9168292);
    expect(parseBlockNumber(12)).toBe(12);
    expect(() => parseBlockNumber('12')).toThrow(TaoRpcError);
    expect(() => parseBlockNumber('0x')).toThrow(TaoRpcError);
  });
});

function digest(over: Partial<TaoRuntimeDigest> = {}): TaoRuntimeDigest {
  return { ...TAO_PROFILE, node: 'https://entrypoint-finney.opentensor.ai', finalizedHeight: 1, ...over };
}

const version = (specVersion: number, transactionVersion = 1, specName = 'node-subtensor') => ({
  state_getRuntimeVersion: () => ({ specName, specVersion, transactionVersion, implVersion: 1 }),
});

describe('substrate/reader checkRuntime (§4.4)', () => {
  it("equal versions: 'same', one call, no digest", async () => {
    const { rpc, calls, runtimeCalls } = fakeRpc(version(470));
    const r = await checkRuntime(rpc, TAO_PROFILE);
    expect(r).toEqual({ verdict: 'same', live: { specVersion: 470, transactionVersion: 1 } });
    expect(calls).toHaveLength(1);
    expect(runtimeCalls()).toBe(0);
    expect(profileForSigning(TAO_PROFILE, r)).toBe(TAO_PROFILE);
  });

  it("a spec bump whose digest keeps the layout: 'version-only', signed with the LIVE versions", async () => {
    const { rpc, runtimeCalls } = fakeRpc(version(471, 2), async () => digest({ specVersion: 471, transactionVersion: 2 }));
    const r = await checkRuntime(rpc, TAO_PROFILE);
    expect(r.verdict).toBe('version-only');
    expect(runtimeCalls()).toBe(1);
    const p = profileForSigning(TAO_PROFILE, r);
    expect(p.specVersion).toBe(471);
    expect(p.transactionVersion).toBe(2);
    expect(p.balances).toEqual(TAO_PROFILE.balances);
  });

  it("a reordered extension list, a moved pallet: 'layout-changed', and signing throws the banner", async () => {
    const swapped = [...TAO_PROFILE.signedExtensions];
    [swapped[0], swapped[1]] = [swapped[1], swapped[0]];
    for (const d of [
      digest({ specVersion: 471, signedExtensions: swapped }),
      digest({ specVersion: 471, balances: { ...TAO_PROFILE.balances, pallet: 6 } }),
    ]) {
      const { rpc } = fakeRpc(version(471), async () => d);
      const r = await checkRuntime(rpc, TAO_PROFILE);
      expect(r.verdict).toBe('layout-changed');
      expect(() => profileForSigning(TAO_PROFILE, r)).toThrow(TaoRuntimeChangedError);
      expect(() => profileForSigning(TAO_PROFILE, r)).toThrow('Bittensor updated its network; update Satori GO to send.');
    }
  });

  it("a digest that still describes the old runtime (gateway cache) is 'layout-changed'", async () => {
    const { rpc } = fakeRpc(version(471), async () => digest({ specVersion: 470 }));
    expect((await checkRuntime(rpc, TAO_PROFILE)).verdict).toBe('layout-changed');
  });

  it("no digest (gateway down, malformed) is 'layout-changed', never 'sign anyway'", async () => {
    const { rpc } = fakeRpc(version(471), async () => {
      throw new TaoRpcError('http', 'runtime', 'HTTP 502', { status: 502 });
    });
    expect((await checkRuntime(rpc, TAO_PROFILE)).verdict).toBe('layout-changed');
  });

  it("another spec name is 'layout-changed' without asking for a digest", async () => {
    const { rpc, runtimeCalls } = fakeRpc(version(470, 1, 'polkadot'), async () => digest());
    expect((await checkRuntime(rpc, TAO_PROFILE)).verdict).toBe('layout-changed');
    expect(runtimeCalls()).toBe(0);
  });

  it('a malformed runtime version is a format error', async () => {
    const { rpc } = fakeRpc({ state_getRuntimeVersion: () => ({ specName: 'node-subtensor', specVersion: '470' }) });
    await expect(checkRuntime(rpc, TAO_PROFILE)).rejects.toBeInstanceOf(TaoRpcError);
  });
});
