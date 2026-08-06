# Build instructions for add-on store reviewers

Satori GO, Firefox add-on ID `satori-go@satorinet.io`.

This source package contains **complete, original, human-written source only**.
There is no minified, concatenated, obfuscated or otherwise machine-generated code
in it. The submitted add-on package is produced from these sources by the build
below. Minification comes from Vite during that build, which is why this source
package is supplied.

The same source is public at <https://github.com/SatoriNetwork/SatoriGO>.

## Build environment

- Node.js 24.x (built and verified with 24.13.0)
- npm 11.x (built and verified with 11.6.2)
- No native modules, no compilers, no platform-specific steps. Linux, macOS and
  Windows all work.

All dependencies are installed from the public npm registry through
`package-lock.json`. Nothing is fetched from anywhere else.

## Steps to reproduce the submitted package

```sh
npm ci                  # installs the exact pinned dependencies from package-lock.json
npm run build:firefox   # runs: node scripts/build.mjs --target=firefox
```

The unpacked extension is written to `dist/firefox`. **The submitted add-on is the
contents of `dist/firefox`, zipped.** Running `npm run package:firefox` produces
that zip directly, at `release/satori-go-firefox.zip`.

`scripts/build.mjs` type-checks the project, runs the Vite build, then copies
`platforms/firefox/manifest.json` and any files under
`platforms/firefox/overrides/` into `dist/firefox`.

Chrome and Edge are built the same way with `--target=chrome` / `--target=edge`.

## Mapping the built files back to source

| File in the add-on | Comes from |
| --- | --- |
| `assets/main-*.js` | `src/main.tsx` and everything it imports (the wallet UI) |
| `assets/approvals-*.js` | `src/screens/dapp/DappApproval.tsx` (the dApp approval view) |
| `background.js` | `src/background/index.ts` (MV3 service worker) |
| `assets/main-*.css` | `src/styles/*.css` |
| `content.js`, `inpage.js` | `public/content.js`, `public/inpage.js` (copied verbatim, not built) |
| `icons/*`, `assets/*.woff2`, `assets/*.png`, `assets/*.svg` | `public/icons/*`, `src/assets/*` |
| `manifest.json` | `platforms/<target>/manifest.json` |

Filename hashes (for example `main-iXquaEEW.js`) are content hashes produced by
Vite, so they change if the input changes.

## One file that may look generated, and why it is not code

`src/assets/evrmore-logo.svg` is a single long line. It is **not** minified code:
it is the Evrmore vector logo, an image asset exported from a vector graphics
editor (hence the `.cls-N` class names and the gradient definitions), and the
export writes it on one line. It contains two `<path>` elements and no
JavaScript.

It is deliberately left exactly as exported, because the build embeds this file
byte for byte and derives the output filename from its content hash. Reformatting
it would change that hash and the produced package would no longer match the one
submitted.

Every other file here is hand-written source. No file in this package contains
minified, concatenated or obfuscated JavaScript.

## Notes

- The wallet is non-custodial. Keys are generated and stored on the user's own
  device, encrypted with AES-256-GCM (`src/services/chain/vault.ts`), and are
  never transmitted anywhere.
- Requested permissions: `storage` (persist the local wallet and settings),
  `alarms` (periodic background balance refresh), `notifications` (alert on
  incoming transactions).
- Network access: public Evrmore and Ravencoin ElectrumX servers over secure
  WebSocket for balances, history and broadcasting signed transactions, plus the
  HTTPS hosts in `host_permissions` for public price and network statistics.
- No analytics, tracking or telemetry of any kind.
- Testing needs no account and no funds: choose "Create wallet" on first run and
  a new wallet is generated locally. A new wallet simply shows a zero balance.

Contact: satori@satorinet.io
