import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import * as catalogSchemas from '../../src/modules/catalog/schemas.js';
import * as bookingSchemas from '../../src/modules/bookings/schemas.js';
import * as ratesRoutes from '../../src/modules/rates/routes.js';
import * as quoteSchemas from '../../src/modules/quotes/schemas.js';

describe('Leak Scan Contract Tests', () => {
  const FORBIDDEN_WORDS = [
    'net_rate',
    'commission',
    'markup',
    'internal_notes',
    'destination_details_enc',
    'storage_key',
    'destinationDetailsEnc',
  ];

  function checkSchemaForForbiddenKeys(obj: any, path = ''): string[] {
    const violations: string[] = [];
    if (!obj || typeof obj !== 'object') return violations;

    for (const [key, val] of Object.entries(obj)) {
      const currentPath = path ? `${path}.${key}` : key;
      const lowerKey = key.toLowerCase();

      for (const forbidden of FORBIDDEN_WORDS) {
        if (lowerKey.includes(forbidden)) {
          violations.push(`Found forbidden term '${forbidden}' at ${currentPath}`);
        }
      }

      if (typeof val === 'object' && val !== null) {
        if ((val as any)._def?.shape) {
          const shape =
            typeof (val as any)._def.shape === 'function'
              ? (val as any)._def.shape()
              : (val as any)._def.shape;
          violations.push(...checkSchemaForForbiddenKeys(shape, currentPath));
        } else if ((val as any)._def?.schema) {
          violations.push(...checkSchemaForForbiddenKeys((val as any)._def.schema, currentPath));
        } else {
          violations.push(...checkSchemaForForbiddenKeys(val, currentPath));
        }
      }
    }

    return violations;
  }

  function checkJsonForForbiddenTerms(data: any, path = ''): string[] {
    const violations: string[] = [];
    if (!data) return violations;

    if (typeof data === 'string') {
      const lower = data.toLowerCase();
      for (const forbidden of FORBIDDEN_WORDS) {
        if (lower.includes(forbidden)) {
          violations.push(`Found forbidden string '${forbidden}' at ${path}`);
        }
      }
      return violations;
    }

    if (Array.isArray(data)) {
      data.forEach((item, idx) => {
        violations.push(...checkJsonForForbiddenTerms(item, `${path}[${idx}]`));
      });
      return violations;
    }

    if (typeof data === 'object') {
      for (const [key, val] of Object.entries(data)) {
        const currentPath = path ? `${path}.${key}` : key;
        const lowerKey = key.toLowerCase();
        for (const forbidden of FORBIDDEN_WORDS) {
          if (lowerKey.includes(forbidden)) {
            violations.push(`Found forbidden key '${forbidden}' at ${currentPath}`);
          }
        }
        violations.push(...checkJsonForForbiddenTerms(val, currentPath));
      }
    }

    return violations;
  }

  it('ensures no public schemas expose sensitive pricing or internal notes', () => {
    const publicModules = [catalogSchemas, bookingSchemas, ratesRoutes, quoteSchemas];

    for (const mod of publicModules) {
      for (const [schemaName, schemaObj] of Object.entries(mod)) {
        if (typeof schemaObj === 'object' && schemaObj !== null) {
          const violations = checkSchemaForForbiddenKeys({ [schemaName]: schemaObj });
          expect(
            violations,
            `Leak scan failed in schema '${schemaName}': ${violations.join(', ')}`
          ).toEqual([]);
        }
      }
    }

    // Explicit check: catalog and quote schemas MUST never leak guest_details
    const forbiddenGuestSchemas = [catalogSchemas, quoteSchemas];
    for (const mod of forbiddenGuestSchemas) {
      for (const [schemaName, schemaObj] of Object.entries(mod)) {
        if (typeof schemaObj === 'object' && schemaObj !== null) {
          const rawKeys = JSON.stringify(schemaObj);
          expect(rawKeys.includes('guest_details') || rawKeys.includes('guestDetails')).toBe(false);
        }
      }
    }
  });

  it('ensures live public /api/v1 endpoints do not leak internal fields', async () => {
    const { prisma } = await import('../../src/lib/prisma.js');

    // 1. Rates
    const ratesRes = await request(app).get('/api/v1/rates');
    expect(checkJsonForForbiddenTerms(ratesRes.body)).toEqual([]);

    const ratesHistoryRes = await request(app).get('/api/v1/rates/history');
    expect(checkJsonForForbiddenTerms(ratesHistoryRes.body)).toEqual([]);

    // 2. Catalog (Hotels, Destinations, Categories)
    const hotelsRes = await request(app).get('/api/v1/hotels');
    expect(checkJsonForForbiddenTerms(hotelsRes.body)).toEqual([]);

    let testHotel = await prisma.hotel.findFirst({ where: { isActive: true } });
    if (!testHotel) {
      testHotel = await prisma.hotel.create({
        data: {
          slug: 'hotel-leak-test',
          name: 'Hotel Leak Test',
          destination: 'Caracas',
          category: 'Boutique',
          baseCurrency: 'USD',
          isActive: true,
        },
      });
    }

    const hotelDetailRes = await request(app).get(`/api/v1/hotels/${testHotel.slug}`);
    expect(checkJsonForForbiddenTerms(hotelDetailRes.body)).toEqual([]);

    const destRes = await request(app).get('/api/v1/destinations');
    expect(checkJsonForForbiddenTerms(destRes.body)).toEqual([]);

    const destDetailRes = await request(app).get('/api/v1/destinations/caracas');
    expect(checkJsonForForbiddenTerms(destDetailRes.body)).toEqual([]);

    const catRes = await request(app).get('/api/v1/categories');
    expect(checkJsonForForbiddenTerms(catRes.body)).toEqual([]);

    // 3. Leads creation
    const leadRes = await request(app).post('/api/v1/leads').send({
      name: 'Leak Test User',
      email: 'leaktest@example.com',
      message: 'Testing for leaks',
    });
    expect(checkJsonForForbiddenTerms(leadRes.body)).toEqual([]);

    // 4. Quote share view (with actual quote containing sensitive internal fields)
    const quoteToken = '12345678-1234-1234-1234-123456789abc';
    await prisma.quote.deleteMany({ where: { tokenKey: quoteToken } });
    const quote = await prisma.quote.create({
      data: {
        code: 'Q-LEAK-TEST',
        tokenKey: quoteToken,
        status: 'draft',
        lines: [{ description: 'Test Room Stay', amount: 500 }],
        commissionPercent: 15.0,
        commissionAmount: 75.0,
        internalNotes: 'Top secret internal agent notes that must never leak to customer',
        expiresAt: new Date(Date.now() + 86400000),
      },
    });

    const quoteRes = await request(app).get(`/api/v1/quotes/share/${quote.tokenKey}`);
    expect(quoteRes.status).toBe(200);
    expect(checkJsonForForbiddenTerms(quoteRes.body)).toEqual([]);
    expect(JSON.stringify(quoteRes.body)).not.toContain('Top secret');
    expect(JSON.stringify(quoteRes.body)).not.toContain('commission');

    // 5. Bookings
    let testRoom = await prisma.roomType.findFirst({ where: { hotelId: testHotel.id } });
    if (!testRoom) {
      testRoom = await prisma.roomType.create({
        data: {
          hotelId: testHotel.id,
          name: 'Standard Leak Room',
          maxOccupancy: 2,
          isActive: true,
        },
      });
      const season = await prisma.season.create({
        data: {
          hotelId: testHotel.id,
          name: 'Season Leak Test',
          priority: 1,
          dateFrom: new Date('2026-01-01'),
          dateTo: new Date('2026-12-31'),
          isActive: true,
        },
      });
      await prisma.rate.create({
        data: {
          roomTypeId: testRoom.id,
          seasonId: season.id,
          mealPlan: 'desayuno',
          concept: 'OCUPACION',
          priceKind: 'IMPORTE',
          occupancy: 2,
          pricingUnit: 'per_room',
          netRate: 100,
          isActive: true,
        },
      });
      await prisma.hotelPaymentTaxRule.create({
        data: {
          hotelId: testHotel.id,
          method: 'zelle',
          ivaRate: 0,
        },
      });
    }

    const bookingRes = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: testHotel.slug,
            check_in: '2026-11-10',
            check_out: '2026-11-12',
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: testRoom.id,
                adults: 2,
                children: 0,
                child_ages: [],
              },
            ],
          },
        ],
        contact: {
          name: 'Leak Test Guest',
          email: 'leakguest@example.com',
        },
        guest_details: {
          country: 'VE',
          booking_for_someone_else: true,
          guest_name: 'Beneficiary Guest',
          travel_purpose: 'work',
          estimated_arrival_time: '15:00 - 16:00',
          special_requests: 'Quiet room near elevator',
        },
        terms_accepted: true,
      });

    if (bookingRes.status === 201) {
      expect(checkJsonForForbiddenTerms(bookingRes.body)).toEqual([]);
      const code = bookingRes.body.data.code;
      const token = bookingRes.body.data.access_token;
      const bookingViewRes = await request(app)
        .get(`/api/v1/bookings/${code}`)
        .set('X-Booking-Token', token);
      expect(checkJsonForForbiddenTerms(bookingViewRes.body)).toEqual([]);
    }

    // Cleanup test quote
    await prisma.quote.deleteMany({ where: { tokenKey: quoteToken } });
  });

  it('ensures no internal checkout settings or secrets leak in public responses', async () => {
    const { prisma } = await import('../../src/lib/prisma.js');
    const hotel = await prisma.hotel.findFirst({ where: { isActive: true } });
    if (!hotel) return;

    // Public hotel detail
    const hotelRes = await request(app).get(`/api/v1/hotels/${hotel.slug}`);
    expect(hotelRes.status).toBe(200);

    const rawHotelBody = JSON.stringify(hotelRes.body);
    expect(rawHotelBody).not.toContain('autoConfirmAfterPayment');
    expect(rawHotelBody).not.toContain('auto_confirm_after_payment');
    expect(rawHotelBody).not.toContain('reminderOffsetsPct');
    expect(rawHotelBody).not.toContain('reminder_offsets_pct');
    expect(rawHotelBody).not.toContain('settingsAudit');
    expect(rawHotelBody).not.toContain('settings_audit');
    expect(rawHotelBody).not.toContain('INTERNAL_SERVICE_SECRET');

    if (hotelRes.body.data.checkout_options) {
      const allowedCheckoutKeys = new Set(['pay_now', 'pay_at_hotel', 'card', 'payment_window_hours']);
      const actualKeys = Object.keys(hotelRes.body.data.checkout_options);
      for (const k of actualKeys) {
        expect(allowedCheckoutKeys.has(k)).toBe(true);
      }
    }
  });
});
