import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SATORI_NETWORK_BASE,
  fetchOpenPools,
  getLenderStatus,
  joinPool,
  leavePool,
  sortPoolsForDisplay,
  filterPools,
  paginatePools,
  POOLS_PER_PAGE,
  SatoriOfflineError,
  SatoriServerError,
  type PoolInfo,
} from './satoriPool';
const SIGNATURE = '0xsignature';
const PUBKEY = '02abc';
const signer = vi.fn((_message: string) => ({ aliasPubkey: PUBKEY, signature: SIGNATURE }));
const TOKEN = 'access-token-1';

/** Minimal Response-like stub. status/text drive parseJsonOk; ok mirrors status. */
function res(status: number, body: string): Response {
  return {
    status,
    statusText: `HTTP ${status}`,
    ok: status >= 200 && status < 300,
    text: async () => body,
    headers: { get: () => 'application/json' },
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fetchOpenPools', () => {
  it('GETs /api/v1/pool/open, reads {pools}, coerces + sorts by commission asc', async () => {
    const spy = vi.fn(async (_url: unknown, _init?: RequestInit) =>
      res(
        200,
        JSON.stringify({
          pools: [
            { address: 'Ehigh', alias: 'Expensive', commission: 99 },
            { address: 'Elow', alias: null, commission: 10 },
            { address: 'Emid', alias: 'Mid', commission: 40 },
          ],
        }),
      ),
    );
    vi.stubGlobal('fetch', spy);

    const pools = await fetchOpenPools();
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(`${SATORI_NETWORK_BASE}/api/v1/pool/open`);
    expect(init?.method).toBe('GET');
    // Sorted ascending by commission; alias null preserved.
    expect(pools.map((p) => p.address)).toEqual(['Elow', 'Emid', 'Ehigh']);
    expect(pools[0].alias).toBeNull();
    expect(pools[0].commission).toBe(10);
  });

  it('tolerates a bare array response and drops records with no address', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        res(200, JSON.stringify([{ address: 'Eok', commission: 5 }, { alias: 'no-addr', commission: 1 }])),
      ),
    );
    const pools = await fetchOpenPools();
    expect(pools).toHaveLength(1);
    expect(pools[0].address).toBe('Eok');
  });

  it('throws SatoriServerError on HTTP 500', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(500, 'boom')));
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriServerError);
  });

  it('throws SatoriServerError on malformed JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => res(200, 'not-json{')));
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriServerError);
  });

  it('maps a network failure to SatoriOfflineError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriOfflineError);
  });

  it('maps an AbortError (timeout) to SatoriOfflineError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        throw e;
      }),
    );
    await expect(fetchOpenPools()).rejects.toBeInstanceOf(SatoriOfflineError);
  });
});

describe('getLenderStatus', () => {
  it('GETs status for the address and parses pool_address + is_pool', async () => {
    const spy = vi.fn(async (_url: unknown) =>
      res(200, JSON.stringify({ pool_address: 'Epool', pool_id: 3, is_pool: false })),
    );
    vi.stubGlobal('fetch', spy);

    const st = await getLenderStatus('Emine');
    expect(st.poolAddress).toBe('Epool');
    expect(st.isPool).toBe(false);
    expect(String(spy.mock.calls[0][0])).toBe(
      `${SATORI_NETWORK_BASE}/api/v1/lender/status?wallet_address=Emine`,
    );
  });

  it('reports poolAddress null when the server returns null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => res(200, JSON.stringify({ pool_address: null, is_pool: true }))),
    );
    const st = await getLenderStatus('Emine');
    expect(st.poolAddress).toBeNull();
    expect(st.isPool).toBe(true);
  });
});

/** Login answers with a token; `lend` answers the lend call. */
function server(lend: Response, login: Response = res(200, JSON.stringify({ access_token: TOKEN }))) {
  return vi.fn(async (url: unknown, _init?: RequestInit) => (String(url).endsWith('/auth/login') ? login : lend));
}

describe('joinPool', () => {
  it('logs in with a signed timestamp, then POSTs /lender/lend with the bearer token', async () => {
    const spy = server(res(200, '{}'));
    vi.stubGlobal('fetch', spy);
    const before = Date.now() / 1000;

    await joinPool('0xpool', signer);

    expect(spy).toHaveBeenCalledTimes(2);
    const [loginUrl, loginInit] = spy.mock.calls[0];
    expect(loginUrl).toBe(`${SATORI_NETWORK_BASE}/api/v1/auth/login`);
    expect(loginInit?.method).toBe('POST');
    const loginHeaders = loginInit?.headers as Record<string, string>;
    expect(loginHeaders['alias-pubkey']).toBe(PUBKEY);
    expect(loginHeaders.signature).toBe(SIGNATURE);
    expect(Number(loginHeaders.message)).toBeGreaterThanOrEqual(before);
    expect(signer).toHaveBeenLastCalledWith(loginHeaders.message);

    const [lendUrl, lendInit] = spy.mock.calls[1];
    expect(lendUrl).toBe(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`);
    expect(lendInit?.method).toBe('POST');
    const headers = lendInit?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(lendInit?.body as string)).toEqual({ pool_address: '0xpool', source: 'satori go' });
  });

  it('does not reach the lend call when the login is refused', async () => {
    const spy = server(res(200, '{}'), res(401, '{"detail":"Invalid signature"}'));
    vi.stubGlobal('fetch', spy);
    await expect(joinPool('0xpool', signer)).rejects.toThrow(/Invalid signature/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a login answer without a token', async () => {
    vi.stubGlobal('fetch', server(res(200, '{}'), res(200, '{}')));
    await expect(joinPool('0xpool', signer)).rejects.toBeInstanceOf(SatoriServerError);
  });

  it('says why the server refused the join', async () => {
    vi.stubGlobal('fetch', server(res(403, '{"detail":"Pool is not open"}')));
    await expect(joinPool('0xpool', signer)).rejects.toThrow(/HTTP 403\)\. Pool is not open/);
  });

  it('throws SatoriServerError when the lend POST returns >= 400 without a reason', async () => {
    vi.stubGlobal('fetch', server(res(500, 'oops')));
    await expect(joinPool('0xpool', signer)).rejects.toBeInstanceOf(SatoriServerError);
  });
});

describe('leavePool', () => {
  it('logs in, then DELETEs /lender/lend with the bearer token and no body', async () => {
    const spy = server(res(200, '{}'));
    vi.stubGlobal('fetch', spy);

    await leavePool(signer);

    const [delUrl, delInit] = spy.mock.calls[1];
    expect(delUrl).toBe(`${SATORI_NETWORK_BASE}/api/v1/lender/lend`);
    expect(delInit?.method).toBe('DELETE');
    expect(delInit?.body).toBeUndefined();
    expect((delInit?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

// ---- pure UI helpers: sort / filter / paginate ------------------------------

/** Build a minimal PoolInfo for the helper tests below. */
function pool(address: string, alias: string | null, commission: number): PoolInfo {
  return { address, alias, commission };
}

describe('sortPoolsForDisplay', () => {
  it('puts named pools before unnamed ones, commission ascending within each group', () => {
    const pools = [
      pool('Eunnamed-hi', null, 5),
      pool('Enamed-hi', 'Zebra Pool', 30),
      pool('Eunnamed-lo', null, 1),
      pool('Enamed-lo', 'Alpha Pool', 10),
    ];
    const sorted = sortPoolsForDisplay(pools);
    expect(sorted.map((p) => p.address)).toEqual([
      'Enamed-lo', // named, commission 10
      'Enamed-hi', // named, commission 30
      'Eunnamed-lo', // unnamed, commission 1
      'Eunnamed-hi', // unnamed, commission 5
    ]);
  });

  it('does not mutate the input array', () => {
    const pools = [pool('Eb', null, 2), pool('Ea', null, 1)];
    const copy = [...pools];
    sortPoolsForDisplay(pools);
    expect(pools).toEqual(copy);
  });

  it('treats an empty-string alias the same as null (unnamed)', () => {
    // coercePool already normalizes '' -> null, but the helper itself should be
    // defensive in case a caller constructs a PoolInfo directly.
    const pools = [pool('Ewith-alias', 'Named', 50), pool('Eempty-alias', '', 1)];
    const sorted = sortPoolsForDisplay(pools);
    expect(sorted[0].address).toBe('Ewith-alias');
    expect(sorted[1].address).toBe('Eempty-alias');
  });
});

describe('filterPools', () => {
  const pools = [
    pool('ENamastePoolAddr123', 'Namaste Club', 21),
    pool('EOtherPoolAddrABC', 'Other Pool', 5),
    pool('EUnnamedPoolXyz', null, 15),
  ];

  it('empty query returns the full list unchanged', () => {
    expect(filterPools(pools, '')).toEqual(pools);
    expect(filterPools(pools, '   ')).toEqual(pools);
  });

  it('matches by alias, case-insensitive substring', () => {
    const result = filterPools(pools, 'namaste');
    expect(result.map((p) => p.address)).toEqual(['ENamastePoolAddr123']);
  });

  it('matches by address, case-insensitive substring', () => {
    const result = filterPools(pools, 'unnamedpoolxyz');
    expect(result.map((p) => p.address)).toEqual(['EUnnamedPoolXyz']);
  });

  it('matches partial substrings anywhere in alias or address', () => {
    const result = filterPools(pools, 'POOL');
    expect(result.map((p) => p.address).sort()).toEqual(
      ['ENamastePoolAddr123', 'EOtherPoolAddrABC', 'EUnnamedPoolXyz'].sort(),
    );
  });

  it('returns an empty array when nothing matches', () => {
    expect(filterPools(pools, 'zzz-no-match')).toEqual([]);
  });

  it('a null alias never matches a non-empty query (no crash on null)', () => {
    const result = filterPools(pools, 'nonexistentalias');
    expect(result).toEqual([]);
  });
});

describe('paginatePools', () => {
  // 25 unnamed pools with distinct commissions 0..24 so sort order is stable
  // and predictable for slicing assertions.
  const pools = Array.from({ length: 25 }, (_, i) => pool(`Epool-${String(i).padStart(2, '0')}`, null, i));

  it('defaults to 10 per page (POOLS_PER_PAGE) and reports totalPages', () => {
    expect(POOLS_PER_PAGE).toBe(10);
    const p1 = paginatePools(pools, 1);
    expect(p1.items).toHaveLength(10);
    expect(p1.total).toBe(25);
    expect(p1.totalPages).toBe(3);
    expect(p1.page).toBe(1);
    expect(p1.items[0].address).toBe('Epool-00');
    expect(p1.items[9].address).toBe('Epool-09');
  });

  it('slices the middle page correctly', () => {
    const p2 = paginatePools(pools, 2);
    expect(p2.items).toHaveLength(10);
    expect(p2.items[0].address).toBe('Epool-10');
    expect(p2.items[9].address).toBe('Epool-19');
  });

  it('the last page holds the remainder (25 % 10 = 5)', () => {
    const p3 = paginatePools(pools, 3);
    expect(p3.items).toHaveLength(5);
    expect(p3.items[0].address).toBe('Epool-20');
    expect(p3.items[4].address).toBe('Epool-24');
  });

  it('clamps an out-of-range page down to the last valid page', () => {
    const p = paginatePools(pools, 999);
    expect(p.page).toBe(3);
    expect(p.items).toHaveLength(5);
  });

  it('clamps a page below 1 up to page 1', () => {
    const p = paginatePools(pools, 0);
    expect(p.page).toBe(1);
    expect(p.items[0].address).toBe('Epool-00');
  });

  it('an empty list yields exactly 1 (empty) page, never 0', () => {
    const p = paginatePools([], 1);
    expect(p.totalPages).toBe(1);
    expect(p.page).toBe(1);
    expect(p.items).toEqual([]);
    expect(p.total).toBe(0);
  });

  it('sorts named-first before paginating (named pool on page 1 even with high commission)', () => {
    const mixed = [
      ...Array.from({ length: 12 }, (_, i) => pool(`Eun-${i}`, null, i)), // unnamed, commission 0..11
      pool('Enamed-highfee', 'High Fee Pool', 90), // named but expensive
    ];
    const p1 = paginatePools(mixed, 1);
    // Named pool sorts first regardless of its high commission.
    expect(p1.items[0].address).toBe('Enamed-highfee');
  });

  it('respects a custom page size', () => {
    const p = paginatePools(pools, 1, 5);
    expect(p.items).toHaveLength(5);
    expect(p.totalPages).toBe(5);
  });
});
