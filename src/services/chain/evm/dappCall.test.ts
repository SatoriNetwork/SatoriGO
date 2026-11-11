import { describe, expect, it } from 'vitest';
import { hexToBytes } from '@noble/hashes/utils';
import { selector } from './erc20';
import { DAPP_CALL_SELECTORS, dappCallCounterparty, decodeDappCall, isUnlimitedAllowance } from './dappCall';

const A = '1111111111111111111111111111111111111111';
const B = '2222222222222222222222222222222222222222';
const addr = (h: string) => h.padStart(64, '0');
const num = (n: bigint) => n.toString(16).padStart(64, '0');
const call = (sel: string, ...words: string[]) => hexToBytes(sel.slice(2) + words.join(''));
const MAX = 2n ** 256n - 1n;

describe('decodeDappCall', () => {
  it('pins every selector to its signature', () => {
    const sigs: Record<keyof typeof DAPP_CALL_SELECTORS, string> = {
      transfer: 'transfer(address,uint256)',
      approve: 'approve(address,uint256)',
      transferFrom: 'transferFrom(address,address,uint256)',
      increaseAllowance: 'increaseAllowance(address,uint256)',
      setApprovalForAll: 'setApprovalForAll(address,bool)',
      safeTransferFrom: 'safeTransferFrom(address,address,uint256)',
      safeTransferFromData: 'safeTransferFrom(address,address,uint256,bytes)',
      permit: 'permit(address,address,uint256,uint256,uint8,bytes32,bytes32)',
    };
    for (const [k, sig] of Object.entries(sigs)) {
      expect(`${k}: ${selector(sig)}`).toBe(`${k}: ${DAPP_CALL_SELECTORS[k as keyof typeof sigs]}`);
    }
  });

  it('reads transfer and an unlimited approve', () => {
    expect(decodeDappCall(call(DAPP_CALL_SELECTORS.transfer, addr(A), num(5n)))).toMatchObject({ kind: 'transfer', amount: 5n });
    const ap = decodeDappCall(call(DAPP_CALL_SELECTORS.approve, addr(B), num(MAX)));
    expect(ap).toMatchObject({ kind: 'approve', unlimited: true });
    expect(dappCallCounterparty(ap!).toLowerCase()).toBe(`0x${B}`);
    expect(decodeDappCall(call(DAPP_CALL_SELECTORS.approve, addr(B), num(10n)))).toMatchObject({ unlimited: false });
  });

  it('reads transferFrom, both safeTransferFrom forms and setApprovalForAll', () => {
    expect(decodeDappCall(call(DAPP_CALL_SELECTORS.transferFrom, addr(A), addr(B), num(7n)))).toMatchObject({ kind: 'transferFrom', safe: false, amount: 7n });
    expect(decodeDappCall(call(DAPP_CALL_SELECTORS.safeTransferFrom, addr(A), addr(B), num(7n)))).toMatchObject({ safe: true });
    const withData = call(DAPP_CALL_SELECTORS.safeTransferFromData, addr(A), addr(B), num(7n), num(128n), num(0n));
    expect(decodeDappCall(withData)).toMatchObject({ kind: 'transferFrom', safe: true });
    expect(decodeDappCall(call(DAPP_CALL_SELECTORS.setApprovalForAll, addr(B), num(1n)))).toMatchObject({ kind: 'setApprovalForAll', approved: true });
  });

  it('reads permit with its deadline', () => {
    const p = decodeDappCall(call(DAPP_CALL_SELECTORS.permit, addr(A), addr(B), num(MAX), num(99n), num(27n), num(1n), num(2n)));
    expect(p).toMatchObject({ kind: 'permit', unlimited: true, deadline: 99n });
  });

  it('returns null for what it does not know and throws for a known selector that does not fit', () => {
    expect(decodeDappCall(new Uint8Array())).toBeNull();
    expect(decodeDappCall(hexToBytes('deadbeef' + num(1n)))).toBeNull();
    expect(() => decodeDappCall(call(DAPP_CALL_SELECTORS.transfer, addr(A)))).toThrow(/bytes/);
    expect(() => decodeDappCall(call(DAPP_CALL_SELECTORS.transfer, 'ff' + addr(A).slice(2), num(1n)))).toThrow(/plain address/);
    expect(() => decodeDappCall(call(DAPP_CALL_SELECTORS.setApprovalForAll, addr(B), num(2n)))).toThrow(/true or false/);
  });

  it('treats anything from 2^255 as unlimited', () => {
    expect(isUnlimitedAllowance(1n << 255n)).toBe(true);
    expect(isUnlimitedAllowance((1n << 255n) - 1n)).toBe(false);
  });
});
