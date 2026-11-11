// What the wallet shows WHILE it switches to another wallet (1.6.5).
//
// It used to be a blank frame with a spinner and "Switching wallet…", which
// made a switch that takes a few frames feel like a page load. This is the
// outline of Home instead: the header already carries the wallet being opened
// (its mark, its name, its address, all known from the wallet list before
// anything is decrypted), and the balance and the rows are placeholders in the
// places the real ones land a moment later. Nothing in it is interactive, and
// no figure in it is a balance: a number is only ever drawn from the wallet
// that is actually open.
//
// It is a picture of where things will be, not a second Home: it mounts none of
// the effects Home has, so nothing refreshes, reads rewards or starts a timer
// for a wallet that is not open yet.

import { ChevronDown, Copy } from 'lucide-react';
import { AccountAvatar } from '../../components/AccountAvatar';
import { Skeleton, TokenRowSkeleton } from '../../components/Skeleton';

/** Home's own 8+6 form (LiveHome.shortenAddr), kept identical on purpose. */
function shortenAddr(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export interface SwitchingTarget {
  id: string;
  name: string;
  address: string;
}

export function LiveSwitching({ target }: { target: SwitchingTarget | null }) {
  return (
    <div className="app-frame switching-frame" data-testid="live-syncing" aria-busy="true">
      <div className="app-header">
        <Skeleton width={92} height={30} radius={999} style={{ gridColumn: 1, gridRow: 1 }} />
        <div className="header-identity">
          {target ? (
            <>
              <span className="wallet-switcher" data-testid="live-switching-name">
                <AccountAvatar address={target.address} seed={target.id} size={20} />
                <span className="wallet-switcher-text">{target.name}</span>
                <ChevronDown size={12} style={{ flexShrink: 0 }} />
              </span>
              {target.address && (
                <span className="wallet-address">
                  {/* The same two forms and the same icon as Home's address
                      button, so the line wraps (or not) exactly as it will a
                      moment later and the name does not jump. */}
                  <span className="wallet-address-text mono">
                    <span className="addr-wide">{shortenAddr(target.address)}</span>
                    <span className="addr-narrow">{`${target.address.slice(0, 6)}…${target.address.slice(-4)}`}</span>
                  </span>
                  <Copy size={11} />
                </span>
              )}
            </>
          ) : (
            <Skeleton width={180} height={22} radius={999} />
          )}
        </div>
      </div>
      <div className="app-content" aria-hidden>
        <div className="hero">
          <Skeleton width={150} height={30} style={{ margin: '6px auto 6px' }} />
          <Skeleton width={90} height={13} style={{ margin: '0 auto' }} />
        </div>
        <div className="actions-row" style={{ opacity: 0.45 }}>
          <div className="action-round">
            <div className="action-circle" />
            Send
          </div>
          <div className="action-round">
            <div className="action-circle" />
            Receive
          </div>
        </div>
        <div className="stack" style={{ marginTop: 14 }}>
          <TokenRowSkeleton />
          <TokenRowSkeleton />
          <TokenRowSkeleton />
        </div>
      </div>
      {/* For a screen reader the words are still said. */}
      <span className="sr-only" role="status">
        {target ? `Switching to ${target.name}` : 'Switching wallet'}
      </span>
    </div>
  );
}
