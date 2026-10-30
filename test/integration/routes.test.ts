import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import argon2 from 'argon2';

describe('End-to-End API Routes Integration', () => {
  let createdHotelId: string;
  let testRoomTypeId: string;
  let testSeasonId: string;
  let adminSessionToken: string;

  async function cleanTestData() {
    await prisma.$executeRawUnsafe('ALTER TABLE booking_events DISABLE TRIGGER ALL;');
    const testHotels = await prisma.hotel.findMany({
      where: { slug: 'hotel-playa-el-agua' },
    });
    for (const h of testHotels) {
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
      await prisma.hotelImage.deleteMany({ where: { hotelId: h.id } });
      await prisma.availabilityCheck.deleteMany({ where: { hotelId: h.id } });
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

    // 1. Seed exchange rates if not already present
    const existingRate = await prisma.exchangeRate.findFirst();
    if (!existingRate) {
      await prisma.exchangeRate.create({
        data: {
          bcvUsd: 45.0,
          bcvEur: 49.0,
          binanceUsdt: 46.8,
          bcvUsdSource: 'test',
          bcvEurSource: 'test',
          usdtSource: 'test',
          bcvValueDate: new Date('2026-10-29T00:00:00Z'),
          source: 'manual',
          isManualOverride: true,
        },
      });
    }

    // 2. Seed Hotel
    const hotel = await prisma.hotel.create({
      data: {
        slug: 'hotel-playa-el-agua',
        name: 'Hotel Playa El Agua',
        destination: 'Isla de Margarita',
        category: 'Hotel',
        starRating: 4,
        baseCurrency: 'USD',
        isSoloDivisas: false,
        defaultCommissionPercent: 10,
        availabilityMode: 'manual',
        isActive: true,
      },
    });
    createdHotelId = hotel.id;

    // 3. Seed Room
    const room = await prisma.roomType.create({
      data: {
        hotelId: hotel.id,
        name: 'Habitación Estándar',
        maxOccupancy: 3,
        isActive: true,
      },
    });
    testRoomTypeId = room.id;

    // 4. Seed Season
    const season = await prisma.season.create({
      data: {
        hotelId: hotel.id,
        name: 'Temporada Alta 2026',
        priority: 1,
        dateFrom: new Date('2026-11-01T00:00:00Z'),
        dateTo: new Date('2026-11-30T00:00:00Z'),
        isActive: true,
      },
    });
    testSeasonId = season.id;

    // 5. Seed Rate
    await prisma.rate.create({
      data: {
        roomTypeId: room.id,
        seasonId: season.id,
        mealPlan: 'desayuno',
        concept: 'OCUPACION',
        priceKind: 'IMPORTE',
        occupancy: 2,
        pricingUnit: 'per_room',
        netRate: 100,
        minNights: 1,
        isActive: true,
      },
    });

    // 6. Seed Payment rules
    await prisma.hotelPaymentTaxRule.createMany({
      data: [
        { hotelId: hotel.id, method: 'zelle', ivaRate: 0 },
        { hotelId: hotel.id, method: 'pago_movil', ivaRate: 0.16 },
        { hotelId: hotel.id, method: 'usdt_binance', ivaRate: 0.16 },
      ],
    });

    // 7. Seed Admin User
    const hash = await argon2.hash('SecretAdminPass123!', { type: argon2.argon2id });
    await prisma.staffUser.upsert({
      where: { email: 'admin@vuelitos.com' },
      update: { passwordHash: hash, role: 'super_admin' },
      create: {
        email: 'admin@vuelitos.com',
        passwordHash: hash,
        role: 'super_admin',
      },
    });
  });

  afterAll(async () => {
    await cleanTestData();
    const seedAdminHash = await argon2.hash('Admin123!', { type: argon2.argon2id });
    await prisma.staffUser.updateMany({
      where: { email: 'admin@vuelitos.com' },
      data: { passwordHash: seedAdminHash },
    });
    await prisma.$disconnect();
  });

  it('GET /health returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('GET /api/v1/exchange-rates returns current rates', async () => {
    const res = await request(app).get('/api/v1/exchange-rates');
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.bcv_usd).toBe(45);
  });

  it('GET /api/v1/destinations returns active destinations', async () => {
    const res = await request(app).get('/api/v1/destinations');
    expect(res.status).toBe(200);
    expect(res.body.data.destinations.length).toBeGreaterThanOrEqual(1);
    expect(res.body.data.destinations).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'Isla de Margarita' })])
    );
  });

  it('GET /api/v1/hotels searches catalog', async () => {
    const res = await request(app).get('/api/v1/hotels?q=Playa%20El%20Agua');
    expect(res.status).toBe(200);
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.items[0].slug).toBe('hotel-playa-el-agua');
    expect(res.body.meta.applied).toBeDefined();
  });

  it('GET /api/v1/hotels/:slug returns detail', async () => {
    const res = await request(app).get('/api/v1/hotels/hotel-playa-el-agua');
    expect(res.status).toBe(200);
    expect(res.body.data.hotel.name).toBe('Hotel Playa El Agua');
    expect(res.body.data.rooms).toHaveLength(1);
  });

  it('POST /api/v1/hotels/:slug/price prices stay', async () => {
    const res = await request(app)
      .post('/api/v1/hotels/hotel-playa-el-agua/price')
      .send({
        check_in: '2026-11-10',
        check_out: '2026-11-12',
        meal_plan: 'desayuno',
        room_selections: [
          {
            room_type_id: testRoomTypeId,
            adults: 2,
            children: 0,
            child_ages: [],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.priced).toBe(true);
    expect(res.body.data.total.base).toBe(200); // 2 nights * $100
  });

  it('POST /api/v1/bookings creates a booking and returns access token', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: 'hotel-playa-el-agua',
            check_in: '2026-11-10',
            check_out: '2026-11-12',
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: testRoomTypeId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
        ],
        contact: {
          name: 'Carlos Perez',
          email: 'carlos@example.com',
          phone: '+584121234567',
        },
        locale: 'es',
        terms_accepted: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.code).toMatch(/^VH-\d{4}-\d{6}$/);
    expect(res.body.data.access_token).toBeDefined();
    expect(res.body.data.status).toBe('requested');

    const code = res.body.data.code;
    const token = res.body.data.access_token;

    // Retrieve booking view with token
    const viewRes = await request(app)
      .get(`/api/v1/bookings/${code}`)
      .set('X-Booking-Token', token);

    expect(viewRes.status).toBe(200);
    expect(viewRes.body.data.code).toBe(code);
    expect(viewRes.body.data.contact.name).toBe('Carlos Perez');
    expect(viewRes.body.data.allowed_actions).toContain('cancel');

    // Reject wrong token with 404
    const wrongTokenRes = await request(app)
      .get(`/api/v1/bookings/${code}`)
      .set('X-Booking-Token', 'wrong-token');
    expect(wrongTokenRes.status).toBe(404);

    // Cancel booking
    const cancelRes = await request(app)
      .post(`/api/v1/bookings/${code}/cancel`)
      .send({ token });

    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.data.status).toBe('cancelled');
  });

  it('POST /api/v1/bookings triggers honeypot silently if website is filled', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: 'hotel-playa-el-agua',
            check_in: '2026-11-10',
            check_out: '2026-11-12',
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: testRoomTypeId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
        ],
        contact: {
          name: 'Spam Bot',
          email: 'bot@spam.com',
        },
        terms_accepted: true,
        website: 'http://spam.com', // HONEYPOT FILLED
      });

    expect(res.status).toBe(201);
    expect(res.body.data.access_token).toBe('fake-honeypot-token');

    // Ensure it was NOT saved in database
    const dbBooking = await prisma.booking.findUnique({
      where: { code: res.body.data.code },
    });
    expect(dbBooking).toBeNull();
  });

  it('rejects group bookings with 422 GROUP_REQUEST_REQUIRED', async () => {
    const fiveRooms = Array.from({ length: 5 }, () => ({
      room_type_id: testRoomTypeId,
      adults: 2,
      children: 0,
      child_ages: [],
    }));

    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: 'hotel-playa-el-agua',
            check_in: '2026-11-10',
            check_out: '2026-11-12',
            meal_plan: 'desayuno',
            room_selections: fiveRooms,
          },
        ],
        contact: {
          name: 'Group Organizer',
          email: 'group@example.com',
        },
        terms_accepted: true,
      });

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('GROUP_REQUEST_REQUIRED');
  });

  it('admin login, authentication and authorization flow', async () => {
    // Login
    const loginRes = await request(app)
      .post('/api/admin/auth/sign-in')
      .send({
        email: 'admin@vuelitos.com',
        password: 'SecretAdminPass123!',
      });

    expect(loginRes.status).toBe(200);
    adminSessionToken = loginRes.body.data.token;
    expect(adminSessionToken).toBeDefined();

    // Access admin protected route
    const meRes = await request(app)
      .get('/api/admin/auth/me')
      .set('Authorization', `Bearer ${adminSessionToken}`);

    expect(meRes.status).toBe(200);
    expect(meRes.body.data.user.email).toBe('admin@vuelitos.com');
    expect(meRes.body.data.user.role).toBe('super_admin');

    // Access admin inbox
    const inboxRes = await request(app)
      .get('/api/admin/bookings')
      .set('Authorization', `Bearer ${adminSessionToken}`);

    expect(inboxRes.status).toBe(200);
    expect(Array.isArray(inboxRes.body.data)).toBe(true);
  });

  it('reports payment on awaiting_payment booking', async () => {
    // 1. Create a booking
    const createRes = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: 'hotel-playa-el-agua',
            check_in: '2026-11-10',
            check_out: '2026-11-12',
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: testRoomTypeId,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
        ],
        contact: {
          name: 'Maria Gomez',
          email: 'maria@example.com',
        },
        terms_accepted: true,
      });

    expect(createRes.status).toBe(201);
    const { code, access_token } = createRes.body.data;

    // 2. Transition booking from requested -> checking_availability -> awaiting_payment by admin
    await request(app)
      .post(`/api/admin/bookings/${code}/transition`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ event: 'start_check' });

    await request(app)
      .post(`/api/admin/bookings/${code}/transition`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ event: 'hotel_confirmed' });

    // 3. Customer reports payment
    const paymentRes = await request(app)
      .post(`/api/v1/bookings/${code}/payments`)
      .send({
        token: access_token,
        method: 'pago_movil',
        reference: 'PM-987654321',
      });

    expect(paymentRes.status).toBe(200);
    expect(paymentRes.body.data.status).toBe('payment_submitted');
    expect(paymentRes.body.data.payments).toHaveLength(1);
    expect(paymentRes.body.data.payments[0].reference).toBe('PM-987654321');
  });

  it('serves hotel detail safely when availability check has pending status', async () => {
    // Insert a pending availability check
    await prisma.availabilityCheck.create({
      data: {
        hotelId: createdHotelId,
        checkIn: new Date('2026-11-10T00:00:00Z'),
        checkOut: new Date('2026-11-12T00:00:00Z'),
        status: 'pending',
      },
    });

    const res = await request(app).get('/api/v1/hotels/hotel-playa-el-agua');
    expect(res.status).toBe(200);
    expect(res.body.data.availability.status).toBe('on_request');
    expect(res.body.data.availability.last_checked_at).toBeNull();
  });

  it('uploads, publishes, and deletes hotel images via admin API', async () => {
    // 1x1 transparent PNG buffer
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64'
    );

    const uploadRes = await request(app)
      .post(`/api/admin/hotels/${createdHotelId}/images`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .attach('file', pngBuffer, 'test.png')
      .field('alt', 'Beach view');

    expect(uploadRes.status).toBe(201);
    expect(uploadRes.body.data.status).toBe('held');
    expect(uploadRes.body.data.key).toContain('private/');

    const imageId = uploadRes.body.data.id;

    // Publish image
    const patchRes = await request(app)
      .patch(`/api/admin/images/${imageId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ status: 'published' });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('published');
    expect(patchRes.body.data.key).toContain('public/');

    // Delete image
    const delRes = await request(app)
      .delete(`/api/admin/images/${imageId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`);

    expect(delRes.status).toBe(200);
    expect(delRes.body.data.success).toBe(true);
  });

  it('prevents accepting a declined or expired quote', async () => {
    const createRes = await request(app)
      .post('/api/admin/quotes')
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        lines: [{ title: 'Special package', amount: 500 }],
        commission_percent: 10,
        commission_amount: 50,
      });

    expect(createRes.status).toBe(201);
    const quoteId = createRes.body.data.id;

    // Decline quote
    await request(app)
      .patch(`/api/admin/quotes/${quoteId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ status: 'declined' });

    // Attempt to accept declined quote must fail with 409 INVALID_TRANSITION
    const acceptRes = await request(app)
      .patch(`/api/admin/quotes/${quoteId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ status: 'accepted' });

    expect(acceptRes.status).toBe(409);
    expect(acceptRes.body.error.code).toBe('INVALID_TRANSITION');
  });

  it('supports tarifario dry-run and commit flow in admin API', async () => {
    const doc = {
      format_version: '1.0',
      source: 'api_test_tarifario.json',
      hotels: [
        {
          slug: 'hotel-playa-el-agua',
          name: 'Hotel Playa El Agua',
          destination: 'Isla de Margarita',
          category: 'Hotel',
          currency: 'USD',
          is_solo_divisas: false,
          rooms: [{ name: 'Habitación Estándar', max_occupancy: 3 }],
          seasons: [
            {
              name: 'Temporada Alta 2026',
              priority: 1,
              date_from: '2026-11-01',
              date_to: '2026-11-30',
              booking_from: null,
              booking_to: null,
            },
          ],
          rates: [
            {
              room_name: 'Habitación Estándar',
              season_name: 'Temporada Alta 2026',
              meal_plan: 'desayuno',
              concept: 'OCUPACION',
              price_kind: 'IMPORTE',
              occupancy: 2,
              pricing_unit: 'per_room',
              net_rate: 105, // Updated rate from 100 to 105
              days_of_week: [],
              min_nights: 1,
              max_nights: null,
              child_age_min: null,
              child_age_max: null,
            },
          ],
        },
      ],
    };

    // Dry run
    const dryRunRes = await request(app)
      .post('/api/admin/tarifario/imports')
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send(doc);

    expect(dryRunRes.status).toBe(200);
    const plan = dryRunRes.body.data;
    expect(plan.planId).toBeDefined();
    expect(plan.snapshotHash).toBeDefined();

    // Commit
    const commitRes = await request(app)
      .post(`/api/admin/tarifario/imports/${plan.planId}/commit`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ expected_hash: plan.snapshotHash });

    expect(commitRes.status).toBe(200);
    expect(commitRes.body.data.applied).toBe(true);
  });
});
