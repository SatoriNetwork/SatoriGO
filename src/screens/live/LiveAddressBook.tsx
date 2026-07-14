// Address book — a persisted list of saved recipients ({label, address}). Reachable
// from Live Settings. Addresses are validated with the chain layer before saving.
// The Send screen reuses the same store list via its inline contacts picker.

import { useState } from 'react';
import { ChevronLeft, BookUser, Trash2, Plus, Pencil, Check, X } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField } from '../../components/TextField';
import { CopyButton } from '../../components/CopyButton';
import { EmptyState } from '../../components/EmptyState';
import { useLiveStore } from '../../store/liveStore';
import { LiveNav } from './LiveNav';

interface LiveAddressBookProps {
  onBack(): void;
  /** When provided, tapping a contact fills the recipient and returns (used when
   *  the address book is opened as a picker). Absent = manage-only view. */
  onPick?(address: string): void;
}

function short8(address: string): string {
  return address.slice(0, 8);
}

export function LiveAddressBook({ onBack, onPick }: LiveAddressBookProps) {
  const addressBook = useLiveStore((s) => s.addressBook);
  const addContact = useLiveStore((s) => s.addContact);
  const renameContact = useLiveStore((s) => s.renameContact);
  const removeContact = useLiveStore((s) => s.removeContact);

  const [label, setLabel] = useState('');
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');

  // Inline label editing (one contact at a time, keyed by its address).
  const [editingAddress, setEditingAddress] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editError, setEditError] = useState('');

  const handleSave = () => {
    setError('');
    const res = addContact(label, address);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setLabel('');
    setAddress('');
  };

  const startEdit = (contactAddress: string, contactLabel: string) => {
    setEditingAddress(contactAddress);
    setEditLabel(contactLabel);
    setEditError('');
  };

  const cancelEdit = () => {
    setEditingAddress(null);
    setEditLabel('');
    setEditError('');
  };

  const commitEdit = (contactAddress: string) => {
    const res = renameContact(contactAddress, editLabel);
    if (!res.ok) {
      setEditError(res.error);
      return;
    }
    cancelEdit();
  };

  return (
    <div className="app-frame screen-enter">
      <div className="sub-header">
        <button type="button" className="icon-btn" onClick={onBack} aria-label="Back">
          <ChevronLeft size={20} />
        </button>
        <h2>Address book</h2>
        <span />
      </div>

      <div className="app-content" data-testid="live-address-book">
        <p className="text-dim" style={{ fontSize: 12, marginBottom: 14, lineHeight: 1.5 }}>
          Save recipients you send to often. Contacts are stored on this device and offered when you send.
        </p>

        {/* Add contact */}
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="section-label" style={{ marginTop: 0 }}>Add a contact</div>
          <TextField
            label="Name"
            value={label}
            onChange={(e) => { setLabel(e.target.value); setError(''); }}
            placeholder="e.g. Exchange"
            testId="live-contact-label"
            autoComplete="off"
          />
          <TextField
            label="EVRmore address"
            value={address}
            onChange={(e) => { setAddress(e.target.value); setError(''); }}
            placeholder="EVR address (starts with E)"
            testId="live-contact-address"
            autoComplete="off"
            error={error || undefined}
          />
          <Button
            block
            icon={<Plus size={14} />}
            onClick={handleSave}
            data-testid="live-contact-save"
            style={{ marginTop: 12 }}
          >
            Save contact
          </Button>
        </div>

        {/* Contact list */}
        <div className="section-label">Saved contacts</div>
        {addressBook.length === 0 ? (
          <EmptyState
            icon={<BookUser size={20} />}
            title="No contacts yet"
            description="Add a recipient above to save it here."
          />
        ) : (
          <div className="stack">
            {addressBook.map((c) => {
              const isEditing = editingAddress === c.address;
              if (isEditing) {
                return (
                  <div key={c.address} className="token-row" style={{ alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <TextField
                        label="Name"
                        value={editLabel}
                        onChange={(e) => { setEditLabel(e.target.value); setEditError(''); }}
                        placeholder="Contact name"
                        testId={`live-contact-edit-input-${short8(c.address)}`}
                        autoComplete="off"
                        autoFocus
                        error={editError || undefined}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commitEdit(c.address); }
                          if (e.key === 'Escape') { e.preventDefault(); cancelEdit(); }
                        }}
                      />
                      <div className="token-sub mono" style={{ wordBreak: 'break-all', marginTop: 4 }}>{c.address}</div>
                    </div>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => commitEdit(c.address)}
                      aria-label={`Save name for ${c.label}`}
                      data-testid={`live-contact-edit-save-${short8(c.address)}`}
                      style={{ width: 26, height: 26, flexShrink: 0, color: 'var(--accent)' }}
                    >
                      <Check size={15} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={cancelEdit}
                      aria-label="Cancel editing"
                      data-testid={`live-contact-edit-cancel-${short8(c.address)}`}
                      style={{ width: 26, height: 26, flexShrink: 0 }}
                    >
                      <X size={15} />
                    </button>
                  </div>
                );
              }
              return (
                <div
                  key={c.address}
                  className="token-row"
                  data-testid={`live-contact-${short8(c.address)}`}
                  style={{ cursor: onPick ? 'pointer' : 'default' }}
                  role={onPick ? 'button' : undefined}
                  tabIndex={onPick ? 0 : undefined}
                  onClick={onPick ? () => onPick(c.address) : undefined}
                  onKeyDown={
                    onPick
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onPick(c.address);
                          }
                        }
                      : undefined
                  }
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="token-name">{c.label}</div>
                    <div className="token-sub mono" style={{ wordBreak: 'break-all' }}>{c.address}</div>
                  </div>
                  <CopyButton value={c.address} label={`Copy ${c.label} address`} size={13} />
                  <button
                    type="button"
                    className="icon-btn"
                    onClick={(e) => { e.stopPropagation(); startEdit(c.address, c.label); }}
                    aria-label={`Edit name for ${c.label}`}
                    data-testid={`live-contact-edit-${short8(c.address)}`}
                    style={{ width: 26, height: 26, flexShrink: 0 }}
                  >
                    <Pencil size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn danger"
                    onClick={(e) => { e.stopPropagation(); removeContact(c.address); }}
                    aria-label={`Remove ${c.label}`}
                    data-testid={`live-contact-remove-${short8(c.address)}`}
                    style={{ width: 26, height: 26, flexShrink: 0 }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <LiveNav />
    </div>
  );
}
