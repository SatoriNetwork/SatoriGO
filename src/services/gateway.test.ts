// The non-EVM view of the Satori GO gateway. It exists so code that ships in
// EVERY build (prices) can read the gateway config without importing
// src/services/chain/evm/, which is compiled out of a store build.
import { describe, expect, it } from 'vitest';

import { GATEWAY_URL, HAS_GATEWAY, gatewayHeaders, gatewayUrl } from './gateway';
import { evmGatewayHeaders } from './chain/evm/endpoints';

const GATEWAY = 'https://network.satorigo.app';

describe('gateway config', () => {
  it('HAS_GATEWAY is exactly "a gateway URL is configured"', () => {
    // A build-time literal in the bundle; here it is whatever vitest.config.ts
    // defined (empty unless EVM_GATEWAY_URL is set). The invariant is that the
    // two never disagree, because prices branch on HAS_GATEWAY and then build
    // their URL from GATEWAY_URL.
    expect(HAS_GATEWAY).toBe(GATEWAY_URL !== '');
    expect(gatewayUrl()).toBe(GATEWAY_URL);
    // Never a trailing slash: scripts/evm-hosts.mjs normalises it at build time,
    // so `${GATEWAY_URL}/prices` can be built by concatenation.
    expect(GATEWAY_URL.endsWith('/')).toBe(false);
  });

  it('the client token rides as X-Satori-Client ONLY when both a gateway and a token are configured', () => {
    expect(gatewayHeaders('sgw_tok', GATEWAY)).toEqual({ 'X-Satori-Client': 'sgw_tok' });
    // No gateway: no custom header, so a dev build adds no CORS preflight to a
    // third-party host.
    expect(gatewayHeaders('sgw_tok', '')).toEqual({});
    expect(gatewayHeaders('', GATEWAY)).toEqual({});
    expect(gatewayHeaders('', '')).toEqual({});
  });

  it('sends the SAME header as the EVM routes: one gateway, one auth story', () => {
    for (const [token, gateway] of [
      ['sgw_tok', GATEWAY],
      ['sgw_tok', ''],
      ['', GATEWAY],
      ['', ''],
    ] as const) {
      expect(gatewayHeaders(token, gateway)).toEqual(evmGatewayHeaders(token, gateway));
    }
  });
});
