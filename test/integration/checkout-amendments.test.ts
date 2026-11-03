import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import * as jose from 'jose';
import crypto from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { setPublicKeyOverride } from '../../src/lib/jwt.js';
import { processExpiryJob } from '../../src/jobs/scheduler.js';
import { getAllowedActions } from '../../src/modules/bookings/state-machine.js';
import { settingsService } from '../../src/modules/settings/service.js';
import { bookingService } from '../../src/modules/bookings/service.js';

describe('Checkout Amendments & Invariant Verification', () => {
  let privateKey: jose.KeyInput;
  let adminToken: string;
  let testHotel: any;
  let testRoom: any;

  beforeAll(async () => {
    // 1. Setup RSA keys for admin JWT
    const { publicKey, privateKey: generatedPrivKey } = await jose.generateKeyPair('RS256');
    privateKey = generatedPrivKey;
    setPublicKeyOverride(publicKey);

    const now = Math.floor(Date.now() / 1000);
    adminToken = await new jose.SignJWT({
      userId: 999,
      email: 'admin@vuelitos.com',
      role: 'Admin',
      roleId: 3,
      userType: 'STAFF',
      token_type: 'access',
    })
      .setProtectedHeader({ alg: 'RS256' })
      .setSubject('999')
      .setIssuer('vuelitos-auth')
      .setAudience('vuelitos-platform')
      .setIssuedAt(now)
      .setExpirationTime(now + 3600)
      .sign(privateKey);

    // 2. Seed test hotel & room
    testHotel = await prisma.hotel.findUnique({
      where: { slug: 'hotel-amendments-test' },
    });

    if (!testHotel) {
      testHotel = await prisma.hotel.create({
        data: {
          slug: 'hotel-amendments-test',
          name: 'Hotel Amendments Test',
          destination: 'Margarita',
          category: 'Resort',
          starRating: 5,
          baseCurrency: 'USD',
          isSoloDivisas: false,
          defaultCommissionPercent: 10,
          availabilityMode: 'manual',
          isActive: true,
        },
      });

      testRoom = await prisma.roomType.create({
        data: {
          hotelId: testHotel.id,
          name: 'Deluxe Ocean View',
          maxOccupancy: 2,
          isActive: true,
        },
      });

      const season = await prisma.season.create({
        data: {
          hotelId: testHotel.id,
          name: 'Temporada General',
          priority: 1,
          dateFrom: new Date('2026-01-01T00:00:00Z'),
          dateTo: new Date('2026-12-31T00:00:00Z'),
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
          netRate: 150,
          minNights: 1,
          isActive: true,
        },
      });

      await prisma.hotelPaymentTaxRule.createMany({
        data: [
          { hotelId: testHotel.id, method: 'zelle', ivaRate: 0 },
          { hotelId: testHotel.id, method: 'pago_movil', ivaRate: 0.16 },
        ],
      });
    } else {
      testRoom = await prisma.roomType.findFirst({
        where: { hotelId: testHotel.id, isActive: true },
      });
    }

    // Ensure exchange rate
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

    // Ensure global checkout settings enable pay_at_hotel and pay_now
    await prisma.checkoutSettings.upsert({
      where: { id: 'global' },
      create: {
        id: 'global',
        payNowEnabled: true,
        payAtHotelEnabled: true,
        cardPaymentsEnabled: true,
        paymentWindowHours: 48,
      },
      update: {
        payNowEnabled: true,
        payAtHotelEnabled: true,
        cardPaymentsEnabled: true,
      },
    });
  });

  // HARD RULE: Availability approval stays 100% manual
  it('HARD RULE: Newly created booking always starts and stays in "requested" status', async () => {
    const res = await request(app)
      .post('/api/v1/bookings')
      .send({
        checkout_mode: 'pay_at_hotel',
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: testHotel.slug,
            check_in: '2026-11-20',
            check_out: '2026-11-22',
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
          name: 'Manual Approval Guard',
          email: 'guard@example.com',
        },
        guest_details: {
          country: 'VE',
          booking_for_someone_else: false,
          travel_purpose: 'leisure',
        },
        terms_accepted: true,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('requested');
    expect(res.body.data.payment_mode).toBe('at_hotel');

    const bookingInDb = await prisma.booking.findUnique({
      where: { code: res.body.data.code },
    });
    expect(bookingInDb?.status).toBe('requested');
    expect(bookingInDb?.paymentMode).toBe('at_hotel');
  });

  // Amendment 3 & 11: Expiry job strictly ignores at_hotel bookings
  it('Expiry job cancels expired online bookings but strictly ignores at_hotel bookings', async () => {
    const pastDate = new Date(Date.now() - 3600 * 1000); // 1 hour ago

    // 1. Create expired online booking
    const onlineBooking = await prisma.booking.create({
      data: {
        termsAcceptedAt: new Date(),
        accessKey: crypto.randomUUID(),
        totalsByMethod: {},
        fxSnapshot: {},
        code: `ONL-${Date.now().toString(36).toUpperCase()}`,
        status: 'awaiting_payment',
        paymentMode: 'online',
        contactName: 'Online Expiree',
        contactEmail: 'online@example.com',
        slaDueAt: pastDate,
        paymentWindowHours: 48,
        remindersSent: [],
        items: {
          create: {
            hotelId: testHotel.id,
            checkIn: new Date('2026-11-20'),
            checkOut: new Date('2026-11-22'),
            mealPlan: 'desayuno',
            roomSelections: [{ roomTypeId: testRoom.id, adults: 2, children: 0, childAges: [] }],
            priceSnapshot: { totalBase: 100 },
          },
        },
      },
    });

    // 2. Create expired at_hotel booking
    const atHotelBooking = await prisma.booking.create({
      data: {
        termsAcceptedAt: new Date(),
        accessKey: crypto.randomUUID(),
        totalsByMethod: {},
        fxSnapshot: {},
        code: `ATH-${Date.now().toString(36).toUpperCase()}`,
        status: 'confirmed',
        paymentMode: 'at_hotel',
        contactName: 'At Hotel Guest',
        contactEmail: 'athotel@example.com',
        slaDueAt: pastDate,
        paymentWindowHours: 48,
        remindersSent: [],
        items: {
          create: {
            hotelId: testHotel.id,
            checkIn: new Date('2026-11-20'),
            checkOut: new Date('2026-11-22'),
            mealPlan: 'desayuno',
            roomSelections: [{ roomTypeId: testRoom.id, adults: 2, children: 0, childAges: [] }],
            priceSnapshot: { totalBase: 100 },
          },
        },
      },
    });

    // Run expiry job
    const expiredCount = await processExpiryJob();
    expect(expiredCount).toBeGreaterThanOrEqual(1);

    // Verify online booking was cancelled
    const updatedOnline = await prisma.booking.findUnique({
      where: { id: onlineBooking.id },
    });
    expect(updatedOnline?.status).toBe('cancelled');

    // Verify at_hotel booking was NOT cancelled
    const updatedPayAtHotel = await prisma.booking.findUnique({
      where: { id: atHotelBooking.id },
    });
    expect(updatedPayAtHotel?.status).toBe('confirmed');
  });

  // Amendment 2 & 11: at_hotel allowed_actions includes customer cancel until check-in
  it('at_hotel allowed_actions excludes report_payment/confirm_availability and includes cancel until check-in', () => {
    const futureCheckIn = new Date(Date.now() + 86400 * 5 * 1000); // 5 days in future
    const pastCheckIn = new Date(Date.now() - 86400 * 1000); // 1 day in past

    // When status is confirmed and check-in is in future
    const actionsFuture = getAllowedActions('confirmed', 'at_hotel', futureCheckIn);
    expect(actionsFuture).toContain('cancel');
    expect(actionsFuture).not.toContain('report_payment');
    expect(actionsFuture).not.toContain('confirm_availability');

    // When status is confirmed but check-in has passed
    const actionsPast = getAllowedActions('confirmed', 'at_hotel', pastCheckIn);
    expect(actionsPast).not.toContain('cancel');

    // Checking availability state
    const actionsChecking = getAllowedActions('checking_availability', 'at_hotel', futureCheckIn);
    expect(actionsChecking).toContain('cancel');
    expect(actionsChecking).not.toContain('confirm_availability');
    expect(actionsChecking).not.toContain('report_payment');
  });

  // Amendment 2, 4 & 11: Auto-confirm as system actor
  it('Auto-confirm confirms booking as "system" actor when autoConfirmAfterPayment is true', async () => {
    // 1. Update hotel override or global to enable auto-confirm
    await settingsService.updateGlobalCheckoutSettings(
      { autoConfirmAfterPayment: true },
      { id: 'admin-1', type: 'admin' }
    );

    const booking = await prisma.booking.create({
      data: {
        termsAcceptedAt: new Date(),
        accessKey: crypto.randomUUID(),
        totalsByMethod: {},
        fxSnapshot: {},
        code: `AUT-${Date.now().toString(36).toUpperCase()}`,
        status: 'payment_submitted',
        paymentMode: 'online',
        contactName: 'Auto Confirm User',
        contactEmail: 'autoconfirm@example.com',
        paymentWindowHours: 48,
        remindersSent: [],
        items: {
          create: {
            hotelId: testHotel.id,
            checkIn: new Date('2026-11-20'),
            checkOut: new Date('2026-11-22'),
            mealPlan: 'desayuno',
            roomSelections: [{ roomTypeId: testRoom.id, adults: 2, children: 0, childAges: [] }],
            priceSnapshot: { totalBase: 200 },
          },
        },
        payments: {
          create: {
            method: 'zelle',
            amountQuoted: 200,
            currency: 'USD',
            status: 'submitted',
            reference: 'AUTOREF123',
          },
        },
      },
    });

    // 2. Admin verifies payment
    const verifyRes = await request(app)
      .post(`/api/admin/bookings/${booking.code}/verify-payment`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ amountReceived: 200 });

    expect(verifyRes.status).toBe(200);
    expect(verifyRes.body.data.status).toBe('confirmed');

    // 3. Inspect audit events: confirm_booking must have actorType 'system'
    const events = await prisma.bookingEvent.findMany({
      where: { bookingId: booking.id },
      orderBy: { createdAt: 'desc' },
    });

    const confirmEvent = events.find((e) => e.event === 'confirm_booking');
    expect(confirmEvent).toBeDefined();
    expect(confirmEvent?.actorType).toBe('system');
    expect(confirmEvent?.actorId).toBe('system');

    // Reset setting
    await settingsService.updateGlobalCheckoutSettings(
      { autoConfirmAfterPayment: false },
      { id: 'admin-1', type: 'admin' }
    );
  });

  // Amendment 3 & 11: extend-payment-window updates snapshot and resets remindersSent
  it('extend-payment-window adds hours to snapshot and clears remindersSent', async () => {
    const booking = await prisma.booking.create({
      data: {
        termsAcceptedAt: new Date(),
        accessKey: crypto.randomUUID(),
        totalsByMethod: {},
        fxSnapshot: {},
        code: `EXT-${Date.now().toString(36).toUpperCase()}`,
        status: 'awaiting_payment',
        paymentMode: 'online',
        contactName: 'Extend User',
        contactEmail: 'extend@example.com',
        paymentWindowHours: 24,
        remindersSent: [50],
        slaDueAt: new Date(Date.now() + 12 * 3600 * 1000),
        items: {
          create: {
            hotelId: testHotel.id,
            checkIn: new Date('2026-11-20'),
            checkOut: new Date('2026-11-22'),
            mealPlan: 'desayuno',
            roomSelections: [{ roomTypeId: testRoom.id, adults: 2, children: 0, childAges: [] }],
            priceSnapshot: { totalBase: 150 },
          },
        },
      },
    });

    const prevSlaDueAt = booking.slaDueAt!.getTime();

    const res = await request(app)
      .post(`/api/admin/bookings/${booking.code}/extend-payment-window`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        additionalHours: 24,
        note: 'Customer requested 24h grace extension',
      });

    expect(res.status).toBe(200);
    expect(res.body.data.payment_window_hours).toBe(48);
    expect(res.body.data.reminders_sent).toEqual([]);

    const updated = await prisma.booking.findUnique({
      where: { id: booking.id },
      include: { events: true },
    });

    expect(updated?.paymentWindowHours).toBe(48);
    expect(updated?.remindersSent).toEqual([]);
    expect(updated?.slaDueAt!.getTime()).toBeGreaterThan(prevSlaDueAt + 23 * 3600 * 1000);

    const extEvent = updated?.events.find((e) => e.event === 'extend_payment_window');
    expect(extEvent).toBeDefined();
    expect(extEvent?.note).toContain('Customer requested 24h grace extension');
  });

  // Amendment 7 & 11: Duplicate reference check (normalized, method-scoped, self-ignoring)
  it('Duplicate-reference check normalizes reference, scopes by method, and ignores same booking', async () => {
    const booking1CodeSuffix = `${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const booking1 = await prisma.booking.create({
      data: {
        termsAcceptedAt: new Date(),
        accessKey: crypto.randomUUID(),
        totalsByMethod: {},
        fxSnapshot: {},
        code: `DUP1-${booking1CodeSuffix}`,
        status: 'payment_submitted',
        paymentMode: 'online',
        contactName: 'Dup One',
        contactEmail: 'dup1@example.com',
        paymentWindowHours: 48,
        remindersSent: [],
        payments: {
          create: {
            method: 'pago_movil',
            amountQuoted: 100,
            currency: 'VES',
            status: 'submitted',
            reference: `PM-${booking1CodeSuffix}-XYZ`,
          },
        },
      },
      include: { payments: true },
    });

    const booking2 = await prisma.booking.create({
      data: {
        termsAcceptedAt: new Date(),
        accessKey: crypto.randomUUID(),
        totalsByMethod: {},
        fxSnapshot: {},
        code: `DUP2-${booking1CodeSuffix}`,
        status: 'awaiting_payment',
        paymentMode: 'online',
        contactName: 'Dup Two',
        contactEmail: 'dup2@example.com',
        paymentWindowHours: 48,
        remindersSent: [],
      },
    });

    // 1. Normalized check: booking 2 with variant reference " pm <suffix> xyz " on pago_movil matches booking 1
    const check1 = await bookingService.checkDuplicateReference(
      'pago_movil',
      ` pm ${booking1CodeSuffix} xyz `,
      booking2.id
    );
    expect(check1.isDuplicate).toBe(true);
    expect(check1.duplicateBookingCode).toBe(booking1.code);

    // 2. Different payment method (e.g. zelle) does NOT match
    const checkDiffMethod = await bookingService.checkDuplicateReference(
      'zelle',
      `PM-${booking1CodeSuffix}-XYZ`,
      booking2.id
    );
    expect(checkDiffMethod.isDuplicate).toBe(false);

    // 3. Same booking checking against its own payment reference is ignored
    const checkSelf = await bookingService.checkDuplicateReference(
      'pago_movil',
      `PM-${booking1CodeSuffix}-XYZ`,
      booking1.id
    );
    expect(checkSelf.isDuplicate).toBe(false);
  });

  // Amendment 11: Settings audit history recording and retrieval
  it('Settings changes record full audit entries with oldValue and newValue', async () => {
    // 1. Update global settings
    const updateRes = await request(app)
      .put('/api/admin/settings/checkout')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        payment_window_hours: 36,
        reminder_offsets_pct: [40, 80],
      });

    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.payment_window_hours).toBe(36);
    expect(updateRes.body.data.reminder_offsets_pct).toEqual([40, 80]);

    // 2. Query audit log
    const auditRes = await request(app)
      .get('/api/admin/settings/audit?settingType=checkout_global')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(auditRes.status).toBe(200);
    expect(Array.isArray(auditRes.body.data)).toBe(true);
    expect(auditRes.body.data.length).toBeGreaterThan(0);

    const latest = auditRes.body.data[0];
    expect(latest.settingType).toBe('checkout_global');
    expect(latest.newValue.paymentWindowHours).toBe(36);
    expect(latest.newValue.reminderOffsetsPct).toEqual([40, 80]);
  });
});
