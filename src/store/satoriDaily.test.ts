import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setStorageForTests } from '../services/storage';
import { auditDecimalToBase, loadSatoriDays, satoriDayFigures, satoriDayStatuses, satoriDropDays, type SatoriDayRead } from './satoriDaily';

const ONE = 10n ** 18n;
const ME = '0x00000000000000000000000000000000000000AA';
const OTHER = '0x00000000000000000000000000000000000000BB';

const predictors = [
  'observation_ts,peer_id,alias_address,reward_address,wallet_address,distance,balance,total',
  `t,1,0x1,${ME},0x1,5,250,1.5`,
  `t,2,0x2,${ME.toLowerCase()},0x2,5,250,0.5`,
  `t,3,0x3,${OTHER},0x3,5,250,9`,
  // No reward address set: the reward goes to the neuron's own wallet.
  `t,4,0x4,,${ME},5,250,0.25`,
  '',
].join('\n');

const stakers = [
  'observation_ts,peer_id,lender_alias,lender_wallet,lender_reward,pool_alias,pool_wallet,pool_reward,pool_balance,lender_contribution,pool_commission,share,reward_calculated',
  // ME lends to OTHER's pool: moves from OTHER to ME.
  `t,1,0x1,0x9,${ME},0x5,0x6,${OTHER},0,0,0,0,3.0`,
  // No lender_reward: the lender's wallet is paid.
  `t,2,0x1,${ME},,0x5,0x6,${OTHER},0,0,0,0,1.0`,
  // A lender of ME's pool, whose pool_reward is empty: out of the pool wallet.
  `t,3,0x1,0x8,0x8,0x5,${ME},,0,0,0,0,0.75`,
  '',
].join('\n');

describe('auditDecimalToBase', () => {
  it('reads the file\'s numbers exactly', () => {
    expect(auditDecimalToBase('1.5')).toBe((3n * ONE) / 2n);
    expect(auditDecimalToBase('0.138645902418')).toBe(138645902418000000n);
    expect(auditDecimalToBase('16.60495635890')).toBe(16604956358900000000n);
    expect(auditDecimalToBase('250')).toBe(250n * ONE);
    expect(auditDecimalToBase('0E-12')).toBe(0n);
    expect(auditDecimalToBase('1.5e-3')).toBe(15n * 10n ** 14n);
  });

  it('an empty or foreign cell is nothing', () => {
    expect(auditDecimalToBase('')).toBe(0n);
    expect(auditDecimalToBase('.')).toBe(0n);
    expect(auditDecimalToBase('abc')).toBe(0n);
  });
});

describe('satoriDayFigures', () => {
  it('adds neurons, lending and what the pool paid out, for both addresses of one file', () => {
    const out = satoriDayFigures(predictors, stakers, [ME, OTHER]);
    const me = out.get(ME.toLowerCase());
    expect(me?.neuronsBase).toBe((2n * ONE + ONE / 4n) - (3n * ONE) / 4n);
    expect(me?.lendingBase).toBe(4n * ONE);
    expect(me?.totalBase).toBe((11n * ONE) / 2n);
    expect(out.get(OTHER.toLowerCase())?.totalBase).toBe(5n * ONE);
  });

  it('survives Windows line ends', () => {
    const out = satoriDayFigures(predictors.replace(/\n/g, '\r\n'), stakers.replace(/\n/g, '\r\n'), [ME]);
    expect(out.get(ME.toLowerCase())?.totalBase).toBe((11n * ONE) / 2n);
  });

  it('an address in neither file has an honest zero', () => {
    const out = satoriDayFigures(predictors, stakers, ['0x00000000000000000000000000000000000000CC']);
    expect(out.get('0x00000000000000000000000000000000000000cc')?.totalBase).toBe(0n);
  });
});

describe('satoriDropDays', () => {
  it('runs newest first, down to the first day of the drop', () => {
    expect(satoriDropDays(Date.parse('2026-11-04T10:00:00Z'))).toEqual(['2026-11-04', '2026-11-03', '2026-11-02']);
  });
});

describe('satoriDayStatuses', () => {
  const days = [{ totalBase: 3n * ONE }, { totalBase: 2n * ONE }, { totalBase: ONE }]; // newest first

  for (const fromFirstDay of [true, false]) {
    describe(fromFirstDay ? 'reaching the first day' : 'a later page', () => {
      it('nothing claimed, everything waits', () => {
        expect(satoriDayStatuses(days, 6n * ONE, 0n, fromFirstDay)).toEqual(['waiting', 'waiting', 'waiting']);
      });

      it('a claim covers the oldest days first', () => {
        expect(satoriDayStatuses(days, 6n * ONE, 3n * ONE, fromFirstDay)).toEqual(['waiting', 'claimed', 'claimed']);
        expect(satoriDayStatuses(days, 6n * ONE, 4n * ONE, fromFirstDay)).toEqual(['part', 'claimed', 'claimed']);
      });

      it('all claimed, whatever the rounding between drop and files', () => {
        expect(satoriDayStatuses(days, 6n * ONE, 6n * ONE - 5n, fromFirstDay)).toEqual(['claimed', 'claimed', 'claimed']);
      });
    });
  }

  it('a newest day the drop does not count yet is neither claimed nor to claim', () => {
    expect(satoriDayStatuses([{ totalBase: ONE }, ...days], 6n * ONE, 6n * ONE, true)).toEqual(['later', 'claimed', 'claimed', 'claimed']);
    expect(satoriDayStatuses([{ totalBase: ONE }, ...days], 6n * ONE, 3n * ONE, true)).toEqual(['later', 'waiting', 'claimed', 'claimed']);
  });

  it('past a day not read, it does not guess', () => {
    expect(satoriDayStatuses([days[0], null, days[2]], 6n * ONE, 0n, true)).toEqual(['waiting', null, null]);
  });

  it('a page not reaching the first day leaves its older sum out of it', () => {
    expect(satoriDayStatuses([days[0], days[1]], 6n * ONE, 3n * ONE, false)).toEqual(['waiting', 'claimed']);
  });
});

describe('a file that is not an audit file', () => {
  it('throws, so it is never kept as a day that earned nothing', () => {
    expect(() => satoriDayFigures('<html>Bad gateway</html>', stakers, [ME])).toThrow(/not an audit file/);
    expect(() => satoriDayFigures(predictors, '<html>Bad gateway</html>', [ME])).toThrow(/not an audit file/);
    expect(() => satoriDayFigures(predictors.split('\n')[0], stakers, [ME])).toThrow(/no rows/);
  });
});

describe('loadSatoriDays', () => {
  const STORE = new Map<string, unknown>();
  const reads = async (nowMs = Date.parse('2026-11-04T10:00:00Z'), dates = ['2026-11-03']) => {
    const out: SatoriDayRead[] = [];
    await loadSatoriDays({ addresses: [ME], dates, nowMs, onDay: (r) => out.push(r), isCancelled: () => false });
    return out;
  };
  beforeEach(() => {
    STORE.clear();
    setStorageForTests({
      get: async (key: string) => STORE.get(key),
      set: async (key: string, value: unknown) => void STORE.set(key, value),
    } as never);
  });
  afterEach(() => vi.unstubAllGlobals());

  const serve = (body: (url: string) => Response) => {
    const fetchMock = vi.fn(async (url: string) => body(url));
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };
  const files = (url: string) => new Response(url.includes('predictors') ? predictors : stakers, { status: 200 });

  it('downloads a finished day once', async () => {
    const fetchMock = serve(files);
    expect((await reads())[0].state).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const again = await reads();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(again[0]).toMatchObject({ state: 'ok' });
    if (again[0].state === 'ok') expect(again[0].figures.get(ME.toLowerCase())?.totalBase).toBe((11n * ONE) / 2n);
  });

  it('does not keep today', async () => {
    const fetchMock = serve(files);
    await reads(Date.parse('2026-11-03T10:00:00Z'));
    await reads(Date.parse('2026-11-03T10:00:00Z'));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('an error page fails the day and is not kept', async () => {
    let fetchMock = serve(() => new Response('<html>oops</html>', { status: 200 }));
    expect((await reads())[0].state).toBe('failed');
    fetchMock = serve(files);
    expect((await reads())[0].state).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a date the server does not have is missing', async () => {
    serve(() => new Response('', { status: 404 }));
    expect((await reads())[0].state).toBe('missing');
  });

  it('a damaged stored day is downloaded again', async () => {
    const fetchMock = serve(files);
    await reads();
    const key = [...STORE.keys()][0];
    STORE.set(key, { '2026-11-03': { n: 'junk', l: '1' } });
    expect((await reads())[0].state).toBe('ok');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
