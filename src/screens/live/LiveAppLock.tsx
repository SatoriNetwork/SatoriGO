// The APP LOCK SCREEN (the app-password design notes §5).
//
// It exists ONLY for a user who has set an app password. Without one this screen
// is never rendered and the lock screen is the selected wallet's own, exactly as
// it has always been.
//
//   launch -> APP LOCK SCREEN (one field)
//               |- wrong -> stay, with the existing failure copy
//               \- right -> wallet list / the last active wallet
//
// The app password gates the APPLICATION; choosing a wallet comes after it. So
// there is deliberately no wallet card, no wallet picker and no per-wallet chip
// here: which wallet is active is not this screen's question. That is the whole
// inversion the design asks for.
//
// It reuses the same brand block, ConstellationField, PasswordField, shake and
// failure copy as LiveLock rather than inventing a second visual language for
// the same act.

import { useState, useCallback } from 'react';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/TextField';
import { BrandLogo } from '../../components/BrandLogo';
import { ConstellationField } from '../../components/ConstellationField';
import { AppRecoverPanel } from './LiveRecovery';
import { useLiveStore } from '../../store/liveStore';

export function LiveAppLock() {
  const unlockApp = useLiveStore((s) => s.unlockApp);
  const storeError = useLiveStore((s) => s.error);
  // NOTHING IS STRANDED (the app-password design notes §4 rule 5). Wallets that
  // never migrated still open with their own password, and this screen used to
  // be the one place that could not reach them: one field, no list, and a
  // forgotten app password locked the user out of wallets it had never touched.
  // Offered only while such a wallet exists, so an install where everything has
  // moved over sees exactly the screen it saw before.
  const wallets = useLiveStore((s) => s.wallets);
  const openWithWalletPassword = useLiveStore((s) => s.openWithWalletPassword);
  const ownPasswordWallets = wallets.filter((w) => !w.appProtected);

  const [password, setPassword] = useState('');
  // "I forgot my password" (the app-password design notes §13.9). It replaces the
  // form rather than sitting under it: someone who is here has already failed
  // at the field above, and a lock screen that grows a second form is a lock
  // screen nobody reads.
  const [recovering, setRecovering] = useState(false);
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [localError, setLocalError] = useState('');
  // Same arrival-then-plain-DOM treatment as LiveLock: keeping the animation
  // class would keep the mark composited as a GPU texture and Windows display
  // scaling would stretch it into standing pixelation.
  const [markArrived, setMarkArrived] = useState(false);

  const triggerShake = useCallback(() => {
    setShake(true);
    setTimeout(() => setShake(false), 500);
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLocalError('');
    if (!password) {
      setLocalError('Enter your password.');
      triggerShake();
      return;
    }
    setLoading(true);
    const ok = await unlockApp(password);
    setLoading(false);
    if (!ok) {
      // The SAME failure copy the per-wallet lock screen uses.
      setLocalError('Incorrect password. Try again.');
      setPassword('');
      triggerShake();
    }
  };

  const displayError = localError || storeError;

  return (
    <div className="app-frame screen-enter" data-testid="live-app-lock">
      <ConstellationField variant="calm" />
      <div className="lock-screen">
        <div className="lock-brand">
          <span
            className={markArrived ? 'welcome-mark' : 'welcome-mark welcome-mark-arrive'}
            onAnimationEnd={() => setMarkArrived(true)}
          >
            <BrandLogo slot="satori" size={124} alt="Satori Network" />
          </span>
          <span className="brand-title">Satori GO</span>
        </div>

        {/* The owner asked for less on this screen (2026-08-26): a bigger mark
            and plain copy. It is the first thing seen on every open, it asks
            for one thing, and the mark already says whose wallet this is, so
            the "Wallet Locked" heading and the sentence explaining the password
            are gone.
            The line under the name is a TAGLINE now, at the owner's request
            (2026-08-26), not the note about picking a wallet next: it therefore
            no longer depends on how many wallets there are. */}
        <p className="lock-account" data-testid="live-app-lock-sub">
          The future is here.
        </p>

        {recovering && (
          <div className="lock-form" data-testid="live-app-lock-recover">
            <AppRecoverPanel onBack={() => setRecovering(false)} />
          </div>
        )}

        {!recovering && (
        <form onSubmit={handleSubmit} className={`lock-form${shake ? ' shake' : ''}`}>
          <PasswordField
            label="Password"
            showLabel="Show password"
            hideLabel="Hide password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            // No placeholder: the label already says "Password" and repeating
            // the word directly under itself reads as clutter on a screen whose
            // whole point is that it asks for one thing.
            autoFocus
            testId="live-app-unlock"
            error={displayError ?? undefined}
          />
          <Button type="submit" block loading={loading} style={{ marginTop: 16 }}>
            Unlock
          </Button>
          <button
            type="button"
            className="lock-forgot"
            style={{ display: 'block', margin: '14px auto 0' }}
            onClick={() => setRecovering(true)}
            data-testid="live-app-lock-forgot"
          >
            Forgot your password?
          </button>
        </form>
        )}

        {!recovering && ownPasswordWallets.length > 0 && (
          <div className="lock-alt" data-testid="live-app-lock-own-password">
            <span className="lock-alt-sep">or</span>
            <p className="text-faint" style={{ fontSize: 11, margin: '0 0 9px', lineHeight: 1.5 }}>
              {ownPasswordWallets.length === 1
                ? 'One wallet has not moved to your app password yet. It still opens with its own.'
                : `${ownPasswordWallets.length} wallets have not moved to your app password yet. They still open with their own.`}
            </p>
            <Button
              type="button"
              variant="secondary"
              block
              data-testid="live-app-lock-use-wallet-password"
              onClick={() => void openWithWalletPassword()}
            >
              Use a wallet&apos;s own password
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
