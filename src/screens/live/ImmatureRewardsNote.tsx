// "Maturing" rewards under Home's balance.
//
// A block reward cannot be spent for its first 101 blocks. On a chain that pays
// rewards to ordinary users (X Coin's minute lottery) that is everyday life:
// the balance already counts a fresh win, a send leaves it out, and without a
// word here the two numbers simply disagree. This line says how much is
// waiting and for how long.
//
// It is a NOTE, never a balance: if the read fails it shows nothing, and the
// send path (which makes its own read, under the same rule) is what actually
// decides what can be spent.

import { useEffect, useState } from 'react';
import { liveService } from '../../store/liveStore';
import type { ImmatureRewards } from '../../services/chain/liveWallet';
import { formatListAmount } from '../../services/chain/amounts';

/** While something is waiting, look again this often: a block is a minute. */
const RECHECK_MS = 60_000;
/** After a failed read: try again after these waits, then stop. */
const RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000];

/** "about 37 min", "about 1 h 35 min". Null when the block time is unknown. */
export function aboutDuration(blocks: number, blockSeconds: number | null): string | null {
  if (!blockSeconds || blockSeconds <= 0) return null;
  const minutes = Math.max(1, Math.round((blocks * blockSeconds) / 60));
  if (minutes < 60) return `about ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `about ${h} h` : `about ${h} h ${m} min`;
}

const blocksWord = (n: number) => `${n} block${n === 1 ? '' : 's'}`;

/** The sentence itself, kept pure so it can be tested without a wallet. */
export function immatureRewardsText(r: ImmatureRewards, ticker: string, scale: number, hide: boolean): string {
  const amount = hide ? '••••' : formatListAmount(r.totalSats, scale);
  const next = aboutDuration(r.nextBlocks, r.blockSeconds);
  const all = aboutDuration(r.allBlocks, r.blockSeconds);
  if (r.count === 1) {
    return next
      ? `${amount} ${ticker} maturing, can be sent in ${next} (${blocksWord(r.nextBlocks)})`
      : `${amount} ${ticker} maturing, can be sent in ${blocksWord(r.nextBlocks)}`;
  }
  return next && all
    ? `${amount} ${ticker} maturing in ${r.count} rewards. Next in ${next}, all in ${all}.`
    : `${amount} ${ticker} maturing in ${r.count} rewards. Next in ${blocksWord(r.nextBlocks)}, all in ${blocksWord(r.allBlocks)}.`;
}

export function ImmatureRewardsNote({
  address,
  balanceKey,
  ticker,
  scale,
  hide,
}: {
  /** The active wallet's address: a result is only ever shown for the address
   *  it was read for, so a wallet switch can never show the last wallet's. */
  address: string | null;
  /** Changes whenever the native balance does (a new win, a spend): re-read. */
  balanceKey: string;
  ticker: string;
  scale: number;
  hide: boolean;
}) {
  const [state, setState] = useState<{ address: string; rewards: ImmatureRewards | null } | null>(null);

  useEffect(() => {
    if (!address) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const read = async () => {
      let rewards: ImmatureRewards | null = null;
      try {
        rewards = await liveService().getImmatureRewards();
      } catch {
        // A note that cannot be read is not shown, but one failed read must not
        // silence it for good: right after the window opens the wallet may not
        // be unlocked or connected yet. A few spaced retries, then give up
        // until the balance changes.
        if (cancelled) return;
        failures += 1;
        if (failures <= RETRY_DELAYS_MS.length) timer = setTimeout(() => void read(), RETRY_DELAYS_MS[failures - 1]);
        return;
      }
      if (cancelled) return;
      failures = 0;
      setState({ address, rewards });
      // Only a wallet that HAS something waiting keeps asking.
      if (rewards) timer = setTimeout(() => void read(), RECHECK_MS);
    };
    void read();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [address, balanceKey]);

  const rewards = state && state.address === address ? state.rewards : null;
  if (!rewards) return null;
  return (
    <div
      className="text-dim immature-note"
      data-testid="live-immature-rewards"
      data-blocks-next={rewards.nextBlocks}
      data-blocks-all={rewards.allBlocks}
      title={`A reward can be spent 101 blocks after it was won. Until then it is in your balance but is left out of a send.`}
    >
      {immatureRewardsText(rewards, ticker, scale, hide)}
    </div>
  );
}
