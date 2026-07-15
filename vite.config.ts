import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const rootDir = dirname(fileURLToPath(import.meta.url));

// Two build entries share one output: the popup (index.html) and the background
// service worker (src/background/index.ts), emitted as a stable `background.js`
// at the dist root so the MV3 manifest can point at it. `public/` carries the
// icons and the content/inpage scripts verbatim; the per-target manifest.json
// lives under `platforms/<target>/` and is copied in by `scripts/build.mjs`
// after this build, so `dist/<target>` becomes directly loadable via
// "Load unpacked". TARGET selects the output dir (default: chrome).
const target = process.env.TARGET || 'chrome';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: `dist/${target}`,
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
