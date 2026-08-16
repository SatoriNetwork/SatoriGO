// Reading the chain tip's block time out of a raw header. This value decides
// whether the wallet tells the user a chain has stopped producing blocks, so a
// header it cannot trust must read as UNKNOWN rather than as a wildly stale or
// future chain.

import { describe, expect, it } from 'vitest';
import { parseHeaderTime } from './electrumProvider';

/** Build an 80-byte header hex whose `time` field holds `seconds`. */
function headerWithTime(seconds: number): string {
  const le = [0, 8, 16, 24].map((shift) => (((seconds >>> shift) & 0xff).toString(16).padStart(2, '0'))).join('');
  return (
    '00'.repeat(4) + // version
    '11'.repeat(32) + // prev block
    '22'.repeat(32) + // merkle root
    le + // time
    '33'.repeat(4) + // bits
    '44'.repeat(4) // nonce
  );
}

describe('parseHeaderTime', () => {
  it('reads the little-endian time at the Bitcoin header offset', () => {
    // Bitcoin block 500000: 2017-12-18T18:35:25Z.
    const seconds = 1_513_622_125;
    expect(parseHeaderTime(headerWithTime(seconds))).toBe(seconds * 1000);
  });

  it('still reads a LONGER header (Ravencoin/Evrmore append fields after nonce)', () => {
    const seconds = 1_700_000_000;
    expect(parseHeaderTime(headerWithTime(seconds) + 'ab'.repeat(40))).toBe(seconds * 1000);
  });

  it('returns null for a missing, short or non-hex header', () => {
    expect(parseHeaderTime(undefined)).toBeNull();
    expect(parseHeaderTime('')).toBeNull();
    expect(parseHeaderTime('00'.repeat(40))).toBeNull(); // 40 bytes, too short
    expect(parseHeaderTime('zz'.repeat(80))).toBeNull();
  });

  it('rejects an implausible time instead of reporting a dead or future chain', () => {
    // Zero would read as 1970, i.e. "no block for 55 years".
    expect(parseHeaderTime(headerWithTime(0))).toBeNull();
    // Pre-Bitcoin is impossible for any chain here.
    expect(parseHeaderTime(headerWithTime(1_000_000_000))).toBeNull();
    // Far future would hide a real stall behind a negative age.
    expect(parseHeaderTime(headerWithTime(Math.floor(Date.now() / 1000) + 86_400))).toBeNull();
  });

  it('accepts a timestamp slightly ahead of now (block times are allowed to drift)', () => {
    const soon = Math.floor(Date.now() / 1000) + 60 * 60;
    expect(parseHeaderTime(headerWithTime(soon))).toBe(soon * 1000);
  });
});
