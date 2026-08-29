// LOSING THE APP PASSWORD, in Settings > Security (the app-password design notes §13).
//
// Three things live here, and they are three because they answer three
// different failures:
//
//   RECOVERY CODE  "I forgot my password."      Recovers this install whole.
//   BACKUP FILE    "My computer is gone."       Recovers it onto another one.
//   RESTORE        "Put that file back."        Replaces what is here.
//
// The copy on all three is written for someone reading it in the emergency,
// not for someone browsing settings: it says what each one recovers, what it
// does NOT recover, and (for the code) that it is a second full key to the
// wallet rather than a convenience.
//
// Kept out of LiveSettings.tsx because that file is already long, and because
// everything here is one feature with one design doc behind it.

import { useCallback, useRef, useState } from 'react';
import { AlertTriangle, Download, KeyRound, Upload } from 'lucide-react';
import { Button } from '../../components/Button';
import { TextField, PasswordField } from '../../components/TextField';
import { CopyButton } from '../../components/CopyButton';
import { useLiveStore } from '../../store/liveStore';
import type { BackupPreview } from '../../services/chain/liveWallet';

/** The shortest an app password may be, mirrored for the backup file: a file
 *  someone else may hold is the one place a short password is worst. */
const MIN_PASSWORD = 8;

/**
 * Hand the browser a file to save.
 *
 * An object URL and a synthetic click, which is the only route an extension
 * page has without the `downloads` permission — and asking for a new permission
 * to save one file would be a worse trade than this. The URL is revoked on a
 * timer rather than immediately: revoking it in the same tick can cancel the
 * download it was created for.
 */
function downloadText(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type Panel = 'none' | 'code' | 'backup' | 'restore';

export function RecoverySettings() {
  const recoveryCodeSet = useLiveStore((s) => s.recoveryCodeSet);
  const appPasswordSet = useLiveStore((s) => s.appPasswordSet);
  const [panel, setPanel] = useState<Panel>('none');

  const open = (next: Panel) => setPanel((p) => (p === next ? 'none' : next));

  return (
    <>
      {/* No heading of its own: this is the whole of the Recovery screen now,
          and the Shell above it already says so. */}
      {/* WITHOUT AN APP PASSWORD THERE IS NOTHING TO RECOVER *TO*. The code is a
          second way to the app's master key and the backup carries the record
          that key lives in, so both are offered only once one exists. Saying
          why beats hiding the section and leaving the user to wonder. */}
      {!appPasswordSet ? (
        <div className="card" data-testid="live-rec-needs-app-password">
          <p className="text-dim" style={{ fontSize: 11.5, margin: 0, lineHeight: 1.55 }}>
            Set an app password first. A recovery code and a backup file are both ways back to it.
          </p>
        </div>
      ) : (
        <>
          <div className="card" data-testid="live-rec-code-card">
            <div className="list-row" style={{ padding: 0, border: 'none' }}>
              <span className="row-main">
                <span className="row-title">Recovery code</span>
              </span>
              <span
                className={`chip ${recoveryCodeSet ? 'success' : 'neutral'}`}
                data-testid="live-rec-code-chip"
              >
                {recoveryCodeSet ? 'On' : 'Off'}
              </span>
            </div>
            <p className="text-dim" style={{ fontSize: 11.5, margin: '3px 0 0', lineHeight: 1.55 }}>
              {recoveryCodeSet
                ? 'If you forget your password, this code opens the wallet and lets you set a new one. It is not shown again.'
                : 'One code that opens the wallet if you forget your password. Shown once, then never again.'}
            </p>
            <Button
              variant="secondary"
              size="sm"
              block
              style={{ marginTop: 9 }}
              icon={<KeyRound size={14} />}
              onClick={() => open('code')}
              data-testid="live-rec-code-open"
            >
              {recoveryCodeSet ? 'Replace or remove the code' : 'Create a recovery code'}
            </Button>
            {panel === 'code' && <RecoveryCodePanel onDone={() => setPanel('none')} />}
          </div>

          <div className="card" data-testid="live-rec-backup-card">
            <div className="list-row" style={{ padding: 0, border: 'none' }}>
              <span className="row-main">
                <span className="row-title">Backup file</span>
              </span>
            </div>
            <p className="text-dim" style={{ fontSize: 11.5, margin: '3px 0 0', lineHeight: 1.55 }}>
              One encrypted file with every wallet on this device. It is the only thing that
              survives losing this computer.
            </p>
            <div style={{ display: 'flex', gap: 9, marginTop: 9 }}>
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<Download size={14} />}
                onClick={() => open('backup')}
                data-testid="live-rec-backup-open"
              >
                Save a backup
              </Button>
              <Button
                variant="secondary"
                size="sm"
                block
                icon={<Upload size={14} />}
                onClick={() => open('restore')}
                data-testid="live-rec-restore-open"
              >
                Restore
              </Button>
            </div>
            {panel === 'backup' && <BackupPanel onDone={() => setPanel('none')} />}
            {panel === 'restore' && <RestorePanel onDone={() => setPanel('none')} />}
          </div>
        </>
      )}

      {/* The one route this release does not build, said out loud rather than
          left for someone to discover at the worst moment (§13.10). */}
      <p
        className="text-faint"
        style={{ fontSize: 11, margin: '8px 2px 0', lineHeight: 1.5 }}
        data-testid="live-rec-phrase-note"
      >
        With no code and no backup file, a forgotten password leaves only each wallet&apos;s
        recovery phrase. Nothing about your password is stored anywhere but this device, so there
        is no reset we could send you.
      </p>
    </>
  );
}

// ---------------------------------------------------------------------------
// The recovery code
// ---------------------------------------------------------------------------

function RecoveryCodePanel({ onDone }: { onDone: () => void }) {
  const recoveryCodeSet = useLiveStore((s) => s.recoveryCodeSet);
  const createRecoveryCode = useLiveStore((s) => s.createRecoveryCode);
  const removeRecoveryCode = useLiveStore((s) => s.removeRecoveryCode);

  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);

  const make = async () => {
    setError('');
    setBusy(true);
    const result = await createRecoveryCode(password);
    setBusy(false);
    setPassword('');
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setCode(result.code);
  };

  const drop = async () => {
    setError('');
    setBusy(true);
    const result = await removeRecoveryCode(password);
    setBusy(false);
    setPassword('');
    if (!result.ok) {
      setError(result.error ?? 'Could not remove the code.');
      return;
    }
    onDone();
  };

  // THE CODE IS ON SCREEN. This is the only moment it exists outside the wrap
  // it opens, so the panel stops being a form and becomes one instruction.
  if (code) {
    return (
      <div style={{ marginTop: 11 }} data-testid="live-rec-code-shown">
        <p className="text-dim" style={{ fontSize: 11.5, margin: '0 0 8px', lineHeight: 1.55 }}>
          Write this down and keep it somewhere safe. It will not be shown again.
        </p>
        <div
          className="card"
          style={{
            fontFamily: 'var(--font-mono, ui-monospace, monospace)',
            fontSize: 13,
            letterSpacing: 0.6,
            lineHeight: 1.8,
            wordBreak: 'break-all',
            textAlign: 'center',
          }}
          data-testid="live-rec-code-value"
        >
          {code}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 9 }}>
          {/* `secret`, like the seed-phrase and private-key reveals: this code
              opens the wallet on its own, so the clipboard must auto-clear and
              the toast must say so, whatever the user's clipboard setting is.
              A lone icon says nothing, hence the label beside it. */}
          <CopyButton
            value={code}
            label="Copy the recovery code"
            testId="live-rec-code-copy"
            secret
          />
          <span className="text-dim" style={{ fontSize: 11.5 }}>
            Copy it (the clipboard clears itself)
          </span>
        </div>
        {/* Not decoration. Anyone with this code does not need the password, so
            the screen that hands it over is the screen that has to say so. */}
        <p
          className="text-faint"
          style={{ fontSize: 11, margin: '9px 0 0', lineHeight: 1.5, display: 'flex', gap: 6 }}
        >
          <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>
            Anyone who has this code can open your wallet without your password. Do not store it
            with the password, and do not photograph it.
          </span>
        </p>
        <label
          style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '11px 0 0', fontSize: 12 }}
        >
          <input
            type="checkbox"
            checked={saved}
            onChange={(e) => setSaved(e.target.checked)}
            data-testid="live-rec-code-saved"
          />
          <span>I have written it down</span>
        </label>
        <Button
          block
          size="sm"
          style={{ marginTop: 9 }}
          disabled={!saved}
          onClick={onDone}
          data-testid="live-rec-code-done"
        >
          Done
        </Button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 11 }} data-testid="live-rec-code-form">
      {recoveryCodeSet && (
        <p className="text-faint" style={{ fontSize: 11, margin: '0 0 8px', lineHeight: 1.5 }}>
          Making a new code stops the old one from working.
        </p>
      )}
      <PasswordField
        label="App password"
        showLabel="Show password"
        hideLabel="Hide password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Your app password"
        testId="live-rec-code-pw"
        error={error || undefined}
      />
      <div style={{ display: 'flex', gap: 9, marginTop: 9 }}>
        <Button
          block
          size="sm"
          loading={busy}
          disabled={!password}
          onClick={() => void make()}
          data-testid="live-rec-code-create"
        >
          {recoveryCodeSet ? 'Make a new code' : 'Create the code'}
        </Button>
        {recoveryCodeSet && (
          <Button
            block
            size="sm"
            variant="danger"
            loading={busy}
            disabled={!password}
            onClick={() => void drop()}
            data-testid="live-rec-code-remove"
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Saving a backup file
// ---------------------------------------------------------------------------

function BackupPanel({ onDone }: { onDone: () => void }) {
  const exportBackup = useLiveStore((s) => s.exportBackup);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');

  const save = async () => {
    setError('');
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    const result = await exportBackup(password);
    setBusy(false);
    setPassword('');
    setConfirm('');
    if (!result.ok) {
      setError(result.error);
      return;
    }
    downloadText(result.fileName, result.text);
    setSaved(result.fileName);
  };

  if (saved) {
    return (
      <div style={{ marginTop: 11 }} data-testid="live-rec-backup-saved">
        <p className="text-dim" style={{ fontSize: 11.5, margin: 0, lineHeight: 1.55 }}>
          Saved as <strong>{saved}</strong>. Keep it somewhere other than this computer, and
          remember the password you just chose: without it the file cannot be opened by anyone,
          including us.
        </p>
        <Button block size="sm" style={{ marginTop: 9 }} onClick={onDone} data-testid="live-rec-backup-done">
          Done
        </Button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 11 }} data-testid="live-rec-backup-form">
      {/* NOT the app password, and the reason is the whole point of the file. */}
      <p className="text-dim" style={{ fontSize: 11.5, margin: '0 0 9px', lineHeight: 1.55 }}>
        Choose a password for the file itself. It is deliberately not your app password: the file
        exists so a forgotten app password is survivable.
      </p>
      <PasswordField
        label="File password"
        showLabel="Show password"
        hideLabel="Hide password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={`At least ${MIN_PASSWORD} characters`}
        testId="live-rec-backup-pw"
      />
      <div style={{ height: 9 }} />
      <PasswordField
        label="Repeat it"
        showLabel="Show password"
        hideLabel="Hide password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        placeholder="The same password"
        testId="live-rec-backup-pw2"
        error={error || undefined}
      />
      <Button
        block
        size="sm"
        style={{ marginTop: 9 }}
        loading={busy}
        disabled={!password || !confirm}
        onClick={() => void save()}
        data-testid="live-rec-backup-save"
      >
        Save the file
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restoring one
// ---------------------------------------------------------------------------

export function RestorePanel({ onDone }: { onDone: () => void }) {
  const readBackupFile = useLiveStore((s) => s.readBackupFile);
  const applyRestore = useLiveStore((s) => s.applyRestore);
  const cancelRestore = useLiveStore((s) => s.cancelRestore);

  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [text, setText] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<BackupPreview | null>(null);

  const pick = useCallback(async (file: File | undefined) => {
    setError('');
    setPreview(null);
    if (!file) return;
    setFileName(file.name);
    try {
      setText(await file.text());
    } catch {
      setError('Could not read that file.');
    }
  }, []);

  const openFile = async () => {
    setError('');
    setBusy(true);
    const result = await readBackupFile(text, password);
    setBusy(false);
    setPassword('');
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setPreview(result.preview);
  };

  const apply = async (mode: 'replace' | 'merge') => {
    setError('');
    setBusy(true);
    const result = await applyRestore(mode);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not restore.');
      return;
    }
    onDone();
  };

  // Step 2: the file is open. Say what is in it and what it costs BEFORE
  // offering the button that does it (§13.8).
  if (preview) {
    return (
      <div style={{ marginTop: 11 }} data-testid="live-rec-restore-preview">
        <p className="text-dim" style={{ fontSize: 11.5, margin: '0 0 8px', lineHeight: 1.55 }}>
          {preview.wallets.length === 1
            ? 'This backup holds 1 wallet:'
            : `This backup holds ${preview.wallets.length} wallets:`}
        </p>
        <div className="card" style={{ padding: '8px 10px' }}>
          {preview.wallets.map((w) => (
            <div key={w.id} style={{ fontSize: 12, lineHeight: 1.7 }}>
              {w.name}
              <span className="text-faint" style={{ marginLeft: 6, fontSize: 11 }}>
                {w.network}
              </span>
            </div>
          ))}
        </div>

        {/* WHAT A REPLACE DESTROYS, BY NAME. The word "replace" is not a
            warning; a list of the wallets that will be gone is. */}
        {preview.losing.length > 0 && (
          <p
            style={{
              // `--warning`, not a class: there is no `.text-warn` in the sheet
              // and inventing one for a single paragraph is not worth a global.
              color: 'var(--warning)',
              fontSize: 11.5,
              margin: '10px 0 0',
              lineHeight: 1.55,
              display: 'flex',
              gap: 6,
            }}
            data-testid="live-rec-restore-losing"
          >
            <AlertTriangle size={13} style={{ flexShrink: 0, marginTop: 2 }} />
            <span>
              Replacing removes {preview.losing.length === 1 ? 'this wallet' : 'these wallets'} from
              this device: <strong>{preview.losing.map((w) => w.name).join(', ')}</strong>. Save a
              backup first if you cannot re-import {preview.losing.length === 1 ? 'it' : 'them'}{' '}
              from a recovery phrase.
            </span>
          </p>
        )}

        <div style={{ display: 'flex', gap: 9, marginTop: 11 }}>
          {/* Offered first when it is available, because it is the one that
              cannot lose anything. */}
          {preview.canMerge && preview.gaining > 0 && (
            <Button
              block
              size="sm"
              loading={busy}
              onClick={() => void apply('merge')}
              data-testid="live-rec-restore-merge"
            >
              Add {preview.gaining} missing
            </Button>
          )}
          <Button
            block
            size="sm"
            variant={preview.losing.length > 0 ? 'danger' : 'primary'}
            loading={busy}
            onClick={() => void apply('replace')}
            data-testid="live-rec-restore-replace"
          >
            {preview.deviceEmpty ? 'Restore' : 'Replace everything'}
          </Button>
        </div>
        {!preview.canMerge && !preview.deviceEmpty && (
          <p className="text-faint" style={{ fontSize: 11, margin: '9px 0 0', lineHeight: 1.5 }}>
            These wallets were protected by a different app password, so they cannot be added
            alongside the ones already here.
          </p>
        )}
        {error && (
          <p className="text-danger" style={{ fontSize: 11.5, margin: '9px 0 0' }}>
            {error}
          </p>
        )}
        <Button
          block
          size="sm"
          variant="secondary"
          style={{ marginTop: 9 }}
          onClick={() => {
            cancelRestore();
            onDone();
          }}
          data-testid="live-rec-restore-cancel"
        >
          Cancel
        </Button>
      </div>
    );
  }

  // Step 1: pick the file, then its password.
  return (
    <div style={{ marginTop: 11 }} data-testid="live-rec-restore-form">
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        style={{ display: 'none' }}
        onChange={(e) => void pick(e.target.files?.[0])}
        data-testid="live-rec-restore-file"
      />
      <Button
        block
        size="sm"
        variant="secondary"
        icon={<Upload size={14} />}
        onClick={() => fileRef.current?.click()}
        data-testid="live-rec-restore-pick"
      >
        {fileName || 'Choose a backup file'}
      </Button>
      {text && (
        <>
          <div style={{ height: 9 }} />
          <PasswordField
            label="File password"
            showLabel="Show password"
            hideLabel="Hide password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="The password you chose for this file"
            testId="live-rec-restore-pw"
            error={error || undefined}
          />
          <Button
            block
            size="sm"
            style={{ marginTop: 9 }}
            loading={busy}
            disabled={!password}
            onClick={() => void openFile()}
            data-testid="live-rec-restore-read"
          >
            Open the file
          </Button>
        </>
      )}
      {!text && error && (
        <p className="text-danger" style={{ fontSize: 11.5, margin: '9px 0 0' }}>
          {error}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The way in from the LOCK screen
// ---------------------------------------------------------------------------

/**
 * "Forgot password?" — the code, or a backup file.
 *
 * Reachable with nothing unlocked, which is the whole point, and therefore
 * deliberately offers only the two routes that do not need the password. There
 * is no destructive "reset the wallet" here: a one-click irreversible wipe on a
 * screen anyone can reach needs its own design pass, not an afterthought
 * (§13.10).
 */
export function AppRecoverPanel({ onBack }: { onBack: () => void }) {
  const recoveryCodeSet = useLiveStore((s) => s.recoveryCodeSet);
  const unlockWithRecoveryCode = useLiveStore((s) => s.unlockWithRecoveryCode);

  const [mode, setMode] = useState<'menu' | 'code' | 'file'>('menu');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async () => {
    setError('');
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for the new password.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    const result = await unlockWithRecoveryCode(code, password);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'That did not work.');
      setPassword('');
      setConfirm('');
      return;
    }
    // On success the store has already opened the wallet.
  };

  if (mode === 'code') {
    return (
      <div data-testid="live-recover-code">
        <TextField
          label="Recovery code"
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          autoFocus
          testId="live-recover-code-input"
        />
        <div style={{ height: 9 }} />
        <PasswordField
          label="New password"
          showLabel="Show password"
          hideLabel="Hide password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={`At least ${MIN_PASSWORD} characters`}
          testId="live-recover-new-pw"
        />
        <div style={{ height: 9 }} />
        <PasswordField
          label="Repeat it"
          showLabel="Show password"
          hideLabel="Hide password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          placeholder="The same password"
          testId="live-recover-new-pw2"
          error={error || undefined}
        />
        <Button
          block
          style={{ marginTop: 12 }}
          loading={busy}
          disabled={!code || !password || !confirm}
          onClick={() => void submit()}
          data-testid="live-recover-submit"
        >
          Open the wallet
        </Button>
        <Button
          block
          variant="secondary"
          style={{ marginTop: 9 }}
          onClick={() => setMode('menu')}
          data-testid="live-recover-code-back"
        >
          Back
        </Button>
      </div>
    );
  }

  if (mode === 'file') {
    return (
      <div data-testid="live-recover-file">
        <RestorePanel onDone={() => setMode('menu')} />
        <Button
          block
          variant="secondary"
          style={{ marginTop: 9 }}
          onClick={() => setMode('menu')}
          data-testid="live-recover-file-back"
        >
          Back
        </Button>
      </div>
    );
  }

  return (
    <div data-testid="live-recover-menu">
      <Button
        block
        variant="secondary"
        icon={<KeyRound size={14} />}
        disabled={!recoveryCodeSet}
        onClick={() => setMode('code')}
        data-testid="live-recover-use-code"
      >
        I have my recovery code
      </Button>
      {!recoveryCodeSet && (
        <p className="text-faint" style={{ fontSize: 11, margin: '6px 2px 0', lineHeight: 1.5 }}>
          No recovery code was ever made on this device.
        </p>
      )}
      <Button
        block
        variant="secondary"
        icon={<Upload size={14} />}
        style={{ marginTop: 9 }}
        onClick={() => setMode('file')}
        data-testid="live-recover-use-file"
      >
        I have a backup file
      </Button>
      {/* The honest floor. Everything above needs something the user made in
          advance; this is what is left when they did not. */}
      <p className="text-faint" style={{ fontSize: 11, margin: '11px 2px 0', lineHeight: 1.5 }}>
        With neither, your wallets can only be brought back from their recovery phrases, on a fresh
        install. Your password is not stored anywhere but this device, so there is nothing we can
        reset for you.
      </p>
      <Button
        block
        variant="secondary"
        style={{ marginTop: 12 }}
        onClick={onBack}
        data-testid="live-recover-back"
      >
        Back to the password
      </Button>
    </div>
  );
}
