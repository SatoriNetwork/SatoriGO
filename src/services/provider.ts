// Wallet data-provider contract.
//
// The real implementation is `ElectrumWalletDataProvider` (src/services/chain/
// electrumProvider.ts), which reads the live Evrmore chain over Electrum/wss.
// This module only declares the shape it satisfies, so the chain layer and the
// UI depend on an interface rather than a concrete client.

import type {
  Asset,
  AssetBalance,
  NetworkStatus,
  Transaction,
  TransactionRequest,
  TransactionSimulation,
} from '../types/domain';

export interface WalletDataProvider {
  getNetworkStatus(): Promise<NetworkStatus>;
  getBalances(address: string): Promise<AssetBalance[]>;
  getTransactions(address: string): Promise<Transaction[]>;
  getAssets(): Promise<Asset[]>;
  simulateTransaction(request: TransactionRequest): Promise<TransactionSimulation>;
  submitTransaction(request: TransactionRequest): Promise<TransactionSimulation>;
}

/** Thrown when the wallet cannot reach the network (Electrum unreachable). */
export class NetworkOfflineError extends Error {
  constructor() {
    super('Network is offline');
    this.name = 'NetworkOfflineError';
  }
}
