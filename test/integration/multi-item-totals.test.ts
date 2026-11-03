import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

describe('Multi-Item Booking Totals & Payment Method Intersection', () => {
  let hotelAId: string;
  let hotelBId: string;
  let hotelCId: string; // disjoint payment methods

  let hotelARoomId: string;
  let hotelBRoomId: string;
  let hotelCRoomId: string;

  let hotelASeasonId: string;
  let hotelBSeasonId: string;
  let hotelCSeasonId: string;

  const testHotelSlugs = ['test-multi-hotel-a', 'test-multi-hotel-b', 'test-multi-hotel-c'];

  async function cleanTestData() {
    await prisma.$executeRawUnsafe('ALTER TABLE booking_events DISABLE TRIGGER ALL;');
    const hotels = await prisma.hotel.findMany({
      where: { slug: { in: testHotelSlugs } },
    });
    for (const h of hotels) {
      const items = await prisma.bookingItem.findMany({ where: { hotelId: h.id } });
      const bIds = items.map((i) => i.bookingId);
      if (bIds.length > 0) {
        await prisma.bookingEvent.deleteMany({ where: { bookingId: { in: bIds } } });
        await prisma.payment.deleteMany({ where: { bookingId: { in: bIds } } });
        await prisma.availabilityCheck.deleteMany({ where: { bookingId: { in: bIds } } });
        await prisma.bookingItem.deleteMany({ where: { bookingId: { in: bIds } } });
        await prisma.booking.deleteMany({ where: { id: { in: bIds } } });
      }
      await prisma.rate.deleteMany({ where: { roomType: { hotelId: h.id } } });
      await prisma.season.deleteMany({ where: { hotelId: h.id } });
      await prisma.roomType.deleteMany({ where: { hotelId: h.id } });
      await prisma.hotelPaymentTaxRule.deleteMany({ where: { hotelId: h.id } });
      await prisma.hotel.delete({ where: { id: h.id } });
    }
    await prisma.$executeRawUnsafe('ALTER TABLE booking_events ENABLE TRIGGER ALL;');
    try {
      const { redis } = await import('../../src/lib/redis.js');
      const keys = await redis.keys('ratelimit:*');
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch {}
  }

  beforeAll(async () => {
    await cleanTestData();

    // Ensure exchange rate exists
    const existingRate = await prisma.exchangeRate.findFirst();
    if (!existingRate) {
      await prisma.exchangeRate.create({
        data: {
          bcvUsd: 50.0,
          bcvEur: 55.0,
          binanceUsdt: 52.0,
          bcvUsdSource: 'test',
          bcvEurSource: 'test',
          usdtSource: 'test',
          recordedAt: new Date(),
          fetchedAt: new Date(),
          bcvValueDate: new Date('2026-10-01'),
          source: 'auto',
          isManualOverride: false,
        },
      });
    }

    // Hotel A: offers pago_movil, zelle, usdt_binance
    const hotelA = await prisma.hotel.create({
      data: {
        slug: 'test-multi-hotel-a',
        name: 'Multi Hotel A',
        destination: 'Margarita',
        category: 'Resort',
        baseCurrency: 'USD',
        isSoloDivisas: false,
        defaultCommissionPercent: 10.0,
        availabilityMode: 'manual',
        isActive: true,
      },
    });
    hotelAId = hotelA.id;

    // Hotel B: offers zelle, usdt_binance, cash_usd
    const hotelB = await prisma.hotel.create({
      data: {
        slug: 'test-multi-hotel-b',
        name: 'Multi Hotel B',
        destination: 'Margarita',
        category: 'Boutique',
        baseCurrency: 'USD',
        isSoloDivisas: false,
        defaultCommissionPercent: 12.0,
        availabilityMode: 'manual',
        isActive: true,
      },
    });
    hotelBId = hotelB.id;

    // Hotel C: offers only cash_eur
    const hotelC = await prisma.hotel.create({
      data: {
        slug: 'test-multi-hotel-c',
        name: 'Multi Hotel C (Disjoint)',
        destination: 'Margarita',
        category: 'Posada',
        baseCurrency: 'USD',
        isSoloDivisas: false,
        defaultCommissionPercent: 10.0,
        availabilityMode: 'manual',
        isActive: true,
      },
    });
    hotelCId = hotelC.id;

    // Payment rules for Hotel A: pago_movil, zelle, usdt_binance
    await prisma.hotelPaymentTaxRule.createMany({
      data: [
        { hotelId: hotelAId, method: 'pago_movil', ivaRate: 0.16 },
        { hotelId: hotelAId, method: 'zelle', ivaRate: 0.0 },
        { hotelId: hotelAId, method: 'usdt_binance', ivaRate: 0.0 },
      ],
    });

    // Payment rules for Hotel B: zelle, usdt_binance, cash_usd
    await prisma.hotelPaymentTaxRule.createMany({
      data: [
        { hotelId: hotelBId, method: 'zelle', ivaRate: 0.0 },
        { hotelId: hotelBId, method: 'usdt_binance', ivaRate: 0.0 },
        { hotelId: hotelBId, method: 'cash_usd', ivaRate: 0.0 },
      ],
    });

    // Payment rules for Hotel C: cash_eur only
    await prisma.hotelPaymentTaxRule.createMany({
      data: [{ hotelId: hotelCId, method: 'cash_eur', ivaRate: 0.0 }],
    });

    // Room types
    const rA = await prisma.roomType.create({
      data: { hotelId: hotelAId, name: 'Standard A', maxOccupancy: 4, isActive: true },
    });
    hotelARoomId = rA.id;

    const rB = await prisma.roomType.create({
      data: { hotelId: hotelBId, name: 'Standard B', maxOccupancy: 4, isActive: true },
    });
    hotelBRoomId = rB.id;

    const rC = await prisma.roomType.create({
      data: { hotelId: hotelCId, name: 'Standard C', maxOccupancy: 4, isActive: true },
    });
    hotelCRoomId = rC.id;

    // Seasons
    const sA = await prisma.season.create({
      data: {
        hotelId: hotelAId,
        name: 'Regular A',
        priority: 1,
        dateFrom: new Date('2026-01-01'),
        dateTo: new Date('2026-12-31'),
        isActive: true,
      },
    });
    hotelASeasonId = sA.id;

    const sB = await prisma.season.create({
      data: {
        hotelId: hotelBId,
        name: 'Regular B',
        priority: 1,
        dateFrom: new Date('2026-01-01'),
        dateTo: new Date('2026-12-31'),
        isActive: true,
      },
    });
    hotelBSeasonId = sB.id;

    const sC = await prisma.season.create({
      data: {
        hotelId: hotelCId,
        name: 'Regular C',
        priority: 1,
        dateFrom: new Date('2026-01-01'),
        dateTo: new Date('2026-12-31'),
        isActive: true,
      },
    });
    hotelCSeasonId = sC.id;

    // Rates: 100 USD/night for A, 150 USD/night for B, 200 USD/night for C
    await prisma.rate.createMany({
      data: [
        {
          roomTypeId: hotelARoomId,
          seasonId: hotelASeasonId,
          mealPlan: 'desayuno',
          concept: 'OCUPACION',
          priceKind: 'IMPORTE',
          occupancy: 2,
          pricingUnit: 'per_room',
          netRate: 100.0,
          minNights: 1,
          daysOfWeek: [],
          isActive: true,
        },
        {
          roomTypeId: hotelBRoomId,
          seasonId: hotelBSeasonId,
          mealPlan: 'desayuno',
          concept: 'OCUPACION',
          priceKind: 'IMPORTE',
          occupancy: 2,
          pricingUnit: 'per_room',
          netRate: 150.0,
          minNights: 1,
          daysOfWeek: [],
          isActive: true,
        },
        {
          roomTypeId: hotelCRoomId,
          seasonId: hotelCSeasonId,
          mealPlan: 'desayuno',
          concept: 'OCUPACION',
          priceKind: 'IMPORTE',
          occupancy: 2,
          pricingUnit: 'per_room',
          netRate: 200.0,
          minNights: 1,
          daysOfWeek: [],
          isActive: true,
        },
      ],
    });
  });

  afterAll(async () => {
    await cleanTestData();
  });

  it('correctly combines totals for 2 items in the same hotel', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: 'test-multi-hotel-a',
            check_in: '2026-11-10',
            check_out: '2026-11-12', // 2 nights x 100 = 200
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: hotelARoomId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
          {
            type: 'hotel_stay',
            hotel_slug: 'test-multi-hotel-a',
            check_in: '2026-11-15',
            check_out: '2026-11-18', // 3 nights x 100 = 300
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: hotelARoomId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
        ],
        contact: {
          name: 'Multi Item Tester',
          email: 'multi@example.com',
        },
        terms_accepted: true,
      });

    expect(res.status).toBe(201);
    const code = res.body.data.code;
    const token = res.body.data.access_token;

    // View booking and check combined totals
    const viewRes = await request(app)
      .get(`/api/v1/bookings/${code}`)
      .set('X-Booking-Token', token);

    expect(viewRes.status).toBe(200);
    const totals = viewRes.body.data.totals_by_method;
    expect(totals).toBeInstanceOf(Array);

    // Zelle: total should be 200 + 300 = 500 USD
    const zelle = totals.find((t: any) => t.method === 'zelle');
    expect(zelle).toBeDefined();
    expect(zelle.amount).toBe(500);
    expect(zelle.currency).toBe('USD');

    // Pago movil: total amount with 16% IVA
    const pm = totals.find((t: any) => t.method === 'pago_movil');
    expect(pm).toBeDefined();
    const rate = await prisma.exchangeRate.findFirst({ orderBy: { recordedAt: 'desc' } });
    const bcv = Number(rate!.bcvUsd);
    const expectedBaseVes = 500 * bcv;
    const expectedIva = expectedBaseVes * 0.16;
    expect(pm.amount).toBe(Math.round((expectedBaseVes + expectedIva) * 100) / 100);
    expect(pm.iva_amount).toBe(Math.round(expectedIva * 100) / 100);
  });

  it('correctly intersects payment methods between 2 hotels with different payment rules', async () => {
    // Hotel A offers: pago_movil, zelle, usdt_binance
    // Hotel B offers: zelle, usdt_binance, cash_usd
    // Common: zelle, usdt_binance
    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: 'test-multi-hotel-a',
            check_in: '2026-11-10',
            check_out: '2026-11-11', // 1 night x 100 = 100 USD
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: hotelARoomId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
          {
            type: 'hotel_stay',
            hotel_slug: 'test-multi-hotel-b',
            check_in: '2026-11-12',
            check_out: '2026-11-14', // 2 nights x 150 = 300 USD
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: hotelBRoomId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
        ],
        contact: {
          name: 'Two Hotel Tester',
          email: 'two@example.com',
        },
        terms_accepted: true,
      });

    expect(res.status).toBe(201);
    const code = res.body.data.code;
    const token = res.body.data.access_token;

    const viewRes = await request(app)
      .get(`/api/v1/bookings/${code}`)
      .set('X-Booking-Token', token);

    expect(viewRes.status).toBe(200);
    const totals = viewRes.body.data.totals_by_method;
    const offeredMethods = totals.map((t: any) => t.method);

    // Only zelle and usdt_binance should be offered!
    expect(offeredMethods).toContain('zelle');
    expect(offeredMethods).toContain('usdt_binance');
    expect(offeredMethods).not.toContain('pago_movil');
    expect(offeredMethods).not.toContain('cash_usd');

    const zelle = totals.find((t: any) => t.method === 'zelle');
    expect(zelle.amount).toBe(400); // 100 + 300
  });

  it('rejects with 422 STAY_NOT_BOOKABLE when payment methods intersection is empty', async () => {
    // Hotel A offers: pago_movil, zelle, usdt_binance
    // Hotel C offers: cash_eur only
    // Intersection is empty!
    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: 'test-multi-hotel-a',
            check_in: '2026-11-10',
            check_out: '2026-11-11',
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: hotelARoomId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
          {
            type: 'hotel_stay',
            hotel_slug: 'test-multi-hotel-c',
            check_in: '2026-11-12',
            check_out: '2026-11-13',
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: hotelCRoomId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
        ],
        contact: {
          name: 'Disjoint Tester',
          email: 'disjoint@example.com',
        },
        terms_accepted: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('STAY_NOT_BOOKABLE');
    expect(res.body.error.message).toMatch(/payment method/i);
  });
});
