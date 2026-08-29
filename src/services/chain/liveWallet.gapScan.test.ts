// Gap-limit receive-address discovery (KNOWN_LIMITATIONS item 15).
//
// The wallet only ever derived the addresses it created itself, so a SEED
// IMPORTED from another wallet could have funds on indices this one never
// looked at — the usual reason an imported wallet shows a smaller balance than
// the user expects. discoverUsedAddresses() walks the receive chain asking the
// server which addresses have history and raises `addressCount` to cover the
// highest used one.
//
// That count is the whole money path: allKeys() derives exactly `addressCount`
// keys, and balance reads, UTXO gathering and coin selection all iterate those
// keys (see the existing "buildEvrSend spends UTXOs gathered across ALL derived
// addresses" test). So these tests pin the count, and the count is what makes
// the funds both visible and spendable.
//
// The server is mocked at the ElectrumClient level, exactly like liveWallet.test.ts:
// only blockchain.scripthash.get_history is answered, keyed back to the receive
// index it belongs to, so each test scripts the chain one index at a time.

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GAP_LIMIT,
  LiveWalletService,
  MAX_RECEIVE_ADDRESSES,
  MAX_SCAN_INDEX,
} from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests } from '../storage';
import { ELECTRUM_METHODS } from './network';
import { addressToElectrumScripthash, deriveAddress, mnemonicToSeed } from './keys';
import { EVRMORE_MAINNET } from './chainParams';
import type { ElectrumClient } from './electrumTypes';

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

/** Receive index -> address, and its Electrum scripthash back to that index, for
 *  every index the scan can possibly reach. Computed once: the scan asks by
 *  scripthash, so this is how a scripted answer finds its index. */
const addressByIndex: string[] = [];
const indexByScripthash = new Map<string, number>();

beforeAll(async () => {
  const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
  for (let i = 0; i < MAX_RECEIVE_ADDRESSES; i++) {
    const { address } = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, i);
    addressByIndex.push(address);
    indexByScripthash.set(addressToElectrumScripthash(address), i);
  }
});

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

/** What the scripted server says about one receive index.
 *  'used'      — history exists,
 *  'empty'     — provably no history,
 *  'fail'      — transport died (the provider turns this into NetworkOfflineError),
 *  'too-large' — a JSON-RPC ERROR REPLY refusing the address for having too much
 *                history (AddressHistoryRefusedError with tooLarge). */
type Answer = 'used' | 'empty' | 'fail' | 'too-large';

/** An ElectrumClient that ONLY serves get_history, per the script, and records
 *  every index it was asked about (so a test can prove what was NOT asked). */
function scanClient(answer: (index: number) => Answer): ElectrumClient & { asked: number[] } {
  const asked: number[] = [];
  return {
    asked,
    connect: async () => {},
    isConnected: () => true,
    endpoint: () => 'wss://fake',
    close: () => {},
    request: async (method: string, params: unknown[] = []) => {
      if (method !== ELECTRUM_METHODS.getHistory) throw new Error(`unexpected method ${method}`);
      const index = indexByScripthash.get(params[0] as string);
      if (index === undefined) throw new Error('scripthash outside the scanned range');
      asked.push(index);
      switch (answer(index)) {
        case 'used':
          return [{ tx_hash: 'a'.repeat(64), height: 1 }] as never;
        case 'empty':
          return [] as never;
        case 'too-large':
          // The exact shape electrumClient.dispatch() produces for a JSON-RPC
          // error reply; electrumProvider turns it into AddressHistoryRefusedError.
          throw new Error('Electrum error: history too large (code 1)');
        case 'fail':
        default:
          throw new Error('socket closed mid-request');
      }
    },
  };
}

/** An imported, unlocked seed wallet talking to `client`. */
async function importedWallet(client: ElectrumClient): Promise<LiveWalletService> {
  const svc = new LiveWalletService(client);
  await svc.import(VECTOR_MNEMONIC, 'pw');
  return svc;
}

describe('discoverUsedAddresses — bounds', () => {
  it('leaves room for a full gap scan, and ties the scan ceiling to the cap', () => {
    // A cap equal to the gap limit could not hold the RESULT of a gap scan: the
    // highest index a 20-address gap can prove is 19, which already needs 20
    // addresses, leaving nothing for a manually added one.
    expect(GAP_LIMIT).toBe(20);
    expect(MAX_RECEIVE_ADDRESSES).toBe(100);
    expect(MAX_RECEIVE_ADDRESSES).toBeGreaterThan(GAP_LIMIT);
    // A used address above the cap could never be derived, so discovering one
    // would persist a count the wallet clamps away — hiding the very funds the
    // scan exists to find. The two bounds must not drift apart.
    expect(MAX_SCAN_INDEX).toBe(MAX_RECEIVE_ADDRESSES - 1);
  });
});

describe('discoverUsedAddresses — what it finds', () => {
  it('covers a GAP INSIDE the used range: 0 and 5 used, 1-4 empty -> 6 addresses', async () => {
    // The case the whole feature exists for: another wallet used index 5, this
    // one had only ever derived index 0, so 1-4 must be derived too (BIP44
    // requires 0..N-1 to all exist — a scan may never skip an index).
    const client = scanClient((i) => (i === 0 || i === 5 ? 'used' : 'empty'));
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    expect(res.highestUsedIndex).toBe(5);
    expect(res.addressCountBefore).toBe(1);
    expect(res.addressCountAfter).toBe(6);
    expect(res.failedReads).toBe(0);
    expect(res.complete).toBe(true);
    // 0..5, then GAP_LIMIT empties after the last used one.
    expect(res.scanned).toBe(6 + GAP_LIMIT);

    // The count IS the money path: these are the keys allKeys() now derives, so
    // balances, UTXO gathering and coin selection all cover them.
    const list = await svc.listAddresses();
    expect(list.map((a) => a.address)).toEqual(addressByIndex.slice(0, 6));

    // And it is persisted: a fresh service + unlock still has all six.
    const svc2 = new LiveWalletService(scanClient(() => 'empty'));
    expect(await svc2.unlock('pw')).toBe(true);
    expect((await svc2.listAddresses()).length).toBe(6);
  });

  it('leaves a wallet with nothing beyond index 0 exactly as it was', async () => {
    const client = scanClient((i) => (i === 0 ? 'used' : 'empty'));
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    expect(res.highestUsedIndex).toBe(0);
    expect(res.addressCountBefore).toBe(1);
    expect(res.addressCountAfter).toBe(1);
    expect(res.complete).toBe(true);
    expect((await svc.listAddresses()).length).toBe(1);
  });

  it('leaves a wallet with NO history at all at one address', async () => {
    const client = scanClient(() => 'empty');
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    expect(res.highestUsedIndex).toBe(-1);
    expect(res.addressCountAfter).toBe(1); // never below the one address that exists
    expect(res.scanned).toBe(GAP_LIMIT);
    expect((await svc.listAddresses()).length).toBe(1);
  });

  it('counts a "history too large" REFUSAL as used, not as empty', async () => {
    // The server answering "I will not serve this address's history because
    // there is too much of it" is the server stating that history EXISTS.
    // Treating that as empty would hide the most heavily used address of all.
    const client = scanClient((i) => (i === 0 ? 'used' : i === 1 ? 'too-large' : 'empty'));
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    expect(res.highestUsedIndex).toBe(1);
    expect(res.addressCountAfter).toBe(2);
    expect(res.failedReads).toBe(0); // it was answered, just not with a list
  });
});

describe('discoverUsedAddresses — termination', () => {
  it('stops after GAP_LIMIT consecutive empty addresses', async () => {
    const client = scanClient((i) => (i === 0 ? 'used' : 'empty'));
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    // Index 0 plus exactly GAP_LIMIT empties, and not one request more.
    expect(res.scanned).toBe(GAP_LIMIT + 1);
    expect(client.asked).toEqual(Array.from({ length: GAP_LIMIT + 1 }, (_, i) => i));
  });

  it('stops at the hard ceiling when a server claims EVERY address is used', async () => {
    // A hostile or broken server that never lets the gap counter build must not
    // be able to make this loop without end.
    const client = scanClient(() => 'used');
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    expect(res.scanned).toBe(MAX_SCAN_INDEX + 1);
    expect(client.asked.length).toBe(MAX_SCAN_INDEX + 1);
    expect(res.highestUsedIndex).toBe(MAX_SCAN_INDEX);
    expect(res.addressCountAfter).toBe(MAX_RECEIVE_ADDRESSES); // capped, never above
    // The ceiling is not proof there is nothing further: a lower bound only.
    expect(res.complete).toBe(false);
    expect((await svc.listAddresses()).length).toBe(MAX_RECEIVE_ADDRESSES);
  });

  it('gives up after a run of failed reads instead of walking to the ceiling', async () => {
    // Every read fails (offline). The gap can never build, so only the
    // consecutive-failure bound can end this.
    const client = scanClient(() => 'fail');
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    expect(res.scanned).toBeLessThan(GAP_LIMIT);
    expect(res.failedReads).toBe(res.scanned);
    expect(res.highestUsedIndex).toBe(-1);
    expect(res.addressCountAfter).toBe(1);
    expect(res.complete).toBe(false);
  });
});

describe('discoverUsedAddresses — safety', () => {
  it('does NOT treat a failed read as empty (a failure must not end the scan early)', async () => {
    // Index 20 fails. If a failure counted as empty it would complete a run of
    // GAP_LIMIT empties (indices 1..20) and the scan would stop right there,
    // never seeing the funds at index 21.
    const client = scanClient((i) => (i === 0 || i === 21 ? 'used' : i === 20 ? 'fail' : 'empty'));
    const svc = await importedWallet(client);

    const res = await svc.discoverUsedAddresses();

    expect(client.asked).toContain(21);
    expect(res.highestUsedIndex).toBe(21);
    expect(res.addressCountAfter).toBe(22);
    expect(res.failedReads).toBe(1);
    // One unread address means the answer is a lower bound, not the truth.
    expect(res.complete).toBe(false);
  });

  it('NEVER lowers the count, so a manually added address is never dropped', async () => {
    const client = scanClient(() => 'empty');
    const svc = await importedWallet(client);
    for (let i = 0; i < 4; i++) await svc.addReceiveAddress();
    expect((await svc.listAddresses()).length).toBe(5);

    const res = await svc.discoverUsedAddresses();

    expect(res.addressCountBefore).toBe(5);
    expect(res.addressCountAfter).toBe(5);
    expect((await svc.listAddresses()).length).toBe(5);
  });

  it('leaves a pk wallet untouched and asks the server nothing', async () => {
    // A single imported private key IS one address: there is no derivation tree
    // to walk, so the scan must cost nothing and change nothing.
    const seed = await mnemonicToSeed(VECTOR_MNEMONIC);
    const wif = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).wif;
    const client = scanClient(() => 'used');
    const svc = new LiveWalletService(client);
    await svc.importPrivateKey(wif, 'pw');

    const res = await svc.discoverUsedAddresses();

    expect(res.scanned).toBe(0);
    expect(res.addressCountBefore).toBe(1);
    expect(res.addressCountAfter).toBe(1);
    expect(res.complete).toBe(true);
    expect(client.asked).toEqual([]);
    expect((await svc.listAddresses()).length).toBe(1);
  });

  it('fails cleanly when the wallet is LOCKED, before touching the network', async () => {
    const client = scanClient(() => 'used');
    await importedWallet(client);

    const locked = new LiveWalletService(scanClient(() => 'used'));
    expect(locked.isUnlocked()).toBe(false);
    await expect(locked.discoverUsedAddresses()).rejects.toThrow('Live wallet is locked');
    expect(client.asked).toEqual([]);
  });

  it('reports progress for every index it examines', async () => {
    const client = scanClient((i) => (i === 0 ? 'used' : 'empty'));
    const svc = await importedWallet(client);
    const seen: { scanned: number; highestUsedIndex: number }[] = [];

    const res = await svc.discoverUsedAddresses({ onProgress: (p) => seen.push({ ...p }) });

    expect(seen.length).toBe(res.scanned);
    expect(seen[0]).toEqual({ scanned: 1, highestUsedIndex: 0 });
    expect(seen[seen.length - 1].scanned).toBe(res.scanned);
  });
});
