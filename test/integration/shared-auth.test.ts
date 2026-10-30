import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import fs from 'node:fs';
import path from 'node:path';
import * as jose from 'jose';

describe('Shared Authentication & Authorization Integration', () => {
  let privateKey: jose.KeyInput;
  let testRoomTypeId: string;
  let customer1Token: string;
  let customer2Token: string;
  let customer1RefreshToken: string;
  let agentToken: string;
  let adminToken: string;
  let superAdminToken: string;
  let expiredToken: string;

  beforeAll(async () => {
    // 1. Seed test data if not already present
    let hotel = await prisma.hotel.findUnique({
      where: { slug: 'hotel-shared-auth' },
    });

    if (!hotel) {
      hotel = await prisma.hotel.create({
        data: {
          slug: 'hotel-shared-auth',
          name: 'Hotel Shared Auth',
          destination: 'Caracas',
          category: 'Hotel',
          starRating: 5,
          baseCurrency: 'USD',
          isSoloDivisas: false,
          defaultCommissionPercent: 10,
          availabilityMode: 'manual',
          isActive: true,
        },
      });

      const room = await prisma.roomType.create({
        data: {
          hotelId: hotel.id,
          name: 'Habitación Suite',
          maxOccupancy: 3,
          isActive: true,
        },
      });
      testRoomTypeId = room.id;

      const season = await prisma.season.create({
        data: {
          hotelId: hotel.id,
          name: 'Temporada Shared Auth',
          priority: 1,
          dateFrom: new Date('2026-11-01T00:00:00Z'),
          dateTo: new Date('2026-11-30T00:00:00Z'),
          isActive: true,
        },
      });

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

      await prisma.hotelPaymentTaxRule.createMany({
        data: [
          { hotelId: hotel.id, method: 'zelle', ivaRate: 0 },
          { hotelId: hotel.id, method: 'pago_movil', ivaRate: 0.16 },
        ],
      });
    } else {
      const room = await prisma.roomType.findFirst({
        where: { hotelId: hotel.id, isActive: true },
      });
      if (room) testRoomTypeId = room.id;
    }

    // Ensure exchange rates exist
    const fx = await prisma.exchangeRate.findFirst();
    if (!fx) {
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

    // 2. Load private key to sign Flight-Backend-compatible tokens
    const privPem = fs.readFileSync(path.resolve('../Flight-Booking-Backend/certs/jwt-private.pem'), 'utf8');
    privateKey = await jose.importPKCS8(privPem, 'RS256');

    // 3. Generate tokens simulating Flight Backend issuance
    const now = Math.floor(Date.now() / 1000);

    // Customer 1
    customer1Token = await new jose.SignJWT({
      userId: 101,
      email: 'customer1@vuelitos.com',
      role: 'USER',
      userType: 'CUSTOMER',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('101')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // Customer 1 Refresh token
    customer1RefreshToken = await new jose.SignJWT({
      userId: 101,
      email: 'customer1@vuelitos.com',
      role: 'USER',
      userType: 'CUSTOMER',
      token_type: 'refresh',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('101')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 30 * 86400)
      .sign(privateKey);

    // Customer 2
    customer2Token = await new jose.SignJWT({
      userId: 202,
      email: 'customer2@vuelitos.com',
      role: 'USER',
      userType: 'CUSTOMER',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('202')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // Agent
    agentToken = await new jose.SignJWT({
      userId: 301,
      email: 'agent@vuelitos.com',
      role: 'Agent',
      roleId: 2,
      userType: 'STAFF',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('301')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // Admin
    adminToken = await new jose.SignJWT({
      userId: 401,
      email: 'admin@vuelitos.com',
      role: 'Admin',
      roleId: 3,
      userType: 'STAFF',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('401')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // SuperAdmin
    superAdminToken = await new jose.SignJWT({
      userId: 501,
      email: 'superadmin@vuelitos.com',
      role: 'SuperAdmin',
      roleId: 1,
      userType: 'STAFF',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('501')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // Expired Token
    expiredToken = await new jose.SignJWT({
      userId: 101,
      role: 'USER',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('101')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now - 7200)
      .setExpirationTime(now - 3600)
      .sign(privateKey);
  });

  describe('Customer Authentication & Booking Ownership', () => {
    let customer1BookingCode: string;

    it('creates a hotel booking associated with verified Flight userId', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer1Token}`)
        .set('X-Forwarded-For', '10.99.1.6')
        .send({
          items: [
            {
              type: 'hotel_stay',
              hotel_slug: 'hotel-shared-auth',
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
            name: 'Customer One',
            email: 'customer1@vuelitos.com',
            phone: '+584121111111',
          },
          terms_accepted: true,
        });

      expect(res.status).toBe(201);
      expect(res.body.data.code).toBeDefined();
      customer1BookingCode = res.body.data.code;

      // Verify DB stored external userId from JWT (101)
      const dbBooking = await prisma.booking.findUnique({
        where: { code: customer1BookingCode },
      });
      expect(dbBooking?.userId).toBe('101');
    });

    it('customer 1 can access their booking using their JWT access token', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${customer1BookingCode}`)
        .set('Authorization', `Bearer ${customer1Token}`);

      expect(res.status).toBe(200);
      expect(res.body.data.code).toBe(customer1BookingCode);
      expect(res.body.data.contact.name).toBe('Customer One');
    });

    it('customer 2 CANNOT access customer 1 booking (returns 403 Forbidden)', async () => {
      const res = await request(app)
        .get(`/api/v1/bookings/${customer1BookingCode}`)
        .set('Authorization', `Bearer ${customer2Token}`);

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('customer 1 can list their booking history via GET /api/v1/bookings', async () => {
      const res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer1Token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const found = res.body.data.find((b: any) => b.code === customer1BookingCode);
      expect(found).toBeDefined();
    });

    it('customer 2 sees an empty history (does not see customer 1 bookings)', async () => {
      const res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer2Token}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data)).toBe(true);
      const found = res.body.data.find((b: any) => b.code === customer1BookingCode);
      expect(found).toBeUndefined();
    });

    it('guest booking without JWT works and has null userId', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('X-Forwarded-For', '10.99.1.5')
        .send({
          items: [
            {
              type: 'hotel_stay',
              hotel_slug: 'hotel-shared-auth',
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
            name: 'Guest Customer',
            email: 'guest@vuelitos.com',
          },
          terms_accepted: true,
        });

      expect(res.status).toBe(201);
      const code = res.body.data.code;
      const dbBooking = await prisma.booking.findUnique({ where: { code } });
      expect(dbBooking?.userId).toBeNull();

      // Access with access token works
      const viewRes = await request(app)
        .get(`/api/v1/bookings/${code}`)
        .set('X-Booking-Token', res.body.data.access_token);
      expect(viewRes.status).toBe(200);
    });
  });

  describe('Admin Authentication & Role Authorization Hierarchy', () => {
    it('rejects unauthenticated requests to admin routes with 401', async () => {
      const res = await request(app).get('/api/admin/bookings');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects expired token with 401', async () => {
      const res = await request(app)
        .get('/api/admin/bookings')
        .set('Authorization', `Bearer ${expiredToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects refresh token sent as access token with 401', async () => {
      const res = await request(app)
        .get('/api/admin/bookings')
        .set('Authorization', `Bearer ${customer1RefreshToken}`);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects malformed token with 401', async () => {
      const res = await request(app)
        .get('/api/admin/bookings')
        .set('Authorization', 'Bearer invalid.token.payload');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects customer (USER role) from accessing admin routes with 403 Forbidden', async () => {
      const res = await request(app)
        .get('/api/admin/bookings')
        .set('Authorization', `Bearer ${customer1Token}`);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('agent role can access bookings but is forbidden from hotel catalog management (403)', async () => {
      // Allowed: agent can view bookings
      const bookingsRes = await request(app)
        .get('/api/admin/bookings')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(bookingsRes.status).toBe(200);

      // Forbidden: agent cannot manage hotels
      const hotelsRes = await request(app)
        .get('/api/admin/hotels')
        .set('Authorization', `Bearer ${agentToken}`);
      expect(hotelsRes.status).toBe(403);
      expect(hotelsRes.body.error.code).toBe('FORBIDDEN');
    });

    it('admin role can manage hotels but is forbidden from staff user management (403)', async () => {
      // Allowed: admin can view hotels
      const hotelsRes = await request(app)
        .get('/api/admin/hotels')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(hotelsRes.status).toBe(200);

      // Forbidden: admin cannot manage staff users
      const usersRes = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${adminToken}`);
      expect(usersRes.status).toBe(403);
      expect(usersRes.body.error.code).toBe('FORBIDDEN');
    });

    it('super_admin role can access all routes including staff user management', async () => {
      // Allowed: super admin can view staff users
      const usersRes = await request(app)
        .get('/api/admin/users')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(usersRes.status).toBe(200);

      // Allowed: super admin can view hotels
      const hotelsRes = await request(app)
        .get('/api/admin/hotels')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(hotelsRes.status).toBe(200);

      // Allowed: super admin can view bookings
      const bookingsRes = await request(app)
        .get('/api/admin/bookings')
        .set('Authorization', `Bearer ${superAdminToken}`);
      expect(bookingsRes.status).toBe(200);
    });

    it('allows cross-origin admin write request with Bearer JWT without being blocked by CSRF check', async () => {
      const hotel = await prisma.hotel.findUnique({ where: { slug: 'hotel-shared-auth' } });
      const res = await request(app)
        .post('/api/admin/availability')
        .set('Authorization', `Bearer ${superAdminToken}`)
        .set('Origin', 'http://localhost:5173')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({
          hotel_id: hotel!.id,
          check_in: '2026-11-10',
          check_out: '2026-11-12',
          status: 'available',
        });

      // Should succeed (201) rather than 403 Forbidden
      expect(res.status).toBe(201);
    });

    it('rejects token with invalid or spoofed issuer', async () => {
      const now = Math.floor(Date.now() / 1000);
      const badIssToken = await new jose.SignJWT({
        userId: 101,
        role: 'USER',
        token_type: 'access',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('101')
        .setIssuer('evil-auth-authority')
        .setAudience('vuelitos-platform')
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);

      const res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', `Bearer ${badIssToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it('rejects token with invalid or spoofed audience', async () => {
      const now = Math.floor(Date.now() / 1000);
      const badAudToken = await new jose.SignJWT({
        userId: 101,
        role: 'USER',
        token_type: 'access',
      })
        .setProtectedHeader({ alg: 'RS256' })
        .setSubject('101')
        .setIssuer('vuelitos-auth')
        .setAudience('untrusted-foreign-client')
        .setIssuedAt(now)
        .setExpirationTime(now + 3600)
        .sign(privateKey);

      const res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', `Bearer ${badAudToken}`);

      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });
  });

  describe('Customer Payment, Cancellation & Spoofing Edge Cases', () => {
    it('ignores client-supplied userId spoofing attempt and uses verified JWT sub', async () => {
      const res = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer1Token}`)
        .set('X-Forwarded-For', '10.99.1.1')
        .send({
          userId: 'spoofed-999',
          externalUserId: 'attacker-id',
          items: [
            {
              type: 'hotel_stay',
              hotel_slug: 'hotel-shared-auth',
              check_in: '2026-11-20',
              check_out: '2026-11-22',
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
            name: 'Customer One',
            email: 'customer1@vuelitos.com',
          },
          terms_accepted: true,
        });

      expect(res.status).toBe(201);
      const bookingCode = res.body.data.code;

      const dbBooking = await prisma.booking.findUnique({
        where: { code: bookingCode },
      });
      // external userId must be 101 from verified JWT subject, NOT spoofed-999
      expect(dbBooking?.userId).toBe('101');
    });

    it('allows authenticated customer to report payment without passing body token', async () => {
      // 1. Create a booking for customer 1
      const bookingRes = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer1Token}`)
        .set('X-Forwarded-For', '10.99.1.2')
        .send({
          items: [
            {
              type: 'hotel_stay',
              hotel_slug: 'hotel-shared-auth',
              check_in: '2026-11-24',
              check_out: '2026-11-26',
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
            name: 'Customer One',
            email: 'customer1@vuelitos.com',
          },
          terms_accepted: true,
        });

      expect(bookingRes.status).toBe(201);
      const code = bookingRes.body.data.code;

      // 2. Advance booking status to awaiting_payment via agent transition
      await prisma.booking.update({
        where: { code },
        data: { status: 'awaiting_payment' },
      });

      // 3. Customer 1 reports payment with Bearer token (no body token)
      const payRes = await request(app)
        .post(`/api/v1/bookings/${code}/payments`)
        .set('Authorization', `Bearer ${customer1Token}`)
        .send({
          method: 'zelle',
          reference: 'ZELLE-TEST-REF-101',
        });

      expect(payRes.status).toBe(200);
      expect(payRes.body.data.code).toBe(code);
      expect(payRes.body.data.status).toBe('payment_submitted');

      // 4. Customer 2 attempts to report payment on Customer 1 booking -> 403 Forbidden
      const badPayRes = await request(app)
        .post(`/api/v1/bookings/${code}/payments`)
        .set('Authorization', `Bearer ${customer2Token}`)
        .send({
          method: 'zelle',
          reference: 'ATTACKER-REF-202',
        });

      expect(badPayRes.status).toBe(403);
      expect(badPayRes.body.error.code).toBe('FORBIDDEN');
    });

    it('allows authenticated customer to cancel their booking without passing body token', async () => {
      // 1. Create a booking for customer 1
      const bookingRes = await request(app)
        .post('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer1Token}`)
        .set('X-Forwarded-For', '10.99.1.3')
        .send({
          items: [
            {
              type: 'hotel_stay',
              hotel_slug: 'hotel-shared-auth',
              check_in: '2026-11-27',
              check_out: '2026-11-29',
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
            name: 'Customer One',
            email: 'customer1@vuelitos.com',
          },
          terms_accepted: true,
        });

      expect(bookingRes.status).toBe(201);
      const code = bookingRes.body.data.code;

      // 2. Customer 2 attempts to cancel Customer 1 booking -> 403 Forbidden
      const badCancelRes = await request(app)
        .post(`/api/v1/bookings/${code}/cancel`)
        .set('Authorization', `Bearer ${customer2Token}`)
        .send({});

      expect(badCancelRes.status).toBe(403);
      expect(badCancelRes.body.error.code).toBe('FORBIDDEN');

      // 3. Customer 1 cancels their own booking with Bearer token (no body token)
      const cancelRes = await request(app)
        .post(`/api/v1/bookings/${code}/cancel`)
        .set('Authorization', `Bearer ${customer1Token}`)
        .send({});

      expect(cancelRes.status).toBe(200);
      expect(cancelRes.body.data.code).toBe(code);
      expect(cancelRes.body.data.status).toBe('cancelled');
    });
  });
});
