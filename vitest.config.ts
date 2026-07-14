import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Real scrypt (N=2^17, ~128 MB) runs in vault/liveWallet tests; under full
    // parallel load the default 5 s per-test timeout flakes. Do NOT lower N.
    testTimeout: 30_000,
  },
});
