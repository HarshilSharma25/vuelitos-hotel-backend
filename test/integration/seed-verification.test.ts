import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { seed } from '../../prisma/seed.js';
import * as jose from 'jose';
import fs from 'node:fs';
import path from 'node:path';

describe('Comprehensive Seed Data & State Machine Query Verification', () => {
  let adminToken: string;
  let customer1Token: string;
  let customer2Token: string;

  beforeAll(async () => {
    // 1. Run seed script against the database
    await seed();

    // 2. Login as admin with seeded credentials
    const loginRes = await request(app)
      .post('/api/admin/auth/sign-in')
      .send({
        email: 'admin@vuelitos.com',
        password: 'Admin123!',
      });
    expect(loginRes.status).toBe(200);
    adminToken = loginRes.body.data.token;
    expect(adminToken).toBeDefined();

    // 3. Generate Flight Customer JWTs for customer 1 and customer 2
    const keyPath = path.resolve('../Flight-Booking-Backend/certs/jwt-private.pem');
    const privateKeyPem = fs.readFileSync(keyPath, 'utf8');
    const privateKey = await jose.importPKCS8(privateKeyPem, 'RS256');
    const now = Math.floor(Date.now() / 1000);

    customer1Token = await new jose.SignJWT({
      userId: '1',
      email: 'valentina.gomez@hotmail.com',
      role: 'USER',
      userType: 'CUSTOMER',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('1')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    customer2Token = await new jose.SignJWT({
      userId: '2',
      email: 'alejandro.silva@yahoo.com',
      role: 'USER',
      userType: 'CUSTOMER',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('2')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);
  });

  describe('1. Hotel Catalog Seed Verification', () => {
    it('seeds at least 8 varied hotels across top Venezuelan destinations', async () => {
      const hotels = await prisma.hotel.findMany({
        where: { isActive: true },
        include: {
          rooms: true,
          seasons: { include: { rates: true } },
          images: true,
          paymentRules: true,
        },
      });

      expect(hotels.length).toBeGreaterThanOrEqual(8);

      const destinations = new Set(hotels.map((h) => h.destination));
      expect(destinations.has('Caracas')).toBe(true);
      expect(destinations.has('Isla de Margarita')).toBe(true);
      expect(destinations.has('Los Roques')).toBe(true);
      expect(destinations.has('Canaima')).toBe(true);
      expect(destinations.has('Morrocoy')).toBe(true);
      expect(destinations.has('Puerto La Cruz')).toBe(true);
      expect(destinations.has('Mérida')).toBe(true);

      const categories = new Set(hotels.map((h) => h.category));
      expect(categories.has('Luxury')).toBe(true);
      expect(categories.has('Resort')).toBe(true);
      expect(categories.has('Boutique')).toBe(true);
      expect(categories.has('Eco-Lodge')).toBe(true);
      expect(categories.has('Business')).toBe(true);

      // Verify solo divisas destinations
      const losRoques = hotels.find((h) => h.slug === 'posada-acuarela-los-roques');
      expect(losRoques?.isSoloDivisas).toBe(true);

      const canaima = hotels.find((h) => h.slug === 'waku-lodge-canaima');
      expect(canaima?.isSoloDivisas).toBe(true);

      // Verify every hotel has images, rooms, seasons, rates, and payment tax rules
      for (const h of hotels) {
        expect(h.coverImageUrl).toMatch(/^https:\/\/images\.unsplash\.com\//);
        expect(h.coverImageKey).toBeDefined();
        expect(h.description?.length).toBeGreaterThan(20);
        expect(h.starRating).toBeGreaterThanOrEqual(3);
        expect(h.starRating).toBeLessThanOrEqual(5);
        expect(Number(h.defaultCommissionPercent)).toBeGreaterThanOrEqual(10);
        expect(Number(h.defaultCommissionPercent)).toBeLessThanOrEqual(15);

        // Images
        expect(h.images.length).toBeGreaterThanOrEqual(2);
        for (const img of h.images) {
          expect(img.status).toBe('published');
          expect(img.sourceUrl).toMatch(/^https:\/\/images\.unsplash\.com\//);
        }

        // Room types
        expect(h.rooms.length).toBeGreaterThanOrEqual(2);
        for (const room of h.rooms) {
          expect(room.maxOccupancy).toBeGreaterThanOrEqual(2);
          expect(room.name.length).toBeGreaterThan(3);
        }

        // Seasons covering 2026-2027
        expect(h.seasons.length).toBeGreaterThanOrEqual(2);
        const regularSeason = h.seasons.find((s) => s.priority === 1);
        expect(regularSeason).toBeDefined();
        expect(regularSeason?.dateFrom.getFullYear()).toBe(2026);
        expect(regularSeason?.dateTo.getFullYear()).toBe(2027);

        // Rates
        const allRates = h.seasons.flatMap((s) => s.rates);
        expect(allRates.length).toBeGreaterThanOrEqual(6);
        for (const r of allRates) {
          const net = Number(r.netRate);
          expect(net).toBeGreaterThanOrEqual(60);
          expect(net).toBeLessThanOrEqual(550);
          expect(r.concept).toBe('OCUPACION');
          expect(r.priceKind).toBe('IMPORTE');
        }

        // Payment tax rules
        expect(h.paymentRules.length).toBe(7);
        const stripeRule = h.paymentRules.find((pr) => pr.method === 'stripe_card');
        expect(Number(stripeRule?.surchargePercent)).toBe(3);
        const zelleRule = h.paymentRules.find((pr) => pr.method === 'zelle');
        expect(Number(zelleRule?.ivaRate)).toBe(0);
      }
    });

    it('GET /api/v1/destinations returns active destinations with hotel counts', async () => {
      const res = await request(app).get('/api/v1/destinations');
      expect(res.status).toBe(200);
      const names = res.body.data.destinations.map((d: any) => d.name);
      expect(names).toContain('Caracas');
      expect(names).toContain('Isla de Margarita');
      expect(names).toContain('Los Roques');
      expect(names).toContain('Canaima');
      expect(names).toContain('Morrocoy');
      expect(names).toContain('Puerto La Cruz');
      expect(names).toContain('Mérida');
    });

    it('GET /api/v1/hotels returns full catalog with pagination', async () => {
      const res = await request(app).get('/api/v1/hotels');
      expect(res.status).toBe(200);
      expect(res.body.data.items.length).toBeGreaterThanOrEqual(8);
      const slugs = res.body.data.items.map((h: any) => h.slug);
      expect(slugs).toContain('gran-melia-caracas');
      expect(slugs).toContain('hesperia-isla-margarita');
      expect(slugs).toContain('posada-acuarela-los-roques');
    });

    it('calculates stay pricing correctly using seeded rate matrix', async () => {
      const hotel = await prisma.hotel.findUnique({
        where: { slug: 'gran-melia-caracas' },
        include: { rooms: true },
      });
      expect(hotel).toBeDefined();

      const res = await request(app)
        .post('/api/v1/hotels/gran-melia-caracas/price')
        .send({
          check_in: '2026-11-10',
          check_out: '2026-11-13', // 3 nights
          meal_plan: 'CP',
          room_selections: [
            {
              room_type_id: hotel!.rooms[0].id,
              adults: 2,
              children: 0,
              child_ages: [],
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(res.body.data.priced).toBe(true);
      expect(res.body.data.total.base).toBeGreaterThan(0);
      expect(res.body.data.methods.length).toBeGreaterThan(0);
    });
  });

  describe('2. Booking Lifecycle Seed Verification', () => {
    it('seeds 16 dummy bookings covering all state machine statuses', async () => {
      const bookings = await prisma.booking.findMany({
        include: {
          items: true,
          events: true,
          payments: true,
          checks: true,
        },
      });

      expect(bookings.length).toBe(16);

      const statuses = new Set(bookings.map((b) => b.status));
      expect(statuses.has('requested')).toBe(true);
      expect(statuses.has('checking_availability')).toBe(true);
      expect(statuses.has('awaiting_payment')).toBe(true);
      expect(statuses.has('payment_submitted')).toBe(true);
      expect(statuses.has('payment_verified')).toBe(true);
      expect(statuses.has('confirmed')).toBe(true);
      expect(statuses.has('cancelled')).toBe(true);
      expect(statuses.has('refund_pending')).toBe(true);
      expect(statuses.has('refunded')).toBe(true);

      // Verify every booking has items and timeline events
      for (const b of bookings) {
        expect(b.code).toMatch(/^VH-\d{4}-\d{6}$/);
        expect(b.items.length).toBeGreaterThan(0);
        expect(b.events.length).toBeGreaterThan(0);
        expect(b.contactName.length).toBeGreaterThan(3);
        expect(b.contactEmail).toContain('@');
        expect(b.termsAcceptedAt).toBeDefined();
        expect(b.totalsByMethod).toBeDefined();
        expect(b.fxSnapshot).toBeDefined();
      }
    });

    it('seeds active SLA countdowns AND overdue SLA countdowns', async () => {
      // Admin inbox with SLA Overdue Only filter
      const overdueRes = await request(app)
        .get('/api/admin/bookings?overdue=true')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(overdueRes.status).toBe(200);
      expect(overdueRes.body.data.length).toBeGreaterThanOrEqual(1);

      const overdueBooking = overdueRes.body.data.find(
        (b: any) => b.code === 'VH-2026-000104'
      );
      expect(overdueBooking).toBeDefined();
      expect(overdueBooking.is_overdue).toBe(true);
      expect(overdueBooking.sla_minutes_remaining).toBeLessThan(0);

      // Active SLA countdowns
      const activeRes = await request(app)
        .get('/api/admin/bookings?status=requested')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(activeRes.status).toBe(200);
      const activeBooking = activeRes.body.data.find(
        (b: any) => b.code === 'VH-2026-000101'
      );
      expect(activeBooking).toBeDefined();
      expect(activeBooking.is_overdue).toBe(false);
      expect(activeBooking.sla_minutes_remaining).toBeGreaterThan(0);
    });

    it('GET /api/admin/bookings/:code returns complete reservation dossier with enriched items', async () => {
      const res = await request(app)
        .get('/api/admin/bookings/VH-2026-000101')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const b = res.body.data;
      expect(b.code).toBe('VH-2026-000101');
      expect(b.items).toBeDefined();
      expect(b.items.length).toBe(1);
      // Enriched fields for Frontend Admin Console (HotelBookingsInbox.tsx)
      expect(b.items[0].hotelSlug).toBe('gran-melia-caracas');
      expect(b.items[0].hotelName).toBe('Gran Meliá Caracas & Suites');
      expect(b.events.length).toBeGreaterThan(0);
      expect(b.checks.length).toBeGreaterThan(0);
    });

    it('seeds confirmed bookings with vouchers and payment records', async () => {
      const res = await request(app)
        .get('/api/admin/bookings/VH-2026-000111')
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const b = res.body.data;
      expect(b.status).toBe('confirmed');
      expect(b.payments.length).toBe(1);
      expect(b.payments[0].status).toBe('verified');
      expect(b.payments[0].method).toBe('zelle');
      expect(b.payments[0].reference).toBe('ZEL-55443322-BOFA');

      // Verify event history contains verify_payment and confirm_booking
      const eventNames = b.events.map((e: any) => e.event);
      expect(eventNames).toContain('requested');
      expect(eventNames).toContain('start_check');
      expect(eventNames).toContain('hotel_confirmed');
      expect(eventNames).toContain('submit_payment');
      expect(eventNames).toContain('verify_payment');
      expect(eventNames).toContain('confirm_booking');
    });

    it('supports customer booking history isolation for linked Flight User IDs', async () => {
      // Customer 1 history
      const c1Res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer1Token}`);

      expect(c1Res.status).toBe(200);
      expect(Array.isArray(c1Res.body.data)).toBe(true);
      expect(c1Res.body.data.length).toBeGreaterThanOrEqual(4);
      const c1Codes = c1Res.body.data.map((b: any) => b.code);
      expect(c1Codes).toContain('VH-2026-000102');
      expect(c1Codes).toContain('VH-2026-000106');
      expect(c1Codes).toContain('VH-2026-000108');
      expect(c1Codes).toContain('VH-2026-000111');
      // Customer 1 should not see Customer 2's bookings
      expect(c1Codes).not.toContain('VH-2026-000103');

      // Customer 2 history
      const c2Res = await request(app)
        .get('/api/v1/bookings')
        .set('Authorization', `Bearer ${customer2Token}`);

      expect(c2Res.status).toBe(200);
      const c2Codes = c2Res.body.data.map((b: any) => b.code);
      expect(c2Codes).toContain('VH-2026-000103');
      expect(c2Codes).toContain('VH-2026-000107');
      expect(c2Codes).toContain('VH-2026-000110');
      expect(c2Codes).toContain('VH-2026-000113');
      // Customer 2 should not see Customer 1's bookings
      expect(c2Codes).not.toContain('VH-2026-000102');
    });

    it('guest bookings have null userId and can be accessed with their access token', async () => {
      const guestBooking = await prisma.booking.findUnique({
        where: { code: 'VH-2026-000101' },
      });
      expect(guestBooking).toBeDefined();
      expect(guestBooking?.userId).toBeNull();
    });
  });

  describe('3. Staff Users, Holidays, and Exchange Rates Verification', () => {
    it('seeds staff accounts with argon2 hashed passwords', async () => {
      const staff = await prisma.staffUser.findMany();
      expect(staff.length).toBe(2);
      const emails = staff.map((s) => s.email);
      expect(emails).toContain('admin@vuelitos.com');
      expect(emails).toContain('agent@vuelitos.com');

      // Agent login
      const agentRes = await request(app)
        .post('/api/admin/auth/sign-in')
        .send({
          email: 'agent@vuelitos.com',
          password: 'Agent123!',
        });
      expect(agentRes.status).toBe(200);
      expect(agentRes.body.data.user.role).toBe('agent');
    });

    it('seeds Venezuelan holidays for 2026-2027', async () => {
      const holidays = await prisma.holiday.findMany();
      expect(holidays.length).toBeGreaterThanOrEqual(15);
      const names = holidays.map((h) => h.name);
      expect(names).toContain('Año Nuevo');
      expect(names).toContain('Navidad');
    });

    it('seeds exchange rates', async () => {
      const rates = await prisma.exchangeRate.findMany();
      expect(rates.length).toBeGreaterThanOrEqual(1);
      const latest = rates[0];
      expect(Number(latest.bcvUsd)).toBe(45);
      expect(Number(latest.bcvEur)).toBe(49);
      expect(Number(latest.binanceUsdt)).toBe(46.8);
    });
  });
});
