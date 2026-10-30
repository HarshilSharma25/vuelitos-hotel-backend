import { describe, it, expect } from 'vitest';
import { Rational } from '../../src/modules/pricing/money.js';

describe('Rational Money Arithmetic', () => {
  it('adds, subtracts, multiplies and divides correctly without float drift', () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004
    const a = Rational.fromString('0.1');
    const b = Rational.fromString('0.2');
    const sum = a.add(b);
    expect(sum.toDecimal(2)).toBe(0.3);

    const diff = sum.sub(a);
    expect(diff.toDecimal(2)).toBe(0.2);

    const prod = a.mul(b);
    expect(prod.toDecimal(2)).toBe(0.02);

    const div = b.div(a);
    expect(div.toDecimal(2)).toBe(2);
  });

  it('performs exact half-up rounding', () => {
    // 1.005 -> 1.01
    expect(Rational.fromString('1.005').toDecimal(2)).toBe(1.01);
    // 1.004 -> 1.00
    expect(Rational.fromString('1.004').toDecimal(2)).toBe(1.0);
    // 1.0051 -> 1.01
    expect(Rational.fromString('1.0051').toDecimal(2)).toBe(1.01);
    // 2.555 -> 2.56
    expect(Rational.fromString('2.555').toDecimal(2)).toBe(2.56);
  });

  it('throws on division by zero', () => {
    const zero = new Rational(0n, 1n);
    const one = new Rational(1n, 1n);
    expect(() => one.div(zero)).toThrow();
  });
});
