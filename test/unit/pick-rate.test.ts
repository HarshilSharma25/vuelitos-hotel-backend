import { describe, it, expect } from 'vitest';
import { pickRate } from '../../src/modules/pricing/pick-rate.js';
import { RateInput } from '../../src/modules/pricing/types.js';

describe('pickRate Pure Function', () => {
  const baseRate: RateInput = {
    id: 'rate-1',
    roomTypeId: 'rt-1',
    seasonId: 's-1',
    mealPlan: 'desayuno',
    concept: 'OCUPACION',
    priceKind: 'IMPORTE',
    occupancy: 2,
    pricingUnit: 'per_room',
    netRate: 100,
    daysOfWeek: [],
    minNights: 1,
    maxNights: null,
    isActive: true,
  };

  const night = new Date('2026-11-01T00:00:00Z'); // Sunday (UTCDay 0)

  it('selects valid rate matching guests and nights', () => {
    const res = pickRate([baseRate], night, 2, 2);
    expect('rate' in res).toBe(true);
    if ('rate' in res) {
      expect(res.rate.id).toBe('rate-1');
    }
  });

  it('returns min_nights error if stay is shorter than required', () => {
    const longRate = { ...baseRate, minNights: 3 };
    const res = pickRate([longRate], night, 2, 2);
    expect('error' in res && res.error).toBe('min_nights');
    if ('error' in res) {
      expect(res.required).toBe(3);
    }
  });

  it('honours max_nights restriction (Decision 5 / Q5)', () => {
    const maxNightsRate = { ...baseRate, maxNights: 3 };
    // Stay is 4 nights -> cannot use maxNights 3 rate
    const res = pickRate([maxNightsRate], night, 2, 4);
    expect('error' in res && res.error).toBe('no_rate');
  });

  it('prioritizes day-specific rate over general rate', () => {
    const generalRate = { ...baseRate, id: 'general', netRate: 80, daysOfWeek: [] };
    const sundayRate = { ...baseRate, id: 'sunday', netRate: 120, daysOfWeek: [0] };

    const res = pickRate([generalRate, sundayRate], night, 2, 2);
    expect('rate' in res && res.rate.id).toBe('sunday');
  });

  it('prioritizes longer minNights and then cheaper netRate', () => {
    const rate1 = { ...baseRate, id: 'r1', minNights: 1, netRate: 100 };
    const rate2 = { ...baseRate, id: 'r2', minNights: 2, netRate: 90 };
    const rate3 = { ...baseRate, id: 'r3', minNights: 2, netRate: 110 };

    const res = pickRate([rate1, rate2, rate3], night, 2, 3);
    expect('rate' in res && res.rate.id).toBe('r2');
  });
});
