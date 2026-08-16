/**
 * @vitest-environment jsdom
 *
 * Private-key import form: the WIF version-byte notice.
 *
 * This is the ONLY boundary where a human pastes a key they believe belongs to a
 * particular chain, which is why the check lives here and not in the decoders
 * (enabling a chain on a single-key wallet re-imports that wallet's own WIF onto
 * another chain, and that must keep working — see keys.importGuards.test.ts).
 *
 * The store action is replaced with a spy so the test asserts what the FORM does
 * about the key, without building a real scrypt vault.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/chain/liveWallet', () => {
  class BroadcastGatedError extends Error {}
  class LiveWalletService {
    async exists() {
      return false;
    }
    async listWallets() {
      return [];
    }
    activeWalletId() {
      return null;
    }
    isUnlocked() {
      return false;
    }
    getProvider() {
      return {};
    }
    lock() {}
  }
  return { LiveWalletService, BroadcastGatedError };
});

import { LiveOnboarding } from './LiveOnboarding';
import { useLiveStore } from '../../store/liveStore';
import { MemoryStorageAdapter, setStorageForTests } from '../../services/storage';
import {
  BITCOIN_MAINNET,
  EVRMORE_MAINNET,
  LITECOIN_MAINNET,
  WOJAKCOIN_MAINNET,
} from '../../services/chain/chainParams';
import { encodeWif } from '../../services/chain/keys';
import { sha256 } from '@noble/hashes/sha256';
import { concatBytes, bytesToHex } from '@noble/hashes/utils';
import { base58check } from '@scure/base';

const PRIV = Uint8Array.from(
  ('0101010101010101010101010101010101010101010101010101010101010101'.match(/../g) as string[]).map(
    (h) => parseInt(h, 16),
  ),
);

/** A Bitcoin TESTNET WIF (version 0xEF): the concrete "belongs to no chain this
 *  wallet offers" case. It currently parses fine and would mint a real, fundable
 *  mainnet address. */
const TESTNET_WIF = base58check(sha256).encode(
  concatBytes(Uint8Array.of(0xef), PRIV, Uint8Array.of(1)),
);

let importSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  importSpy = vi.fn(async () => {});
  useLiveStore.setState({ importPrivateKeyWallet: importSpy, pendingMnemonic: null, addingWallet: false });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function byId(id: string): HTMLElement {
  return screen.getByTestId(id);
}

/** Render the onboarding screen and walk to the private-key form. */
function openPkForm() {
  render(<LiveOnboarding />);
  fireEvent.click(byId('live-choose-pk'));
  return byId('live-pk-input');
}

/** Fill in the key and a valid password pair, then submit. */
function submitWith(key: string) {
  fireEvent.change(byId('live-pk-input'), { target: { value: key } });
  fireEvent.change(byId('live-password'), { target: { value: 'password123' } });
  fireEvent.change(byId('live-password-confirm'), { target: { value: 'password123' } });
  fireEvent.click(byId('live-pk-submit'));
}

describe('private-key import: WIF version-byte notice', () => {
  it('says NOTHING for a key whose prefix matches the selected chain', () => {
    openPkForm();
    // Evrmore is preselected. An Evrmore WIF must produce no notice at all: byte
    // 128 is also Bitcoin's and Ravencoin's, so a green "verified" message here
    // would be a claim the wallet cannot back up.
    fireEvent.change(byId('live-pk-input'), {
      target: { value: encodeWif(PRIV, EVRMORE_MAINNET, true) },
    });
    expect(screen.queryByTestId('live-pk-chain-warning')).toBeNull();
    expect(screen.queryByTestId('live-pk-error')).toBeNull();
  });

  it('says nothing for a raw hex key, which carries no version byte', () => {
    openPkForm();
    fireEvent.change(byId('live-pk-input'), { target: { value: bytesToHex(PRIV) } });
    expect(screen.queryByTestId('live-pk-chain-warning')).toBeNull();
  });

  it('WARNS about a key from another family, naming that family, and still imports', async () => {
    openPkForm();
    fireEvent.click(byId('live-pk-chain-bitcoin-mainnet'));
    fireEvent.change(byId('live-pk-input'), {
      target: { value: encodeWif(PRIV, LITECOIN_MAINNET, true) },
    });

    const warning = byId('live-pk-chain-warning');
    // Names come from the chain params, so a renamed chain renames the message.
    expect(warning.textContent).toContain(LITECOIN_MAINNET.displayName);
    expect(warning.textContent).toContain(BITCOIN_MAINNET.displayName);
    // And it admits what it cannot do, rather than reading as a chain check.
    expect(warning.textContent).toMatch(/share WIF prefixes/i);

    // A WARNING, not a gate: re-using one key across chains is a supported thing
    // to do, so the user is told and then trusted.
    submitWith(encodeWif(PRIV, LITECOIN_MAINNET, true));
    await waitFor(() => expect(importSpy).toHaveBeenCalledTimes(1));
    expect(importSpy.mock.calls[0][0]).toBe(encodeWif(PRIV, LITECOIN_MAINNET, true));
    expect(importSpy.mock.calls[0][3]).toBe('bitcoin-mainnet');
  });

  it('the warning tracks the chain picker, appearing and clearing as it changes', () => {
    openPkForm();
    // A WojakCoin WIF (byte 201, unique to that chain) while Evrmore is selected.
    fireEvent.change(byId('live-pk-input'), {
      target: { value: encodeWif(PRIV, WOJAKCOIN_MAINNET, true) },
    });
    expect(byId('live-pk-chain-warning').textContent).toContain(WOJAKCOIN_MAINNET.displayName);

    // Select WojakCoin and the mismatch is gone.
    fireEvent.click(byId('live-pk-chain-wojakcoin-mainnet'));
    expect(screen.queryByTestId('live-pk-chain-warning')).toBeNull();
  });

  it('REJECTS a key whose prefix belongs to no chain the wallet offers', async () => {
    openPkForm();
    submitWith(TESTNET_WIF);

    const error = await screen.findByTestId('live-pk-error');
    expect(error.textContent).toMatch(/another network/i);
    expect(error.textContent).toContain('239'); // the version byte, stated plainly
    expect(error.textContent).toContain(EVRMORE_MAINNET.displayName);
    // Nothing was created: this is the case where importing would have produced
    // a real, fundable mainnet address holding none of the key's coins.
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('the rejection is about the KEY, so it beats the password complaints to the screen', async () => {
    openPkForm();
    fireEvent.change(byId('live-pk-input'), { target: { value: TESTNET_WIF } });
    fireEvent.change(byId('live-password'), { target: { value: 'short' } });
    fireEvent.click(byId('live-pk-submit'));

    const error = await screen.findByTestId('live-pk-error');
    expect(error.textContent).toMatch(/another network/i);
    expect(error.textContent).not.toMatch(/password/i);
    expect(importSpy).not.toHaveBeenCalled();
  });

  it('an empty field still reports the empty field, not a chain problem', async () => {
    openPkForm();
    fireEvent.click(byId('live-pk-submit'));
    const error = await screen.findByTestId('live-pk-error');
    expect(error.textContent).toMatch(/Enter a private key/i);
  });
});
