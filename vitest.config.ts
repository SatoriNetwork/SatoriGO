import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Mirror vite.config.ts: the EVM build flag defaults to OFF in tests too, so a
  // test that reaches the flag sees exactly what a shipped package sees. The
  // EVM modules' own tests import them directly and are unaffected.
  define: {
    __EVM_ENABLED__: JSON.stringify(process.env.EVM_ENABLED === '1'),
    // No provider key in tests: the registry's public endpoints are what the
    // fakes answer for; live checks that need a key read it from the env.
    __ALCHEMY_API_KEY__: JSON.stringify(process.env.ALCHEMY_API_KEY ?? ''),
    // No gateway in tests either: the URL builders take the gateway as an
    // explicit argument where the gateway shape is what is under test.
    __EVM_GATEWAY_URL__: JSON.stringify(process.env.EVM_GATEWAY_URL ?? ''),
    __EVM_CLIENT_TOKEN__: JSON.stringify(process.env.EVM_CLIENT_TOKEN ?? ''),
  },
  test: {
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Real scrypt (N=2^17, ~128 MB) runs in vault/liveWallet tests; under full
    // parallel load the default 5 s per-test timeout flakes. Do NOT lower N.
    testTimeout: 30_000,
  },
});
