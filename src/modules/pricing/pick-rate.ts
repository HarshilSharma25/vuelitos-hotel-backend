import { Rational } from './money.js';
import { PickRateResult, RateInput } from './types.js';

export function pickRate(
  rates: RateInput[],
  night: Date,
  guests: number,
  stayNights: number
): PickRateResult {
  const nightDay = night.getUTCDay();
  const ok = rates.filter((r) => {
    if (!r.isActive) return false;
    if (r.concept !== 'OCUPACION' && r.concept !== null) return false;
    if (r.priceKind !== 'IMPORTE') return false;
    if (r.occupancy !== null && r.occupancy !== guests) return false;
    if (r.daysOfWeek && r.daysOfWeek.length > 0 && !r.daysOfWeek.includes(nightDay)) return false;
    if (r.maxNights !== null && stayNights > r.maxNights) return false;
    return true;
  });

  const sellable = ok.filter((r) => r.minNights <= stayNights);

  if (!sellable.length) {
    return ok.length
      ? { error: 'min_nights', required: Math.min(...ok.map((r) => r.minNights)) }
      : { error: 'no_rate' };
  }

  sellable.sort((a, b) => {
    const aHasDays = a.daysOfWeek && a.daysOfWeek.length > 0 ? 1 : 0;
    const bHasDays = b.daysOfWeek && b.daysOfWeek.length > 0 ? 1 : 0;
    if (bHasDays !== aHasDays) return bHasDays - aHasDays; // day-specific first

    if (b.minNights !== a.minNights) return b.minNights - a.minNights; // longer min nights first

    const aRat = Rational.from(a.netRate);
    const bRat = Rational.from(b.netRate);
    return aRat.cmp(bRat); // cheaper first
  });

  return { rate: sellable[0] };
}
