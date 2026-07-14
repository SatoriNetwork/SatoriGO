import { useState, useCallback, useEffect } from 'react';
import { Check, Lock } from 'lucide-react';
import { Button } from '../../components/Button';
import { PasswordField } from '../../components/TextField';
import { BrandLogo } from '../../components/BrandLogo';
import { useLiveStore } from '../../store/liveStore';

type LiveLockProps = Record<string, never>;

export function LiveLock(_props: LiveLockProps) {
  const unlock = useLiveStore((s) => s.unlock);
  const storeError = useLiveStore((s) => s.error);
  const wallets = useLiveStore((s) => s.wallets);
  const activeWalletId = useLiveStore((s) => s.activeWalletId);
  const switchWallet = useLiveStore((s) => s.switchWallet);
  const loadWallets = useLiveStore((s) => s.loadWallets);
  const addWalletStart = useLiveStore((s) => s.addWalletStart);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(false);
  const [localError, setLocalError] = useState('');

  // The wallet list is normally loaded by init(), but make sure it's there when
  // the lock screen is reached through a path that skipped it.
  useEffect(() => {
    if (wallets.length === 0) void loadWallets();
  }, [wallets.length, loadWallets]);

  const activeWallet = wallets.find((w) => w.id === activeWalletId) ?? null;
  // Bug fix: switchWallet() only auto-unlocks a passwordless target when it
  // ACTUALLY switches (it no-ops if the id is already active — see liveStore's
  // `if (id === get().activeWalletId) return;`). That left no path to unlock a
  // passwordless wallet that is already the active one when the lock screen is
  // reached directly (e.g. re-opening the popup after auto-lock) — clicking it
  // looked selected already, so nothing happened. Previously the only way in
  // was to switch to a different wallet and back, which DOES cross the
  // passwordless auto-unlock branch. Fixed below by unlocking explicitly with
  // unlock('') whenever the selected wallet is passwordless, regardless of
  // whether picking it also triggered a switch.
  const isActivePasswordless = !!activeWallet?.passwordless;

  // Picking a wallet re-targets the lock screen: the store switches the active
  // wallet (it stays locked; a passwordless target auto-unlocks inside
  // switchWallet) and the password field below now applies to it.
  const pickWallet = (id: string) => {
    setLocalError('');
    if (id === activeWalletId) {
      // Already the selected/active wallet — switchWallet() would no-op, so if
      // it's passwordless, unlock it directly instead of relying on a switch.
      const w = wallets.find((x) => x.id === id);
      if (w?.passwordless) void unlock('');
      return;
    }
    setPassword('');
    void switchWallet(id);
  };

  const handleOpenPasswordless = async () => {
    setLocalError('');
    setLoading(true);
    const ok = await unlock('');
    setLoading(false);
    if (!ok) {
      setLocalError('Could not open this wallet. Try again.');
      triggerShake();
    }
  };

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
    const ok = await unlock(password);
    setLoading(false);
    if (!ok) {
      setLocalError('Incorrect password. Try again.');
      setPassword('');
      triggerShake();
    }
  };

  const displayError = localError || storeError;

  return (
    <div className="app-frame screen-enter" data-testid="live-lock">
      <div className="lock-screen">
        {/* Satori GO branding — the lock screen previously had no wordmark at
            all, just a bare red lock circle (user report: "na ekranie
            logowania nic nie ma" — nothing on the login screen). Matches the
            header brand block on LiveHome (BrandLogo "satori" slot + "Satori
            GO" wordmark) plus the same tagline used on LiveHome's footer. */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, marginBottom: 4 }}>
          <BrandLogo slot="satori" size={88} alt="Satori Network" />
          <span className="brand-title" style={{ fontSize: 19, marginTop: 10 }}>Satori GO</span>
          <span className="text-faint" style={{ fontSize: 10.5 }}>
            Built for the Satori Network
          </span>
        </div>

        <div className="lock-logo">
          <div
            style={{
              width: 48,
              height: 48,
              borderRadius: '50%',
              background: 'var(--danger-bg)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--danger)',
              border: '1px solid color-mix(in srgb, var(--danger) 25%, transparent)',
            }}
          >
            <Lock size={20} />
          </div>
        </div>
        <h2>Live Wallet Locked</h2>
        <p className="lock-account">{activeWallet?.name ?? 'Real EVRmore Network'}</p>

        {/* Wallet picker: the LAST-USED (active) wallet is preselected; picking
            another one switches to it while staying on this lock screen. */}
        {wallets.length > 0 && (
          <div className="stack lock-wallets" data-testid="live-lock-wallets">
            {wallets.map((w, i) => {
              const selected = w.id === activeWalletId;
              return (
                <button
                  key={w.id}
                  type="button"
                  className="lock-wallet"
                  aria-pressed={selected}
                  onClick={() => pickWallet(w.id)}
                  data-testid={`live-lock-wallet-${i}`}
                >
                  {w.kind === 'pk' && <BrandLogo slot="satori" size={16} alt="Satori" />}
                  <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {w.name}
                  </span>
                  <span className="chip neutral" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>
                    {w.kind === 'pk' ? 'Satori' : 'Seed'}
                  </span>
                  {w.passwordless && (
                    <span className="chip warning" style={{ fontSize: 8.5, padding: '1px 4px', flexShrink: 0 }}>No pw</span>
                  )}
                  {selected && <Check size={14} style={{ color: 'var(--accent-text)', flexShrink: 0 }} />}
                </button>
              );
            })}
          </div>
        )}

        {/* Passwordless wallet: there is no password to ask for. Skip the form
            entirely and offer a single button that unlocks with the empty
            passphrase — covers both "just picked from the list above" and
            "already the active wallet when this screen was reached". */}
        {isActivePasswordless ? (
          <div className={`lock-form${shake ? ' shake' : ''}`}>
            {displayError && (
              <p
                data-testid="live-unlock-error"
                style={{ fontSize: 11.5, color: 'var(--danger)', marginBottom: 10 }}
              >
                {displayError}
              </p>
            )}
            <Button
              type="button"
              block
              loading={loading}
              data-testid="live-lock-open-passwordless"
              onClick={() => void handleOpenPasswordless()}
            >
              Open wallet
            </Button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className={`lock-form${shake ? ' shake' : ''}`}>
            <PasswordField
              label="Password"
              showLabel="Show password"
              hideLabel="Hide password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Enter your password"
              autoFocus
              testId="live-unlock"
              error={displayError ?? undefined}
            />
            <Button
              type="submit"
              block
              loading={loading}
              style={{ marginTop: 16 }}
            >
              Unlock
            </Button>
          </form>
        )}

        {/* Don't want to log in? Create or import a NEW wallet from here. */}
        <div className="lock-alt">
          <span className="lock-alt-sep">or</span>
          <div style={{ display: 'flex', gap: 9 }}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => addWalletStart()}
              data-testid="live-lock-create"
              style={{ flex: 1 }}
            >
              Create new wallet
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => addWalletStart()}
              data-testid="live-lock-import"
              style={{ flex: 1 }}
            >
              Import wallet
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
