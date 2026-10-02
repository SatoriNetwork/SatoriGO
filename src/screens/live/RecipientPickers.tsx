// The three recipient helpers every Send screen shares: the "My wallets"
// quick-pick (chips, or a dropdown past a handful), the address-book dropdown,
// and the "Save to address book" panel. They used to be inline in LiveSend.tsx
// and LiveSendEvm.tsx and were missing from the Monero send entirely; one
// component set is what keeps a Monero send feeling like every other send.
//
// CHAIN SCOPING IS THE CALLER'S JOB (the owner's rule): the screen hands in
// wallets and contacts it has already filtered to the active chain
// (walletsOnChain, isSpendableAddress / isValidMoneroAddress / the EVM check).
// These components only draw what they are given and fill the recipient.
//
// Test ids are `${testIdPrefix}-my-wallets`, `${testIdPrefix}-my-wallets-select`,
// `${testIdPrefix}-wallet-${i}`, `${testIdPrefix}-contacts`,
// `${testIdPrefix}-save-contact`, `${testIdPrefix}-contact-label` and
// `${testIdPrefix}-contact-save`, so the UTXO screen keeps the ids its tests
// and smokes already know ('live-send') and the Monero screen gets its own.

import { useState } from 'react';
import { BookUser, Check, Wallet } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';

/** Past this many wallets the chip grid would eat the screen (an EVM seed can
 *  carry 20 accounts): a dropdown then, chips for the common 1 to 4. */
export const MY_WALLETS_CHIPS_MAX = 4;

export interface PickableWallet {
  id: string;
  name: string;
  address: string;
}

export interface PickableContact {
  label: string;
  address: string;
}

interface MyWalletsPickerProps {
  wallets: PickableWallet[];
  /** The recipient as typed (trimmed); the matching chip highlights. */
  current: string;
  onPick(address: string): void;
  testIdPrefix: string;
  /** Word used in the dropdown placeholder: "wallets" (UTXO, Monero) or
   *  "accounts" (EVM). */
  noun?: 'wallets' | 'accounts';
  /** How many characters of the address the dropdown shows before the ellipsis. */
  shortLen?: number;
  /** Case-insensitive match (EVM addresses are case-insensitive hex). */
  caseInsensitive?: boolean;
}

/** Quick-pick one of your OWN wallets: one tap fills the recipient. The
 *  chosen wallet's chip highlights green (matched by address, so it survives
 *  duplicate names and clears itself when you edit the recipient). No separate
 *  confirmation line, so picking never shifts the layout. */
export function MyWalletsPicker({
  wallets,
  current,
  onPick,
  testIdPrefix,
  noun = 'wallets',
  shortLen = 8,
  caseInsensitive = false,
}: MyWalletsPickerProps) {
  if (wallets.length === 0) return null;
  const same = (a: string, b: string) => (caseInsensitive ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (wallets.length > MY_WALLETS_CHIPS_MAX) {
    return (
      <div data-testid={`${testIdPrefix}-my-wallets`} style={{ margin: '10px 0 12px' }}>
        <select
          data-testid={`${testIdPrefix}-my-wallets-select`}
          className="live-picker"
          value={wallets.find((w) => !!w.address && same(current, w.address))?.address ?? ''}
          onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
          aria-label={`Send to one of my ${noun}`}
          style={{ width: '100%' }}
        >
          <option value="">Send to one of my {noun} ({wallets.length})…</option>
          {wallets.map((w) => (
            <option key={w.id} value={w.address}>
              {w.name} · {w.address.slice(0, shortLen)}…{w.address.slice(-4)}
            </option>
          ))}
        </select>
      </div>
    );
  }
  return (
    <div data-testid={`${testIdPrefix}-my-wallets`} style={{ margin: '10px 0 12px' }}>
      <div className="section-label" style={{ marginTop: 0, marginBottom: 6 }}>My wallets</div>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {wallets.map((w, i) => {
          const isPicked = !!w.address && same(current, w.address);
          return (
            <button
              key={w.id}
              type="button"
              className="chip"
              onClick={() => onPick(w.address)}
              aria-label={`Send to my wallet ${w.name}`}
              aria-pressed={isPicked}
              title={`${w.name}: ${w.address}`}
              data-testid={`${testIdPrefix}-wallet-${i}`}
              style={{
                cursor: 'pointer',
                maxWidth: '100%',
                color: isPicked ? 'var(--success)' : 'var(--text-dim)',
                background: isPicked ? 'var(--success-bg)' : 'var(--card)',
                border: isPicked
                  ? '1px solid color-mix(in srgb, var(--success) 45%, transparent)'
                  : '1px solid var(--border)',
                fontWeight: isPicked ? 700 : 600,
                transition: 'all 0.15s',
              }}
            >
              {isPicked ? <Check size={11} style={{ flexShrink: 0 }} /> : <Wallet size={11} style={{ flexShrink: 0 }} />}
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {w.name}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

interface ContactsPickerProps {
  contacts: PickableContact[];
  onPick(address: string): void;
  testIdPrefix: string;
  shortLen?: number;
}

/** Saved contacts from the address book, already scoped to the active chain
 *  by the caller. Renders nothing when there are none. */
export function ContactsPicker({ contacts, onPick, testIdPrefix, shortLen = 8 }: ContactsPickerProps) {
  if (contacts.length === 0) return null;
  return (
    <div style={{ display: 'flex', gap: 8, margin: '2px 0 12px', flexWrap: 'wrap' }}>
      <select
        data-testid={`${testIdPrefix}-contacts`}
        className="live-picker"
        value=""
        onChange={(e) => { if (e.target.value) onPick(e.target.value); }}
        aria-label="From address book"
        style={{ flex: 1, minWidth: 128 }}
      >
        <option value="">From address book…</option>
        {contacts.map((c) => (
          <option key={c.address} value={c.address}>
            {c.label} · {c.address.slice(0, shortLen)}…
          </option>
        ))}
      </select>
    </div>
  );
}

interface SaveContactPanelProps {
  /** Whether the current recipient is worth offering to save (valid on this
   *  chain, not already a contact, not one of the user's own wallets). */
  canSave: boolean;
  /** Bumps whenever the recipient changes, so a "Saved." note from an earlier
   *  recipient does not linger under a new one. */
  recipient: string;
  onSave(label: string): { ok: true } | { ok: false; error: string };
  testIdPrefix: string;
}

/** "Save to address book" for a freshly typed recipient: a ghost button, then
 *  an inline name field with Cancel / Save contact, then a one-line "Saved"
 *  note. Owns its own open/label/error state. */
export function SaveContactPanel({ canSave, recipient, onSave, testIdPrefix }: SaveContactPanelProps) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [error, setError] = useState('');
  // The recipient the note refers to: a "Saved" line only shows while the
  // recipient it was saved under is still the one in the field.
  const [savedFor, setSavedFor] = useState('');

  const saved = savedFor !== '' && savedFor === recipient;

  const handleSave = () => {
    setError('');
    const res = onSave(label);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setOpen(false);
    setLabel('');
    setSavedFor(recipient);
  };

  return (
    <>
      {canSave && !open && (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => { setOpen(true); setError(''); }}
          data-testid={`${testIdPrefix}-save-contact`}
          style={{ marginBottom: 12 }}
        >
          <BookUser size={13} /> Save to address book
        </button>
      )}
      {saved && (
        <div className="text-dim" style={{ fontSize: 11.5, margin: '0 2px 12px', display: 'flex', alignItems: 'center', gap: 5 }}>
          <Wallet size={12} /> Saved to address book.
        </div>
      )}
      {canSave && open && (
        <div className="card" style={{ marginBottom: 12 }}>
          <TextField
            label="Contact name"
            value={label}
            onChange={(e) => { setLabel(e.target.value); setError(''); }}
            placeholder="e.g. Exchange"
            testId={`${testIdPrefix}-contact-label`}
            autoComplete="off"
            autoFocus
            error={error || undefined}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <Button type="button" variant="secondary" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" size="sm" block onClick={handleSave} data-testid={`${testIdPrefix}-contact-save`}>
              Save contact
            </Button>
          </div>
        </div>
      )}
    </>
  );
}
