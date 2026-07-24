// Contract between the Electrum WSS client and its consumers (provider, tx
// builder). Defined up front so the client implementation and the provider are
// written against the same interface and cannot drift.

/** Balance reply from blockchain.scripthash.get_balance. Values are in the
 *  smallest unit (sats) of the relevant asset (EVR and SATORI both use 8 dp). */
export interface ElectrumBalance {
  confirmed: number;
  unconfirmed: number;
}

/** Item from blockchain.scripthash.get_history. height<=0 means mempool. */
export interface ElectrumHistoryItem {
  tx_hash: string;
  height: number;
  fee?: number;
}

/** UTXO from blockchain.scripthash.listunspent. `asset` is null/absent for EVR
 *  outputs, or the asset name (e.g. "SATORI") for asset outputs. */
export interface ElectrumUtxo {
  tx_hash: string;
  tx_pos: number;
  height: number;
  value: number;
  asset?: string | null;
}

export interface ElectrumServerVersion {
  server: string;
  protocol: string;
}

/** Minimal transport the provider/tx-builder depend on. The concrete client
 *  (electrumClient.ts) owns wss connection, server failover and JSON-RPC id
 *  correlation; consumers only see request(). */
export interface ElectrumClient {
  /** Opens a wss connection, trying the configured servers in order until one
   *  succeeds. Resolves once connected (server.version handshake done). */
  connect(): Promise<void>;
  /** JSON-RPC call; rejects on Electrum error or timeout. */
  request<T = unknown>(method: string, params?: unknown[]): Promise<T>;
  /** Closes the socket; safe to call multiple times. */
  close(): void;
  isConnected(): boolean;
  /** wss:// URL of the currently connected server (for the Network UI). */
  endpoint(): string | null;
  /** OPTIONAL: retarget which chain's server pool this client resolves at connect
   *  time (Evrmore vs Ravencoin). Only the concrete wss client implements it; the
   *  in-memory test fakes omit it. Callers must use optional-call (`?.`). */
  setPoolChain?(chainId: string): void;
}

export type ElectrumClientFactory = () => ElectrumClient;
