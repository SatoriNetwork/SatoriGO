import { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';

import { BrandLogo } from '../../components/BrandLogo';
import { getSatoriStats, type SatoriStats } from '../../services/satoriStats';

/**
 * Satori Network statistics, laid out the way satorinet.io's own "Statistics"
 * section does it: a grid of tiles, each a small uppercase label, a big number, and
 * a caption underneath. Same six figures, same derivations (see satoriStats.ts).
 * Two columns instead of three, because the popup is 400px wide.
 */

const nf0 = new Intl.NumberFormat('en-US');
const nf3 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

interface Tile {
  label: string;
  value: string | null;
  caption: string;
}

function buildTiles(s: SatoriStats | null): Tile[] {
  const money = (v: number | null | undefined) => (v === null || v === undefined ? null : `$${nf2.format(v)}`);
  const count = (v: number | null | undefined) => (v === null || v === undefined ? null : nf0.format(v));

  return [
    { label: 'Network output', value: count(s?.predictions), caption: 'Predictions' },
    { label: 'Connected', value: count(s?.neurons), caption: 'Neurons' },
    { label: 'Price', value: money(s?.price), caption: 'SATORIEVR token' },
    { label: 'Cost', value: money(s?.stakeCostUsd), caption: 'Stake a neuron' },
    {
      label: '24h avg earnings',
      value: s?.avgEarningsPerNeuron == null ? null : nf3.format(s.avgEarningsPerNeuron),
      caption: 'Per staked neuron',
    },
    { label: 'Total', value: count(s?.walletHolders), caption: 'Wallet holders' },
  ];
}

export function LiveNetwork() {
  const [stats, setStats] = useState<SatoriStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async (force: boolean) => {
    setLoading(true);
    const next = await getSatoriStats(force);
    setStats(next);
    // A total miss (no live data AND no cached copy) is the only real failure; a
    // partial one just leaves individual tiles blank.
    setFailed(next === null);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const tiles = buildTiles(stats);

  return (
    <div className="screen-enter" data-testid="live-network">
      <div className="net-head">
        <div className="net-head-title">
          <BrandLogo slot="satori" size={18} alt="Satori Network" />
          <span>Satori Network</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          onClick={() => void load(true)}
          disabled={loading}
          aria-label="Refresh statistics"
          data-testid="live-network-refresh"
        >
          <RefreshCw size={15} className={loading ? 'spin' : undefined} />
        </button>
      </div>

      <div className="stat-grid" data-testid="live-network-grid">
        {tiles.map((t) => (
          <div className="stat-tile" key={t.label} data-testid={`live-stat-${t.caption.toLowerCase().replace(/\s+/g, '-')}`}>
            <div className="stat-label">{t.label}</div>
            <div className="stat-value tnum">
              {t.value ?? <span className="stat-value-missing">n/a</span>}
            </div>
            <div className="stat-caption">{t.caption}</div>
          </div>
        ))}
      </div>

      {failed && (
        <div className="alert alert-danger" style={{ marginTop: 12 }} data-testid="live-network-error">
          Could not reach satorinet.io. Check your connection and try again.
        </div>
      )}

      <p className="text-faint" style={{ fontSize: 11, marginTop: 12, textAlign: 'center' }}>
        Live figures from satorinet.io. A neuron stake is 250 SATORI.
      </p>
    </div>
  );
}
