import { Rational } from './money.js';
import { PickRateResult, RateInput } from './types.js';

/** Party must fit the room type's max occupancy. */
export function rateCoversGuests(rate: RateInput, guests: number): boolean {
  return guests <= Math.max(1, rate.maxOccupancy);
}

/** Kept for catalog comparisons — all fitting rates share the same room cap. */
export function occupancyFitRank(_rate: RateInput, guests: number): number {
  return guests > 0 ? 1 : 0;
}

export function pickRate(
  rates: RateInput[],
  night: Date,
  guests: number,
  stayNights: number
): PickRateResult {
  const ok = rates.filter((r) => {
    if (!r.isActive) return false;
    if (r.concept !== 'OCUPACION' && r.concept !== null) return false;
    if (r.priceKind !== 'IMPORTE') return false;
    if (!rateCoversGuests(r, guests)) return false;
    return true;
  });

  const sellable = ok.filter((r) => r.minNights <= stayNights);

  if (!sellable.length) {
    return ok.length
      ? { error: 'min_nights', required: Math.min(...ok.map((r) => r.minNights)) }
      : { error: 'no_rate' };
  }

  sellable.sort((a, b) => {
  if (b.minNights !== a.minNights) return b.minNights - a.minNights;

    const aRat = Rational.from(a.netRate);
    const bRat = Rational.from(b.netRate);
    return aRat.cmp(bRat);
  });

  return { rate: sellable[0] };
}
