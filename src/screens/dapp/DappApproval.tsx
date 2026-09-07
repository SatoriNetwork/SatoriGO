// dApp approval window — the EXPLICIT user gate for every site connection and
// every send requested through `window.evrmore`.
//
// Opened by the background worker as index.html?dapp=<id> (App.tsx routes here
// before any other boot). Reads the pending request from chrome.storage.session
// and the PUBLIC wallet info (name/address/passwordless — never the vault) from
// the `liveWallets` record. For sends it unlocks/builds/signs/broadcasts with
// its OWN LiveWalletService instance, entirely inside this extension page —
// keys never reach the background worker, the content script or the page.
// The outcome goes back as {type:'evr-dapp-approve-result'} and the window closes.
//
// HOSTED MODE: when a wallet window is already open (side panel, toolbar popup,
// detached window) the worker asks that window to show the request instead of
// opening a popup on top of it; App.tsx then renders this component as an
// overlay with `hosted` set. Same gate, same messages; only "close the window"
// becomes "tell the host to drop the overlay".

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Globe, SendHorizonal, ShieldCheck } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/TextField';
import { getStorage } from '../../services/storage';
import { LiveWalletService, type LiveSendPlan, type LiveNetworkId } from '../../services/chain/liveWallet';
import { createElectrumClient, ELECTRUM_CLOSED, ELECTRUM_NOT_CONNECTED } from '../../services/chain/electrumClient';
import { applyAllStoredElectrumServers } from '../../services/chain/network';
import { isSpendableAddress } from '../../services/chain/keys';
import { toBaseUnits, formatAmount } from '../../services/chain/amounts';
import { displaySymbol } from '../../services/displaySymbol';
import { networkFor } from '../../services/chain/chainParams';
import type { NativeTicker } from '../../services/chain/chainParams';

/** Base units -> display text at the chain's own scale. Exact: the digits come
 *  from the bigint, not from a division through a double. */
function fmtSats(sats: bigint, decimals: number): string {
  return formatAmount(sats, decimals, { grouping: true });
}

const PENDING_PREFIX = 'dappPending:';

interface PendingDappRequest {
  id: string;
  tabId: number;
  origin: string;
  method: string;
  params?: { to?: unknown; amount?: unknown; asset?: unknown; message?: unknown };
  /** Set by the worker. For sign/send: the wallet this origin is CONNECTED to;
   *  the page acts on that wallet, not on whichever one the wallet UI shows.
   *  For connect: the currently connected wallet, preselected in the picker. */
  walletId?: string;
}

interface PublicWalletInfo {
  id: string;
  name: string;
  address: string;
  passwordless: boolean;
  /** True when this wallet's vault is app-key protected (VaultRecord v2). Read
   *  from the record's VERSION, never from a secret. The password this page then
   *  needs is the APP password, and a formerly-passwordless wallet needs one
   *  again: nothing here holds the master key, so it must be derived from what
   *  the user types (the app-password design notes §6). */
  appProtected: boolean;
  /** Chain id ('mainnet'|'testnet'|'ravencoin-mainnet'); drives every chain-aware
   *  label below (fee unit, chain name in copy). Defaults to 'mainnet' (Evrmore)
   *  for a legacy entry with no stored network. */
  network: string;
}

/** Public subset of the persisted `liveWallets` record (no vault is read). */
interface PublicWalletsRecord {
  wallets: {
    id: string;
    name?: string;
    address?: string;
    passwordless?: boolean;
    network?: string;
    /** Chain family; absent means 'utxo'. An EVM account never signs for `window.evrmore`. */
    family?: string;
    /** Version only. The vault's ciphertext is never read on this page. */
    vault?: { version?: number };
  }[];
  activeId: string;
  /** PRESENCE ONLY: is an app password configured on this device? It holds no
   *  key material (a salt, KDF params and a check blob), and nothing here reads
   *  inside it. See the setup-required refusal below. */
  appKey?: unknown;
}

/**
 * IS THE FORCED APP-PASSWORD SETUP OWED (the app-password design notes §12)?
 *
 * The same question LiveWalletService.appPasswordRequired() asks, asked here of
 * the raw record because this page deliberately boots without the wallet store.
 * The two must agree, which is why it is the same two conditions and the same
 * damaged-state clause.
 */
function setupRequired(record: PublicWalletsRecord | null | undefined): boolean {
  const wallets = record?.wallets;
  if (!Array.isArray(wallets) || wallets.length === 0) return false;
  if (record?.appKey) return false;
  if (wallets.some((w) => w.vault?.version === 2)) return false;
  return wallets.some((w) => w.passwordless === true);
}

type PublicWalletRecordEntry = PublicWalletsRecord['wallets'][number];

/**
 * `window.evrmore` is an EVRMORE provider, so the only wallets a site may be
 * offered are Evrmore-mainnet ones. Every chain is its own entry ("Wallet 1
 * (Bitcoin)" beside "Wallet 1"), so this is a filter, not a chain switch. Before
 * this gate, whichever chain happened to be active was handed out, and a site
 * that got a Bitcoin address from an Evrmore provider called it "could not
 * reach the wallet" (satorisignals.app, 2026-09-04). Same predicate as the
 * worker's isEvrmoreEntry.
 */
function isEvrmoreWallet(w: PublicWalletRecordEntry): boolean {
  return (w.family ?? 'utxo') === 'utxo' && (w.network ?? 'mainnet') === 'mainnet';
}

function toWalletInfo(w: PublicWalletRecordEntry): PublicWalletInfo {
  return {
    id: w.id,
    name: w.name || 'Wallet',
    address: w.address || '',
    passwordless: w.passwordless ?? false,
    appProtected: w.vault?.version === 2,
    network: w.network || 'mainnet',
  };
}

/** What to hand LiveWalletService.unlock() for this wallet: the empty passphrase
 *  for a still-v1 passwordless wallet, and otherwise whatever the user typed
 *  (its own password on v1, the app password on v2). */
function walletUnlockSecret(wallet: PublicWalletInfo | null, typed: string): string {
  return wallet?.passwordless && !wallet.appProtected ? '' : typed;
}

function shortAddress(addr: string): string {
  return addr.length > 20 ? `${addr.slice(0, 10)}…${addr.slice(-8)}` : addr;
}

/** Map raw build/broadcast error codes to human messages (mirrors LiveSend).
 *  `native` is the connected wallet's chain ticker and `chainName` its display
 *  name, both from the chain params, so a message never names the wrong chain. */
function friendlyError(msg: string, rawAssetName: string, native: NativeTicker, chainName: string): string {
  // The asset name in these sentences came from the WEBSITE, so it is drawn
  // through the display sanitiser: this is the wallet's voice, and a page must
  // not be able to put a check mark or a text-direction override into it.
  const assetName = displaySymbol(rawAssetName);
  switch (msg) {
    case 'insufficient-funds':
      return `Insufficient ${native} balance for this transaction (amount + network fee).`;
    case 'insufficient-asset':
      return `Insufficient ${assetName} balance for this transfer.`;
    case 'insufficient-evr-for-fee':
      return `Not enough ${native} to cover the network fee for this asset transfer.`;
    case 'invalid-amount-precision':
      return `That amount is finer than ${assetName} allows. Reduce the number of decimals.`;
    case 'unknown-asset':
      return `Asset "${assetName}" was not found on the ${chainName} network.`;
    case 'invalid-amount':
      return 'Enter a valid amount greater than 0.';
    case 'unsupported-address-type':
      return `That recipient is not a standard ${chainName} address. Script and wrong-network addresses are rejected.`;
    case 'input-verify-failed':
    case 'input-value-mismatch':
      return 'Could not verify your coins against the network (the server may be faulty or malicious). Nothing was sent. Try another Electrum server in Settings.';
    case 'broadcast-unconfirmed':
      return 'The server had a problem and the transaction could not be confirmed as sent. Nothing appears on the network. It is safe to try again.';
    case ELECTRUM_NOT_CONNECTED:
    case ELECTRUM_CLOSED:
      // The approval window opens its own client, so an approval arriving before
      // that socket is up hits this. Nothing was built and nothing was sent.
      return `Still connecting to the ${chainName} network. Wait a moment and try again.`;
    default:
      return msg;
  }
}

/**
 * What a HOSTING wallet page lends the approval: its own wallet service and
 * whether the user has unlocked it there. With the wallet unlocked and showing
 * the very wallet the site is connected to, a sign request is answered with
 * that unlocked service and asks for no password (the user just typed it to
 * unlock), and a send follows the wallet's own send-screen rule. With the
 * wallet locked, the approval waits behind the lock screen (a strip says a
 * site is waiting) instead of putting a second password box over it. Absent
 * in the popup window, which has no unlocked service to lend.
 */
export interface DappHostSession {
  service: LiveWalletService;
  unlocked: boolean;
  activeWalletId: string | null;
  /** The wallet's own send rule: verify the password before broadcasting. */
  sendNeedsPassword: boolean;
  verifyPassword(password: string): Promise<boolean>;
}

export interface DappApprovalProps {
  requestId: string;
  /** Rendered inside an already-open wallet window (see the header comment).
   *  Settling then calls onDone instead of closing the window. */
  hosted?: boolean;
  onDone?: () => void;
  session?: DappHostSession;
}

export function DappApproval({ requestId, hosted = false, onDone, session }: DappApprovalProps) {
  const [pending, setPending] = useState<PendingDappRequest | null>(null);
  /** The wallet this request acts on: for connect, the one the user picked
   *  (preselected below); for sign/send, the one the origin is connected to. */
  const [wallet, setWallet] = useState<PublicWalletInfo | null>(null);
  /** Evrmore wallets the user may connect (connect requests only). */
  const [choices, setChoices] = useState<PublicWalletInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  /** True when the wallet UI is currently BLOCKED on the forced app-password
   *  setup. This window then decides nothing; see the refusal below. */
  const [needsSetup, setNeedsSetup] = useState(false);
  const [password, setPassword] = useState('');
  const [actionError, setActionError] = useState('');
  const [working, setWorking] = useState(false);
  // A built+reviewed send: the plan (with its REAL fee) plus the still-unlocked
  // service that will broadcast it. Holding this lets us show the fee/total
  // BEFORE the user commits to broadcasting.
  // `owned`: the service was built here for this request and must be locked
  // and its client closed when done; a service lent by the hosting page is not.
  const [review, setReview] = useState<{
    plan: LiveSendPlan;
    service: LiveWalletService;
    client: { close(): void } | null;
    owned: boolean;
  } | null>(null);
  const settled = useRef(false);
  // Mirror `review` into a ref so the pagehide handler can zero the unlocked
  // service if the window is closed via the OS mid-review (defense-in-depth).
  const reviewRef = useRef(review);
  useEffect(() => {
    reviewRef.current = review;
  }, [review]);

  // Load the pending request (session storage) + public wallet info.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // This window boots WITHOUT the main app's store init (App.tsx routes
        // here before LiveApp), so nothing has loaded the user's configured
        // Electrum pools into this page yet. Without this, build/verify/
        // broadcast below would silently use the built-in default servers even
        // when the user pinned their own trusted server in Settings. Awaited
        // inside the loader (which gates the buttons), so it always completes
        // before any client.connect() can happen. Never throws (best-effort
        // internally), and applies every chain so it matches whatever chain
        // the active wallet turns out to be on.
        await applyAllStoredElectrumServers();
        const key = PENDING_PREFIX + requestId;
        const found = await chrome.storage.session.get(key);
        const req = found[key] as PendingDappRequest | undefined;
        const record = await getStorage().get<PublicWalletsRecord>('liveWallets');
        const wallets = Array.isArray(record?.wallets) ? record.wallets : [];
        const evrmore = wallets.filter(isEvrmoreWallet);
        if (cancelled) return;
        if (!req) {
          setLoadError('This request has expired or was already handled.');
        } else {
          setPending(req);
        }
        setNeedsSetup(setupRequired(record));
        setChoices(evrmore.map(toWalletInfo));
        if (req && req.method !== 'connect' && req.walletId) {
          // Sign/send: the connected wallet, and nothing else. A binding to a
          // wallet that is gone leaves this null, and the buttons stay disabled.
          const bound = wallets.find((w) => w.id === req.walletId && isEvrmoreWallet(w));
          setWallet(bound ? toWalletInfo(bound) : null);
        } else {
          // Connect: preselect the wallet the site is already connected to
          // (a re-connect to switch wallets), else the active wallet when it
          // is an Evrmore one, else the first Evrmore wallet there is.
          const preselected =
            evrmore.find((w) => w.id === req?.walletId) ??
            evrmore.find((w) => w.id === record?.activeId) ??
            evrmore[0];
          setWallet(preselected ? toWalletInfo(preselected) : null);
        }
      } catch {
        if (!cancelled) setLoadError('Could not load the request.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [requestId]);

  /** Leave: close this window, or hand the frame back to the hosting wallet. */
  const leave = useCallback(() => {
    if (hosted) onDone?.();
    else window.close();
  }, [hosted, onDone]);

  /** Send the terminal outcome to the worker exactly once, then leave. */
  const settle = useCallback(
    async (payload: { result?: unknown; error?: string; approveOrigin?: string; walletId?: string }) => {
      if (settled.current) return;
      settled.current = true;
      try {
        await chrome.runtime.sendMessage({
          type: 'evr-dapp-approve-result',
          id: requestId,
          ...payload,
        });
      } catch {
        // worker unreachable — still leave; the page's request will simply hang
      }
      leave();
    },
    [requestId, leave],
  );

  // Closing the window without deciding counts as a rejection.
  useEffect(() => {
    const onPageHide = () => {
      // Zero any unlocked in-memory secret before the window is torn down.
      // lockApp(), not lock(): this page may have derived the app MASTER KEY
      // from the password the user typed (an app-key wallet has no password of
      // its own), and that key is a secret of exactly the same class as the
      // seed. lock() zeroes the seed alone, because a wallet SWITCH must keep
      // the master key; a page teardown must not.
      if (reviewRef.current?.owned) {
        reviewRef.current.service.lockApp();
        reviewRef.current.client?.close();
      }
      if (settled.current) return;
      settled.current = true;
      try {
        void chrome.runtime.sendMessage({
          type: 'evr-dapp-approve-result',
          id: requestId,
          error: 'user-rejected',
        });
      } catch {
        // best-effort
      }
    };
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [requestId]);

  // Hold a port open for as long as this request is on screen. The worker
  // treats the port going away with the request still undecided as "the user
  // closed the wallet": it rejects the request to the site, so the site can
  // ask again instead of waiting on a prompt nobody can see (pagehide alone
  // did not reliably get that message out of a closing window).
  useEffect(() => {
    const rt = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
    if (typeof rt?.connect !== 'function') return;
    const name = `evr-dapp-approval:${requestId}`;
    let open = true;
    let port: chrome.runtime.Port | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      if (!open) return;
      try {
        port = rt.connect({ name });
        // The worker was restarted (or is not up yet): reconnect so it keeps
        // watching this page. Settled pages stop reconnecting on unmount.
        port.onDisconnect.addListener(() => {
          port = null;
          if (open) retry = setTimeout(connect, 500);
        });
      } catch {
        if (open) retry = setTimeout(connect, 500);
      }
    };
    connect();
    return () => {
      open = false;
      if (retry) clearTimeout(retry);
      try {
        port?.disconnect();
      } catch {
        // already gone
      }
    };
  }, [requestId]);

  // The worker asks "is this request still on screen?" before it lets the same
  // site open another approval (see approvalStillShown in the worker). Answer
  // while undecided; once settled, stay silent so the request can be replaced.
  useEffect(() => {
    const rt = typeof chrome !== 'undefined' ? chrome.runtime : undefined;
    if (!rt?.onMessage?.addListener) return;
    const onMessage = (
      message: unknown,
      _sender: chrome.runtime.MessageSender,
      sendResponse: (r?: unknown) => void,
    ): boolean | undefined => {
      const msg = message as { type?: string; id?: string } | null;
      if (msg?.type !== 'evr-dapp-ping' || msg.id !== requestId) return undefined;
      if (!settled.current) sendResponse({ alive: true });
      return undefined;
    };
    rt.onMessage.addListener(onMessage);
    return () => rt.onMessage.removeListener(onMessage);
  }, [requestId]);

  const reject = () => {
    if (review?.owned) {
      review.service.lockApp();
      review.client?.close();
    }
    void settle({ error: 'user-rejected' });
  };

  /** The hosting page's unlocked service, when it is showing the very wallet
   *  this request is for. Anything else takes the fresh-service path below. */
  const shared = hosted && session && session.unlocked && wallet && session.activeWalletId === wallet.id ? session : null;

  const approveConnect = () => {
    if (!wallet?.address || !pending) return;
    // The worker validates walletId against the Evrmore wallets that exist
    // before it binds the origin; this page proposes, it does not decide.
    void settle({ result: { address: wallet.address }, approveOrigin: pending.origin, walletId: wallet.id });
  };

  // Step 1: unlock -> build+sign (NO broadcast). Surfaces the REAL fee so the
  // user sees exactly what will be spent before committing. The unlocked service
  // is held (in `review`) for the confirm step. All inside THIS extension page.
  const reviewSend = async () => {
    if (!pending || working) return;
    setActionError('');
    const to = typeof pending.params?.to === 'string' ? pending.params.to.trim() : '';
    const amount = Number(pending.params?.amount);
    const assetName =
      pending.method === 'sendAsset' && typeof pending.params?.asset === 'string'
        ? pending.params.asset.trim().toUpperCase()
        : '';
    if (!to || !Number.isFinite(amount) || amount <= 0) {
      setActionError('The site sent an invalid recipient or amount.');
      return;
    }
    if (pending.method === 'sendAsset' && !assetName) {
      setActionError('The site sent an invalid asset name.');
      return;
    }
    setWorking(true);
    if (shared) {
      // The page's own unlocked wallet builds it; the password, if the wallet's
      // send rule wants one, is asked at confirm like the wallet's own send.
      const service = shared.service;
      try {
        const net = networkFor(service.network());
        if (!isSpendableAddress(to, net)) {
          setActionError(
            `The site sent an unsupported ${net.displayName} address. Only standard addresses this wallet can pay to are accepted.`,
          );
          return;
        }
        const amountSats = toBaseUnits(amount, net.decimals);
        const plan =
          pending.method === 'sendAsset'
            ? await service.buildAssetSend(to, assetName, amountSats)
            : await service.buildEvrSend(to, amountSats);
        setReview({ plan, service, client: null, owned: false });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        setActionError(friendlyError(raw, assetName || walletNativeTicker, networkFor(service.network()).ticker, networkFor(service.network()).displayName));
      } finally {
        setWorking(false);
      }
      return;
    }
    const client = createElectrumClient();
    const service = new LiveWalletService(client);
    // Unlock and build for the CONNECTED wallet, whatever the wallet UI shows.
    // adoptWallet is session-local: it does not move the store's active wallet.
    if (wallet) service.adoptWallet(wallet.id);
    let unlocked = false;
    try {
      const ok = await service.unlock(walletUnlockSecret(wallet, password));
      if (!ok) {
        setActionError('Incorrect password.');
        return;
      }
      unlocked = true;
      // Reject a malformed / wrong-network / wrong-type (e.g. P2SH) recipient
      // before building an output the recipient could not spend. Accepts what
      // the builder can actually pay to on this chain: P2PKH everywhere, plus
      // native segwit where the chain supports it.
      const net = networkFor(service.network());
      if (!isSpendableAddress(to, net)) {
        setActionError(
          `The site sent an unsupported ${net.displayName} address. Only standard addresses this wallet can pay to are accepted.`,
        );
        return;
      }
      await client.connect();
      // Shared with the wallet's own send path (services/chain/amounts):
      // a bare Math.round here silently produced the WRONG base-unit count
      // above 2^53, on the one path where the amount comes from a website.
      const amountSats = toBaseUnits(amount, net.decimals);
      const plan =
        pending.method === 'sendAsset'
          ? await service.buildAssetSend(to, assetName, amountSats)
          : await service.buildEvrSend(to, amountSats);
      // Keep the unlocked service + client alive for the confirm step.
      setReview({ plan, service, client, owned: true });
      unlocked = false; // ownership transferred to `review`
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setActionError(friendlyError(raw, assetName || walletNativeTicker, networkFor(service.network()).ticker, networkFor(service.network()).displayName));
    } finally {
      if (unlocked) {
        service.lockApp();
        client.close();
      }
      setWorking(false);
    }
  };

  // Step 2: broadcast the reviewed plan (fee already shown + agreed).
  const confirmSend = async () => {
    if (!review || working) return;
    setActionError('');
    setWorking(true);
    if (!review.owned && shared?.sendNeedsPassword) {
      // The wallet's own send rule, applied at the same moment its send screen
      // applies it: verified before anything is broadcast.
      if (!(await shared.verifyPassword(password))) {
        setActionError('Incorrect password.');
        setWorking(false);
        return;
      }
    }
    try {
      review.service.allowBroadcast = true;
      const txid = await review.service.broadcast(review.plan.built.rawHex, review.plan.built.txid);
      await settle({ result: { txid } });
    } catch (err) {
      const raw = err instanceof Error ? err.message : String(err);
      setActionError(friendlyError(raw, review.plan.assetName || walletNativeTicker, walletNativeTicker, walletChainName));
    } finally {
      if (review.owned) {
        review.service.lockApp();
        review.client?.close();
      }
      setReview(null);
      setWorking(false);
    }
  };

  // Sign an arbitrary message with the active wallet's primary key. Pure local
  // crypto — no network, no broadcast. Keys stay inside this extension page; only
  // { address, signature } goes back to the site. Password-gated unless the
  // wallet is passwordless.
  const approveSign = async () => {
    if (!pending || working) return;
    setActionError('');
    const message = typeof pending.params?.message === 'string' ? pending.params.message : null;
    if (message === null) {
      setActionError('The site sent an invalid message to sign.');
      return;
    }
    setWorking(true);
    if (shared) {
      // Already unlocked by the user in this very window: sign, no password.
      try {
        await settle({ result: shared.service.signMessage(message) });
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err));
      } finally {
        setWorking(false);
      }
      return;
    }
    const client = createElectrumClient();
    const service = new LiveWalletService(client);
    // Sign with the CONNECTED wallet's key (see reviewSend).
    if (wallet) service.adoptWallet(wallet.id);
    try {
      const ok = await service.unlock(walletUnlockSecret(wallet, password));
      if (!ok) {
        setActionError('Incorrect password.');
        return;
      }
      const signed = service.signMessage(message);
      await settle({ result: signed });
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      // lockApp(): this service is finished with, and it may hold the app master
      // key it derived from the typed password as well as the signing key.
      service.lockApp();
      client.close();
      setWorking(false);
    }
  };

  /** Hosted: a full-window overlay above the wallet (its state and its
   *  connections stay where they are). In the popup window: the page itself. */
  const frame = (children: ReactNode): ReactNode =>
    hosted ? (
      <div
        data-testid="dapp-host-overlay"
        data-request-id={requestId}
        style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'var(--bg)', overflow: 'auto' }}
      >
        {children}
      </div>
    ) : (
      children
    );

  if (loading) {
    return frame(
      <div className="app-frame">
        <div className="result-screen">
          <span className="spinner lg" style={{ color: 'var(--accent)' }} />
        </div>
      </div>,
    );
  }

  if (!pending || loadError) {
    return frame(
      <div className="app-frame" data-testid="dapp-approval">
        <div className="app-content">
          <div className="banner danger" style={{ marginTop: 16 }} data-testid="dapp-error">
            {loadError || 'This request has expired or was already handled.'}
          </div>
          <Button block variant="secondary" style={{ marginTop: 14 }} onClick={leave}>
            Close
          </Button>
        </div>
      </div>,
    );
  }

  // THE FORCED APP-PASSWORD SETUP, SEEN FROM THE ONE WINDOW THAT IS NOT THE APP
  // (the app-password design notes §12).
  //
  // This page is opened by the worker for ONE pending site request and bypasses
  // LiveApp entirely, so the blocking setup screen the rest of the wallet is
  // showing never reaches it. That is deliberate on both counts: a setup screen
  // HERE would be a password field in a window a website caused to open, which
  // is the exact shape of a phishing prompt, and it would ask for the password
  // that protects every wallet on the device in the least trustworthy frame the
  // wallet has. So this window sets nothing up.
  //
  // WHAT IT DOES INSTEAD IS REFUSE, and say why. Approving would be the route
  // around the screen: the active wallet in this state can be one whose vault
  // opens under the EMPTY passphrase, so a send would be built, signed and
  // broadcast with NOTHING typed by anyone, from a window a page asked for,
  // while the wallet's own UI is refusing to open at all. Failing closed is the
  // house rule for the send path, and this is the send path.
  //
  // IT IS THE SAME PREDICATE AS THE SCREEN, device-wide, not "is the active
  // wallet the passwordless one". One condition means there is no combination
  // where one surface demands a password and another spends without one, and the
  // cost of the wider rule is only that a user who is already being asked to set
  // a password at every launch is asked to do it before a site can be answered.
  // A refusal cannot lose money; a wrong approval can.
  if (needsSetup) {
    return frame(
      <div className="app-frame" data-testid="dapp-approval">
        <div className="app-content">
          <div className="banner warning" style={{ marginTop: 16, alignItems: 'flex-start' }} data-testid="dapp-setup-required">
            <span>
              Satori GO needs an app password before it can answer this site. Open the extension,
              set one, and try again from the site. Nothing was approved and nothing was sent.
            </span>
          </div>
          <Button
            block
            variant="secondary"
            style={{ marginTop: 14 }}
            data-testid="dapp-reject"
            onClick={() => void settle({ error: 'wallet-setup-required' })}
          >
            Close
          </Button>
        </div>
      </div>,
    );
  }

  // The connected wallet's chain ticker: drives every chain-aware label below
  // (fee unit, "sending X" wording, default asset name for a native send).
  const walletNet = networkFor((wallet?.network as LiveNetworkId | undefined) ?? 'mainnet');
  const walletNativeTicker = walletNet.ticker;
  // Chain NAME from params, never a two-chain ternary: those mislabelled every
  // chain added after Ravencoin (a Bitcoin send announced the EVRmore network).
  const walletChainName = walletNet.displayName;

  const isSend = pending.method === 'sendEvr' || pending.method === 'sendAsset';
  const isSign = pending.method === 'signMessage';
  const signMessageText = typeof pending.params?.message === 'string' ? pending.params.message : '';
  // DISPLAY only. The name the SITE asked to send is drawn on the one screen
  // that stands between a page and real money, so it is sanitised here; the
  // send itself is built from `pending.params.asset` at :224, untouched.
  const sendAssetName = displaySymbol(
    pending.method === 'sendAsset' && typeof pending.params?.asset === 'string'
      ? pending.params.asset.trim().toUpperCase()
      : walletNativeTicker,
  );
  const sendAmount = Number(pending.params?.amount);
  const sendTo = typeof pending.params?.to === 'string' ? pending.params.to : '';
  // An app-key wallet ALWAYS asks here, even one that skips the password on the
  // wallet's own send screen: this page builds a fresh LiveWalletService that
  // holds no master key, so there is nothing to open the vault with but the app
  // password the user types. Unless the hosting page lends its unlocked one.
  const needPassword = !shared && ((wallet?.appProtected ?? false) || !(wallet?.passwordless ?? false));
  const sendPasswordBeforeReview = needPassword && !review;
  const sendPasswordAtConfirm = !!shared && shared.sendNeedsPassword && !!review;

  // WALLET LOCKED, HOSTED, KEYS NEEDED: do not put a password box over the
  // lock screen. The lock screen stays; a strip says who is waiting and why;
  // the approval appears the moment the user unlocks (the owner's flow:
  // unlock once, then sign, then back in the wallet, 2026-09-07).
  if (hosted && session && !session.unlocked && (isSign || isSend)) {
    return (
      <div
        data-testid="dapp-unlock-wait"
        data-request-id={requestId}
        role="status"
        style={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 12px',
          background: 'var(--bg)',
          borderBottom: '1px solid var(--border-strong)',
          boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
        }}
      >
        <ShieldCheck size={16} style={{ flexShrink: 0, color: 'var(--accent)' }} />
        <span style={{ flex: 1, fontSize: 12.5, lineHeight: 1.4 }}>
          <strong className="mono" style={{ wordBreak: 'break-all' }}>{pending.origin}</strong>{' '}
          asks you to {isSign ? 'sign a message' : 'confirm a transaction'}. Unlock the wallet to continue.
        </span>
        <Button variant="secondary" data-testid="dapp-reject" style={{ flexShrink: 0, padding: '6px 12px' }} onClick={reject}>
          Reject
        </Button>
      </div>
    );
  }

  return frame(
    <div className="app-frame screen-enter" data-testid="dapp-approval">
      <div className="sub-header">
        <span style={{ width: 32 }} />
        <h2 style={{ flex: 1 }}>{isSend ? 'Confirm transaction' : isSign ? 'Sign message' : 'Connect to site'}</h2>
        <span style={{ width: 32 }} />
      </div>
      {/* A flex column: the message box (sign) and the wallet picker (connect)
          are the only blocks allowed to shrink, so the password field and the
          buttons stay in view in a 400x620 popup without scrolling. */}
      <div className="app-content" style={{ display: 'flex', flexDirection: 'column' }}>
        <div className="banner info" style={{ marginBottom: 10, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <Globe size={16} style={{ flexShrink: 0 }} />
          <span className="mono" style={{ wordBreak: 'break-all' }} data-testid="dapp-origin">
            {pending.origin}
          </span>
        </div>

        {isSign && (
          <>
            <p className="text-dim" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 2px 10px', flexShrink: 0 }}>
              This site asks you to <strong>sign a message</strong> to prove you control this
              address (for example to log in). Nothing is sent and no funds move.
            </p>
            <div className="section-label" style={{ marginTop: 0, flexShrink: 0 }}>Signing wallet</div>
            <div className="card solid" style={{ marginBottom: 10, flexShrink: 0 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">{wallet?.name ?? 'Wallet'}</span>
                  <span className="sum-val mono" style={{ fontSize: 11 }} data-testid="dapp-sign-address">
                    {wallet?.address ? shortAddress(wallet.address) : 'No wallet set up'}
                  </span>
                </div>
              </div>
            </div>
            <div className="section-label" style={{ marginTop: 0, flexShrink: 0 }}>Message</div>
            <div
              className="card solid mono"
              style={{
                marginBottom: 10,
                flex: '0 1 auto',
                minHeight: 44,
                maxHeight: 160,
                overflowY: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: 12,
                lineHeight: 1.5,
              }}
              data-testid="dapp-sign-message"
            >
              {signMessageText || <span className="text-dim">(empty message)</span>}
            </div>

            {needPassword && (
              <div style={{ flexShrink: 0 }}>
                <PasswordField
                  label="Wallet password"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your wallet password"
                  autoFocus
                  testId="dapp-password"
                />
              </div>
            )}

            {actionError && (
              <div className="banner danger" style={{ margin: '10px 0 0', flexShrink: 0 }} data-testid="dapp-error" role="alert">
                {actionError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexShrink: 0 }}>
              <Button block variant="secondary" data-testid="dapp-reject" disabled={working} onClick={reject}>
                Reject
              </Button>
              <Button
                block
                loading={working}
                icon={working ? undefined : <ShieldCheck size={16} />}
                data-testid="dapp-approve"
                disabled={!wallet?.address}
                onClick={() => void approveSign()}
              >
                Sign
              </Button>
            </div>
          </>
        )}

        {!isSend && !isSign && (
          <>
            <p className="text-dim" style={{ fontSize: 12.5, lineHeight: 1.5, margin: '0 2px 10px', flexShrink: 0 }}>
              This site wants to connect to your <strong>Evrmore</strong> wallet. It will see
              that wallet's address and balances and may <strong>request</strong> transactions,
              each of which still needs your approval.
            </p>
            <div className="section-label" style={{ marginTop: 0, flexShrink: 0 }}>Wallet to connect</div>
            {/* A dropdown, not a list: the approval stays ONE screen however many
                wallets there are (the owner's rule, 2026-09-07). */}
            {choices.length > 1 && (
              <div style={{ marginBottom: 10, flexShrink: 0 }} data-testid="dapp-wallet-picker">
                <select
                  className="live-picker"
                  data-testid="dapp-wallet-select"
                  aria-label="Wallet to connect"
                  value={wallet?.id ?? ''}
                  onChange={(e) => {
                    const next = choices.find((c) => c.id === e.target.value);
                    if (next) setWallet(next);
                  }}
                  style={{ width: '100%' }}
                >
                  {choices.map((c) => (
                    <option key={c.id} value={c.id} data-testid={`dapp-wallet-option-${c.id}`}>
                      {c.name} · {c.address ? shortAddress(c.address) : 'no address'}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="card solid" style={{ marginBottom: 10, flexShrink: 0 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">Wallet</span>
                  <span className="sum-val" data-testid="dapp-wallet-name">{wallet?.name ?? 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Address</span>
                  <span className="sum-val mono" style={{ fontSize: 11 }} data-testid="dapp-wallet-address">
                    {wallet?.address ? shortAddress(wallet.address) : 'No wallet set up'}
                  </span>
                </div>
              </div>
            </div>
            {!wallet?.address && (
              <div className="banner warning" style={{ marginBottom: 10, flexShrink: 0 }} data-testid="dapp-no-evrmore-wallet">
                {choices.length === 0
                  ? 'This site needs an Evrmore wallet. Open Satori GO, switch to Evrmore (or add it to a wallet), then retry from the site.'
                  : 'Set up the live wallet in the extension first, then retry from the site.'}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, marginTop: 4, flexShrink: 0 }}>
              <Button block variant="secondary" data-testid="dapp-reject" onClick={reject}>
                Reject
              </Button>
              <Button
                block
                icon={<ShieldCheck size={16} />}
                data-testid="dapp-approve"
                disabled={!wallet?.address}
                onClick={approveConnect}
              >
                Connect
              </Button>
            </div>
          </>
        )}

        {isSend && (
          <>
            <div className="banner warning" style={{ marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
              <SendHorizonal size={15} style={{ flexShrink: 0 }} />
              <span>
                Sending <strong>{Number.isFinite(sendAmount) ? sendAmount : '?'} {sendAssetName}</strong> on the{' '}
                <strong>real</strong>{` ${walletChainName}`} network. This cannot be undone.
              </span>
            </div>
            <div className="card solid" style={{ marginBottom: 12, flexShrink: 0 }}>
              <div className="summary-table">
                <div className="sum-row">
                  <span className="sum-key">From wallet</span>
                  <span className="sum-val">{wallet?.name ?? 'n/a'}</span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">To</span>
                  <span className="sum-val mono" style={{ fontSize: 11, wordBreak: 'break-all' }} data-testid="dapp-send-to">
                    {sendTo || 'n/a'}
                  </span>
                </div>
                <div className="sum-row">
                  <span className="sum-key">Amount</span>
                  <span className="sum-val" data-testid="dapp-send-amount">
                    {Number.isFinite(sendAmount) ? sendAmount : '?'} {sendAssetName}
                  </span>
                </div>
                <div className="sum-row" data-testid="dapp-send-fee">
                  <span className="sum-key">Network fee</span>
                  <span className="sum-val">
                    {review
                      ? `${fmtSats(review.plan.feeSats, walletNet.decimals)} ${walletNativeTicker}`
                      : 'shown after review'}
                  </span>
                </div>
                {review && review.plan.assetName === undefined && (
                  <div className="sum-row">
                    <span className="sum-key">Total debited</span>
                    <span className="sum-val">
                      {fmtSats(review.plan.amountSats + review.plan.feeSats, walletNet.decimals)} {walletNativeTicker}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {(sendPasswordBeforeReview || sendPasswordAtConfirm) && (
              <div style={{ flexShrink: 0 }}>
                <PasswordField
                  label="Wallet password"
                  showLabel="Show password"
                  hideLabel="Hide password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your wallet password"
                  autoFocus
                  testId="dapp-password"
                />
              </div>
            )}

            {review && (
              <div className="banner info" style={{ marginTop: 4, flexShrink: 0 }}>
                Reviewed &amp; signed. Confirm to broadcast. The fee above is final.
              </div>
            )}

            {actionError && (
              <div className="banner danger" style={{ margin: '10px 0 0', flexShrink: 0 }} data-testid="dapp-error" role="alert">
                {actionError}
              </div>
            )}

            <div style={{ display: 'flex', gap: 10, marginTop: 12, flexShrink: 0 }}>
              <Button block variant="secondary" data-testid="dapp-reject" disabled={working} onClick={reject}>
                Reject
              </Button>
              {review ? (
                <Button
                  block
                  loading={working}
                  icon={working ? undefined : <ShieldCheck size={16} />}
                  data-testid="dapp-confirm"
                  onClick={() => void confirmSend()}
                >
                  Confirm &amp; Send
                </Button>
              ) : (
                <Button
                  block
                  loading={working}
                  data-testid="dapp-approve"
                  onClick={() => void reviewSend()}
                >
                  Review
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </div>,
  );
}
