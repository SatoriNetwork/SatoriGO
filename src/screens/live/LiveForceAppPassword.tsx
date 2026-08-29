// THE FORCED APP-PASSWORD SETUP (the app-password design notes §12).
//
// It appears at launch for exactly one user: someone who has at least one wallet
// that opens with NO PASSWORD AT ALL, and no app password on this device to
// protect it with. `passwordless: true` means the vault is encrypted under an
// EMPTY passphrase, so the seed is effectively at rest in the clear and anyone
// who can use this computer can spend from it. The owner chose to REQUIRE the
// password rather than nudge for it, so this screen has no skip, no dismiss and
// no route around it: LiveApp renders it INSTEAD of the whole wallet, and the
// only way past is setting the password.
//
// WHAT MAKES FORCING DEFENSIBLE, and it is not optional. Forcing a password on
// someone who then forgets it costs them the wallet, and the recovery phrase
// becomes the only way back. On exactly these wallets that phrase is readable
// RIGHT NOW with nothing typed, and this screen is what takes that away. So it
// offers the backup BEFORE it does: "Show my recovery phrase first" works here
// because no password is needed yet, it opens the SAME reveal screen (and the
// same warnings) the wallet has always used, and it stays reachable next to the
// password fields for as long as the screen is up. There is no state in which
// the wallet demands a password and offers no way to save what the user has.
//
// A MIXED INSTALL IS THE INTERESTING ONE. Wallets that already have their own
// password are not touched by any of this: their seeds cannot be read without
// the password the user has not typed, so they stay v1 and migrate lazily, each
// asking once, with the existing option to decline. That means the user
// temporarily has MORE to remember, not less, which the summary at the end says
// out loud rather than leaving them to discover it at a lock screen. It is also
// the property that makes forcing safe: forgetting the new app password does not
// cost those wallets, because their own passwords still open them.

import { useState } from 'react';
import { KeyRound, AlertTriangle, ShieldAlert, Eye } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/TextField';
import { PasswordStrengthBar } from '../../components/PasswordStrengthBar';
import { BrandLogo } from '../../components/BrandLogo';
import { ConstellationField } from '../../components/ConstellationField';
import { useLiveStore } from '../../store/liveStore';
import { MIN_PASSWORD_LENGTH } from '../../services/constants';
import { RevealSecretModal } from './RevealSecretModal';

/** "one" .. "ten", then the digits. Copy reads better in words at small counts,
 *  and a wallet list is small by nature. */
const WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
function count(n: number): string {
  return n < WORDS.length ? WORDS[n] : String(n);
}

/** "A", "A and B", "A, B and C". */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** What the BACKUP of these wallets is called. A 'pk' wallet (a Satori-style
 *  imported key) has no recovery phrase at all: its private key IS its backup,
 *  and telling that user to write down a phrase they do not have would be the
 *  one promise this screen must never make. */
function backupNoun(wallets: { kind: string }[]): string {
  const seed = wallets.some((w) => w.kind !== 'pk');
  const pk = wallets.some((w) => w.kind === 'pk');
  if (seed && pk) return 'recovery phrase or private key';
  return pk ? 'private key' : 'recovery phrase';
}

export function LiveForceAppPassword() {
  const wallets = useLiveStore((s) => s.wallets);
  const completeForcedAppPassword = useLiveStore((s) => s.completeForcedAppPassword);
  const finishForcedAppPassword = useLiveStore((s) => s.finishForcedAppPassword);
  const revealPasswordlessBackup = useLiveStore((s) => s.revealPasswordlessBackup);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  /** Which wallet's backup is on screen, if any. */
  const [revealId, setRevealId] = useState<string | null>(null);
  /** Set once the password is in place: what moved, and what still asks. */
  const [done, setDone] = useState<{ migrated: string[]; kept: string[]; own: string[] } | null>(
    null,
  );

  // The wallets this screen exists for, and the ones it deliberately leaves
  // alone. In the state that shows this screen NO wallet is app-protected yet,
  // so every wallet is one or the other.
  const unprotected = wallets.filter((w) => w.passwordless);
  const ownPassword = wallets.filter((w) => !w.passwordless);
  const revealTarget = unprotected.find((w) => w.id === revealId) ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError('');
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`App password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('App passwords do not match.');
      return;
    }
    // Named BEFORE the move: afterwards these are ordinary app-protected wallets
    // and nothing on the entry says which ones this screen just protected.
    const ownNames = ownPassword.map((w) => w.name);
    setBusy(true);
    const result = await completeForcedAppPassword(password);
    setBusy(false);
    if (!result.ok) {
      setError(result.error ?? 'Could not set the app password.');
      return;
    }
    setPassword('');
    setConfirm('');
    // ONE wallet, all of it moved, nothing left to explain: go straight in.
    // Anything else and the user is owed the state they are now in.
    if (wallets.length <= 1 && result.kept.length === 0) {
      await finishForcedAppPassword();
      return;
    }
    setDone({ migrated: result.migrated, kept: result.kept, own: ownNames });
  };

  // ---- what is happening, in the user's own arithmetic ----------------------
  const total = wallets.length;
  const n = unprotected.length;
  const mixed = n < total;
  const headline = !mixed
    ? total === 1
      ? 'Your wallet opens with no password at all.'
      : `All ${count(total)} of your wallets open with no password at all.`
    : n === 1
      ? `One of your ${count(total)} wallets opens with no password at all.`
      : `${count(n).replace(/^./, (c) => c.toUpperCase())} of your ${count(total)} wallets open with no password at all.`;
  const them = n === 1 ? 'it' : 'them';

  // ---- the summary after the password is set --------------------------------
  if (done) {
    return (
      <div className="app-frame screen-enter" data-testid="live-force-app-password-done">
        <ConstellationField variant="calm" />
        <div className="lock-screen" style={{ justifyContent: 'flex-start', paddingTop: 26 }}>
          <div className="lock-brand" style={{ marginBottom: 14 }}>
            <BrandLogo slot="satori" size={56} alt="Satori Network" />
            <span className="brand-title">Satori GO</span>
          </div>
          <h2 style={{ marginBottom: 10 }}>Your app password is set</h2>

          {done.migrated.length > 0 && (
            <p className="text-dim force-pw-text" data-testid="live-force-app-password-protected">
              {done.migrated.length === 1
                ? `"${done.migrated[0]}" is protected by it now.`
                : `${count(done.migrated.length).replace(/^./, (c) => c.toUpperCase())} wallets are protected by it now: ${nameList(done.migrated)}.`}
            </p>
          )}

          {done.own.length > 0 && (
            <p className="text-dim force-pw-text" data-testid="live-force-app-password-still-own">
              {done.own.length === 1
                ? `"${done.own[0]}" still has its own password. It asks for it once, the next time you open it, and then it moves to your app password too.`
                : `${count(done.own.length).replace(/^./, (c) => c.toUpperCase())} wallets still have their own password: ${nameList(done.own)}. Each one asks for its own password once, the next time you open it, and then it moves to your app password too.`}
            </p>
          )}

          {done.own.length > 0 && (
            <div
              className="banner info"
              style={{ marginTop: 4, alignItems: 'flex-start' }}
              data-testid="live-force-app-password-both"
            >
              <span>
                Until then you need both: your app password to open Satori GO, and{' '}
                {done.own.length === 1 ? 'that password' : 'those passwords'} once each. Forgetting
                the app password does not lock you out of{' '}
                {done.own.length === 1 ? 'that wallet' : 'those wallets'}.
              </span>
            </div>
          )}

          {done.kept.length > 0 && (
            <div
              className="banner warning"
              style={{ marginTop: 8, alignItems: 'flex-start' }}
              data-testid="live-force-app-password-kept"
            >
              <AlertTriangle size={14} />
              <span>
                {done.kept.length === 1
                  ? `"${done.kept[0]}" could not be moved and still opens with no password.`
                  : `${count(done.kept.length).replace(/^./, (c) => c.toUpperCase())} wallets could not be moved and still open with no password: ${nameList(done.kept)}.`}{' '}
                Satori GO offers to move {done.kept.length === 1 ? 'it' : 'them'} again the next
                time {done.kept.length === 1 ? 'it is' : 'they are'} opened.
              </span>
            </div>
          )}

          <Button
            block
            style={{ marginTop: 18 }}
            data-testid="live-force-app-password-continue"
            onClick={() => void finishForcedAppPassword()}
          >
            Continue
          </Button>
        </div>
      </div>
    );
  }

  // ---- the blocking screen ---------------------------------------------------
  return (
    <div className="app-frame screen-enter" data-testid="live-force-app-password">
      <ConstellationField variant="calm" />
      <div className="lock-screen" style={{ justifyContent: 'flex-start', paddingTop: 22 }}>
        <div className="lock-brand" style={{ marginBottom: 12 }}>
          <BrandLogo slot="satori" size={56} alt="Satori Network" />
          <span className="brand-title">Satori GO</span>
        </div>

        <h2 style={{ marginBottom: 8 }}>Set a password for Satori GO</h2>

        <div
          className="banner warning"
          style={{ alignItems: 'flex-start', marginBottom: 10 }}
          data-testid="live-force-app-password-why"
        >
          <ShieldAlert size={15} style={{ flexShrink: 0 }} />
          <span>
            {headline} Anyone who can use this computer can open Satori GO and spend from {them}.
          </span>
        </div>

        <p className="text-dim force-pw-text">
          An app password fixes that. It encrypts {them} on this device, and Satori GO asks for it
          when it opens. Nothing about your coins, addresses or recovery{' '}
          {n === 1 ? 'phrase' : 'phrases'} changes.
        </p>

        <p className="text-faint force-pw-text" data-testid="live-force-app-password-wallets">
          {n === 1 ? 'Wallet with no password: ' : 'Wallets with no password: '}
          {nameList(unprotected.map((w) => w.name))}.
          {mixed && (
            <>
              {' '}
              {ownPassword.length === 1
                ? `"${ownPassword[0].name}" already has its own password and is not changed here.`
                : `${count(ownPassword.length).replace(/^./, (c) => c.toUpperCase())} wallets already have their own passwords and are not changed here.`}
            </>
          )}
        </p>

        {/* THE BACKUP, OFFERED BEFORE IT IS TAKEN AWAY. Always here, never behind
            a step the user has to finish first: a screen that demands a password
            and hides the way to the phrase is the one thing this must not be. */}
        <div className="card" data-testid="live-force-app-password-backup" style={{ marginTop: 4 }}>
          <span className="row-title">Back up first</span>
          <p className="text-dim force-pw-text" style={{ margin: '3px 0 8px' }}>
            Right now you can still see the {backupNoun(unprotected)} of{' '}
            {n === 1 ? 'this wallet' : 'these wallets'} without typing anything. After this step you
            will need your app password to see {n === 1 ? 'it' : 'them'} again. Write{' '}
            {n === 1 ? 'it' : 'them'} down somewhere only you can reach.
          </p>
          {unprotected.map((w, i) => (
            <Button
              key={w.id}
              block
              variant="secondary"
              size="sm"
              icon={<Eye size={14} />}
              style={{ marginTop: i === 0 ? 0 : 7 }}
              data-testid={`live-force-app-password-reveal-${i}`}
              onClick={() => setRevealId(w.id)}
            >
              {n === 1
                ? `Show my ${w.kind === 'pk' ? 'private key' : 'recovery phrase'} first`
                : `${w.name}: show ${w.kind === 'pk' ? 'private key' : 'recovery phrase'}`}
            </Button>
          ))}
        </div>

        <form onSubmit={submit} style={{ width: '100%', marginTop: 12 }}>
          <PasswordField
            label="App password"
            showLabel="Show password"
            hideLabel="Hide password"
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              setError('');
            }}
            placeholder="Choose an app password"
            testId="live-force-app-pw-new"
          />
          <PasswordStrengthBar password={password} />
          <PasswordField
            label="Confirm app password"
            showLabel="Show password"
            hideLabel="Hide password"
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setError('');
            }}
            placeholder="Enter it again"
            testId="live-force-app-pw-confirm"
          />

          {/* The SAME sentences the Settings setup screen has always said, in the
              same order: what losing it costs, and that it cannot be removed. */}
          <div
            className="banner warning"
            data-testid="live-force-app-password-warning"
            style={{ marginTop: 10, alignItems: 'flex-start' }}
          >
            <AlertTriangle size={14} />
            <span>
              If you lose this password, the wallets it protects can only be restored from their
              recovery phrases.
            </span>
          </div>
          <p className="text-faint force-pw-text" style={{ margin: '8px 2px 0' }}>
            Removing the app password is not supported in this release. You can change it at any
            time in Settings.
          </p>

          {error && (
            <span
              role="alert"
              data-testid="live-force-app-pw-error"
              style={{ fontSize: 11.5, color: 'var(--danger)', display: 'block', marginTop: 8 }}
            >
              {error}
            </span>
          )}

          {/* ONE button. No cancel, no "later", no close: see the header. */}
          <Button
            type="submit"
            block
            loading={busy}
            icon={busy ? undefined : <KeyRound size={15} />}
            style={{ marginTop: 12 }}
            data-testid="live-force-app-pw-submit"
          >
            Set app password
          </Button>
        </form>
      </div>

      {revealTarget && (
        <RevealSecretModal
          kind={revealTarget.kind === 'pk' ? 'key' : 'seed'}
          noPassword
          noPasswordNote="This wallet has no password yet, so the secret is shown directly."
          reveal={async () => {
            const found = await revealPasswordlessBackup(revealTarget.id);
            return found ? found.secret : null;
          }}
          onClose={() => setRevealId(null)}
          notes={
            <p className="text-dim" style={{ fontSize: 12, margin: '0 0 10px', lineHeight: 1.5 }}>
              {revealTarget.kind === 'pk' ? 'Private key' : 'Recovery phrase'} of &quot;
              {revealTarget.name}&quot;. Write it down before you set the app password.
            </p>
          }
        />
      )}
    </div>
  );
}
