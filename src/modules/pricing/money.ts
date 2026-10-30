export class Rational {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: bigint, den = 1n) {
    if (den === 0n) throw new Error('Division by zero');
    if (den < 0n) {
      num = -num;
      den = -den;
    }
    const g = Rational.gcd(num < 0n ? -num : num, den);
    this.num = num / g;
    this.den = den / g;
  }

  private static gcd(a: bigint, b: bigint): bigint {
    while (b !== 0n) {
      const t = b;
      b = a % b;
      a = t;
    }
    return a;
  }

  static fromNumber(val: number): Rational {
    if (!Number.isFinite(val)) throw new Error('Cannot create Rational from non-finite number');
    // For small decimals in scientific notation like 1e-7
    if (Math.abs(val) < 1e-4 && val !== 0) {
      return Rational.fromString(val.toFixed(12).replace(/0+$/, ''));
    }
    return Rational.fromString(val.toString());
  }

  static fromString(val: string): Rational {
    let trimmed = val.trim();
    if (!trimmed) throw new Error('Cannot create Rational from empty string');

    // Handle exponential notation like 1e-4 or 2.5e3
    if (/[eE]/.test(trimmed)) {
      const num = Number(trimmed);
      if (!Number.isFinite(num)) throw new Error(`Invalid numeric string: ${val}`);
      trimmed = num.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
    }

    const isNeg = trimmed.startsWith('-');
    if (isNeg || trimmed.startsWith('+')) {
      trimmed = trimmed.slice(1).trim();
    }

    if (trimmed.startsWith('.')) {
      trimmed = '0' + trimmed;
    }
    if (trimmed.endsWith('.')) {
      trimmed = trimmed.slice(0, -1);
    }

    if (!trimmed.includes('.')) {
      const n = BigInt(trimmed);
      return new Rational(isNeg ? -n : n, 1n);
    }

    const [intPart, fracPart] = trimmed.split('.');
    const den = 10n ** BigInt(fracPart.length);
    const num = BigInt(intPart) * den + BigInt(fracPart);
    return new Rational(isNeg ? -num : num, den);
  }

  static from(val: number | string | bigint | Rational): Rational {
    if (val instanceof Rational) return val;
    if (typeof val === 'bigint') return new Rational(val, 1n);
    if (typeof val === 'number') return Rational.fromNumber(val);
    return Rational.fromString(val);
  }

  add(other: Rational | number | string | bigint): Rational {
    const o = Rational.from(other);
    return new Rational(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(other: Rational | number | string | bigint): Rational {
    const o = Rational.from(other);
    return new Rational(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(other: Rational | number | string | bigint): Rational {
    const o = Rational.from(other);
    return new Rational(this.num * o.num, this.den * o.den);
  }

  div(other: Rational | number | string | bigint): Rational {
    const o = Rational.from(other);
    if (o.num === 0n) throw new Error('Division by zero in Rational');
    return new Rational(this.num * o.den, this.den * o.num);
  }

  cmp(other: Rational | number | string | bigint): number {
    const o = Rational.from(other);
    const diff = this.num * o.den - o.num * this.den;
    if (diff < 0n) return -1;
    if (diff > 0n) return 1;
    return 0;
  }

  toDecimal(decimals = 2): number {
    const scale = 10n ** BigInt(decimals);
    const scaledNum = this.num * scale;
    const isNegative = scaledNum < 0n;
    const absNum = isNegative ? -scaledNum : scaledNum;

    const div = absNum / this.den;
    const rem = absNum % this.den;

    // Half-up rounding: if 2 * rem >= den, round up
    const rounded = 2n * rem >= this.den ? div + 1n : div;
    const finalScaled = isNegative ? -rounded : rounded;

    return Number(finalScaled) / Number(scale);
  }
}
