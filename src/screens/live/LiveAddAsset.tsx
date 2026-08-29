// Add-asset (MetaMask-style) modal for the Live surface. The user types an
// EVRmore asset name; the store validates it against the real chain via
// getAssetMeta before pinning it. On success the modal closes and the new row
// appears on LiveHome; on failure the error is shown inline.
//
// On an EVM chain the same field takes EITHER a contract address or a name /
// symbol to search for. A token's identity is still only its contract address:
// picking a search row simply fills that address into the very same add path,
// and the chain is still what answers for symbol and decimals.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Coins } from 'lucide-react';
import { Modal } from '../../components/Modal';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { TokenIcon } from '../../components/BrandLogo';
import { useLiveStore, nativeTickerFor, assetsSupported, chainDisplayName, activeFamily, activeEvmChain, type TokenSearchHit } from '../../store/liveStore';
import { shortAccountAddress } from './walletGroups';
import { displaySymbol, displayTokenName } from '../../services/displaySymbol';

interface LiveAddAssetProps {
  onClose(): void;
}

/** '0x' + 40 hex: the input is already a contract address, so there is nothing
 *  to search for. Case is not checked here (the store's EIP-55 validator is
 *  what accepts or refuses the address); this only picks the input's MODE. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Shortest query worth a search. One character matches most of a 3000-token
 *  list, which is noise, not a result. */
const MIN_QUERY = 2;

/** Keystrokes settle before the list is searched. The download itself happens
 *  once a day (tokenSearch.ts caches it), so this only paces the filtering. */
const SEARCH_DEBOUNCE_MS = 300;

export function LiveAddAsset({ onClose }: LiveAddAssetProps) {
  const addAsset = useLiveStore((s) => s.addAsset);
  const nativeTicker = nativeTickerFor();
  // Whether the active chain has an asset protocol at all — a plain chain
  // (e.g. Bitcoin Gold) has nothing to add. Capability-driven, never a
  // hardcoded ticker check.
  const canAdd = assetsSupported();
  // On an EVM chain a token is identified by its CONTRACT ADDRESS (two tokens
  // can share a symbol); the store reads symbol and decimals from the chain.
  const isEvm = activeFamily() === 'evm';
  // Import (EVM only, where the build has a token index): everything the
  // account holds, or only tokens listed in Trust Wallet's assets (airdrop and
  // spam tokens are not); the user removes what they do not want afterwards.
  const evmChain = useLiveStore((s) => activeEvmChain(s));
  const importEvmTokens = useLiveStore((s) => s.importEvmTokens);
  const canImport = isEvm && !!evmChain?.alchemy;
  const [importing, setImporting] = useState<'trusted' | 'all' | null>(null);
  const [importNote, setImportNote] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  // Search by name / symbol (EVM only). `searchedFor` is the query the results
  // below actually answer, so "no matches" can never be shown for a query that
  // is still being typed or still in flight.
  const searchEvmTokens = useLiveStore((s) => s.searchEvmTokens);
  const [results, setResults] = useState<TokenSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searchedFor, setSearchedFor] = useState('');
  // Only the newest query may write results: the list download is slow the
  // first time and instant afterwards, so answers can arrive out of order.
  const queryRef = useRef(0);

  const runImport = async (mode: 'trusted' | 'all') => {
    if (importing) return;
    setImporting(mode);
    setImportNote('');
    setError('');
    try {
      const res = await importEvmTokens({ trustedOnly: mode === 'trusted' });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      const parts: string[] = [];
      parts.push(
        res.added > 0
          ? `Imported ${res.added} token${res.added === 1 ? '' : 's'}.`
          : mode === 'trusted' && res.untrusted > 0
            ? 'Satori GO cannot vouch for any of the tokens this account holds.'
            : 'No new tokens: everything eligible is already listed.',
      );
      if (mode === 'trusted' && res.untrusted > 0) parts.push(`${res.untrusted} unlisted token${res.untrusted === 1 ? '' : 's'} left out (add one by contract address if you want it).`);
      if (res.skipped > 0) parts.push(`${res.skipped} without usable metadata left out.`);
      if (res.added > 0) parts.push('Remove any you do not want from its details.');
      setImportNote(parts.join(' '));
    } finally {
      setImporting(null);
    }
  };

  const trimmed = name.trim();
  const looksLikeAddress = ADDRESS_RE.test(trimmed);
  // What the search runs on: an EVM query that is not already an address.
  const query = isEvm && !looksLikeAddress && trimmed.length >= MIN_QUERY ? trimmed : '';

  useEffect(() => {
    const seq = ++queryRef.current;
    if (!query) {
      setResults([]);
      setSearching(false);
      setSearchError('');
      setSearchedFor('');
      return;
    }
    setSearchError('');
    setSearching(true);
    const timer = setTimeout(() => {
      void searchEvmTokens(query).then((res) => {
        if (queryRef.current !== seq) return;
        setSearching(false);
        setSearchedFor(query);
        if (res.ok) {
          setResults(res.results);
          setSearchError('');
        } else {
          setResults([]);
          setSearchError(res.error);
        }
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, searchEvmTokens]);

  /** The one add path: whatever is added, it is added as a contract address
   *  (EVM) or an asset name (UTXO) through the store's addAsset. */
  const runAdd = async (value: string) => {
    if (submitting) return;
    setError('');
    setSubmitting(true);
    const res = await addAsset(value);
    setSubmitting(false);
    if (res.ok) {
      onClose();
    } else {
      setError(res.error);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError('');
    if (!trimmed) {
      setError(isEvm ? 'Enter a token contract address, or pick a token from the search results.' : 'Enter an asset name.');
      return;
    }
    // A name typed in full that matches exactly one token is unambiguous: add
    // it rather than making the user click the single row under the field.
    if (isEvm && !looksLikeAddress) {
      if (searchedFor === query && results.length === 1) {
        await runAdd(results[0].address);
        return;
      }
      setError('Enter a token contract address, or pick a token from the search results.');
      return;
    }
    await runAdd(trimmed);
  };

  // This chain has no asset protocol (e.g. Bitcoin Gold): there is nothing to
  // add. Reachable only defensively — LiveHome hides the "Add token" action
  // that opens this modal on such a chain — so this just explains why and
  // offers a close, instead of showing a form with nowhere useful to go.
  if (!canAdd) {
    return (
      <Modal title="Add a token" onClose={onClose} testId="live-add-asset-modal">
        <p className="text-dim" style={{ fontSize: 12, margin: '0 0 14px', lineHeight: 1.5 }}>
          {nativeTicker} has no token or asset support. This wallet only ever holds {nativeTicker}.
        </p>
        <Button type="button" block onClick={onClose} data-testid="live-add-asset-close">
          Close
        </Button>
      </Modal>
    );
  }

  return (
    <Modal title="Add a token" onClose={onClose} testId="live-add-asset-modal">
      <form onSubmit={submit}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
          {/* Neutral placeholder until a name is typed — a "?" letter avatar in
              a random hue read as a real (broken) token. */}
          {trimmed && !isEvm ? (
            <TokenIcon assetId={trimmed} size={34} />
          ) : (
            <span className="row-icon neutral" aria-hidden="true">
              <Coins size={16} />
            </span>
          )}
          <p className="text-dim" style={{ fontSize: 12, margin: 0, lineHeight: 1.5 }}>
            {isEvm
              ? `Search a token by name or symbol on ${chainDisplayName()}, or paste its contract address. Its symbol and decimals are read from the chain before it is added.`
              : `Enter a ${chainDisplayName()} asset name. We verify it exists on-chain before adding it to your list.`}
          </p>
        </div>

        <TextField
          label={isEvm ? 'Token name, symbol or contract address' : 'Asset name'}
          placeholder={isEvm ? 'e.g. USDC or 0x...' : 'e.g. SATORI'}
          value={name}
          onChange={(e) => {
            setName(isEvm ? e.target.value.trim() : e.target.value.toUpperCase());
            setError('');
          }}
          testId="live-add-asset-input"
          autoComplete="off"
          autoCapitalize={isEvm ? 'off' : 'characters'}
          spellCheck={false}
          autoFocus
        />

        {/* Search results (EVM). A row is a shortcut to an address, so it adds
            through exactly the same path the submit button uses. */}
        {query !== '' && searching && results.length === 0 && (
          <div className="text-dim" data-testid="live-token-search-loading" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
            Searching…
          </div>
        )}
        {query !== '' && results.length > 0 && (
          <div
            data-testid="live-token-search-results"
            style={{
              marginTop: 6,
              padding: 3,
              border: '1px solid var(--border)',
              borderRadius: 10,
              maxHeight: 196,
              overflowY: 'auto',
            }}
          >
            {results.map((hit) => (
              <button
                key={hit.address}
                type="button"
                className="list-row"
                data-testid={`live-token-search-result-${hit.address.toLowerCase()}`}
                disabled={submitting}
                onClick={() => void runAdd(hit.address)}
                style={{ gap: 8, padding: '7px 9px' }}
              >
                {/* Symbol and name are DISPLAY hints the token list published,
                    and a search row is a place a token would very much like to
                    put a green check into. Both are drawn through the sanitiser;
                    adding the token still goes by hit.address. */}
                <span style={{ fontSize: 12.5, fontWeight: 650, flex: '0 0 auto' }}>{displaySymbol(hit.symbol)}</span>
                <span
                  className="text-dim"
                  style={{ fontSize: 11.5, flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {displayTokenName(hit.name)}
                </span>
                <span className="text-dim mono" style={{ fontSize: 10.5, flex: '0 0 auto' }}>
                  {shortAccountAddress(hit.address)}
                </span>
              </button>
            ))}
          </div>
        )}
        {query !== '' && !searching && !searchError && searchedFor === query && results.length === 0 && (
          <div className="text-dim" data-testid="live-token-search-empty" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
            No matches. Paste the contract address to add it anyway.
          </div>
        )}
        {query !== '' && !searching && searchError !== '' && (
          <div className="text-dim" data-testid="live-token-search-error" style={{ fontSize: 11.5, marginTop: 2, lineHeight: 1.5 }}>
            Token search is unavailable right now. Paste the contract address instead.
          </div>
        )}

        {error && (
          <div
            className="banner danger"
            data-testid="live-add-asset-error"
            style={{ marginTop: 4, marginBottom: 4 }}
          >
            {error}
          </div>
        )}

        <div style={{ display: 'flex', gap: 9, marginTop: 14 }}>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" block loading={submitting} data-testid="live-add-asset-submit">
            Add token
          </Button>
        </div>

        {canImport && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border)' }} data-testid="live-import-section">
            <div className="section-label" style={{ marginTop: 0, marginBottom: 4 }}>Or import what this account already holds</div>
            <p className="text-dim" style={{ fontSize: 11.5, margin: '0 0 10px', lineHeight: 1.5 }}>
              Import trusted takes only the tokens Satori GO will vouch for: the ones in this network's public token list that also have a registry picture. Airdrop and spam tokens have neither. Import all takes every token with a balance. You can remove any afterwards.
            </p>
            <div style={{ display: 'flex', gap: 9 }}>
              <Button
                type="button"
                block
                loading={importing === 'trusted'}
                disabled={importing !== null}
                onClick={() => void runImport('trusted')}
                data-testid="live-import-trusted"
              >
                Import trusted
              </Button>
              <Button
                type="button"
                variant="secondary"
                block
                loading={importing === 'all'}
                disabled={importing !== null}
                onClick={() => void runImport('all')}
                data-testid="live-import-all"
              >
                Import all
              </Button>
            </div>
            {importNote && (
              <div className="text-dim" data-testid="live-import-note" style={{ fontSize: 11.5, marginTop: 10, lineHeight: 1.45 }}>
                {importNote}
              </div>
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
