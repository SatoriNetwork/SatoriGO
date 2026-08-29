// A BIP39 passphrase set at CREATE time (KNOWN_LIMITATIONS item 16).
//
// The import side of this is already pinned in liveWallet.test.ts's "BIP39
// passphrase" block. What is new here is that create() can attach one too, and
// the thing that has to be proven about it is not the feature: it is that the
// wallets which do NOT use it are untouched. A create without a passphrase must
// write the bytes an older build wrote and derive the address it always did,
// because every wallet in the field was made that way and a change there is
// unrecoverable funds, not a bug report.
//
// The service is driven straight (no network): create, unlock and reveal only
// touch storage, so the client below exists purely to satisfy the constructor
// and throws if anything ever reaches for it.

import { beforeEach, describe, expect, it } from 'vitest';
import { LiveWalletService } from './liveWallet';
import { MemoryStorageAdapter, setStorageForTests, getStorage } from '../storage';
import { unlockVaultString, type VaultRecord } from './vault';
import { deriveAddress, mnemonicToSeed } from './keys';
import { BITCOIN_MAINNET, EVRMORE_MAINNET } from './chainParams';
import type { ElectrumClient } from './electrumTypes';

const PASSPHRASE = 'correct horse battery staple';

/** No test here talks to a server; a request means the test is wrong. */
function offlineClient(): ElectrumClient {
  return {
    connect: async () => {},
    isConnected: () => false,
    endpoint: () => 'wss://fake',
    close: () => {},
    request: async () => {
      throw new Error('no network expected in these tests');
    },
  };
}

type StoredEntry = Record<string, unknown> & { vault: VaultRecord };

/** The persisted entry for the ACTIVE wallet, straight out of storage. */
async function storedActiveEntry(): Promise<StoredEntry> {
  const store = (await getStorage().get('liveWallets')) as {
    wallets: (StoredEntry & { id: string })[];
    activeId: string;
  };
  const entry = store.wallets.find((w) => w.id === store.activeId);
  if (!entry) throw new Error('no active wallet in storage');
  return entry;
}

/** What the active wallet's vault actually holds, decrypted. */
async function storedPayload(password: string): Promise<string> {
  return unlockVaultString((await storedActiveEntry()).vault, password);
}

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
});

describe('create with a BIP39 passphrase', () => {
  it('creating WITHOUT one stores the bare mnemonic and derives the address it always did', async () => {
    // The backward-compatibility guarantee, on the create path. Both halves
    // matter: the same bytes on disk (so an older build can still open it) AND
    // the same address (so the coins are where they have always been).
    const svc = new LiveWalletService(offlineClient());
    const { mnemonic } = await svc.create('pw');

    const payload = await storedPayload('pw');
    expect(payload).toBe(mnemonic); // the mnemonic exactly, not an envelope
    expect(payload.startsWith('{')).toBe(false);

    // And no new field crept into the persisted entry alongside it.
    expect(Object.keys(await storedActiveEntry()).sort()).toEqual(
      ['address', 'createdAt', 'id', 'kind', 'name', 'network', 'passwordless', 'vault'].sort(),
    );

    const seed = await mnemonicToSeed(mnemonic);
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address);
  });

  it('creating WITHOUT one is identical whether the option is omitted or empty', async () => {
    // The form passes '' when its opt-in is off, so the two spellings must not
    // be allowed to drift into two different storage formats.
    const svc = new LiveWalletService(offlineClient());
    const { mnemonic } = await svc.create('pw', { passphrase: '' });
    expect(await storedPayload('pw')).toBe(mnemonic);
  });

  it('a created passphrase produces a DIFFERENT wallet, and unlock reproduces it', async () => {
    const svc = new LiveWalletService(offlineClient());
    const { mnemonic } = await svc.create('pw', { name: 'Passphrase wallet', passphrase: PASSPHRASE });

    const withPass = await mnemonicToSeed(mnemonic, PASSPHRASE);
    const without = await mnemonicToSeed(mnemonic);
    const expected = deriveAddress(withPass, EVRMORE_MAINNET, 0, 0, 0).address;
    expect(svc.getAddress(0)).toBe(expected);
    // The whole danger of this feature in one assertion: the words handed to the
    // user on the backup screen are, alone, a different wallet.
    expect(expected).not.toBe(deriveAddress(without, EVRMORE_MAINNET, 0, 0, 0).address);

    // Survives lock/unlock, otherwise the wallet silently becomes the empty
    // passphrase-less one on the user's next session.
    svc.lock();
    expect(await svc.unlock('pw')).toBe(true);
    expect(svc.getAddress(0)).toBe(expected);
  });

  it('a created passphrase is stored in the same envelope an imported one is', async () => {
    const svc = new LiveWalletService(offlineClient());
    const { mnemonic } = await svc.create('pw', { passphrase: PASSPHRASE });
    expect(JSON.parse(await storedPayload('pw'))).toEqual({ v: 1, mnemonic, passphrase: PASSPHRASE });
  });

  it('round-trips through reveal, and a re-import with it reproduces the same wallet', async () => {
    // The created passphrase goes through the SAME revealSeedSecret() the
    // imported one does, which is what enableChain re-imports with. Dropping it
    // there would derive a plausible-looking wallet on the new chain, at an
    // address the user has no funds on.
    const svc = new LiveWalletService(offlineClient());
    const { mnemonic } = await svc.create('pw', { passphrase: PASSPHRASE });

    expect(await svc.revealSeedSecret('pw')).toEqual({ mnemonic, passphrase: PASSPHRASE });
    expect(await svc.revealSeedSecret('wrong-pw')).toBeNull();
    // Settings shows this to the user, so it must never be handed the envelope.
    expect(await svc.revealMnemonic('pw')).toBe(mnemonic);

    const revealed = (await svc.revealSeedSecret('pw'))!;
    await svc.import(revealed.mnemonic, 'pw', 'bitcoin-mainnet', undefined, revealed.passphrase);
    const seed = await mnemonicToSeed(mnemonic, PASSPHRASE);
    expect(svc.getAddress(0)).toBe(deriveAddress(seed, BITCOIN_MAINNET, 0, 0, 0).address);
    const plain = await mnemonicToSeed(mnemonic);
    expect(svc.getAddress(0)).not.toBe(deriveAddress(plain, BITCOIN_MAINNET, 0, 0, 0).address);
  });

  it('a PASSWORDLESS wallet keeps its passphrase across unlock too', async () => {
    // The vault is keyed by the empty password here, so anyone with the browser
    // profile can read the passphrase; that is the limitation the form states
    // rather than hides. It must still SURVIVE, or the wallet reopens as a
    // different, empty one.
    const svc = new LiveWalletService(offlineClient());
    const { mnemonic } = await svc.create('', { passphrase: PASSPHRASE });
    const seed = await mnemonicToSeed(mnemonic, PASSPHRASE);
    const expected = deriveAddress(seed, EVRMORE_MAINNET, 0, 0, 0).address;
    expect(svc.getAddress(0)).toBe(expected);

    svc.lock();
    expect(await svc.unlock('')).toBe(true);
    expect(svc.getAddress(0)).toBe(expected);
  });
});
