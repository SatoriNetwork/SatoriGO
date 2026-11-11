import { describe, expect, it } from 'vitest';

import { typedAmountFiat } from './useFiat';

describe('typedAmountFiat (the fiat line under an amount field)', () => {
  const unit = { value: 2000, currency: 'USD' as const };

  it('multiplies a typed amount by the unit price, comma or dot', () => {
    expect(typedAmountFiat('0.05', unit)).toEqual({ value: 100, currency: 'USD' });
    expect(typedAmountFiat(' 0,05 ', unit)).toEqual({ value: 100, currency: 'USD' });
  });

  it('says nothing for an unpriced asset, an empty field, zero, a negative or text', () => {
    expect(typedAmountFiat('1', undefined)).toBeNull();
    for (const text of ['', '   ', '0', '-1', 'abc', '1e999']) expect(typedAmountFiat(text, unit)).toBeNull();
  });
});
