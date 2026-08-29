/**
 * @vitest-environment jsdom
 *
 * LiveHome with an EVM active wallet (phase 3): the header names the EVM
 * chain, the young-network caution and the chain-homepage link disappear
 * (neither concept exists for an EVM account: it has no single project site
 * and this build's registry carries no young flag), and "Add token" is offered
 * (on EVM it adds an ERC-20 by CONTRACT ADDRESS: symbol and decimals are read
 * from the chain, see liveStore.addEvmToken). A UTXO
 * active wallet is asserted alongside it to pin that all of this renders
 * exactly as before once the EVM engine falls away.
 *
 * Real store + real LiveWalletService (so activeFamily()/nativeTickerFor()/
 * chainDisplayName() behave exactly as the app sees them), with the EVM
 * chain REGISTRY real (so "Base"/"ETH" are the actual names) but the EVM
 * balance/RPC path neutralized (refreshEvmWallet -> null, the store's own
 * "no EVM engine" fallback), a WebSocket that refuses to connect (keeps
 * every UTXO read offline), and prices stubbed. No network reaches out.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

const hoisted = vi.hoisted(() => ({ evmEnabled: true }));

vi.mock('../../services/chain/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/chain/engine')>();
  return {
    ...actual,
    loadEvmModules: async () => (hoisted.evmEnabled ? await import('../../services/chain/evm') : null),
  };
});

// Neutralizes every EVM balance/RPC call: refreshEvmWallet -> null is the
// store's own documented "this build carries no EVM engine" fallback (sets
// offline:true, leaves assets alone), so no fetch ever needs stubbing here.
vi.mock('../../store/evmBalances', () => ({
  evmProviderFor: async () => null,
  refreshEvmWallet: async () => null,
}));

// Prices are decorative and hit the network — stub so init()'s fire-and-forget
// fetch is inert (same stub LiveApp.test.tsx uses).
vi.mock('../../services/prices', () => ({
  fetchPrices: async () => ({}),
}));

import { MemoryStorageAdapter, setStorageForTests, type KeyValueStorage } from '../../services/storage';
import type { WalletSummary } from '../../services/chain/liveWallet';
import { NavProvider } from './LiveNav';

class NoNetWebSocket {
  static readonly OPEN = 1;
  constructor() {
    throw new Error('no network in unit tests');
  }
}

const VECTOR_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const PW = 'password123';

type LiveStoreModule = typeof import('../../store/liveStore');
type LiveState = ReturnType<LiveStoreModule['useLiveStore']['getState']>;
type LiveHomeModule = typeof import('./LiveHome');
let storeMod: LiveStoreModule;
let LiveHome: LiveHomeModule['LiveHome'];
let storage: KeyValueStorage;
const state = () => storeMod.useLiveStore.getState();

const NAV_VALUE = { tab: 'assets' as const, section: 'home' as const, openTab: () => {}, openSettings: () => {} };
function renderHome(tab: 'assets' | 'activity' = 'assets') {
  return render(
    <NavProvider value={{ ...NAV_VALUE, tab }}>
      <LiveHome onReceive={() => {}} onSend={() => {}} onSelectAsset={() => {}} onSelectTx={() => {}} />
    </NavProvider>,
  );
}

// Two accounts of ONE seed plus a UTXO wallet, injected straight into the store.
// The switcher renders entirely from `wallets` + `activeWalletId`, so fabricating
// the summaries pins the GROUPING without needing the service to derive a second
// address (that half is the accounts service's own tests).
const ADDR_1 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ADDR_2 = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const SEED_GROUP = ADDR_1.toLowerCase();

function evmAccount(over: Partial<WalletSummary> & { id: string }): WalletSummary {
  return {
    name: 'Account',
    network: 'evm',
    createdAt: 1,
    active: false,
    kind: 'seed',
    address: ADDR_1,
    passwordless: false,
    family: 'evm',
    hdIndex: 0,
    seedGroup: SEED_GROUP,
    ...over,
  } as WalletSummary;
}

const UTXO_WALLET = {
  id: 'w-utxo',
  name: 'My Evrmore',
  network: 'mainnet',
  createdAt: 1,
  active: false,
  kind: 'seed',
  address: 'EXXaddressXX',
  passwordless: false,
  family: 'utxo',
} as unknown as WalletSummary;

/** Put a known wallet list (and a clean scan state) in the store. */
function setWallets(wallets: WalletSummary[], activeWalletId: string) {
  storeMod.useLiveStore.setState({
    wallets,
    activeWalletId,
    evmAccountScan: { scanning: false, added: null, error: null },
  });
}

let realAddEvmAccount: LiveState['addEvmAccount'];
let realDiscoverEvmAccounts: LiveState['discoverEvmAccounts'];

beforeAll(async () => {
  (globalThis as { WebSocket?: unknown }).WebSocket = NoNetWebSocket;
  storeMod = await import('../../store/liveStore');
  LiveHome = (await import('./LiveHome')).LiveHome;
  // The store is a module singleton: an action replaced by a spy would leak into
  // every later test, so keep the originals and put them back after each one.
  realAddEvmAccount = state().addEvmAccount;
  realDiscoverEvmAccounts = state().discoverEvmAccounts;
});

beforeEach(async () => {
  hoisted.evmEnabled = true;
  storage = new MemoryStorageAdapter();
  setStorageForTests(storage);
  await state().resetLiveWallet();
  await state().init();
  // init() loads the EVM chains asynchronously; wait for them so
  // chainDisplayName()/nativeTickerFor() resolve 'Base'/'ETH' correctly.
  for (let i = 0; i < 50 && state().evm.chains.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
});

afterEach(() => {
  state().stopAutoRefresh();
  storeMod.useLiveStore.setState({
    addEvmAccount: realAddEvmAccount,
    discoverEvmAccounts: realDiscoverEvmAccounts,
  });
  cleanup();
});

describe('LiveHome with an EVM active wallet', () => {
  it('shows the EVM chain name, hides the young-chain notice and the chain homepage link, and offers Add token (by contract)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', 'evm:base');
    await state().loadWallets();
    expect(state().wallets[0]?.family).toBe('evm');

    renderHome();

    // The header's chain switcher names the active EVM chain.
    expect(screen.getByTestId('live-chain-switcher')).toHaveTextContent('Base');
    // The hero balance is labelled with the EVM chain's native ticker.
    expect(screen.getByText(/ETH Balance/)).toBeTruthy();

    expect(screen.queryByTestId('live-young-chain-notice')).toBeNull();
    expect(screen.queryByTestId('live-chain-homepage')).toBeNull();
    // Add token IS offered on EVM: it adds an ERC-20 by contract address.
    expect(screen.queryByTestId('live-add-asset')).not.toBeNull();
  }, 30_000);

  it('shows "EVM" (never a UTXO ticker) for an EVM row in the wallet switcher menu', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', 'evm:base');
    await state().loadWallets();

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));

    expect(screen.getByTestId('live-wallet-item-chain-0')).toHaveTextContent('EVM');
  }, 30_000);
});

describe('LiveHome Activity while history loads', () => {
  it('shows a loading state (not "No transactions yet") while the history source is being read and nothing is listed; a small spinner beside the title once rows exist', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', 'evm:base');
    await state().loadWallets();
    storeMod.useLiveStore.setState({ historyLoading: true, txs: [], historyIssue: null, loadingRefresh: false });
    const { unmount } = renderHome('activity');
    expect(screen.getByTestId('live-activity-loading')).toHaveTextContent('Loading activity');
    expect(screen.queryByText(/No transactions yet/)).toBeNull();
    unmount();

    storeMod.useLiveStore.setState({ historyLoading: false, txs: [] });
    const r2 = renderHome('activity');
    expect(screen.queryByTestId('live-activity-loading')).toBeNull();
    expect(screen.getByText(/No transactions yet/)).toBeInTheDocument();
    r2.unmount();

    storeMod.useLiveStore.setState({
      historyLoading: true,
      txs: [
        { txid: '0x' + 'ab'.repeat(32), asset: 'ETH', direction: 'in', amount: 1, feeEvr: 0, status: 'confirmed', blockHeight: 1, timestamp: 1_700_000_000, counterparty: '0xabc' },
      ],
    });
    renderHome('activity');
    expect(screen.getByTestId('live-activity-refreshing')).toBeInTheDocument();
    expect(screen.queryByTestId('live-activity-loading')).toBeNull();
  }, 30_000);
});

describe('LiveHome wallet switcher: accounts of one seed (the EVM accounts design notes)', () => {
  // Every test here starts from a REAL EVM import, so the active chain target is
  // an EVM one and the switcher's chain scoping behaves as in the app.
  //
  // The store fires account discovery off by itself after an EVM seed import
  // (fire-and-forget, see liveStore's import path), and that background run
  // writes `evmAccountScan` at a moment no test controls. It is stubbed inert
  // here so each test owns that state; the tests that exercise Discover install
  // their own spy over this one.
  async function importEvm() {
    storeMod.useLiveStore.setState({
      discoverEvmAccounts: vi.fn(async () => ({ ok: true, added: 0 })),
    });
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My EVM', 'evm:base');
    await state().loadWallets();
  }

  it('renames an account inline from the switcher: pencil, type, Enter; Escape cancels; an empty name keeps the old one', async () => {
    await importEvm();
    setWallets(
      [
        evmAccount({ id: 'a1', name: 'My EVM', hdIndex: 0, address: ADDR_1, active: true }),
        evmAccount({ id: 'a2', name: 'Account 2', hdIndex: 1, address: ADDR_2 }),
      ],
      'a1',
    );
    const renameSpy = vi.fn(async () => undefined);
    const realRename = state().renameWallet;
    storeMod.useLiveStore.setState({ renameWallet: renameSpy });
    try {
      renderHome();
      fireEvent.click(screen.getByTestId('live-wallet-switcher'));
      // Every row has a pencil, the active one included (rename is not a switch).
      expect(screen.getByTestId('live-wallet-rename-0')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('live-wallet-rename-1'));
      const input = screen.getByTestId('live-wallet-rename-input-1') as HTMLInputElement;
      expect(input.value).toBe('Account 2');
      // The row itself is replaced by the editor while renaming.
      expect(screen.queryByTestId('live-wallet-item-1')).toBeNull();
      fireEvent.change(input, { target: { value: '  Trading  ' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(renameSpy).toHaveBeenCalledWith('a2', 'Trading');
      // Editor gone, row back.
      expect(screen.queryByTestId('live-wallet-rename-input-1')).toBeNull();
      expect(screen.getByTestId('live-wallet-item-1')).toBeInTheDocument();

      // Escape cancels without a store call.
      fireEvent.click(screen.getByTestId('live-wallet-rename-0'));
      fireEvent.change(screen.getByTestId('live-wallet-rename-input-0'), { target: { value: 'Nope' } });
      fireEvent.keyDown(screen.getByTestId('live-wallet-rename-input-0'), { key: 'Escape' });
      expect(renameSpy).toHaveBeenCalledTimes(1);
      expect(screen.queryByTestId('live-wallet-rename-input-0')).toBeNull();

      // An empty name is not a rename.
      fireEvent.click(screen.getByTestId('live-wallet-rename-0'));
      fireEvent.change(screen.getByTestId('live-wallet-rename-input-0'), { target: { value: '   ' } });
      fireEvent.click(screen.getByTestId('live-wallet-rename-save-0'));
      expect(renameSpy).toHaveBeenCalledTimes(1);
    } finally {
      storeMod.useLiveStore.setState({ renameWallet: realRename });
    }
  }, 30_000);

  it('groups the accounts under their seed and offers the account actions', async () => {
    await importEvm();
    setWallets(
      [
        evmAccount({ id: 'a1', name: 'My EVM', hdIndex: 0, address: ADDR_1, active: true }),
        evmAccount({ id: 'a2', name: 'Account 2', hdIndex: 1, address: ADDR_2 }),
        UTXO_WALLET,
      ],
      'a1',
    );

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));

    // The group heading names the seed (the lowest-index member's name) once.
    const heading = screen.getByTestId('live-wallet-group-0');
    expect(heading).toHaveTextContent('My EVM');
    expect(heading).toHaveTextContent('Seed');

    // One row per account, in hdIndex order, each with its OWN short address.
    // The first account reads "Account 1" under the group title (its stored
    // name IS the title, so printing it twice would say nothing).
    expect(screen.getByTestId('live-wallet-item-0')).toHaveTextContent('Account 1');
    expect(screen.getByTestId('live-wallet-item-0')).not.toHaveTextContent('My EVM');
    expect(screen.getByTestId('live-account-address-0')).toHaveTextContent('0x9858…da94');
    expect(screen.getByTestId('live-wallet-item-1')).toHaveTextContent('Account 2');
    expect(screen.getByTestId('live-account-address-1')).toHaveTextContent('0x6Fac…b9C0');
    // The non-active account keeps its delete affordance; the active one has none.
    expect(screen.queryByTestId('live-wallet-delete-1')).not.toBeNull();
    expect(screen.queryByTestId('live-wallet-delete-0')).toBeNull();

    // Both account actions hang off the ACTIVE group. "Add wallet" (a different
    // seed or key) stays alongside them.
    expect(screen.queryByTestId('live-add-account')).not.toBeNull();
    expect(screen.queryByTestId('live-discover-accounts')).not.toBeNull();
    expect(screen.queryByTestId('live-add-wallet')).not.toBeNull();

    // The switcher is chain-scoped (unchanged by grouping): the Evrmore wallet
    // belongs to the chain switcher's list, not this one, so it is not a row here.
    expect(screen.queryByTestId('live-wallet-item-2')).toBeNull();
  }, 30_000);

  it('offers no account actions when the active wallet is a private-key wallet', async () => {
    await importEvm();
    setWallets(
      [
        evmAccount({
          id: 'pk1',
          name: 'Satori key',
          kind: 'pk',
          hdIndex: undefined,
          seedGroup: undefined,
          active: true,
        }),
      ],
      'pk1',
    );

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));

    expect(screen.queryByTestId('live-wallet-item-0')).not.toBeNull();
    expect(screen.queryByTestId('live-wallet-group-0')).toBeNull();
    expect(screen.queryByTestId('live-add-account')).toBeNull();
    expect(screen.queryByTestId('live-discover-accounts')).toBeNull();
  }, 30_000);

  it('offers no account actions on a UTXO wallet', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My Evrmore', 'mainnet');
    await state().loadWallets();

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));

    expect(screen.queryByTestId('live-wallet-item-0')).not.toBeNull();
    expect(screen.queryByTestId('live-wallet-group-0')).toBeNull();
    expect(screen.queryByTestId('live-add-account')).toBeNull();
    expect(screen.queryByTestId('live-discover-accounts')).toBeNull();
  }, 30_000);

  it('"Add account" calls the store action and closes the switcher', async () => {
    await importEvm();
    setWallets([evmAccount({ id: 'a1', name: 'My EVM', active: true })], 'a1');
    const addEvmAccount = vi.fn(async () => ({ ok: true as const, id: 'a2' }));
    storeMod.useLiveStore.setState({ addEvmAccount });

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));
    fireEvent.click(screen.getByTestId('live-add-account'));

    await waitFor(() => expect(addEvmAccount).toHaveBeenCalledTimes(1));
    // The new account is already active (same seed, no re-unlock), so the popover
    // has nothing left to say and closes onto the Home showing it.
    await waitFor(() => expect(screen.queryByTestId('live-add-account')).toBeNull());
  }, 30_000);

  it('"Add account" shows the store error inline and keeps the switcher open', async () => {
    await importEvm();
    setWallets([evmAccount({ id: 'a1', name: 'My EVM', active: true })], 'a1');
    storeMod.useLiveStore.setState({
      addEvmAccount: vi.fn(async () => ({ ok: false as const, error: 'not implemented' })),
    });

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));
    fireEvent.click(screen.getByTestId('live-add-account'));

    await waitFor(() =>
      expect(screen.getByTestId('live-add-account-error')).toHaveTextContent('not implemented'),
    );
    expect(screen.queryByTestId('live-add-account')).not.toBeNull();
  }, 30_000);

  it('"Discover accounts" says so in the picker when the seed has no other used accounts', async () => {
    await importEvm();
    setWallets([evmAccount({ id: 'a1', name: 'My EVM', active: true })], 'a1');
    const discoverEvmAccounts = vi.fn(async () => ({ ok: true, added: 0 }));
    storeMod.useLiveStore.setState({ discoverEvmAccounts });

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));
    fireEvent.click(screen.getByTestId('live-discover-accounts'));

    await waitFor(() => expect(discoverEvmAccounts).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.getByTestId('live-discover-note')).toHaveTextContent(
        'No other used accounts found on this seed.',
      ),
    );
    // A failed check is not a Home-level event either: nothing pops up behind it.
    expect(screen.queryByTestId('live-accounts-found')).toBeNull();
  }, 30_000);

  it('announces a discovery on Home and dismisses it', async () => {
    await importEvm();
    setWallets([evmAccount({ id: 'a1', name: 'My EVM', active: true })], 'a1');

    renderHome();
    expect(screen.queryByTestId('live-accounts-found')).toBeNull();

    storeMod.useLiveStore.setState({ evmAccountScan: { scanning: false, added: 2, error: null } });
    await waitFor(() =>
      expect(screen.getByTestId('live-accounts-found')).toHaveTextContent(
        'Found 2 more accounts on this seed. They are in the wallet switcher.',
      ),
    );

    fireEvent.click(screen.getByTestId('live-accounts-found-dismiss'));
    await waitFor(() => expect(screen.queryByTestId('live-accounts-found')).toBeNull());
    expect(state().evmAccountScan.added).toBeNull();
  }, 30_000);

  it('does not announce a scan that found nothing', async () => {
    await importEvm();
    setWallets([evmAccount({ id: 'a1', name: 'My EVM', active: true })], 'a1');

    renderHome();
    storeMod.useLiveStore.setState({
      evmAccountScan: { scanning: false, added: 0, error: 'network unreachable' },
    });

    await waitFor(() => expect(screen.queryByTestId('live-accounts-found')).toBeNull());
  }, 30_000);

  it('removing an account of a shared seed says the seed stays, not that access is lost', async () => {
    await importEvm();
    setWallets(
      [
        evmAccount({ id: 'a1', name: 'My EVM', hdIndex: 0, address: ADDR_1, active: true }),
        evmAccount({ id: 'a2', name: 'Account 2', hdIndex: 1, address: ADDR_2 }),
      ],
      'a1',
    );

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));
    fireEvent.click(screen.getByTestId('live-wallet-delete-1'));

    const dialog = await screen.findByText(/Removes Account 2 only/);
    expect(dialog).toHaveTextContent(
      'Removes Account 2 only. The seed stays in its other account and the same recovery phrase restores this account again.',
    );
    expect(screen.queryByText(/you will lose access/i)).toBeNull();
  }, 30_000);

  it('other seeds with several accounts are folded to one row ("N accounts"); the chevron unfolds; the active seed stays open; search past 8 rows filters by name or address', async () => {
    await importEvm();
    const other = ADDR_2.toLowerCase();
    const manyOther = Array.from({ length: 8 }, (_, k) =>
      evmAccount({
        id: `b${k + 1}`,
        name: k === 0 ? 'Other seed' : `Account ${k + 1}`,
        hdIndex: k,
        address: `0x${(k + 1).toString(16).padStart(4, '0')}${ADDR_2.slice(6)}`,
        seedGroup: other,
      }),
    );
    setWallets(
      [
        evmAccount({ id: 'a1', name: 'My EVM', hdIndex: 0, address: ADDR_1, active: true }),
        evmAccount({ id: 'a2', name: 'Account 2', hdIndex: 1, address: ADDR_2 }),
        ...manyOther,
      ],
      'a1',
    );

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));
    // Active seed open: both of its accounts are rows.
    expect(screen.getByTestId('live-wallet-item-0')).toBeInTheDocument();
    expect(screen.getByTestId('live-wallet-item-1')).toBeInTheDocument();
    // The other seed: one folded header with the count, no account rows.
    expect(screen.getByTestId('live-wallet-group-count-1')).toHaveTextContent('8 accounts');
    expect(screen.queryByTestId('live-wallet-item-2')).toBeNull();
    fireEvent.click(screen.getByTestId('live-wallet-group-1'));
    expect(screen.getByTestId('live-wallet-item-2')).toHaveTextContent('Account 1');
    expect(screen.getByTestId('live-wallet-item-9')).toHaveTextContent('Account 8');
    fireEvent.click(screen.getByTestId('live-wallet-group-1'));
    expect(screen.queryByTestId('live-wallet-item-2')).toBeNull();
    // Folding the active seed works too (and its actions fold with it).
    fireEvent.click(screen.getByTestId('live-wallet-group-0'));
    expect(screen.queryByTestId('live-wallet-item-0')).toBeNull();
    expect(screen.queryByTestId('live-add-account')).toBeNull();
    fireEvent.click(screen.getByTestId('live-wallet-group-0'));
    expect(screen.getByTestId('live-add-account')).toBeInTheDocument();
    // 10 rows > 8: the search box is there; it ignores folding and matches addresses.
    const search = screen.getByTestId('live-wallet-search');
    fireEvent.change(search, { target: { value: 'account 7' } });
    expect(screen.getByTestId('live-wallet-item-8')).toHaveTextContent('Account 7');
    expect(screen.queryByTestId('live-wallet-item-0')).toBeNull();
    expect(screen.queryByTestId('live-wallet-group-0')).toBeNull();
    fireEvent.change(search, { target: { value: ADDR_1.slice(2, 8) } });
    expect(screen.getByTestId('live-wallet-item-0')).toBeInTheDocument();
    expect(screen.queryByTestId('live-wallet-item-8')).toBeNull();
  }, 30_000);

  it('no search box below 8 rows', async () => {
    await importEvm();
    setWallets([evmAccount({ id: 'a1', name: 'My EVM', hdIndex: 0, address: ADDR_1, active: true }), UTXO_WALLET], 'a1');
    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));
    expect(screen.queryByTestId('live-wallet-search')).toBeNull();
  }, 30_000);

  it('removing the LAST account of a seed keeps the backup warning', async () => {
    await importEvm();
    setWallets(
      [
        evmAccount({ id: 'a1', name: 'My EVM', hdIndex: 0, address: ADDR_1, active: true }),
        evmAccount({ id: 'b1', name: 'Other seed', address: ADDR_2, seedGroup: ADDR_2.toLowerCase() }),
      ],
      'a1',
    );

    renderHome();
    fireEvent.click(screen.getByTestId('live-wallet-switcher'));
    fireEvent.click(screen.getByTestId('live-wallet-delete-1'));

    expect(await screen.findByText(/you will lose access/i)).toBeTruthy();
  }, 30_000);
});

describe('LiveHome with a UTXO active wallet renders as before', () => {
  it('keeps the chain homepage link and Add token for Evrmore (not young, has an asset protocol)', async () => {
    await state().importWallet(VECTOR_MNEMONIC, PW, 'My Evrmore', 'mainnet');
    await state().loadWallets();
    expect(state().wallets[0]?.family).toBe('utxo');

    renderHome();

    expect(screen.getByTestId('live-chain-switcher')).toHaveTextContent('Evrmore');
    expect(screen.getByText(/EVR Balance/)).toBeTruthy();
    expect(screen.queryByTestId('live-young-chain-notice')).toBeNull();
    expect(screen.getByTestId('live-chain-homepage')).toBeTruthy();
    expect(screen.getByTestId('live-add-asset')).toBeTruthy();
  }, 30_000);
});
