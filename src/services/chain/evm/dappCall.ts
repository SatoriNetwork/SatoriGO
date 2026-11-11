// What a website's eth_sendTransaction calldata does, when it is one of the
// token calls that move or unlock the user's tokens. Pure, for the dApp
// approval screen (DappApprovalEvm.tsx).
//
// Recognised: ERC-20 transfer / approve / transferFrom / increaseAllowance /
// permit, ERC-721 safeTransferFrom (with and without data) and
// setApprovalForAll (ERC-721 and ERC-1155 share it). ERC-721 approve and
// transferFrom have the SAME selectors as ERC-20's: the third word is then a
// token id, not an amount, which the screen says ("amount or token id").
//
// Same rule as decodeErc20Calldata: an unknown selector is null ("Satori GO
// cannot tell"), but a known selector with a payload that does not fit (wrong
// length, dirty address padding, a bool that is not 0/1) THROWS, because a
// plausible decode of bytes that are not that call would put a party on screen
// the transaction does not contain.

import { bytesToHex } from '@noble/hashes/utils';
import { toChecksumAddress } from './keys';

export const DAPP_CALL_SELECTORS = Object.freeze({
  /** transfer(address,uint256) */
  transfer: '0xa9059cbb',
  /** approve(address,uint256), ERC-20 amount or ERC-721 token id */
  approve: '0x095ea7b3',
  /** transferFrom(address,address,uint256) */
  transferFrom: '0x23b872dd',
  /** increaseAllowance(address,uint256) */
  increaseAllowance: '0x39509351',
  /** setApprovalForAll(address,bool) */
  setApprovalForAll: '0xa22cb465',
  /** safeTransferFrom(address,address,uint256) */
  safeTransferFrom: '0x42842e0e',
  /** safeTransferFrom(address,address,uint256,bytes) */
  safeTransferFromData: '0xb88d4fde',
  /** permit(address,address,uint256,uint256,uint8,bytes32,bytes32) */
  permit: '0xd505accf',
} as const);

export type DappCall =
  | { kind: 'transfer'; to: string; amount: bigint }
  | { kind: 'approve'; spender: string; amount: bigint; unlimited: boolean }
  | { kind: 'increaseAllowance'; spender: string; amount: bigint; unlimited: boolean }
  | { kind: 'transferFrom'; from: string; to: string; amount: bigint; safe: boolean }
  | { kind: 'setApprovalForAll'; operator: string; approved: boolean }
  | { kind: 'permit'; owner: string; spender: string; amount: bigint; unlimited: boolean; deadline: bigint };

const WORD = 32;
const SEL = 4;

/** An allowance this large is "everything, forever" in practice: 2^256-1 is
 *  the usual value, and anything from 2^255 is beyond any real supply. */
export function isUnlimitedAllowance(amount: bigint): boolean {
  return amount >= 1n << 255n;
}

function word(data: Uint8Array, i: number): Uint8Array {
  return data.subarray(SEL + i * WORD, SEL + (i + 1) * WORD);
}

function uint(data: Uint8Array, i: number): bigint {
  const w = word(data, i);
  return w.length === 0 ? 0n : BigInt(`0x${bytesToHex(w)}`);
}

function address(data: Uint8Array, i: number, name: string): string {
  const w = word(data, i);
  for (let k = 0; k < 12; k++) {
    if (w[k] !== 0) throw new Error(`${name}: argument ${i + 1} is not a plain address`);
  }
  return toChecksumAddress(bytesToHex(w.subarray(12)));
}

function bool(data: Uint8Array, i: number, name: string): boolean {
  const v = uint(data, i);
  if (v !== 0n && v !== 1n) throw new Error(`${name}: argument ${i + 1} is not true or false`);
  return v === 1n;
}

function needWords(data: Uint8Array, n: number, name: string, atLeast = false): void {
  const want = SEL + n * WORD;
  if (atLeast ? data.length < want : data.length !== want) {
    throw new Error(`${name}: calldata must be ${atLeast ? 'at least ' : ''}${want} bytes, got ${data.length}`);
  }
}

/** Decode `data`, or null when it is not one of the recognised calls. */
export function decodeDappCall(data: Uint8Array): DappCall | null {
  if (!(data instanceof Uint8Array) || data.length < SEL) return null;
  const sel = `0x${bytesToHex(data.subarray(0, SEL))}`;
  const S = DAPP_CALL_SELECTORS;
  switch (sel) {
    case S.transfer:
      needWords(data, 2, 'transfer');
      return { kind: 'transfer', to: address(data, 0, 'transfer'), amount: uint(data, 1) };
    case S.approve:
    case S.increaseAllowance: {
      const kind = sel === S.approve ? 'approve' : 'increaseAllowance';
      needWords(data, 2, kind);
      const amount = uint(data, 1);
      return { kind, spender: address(data, 0, kind), amount, unlimited: isUnlimitedAllowance(amount) };
    }
    case S.transferFrom:
    case S.safeTransferFrom:
    case S.safeTransferFromData: {
      const safe = sel !== S.transferFrom;
      // The data variant carries a dynamic bytes argument after the three words.
      needWords(data, sel === S.safeTransferFromData ? 4 : 3, 'transferFrom', sel === S.safeTransferFromData);
      return {
        kind: 'transferFrom',
        from: address(data, 0, 'transferFrom'),
        to: address(data, 1, 'transferFrom'),
        amount: uint(data, 2),
        safe,
      };
    }
    case S.setApprovalForAll:
      needWords(data, 2, 'setApprovalForAll');
      return {
        kind: 'setApprovalForAll',
        operator: address(data, 0, 'setApprovalForAll'),
        approved: bool(data, 1, 'setApprovalForAll'),
      };
    case S.permit: {
      needWords(data, 7, 'permit');
      const amount = uint(data, 2);
      return {
        kind: 'permit',
        owner: address(data, 0, 'permit'),
        spender: address(data, 1, 'permit'),
        amount,
        unlimited: isUnlimitedAllowance(amount),
        deadline: uint(data, 3),
      };
    }
    default:
      return null;
  }
}

/** The address that ends up holding the tokens or the power over them: what
 *  the recipient checks (first time, lookalike) should look at. */
export function dappCallCounterparty(call: DappCall): string {
  switch (call.kind) {
    case 'transfer':
    case 'transferFrom':
      return call.to;
    case 'approve':
    case 'increaseAllowance':
    case 'permit':
      return call.spender;
    case 'setApprovalForAll':
      return call.operator;
  }
}
