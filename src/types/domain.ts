// Domain models shared across the UI, stores and the wallet data-provider
// contract (src/services/provider.ts). The concrete provider is
// ElectrumWalletDataProvider, which reads the live Evrmore chain over Electrum;
// these are the plain shapes it returns.

export type AssetId = 'EVR' | 'SATORI';

export interface Asset {
  id: AssetId;
  symbol: string;
  name: string;
  /** 'native' = chain coin, 'evr-asset' = asset issued on the EVRmore chain. */
  kind: 'native' | 'evr-asset';
  decimals: number;
  priceUsd: number;
  change24hPct: number;
  description: string;
}

export interface AssetBalance {
  assetId: AssetId;
  amount: number;
}

export type TxStatus = 'pending' | 'confirmed' | 'failed';
export type TxDirection = 'in' | 'out';

export interface Transaction {
  id: string;
  txid: string;
  assetId: AssetId;
  direction: TxDirection;
  amount: number;
  /** Fees on EVRmore are always paid in EVR, also for asset transfers. */
  feeEvr: number;
  /** Counterparty address. */
  address: string;
  status: TxStatus;
  timestamp: number;
  blockHeight?: number;
  errorMessage?: string;
  note?: string;
}

export type NetworkId = 'mainnet' | 'testnet' | 'custom';
export type NetworkState = 'connected' | 'connecting' | 'offline' | 'degraded';

export interface NetworkStatus {
  networkId: NetworkId;
  state: NetworkState;
  latencyMs: number;
  blockHeight: number;
  serverVersion: string;
  updatedAt: number;
}

export interface TransactionRequest {
  from: string;
  to: string;
  assetId: AssetId;
  amount: number;
}

export interface TransactionSimulation {
  ok: boolean;
  txid?: string;
  feeEvr: number;
  estimatedSeconds: number;
  errorCode?: 'invalid-address' | 'insufficient-funds' | 'insufficient-fee' | 'network-rejected' | 'offline';
  errorMessage?: string;
}
