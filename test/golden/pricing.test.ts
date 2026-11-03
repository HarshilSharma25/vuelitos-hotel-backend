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
        occupancy: 2,
        pricingUnit: 'per_room',
        netRate: 120, // $120 / night for the room
        daysOfWeek: [],
        minNights: 1,
        maxNights: null,
        isActive: true,
      },
      {
        id: 'rate_standard_triple',
        roomTypeId: 'rt_standard',
        seasonId: 'season_golden',
        mealPlan: 'desayuno',
        concept: 'OCUPACION',
        priceKind: 'IMPORTE',
        occupancy: 3,
        pricingUnit: 'per_room',
        netRate: 150, // $150 / night
        daysOfWeek: [],
        minNights: 1,
        maxNights: null,
        isActive: true,
      },
      {
        id: 'rate_min3_nights',
        roomTypeId: 'rt_villa',
        seasonId: 'season_golden',
        mealPlan: 'desayuno',
        concept: 'OCUPACION',
        priceKind: 'IMPORTE',
        occupancy: 4,
        pricingUnit: 'per_room',
        netRate: 200,
        daysOfWeek: [],
        minNights: 3,
        maxNights: null,
        isActive: true,
      },
    ],
  };

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
          occupancy: 2,
          pricingUnit: 'per_room',
          netRate: 100, // 100 EUR / night
          daysOfWeek: [],
          minNights: 1,
          maxNights: null,
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
          occupancy: null,
          pricingUnit: 'per_person',
          netRate: 50, // $50 / person / night
          daysOfWeek: [],
          minNights: 1,
          maxNights: null,
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

  it('tests child pricing bands (flag off matches current, flag on computes child bands)', () => {
    const childSeason: SeasonInput = {
      id: 'season_child',
      hotelId: 'hotel_child',
      name: 'Temporada Child Bands',
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
          occupancy: 2,
          pricingUnit: 'per_room',
          netRate: 100, // $100 / night for room (2 adults)
          daysOfWeek: [],
          minNights: 1,
          maxNights: null,
          isActive: true,
        },
        {
          id: 'rate_child_gratis',
          roomTypeId: 'rt_child',
          seasonId: 'season_child',
          mealPlan: 'desayuno',
          concept: 'NINO',
          priceKind: 'GRATIS',
          occupancy: null,
          pricingUnit: 'per_person',
          netRate: 0,
          childAgeMin: 0,
          childAgeMax: 6,
          daysOfWeek: [],
          minNights: 1,
          maxNights: null,
          isActive: true,
        },
        {
          id: 'rate_child_percentage',
          roomTypeId: 'rt_child',
          seasonId: 'season_child',
          mealPlan: 'desayuno',
          concept: 'NINO',
          priceKind: 'PORCENTAJE_ADULTO',
          percentOfAdult: 50, // 50% of adult unit
          occupancy: null,
          pricingUnit: 'per_person',
          netRate: 0,
          childAgeMin: 7,
          childAgeMax: 12,
          daysOfWeek: [],
          minNights: 1,
          maxNights: null,
          isActive: true,
        },
      ],
    };

    // Case 1: Flag off (childBandsEnabled false)
    const resFlagOff = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-07', // 2 nights
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
      childBandsEnabled: false,
      seasons: [childSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });
    // With flag off, 2 adults + 1 child = 3 guests, rate requires occupancy 2 so fails with no_rate
    expect(resFlagOff.priced).toBe(false);

    // Case 2: Flag on, child age 4 is GRATIS
    (env as any).PRICING_CHILD_BANDS = true;
    const resChildFree = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-07', // 2 nights
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
      childBandsEnabled: true,
      seasons: [childSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });
    expect(resChildFree.priced).toBe(true);
    if (resChildFree.priced) {
      // 2 nights * $100 (room) + $0 (child gratis) = $200
      expect(resChildFree.total.base).toBe(200.0);
    }

    // Case 3: Flag on, child age 8 pays 50% of adult unit ($50/night -> $25/night)
    const resChildHalf = priceStay({
      checkIn: '2026-11-05',
      checkOut: '2026-11-07', // 2 nights
      mealPlan: 'desayuno',
      roomSelections: [
        {
          roomTypeId: 'rt_child',
          adults: 2,
          children: 1,
          childAges: [8],
        },
      ],
      baseCurrency: 'USD',
      isSoloDivisas: false,
      childBandsEnabled: true,
      seasons: [childSeason],
      paymentRules: mockPaymentRules,
      fx: mockFx,
      bookingDate: '2026-10-29',
    });
    expect(resChildHalf.priced).toBe(true);
    if (resChildHalf.priced) {
      // 2 nights * $100 room + 2 nights * ($100/2 * 50% = $25) child = $200 + $50 = $250
      expect(resChildHalf.total.base).toBe(250.0);
    }
  });
});
