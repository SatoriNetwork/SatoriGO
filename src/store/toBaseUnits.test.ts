import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { networkFor, type ChainId } from '../services/chain/chainParams';
import { parseAmount } from '../services/chain/amounts';

// The conversion itself is tested in services/chain/amounts.test.ts. What this
// file guards is that the conversion stays in ONE place and is driven by chain
// data, because that is the property that keeps quietly breaking:
//   - the guard was once added to the store path only, leaving the dApp
//     approval window (whose amount comes from a WEBSITE) still rounding;
//   - the scale was once hardcoded as 1e8 in 34 places across 9 files.
describe('one amount layer, driven by chain data', () => {
  it('every chain declares its own scale', () => {
    const ids: ChainId[] = [
      'evrmore-mainnet',
      'evrmore-testnet',
      'ravencoin-mainnet',
      'bitcoingold-mainnet',
      'litecoin-mainnet',
      'wojakcoin-mainnet',
      'bitcoin-mainnet',
      'dogecoin-mainnet',
    ];
    for (const id of ids) {
      const net = networkFor(id);
      expect(Number.isInteger(net.decimals)).toBe(true);
      expect(net.decimals).toBeGreaterThanOrEqual(0);
      // Every chain shipped today is 8. This is an assertion about TODAY's
      // data, not a rule: a chain on another scale is exactly what the field
      // exists for, and this line is where that change gets noticed.
      expect(net.decimals).toBe(8);
    }
  });

  it('the send paths import the shared module rather than converting inline', () => {
    for (const file of [
      'src/store/liveStore.ts',
      'src/screens/live/LiveSend.tsx',
      'src/screens/dapp/DappApproval.tsx',
    ]) {
      const src = readFileSync(file, 'utf8');
      expect(src).toContain('services/chain/amounts');
      // The exact patterns this refactor removed. A reappearance means a scale
      // was hardcoded again, which is invisible until a chain is not 8.
      expect(src).not.toMatch(/Math\.round\([^)]*\*\s*1e8\)/);
      expect(src).not.toMatch(/Number\([^)]*\)\s*\/\s*1e8/);
    }
  });

  it('an amount typed at the chain scale converts exactly, with no float in between', () => {
    const net = networkFor('mainnet');
    // Past 2^53 base units, which is where the old parseFloat path went wrong.
    const text = '123456789012.12345678';
    expect(parseAmount(text, net.decimals)).toBe(12_345_678_901_212_345_678n);
    expect(BigInt(Math.round(parseFloat(text) * 1e8))).not.toBe(parseAmount(text, net.decimals));
  });
});
