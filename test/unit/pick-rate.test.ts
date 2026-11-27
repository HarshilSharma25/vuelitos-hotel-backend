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
    pricingUnit: 'per_room',
    netRate: 100,
    maxOccupancy: 2,
    minNights: 1,
    isActive: true,
  };

  const night = new Date('2026-11-01T00:00:00Z');

  it('applies per-room rate when guests fit the room max occupancy', () => {
    const res = pickRate([baseRate], night, 1, 2);
    expect('rate' in res && res.rate.id).toBe('rate-1');
  });

  it('rejects parties above room max occupancy', () => {
    const smallRoom = { ...baseRate, maxOccupancy: 1 };
    const res = pickRate([smallRoom], night, 2, 2);
    expect('error' in res && res.error).toBe('no_rate');
  });

  it('allows per-person pricing when guests fit the room cap', () => {
    const perPerson = { ...baseRate, pricingUnit: 'per_person' as const };
    const res = pickRate([perPerson], night, 2, 2);
    expect('rate' in res).toBe(true);
  });

  it('returns min_nights error if stay is shorter than required', () => {
    const longRate = { ...baseRate, minNights: 3 };
    const res = pickRate([longRate], night, 2, 2);
    expect('error' in res && res.error).toBe('min_nights');
    if ('error' in res) {
      expect(res.required).toBe(3);
    }
  });

  it('prefers longer minNights and then cheaper netRate', () => {
    const rate1 = { ...baseRate, id: 'r1', minNights: 1, netRate: 100 };
    const rate2 = { ...baseRate, id: 'r2', minNights: 2, netRate: 90 };
    const rate3 = { ...baseRate, id: 'r3', minNights: 2, netRate: 110 };

    const res = pickRate([rate1, rate2, rate3], night, 2, 3);
    expect('rate' in res && res.rate.id).toBe('r2');
  });
});