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

import { afterEach, describe, expect, it, vi } from 'vitest';
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
  family?: 'utxo' | 'evm';
  evmChainKey?: string;
}

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
  switchChain: (id: string) => Promise<void>;
  enableChain: (id: string, password: string) => Promise<{ ok: boolean; error?: string }>;
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
  describeChain: (id: string, evmChains: MockEvmChainInfo[]) => {
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
  walletOnChain: (wallets: MockWallet[], chainId: string) =>
    (chainId.startsWith('evm:')
      ? wallets.find((w) => w.family === 'evm')
      : wallets.find((w) => w.network === chainId)) ?? null,
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
}));

import { ChainSwitcher } from './ChainSwitcher';
import { NavProvider } from './LiveNav';

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
    // A Check mark renders inside the selected row only.
    expect(current.querySelector('svg')).not.toBeNull();

    const other = screen.getByTestId('live-chain-option-mainnet');
    expect(other.getAttribute('aria-selected')).toBe('false');
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
