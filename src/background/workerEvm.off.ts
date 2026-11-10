// '#worker-evm' in a build without --evm: the worker has no EVM engine, and
// window.ethereum answers every request with "no EVM engine". See workerEvm.ts.
export async function loadWorkerEvm(): Promise<typeof import('../services/chain/evm') | null> {
  return null;
}
