// Uniswap v3 calldata and price arithmetic (uniswapV3.ts).
//
// The quote and swap encodings were also run against Base itself on 2026-11-14
// by scripts/uniswap-probe.ts (the quoter answered the wallet-built quote and
// the router simulated the wallet-built swap); the vectors here are hand-built
// from the ABI so the layout is readable word by word.

import { describe, it, expect } from 'vitest';
import { bytesToHex } from '@noble/hashes/utils';
import { selector } from './erc20';
import { isEvmAddress } from './keys';
import {
  UNISWAP_V3,
  UNISWAP_V3_SELECTORS,
  uniswapV3For,
  encodeSwapPath,
  encodeGetPool,
  decodePoolAddress,
  decodeSqrtPriceX96,
  encodeQuoteExactInput,
  decodeQuoteAmountOut,
  encodeExactInput,
  encodeUnwrapWETH9,
  encodeMulticall,
  encodeSwap,
  minimumOut,
  midPriceOut,
  priceImpactBps,
  afterSwapFee,
  beforeSwapFee,
  encodeSweepTokenWithFee,
  encodeUnwrapWETH9WithFee,
  encodeSelfPermitIfNecessary,
  permitDomainSeparator,
  permitTypedData,
  splitPermitSignature,
} from './uniswapV3';
import { signTypedData, typedDataDigest } from './typedData';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hexToBytes } from '@noble/hashes/utils';
import { publicKeyToEvmAddress } from './keys';

const BASE = UNISWAP_V3.base;
const WETH = BASE.wrappedNative;
const USDC = BASE.stable;
const SATORI = '0xd0a5bFF2789230b0fb1Bd989fc7CE7084c947E17';
const USER = '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359';

const weth = '4200000000000000000000000000000000000006';
const usdc = '833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const satori = 'd0a5bff2789230b0fb1bd989fc7ce7084c947e17';
const user = 'fb6916095ca1df60bb79ce92ce3ea74c37c5d359';
const router = '2626664c2603336e57b271c5c0b26f421741e481';
const pad = (hex: string) => hex.padStart(64, '0');
const word = (n: bigint | number) => pad(BigInt(n).toString(16));

const ONE_HOP = [{ tokenIn: USDC, tokenOut: SATORI, fee: 3000 }];
const TWO_HOPS = [
  { tokenIn: WETH, tokenOut: USDC, fee: 500 },
  { tokenIn: USDC, tokenOut: SATORI, fee: 3000 },
];

describe('pinned Uniswap v3 deployments', () => {
  it('pins each selector to its signature', () => {
    const signatures: Record<keyof typeof UNISWAP_V3_SELECTORS, string> = {
      getPool: 'getPool(address,address,uint24)',
      slot0: 'slot0()',
      quoteExactInput: 'quoteExactInput(bytes,uint256)',
      exactInput: 'exactInput((bytes,address,uint256,uint256))',
      multicall: 'multicall(uint256,bytes[])',
      unwrapWETH9: 'unwrapWETH9(uint256,address)',
      sweepTokenWithFee: 'sweepTokenWithFee(address,uint256,address,uint256,address)',
      unwrapWETH9WithFee: 'unwrapWETH9WithFee(uint256,address,uint256,address)',
      selfPermitIfNecessary: 'selfPermitIfNecessary(address,uint256,uint256,uint8,bytes32,bytes32)',
      DOMAIN_SEPARATOR: 'DOMAIN_SEPARATOR()',
      nonces: 'nonces(address)',
      factory: 'factory()',
      WETH9: 'WETH9()',
    };
    for (const [name, signature] of Object.entries(signatures)) {
      expect(UNISWAP_V3_SELECTORS[name as keyof typeof UNISWAP_V3_SELECTORS], name).toBe(selector(signature));
    }
  });

  it('every pinned address is a valid checksummed address', () => {
    for (const deployment of Object.values(UNISWAP_V3)) {
      for (const address of Object.values(deployment)) expect(isEvmAddress(address), address).toBe(true);
    }
  });

  it('a chain with no entry has no swap', () => {
    expect(uniswapV3For('base')).toBe(BASE);
    expect(uniswapV3For('epix')).toBeNull();
    expect(uniswapV3For('constructor')).toBeNull();
  });
});

describe('swap path', () => {
  it('packs token, fee, token', () => {
    expect(encodeSwapPath(ONE_HOP)).toBe(`${usdc}000bb8${satori}`);
    expect(encodeSwapPath(TWO_HOPS)).toBe(`${weth}0001f4${usdc}000bb8${satori}`);
  });

  it('refuses hops that do not chain, unknown tiers, and long paths', () => {
    expect(() => encodeSwapPath([TWO_HOPS[1], TWO_HOPS[0]])).toThrow(/chain/);
    expect(() => encodeSwapPath([{ tokenIn: USDC, tokenOut: SATORI, fee: 42 }])).toThrow(/fee/);
    expect(() => encodeSwapPath([{ tokenIn: USDC, tokenOut: USDC, fee: 500 }])).toThrow(/two tokens/);
    expect(() => encodeSwapPath([])).toThrow(/hops/);
    expect(() => encodeSwapPath([...TWO_HOPS, { tokenIn: SATORI, tokenOut: WETH, fee: 500 }])).toThrow(/hops/);
  });
});

describe('reads', () => {
  it('builds getPool and reads the answer', () => {
    expect(encodeGetPool(SATORI, USDC, 3000)).toBe(`0x1698ee82${pad(satori)}${pad(usdc)}${word(3000)}`);
    expect(decodePoolAddress(`0x${pad('a49d06da6659653dafc88114ff00c3a901043bbb')}`)?.toLowerCase()).toBe(
      '0xa49d06da6659653dafc88114ff00c3a901043bbb',
    );
    expect(decodePoolAddress(`0x${pad('0')}`)).toBeNull();
    expect(() => decodePoolAddress(`0x${'1'.padEnd(64, '0')}`)).toThrow();
    expect(() => decodePoolAddress('0x')).toThrow();
  });

  it('reads the sqrt price from slot0 and refuses nonsense', () => {
    expect(decodeSqrtPriceX96(`0x${word(1n << 96n)}${word(7)}`)).toBe(1n << 96n);
    expect(() => decodeSqrtPriceX96(`0x${word(0)}`)).toThrow();
    expect(() => decodeSqrtPriceX96('nope')).toThrow();
  });

  it('builds quoteExactInput(path, amountIn) and reads amountOut', () => {
    const path = `${usdc}000bb8${satori}`; // 43 bytes
    expect(encodeQuoteExactInput(ONE_HOP, 10_000_000n)).toBe(
      `0xcdca1753${word(64)}${word(10_000_000)}${word(43)}${path.padEnd(128, '0')}`,
    );
    expect(decodeQuoteAmountOut(`0x${word(123456)}${word(1)}${word(2)}${word(3)}`)).toBe(123456n);
    expect(() => decodeQuoteAmountOut('0x')).toThrow();
  });
});

describe('swap transaction', () => {
  const exactInput = (recipient: string, path: string, pathBytes: number, padded: number) =>
    `0xb858183f${word(32)}${word(128)}${pad(recipient)}${word(10_000_000)}${word(9_950_000)}${word(pathBytes)}${path.padEnd(padded, '0')}`;

  it('builds exactInput with the path after the four head words', () => {
    const path = `${usdc}000bb8${satori}`;
    expect(encodeExactInput({ hops: ONE_HOP, recipient: USER, amountIn: 10_000_000n, amountOutMinimum: 9_950_000n })).toBe(
      exactInput(user, path, 43, 128),
    );
  });

  it('wraps a token-out swap in multicall(deadline, [exactInput]) paid to the user', () => {
    const inner = exactInput(user, `${usdc}000bb8${satori}`, 43, 128).slice(2);
    const data = encodeSwap({
      deployment: BASE,
      hops: ONE_HOP,
      recipient: USER,
      amountIn: 10_000_000n,
      amountOutMinimum: 9_950_000n,
      deadline: 1_800_000_000n,
      nativeOut: false,
    });
    const innerBytes = inner.length / 2; // 4 + 8 words = 260
    expect(bytesToHex(data)).toBe(
      `5ae401dc${word(1_800_000_000)}${word(64)}${word(1)}${word(32)}${word(innerBytes)}${inner.padEnd(Math.ceil(innerBytes / 32) * 64, '0')}`,
    );
  });

  it('pays the router and unwraps to the user when the output is the coin', () => {
    const hops = [
      { tokenIn: SATORI, tokenOut: USDC, fee: 3000 },
      { tokenIn: USDC, tokenOut: WETH, fee: 500 },
    ];
    const data = bytesToHex(
      encodeSwap({ deployment: BASE, hops, recipient: USER, amountIn: 10_000_000n, amountOutMinimum: 9_950_000n, deadline: 1n, nativeOut: true }),
    );
    const swap = exactInput(router, `${satori}000bb8${usdc}0001f4${weth}`, 66, 192).slice(2);
    const unwrap = encodeUnwrapWETH9(9_950_000n, USER).slice(2);
    expect(unwrap).toBe(`49404b7c${word(9_950_000)}${pad(user)}`);
    expect(data).toBe(bytesToHex(encodeMulticall(1n, [`0x${swap}`, `0x${unwrap}`])));
    // Two calls: two offsets, then each as length + padded bytes.
    const swapBytes = swap.length / 2;
    const swapPadded = Math.ceil(swapBytes / 32) * 32;
    expect(data.startsWith(`5ae401dc${word(1)}${word(64)}${word(2)}${word(64)}${word(64 + 32 + swapPadded)}${word(swapBytes)}`)).toBe(true);
    expect(data.endsWith(`${word(68)}${unwrap.padEnd(192, '0')}`)).toBe(true);
  });

  it('refuses a swap with no minimum, no amount, or a coin-out route that does not end wrapped', () => {
    const base = { deployment: BASE, hops: ONE_HOP, recipient: USER, amountIn: 1n, amountOutMinimum: 1n, deadline: 1n, nativeOut: false };
    expect(() => encodeSwap({ ...base, amountOutMinimum: 0n })).toThrow(/minimum/);
    expect(() => encodeSwap({ ...base, amountIn: 0n })).toThrow(/amountIn/);
    expect(() => encodeSwap({ ...base, nativeOut: true })).toThrow(/wrapped/);
    expect(() => encodeSwap({ ...base, recipient: '0x1234' })).toThrow(/address/);
  });
});

describe('swap fee (the router splits it off the output)', () => {
  const TREASURY = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
  const treasury = '000000000022d473030f116ddee9f6b43ac78ba3';
  const FEE = { bips: 25, recipient: TREASURY };

  it('rounds exactly as the router does, and the pre-fee minimum always leaves the user theirs', () => {
    expect(afterSwapFee(1_000_000n, 25)).toBe(997_500n);
    expect(afterSwapFee(399n, 25)).toBe(399n); // the fee floors to nothing
    expect(afterSwapFee(1_000n, 0)).toBe(1_000n);
    expect(beforeSwapFee(997_500n, 25)).toBe(1_000_000n);
    expect(beforeSwapFee(5n, 0)).toBe(5n);
    for (const net of [1n, 7n, 399n, 400n, 997_501n, 10n ** 30n + 3n]) {
      for (const bips of [1, 25, 99, 100]) {
        const gross = beforeSwapFee(net, bips);
        expect(afterSwapFee(gross, bips) >= net, `${net} at ${bips}`).toBe(true);
        // Never short, and at most one base unit more careful than it has to be.
        expect(afterSwapFee(gross, bips) - net <= 1n, `${net} at ${bips} is tight`).toBe(true);
      }
    }
  });

  it('refuses a fee above the router cap, a zero fee and a fraction', () => {
    for (const bips of [101, -1, 0.5]) expect(() => afterSwapFee(1n, bips)).toThrow(/fee/);
    expect(() => encodeSweepTokenWithFee(USDC, 1n, USER, { bips: 0, recipient: TREASURY })).toThrow(/fee/);
    expect(() => encodeSweepTokenWithFee(USDC, 1n, USER, { bips: 25, recipient: '0x12' })).toThrow(/address/);
  });

  it('builds the two fee calls word by word', () => {
    expect(encodeSweepTokenWithFee(SATORI, 500n, USER, FEE)).toBe(`0xe0e189a0${pad(satori)}${word(500)}${pad(user)}${word(25)}${pad(treasury)}`);
    expect(encodeUnwrapWETH9WithFee(500n, USER, FEE)).toBe(`0x9b2c0a37${word(500)}${pad(user)}${word(25)}${pad(treasury)}`);
  });

  it('a token-out swap with a fee pays the router, then sweeps to the user with the pre-fee minimum', () => {
    const args = { deployment: BASE, hops: ONE_HOP, recipient: USER, amountIn: 10_000_000n, amountOutMinimum: 997_500n, deadline: 9n, nativeOut: false };
    const data = bytesToHex(encodeSwap({ ...args, fee: FEE }));
    const swap = encodeExactInput({ hops: ONE_HOP, recipient: BASE.swapRouter02, amountIn: 10_000_000n, amountOutMinimum: 1_000_000n });
    expect(data).toBe(bytesToHex(encodeMulticall(9n, [swap, encodeSweepTokenWithFee(SATORI, 1_000_000n, USER, FEE)])));
    // No fee, null or absent: the bytes that shipped before the fee existed.
    expect(bytesToHex(encodeSwap({ ...args, fee: null }))).toBe(bytesToHex(encodeSwap(args)));
    expect(bytesToHex(encodeSwap(args))).not.toContain('e0e189a0');
  });

  it('a coin-out swap with a fee unwraps with the fee instead', () => {
    const hops = [{ tokenIn: USDC, tokenOut: WETH, fee: 500 }];
    const data = bytesToHex(
      encodeSwap({ deployment: BASE, hops, recipient: USER, amountIn: 5n, amountOutMinimum: 997_500n, deadline: 9n, nativeOut: true, fee: FEE }),
    );
    expect(data).toContain(encodeUnwrapWETH9WithFee(1_000_000n, USER, FEE).slice(2));
    expect(data).not.toContain('49404b7c');
  });
});

describe('slippage and price impact', () => {
  it('takes slippage off the quote, rounding down', () => {
    expect(minimumOut(1_000_000n, 50)).toBe(995_000n);
    expect(minimumOut(999n, 50)).toBe(994n);
    expect(minimumOut(1_000n, 0)).toBe(1_000n);
    expect(() => minimumOut(1n, -1)).toThrow();
    expect(() => minimumOut(1n, 10_001)).toThrow();
    expect(() => minimumOut(1n, 0.5)).toThrow();
  });

  it('prices a hop at the pool price in either direction, less the pool fee', () => {
    // sqrtPrice 2^97 means token1/token0 = 4. USDC is token0 (lower address).
    const sqrt = 1n << 97n;
    expect(midPriceOut(1_000_000n, ONE_HOP, [sqrt])).toBe(3_988_000n); // 4x, less 0.3%
    expect(midPriceOut(4_000_000n, [{ tokenIn: SATORI, tokenOut: USDC, fee: 3000 }], [sqrt])).toBe(997_000n);
    expect(midPriceOut(1_000_000n, [{ tokenIn: USDC, tokenOut: SATORI, fee: 500 }, { tokenIn: SATORI, tokenOut: USDC, fee: 500 }], [sqrt, sqrt])).toBe(
      999_000n,
    );
    expect(() => midPriceOut(1n, ONE_HOP, [])).toThrow();
  });

  it('reports impact in hundredths of a percent, never negative', () => {
    expect(priceImpactBps(985n, 1000n)).toBe(150);
    expect(priceImpactBps(1001n, 1000n)).toBe(0);
    expect(priceImpactBps(0n, 1000n)).toBe(10_000);
    expect(priceImpactBps(5n, 0n)).toBeNull();
  });
});

describe('permit: the allowance as a signature inside the swap', () => {
  const KEY = hexToBytes('1ab42cc412b618bdea3a599e3c9bae199ebf030895b039e9db1e30dafb12b727');
  const OWNER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
  const data = permitTypedData({
    name: 'Satori',
    version: '1',
    chainId: 8453,
    token: SATORI,
    owner: OWNER,
    spender: BASE.swapRouter02,
    value: 10_000_000n,
    nonce: 5n,
    deadline: 1_800_001_200n,
  });

  it('the domain separator depends on every part of the domain', () => {
    const sep = permitDomainSeparator('Satori', '1', 8453, SATORI);
    expect(sep).toMatch(/^0x[0-9a-f]{64}$/);
    expect(permitDomainSeparator('Satori', '2', 8453, SATORI)).not.toBe(sep);
    expect(permitDomainSeparator('Satori', '1', 1, SATORI)).not.toBe(sep);
    expect(permitDomainSeparator('satori', '1', 8453, SATORI)).not.toBe(sep);
    expect(permitDomainSeparator('Satori', '1', 8453, USDC)).not.toBe(sep);
    // USD Coin on Ethereum, a published value: the hashing is the standard's.
    expect(permitDomainSeparator('USD Coin', '2', 1, '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48')).toBe(
      '0x06c37168a7db5138defc7866392bb87a741f9b3d104deb5094588ce041cae335',
    );
  });

  it('the signed permit recovers to its owner and names the spender and the exact amount', () => {
    expect(data.message).toEqual({ owner: OWNER, spender: BASE.swapRouter02, value: '10000000', nonce: '5', deadline: '1800001200' });
    const { v, r, s } = splitPermitSignature(signTypedData(data, KEY));
    const sig = new secp256k1.Signature(BigInt(r), BigInt(s)).addRecoveryBit(v - 27);
    expect(publicKeyToEvmAddress(sig.recoverPublicKey(typedDataDigest(data)).toRawBytes(false))).toBe(OWNER);
    expect(() => splitPermitSignature('0x1234')).toThrow(/65 bytes/);
    expect(() => splitPermitSignature(`0x${'11'.repeat(64)}00`)).toThrow(/27 or 28/);
  });

  it('goes first in the multicall, and only for the token and amount being swapped', () => {
    const permit = { token: SATORI, value: 10_000_000n, deadline: 99n, v: 28, r: `0x${'aa'.repeat(32)}`, s: `0x${'bb'.repeat(32)}` };
    expect(encodeSelfPermitIfNecessary(permit)).toBe(
      `0xc2e3140a${pad(satori)}${word(10_000_000)}${word(99)}${word(28)}${'aa'.repeat(32)}${'bb'.repeat(32)}`,
    );
    const hops = [{ tokenIn: SATORI, tokenOut: USDC, fee: 3000 }];
    const args = { deployment: BASE, hops, recipient: USER, amountIn: 10_000_000n, amountOutMinimum: 5n, deadline: 99n, nativeOut: false };
    const swap = encodeExactInput({ hops, recipient: USER, amountIn: 10_000_000n, amountOutMinimum: 5n });
    expect(bytesToHex(encodeSwap({ ...args, permit }))).toBe(bytesToHex(encodeMulticall(99n, [encodeSelfPermitIfNecessary(permit), swap])));
    expect(() => encodeSwap({ ...args, permit: { ...permit, value: 10_000_001n } })).toThrow(/permit/);
    expect(() => encodeSwap({ ...args, permit: { ...permit, token: USDC } })).toThrow(/permit/);
    expect(() => encodeSelfPermitIfNecessary({ ...permit, r: '0x12' })).toThrow(/bytes32/);
    expect(() => encodeSelfPermitIfNecessary({ ...permit, v: 1 })).toThrow(/27 or 28/);
  });
});
