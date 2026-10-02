import { describe, expect, it } from 'vitest';
import {
  TAO_RPC_METHODS,
  TAO_STATE_CALLS,
  TaoRpcError,
  isValidTaoNodeSet,
  parseRuntimeDigest,
  taoCallRefusal,
  taoGatewayBase,
  taoRpc,
} from './rpc';
import { TAO_PROFILE } from './tao';

const GW = 'https://network.satorigo.app';
const TOKEN = 'sgw_test_token';

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    seen.push({ url, init: init ?? {} });
    return answer(url, init ?? {});
  }) as typeof fetch;
  return { fetch: f, seen };
}

async function rejected(p: Promise<unknown>): Promise<TaoRpcError> {
  try {
    await p;
  } catch (e) {
    return e as TaoRpcError;
  }
  throw new Error('expected a rejection');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** Echo the request id back with `result`. */
function rpcAnswer(result: unknown) {
  return (_url: string, init: RequestInit) => {
    const req = JSON.parse(String(init.body)) as { id: number };
    return json({ jsonrpc: '2.0', id: req.id, result });
  };
}

const DIGEST = {
  specName: 'node-subtensor',
  specVersion: 470,
  transactionVersion: 1,
  genesis: '0x2f0555cc76fc2840a25a6ea3b9637146806f1f44b090c175ffde2a7e5ab36c03',
  ss58: 42,
  decimals: 9,
  symbol: 'TAO',
  existentialDeposit: '500',
  extrinsicVersion: 4,
  balanceBytes: 8,
  balances: { pallet: 5, transfer_allow_death: 0, transfer_keep_alive: 3, transfer_all: 4 },
  signedExtensions: [...TAO_PROFILE.signedExtensions],
  node: 'https://entrypoint-finney.opentensor.ai',
  finalizedHeight: 9169415,
};

describe('substrate/rpc allowlists', () => {
  it('mirror the gateway (gateway/server.mjs TAO_RPC_METHODS, TAO_STATE_CALLS)', () => {
    expect([...TAO_RPC_METHODS].sort()).toEqual(
      [
        'system_properties',
        'system_chain',
        'state_getRuntimeVersion',
        'chain_getBlockHash',
        'chain_getFinalizedHead',
        'chain_getHeader',
        'chain_getBlock',
        'state_getStorage',
        'state_call',
        'system_accountNextIndex',
        'payment_queryInfo',
        'payment_queryFeeDetails',
        'author_submitExtrinsic',
      ].sort(),
    );
    expect([...TAO_STATE_CALLS].sort()).toEqual(
      [
        'TransactionPaymentApi_query_info',
        'TransactionPaymentApi_query_fee_details',
        'TaggedTransactionQueue_validate_transaction',
        'AccountNonceApi_account_nonce',
      ].sort(),
    );
    // What the gateway explicitly does not relay.
    for (const m of ['state_getMetadata', 'state_getKeysPaged', 'author_submitAndWatchExtrinsic', 'system_dryRun', 'eth_call']) {
      expect(TAO_RPC_METHODS).not.toContain(m);
    }
  });

  it('taoCallRefusal names the problem; null for a good call', () => {
    expect(taoCallRefusal('state_getMetadata', [])).toMatch(/not allowed/);
    expect(taoCallRefusal('state_call', ['Metadata_metadata', '0x'])).toMatch(/state_call not allowed/);
    expect(taoCallRefusal('state_call', ['TransactionPaymentApi_query_info', 'zz'])).toMatch(/hex/);
    expect(taoCallRefusal('author_submitExtrinsic', ['0x'])).toMatch(/extrinsic/);
    expect(taoCallRefusal('chain_getBlock', [123])).toMatch(/hash/);
    expect(taoCallRefusal('chain_getFinalizedHead', [])).toBe(null);
    expect(taoCallRefusal('state_call', ['TaggedTransactionQueue_validate_transaction', '0x02aa', `0x${'11'.repeat(32)}`])).toBe(null);
  });

  it('node set and gateway URL are validated', () => {
    expect(isValidTaoNodeSet('main')).toBe(true);
    expect(isValidTaoNodeSet('../evm')).toBe(false);
    expect(isValidTaoNodeSet('')).toBe(false);
    expect(taoGatewayBase(`${GW}/`, 'main')).toBe(`${GW}/tao/main`);
    expect(() => taoGatewayBase('http://example.com', 'main')).toThrow(/https/);
    expect(() => taoGatewayBase('', 'main')).toThrow(/gateway/);
    expect(() => taoGatewayBase(GW, 'a/b')).toThrow(/node set/);
    expect(taoGatewayBase('http://127.0.0.1:8080', 'test')).toBe('http://127.0.0.1:8080/tao/test');
  });
});

describe('substrate/rpc call', () => {
  it('POSTs one JSON-RPC object to /tao/<set> with the client token and returns the result', async () => {
    const { fetch, seen } = fakeFetch(rpcAnswer('0xabc'));
    const rpc = taoRpc(GW, TOKEN, 'main', { fetch });
    await expect(rpc.call('chain_getFinalizedHead', [])).resolves.toBe('0xabc');
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(`${GW}/tao/main`);
    expect(seen[0].init.method).toBe('POST');
    expect((seen[0].init.headers as Record<string, string>)['X-Satori-Client']).toBe(TOKEN);
    expect(seen[0].init.credentials).toBe('omit');
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ jsonrpc: '2.0', method: 'chain_getFinalizedHead', params: [] });
    expect(Array.isArray(body)).toBe(false);
  });

  it('a null result (absent storage key) is a result, not an error', async () => {
    const { fetch } = fakeFetch(rpcAnswer(null));
    const rpc = taoRpc(GW, TOKEN, 'main', { fetch });
    await expect(rpc.call('state_getStorage', [`0x${'26'.repeat(80)}`])).resolves.toBe(null);
  });

  it('no token: no custom header (Origin authenticates the extension)', async () => {
    const { fetch, seen } = fakeFetch(rpcAnswer(1));
    await taoRpc(GW, '', 'main', { fetch }).call('system_properties', []);
    expect((seen[0].init.headers as Record<string, string>)['X-Satori-Client']).toBeUndefined();
  });

  it('refuses a method the gateway drops without making a request', async () => {
    const { fetch, seen } = fakeFetch(rpcAnswer(1));
    const rpc = taoRpc(GW, TOKEN, 'main', { fetch });
    const err = await rejected(rpc.call('state_getMetadata', []));
    expect(err).toBeInstanceOf(TaoRpcError);
    expect(err.code).toBe('refused-locally');
    expect(seen).toHaveLength(0);
  });

  it('a JSON-RPC error is code rpc with the node code; the request body never appears in the message', async () => {
    const hex = `0x${'ab'.repeat(145)}`;
    const { fetch } = fakeFetch((_u, init) => {
      const req = JSON.parse(String(init.body));
      return json({ jsonrpc: '2.0', id: req.id, error: { code: 1010, message: 'Invalid Transaction', data: 'Transaction has a bad signature' } });
    });
    const rpc = taoRpc(GW, TOKEN, 'main', { fetch });
    const err = await rejected(rpc.call('payment_queryInfo', [hex]));
    expect(err).toBeInstanceOf(TaoRpcError);
    expect(err.code).toBe('rpc');
    expect(err.rpcCode).toBe(1010);
    expect(err.maybeSent).toBe(false);
    expect(err.message).toMatch(/bad signature/);
    expect(err.message).not.toContain('abab');
  });

  it('the gateway refusing params (HTTP 400 with a JSON-RPC error) is an rpc error', async () => {
    const { fetch } = fakeFetch((_u, init) => {
      const req = JSON.parse(String(init.body));
      return json({ jsonrpc: '2.0', id: req.id, error: { code: -32602, message: 'bad params for state_getStorage' } }, 400);
    });
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch })
      .call('state_getStorage', ['0x00']));
    expect(err.code).toBe('rpc');
    expect(err.status).toBe(400);
    expect(err.rpcCode).toBe(-32602);
  });

  it('429 is rate-limited', async () => {
    const { fetch } = fakeFetch(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limited' } }, 429));
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch })
      .call('chain_getFinalizedHead', []));
    expect(err.code).toBe('rate-limited');
  });

  it('an answer for another id is refused', async () => {
    const { fetch } = fakeFetch(() => json({ jsonrpc: '2.0', id: 999999, result: '0x' }));
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch })
      .call('chain_getFinalizedHead', []));
    expect(err.code).toBe('format');
  });

  it('HTML on a 502 for a read is an http error, not maybeSent', async () => {
    const { fetch } = fakeFetch(() => new Response('<html>bad gateway</html>', { status: 502 }));
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch })
      .call('chain_getFinalizedHead', []));
    expect(err.code).toBe('http');
    expect(err.maybeSent).toBe(false);
  });

  it('submit: 504 (the gateway timed out on its node) is maybeSent, never a plain failure', async () => {
    const { fetch } = fakeFetch((_u, init) => {
      const req = JSON.parse(String(init.body));
      return json({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'submit timed out; the extrinsic may still be in the pool, check its hash' } }, 504);
    });
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch })
      .call('author_submitExtrinsic', ['0x1234']));
    expect(err).toBeInstanceOf(TaoRpcError);
    expect(err.maybeSent).toBe(true);
    expect(err.status).toBe(504);
  });

  it('submit: a 502 (every node failed) and a transport failure are maybeSent', async () => {
    const f502 = fakeFetch(() => json({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'tao nodes unreachable' } }, 502));
    const e1 = await rejected(taoRpc(GW, TOKEN, 'main', { fetch: f502.fetch })
      .call('author_submitExtrinsic', ['0x1234']));
    expect(e1.maybeSent).toBe(true);
    const fNet = fakeFetch(() => {
      throw new TypeError('Failed to fetch');
    });
    const e2 = await rejected(taoRpc(GW, TOKEN, 'main', { fetch: fNet.fetch })
      .call('author_submitExtrinsic', ['0x1234']));
    expect(e2.code).toBe('transport');
    expect(e2.maybeSent).toBe(true);
  });

  it('submit: a node answering with a JSON-RPC error is a definite refusal (not maybeSent)', async () => {
    const { fetch } = fakeFetch((_u, init) => {
      const req = JSON.parse(String(init.body));
      return json({ jsonrpc: '2.0', id: req.id, error: { code: 1010, message: 'Invalid Transaction', data: 'Inability to pay some fees' } });
    });
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch })
      .call('author_submitExtrinsic', ['0x1234']));
    expect(err.code).toBe('rpc');
    expect(err.maybeSent).toBe(false);
  });

  it('times out with code timeout; a read transport failure is not maybeSent', async () => {
    const { fetch } = fakeFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch, timeoutMs: 20 })
      .call('chain_getFinalizedHead', []));
    expect(err.code).toBe('timeout');
    expect(err.maybeSent).toBe(false);
  });

  it("the caller's abort is code aborted", async () => {
    const { fetch } = fakeFetch(
      (_u, init) =>
        new Promise<Response>((_res, rej) => {
          init.signal?.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const ctrl = new AbortController();
    const p = taoRpc(GW, TOKEN, 'main', { fetch }).call('chain_getFinalizedHead', [], ctrl.signal);
    ctrl.abort();
    const err = await rejected(p);
    expect(err.code).toBe('aborted');
  });
});

describe('substrate/rpc runtime', () => {
  it('GETs /tao/<set>/runtime with the token and returns a typed digest', async () => {
    const { fetch, seen } = fakeFetch(() => json(DIGEST));
    const d = await taoRpc(GW, TOKEN, 'main', { fetch }).runtime();
    expect(seen[0].url).toBe(`${GW}/tao/main/runtime`);
    expect(seen[0].init.method).toBe('GET');
    expect((seen[0].init.headers as Record<string, string>)['X-Satori-Client']).toBe(TOKEN);
    expect(d.existentialDeposit).toBe(500n);
    expect(d.specVersion).toBe(470);
    expect(d.balances.transfer_keep_alive).toBe(3);
    expect(d.node).toBe('https://entrypoint-finney.opentensor.ai');
    expect(d.finalizedHeight).toBe(9169415);
  });

  it('a digest this engine cannot sign for (v5 extrinsic, u128, missing field) is a format error', () => {
    expect(() => parseRuntimeDigest({ ...DIGEST, extrinsicVersion: 5 })).toThrow(TaoRpcError);
    expect(() => parseRuntimeDigest({ ...DIGEST, balanceBytes: 16 })).toThrow(TaoRpcError);
    const noGenesis: Record<string, unknown> = { ...DIGEST };
    delete noGenesis.genesis;
    expect(() => parseRuntimeDigest(noGenesis)).toThrow(TaoRpcError);
    expect(() => parseRuntimeDigest('nope')).toThrow(TaoRpcError);
  });

  it('non-2xx is an http error', async () => {
    const { fetch } = fakeFetch(() => json({ error: 'not found' }, 404));
    const err = await rejected(taoRpc(GW, TOKEN, 'main', { fetch })
      .runtime());
    expect(err.code).toBe('http');
    expect(err.status).toBe(404);
  });
});
