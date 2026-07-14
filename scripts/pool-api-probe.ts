// READ-ONLY probe of the Satori central-server pool/lender GET endpoints, hitting
// the REAL server (network.satorinet.io) and printing the actual response SHAPES.
// This verifies the request/response contracts our src/services/satoriPool.ts
// relies on WITHOUT any server-state pollution: it only GETs. It never POSTs or
// DELETEs (which would register/deregister a wallet as a pool lender).
//
// Run: npx vite-node scripts/pool-api-probe.ts
//
// Endpoints probed (verified from the Magic Flutter reference, re-verified here
// against the live server):
//   GET /api/v1/pool/open                       -> list of open pools
//   GET /api/v1/auth/challenge?t=<ms>           -> { challenge }
//   GET /api/v1/lender/status?wallet_address=.. -> { pool_address, ... }

const BASE = 'https://network.satorinet.io';

// A public pool address is used ONLY as a read-only lender-status query subject.
// We do not sign anything or mutate any state. If none is known up-front we fall
// back to the first pool the /pool/open endpoint returns.
const FALLBACK_QUERY_ADDRESS = 'EXOSRToNP1nUuNyfDGA4Gvr1MTeALLGoXt';

function truncate(s: string, n = 600): string {
  return s.length > n ? `${s.slice(0, n)}… (${s.length} bytes total)` : s;
}

async function probe(label: string, url: string, headers?: Record<string, string>) {
  console.log(`\n=== ${label} ===`);
  console.log('GET', url);
  try {
    const res = await fetch(url, { headers });
    console.log('HTTP', res.status, res.statusText);
    console.log('content-type:', res.headers.get('content-type'));
    const text = await res.text();
    console.log('raw body:', truncate(text));
    try {
      const json = JSON.parse(text);
      console.log('parsed typeof:', Array.isArray(json) ? 'array' : typeof json);
      if (Array.isArray(json)) {
        console.log('array length:', json.length);
        if (json.length) console.log('first element keys:', Object.keys(json[0]));
      } else if (json && typeof json === 'object') {
        console.log('top-level keys:', Object.keys(json));
      }
      return json;
    } catch {
      console.log('(body is not valid JSON)');
      return null;
    }
  } catch (e) {
    console.log('REQUEST FAILED:', (e as Error).message);
    return null;
  }
}

async function main() {
  console.log('Satori pool/lender API probe — READ-ONLY, no funds, no state change');
  console.log('base:', BASE);

  // 1) Open pools.
  const pools = await probe('OPEN POOLS', `${BASE}/api/v1/pool/open`);

  // 2) Auth challenge (cache-busted, as the client will do). We only READ it.
  await probe('AUTH CHALLENGE', `${BASE}/api/v1/auth/challenge?t=${Date.now()}`, {
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Pragma: 'no-cache',
  });

  // 3) Lender status for a real pool address (or fallback). Read-only.
  let queryAddr = FALLBACK_QUERY_ADDRESS;
  if (Array.isArray(pools) && pools.length && typeof pools[0]?.address === 'string') {
    queryAddr = pools[0].address;
  } else if (pools && typeof pools === 'object') {
    const arr = (pools as Record<string, unknown>).pools;
    if (Array.isArray(arr) && arr.length && typeof (arr[0] as Record<string, unknown>)?.address === 'string') {
      queryAddr = (arr[0] as Record<string, string>).address;
    }
  }
  await probe(
    'LENDER STATUS',
    `${BASE}/api/v1/lender/status?wallet_address=${encodeURIComponent(queryAddr)}`,
  );

  console.log('\nprobe complete (no POST/DELETE issued).');
}

main().catch((e) => {
  console.error('PROBE FAILED:', e);
  process.exit(1);
});
