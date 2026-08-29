// LIVE read check for phase 2 (the EVM rollout plan §3, "done when: a
// known funded address reports the balance a block explorer shows, natively and
// for one ERC-20, with every figure exact in base units").
//
// Opt-in only: `EVM_LIVE=1 npx vitest run src/services/chain/evm/live.test.ts`.
// The normal suite skips it (no network in unit tests). It READS; nothing here
// can sign or send.
//
// Method: for each registered chain, read through the wallet's own stack
// (createEvmProvider -> rpc client -> erc20 codec) and compare EXACTLY, at a
// pinned block, against an INDEPENDENT public RPC (a different operator) and,
// where one is reachable without a key, an explorer API. Two operators
// agreeing on the same wei figure at the same block is the check; a single
// source agreeing with itself would prove nothing.

import { describe, expect, it } from 'vitest';
import { EVM_CHAINS, evmChainByKey } from './chains';
import { createEvmProvider } from './evmProvider';
import { EvmRpcError, createEvmRpcClient, fromHexData, fromQuantity, toQuantity } from './rpc';
import { decodeErc20Calldata, decodeUint256, encodeBalanceOf } from './erc20';
import { toChecksumAddress } from './keys';

const LIVE = process.env.EVM_LIVE === '1';

/** Independent operators, one per chain. Not the registry hosts on purpose. */
const INDEPENDENT_RPC: Record<string, string> = {
  base: 'https://base-rpc.publicnode.com',
  bsc: 'https://bsc-rpc.publicnode.com',
};

/** Addresses that certainly hold the native coin (contracts / burn address). */
const NATIVE_HOLDERS: Record<string, string> = {
  base: '0x4200000000000000000000000000000000000006', // WETH predeploy
  bsc: '0x000000000000000000000000000000000000dEaD',
};

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rawRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: unknown; error?: unknown };
  if (json.error) throw new Error(`${url} ${method}: ${JSON.stringify(json.error)}`);
  return json.result;
}

describe.skipIf(!LIVE)('EVM live read check (EVM_LIVE=1)', () => {
  for (const chain of EVM_CHAINS) {
    describe(chain.displayName, () => {
      const independent = INDEPENDENT_RPC[chain.key];
      const token = chain.defaultTokens?.[0];

      it('network status is connected with a fresh tip', async () => {
        const provider = createEvmProvider(chain);
        const status = await provider.getNetworkStatus();
        console.log(`[${chain.key}] status`, JSON.stringify(status));
        expect(status.state).toBe('connected');
        expect(status.blockHeight).toBeGreaterThan(0);
        expect(status.tipTime).not.toBe(null);
        expect(Math.abs(Date.now() - (status.tipTime ?? 0))).toBeLessThan(10 * 60_000);
      }, 30_000);

      it('native balance at a pinned block equals an independent operator, exact in wei', async () => {
        const client = createEvmRpcClient(chain);
        const latest = fromQuantity(await client.call('eth_blockNumber'));
        const tag = toQuantity(latest - 5n);
        const holder = NATIVE_HOLDERS[chain.key];
        const ours = fromQuantity(await client.call('eth_getBalance', [holder, tag]));
        const theirs = fromQuantity(await rawRpc(independent, 'eth_getBalance', [holder, tag]));
        console.log(`[${chain.key}] ${holder} @${tag}: ours=${ours} theirs=${theirs} (${client.activeEndpoint()} vs ${independent})`);
        expect(ours).toBeGreaterThan(0n);
        expect(ours).toBe(theirs);
      }, 30_000);

      it('the default ERC-20: a live holder found from recent Transfer logs, balance exact vs independent operator, and the provider row carries the chain-read symbol/decimals', async () => {
        expect(token).toBeDefined();
        const client = createEvmRpcClient(chain);
        const latest = fromQuantity(await client.call('eth_blockNumber'));
        // Find someone who received the token recently. Public nodes cap the
        // log count per query (BSC USDT moves thousands of times per minute),
        // so the window shrinks until the node accepts it.
        let holder: string | null = null;
        for (const span of [30n, 5n, 1n, 0n]) {
          try {
            const logs = (await client.call('eth_getLogs', [
              {
                address: token!.address,
                fromBlock: toQuantity(latest - span),
                toBlock: toQuantity(latest),
                topics: [TRANSFER_TOPIC],
              },
            ])) as Array<{ topics: string[] }>;
            if (logs.length > 0) holder = toChecksumAddress('0x' + logs[logs.length - 1].topics[2].slice(26));
            break;
          } catch (err) {
            if (!(err instanceof EvmRpcError) || span === 0n) break;
          }
        }
        if (!holder) {
          // Some public nodes (bsc-dataseed) refuse eth_getLogs outright. Walk
          // back from the tip through full blocks and decode a transfer(to, ..)
          // aimed at the token contract with the wallet's own calldata decoder.
          for (let back = 0n; back < 20n && !holder; back++) {
            const block = (await client.call('eth_getBlockByNumber', [toQuantity(latest - back), true])) as {
              transactions: Array<{ to: string | null; input: string }>;
            };
            for (const tx of block.transactions) {
              if (tx.to?.toLowerCase() !== token!.address.toLowerCase()) continue;
              const decoded = decodeErc20Calldata(fromHexData(tx.input));
              if (decoded?.kind === 'transfer') {
                holder = decoded.to;
                break;
              }
            }
          }
        }
        expect(holder).not.toBe(null);
        holder = holder!;
        const tag = toQuantity(latest);
        const call = { to: token!.address, data: encodeBalanceOf(holder) };
        const ours = decodeUint256((await client.call('eth_call', [call, tag])) as string);
        const theirs = decodeUint256((await rawRpc(independent, 'eth_call', [call, tag])) as string);
        console.log(`[${chain.key}] ${token!.symbol} balanceOf(${holder}) @${tag}: ours=${ours} theirs=${theirs}`);
        expect(ours).toBe(theirs);

        // Now the provider path (what the store consumes), at 'latest'. The
        // holder may move funds between the two reads, so accept equality with
        // either the pinned figure or a fresh independent 'latest' read.
        const provider = createEvmProvider(chain);
        const rows = await provider.getAllAssetBalances(holder);
        console.log(`[${chain.key}] provider rows for ${holder}:`, rows.map((r) => `${r.name}=${r.amountBase} (scale ${r.scale})`).join(', '));
        expect(rows[0].isNative).toBe(true);
        expect(rows[0].name).toBe(chain.nativeTicker);
        expect(rows[0].scale).toBe(chain.nativeDecimals);
        const tokenRow = rows.find((r) => !r.isNative);
        expect(tokenRow).toBeDefined();
        expect(tokenRow!.name).toBe(token!.symbol);
        expect(tokenRow!.scale).toBe(token!.decimals);
        const freshTheirs = decodeUint256((await rawRpc(independent, 'eth_call', [call, 'latest'])) as string);
        expect([ours, freshTheirs]).toContain(tokenRow!.amountBase);
      }, 60_000);

      if (chain.key === 'base') {
        it('explorer cross-check (Blockscout for Base): the burn address native balance matches, exact', async () => {
          const burn = '0x000000000000000000000000000000000000dEaD';
          const client = createEvmRpcClient(evmChainByKey('base')!);
          const res = await fetch(
            `https://base.blockscout.com/api?module=account&action=balance&address=${burn}`,
          );
          expect(res.ok).toBe(true);
          const json = (await res.json()) as { status: string; result: string };
          expect(json.status).toBe('1');
          const explorer = BigInt(json.result);
          let ours = fromQuantity(await client.call('eth_getBalance', [burn, 'latest']));
          if (ours !== explorer) {
            // The address receives dust now and then; one immediate re-read
            // settles whether the two disagreed or the balance moved.
            ours = fromQuantity(await client.call('eth_getBalance', [burn, 'latest']));
          }
          console.log(`[base] explorer ${burn}: blockscout=${explorer} ours=${ours}`);
          expect(ours).toBe(explorer);
        }, 30_000);
      }
    });
  }
});
