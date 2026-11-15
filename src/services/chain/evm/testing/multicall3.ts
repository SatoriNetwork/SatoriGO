// A stand-in for the Multicall3 contract, for the fake nodes the swap tests
// run against. Tests only: nothing in the wallet imports this.

const WORD = 64;
const word = (n: number | bigint) => BigInt(n).toString(16).padStart(WORD, '0');

/**
 * Answer one aggregate3 eth_call the way the contract would: run every inner
 * call through `answerOne` (return data, or null for a call that reverts) and
 * pack the outcomes as (bool success, bytes returnData)[].
 */
export function answerAggregate3(calldata: string, answerOne: (to: string, data: string) => string | null): string {
  const body = calldata.slice(10);
  const at = (byte: number) => Number(BigInt(`0x${body.slice(byte * 2, byte * 2 + WORD)}`));
  const array = at(0);
  const count = at(array);
  const start = array + 32;
  const tuples: string[] = [];
  for (let i = 0; i < count; i++) {
    const tuple = start + at(start + i * 32);
    const to = `0x${body.slice(tuple * 2 + 24, tuple * 2 + WORD)}`;
    const data = tuple + at(tuple + 64);
    const length = at(data);
    const result = answerOne(to, `0x${body.slice((data + 32) * 2, (data + 32 + length) * 2)}`);
    const hex = result === null ? '' : result.slice(2);
    tuples.push(word(result === null ? 0 : 1) + word(64) + word(hex.length / 2) + hex.padEnd(Math.ceil(hex.length / WORD) * WORD, '0'));
  }
  let offset = count * 32;
  let heads = '';
  for (const tuple of tuples) {
    heads += word(offset);
    offset += tuple.length / 2;
  }
  return `0x${word(32)}${word(count)}${heads}${tuples.join('')}`;
}
