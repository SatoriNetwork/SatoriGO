// @vitest-environment jsdom
// Needs `document` for React Testing Library render, so this file opts into
// jsdom on its own (the project's default vitest environment is 'node').
//
// The store + chainParams modules are fully mocked so this exercises
// ChainSwitcher in isolation, independent of the real store's own (separately
// landing) implementation of chainsWithWallets/walletOnChain/switchChain/
// enableChain/chainsShareDerivation/describeChain. ChainPicker (and the plain
// evmChains helpers it pulls in: isEvmChainTarget/evmChainTarget) are left
// REAL, same as before — they are pure/store-free already.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';

interface MockWallet {
  id: string;
  name: string;
  network: string;
  createdAt: number;
  active: boolean;
  kind: 'seed' | 'pk';
  address: string;
  passwordless: boolean;
  /** Absent = 'utxo', mirroring the real WalletSummary/walletFamily contract. */
  family?: 'utxo' | 'evm' | 'monero' | 'zcash' | 'substrate';
  evmChainKey?: string;
  /** Monero only: 'words' = imported from 25 words (outside every seed group). */
  moneroKeySource?: 'phrase' | 'words';
  /** Vault v2: wrapped by the app master key (the app password opens it). */
  appProtected?: boolean;
}

/** The one Monero row's chain record, the fields switcherChainOptionsFor (REAL)
 *  and this file's describeChain mock read. */
interface MockMoneroChainInfo {
  key: string;
  displayName: string;
  nativeTicker: string;
  nativeDecimals: number;
  homepage: string;
}

const XMR_CHAIN: MockMoneroChainInfo = {
  key: 'monero',
  displayName: 'Monero',
  nativeTicker: 'XMR',
  nativeDecimals: 12,
  homepage: 'https://getmonero.org',
};

/** Mirrors the fields of the real EvmChainInfo that chainOptionsFor (REAL,
 *  imported from the real ChainPicker) and this file's own describeChain mock
 *  both read. */
interface MockEvmChainInfo {
  key: string;
  chainId: number;
  displayName: string;
  nativeTicker: string;
  nativeDecimals: number;
  /** Required on the real EvmChainInfo, so required here: the chain list shows
   *  it under the name for EVM rows too. */
  homepage: string;
  young?: boolean;
  recentlyAdded?: boolean;
}

interface MockState {
  wallets: MockWallet[];
  /** What activeChainTarget() would resolve to: a UTXO LiveNetworkId, or an
   *  `evm:<key>` target when the active wallet is EVM. */
  activeChain: string;
  /** Chains hidden in expert Settings. Empty in every test but the one that
   *  covers hiding, which is the shipped default. */
  hiddenChains: string[];
  /** Empty by default: a build without the EVM engine. */
  evm: { chains: MockEvmChainInfo[] };
  /** Absent by default: a build without --monero (no Monero row). */
  monero?: { chain: MockMoneroChainInfo | null };
  switchChain: (id: string) => Promise<void>;
  enableChain: (id: string, password: string) => Promise<{ ok: boolean; error?: string; needsPassword?: boolean }>;
  /** Absent in most tests: reads as "ask for the password", as before. */
  canEnableChainWithoutPassword?: boolean;
  refreshEnableChainWithoutPassword?: () => Promise<boolean>;
}

// vi.mock factories are hoisted above imports, so the shared mutable state
// they close over must be created via vi.hoisted (a plain module-scope `let`
// declared below would still be in its temporal dead zone when the factory
// itself runs at first import).
const { getState, setState } = vi.hoisted(() => {
  let state: MockState;
  return {
    getState: () => state,
    setState: (s: MockState) => {
      state = s;
    },
  };
});

// Mirrors the real ChainNetwork fields this component reads. `homepage` is a
// REQUIRED field on the real type, so the mock must supply it or the component
// renders against undefined (which is exactly how this mock first broke).
// vi.hoisted because BOTH mock factories below (liveStore's describeChain, and
// chainParams' named network constants) read this at first module evaluation,
// i.e. before a plain module-scope const would be initialized.
const CHAIN_INFO = vi.hoisted(
  () =>
    ({
      mainnet: { ticker: 'EVR', displayName: 'Evrmore', homepage: 'https://evrmore.com' },
      'ravencoin-mainnet': { ticker: 'RVN', displayName: 'Ravencoin', homepage: 'https://ravencoin.org' },
      // young: true mirrors the real params for the two thin networks.
      'bitcoingold-mainnet': { ticker: 'BTGS', displayName: 'BitcoinGold', homepage: 'https://bitcoingold.site', young: true },
      'litecoin-mainnet': { ticker: 'LTC', displayName: 'Litecoin', homepage: 'https://litecoin.org' },
      'wojakcoin-mainnet': { ticker: 'WJK', displayName: 'WojakCoin', homepage: 'https://wojakcoin.cash', young: true },
      'bitcoin-mainnet': { ticker: 'BTC', displayName: 'Bitcoin', homepage: 'https://bitcoin.org' },
      'dogecoin-mainnet': { ticker: 'DOGE', displayName: 'Dogecoin', homepage: 'https://dogecoin.com' },
      // recentlyAdded, NOT young: new in this wallet, mature out there. The two
      // flags mean different things and the chip must follow the first while
      // the caution notice follows the second.
      'neoxa-mainnet': {
        ticker: 'NEOX',
        displayName: 'Neoxa',
        homepage: 'https://neoxa.net',
        recentlyAdded: true,
      },
      'bitcoinblake2b-mainnet': {
        ticker: 'XBT',
        displayName: 'Bitcoin BLAKE2b',
        homepage: 'https://bitcoin-blake2b.org',
        recentlyAdded: true,
        young: true,
      },
    }) as Record<
      string,
      {
        ticker: string;
        displayName: string;
        homepage: string;
        young?: boolean;
        recentlyAdded?: boolean;
      }
    >,
);

vi.mock('../../store/liveStore', () => ({
  useLiveStore: (selector: (s: MockState) => unknown) => selector(getState()),
  activeChainTarget: () => getState().activeChain,
  // Family-aware, exactly like the real helper's signature: a UTXO id resolves
  // from the (mocked) chain params, an `evm:<key>` id resolves from the
  // `evmChains` argument the caller passes in (ChainSwitcher passes s.evm.chains).
  describeChain: (id: string, evmChains: MockEvmChainInfo[], moneroChain?: MockMoneroChainInfo | null) => {
    // Zcash and Bittensor rows exist in every build (no flag), marked New;
    // the real helper answers them from their plain-data rows.
    if (id === 'zec:mainnet') {
      return { id, family: 'zcash' as const, displayName: 'Zcash', ticker: 'ZEC', decimals: 8, homepage: 'https://z.cash', young: false, isNew: true };
    }
    if (id === 'tao:mainnet') {
      return { id, family: 'substrate' as const, displayName: 'Bittensor', ticker: 'TAO', decimals: 9, homepage: 'https://bittensor.com', young: false, isNew: true };
    }
    if (id === 'xmr:mainnet') {
      return moneroChain
        ? {
            id,
            family: 'monero' as const,
            displayName: moneroChain.displayName,
            ticker: moneroChain.nativeTicker,
            decimals: moneroChain.nativeDecimals,
            homepage: moneroChain.homepage,
            young: false,
            isNew: true,
          }
        : null;
    }
    if (id.startsWith('evm:')) {
      const key = id.slice('evm:'.length);
      const c = evmChains.find((e) => e.key === key);
      // homepage / young / isNew are REQUIRED of the real helper, for both
      // families. A mock that omitted them rendered no domain and no chip while
      // every assertion still passed, which is how the chain list lost its
      // coverage of both without a single test going red.
      return c
        ? {
            id,
            family: 'evm' as const,
            displayName: c.displayName,
            ticker: c.nativeTicker,
            decimals: c.nativeDecimals,
            homepage: c.homepage,
            young: c.young === true,
            isNew: c.young === true || c.recentlyAdded === true,
          }
        : null;
    }
    const net = CHAIN_INFO[id];
    return net
      ? {
          id,
          family: 'utxo' as const,
          displayName: net.displayName,
          ticker: net.ticker,
          decimals: 8,
          homepage: net.homepage,
          young: net.young === true,
          isNew: net.young === true || net.recentlyAdded === true,
        }
      : null;
  },
  // One EVM account enables EVERY EVM chain key passed in; a UTXO wallet
  // enables only its own `network`.
  chainsWithWallets: (wallets: MockWallet[], evmChainKeys: string[] = []) => {
    const out = new Set<string>();
    for (const w of wallets) {
      if (w.family === 'evm') {
        for (const key of evmChainKeys) out.add(`evm:${key}`);
      } else {
        out.add(w.network);
      }
    }
    return out;
  },
  // Mirrors the real rule's SHAPE (the real one is pinned in the store's own
  // tests): the active wallet's sibling on that chain (same tag-stripped
  // name), or null for a seed wallet with none there; a wallet outside every
  // seed group (an imported key, a 25-word Monero import) takes the first.
  walletOnChain: (wallets: MockWallet[], chainId: string) => {
    const onChain = (w: MockWallet) =>
      chainId.startsWith('evm:')
        ? w.family === 'evm'
        : chainId === 'xmr:mainnet'
          ? w.family === 'monero'
          : chainId === 'zec:mainnet'
            ? w.family === 'zcash'
            : chainId === 'tao:mainnet'
              ? w.family === 'substrate'
              : w.network === chainId;
    const candidates = wallets.filter(onChain);
    if (candidates.length === 0) return null;
    const active = wallets.find((w) => w.active);
    if (!active) return candidates[0];
    if (chainId.startsWith('evm:') && active.family === 'evm') return active;
    const base = (w: MockWallet) => w.name.replace(/ \([^)]*\)$/, '').toLowerCase();
    const sibling = candidates.find((c) => c.id === active.id) ?? candidates.find((c) => base(c) === base(active));
    if (sibling) return sibling;
    return active.kind === 'seed' && active.moneroKeySource !== 'words' ? null : candidates[0];
  },
}));

// Evrmore + Ravencoin share coinType 175 and standard BIP32 bytes (see
// chainParams.ts); Bitcoin Gold and Litecoin each use their own coin type, so
// neither shares derivation with anything else here. The mock accepts either
// a bare chain-id string or a resolved network object (whichever shape the
// real chainsShareDerivation ends up taking), keyed off `.id`.
const SHARED_DERIVATION_GROUP = new Set(['mainnet', 'ravencoin-mainnet']);

vi.mock('../../services/chain/chainParams', () => ({
  // `chainId` is the CANONICAL id and is what the hidden-chain filter compares
  // against. Evrmore's stored id is the legacy bare 'mainnet', so the two differ and
  // the mock must carry both, exactly like the real params do.
  networkFor: (id: string) => ({
    id,
    chainId: id === 'mainnet' ? 'evrmore-mainnet' : id,
    ...CHAIN_INFO[id],
  }),
  // Reads the `young` flag off the mocked chain record, so a test can mark a
  // chain young by adding it to CHAIN_INFO rather than by stubbing this.
  isYoungChain: (net: { young?: boolean }) => net?.young === true,
  chainsShareDerivation: (a: unknown, b: unknown) => {
    const idA = typeof a === 'string' ? a : (a as { id: string }).id;
    const idB = typeof b === 'string' ? b : (b as { id: string }).id;
    return idA !== idB && SHARED_DERIVATION_GROUP.has(idA) && SHARED_DERIVATION_GROUP.has(idB);
  },
  // ChainSwitcher imports CHAIN_OPTIONS (via chainOptionsFor) from ChainPicker,
  // which builds its rows from these named network constants AT MODULE SCOPE —
  // the mock must export them or the whole suite fails at collection time.
  EVRMORE_MAINNET: { id: 'mainnet', ...CHAIN_INFO.mainnet },
  RAVENCOIN_MAINNET: { id: 'ravencoin-mainnet', ...CHAIN_INFO['ravencoin-mainnet'] },
  BITCOINGOLD_MAINNET: { id: 'bitcoingold-mainnet', ...CHAIN_INFO['bitcoingold-mainnet'] },
  LITECOIN_MAINNET: { id: 'litecoin-mainnet', ...CHAIN_INFO['litecoin-mainnet'] },
  WOJAKCOIN_MAINNET: { id: 'wojakcoin-mainnet', ...CHAIN_INFO['wojakcoin-mainnet'] },
  BITCOIN_MAINNET: { id: 'bitcoin-mainnet', ...CHAIN_INFO['bitcoin-mainnet'] },
  DOGECOIN_MAINNET: { id: 'dogecoin-mainnet', ...CHAIN_INFO['dogecoin-mainnet'] },
  NEOXA_MAINNET: { id: 'neoxa-mainnet', ...CHAIN_INFO['neoxa-mainnet'] },
  BITCOIN_BLAKE2B_MAINNET: { id: 'bitcoinblake2b-mainnet', ...CHAIN_INFO['bitcoinblake2b-mainnet'] },
}));

import { ChainSwitcher } from './ChainSwitcher';
import { NavProvider } from './LiveNav';
import { switcherChainOptionsFor } from './ChainPicker';
import { useSettingsStore } from '../../store/settingsStore';
import { DEFAULT_SETTINGS, loadSettings } from '../../services/settings';
import { MemoryStorageAdapter, getStorage, setStorageForTests } from '../../services/storage';

/** ChainSwitcher reads the nav (a chain switch lands on the Wallet tab), so
 *  every render gets a NavProvider; `openedTab` records what it asked for. */
const navCalls: string[] = [];
function renderSwitcher() {
  return render(
    <NavProvider
      value={{ tab: 'activity', section: 'home', openTab: (t) => navCalls.push(t), openSettings: () => {} }}
    >
      <ChainSwitcher />
    </NavProvider>,
  );
}


afterEach(cleanup);
// Favourites live in the REAL settings store (a module singleton): every test
// starts with none, on a fresh in-memory storage.
beforeEach(() => {
  setStorageForTests(new MemoryStorageAdapter());
  useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, favouriteChains: [] }, loaded: true });
});

function wallet(overrides: Partial<MockWallet> = {}): MockWallet {
  return {
    id: 'w1',
    name: 'My Wallet',
    network: 'mainnet',
    createdAt: 0,
    active: true,
    kind: 'seed',
    address: 'EAddr',
    passwordless: false,
    ...overrides,
  };
}

/** An EVM wallet summary: `network` is the 'evm' sentinel on the real type,
 *  never a real chain id, so nothing here should ever read it. */
function evmWallet(overrides: Partial<MockWallet> = {}): MockWallet {
  return {
    id: 'w-evm',
    name: 'My EVM',
    network: 'evm',
    createdAt: 0,
    active: true,
    kind: 'seed',
    address: '0xabc',
    passwordless: false,
    family: 'evm',
    evmChainKey: 'base',
    ...overrides,
  };
}

const EVM_CHAINS: MockEvmChainInfo[] = [
  {
    key: 'base',
    chainId: 8453,
    displayName: 'Base',
    nativeTicker: 'ETH',
    nativeDecimals: 18,
    homepage: 'https://base.org',
  },
  {
    key: 'bsc',
    chainId: 56,
    displayName: 'BNB Smart Chain',
    nativeTicker: 'BNB',
    nativeDecimals: 18,
    homepage: 'https://www.bnbchain.org',
  },
  // A young EVM chain, the case that did not exist when this list was written.
  {
    key: 'epix',
    chainId: 1916,
    displayName: 'Epix',
    nativeTicker: 'EPIX',
    nativeDecimals: 18,
    homepage: 'https://epix.zone',
    young: true,
  },
];

function setup(overrides: Partial<MockState> = {}) {
  const switchChain = vi.fn().mockResolvedValue(undefined);
  const enableChain = vi.fn().mockResolvedValue({ ok: true });
  setState({
    wallets: [wallet()],
    activeChain: 'mainnet',
    hiddenChains: [],
    evm: { chains: [] },
    switchChain,
    enableChain,
    ...overrides,
  });
  return { switchChain, enableChain };
}

function openSwitcher() {
  fireEvent.click(screen.getByTestId('live-chain-switcher'));
}

describe('ChainSwitcher', () => {
  it('shows the active chain on the trigger and marks it selected in the list', () => {
    setup({ wallets: [wallet({ network: 'ravencoin-mainnet' })], activeChain: 'ravencoin-mainnet' });
    renderSwitcher();

    expect(screen.getByTestId('live-chain-switcher')).toHaveTextContent('Ravencoin');

    openSwitcher();
    const current = screen.getByTestId('live-chain-option-ravencoin-mainnet');
    expect(current.getAttribute('aria-selected')).toBe('true');
    expect(current.getAttribute('aria-current')).toBe('true');
    // A Check mark renders inside the selected row only (every row also has
    // a star, so the check is found by its class, not as "any svg").
    expect(current.querySelector('.opt-check')).not.toBeNull();

    const other = screen.getByTestId('live-chain-option-mainnet');
    expect(other.getAttribute('aria-selected')).toBe('false');
    expect(other.querySelector('.opt-check')).toBeNull();
  });

  it('a chain switch lands on the Wallet tab (the balances are the first thing to check)', () => {
    navCalls.length = 0;
    setup({
      wallets: [wallet({ network: 'mainnet' }), wallet({ id: 'w2', network: 'ravencoin-mainnet', active: false })],
      activeChain: 'mainnet',
    });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-ravencoin-mainnet'));
    expect(navCalls).toEqual(['assets']);
  });

  it('switches straight to a chain the wallet already has, and closes the dropdown', () => {
    const { switchChain } = setup({
      wallets: [wallet({ network: 'mainnet' }), wallet({ id: 'w2', network: 'ravencoin-mainnet', active: false })],
      activeChain: 'mainnet',
    });
    renderSwitcher();
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-ravencoin-mainnet'));

    expect(switchChain).toHaveBeenCalledWith('ravencoin-mainnet');
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });

  it('opens the enable panel (not a switch) for a chain with no wallet yet', () => {
    const { switchChain } = setup();
    renderSwitcher();
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-bitcoingold-mainnet'));

    expect(switchChain).not.toHaveBeenCalled();
    const panel = screen.getByTestId('live-chain-enable-panel');
    expect(panel.textContent).toMatch(/Enable BitcoinGold for this wallet\?/);
    expect(panel.textContent).toMatch(/from the same recovery phrase/i);
  });

  it('shows the shared-derivation privacy sentence for Ravencoin (shares a key with the active Evrmore wallet)', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-ravencoin-mainnet'));

    const note = screen.getByTestId('live-chain-privacy-note');
    expect(note.textContent).toMatch(/share the same key/i);
    expect(note.textContent).toMatch(/publicly linkable/i);
  });

  it('does NOT show the privacy sentence for Bitcoin Gold or Litecoin (no shared derivation)', () => {
    setup();
    renderSwitcher();

    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-bitcoingold-mainnet'));
    expect(screen.queryByTestId('live-chain-privacy-note')).toBeNull();

    fireEvent.click(screen.getByTestId('live-chain-enable-cancel'));
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.queryByTestId('live-chain-privacy-note')).toBeNull();
  });

  it('shows the privacy note on EVERY pair for an imported-key (pk) wallet, even without shared derivation', () => {
    // A 'pk' wallet re-imports the SAME private key on the target chain, so the
    // addresses are linkable on every pair; the derivation-based predicate
    // (mocked to Evrmore<->Ravencoin only) cannot see that.
    setup({ wallets: [wallet({ kind: 'pk' })] });
    renderSwitcher();
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.getByTestId('live-chain-privacy-note').textContent).toMatch(/publicly linkable/i);

    fireEvent.click(screen.getByTestId('live-chain-enable-cancel'));
    fireEvent.click(screen.getByTestId('live-chain-option-bitcoingold-mainnet'));
    expect(screen.getByTestId('live-chain-privacy-note').textContent).toMatch(/publicly linkable/i);
  });

  it("describes a pk wallet's enable step as reusing the imported key, never a recovery phrase", () => {
    setup({ wallets: [wallet({ kind: 'pk' })] });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));

    const panel = screen.getByTestId('live-chain-enable-panel');
    expect(panel.textContent).toMatch(/imported private key/i);
    // A pk wallet has no recovery phrase; the seed wording would be false.
    expect(panel.textContent).not.toMatch(/recovery phrase/i);
    // House style: no em-dash in the pk copy either.
    expect(panel.textContent).not.toContain('—');
  });

  it('shows a password field for a normal (password-protected) active wallet', () => {
    setup({ wallets: [wallet({ passwordless: false })] });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));

    expect(screen.getByTestId('live-chain-enable-password')).not.toBeNull();
  });

  it('skips the password field entirely for a passwordless active wallet', () => {
    setup({ wallets: [wallet({ passwordless: true })] });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));

    expect(screen.queryByTestId('live-chain-enable-password')).toBeNull();
  });

  it('calls enableChain with an empty password for a passwordless wallet, and closes on success', async () => {
    const { enableChain } = setup({ wallets: [wallet({ passwordless: true })] });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));

    await waitFor(() => expect(enableChain).toHaveBeenCalledWith('litecoin-mainnet', ''));
    await waitFor(() => expect(screen.queryByTestId('live-chain-enable-panel')).toBeNull());
  });

  it('shows the returned error and keeps the panel open when enableChain fails', async () => {
    const enableChain = vi.fn().mockResolvedValue({ ok: false, error: 'Incorrect password' });
    setup({ enableChain });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    fireEvent.change(screen.getByTestId('live-chain-enable-password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));

    await waitFor(() => expect(screen.getByTestId('live-chain-enable-error')).toHaveTextContent('Incorrect password'));
    expect(screen.getByTestId('live-chain-enable-panel')).not.toBeNull();
    expect(enableChain).toHaveBeenCalledWith('litecoin-mainnet', 'hunter2');
  });

  it('never uses an em-dash in its copy (house style)', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-dropdown').textContent).not.toContain('—');

    fireEvent.click(screen.getByTestId('live-chain-option-ravencoin-mainnet'));
    expect(screen.getByTestId('live-chain-enable-panel').textContent).not.toContain('—');
  });

  it('closes on Escape', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-dropdown')).not.toBeNull();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });

  it('closes on an outside click', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-dropdown')).not.toBeNull();

    fireEvent.click(screen.getByTestId('live-chain-switcher-overlay'));
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });
});

describe('what the chain list says about each chain', () => {
  // NONE of this had a test before 2026-08-26. The mocked describeChain simply
  // did not return `homepage` or the markers, so the component rendered neither
  // and every assertion in this file still passed.

  it('shows the project\'s own domain under the name, EVM rows included', () => {
    setup({
      wallets: [wallet({ network: 'mainnet' }), wallet({ family: 'evm' })],
      activeChain: 'mainnet',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();

    // A domain is what tells two similarly named chains apart, which is the
    // whole reason it is on this list rather than on a detail screen.
    expect(screen.getByTestId('live-chain-option-mainnet')).toHaveTextContent('evrmore.com');
    expect(screen.getByTestId('live-chain-option-neoxa-mainnet')).toHaveTextContent('neoxa.net');
    expect(screen.getByTestId('live-chain-option-evm:base')).toHaveTextContent('base.org');
    expect(screen.getByTestId('live-chain-option-evm:epix')).toHaveTextContent('epix.zone');
    // `www.` is stripped: it is noise, and the row has one line to spend.
    const bsc = screen.getByTestId('live-chain-option-evm:bsc');
    expect(bsc).toHaveTextContent('bnbchain.org');
    expect(bsc.textContent).not.toMatch(/www\./);
    // The scheme never shows either.
    expect(screen.getByTestId('live-chain-option-mainnet').textContent).not.toMatch(/https?:/);
  });

  it('marks a YOUNG network New, on both families', () => {
    setup({
      wallets: [wallet({ network: 'mainnet' }), wallet({ family: 'evm' })],
      activeChain: 'mainnet',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();

    expect(screen.getByTestId('live-chain-young-wojakcoin-mainnet')).toHaveTextContent('New');
    expect(screen.getByTestId('live-chain-young-bitcoingold-mainnet')).toBeTruthy();
    // The EVM registry carries the flag too now, so a thin EVM chain is marked
    // at the moment of choosing, exactly as a thin UTXO one is.
    expect(screen.getByTestId('live-chain-young-evm:epix')).toHaveTextContent('New');
    expect(screen.getByTestId('live-chain-young-evm:epix').getAttribute('title')).toMatch(
      /young network/i,
    );
  });

  it('marks a chain that is only new HERE, and does not call its network young', () => {
    setup({ wallets: [wallet({ network: 'mainnet' })], activeChain: 'mainnet' });
    renderSwitcher();
    openSwitcher();

    // Neoxa is new in this wallet and a mature network out there. It gets the
    // chip, and its tooltip must NOT repeat the young-network warning: that
    // would be a false claim about someone else's chain (see chainParams.ts
    // `recentlyAdded`).
    const chip = screen.getByTestId('live-chain-young-neoxa-mainnet');
    expect(chip).toHaveTextContent('New');
    expect(chip.getAttribute('title')).toBe('Recently added to Satori GO.');
    expect(chip.getAttribute('title')).not.toMatch(/young/i);
  });

  it('marks nothing on an established chain', () => {
    setup({
      wallets: [wallet({ network: 'mainnet' }), wallet({ family: 'evm' })],
      activeChain: 'mainnet',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();

    expect(screen.queryByTestId('live-chain-young-mainnet')).toBeNull();
    expect(screen.queryByTestId('live-chain-young-bitcoin-mainnet')).toBeNull();
    expect(screen.queryByTestId('live-chain-young-evm:base')).toBeNull();
  });
});

describe('hidden networks', () => {
  it('leaves a hidden chain out of the switcher list', () => {
    setup({ hiddenChains: ['litecoin-mainnet', 'dogecoin-mainnet'] });
    renderSwitcher();
    openSwitcher();

    expect(screen.queryByTestId('live-chain-option-litecoin-mainnet')).toBeNull();
    expect(screen.queryByTestId('live-chain-option-dogecoin-mainnet')).toBeNull();
    // Everything else is still offered.
    expect(screen.getByTestId('live-chain-option-bitcoin-mainnet')).toBeTruthy();
    expect(screen.getByTestId('live-chain-option-mainnet')).toBeTruthy();
  });

  it('a hidden EVM chain (evm:<key> in the hide list) is left out too, unless it is the one in use', () => {
    setup({ evm: { chains: EVM_CHAINS }, hiddenChains: ['evm:bsc'] });
    renderSwitcher();
    openSwitcher();
    expect(screen.queryByTestId('live-chain-option-evm:bsc')).toBeNull();
    expect(screen.getByTestId('live-chain-option-evm:base')).toBeTruthy();
    cleanup();

    setup({
      wallets: [evmWallet({ evmChainKey: 'bsc' })],
      activeChain: 'evm:bsc',
      evm: { chains: EVM_CHAINS },
      hiddenChains: ['evm:bsc'],
    });
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-option-evm:bsc').getAttribute('aria-selected')).toBe('true');
  });

  it('still shows the chain IN USE even if it is somehow marked hidden', () => {
    // The store refuses to hide the active chain, but a stale render must not be
    // able to strand the user on a network missing from their own list.
    setup({ activeChain: 'bitcoin-mainnet', hiddenChains: ['bitcoin-mainnet'] });
    renderSwitcher();
    openSwitcher();

    const row = screen.getByTestId('live-chain-option-bitcoin-mainnet');
    expect(row.getAttribute('aria-selected')).toBe('true');
  });
});

describe('seed-scoped rows (the owner chain-scoping rule; X01/X02)', () => {
  // "Wallet 1" (Evrmore) is active and has NO siblings. Another phrase,
  // "Wallet 2", has a Monero wallet (renamed "My XMR"), a Bitcoin wallet and
  // an EVM account. Every one of those rows must offer Add for Wallet 1 and
  // open the enable step, never switch into Wallet 2's wallets.
  const otherPhrase = [
    wallet({ id: 'w2', name: 'Wallet 2', network: 'mainnet', active: false }),
    wallet({ id: 'x2', name: 'My XMR', network: 'xmr:mainnet', family: 'monero', active: false }),
    wallet({ id: 'b2', name: 'Wallet 2 (Bitcoin)', network: 'bitcoin-mainnet', active: false }),
    evmWallet({ id: 'e2', name: 'Wallet 2 (EVM)', active: false }),
  ];

  it('offers Add on Monero, Bitcoin and Base for a phrase that has none of them, whatever other phrases have', () => {
    const { switchChain, enableChain } = setup({
      wallets: [wallet({ id: 'w1', name: 'Wallet 1' }), ...otherPhrase],
      evm: { chains: EVM_CHAINS },
      monero: { chain: XMR_CHAIN },
    });
    renderSwitcher();
    openSwitcher();
    for (const id of ['xmr:mainnet', 'bitcoin-mainnet', 'evm:base']) {
      expect(screen.getByTestId(`live-chain-option-${id}`)).toHaveTextContent('Add');
    }
    fireEvent.click(screen.getByTestId('live-chain-option-xmr:mainnet'));
    expect(switchChain).not.toHaveBeenCalled();
    expect(enableChain).not.toHaveBeenCalled();
    expect(screen.getByTestId('live-chain-enable-panel').textContent).toMatch(/Enable Monero for this wallet\?/);
  });

  it('switches to the sibling once THIS phrase has the chain', () => {
    const { switchChain } = setup({
      wallets: [wallet({ id: 'w1', name: 'Wallet 1' }), wallet({ id: 'x1', name: 'Wallet 1 (Monero)', network: 'xmr:mainnet', family: 'monero', active: false }), ...otherPhrase],
      evm: { chains: EVM_CHAINS },
      monero: { chain: XMR_CHAIN },
    });
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-option-xmr:mainnet')).not.toHaveTextContent('Add');
    expect(screen.getByTestId('live-chain-option-bitcoin-mainnet')).toHaveTextContent('Add');
    fireEvent.click(screen.getByTestId('live-chain-option-xmr:mainnet'));
    expect(switchChain).toHaveBeenCalledWith('xmr:mainnet');
  });

  it('a wallet outside any seed group (imported key) keeps the any-wallet rule', () => {
    const { switchChain } = setup({
      wallets: [wallet({ id: 'p1', name: 'Satori key', kind: 'pk' }), ...otherPhrase],
      evm: { chains: EVM_CHAINS },
      monero: { chain: XMR_CHAIN },
    });
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-option-bitcoin-mainnet')).not.toHaveTextContent('Add');
    fireEvent.click(screen.getByTestId('live-chain-option-bitcoin-mainnet'));
    expect(switchChain).toHaveBeenCalledWith('bitcoin-mainnet');
  });

  it('the row in use never shows Add', () => {
    setup({ wallets: [wallet({ id: 'w1', name: 'Wallet 1' })] });
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-option-mainnet')).not.toHaveTextContent('Add');
  });
});

describe('EVM chains', () => {
  it('shows no EVM rows when evm.chains is empty (a build without the EVM engine)', () => {
    setup();
    renderSwitcher();
    openSwitcher();

    expect(screen.queryByTestId('live-chain-option-evm:base')).toBeNull();
    expect(screen.queryByTestId('live-chain-option-evm:bsc')).toBeNull();
  });

  it('lists one row per EVM chain, after the UTXO rows, once evm.chains is non-empty', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();

    expect(screen.getByTestId('live-chain-option-evm:base')).toHaveTextContent('Base');
    expect(screen.getByTestId('live-chain-option-evm:bsc')).toHaveTextContent('BNB Smart Chain');
  });

  it('an active EVM account marks the row matching activeChainTarget() as current, with the EVM chain name on the trigger', () => {
    setup({
      wallets: [evmWallet({ evmChainKey: 'base' })],
      activeChain: 'evm:base',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();

    expect(screen.getByTestId('live-chain-switcher')).toHaveTextContent('Base');

    openSwitcher();
    const current = screen.getByTestId('live-chain-option-evm:base');
    expect(current.getAttribute('aria-selected')).toBe('true');
    expect(current.getAttribute('aria-current')).toBe('true');
    expect(screen.getByTestId('live-chain-option-evm:bsc').getAttribute('aria-selected')).toBe('false');
  });

  it('clicking an already-enabled EVM row switches straight to it (switchChain), no enable step', () => {
    const { switchChain, enableChain } = setup({
      wallets: [evmWallet({ evmChainKey: 'base' })],
      activeChain: 'evm:base',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-evm:bsc'));

    expect(switchChain).toHaveBeenCalledWith('evm:bsc');
    expect(enableChain).not.toHaveBeenCalled();
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });

  it('clicking an EVM row with no wallet yet opens the enable step and submits enableChain(evm:base, pw)', async () => {
    const { switchChain, enableChain } = setup({
      wallets: [wallet({ network: 'mainnet', passwordless: false })],
      activeChain: 'mainnet',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();

    fireEvent.click(screen.getByTestId('live-chain-option-evm:base'));
    expect(switchChain).not.toHaveBeenCalled();
    const panel = screen.getByTestId('live-chain-enable-panel');
    expect(panel.textContent).toMatch(/Enable Base for this wallet\?/);

    fireEvent.change(screen.getByTestId('live-chain-enable-password'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));

    await waitFor(() => expect(enableChain).toHaveBeenCalledWith('evm:base', 'hunter2'));
  });

  it('shows the EVM-derivation note (not the UTXO linkability note) when enabling an EVM chain', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-evm:base'));

    const note = screen.getByTestId('live-chain-evm-derivation-note');
    expect(note.textContent).toMatch(/standard EVM path/i);
    expect(note.textContent).toMatch(/m\/44'\/60'\/0'\/0\/0/);
    expect(note.textContent).toMatch(/MetaMask/i);
    expect(screen.queryByTestId('live-chain-privacy-note')).toBeNull();
    expect(note.textContent).not.toContain('—');
  });

  it('an enabled EVM row gets the same "enabled" affordance as a UTXO row (no Add chip)', () => {
    setup({
      wallets: [evmWallet({ evmChainKey: 'base' })],
      activeChain: 'evm:base',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();

    // Both EVM rows are "Add"-free: one EVM account enables every EVM chain.
    expect(screen.getByTestId('live-chain-option-evm:base').textContent).not.toMatch(/Add/);
    expect(screen.getByTestId('live-chain-option-evm:bsc').textContent).not.toMatch(/Add/);
  });

  it('offers an EVM row with no wallet yet with the same "Add" affordance as an unenabled UTXO row', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();

    expect(screen.getByTestId('live-chain-option-evm:base').textContent).toMatch(/Add/);
  });

  it('never filters an EVM row via hiddenChains (hidden is a UTXO-only concept)', () => {
    setup({ hiddenChains: ['mainnet', 'ravencoin-mainnet'], evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();

    expect(screen.getByTestId('live-chain-option-evm:base')).toBeTruthy();
    expect(screen.getByTestId('live-chain-option-evm:bsc')).toBeTruthy();
  });
});

describe('grouping: Your networks on top, Add a network below', () => {
  /** Row and header test ids in DOM order, so an assertion reads the list the
   *  way the user does. */
  function listOrder(): string[] {
    const list = screen.getByTestId('live-chain-list');
    return Array.from(list.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid') ?? '')
      .filter((id) => id.startsWith('live-chain-option-') || id.startsWith('live-chain-group-'));
  }

  it('puts the chains this wallet has first, then the Add rows, each in the switcher order', () => {
    setup({
      wallets: [
        wallet({ id: 'w1', name: 'Wallet 1', network: 'mainnet' }),
        wallet({ id: 'w1b', name: 'Wallet 1 (Bitcoin)', network: 'bitcoin-mainnet', active: false }),
      ],
      activeChain: 'mainnet',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();

    const order = listOrder();
    const mineAt = order.indexOf('live-chain-group-mine');
    const addAt = order.indexOf('live-chain-group-add');
    expect(mineAt).toBe(0);
    // Within each group, the switcher's own order (from the REAL ChainPicker),
    // not an order this component invents.
    const full = switcherChainOptionsFor(EVM_CHAINS as never, null).map((o) => `live-chain-option-${o.value}`);
    const mineRows = order.slice(mineAt + 1, addAt);
    expect([...mineRows].sort()).toEqual(['live-chain-option-bitcoin-mainnet', 'live-chain-option-mainnet']);
    expect(mineRows).toEqual(full.filter((id) => mineRows.includes(id)));
    const addRows = order.slice(addAt + 1);
    expect(addRows).toEqual(full.filter((id) => addRows.includes(id)));
    // Every other chain sits under Add, and every one of them shows the chip.
    expect(addRows).toContain('live-chain-option-ravencoin-mainnet');
    expect(addRows).toContain('live-chain-option-evm:base');
    for (const id of addRows) expect(screen.getByTestId(id)).toHaveTextContent('Add');
    // Same relative order as before the split: UTXO rows keep theirs, EVM after.
    expect(addRows.indexOf('live-chain-option-ravencoin-mainnet')).toBeLessThan(
      addRows.indexOf('live-chain-option-evm:base'),
    );
    expect(addRows.indexOf('live-chain-option-evm:base')).toBeLessThan(addRows.indexOf('live-chain-option-evm:bsc'));
    expect(screen.getByTestId('live-chain-group-mine')).toHaveTextContent('Your networks');
    expect(screen.getByTestId('live-chain-group-add')).toHaveTextContent('Add a network');
    expect(screen.getByTestId('live-chain-group-mine').className).toContain('section-label');
  });

  it('files the seed-scoped rows by the same rule that decides Add vs switch', () => {
    // Another phrase has Bitcoin and an EVM account; Wallet 1 has neither, so
    // they belong under Add, not under Your networks.
    setup({
      wallets: [
        wallet({ id: 'w1', name: 'Wallet 1' }),
        wallet({ id: 'b2', name: 'Wallet 2 (Bitcoin)', network: 'bitcoin-mainnet', active: false }),
        evmWallet({ id: 'e2', name: 'Wallet 2 (EVM)', active: false }),
      ],
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();
    const order = listOrder();
    const addAt = order.indexOf('live-chain-group-add');
    expect(order.indexOf('live-chain-option-bitcoin-mainnet')).toBeGreaterThan(addAt);
    expect(order.indexOf('live-chain-option-evm:base')).toBeGreaterThan(addAt);
    expect(order.indexOf('live-chain-option-mainnet')).toBeLessThan(addAt);
  });

  it('an EVM account lists every EVM chain under Your networks', () => {
    setup({
      wallets: [evmWallet({ evmChainKey: 'base' })],
      activeChain: 'evm:base',
      evm: { chains: EVM_CHAINS },
    });
    renderSwitcher();
    openSwitcher();
    const order = listOrder();
    const addAt = order.indexOf('live-chain-group-add');
    for (const id of ['evm:base', 'evm:bsc', 'evm:epix']) {
      expect(order.indexOf(`live-chain-option-${id}`)).toBeLessThan(addAt);
    }
  });

  it('hides a group header when its group is empty', () => {
    // Every visible chain is one this wallet has: no Add group at all.
    setup({
      activeChain: 'mainnet',
      hiddenChains: [
        'ravencoin-mainnet',
        'bitcoingold-mainnet',
        'litecoin-mainnet',
        'wojakcoin-mainnet',
        'bitcoin-mainnet',
        'dogecoin-mainnet',
        'neoxa-mainnet',
        'bitcoinblake2b-mainnet',
        'zec:mainnet',
        'tao:mainnet',
      ],
    });
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-group-mine')).toBeTruthy();
    expect(screen.queryByTestId('live-chain-group-add')).toBeNull();
    cleanup();

    // A search that only hits Add rows leaves Your networks without a header.
    setup();
    renderSwitcher();
    openSwitcher();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'doge' } });
    expect(screen.queryByTestId('live-chain-group-mine')).toBeNull();
    expect(screen.getByTestId('live-chain-group-add')).toBeTruthy();
  });
});

describe('search', () => {
  it('filters by display name, case-insensitively', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'RAVEN' } });
    expect(screen.getByTestId('live-chain-option-ravencoin-mainnet')).toBeTruthy();
    expect(screen.queryByTestId('live-chain-option-mainnet')).toBeNull();
    expect(screen.queryByTestId('live-chain-option-evm:base')).toBeNull();
  });

  it('filters by ticker', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'bnb' } });
    expect(screen.getByTestId('live-chain-option-evm:bsc')).toBeTruthy();
    expect(screen.queryByTestId('live-chain-option-evm:base')).toBeNull();

    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'ltc' } });
    expect(screen.getByTestId('live-chain-option-litecoin-mainnet')).toBeTruthy();
    expect(screen.queryByTestId('live-chain-option-bitcoin-mainnet')).toBeNull();
  });

  it('filters by homepage host, as the row shows it (no scheme, no www.)', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'bnbchain.org' } });
    expect(screen.getByTestId('live-chain-option-evm:bsc')).toBeTruthy();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'epix.zone' } });
    expect(screen.getByTestId('live-chain-option-evm:epix')).toBeTruthy();
    expect(screen.queryByTestId('live-chain-option-evm:bsc')).toBeNull();
    // The stripped parts are not searchable: they are not on screen.
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'https' } });
    expect(screen.getByTestId('live-chain-search-empty')).toHaveTextContent('No network matches');
  });

  it('shows "No network matches" when nothing matches, and clearing restores the list', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    const before = screen.getAllByRole('option').length;
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'zzzz' } });
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByTestId('live-chain-search-empty')).toHaveTextContent('No network matches');
    expect(screen.queryByTestId('live-chain-group-mine')).toBeNull();
    expect(screen.queryByTestId('live-chain-group-add')).toBeNull();

    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: '' } });
    expect(screen.getAllByRole('option')).toHaveLength(before);
    expect(screen.queryByTestId('live-chain-search-empty')).toBeNull();
  });

  it('a filtered row keeps its New chip and behaves the same when clicked', () => {
    const { switchChain } = setup();
    renderSwitcher();
    openSwitcher();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'wojak' } });
    expect(screen.getByTestId('live-chain-young-wojakcoin-mainnet')).toHaveTextContent('New');
    fireEvent.click(screen.getByTestId('live-chain-option-wojakcoin-mainnet'));
    expect(switchChain).not.toHaveBeenCalled();
    expect(screen.getByTestId('live-chain-enable-panel')).toBeTruthy();
  });

  it('Escape clears the search first, and a second Escape closes the dropdown', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    const search = screen.getByTestId('live-chain-search') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'doge' } });
    expect(screen.queryByTestId('live-chain-option-mainnet')).toBeNull();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.getByTestId('live-chain-dropdown')).toBeTruthy();
    expect((screen.getByTestId('live-chain-search') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('live-chain-option-mainnet')).toBeTruthy();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });

  it('Escape on the enable step still closes everything in one press', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'lite' } });
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.getByTestId('live-chain-enable-panel')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('live-chain-dropdown')).toBeNull();
  });

  it('starts empty every time the dropdown opens', () => {
    setup();
    renderSwitcher();
    openSwitcher();
    fireEvent.change(screen.getByTestId('live-chain-search'), { target: { value: 'doge' } });
    fireEvent.click(screen.getByTestId('live-chain-switcher-overlay'));
    openSwitcher();
    expect((screen.getByTestId('live-chain-search') as HTMLInputElement).value).toBe('');
    expect(screen.getByTestId('live-chain-option-mainnet')).toBeTruthy();
  });

  it('autofocuses the search with a fine pointer, never on a touch screen', () => {
    const saved = window.matchMedia;
    try {
      window.matchMedia = ((q: string) => ({ matches: false, media: q }) as MediaQueryList) as typeof window.matchMedia;
      setup();
      renderSwitcher();
      openSwitcher();
      expect(document.activeElement).toBe(screen.getByTestId('live-chain-search'));
      cleanup();

      window.matchMedia = ((q: string) =>
        ({ matches: q.includes('coarse'), media: q }) as MediaQueryList) as typeof window.matchMedia;
      setup();
      renderSwitcher();
      openSwitcher();
      expect(document.activeElement).not.toBe(screen.getByTestId('live-chain-search'));
    } finally {
      window.matchMedia = saved;
    }
  });
});

describe('Add Monero: "First used around" date', () => {
  function openMoneroEnable() {
    const mocks = setup({ wallets: [wallet()], monero: { chain: XMR_CHAIN } });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-xmr:mainnet'));
    return mocks;
  }
  function submitWithPassword() {
    fireEvent.change(screen.getByTestId('live-chain-enable-password'), { target: { value: 'pw' } });
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));
  }

  it('shows the date field only while "used before" is ticked, bounded to genesis .. today, with the hint', () => {
    openMoneroEnable();
    const box = screen.getByTestId('live-chain-monero-used-before') as HTMLInputElement;
    // No recorded origin reads as imported, so the box starts ticked.
    expect(box.checked).toBe(true);
    const date = screen.getByTestId('live-chain-monero-first-used') as HTMLInputElement;
    expect(date.type).toBe('date');
    expect(date.min).toBe('2014-04-18');
    expect(date.max).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(screen.getByText('Scanning starts near this date, so an older date takes longer.')).toBeTruthy();
    fireEvent.click(box);
    expect(screen.queryByTestId('live-chain-monero-first-used')).toBeNull();
  });

  it('an empty date keeps the old call exactly (no restore height)', async () => {
    const { enableChain } = openMoneroEnable();
    submitWithPassword();
    await waitFor(() => expect(enableChain).toHaveBeenCalledWith('xmr:mainnet', 'pw', { moneroUsedBefore: true }));
  });

  it('a date becomes a restore height, below the release floor for an older date', async () => {
    const { enableChain } = openMoneroEnable();
    fireEvent.change(screen.getByTestId('live-chain-monero-first-used'), { target: { value: '2024-01-15' } });
    submitWithPassword();
    await waitFor(() => expect(enableChain).toHaveBeenCalled());
    const opts = enableChain.mock.calls[0][2] as { moneroUsedBefore: boolean; moneroRestoreHeight: number };
    expect(opts.moneroUsedBefore).toBe(true);
    expect(Number.isSafeInteger(opts.moneroRestoreHeight)).toBe(true);
    expect(opts.moneroRestoreHeight).toBeGreaterThan(3_000_000);
    expect(opts.moneroRestoreHeight).toBeLessThan(3_772_358);
  });

  it('a date before genesis clamps to height 0', async () => {
    const { enableChain } = openMoneroEnable();
    fireEvent.change(screen.getByTestId('live-chain-monero-first-used'), { target: { value: '2013-01-01' } });
    submitWithPassword();
    await waitFor(() =>
      expect(enableChain).toHaveBeenCalledWith('xmr:mainnet', 'pw', { moneroUsedBefore: true, moneroRestoreHeight: 0 }),
    );
  });

  it('refuses a future date without calling enableChain', () => {
    const { enableChain } = openMoneroEnable();
    fireEvent.change(screen.getByTestId('live-chain-monero-first-used'), { target: { value: '2999-01-01' } });
    submitWithPassword();
    expect(screen.getByText('That date is in the future.')).toBeTruthy();
    expect(enableChain).not.toHaveBeenCalled();
  });

  it('a date typed and then unticked is ignored', async () => {
    const { enableChain } = openMoneroEnable();
    fireEvent.change(screen.getByTestId('live-chain-monero-first-used'), { target: { value: '2024-01-15' } });
    fireEvent.click(screen.getByTestId('live-chain-monero-used-before'));
    submitWithPassword();
    await waitFor(() => expect(enableChain).toHaveBeenCalledWith('xmr:mainnet', 'pw', { moneroUsedBefore: false }));
  });
});


describe('favourites', () => {
  function listOrder(): string[] {
    const list = screen.getByTestId('live-chain-list');
    return Array.from(list.querySelectorAll('[data-testid]'))
      .map((el) => el.getAttribute('data-testid') ?? '')
      .filter((id) => id.startsWith('live-chain-option-') || id.startsWith('live-chain-group-'));
  }
  const favs = () => useSettingsStore.getState().settings.favouriteChains;
  const star = (id: string) => fireEvent.click(screen.getByTestId(`live-chain-fav-${id}`));

  it('every row has an outline star with an accessible label; no Favourites header while empty', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();
    expect(screen.queryByTestId('live-chain-group-fav')).toBeNull();
    const btn = screen.getByTestId('live-chain-fav-ravencoin-mainnet');
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.getAttribute('aria-label')).toBe('Add Ravencoin to favourites');
    expect(screen.getByTestId('live-chain-fav-evm:base').getAttribute('aria-label')).toBe('Add Base to favourites');
    // No button nested inside a button (the row is a focusable div now).
    expect(screen.getByTestId('live-chain-option-mainnet').tagName).toBe('DIV');
  });

  it('starring moves the row into Favourites at the top, ONLY there, and keeps the dropdown open', () => {
    const { switchChain, enableChain } = setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();
    star('ravencoin-mainnet');

    expect(favs()).toEqual(['ravencoin-mainnet']);
    // Not selected, switched or enabled, and the list is still the list.
    expect(switchChain).not.toHaveBeenCalled();
    expect(enableChain).not.toHaveBeenCalled();
    expect(screen.queryByTestId('live-chain-enable-panel')).toBeNull();
    expect(screen.getByTestId('live-chain-dropdown')).toBeTruthy();

    const order = listOrder();
    expect(order[0]).toBe('live-chain-group-fav');
    expect(order[1]).toBe('live-chain-option-ravencoin-mainnet');
    expect(order.filter((id) => id === 'live-chain-option-ravencoin-mainnet')).toHaveLength(1);
    expect(screen.getByTestId('live-chain-group-fav')).toHaveTextContent('Favourites');
    expect(screen.getByTestId('live-chain-group-fav').className).toContain('section-label');
    const btn = screen.getByTestId('live-chain-fav-ravencoin-mainnet');
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-label')).toBe('Remove Ravencoin from favourites');

    // Unstarring puts it back under Add a network and drops the empty header.
    star('ravencoin-mainnet');
    expect(favs()).toEqual([]);
    expect(screen.queryByTestId('live-chain-group-fav')).toBeNull();
    const after = listOrder();
    expect(after.indexOf('live-chain-option-ravencoin-mainnet')).toBeGreaterThan(after.indexOf('live-chain-group-add'));
  });

  it('a starred row keeps its own behaviour: switch when the wallet has it, Add step when not', () => {
    const { switchChain } = setup({
      wallets: [
        wallet({ id: 'w1', name: 'Wallet 1', network: 'mainnet' }),
        wallet({ id: 'w1b', name: 'Wallet 1 (Bitcoin)', network: 'bitcoin-mainnet', active: false }),
      ],
    });
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, favouriteChains: ['litecoin-mainnet', 'bitcoin-mainnet'] } }));
    renderSwitcher();
    openSwitcher();
    expect(screen.getByTestId('live-chain-option-litecoin-mainnet')).toHaveTextContent('Add');
    expect(screen.getByTestId('live-chain-option-bitcoin-mainnet')).not.toHaveTextContent('Add');
    fireEvent.click(screen.getByTestId('live-chain-option-bitcoin-mainnet'));
    expect(switchChain).toHaveBeenCalledWith('bitcoin-mainnet');
    cleanup();

    setup();
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, favouriteChains: ['litecoin-mainnet'] } }));
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.getByTestId('live-chain-enable-panel')).toBeTruthy();
  });

  it('keyboard: the star toggles on Enter/Space as a button without activating the row; the row itself still answers Enter', () => {
    const { switchChain } = setup({
      wallets: [
        wallet({ id: 'w1', name: 'Wallet 1', network: 'mainnet' }),
        wallet({ id: 'w1b', name: 'Wallet 1 (Bitcoin)', network: 'bitcoin-mainnet', active: false }),
      ],
    });
    renderSwitcher();
    openSwitcher();
    const starBtn = screen.getByTestId('live-chain-fav-bitcoin-mainnet');
    fireEvent.keyDown(starBtn, { key: 'Enter' });
    expect(switchChain).not.toHaveBeenCalled();
    const row = screen.getByTestId('live-chain-option-bitcoin-mainnet');
    expect(row.getAttribute('tabindex')).toBe('0');
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(switchChain).toHaveBeenCalledWith('bitcoin-mainnet');
  });

  it('lists favourites in starring order, newest at the bottom', () => {
    setup({ evm: { chains: EVM_CHAINS } });
    renderSwitcher();
    openSwitcher();
    star('dogecoin-mainnet');
    star('evm:base');
    star('mainnet');
    expect(favs()).toEqual(['dogecoin-mainnet', 'evm:base', 'mainnet']);
    expect(listOrder().slice(0, 4)).toEqual([
      'live-chain-group-fav',
      'live-chain-option-dogecoin-mainnet',
      'live-chain-option-evm:base',
      'live-chain-option-mainnet',
    ]);
    // The row in use, starred, is no longer repeated under Your networks.
    expect(screen.queryByTestId('live-chain-group-mine')).toBeNull();
  });

  it('up and down reorder within Favourites; the ends are disabled; plain rows have no arrows', () => {
    setup();
    useSettingsStore.setState((st) => ({
      settings: { ...st.settings, favouriteChains: ['dogecoin-mainnet', 'litecoin-mainnet', 'bitcoin-mainnet'] },
    }));
    renderSwitcher();
    openSwitcher();
    expect((screen.getByTestId('live-chain-fav-up-dogecoin-mainnet') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('live-chain-fav-down-bitcoin-mainnet') as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId('live-chain-fav-up-ravencoin-mainnet')).toBeNull();
    expect(screen.getByTestId('live-chain-fav-up-litecoin-mainnet').getAttribute('aria-label')).toBe('Move Litecoin up');

    fireEvent.click(screen.getByTestId('live-chain-fav-up-bitcoin-mainnet'));
    expect(favs()).toEqual(['dogecoin-mainnet', 'bitcoin-mainnet', 'litecoin-mainnet']);
    fireEvent.click(screen.getByTestId('live-chain-fav-down-dogecoin-mainnet'));
    expect(favs()).toEqual(['bitcoin-mainnet', 'dogecoin-mainnet', 'litecoin-mainnet']);
    expect(listOrder().slice(1, 4)).toEqual([
      'live-chain-option-bitcoin-mainnet',
      'live-chain-option-dogecoin-mainnet',
      'live-chain-option-litecoin-mainnet',
    ]);
    // Moving never selects the row or closes the list.
    expect(screen.getByTestId('live-chain-list')).toBeTruthy();
    expect(screen.queryByTestId('live-chain-enable-panel')).toBeNull();
  });

  it('search filters favourites too, and the header goes when none match', () => {
    setup();
    useSettingsStore.setState((st) => ({
      settings: { ...st.settings, favouriteChains: ['dogecoin-mainnet', 'litecoin-mainnet'] },
    }));
    renderSwitcher();
    openSwitcher();
    const search = screen.getByTestId('live-chain-search');
    fireEvent.change(search, { target: { value: 'doge' } });
    expect(listOrder()).toEqual(['live-chain-group-fav', 'live-chain-option-dogecoin-mainnet']);
    fireEvent.change(search, { target: { value: 'raven' } });
    expect(screen.queryByTestId('live-chain-group-fav')).toBeNull();
    expect(screen.getByTestId('live-chain-option-ravencoin-mainnet')).toBeTruthy();
    fireEvent.change(search, { target: { value: 'zzzz' } });
    expect(screen.getByTestId('live-chain-search-empty')).toBeTruthy();
  });

  it('ignores ids this build has no row for (and hidden chains), but keeps them stored', () => {
    setup({ hiddenChains: ['litecoin-mainnet'] });
    useSettingsStore.setState((st) => ({
      settings: { ...st.settings, favouriteChains: ['evm:gone', 'litecoin-mainnet', 'dogecoin-mainnet'] },
    }));
    renderSwitcher();
    openSwitcher();
    expect(listOrder().slice(0, 2)).toEqual(['live-chain-group-fav', 'live-chain-option-dogecoin-mainnet']);
    expect(screen.queryByTestId('live-chain-option-evm:gone')).toBeNull();
    expect(screen.queryByTestId('live-chain-option-litecoin-mainnet')).toBeNull();
    // Starring another chain leaves the unknown one where it was: the EVM list
    // may simply not have arrived from the gateway yet.
    star('bitcoin-mainnet');
    expect(favs()).toEqual(['evm:gone', 'litecoin-mainnet', 'dogecoin-mainnet', 'bitcoin-mainnet']);
  });

  it('persists: a star survives a reload (fresh settings load from storage)', async () => {
    setup();
    renderSwitcher();
    openSwitcher();
    star('dogecoin-mainnet');
    star('litecoin-mainnet');
    await waitFor(async () => expect((await loadSettings()).favouriteChains).toEqual(['dogecoin-mainnet', 'litecoin-mainnet']));
    cleanup();

    // "Reload": the store forgets, then loads from storage like App does.
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS }, loaded: false });
    await useSettingsStore.getState().load();
    setup();
    renderSwitcher();
    openSwitcher();
    expect(listOrder().slice(0, 3)).toEqual([
      'live-chain-group-fav',
      'live-chain-option-dogecoin-mainnet',
      'live-chain-option-litecoin-mainnet',
    ]);
    // Stored under the one settings key, next to the other UI preferences.
    expect((await getStorage().get<{ favouriteChains: string[] }>('settings'))?.favouriteChains).toEqual([
      'dogecoin-mainnet',
      'litecoin-mainnet',
    ]);
  });

  it('never uses an em-dash in its copy', () => {
    setup();
    useSettingsStore.setState((st) => ({ settings: { ...st.settings, favouriteChains: ['dogecoin-mainnet'] } }));
    renderSwitcher();
    openSwitcher();
    const pop = screen.getByTestId('live-chain-dropdown');
    expect(pop.textContent).not.toContain('\u2014');
    for (const el of Array.from(pop.querySelectorAll('[aria-label]'))) {
      expect(el.getAttribute('aria-label')).not.toContain('\u2014');
    }
  });
});

describe('no password on an open app-protected wallet (owner request 2026-10-04)', () => {
  function setupKeyed(canEnableChainWithoutPassword: boolean, overrides: Partial<MockState> = {}) {
    const refreshEnableChainWithoutPassword = vi.fn().mockResolvedValue(canEnableChainWithoutPassword);
    const mocks = setup({
      wallets: [wallet({ appProtected: true })],
      canEnableChainWithoutPassword,
      refreshEnableChainWithoutPassword,
      ...overrides,
    });
    return { ...mocks, refreshEnableChainWithoutPassword };
  }

  it('hides the field and says the new network is protected by the main password; submits with no password', async () => {
    const { enableChain, refreshEnableChainWithoutPassword } = setupKeyed(true);
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));

    // The flag is re-read the moment the panel opens.
    expect(refreshEnableChainWithoutPassword).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('live-chain-enable-password')).toBeNull();
    expect(screen.getByTestId('live-chain-enable-protected-note')).toHaveTextContent('Protected by your main password.');
    expect(screen.getByTestId('live-chain-enable-panel').textContent).not.toContain('—');

    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));
    await waitFor(() => expect(enableChain).toHaveBeenCalledWith('litecoin-mainnet', ''));
    await waitFor(() => expect(screen.queryByTestId('live-chain-enable-panel')).toBeNull());
  });

  it('shows the (App password) field and no note when the flag is off', () => {
    setupKeyed(false);
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.getByTestId('live-chain-enable-password')).not.toBeNull();
    expect(screen.getByText('App password')).not.toBeNull();
    expect(screen.queryByTestId('live-chain-enable-protected-note')).toBeNull();
  });

  it('a wallet with its OWN password keeps the field even if the flag were on', () => {
    setupKeyed(true, { wallets: [wallet({ appProtected: false })] });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.getByTestId('live-chain-enable-password')).not.toBeNull();
    expect(screen.queryByTestId('live-chain-enable-protected-note')).toBeNull();
  });

  it('a stale key falls back to the field with a plain line, not an error, and the next submit carries the password', async () => {
    const enableChain = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'Enter your password to continue.', needsPassword: true })
      .mockResolvedValueOnce({ ok: true });
    setupKeyed(true, { enableChain });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));

    await waitFor(() =>
      expect(screen.getByTestId('live-chain-enable-needs-password')).toHaveTextContent('Enter your password to continue.'),
    );
    expect(enableChain).toHaveBeenNthCalledWith(1, 'litecoin-mainnet', '');
    expect(screen.queryByTestId('live-chain-enable-error')).toBeNull();
    expect(screen.queryByTestId('live-chain-enable-protected-note')).toBeNull();

    fireEvent.change(screen.getByTestId('live-chain-enable-password'), { target: { value: 'app-pw' } });
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));
    await waitFor(() => expect(enableChain).toHaveBeenNthCalledWith(2, 'litecoin-mainnet', 'app-pw'));
    await waitFor(() => expect(screen.queryByTestId('live-chain-enable-panel')).toBeNull());
  });

  it('the fall-back lasts for that panel only: reopening asks the store again', async () => {
    const enableChain = vi
      .fn()
      .mockResolvedValue({ ok: false, error: 'Enter your password to continue.', needsPassword: true });
    setupKeyed(true, { enableChain });
    renderSwitcher();
    openSwitcher();
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    fireEvent.click(screen.getByTestId('live-chain-enable-submit'));
    await waitFor(() => expect(screen.getByTestId('live-chain-enable-password')).not.toBeNull());

    fireEvent.click(screen.getByTestId('live-chain-enable-cancel'));
    fireEvent.click(screen.getByTestId('live-chain-option-litecoin-mainnet'));
    expect(screen.queryByTestId('live-chain-enable-needs-password')).toBeNull();
    expect(screen.getByTestId('live-chain-enable-protected-note')).not.toBeNull();
  });
});
