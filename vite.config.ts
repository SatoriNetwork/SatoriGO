import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = dirname(fileURLToPath(import.meta.url));

// Two build entries share one output: the popup (index.html) and the background
// service worker (src/background/index.ts), emitted as a stable `background.js`
// at the dist root so the MV3 manifest can point at it. `public/` still carries
// the manifest, icons and the content/inpage scripts verbatim, so
// `dist/chrome-extension` remains directly loadable via "Load unpacked".
export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist/chrome-extension',
    emptyOutDir: true,
    target: 'chrome110',
    assetsInlineLimit: 0,
    rollupOptions: {
      input: {
        main: resolve(rootDir, 'index.html'),
        background: resolve(rootDir, 'src/background/index.ts'),
      },
      output: {
        // The worker must sit at a stable root path; everything else keeps the
        // default hashed assets layout. A module worker may import emitted
        // chunks (shared with the popup), which MV3 allows.
        entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
});
