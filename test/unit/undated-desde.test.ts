import { describe, it, expect } from 'vitest';
import { calculateUndatedDesde } from '../../src/modules/catalog/service.js';
import { SeasonInput } from '../../src/modules/pricing/types.js';

describe('calculateUndatedDesde', () => {
  const season: SeasonInput = {
    id: 's1',
    hotelId: 'h1',
    name: 'A1',
    priority: 1,
    dateFrom: '2026-11-06',
    dateTo: '2026-12-06',
    bookingFrom: null,
    bookingTo: null,
    isActive: true,
    rates: [
      {
        id: 'double',
        roomTypeId: 'suite',
        seasonId: 's1',
        mealPlan: 'desayuno',
        concept: 'OCUPACION',
        priceKind: 'IMPORTE',
                pricingUnit: 'per_room',
        netRate: 100,
        minNights: 1,
        maxOccupancy: 2,
        isActive: true,
      },
    ],
  };

  const fx = { bcvUsd: null, bcvEur: null, binanceUsdt: null, stale: true };

  it('prices one adult at the full double room rate', () => {
    const result = calculateUndatedDesde(
      [{ id: 'suite', maxOccupancy: 2 }],
      [season],
      ['desayuno'],
      undefined,
      1,
      1,
      'USD',
      false,
      fx
    );

    expect(result.availability).toBe('ok');
    expect(result.price.base).toBe(100);
  });
});
