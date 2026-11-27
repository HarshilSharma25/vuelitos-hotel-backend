import { describe, it, expect } from 'vitest';
import {
  priceStay,
  SeasonInput,
  HotelPaymentRuleInput,
  FxRates,
} from '../../src/modules/pricing/index.js';
import { env } from '../../src/config/env.js';

describe('Golden Pricing Test Suite', () => {
  const mockFx: FxRates = {
    bcvUsd: 45.0,
    bcvEur: 49.0,
    binanceUsdt: 46.8,
    bcvValueDate: '2026-10-29',
    stale: false,
  };

  const mockPaymentRules: HotelPaymentRuleInput[] = [
    { method: 'zelle', ivaRate: 0 },
    { method: 'pago_movil', ivaRate: 0.16 },
    { method: 'usdt_binance', ivaRate: 0.16 },
    { method: 'cash_usd', ivaRate: 0 },
  ];

  const standardSeason: SeasonInput = {
    id: 'season_golden',
    hotelId: 'hotel_golden',
    name: 'Temporada Regular',
    priority: 1,
    dateFrom: '2026-11-01',
    dateTo: '2026-11-30',
    bookingFrom: null,
    bookingTo: null,
    isActive: true,
    rates: [
      {
        id: 'rate_standard_double',
        roomTypeId: 'rt_standard',
        seasonId: 'season_golden',
        mealPlan: 'desayuno',
        concept: 'OCUPACION',
        priceKind: 'IMPORTE',
                pricingUnit: 'per_room',
        netRate: 120, // $120 / night for the room
                minNights: 1,
        maxOccupancy: 4,
                isActive: true,
      },
      {
        id: 'rate_standard_triple',
        roomTypeId: 'rt_standard',
        seasonId: 'season_golden',
        mealPlan: 'desayuno',
        concept: 'OCUPACION',
        priceKind: 'IMPORTE',
                pricingUnit: 'per_room',
        netRate: 150, // $150 / night
                minNights: 1,
        maxOccupancy: 4,
                isActive: true,
      },
      {
        id: 'rate_min3_nights',
        roomTypeId: 'rt_villa',
        seasonId: 'season_golden',
        mealPlan: 'desayuno',
        concept: 'OCUPACION',
        priceKind: 'IMPORTE',
                pricingUnit: 'per_room',
        netRate: 200,
                minNights: 3,
        maxOccupancy: 4,
                isActive: true,
      },
    ],
  };

  it('charges the full room rate when one adult stays in a double', () => {
    const result = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-08', // 3 nights
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_standard',
          adults: 1,
          children: 0,
          childAges: [],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: false,
      seasons: [standardSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });

    expect(result.priced).toBe(true);
    if (!result.priced) return;
    // Tightest per-room band is occupancy 2 at $120, charged once per night.
    expect(result.total.base).toBe(360.0);
  });

  it('prices 3 nights double occupancy with frozen exact figures', () => {
    const result = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-08', // 3 nights
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_standard',
          adults: 2,
          children: 0,
          childAges: [],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: false,
      seasons: [standardSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });

    expect(result.priced).toBe(true);
    if (!result.priced) return;

    // 3 nights * $120 = $360 base
    expect(result.nights).toBe(3);
    expect(result.total.base).toBe(360.0);
    // bs = 360 * 45 * 1.16 = 18792.00
    expect(result.total.bs).toBe(18792.0);
    // usdt = 18792 / 46.8 = 401.54
    expect(result.total.usdt).toBe(401.54);

    // Verify payment methods
    const pm = result.methods.find((m) => m.method === 'pago_movil');
    expect(pm).toBeDefined();
    expect(pm?.currency).toBe('VES');
    expect(pm?.amount).toBe(18792.0);
    expect(pm?.iva_rate).toBe(0.16);
    expect(pm?.iva_amount).toBe(2592.0);

    const zelle = result.methods.find((m) => m.method === 'zelle');
    expect(zelle).toBeDefined();
    expect(zelle?.currency).toBe('USD');
    expect(zelle?.amount).toBe(360.0);
    expect(zelle?.iva_rate).toBe(0);

    // Lowest tag
    const lowest = result.methods.find((m) => m.is_lowest);
    expect(lowest).toBeDefined();
  });

  it('prices solo-divisas hotel with 1:1 USDT, no Bs and no IVA', () => {
    const result = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-08',
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_standard',
          adults: 2,
          children: 0,
          childAges: [],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: true, // SOLO DIVISAS
      seasons: [standardSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });

    expect(result.priced).toBe(true);
    if (!result.priced) return;

    expect(result.total.base).toBe(360.0);
    expect(result.total.bs).toBeNull();
    expect(result.total.usdt).toBe(360.0); // 1:1 with base

    // No VES rows for solo-divisas
    const vesRows = result.methods.filter((m) => m.currency === 'VES');
    expect(vesRows.length).toBe(0);

    const usdtRow = result.methods.find((m) => m.method === 'usdt_binance');
    expect(usdtRow?.amount).toBe(360.0);
    expect(usdtRow?.iva_rate).toBe(0);
  });

  it('correctly reports min_nights failure when stay is too short', () => {
    const result = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-07', // 2 nights, but villa requires 3
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_villa',
          adults: 4,
          children: 0,
          childAges: [],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: false,
      seasons: [standardSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });

    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toBe('min_nights');
    expect(result.minNightsRequired).toBe(3);
  });

  it('correctly reports no_season when dates are outside covering season', () => {
    const result = priceStay({
      checkIn: '2026-12-05',
      checkOut: '2026-12-08', // Season ends in Nov
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_standard',
          adults: 2,
          children: 0,
          childAges: [],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: false,
      seasons: [standardSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });

    expect(result.priced).toBe(false);
    if (result.priced) return;
    expect(result.reason).toBe('no_season');
  });

  it('prices EUR hotel with correct conversions', () => {
    const eurSeason: SeasonInput = {
      id: 'season_eur',
      hotelId: 'hotel_eur',
      name: 'Temporada EUR',
      priority: 1,
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
      bookingFrom: null,
      bookingTo: null,
      isActive: true,
      rates: [
        {
          id: 'rate_eur_standard',
          roomTypeId: 'rt_eur',
          seasonId: 'season_eur',
          mealPlan: 'desayuno',
          concept: 'OCUPACION',
          priceKind: 'IMPORTE',
                    pricingUnit: 'per_room',
          netRate: 100, // 100 EUR / night
                    minNights: 1,
          maxOccupancy: 2,
                    isActive: true,
        },
      ],
    };

    const result = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-07', // 2 nights
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_eur',
          adults: 2,
          children: 0,
          childAges: [],
        },
      ],
      baseCurrency: 'EUR',
      isSoloDivisas: false,
      seasons: [eurSeason],
      paymentRules: [
        { method: 'cash_eur', ivaRate: 0 },
        { method: 'pago_movil', ivaRate: 0.16 },
        { method: 'zelle', ivaRate: 0 },
      ],
      fx: mockFx, // bcvEur: 49.0, bcvUsd: 45.0, binanceUsdt: 46.8
      bookingDate: '2026-10-29',
    });

    expect(result.priced).toBe(true);
    if (!result.priced) return;

    // 2 nights * 100 = 200 EUR base
    expect(result.total.base).toBe(200.0);
    // bs = 200 * 49 * 1.16 = 11368.00
    expect(result.total.bs).toBe(11368.0);
    // usdt = 11368 / 46.8 = 242.91
    expect(result.total.usdt).toBe(242.91);

    const cashEur = result.methods.find((m) => m.method === 'cash_eur');
    expect(cashEur).toBeDefined();
    expect(cashEur?.currency).toBe('EUR');
    expect(cashEur?.amount).toBe(200.0);

    const pagoMovil = result.methods.find((m) => m.method === 'pago_movil');
    expect(pagoMovil).toBeDefined();
    expect(pagoMovil?.currency).toBe('VES');
    expect(pagoMovil?.amount).toBe(11368.0);
  });

  it('prices per_person pricingUnit correctly multiplying by guests', () => {
    const perPersonSeason: SeasonInput = {
      id: 'season_pp',
      hotelId: 'hotel_pp',
      name: 'Temporada PP',
      priority: 1,
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
      bookingFrom: null,
      bookingTo: null,
      isActive: true,
      rates: [
        {
          id: 'rate_pp',
          roomTypeId: 'rt_pp',
          seasonId: 'season_pp',
          mealPlan: 'desayuno',
          concept: 'OCUPACION',
          priceKind: 'IMPORTE',
                    pricingUnit: 'per_person',
          netRate: 50, // $50 / person / night
                    minNights: 1,
          maxOccupancy: 3,
                    isActive: true,
        },
      ],
    };

    const result = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-08', // 3 nights
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_pp',
          adults: 2,
          children: 1,
          childAges: [4],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: false,
      childBandsEnabled: false,
      seasons: [perPersonSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });

    expect(result.priced).toBe(true);
    if (!result.priced) return;

    // 3 guests * 3 nights * $50 = $450 base
    expect(result.total.base).toBe(450.0);
  });

  it('includes children in guest count for room occupancy', () => {
    const childSeason: SeasonInput = {
      id: 'season_child',
      hotelId: 'hotel_child',
      name: 'Temporada Child',
      priority: 1,
      dateFrom: '2026-11-01',
      dateTo: '2026-11-30',
      bookingFrom: null,
      bookingTo: null,
      isActive: true,
      rates: [
        {
          id: 'rate_adult',
          roomTypeId: 'rt_child',
          seasonId: 'season_child',
          mealPlan: 'desayuno',
          concept: 'OCUPACION',
          priceKind: 'IMPORTE',
          pricingUnit: 'per_room',
          netRate: 100,
          minNights: 1,
          maxOccupancy: 3,
          isActive: true,
        },
      ],
    };

    const res = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-07',
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_child',
          adults: 2,
          children: 1,
          childAges: [4],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: false,
      seasons: [childSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });

    expect(res.priced).toBe(true);
    if (res.priced) {
      expect(res.total.base).toBe(200.0);
    }
  });
});
