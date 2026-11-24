import { Rational } from './money.js';

function parsePercent(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return null;
  return n;
}

/**
 * Guest amount for a rate.
 * Uses the rate markup when it is set (including 0). Otherwise the hotel
 * commission percent. Otherwise the net amount unchanged.
 */
export function guestNetRate(
  net: number | string,
  markupPercent: number | string | null | undefined,
  hotelCommissionPercent: number | string | null | undefined
): string {
  const markup = parsePercent(markupPercent);
  const hotel = parsePercent(hotelCommissionPercent);
  const pct = markup !== null ? markup : hotel !== null ? hotel : 0;
  if (pct === 0) return String(net);

  const base = Rational.from(net);
  const multiplier = Rational.from(1).add(Rational.from(pct).div(Rational.from(100)));
  return base.mul(multiplier).toDecimal(2).toFixed(2);
}
