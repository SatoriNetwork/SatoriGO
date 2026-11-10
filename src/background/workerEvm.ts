// The EVM engine for the background worker, imported STATICALLY.
//
// Chrome refuses import() inside an MV3 service worker ("import() is
// disallowed on ServiceWorkerGlobalScope"), so the worker cannot reach the
// engine through loadEvmModules() the way extension pages do. The build
// resolves '#worker-evm' to this file only with --evm (vite.config.ts), and to
// workerEvm.off.ts otherwise, so a package built without EVM still carries no
// EVM module (the evmGuard plugin checks).
import * as evm from '../services/chain/evm';

export async function loadWorkerEvm(): Promise<typeof evm | null> {
  return evm;
}
