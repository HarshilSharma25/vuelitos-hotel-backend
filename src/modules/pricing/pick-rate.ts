import { Rational } from './money.js';
import { PickRateResult, RateInput } from './types.js';

/**
 * A per-room rate covers any party up to its occupancy (one guest still buys the room).
 * A per-person rate matches only that exact occupancy. Null occupancy means any party size.
 */
export function rateCoversGuests(rate: RateInput, guests: number): boolean {
  if (rate.occupancy === null) return true;
  if (rate.pricingUnit === 'per_room') return guests <= rate.occupancy;
  return rate.occupancy === guests;
}

/** Exact occupancy beats an open rate, which beats a larger per-room band. */
export function occupancyFitRank(rate: RateInput, guests: number): number {
  if (rate.occupancy === guests) return 3;
  if (rate.occupancy === null) return 2;
  if (rate.pricingUnit === 'per_room' && rate.occupancy !== null && guests <= rate.occupancy) {
    return 1;
  }
  return 0;
}

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
    if (!rateCoversGuests(r, guests)) return false;
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
    const rankDiff = occupancyFitRank(b, guests) - occupancyFitRank(a, guests);
    if (rankDiff !== 0) return rankDiff;

    const aHasDays = a.daysOfWeek && a.daysOfWeek.length > 0 ? 1 : 0;
    const bHasDays = b.daysOfWeek && b.daysOfWeek.length > 0 ? 1 : 0;
    if (bHasDays !== aHasDays) return bHasDays - aHasDays;

    if (
      a.pricingUnit === 'per_room' &&
      b.pricingUnit === 'per_room' &&
      a.occupancy !== null &&
      b.occupancy !== null &&
      a.occupancy !== b.occupancy
    ) {
      return a.occupancy - b.occupancy;
    }

    if (b.minNights !== a.minNights) return b.minNights - a.minNights;

    const aRat = Rational.from(a.netRate);
    const bRat = Rational.from(b.netRate);
    return aRat.cmp(bRat);
  });

  return { rate: sellable[0] };
}
