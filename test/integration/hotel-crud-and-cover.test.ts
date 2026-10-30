import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import argon2 from 'argon2';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';

describe('Admin Hotel CRUD, Key Mapping & Cover Image Management', () => {
  let adminSessionToken: string;
  let testHotelId: string;

  beforeAll(async () => {
    // 1. Create admin user with argon2 password and sign in
    const hash = await argon2.hash('SecretAdminPass123!', { type: argon2.argon2id });
    await prisma.staffUser.upsert({
      where: { email: 'hotel-crud-admin@example.com' },
      update: { passwordHash: hash },
      create: {
        email: 'hotel-crud-admin@example.com',
        passwordHash: hash,
        role: 'super_admin',
      },
    });

    const loginRes = await request(app)
      .post('/api/admin/auth/sign-in')
      .send({
        email: 'hotel-crud-admin@example.com',
        password: 'SecretAdminPass123!',
      });
    adminSessionToken = loginRes.body.data.token;

    // 2. Create a base test hotel
    const hotel = await prisma.hotel.upsert({
      where: { slug: 'test-crud-hotel' },
      update: {},
      create: {
        name: 'Initial Hotel',
        slug: 'test-crud-hotel',
        destination: 'Caracas',
        category: 'Hotel',
        starRating: 3,
        baseCurrency: 'USD',
        isSoloDivisas: false,
        defaultCommissionPercent: 10.0,
        availabilityMode: 'manual',
        isActive: true,
        description: 'Initial description',
      },
    });
    testHotelId = hotel.id;
  });

  it('PATCH /hotels/:id correctly updates hotel with snake_case payload (Original Error Case)', async () => {
    // This payload contains snake_case keys that originally caused:
    // "Unknown argument star_rating. Did you mean starRating?"
    const payload = {
      name: 'Hotel Test Updated',
      slug: 'hotel-test-updated',
      destination: 'Caracas',
      category: 'Hotel',
      star_rating: 4,
      base_currency: 'USD',
      is_solo_divisas: true,
      default_commission_percent: 15,
      availability_mode: 'manual',
      is_active: true,
      description: 'Updated with snake_case keys',
      cover_image_key: 'public/hotels/cover-1.webp',
      cover_image_url: 'https://images.example.com/cover-1.webp',
      // Extra fields that might come from frontend state
      id: testHotelId,
      random_unknown_field: 'should be stripped safely',
    };

    const res = await request(app)
      .patch(`/api/admin/hotels/${testHotelId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Hotel Test Updated');
    expect(res.body.data.starRating).toBe(4);
    expect(res.body.data.isSoloDivisas).toBe(true);
    expect(Number(res.body.data.defaultCommissionPercent)).toBe(15);
    expect(res.body.data.coverImageKey).toBe('public/hotels/cover-1.webp');
    expect(res.body.data.coverImageUrl).toBe('https://images.example.com/cover-1.webp');
    expect(res.body.data.cover_image_url).toBe('https://images.example.com/cover-1.webp');
  });

  it('PATCH /hotels/:id correctly updates hotel with camelCase payload', async () => {
    const payload = {
      name: 'Hotel Test Camel',
      starRating: 5,
      baseCurrency: 'EUR',
      isSoloDivisas: false,
      defaultCommissionPercent: 12.5,
      availabilityMode: 'api',
      isActive: true,
      coverImageUrl: 'https://images.example.com/cover-camel.webp',
    };

    const res = await request(app)
      .patch(`/api/admin/hotels/${testHotelId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Hotel Test Camel');
    expect(res.body.data.starRating).toBe(5);
    expect(res.body.data.baseCurrency).toBe('EUR');
    expect(res.body.data.isSoloDivisas).toBe(false);
    expect(Number(res.body.data.defaultCommissionPercent)).toBe(12.5);
    expect(res.body.data.availabilityMode).toBe('api');
    expect(res.body.data.coverImageUrl).toBe('https://images.example.com/cover-camel.webp');
  });

  it('POST /hotels creates a hotel accepting snake_case and camelCase with cover image', async () => {
    const slug = `new-hotel-${Date.now()}`;
    const payload = {
      name: 'Brand New Hotel',
      slug,
      destination: 'Los Roques',
      category: 'Posada',
      star_rating: 4,
      base_currency: 'USD',
      is_solo_divisas: true,
      default_commission_percent: 10,
      availability_mode: 'manual',
      is_active: true,
      description: 'New posada description',
      cover_image_url: 'https://images.example.com/posada-cover.webp',
    };

    const res = await request(app)
      .post('/api/admin/hotels')
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send(payload);

    expect(res.status).toBe(201);
    expect(res.body.data.name).toBe('Brand New Hotel');
    expect(res.body.data.starRating).toBe(4);
    expect(res.body.data.isSoloDivisas).toBe(true);
    expect(res.body.data.coverImageUrl).toBe('https://images.example.com/posada-cover.webp');
    expect(Array.isArray(res.body.data.images)).toBe(true);
  });

  it('GET /api/admin/hotels includes images and coverImageUrl for all hotels', async () => {
    const res = await request(app)
      .get('/api/admin/hotels')
      .set('Authorization', `Bearer ${adminSessionToken}`);

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);

    const testHotel = res.body.data.find((h: any) => h.id === testHotelId);
    expect(testHotel).toBeDefined();
    expect(Array.isArray(testHotel.images)).toBe(true);
    expect(testHotel.coverImageUrl).toBeDefined();
    expect(testHotel.cover_image_url).toBeDefined();
  });

  it('GET /api/admin/hotels/:id returns hotel with images and resolved cover image', async () => {
    const res = await request(app)
      .get(`/api/admin/hotels/${testHotelId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(testHotelId);
    expect(Array.isArray(res.body.data.images)).toBe(true);
    expect(res.body.data.coverImageUrl).toBe('https://images.example.com/cover-camel.webp');
  });

  it('PATCH /hotels/:id/rooms/:roomId handles snake_case max_occupancy and is_active', async () => {
    const room = await prisma.roomType.create({
      data: {
        hotelId: testHotelId,
        name: 'Standard Suite',
        maxOccupancy: 2,
        isActive: true,
      },
    });

    const res = await request(app)
      .patch(`/api/admin/hotels/${testHotelId}/rooms/${room.id}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        name: 'Deluxe Suite',
        max_occupancy: 4,
        is_active: false,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Deluxe Suite');
    expect(res.body.data.maxOccupancy).toBe(4);
    expect(res.body.data.isActive).toBe(false);
  });

  it('PATCH /hotels/:id returns 404 if hotel does not exist', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000000';
    const res = await request(app)
      .patch(`/api/admin/hotels/${nonExistentId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ name: 'Ghost Hotel' });

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe('NOT_FOUND');
  });

  it('PATCH /hotels/:id rejects invalid star_rating with 400 validation error', async () => {
    const res = await request(app)
      .patch(`/api/admin/hotels/${testHotelId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({ star_rating: 'five' });

    expect(res.status).toBe(400);
    expect(res.body.error?.code).toBe('VALIDATION_ERROR');

    // Verify database starRating was not corrupted to null or NaN
    const checkHotel = await prisma.hotel.findUnique({ where: { id: testHotelId } });
    expect(checkHotel?.starRating).toBe(5);
  });

  it('PATCH /hotels/:id allows clearing cover image when null is passed', async () => {
    const res = await request(app)
      .patch(`/api/admin/hotels/${testHotelId}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        cover_image_key: null,
        cover_image_url: null,
      });

    expect(res.status).toBe(200);
    expect(res.body.data.coverImageKey).toBeNull();
    expect(res.body.data.coverImageUrl).toBeNull();
    expect(res.body.data.cover_image_key).toBeNull();
    expect(res.body.data.cover_image_url).toBeNull();
  });

  it('GET /api/v1/hotels and GET /api/v1/hotels/:slug include cover_image_url and coverImageUrl in public catalog response', async () => {
    // 1. Ensure test hotel is active and has a room, season, rate, and coverImageUrl
    await prisma.hotel.update({
      where: { id: testHotelId },
      data: {
        slug: 'test-crud-hotel',
        coverImageKey: 'public/hotels/public-cover.webp',
        coverImageUrl: 'https://images.example.com/public-cover.webp',
        isActive: true,
      },
    });

    const room = await prisma.roomType.upsert({
      where: { id: 'room-pub-test-1' },
      update: { maxOccupancy: 2, isActive: true },
      create: {
        id: 'room-pub-test-1',
        hotelId: testHotelId,
        name: 'Public Test Room',
        maxOccupancy: 2,
        isActive: true,
      },
    });

    const season = await prisma.season.upsert({
      where: { id: 'season-pub-test-1' },
      update: { priority: 1, isActive: true },
      create: {
        id: 'season-pub-test-1',
        hotelId: testHotelId,
        name: 'Public Season',
        priority: 1,
        dateFrom: new Date('2026-01-01T00:00:00Z'),
        dateTo: new Date('2026-12-31T00:00:00Z'),
        isActive: true,
      },
    });

    await prisma.rate.upsert({
      where: { id: 'rate-pub-test-1' },
      update: { netRate: 100, isActive: true },
      create: {
        id: 'rate-pub-test-1',
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

    // Also ensure a sample exchange rate exists so catalog pricing does not fail
    const existingRate = await prisma.exchangeRate.findFirst();
    if (!existingRate) {
      await prisma.exchangeRate.create({
        data: {
          source: 'manual',
          bcvUsd: 45,
          bcvEur: 48,
          binanceUsdt: 46,
          bcvUsdSource: 'manual',
          bcvEurSource: 'manual',
          usdtSource: 'manual',
          bcvValueDate: new Date('2026-10-30T00:00:00Z'),
        },
      });
    }

    // 2. Query public catalog
    const catRes = await request(app).get('/api/v1/hotels');
    expect(catRes.status).toBe(200);
    const pubHotelCard = catRes.body.data.items.find((item: any) => item.slug === 'test-crud-hotel');
    if (pubHotelCard) {
      expect(pubHotelCard.cover_image_url).toBe('https://images.example.com/public-cover.webp');
      expect(pubHotelCard.coverImageUrl).toBe('https://images.example.com/public-cover.webp');
      expect(pubHotelCard.cover_image_key).toBe('public/hotels/public-cover.webp');
      expect(pubHotelCard.coverImageKey).toBe('public/hotels/public-cover.webp');
    }

    // 3. Query public hotel detail
    const detailRes = await request(app).get('/api/v1/hotels/test-crud-hotel');
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.data.hotel.cover_image_url).toBe('https://images.example.com/public-cover.webp');
    expect(detailRes.body.data.hotel.coverImageUrl).toBe('https://images.example.com/public-cover.webp');
    expect(detailRes.body.data.hotel.cover_image_key).toBe('public/hotels/public-cover.webp');
    expect(detailRes.body.data.hotel.coverImageKey).toBe('public/hotels/public-cover.webp');
  });

  it('PUT /hotels/:id/payment-methods accepts camelCase ivaRate and surchargePercent', async () => {
    const res = await request(app)
      .put(`/api/admin/hotels/${testHotelId}/payment-methods`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        methods: [
          { method: 'zelle', ivaRate: 0, surchargePercent: 5 },
          { method: 'pago_movil', ivaRate: 0.16, surchargePercent: 0 },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.data.success).toBe(true);

    const rules = await prisma.hotelPaymentTaxRule.findMany({ where: { hotelId: testHotelId } });
    expect(rules).toHaveLength(2);
    const zelleRule = rules.find((r) => r.method === 'zelle');
    expect(Number(zelleRule?.surchargePercent)).toBe(5);
  });

  it('POST /availability accepts camelCase hotelId, checkIn, checkOut', async () => {
    const res = await request(app)
      .post('/api/admin/availability')
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        hotelId: testHotelId,
        checkIn: '2026-11-15',
        checkOut: '2026-11-18',
        status: 'available',
        note: 'High demand dates',
      });

    expect(res.status).toBe(201);
    expect(res.body.data.hotelId).toBe(testHotelId);
    expect(res.body.data.status).toBe('available');
  });

  it('PATCH /rates/:id preserves 0 value for markupPercent', async () => {
    const rate = await prisma.rate.findFirst({
      where: { season: { hotelId: testHotelId } },
    });

    if (rate) {
      const res = await request(app)
        .patch(`/api/admin/rates/${rate.id}`)
        .set('Authorization', `Bearer ${adminSessionToken}`)
        .send({
          markup_percent: 0,
        });

      expect(res.status).toBe(200);
      expect(Number(res.body.data.markupPercent)).toBe(0);
    }
  });

  it('PATCH /quotes/:id handles snake_case commission_percent without Prisma error', async () => {
    const quote = await prisma.quote.create({
      data: {
        code: `Q-${Date.now()}`,
        tokenKey: crypto.randomUUID(),
        lines: [],
        commissionPercent: 10,
        commissionAmount: 50,
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000),
      },
    });

    const res = await request(app)
      .patch(`/api/admin/quotes/${quote.id}`)
      .set('Authorization', `Bearer ${adminSessionToken}`)
      .send({
        commission_percent: 15,
        internal_notes: 'Updated note via snake_case',
      });

    expect(res.status).toBe(200);
    expect(Number(res.body.data.commissionPercent)).toBe(15);
    expect(res.body.data.internalNotes).toBe('Updated note via snake_case');
  });
});
