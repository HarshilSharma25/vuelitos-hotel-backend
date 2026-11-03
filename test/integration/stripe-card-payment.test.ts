import { describe, it, expect, beforeAll, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import { app } from '../../src/app.js';
import { prisma } from '../../src/lib/prisma.js';
import { env } from '../../src/config/env.js';
import { flightInternalClient } from '../../src/lib/flight-internal.js';
import { processStripeReconciliationJob } from '../../src/jobs/scheduler.js';

describe('Hotel Stripe Card Payments Integration', () => {
  const secret = env.INTERNAL_SERVICE_SECRET;
  let testHotelSlug = 'hotel-stripe-test';
  let testRoomTypeId: string;
  let testBookingCode: string;
  let testAccessToken: string;
  let quotedAmount: number;
  let testSessionId: string;

  beforeAll(async () => {
    (env as any).CARD_PAYMENTS_ENABLED = true;
    testSessionId = `cs_test_mock_${Date.now()}`;

    // 1. Seed or find dedicated test hotel
    let hotel = await prisma.hotel.findUnique({
      where: { slug: testHotelSlug },
    });
    if (!hotel) {
      hotel = await prisma.hotel.create({
        data: {
          slug: testHotelSlug,
          name: 'Hotel Stripe Test',
          destination: 'Caracas',
          category: 'Hotel',
          baseCurrency: 'USD',
          childBandsEnabled: false,
          isSoloDivisas: false,
          isActive: true,
        },
      });

      const room = await prisma.roomType.create({
        data: {
          hotelId: hotel.id,
          name: 'Habitación Suite Stripe',
          maxOccupancy: 3,
          isActive: true,
        },
      });
      testRoomTypeId = room.id;

      const season = await prisma.season.create({
        data: {
          hotelId: hotel.id,
          name: 'Temporada Stripe Test',
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
          netRate: 150,
          minNights: 1,
          isActive: true,
        },
      });

      await prisma.hotelPaymentTaxRule.createMany({
        data: [
          { hotelId: hotel.id, method: 'stripe_card', ivaRate: 0 },
          { hotelId: hotel.id, method: 'zelle', ivaRate: 0 },
        ],
      });
    } else {
      const room = await prisma.roomType.findFirst({
        where: { hotelId: hotel.id },
      });
      if (room) testRoomTypeId = room.id;
    }

    // 2. Ensure exchange rate exists
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
  });

  function signPayload(body: any, timestamp?: string, customSecret?: string) {
    const ts = timestamp || Date.now().toString();
    const raw = JSON.stringify(body);
    const sec = customSecret || secret;
    const sig = crypto.createHmac('sha256', sec).update(`${ts}.${raw}`).digest('hex');
    return { 'X-Timestamp': ts, 'X-Signature': sig };
  }

  it('rejects checkout session creation when booking is in wrong state (requested instead of awaiting_payment)', async () => {
    // 1. Create a fresh booking
    const createRes = await request(app)
      .post('/api/v1/bookings')
      .send({
        items: [
          {
            type: 'hotel_stay',
            hotel_slug: testHotelSlug,
            check_in: '2026-11-10',
            check_out: '2026-11-12',
            meal_plan: 'desayuno',
            room_selections: [
              {
                room_type_id: testRoomTypeId,
                adults: 2,
                children: 0,
              },
            ],
          },
        ],
        contact: {
          name: 'Stripe Test User',
          email: 'stripetest@example.com',
        },
        terms_accepted: true,
      });

    expect(createRes.status).toBe(201);
    testBookingCode = createRes.body.data.code;
    testAccessToken = createRes.body.data.access_token;

    // Online booking is created in 'awaiting_payment' state
    const createdBooking = await prisma.booking.findUnique({ where: { code: testBookingCode } });
    expect(createdBooking!.status).toBe('awaiting_payment');

    // Reject when in terminal state (cancelled)
    await prisma.booking.update({
      where: { code: testBookingCode },
      data: { status: 'cancelled' },
    });
    const sessionRes = await request(app)
      .post(`/api/v1/bookings/${testBookingCode}/payments/stripe-session`)
      .set('X-Booking-Token', testAccessToken)
      .send({ amount: 99999 });

    expect(sessionRes.status).toBe(409); // InvalidTransitionError (wrong state)

    // Restore to awaiting_payment for subsequent tests
    await prisma.booking.update({
      where: { code: testBookingCode },
      data: { status: 'awaiting_payment' },
    });
  });

  it('creates Stripe session using stored totals even if client sends arbitrary amount in body', async () => {
    const booking = await prisma.booking.findUnique({ where: { code: testBookingCode } });
    const totals = booking!.totalsByMethod as any[];
    const stripeTotal = totals.find((t) => t.method === 'stripe_card');
    expect(stripeTotal).toBeDefined();
    quotedAmount = stripeTotal.amount;

    let capturedParams: any = null;
    vi.spyOn(flightInternalClient, 'createCheckoutSession').mockImplementation(async (params) => {
      capturedParams = params;
      return {
        session_id: testSessionId,
        checkout_url: `https://checkout.stripe.com/pay/${testSessionId}`,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    // Send arbitrary amount 999.99 in body
    const res = await request(app)
      .post(`/api/v1/bookings/${testBookingCode}/payments/stripe-session`)
      .set('X-Booking-Token', testAccessToken)
      .send({ amount: 999.99 });

    expect(res.status).toBe(200);
    expect(res.body.data.checkout_url).toBe(`https://checkout.stripe.com/pay/${testSessionId}`);
    expect(res.body.data.expires_at).toBeDefined();

    // Verify amount came from stored totals, NOT body!
    expect(capturedParams.amount_cents).toBe(Math.round(quotedAmount * 100));
    expect(capturedParams.currency).toBe(stripeTotal.currency.toLowerCase());
    expect(capturedParams.hotel_booking_code).toBe(testBookingCode);

    // Verify Payment row created with pending status
    const payment = await prisma.payment.findUnique({
      where: { externalSessionId: testSessionId },
    });
    expect(payment).toBeDefined();
    expect(payment?.status).toBe('pending');
    expect(payment?.externalProvider).toBe('stripe');
  });

  it('rejects bad or stale signature on internal stripe-event endpoint', async () => {
    const payload = {
      event_id: `evt_test_sig_${Date.now()}`,
      type: 'checkout.session.completed',
      session_id: testSessionId,
      hotel_booking_code: testBookingCode,
      amount_total: Math.round(quotedAmount * 100),
      currency: 'usd',
      payment_status: 'paid',
    };

    // 1. Wrong secret
    const badHeaders = signPayload(payload, undefined, 'wrong-secret-key-that-does-not-match');
    const resBad = await request(app)
      .post('/internal/payments/stripe-event')
      .set(badHeaders)
      .send(payload);
    expect(resBad.status).toBe(401);

    // 2. Stale timestamp (10 minutes ago)
    const staleTs = (Date.now() - 10 * 60 * 1000).toString();
    const staleHeaders = signPayload(payload, staleTs);
    const resStale = await request(app)
      .post('/internal/payments/stripe-event')
      .set(staleHeaders)
      .send(payload);
    expect(resStale.status).toBe(401);

    // 3. Carrying X-Forwarded-For (direct access forbidden)
    const validHeaders = signPayload(payload);
    const resSpoofed = await request(app)
      .post('/internal/payments/stripe-event')
      .set(validHeaders)
      .set('X-Forwarded-For', '203.0.113.195')
      .send(payload);
    expect(resSpoofed.status).toBe(403);
  });

  it('marks payment needs_review and leaves booking untouched on amount/currency mismatch', async () => {
    const payload = {
      event_id: `evt_test_mismatch_${Date.now()}`,
      type: 'checkout.session.completed',
      session_id: testSessionId,
      hotel_booking_code: testBookingCode,
      amount_total: Math.round(quotedAmount * 100) - 500, // Mismatched amount
      currency: 'usd',
      payment_status: 'paid',
    };

    const headers = signPayload(payload);
    const res = await request(app)
      .post('/internal/payments/stripe-event')
      .set(headers)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('needs_review');

    // Check payment row status is needs_review
    const payment = await prisma.payment.findUnique({
      where: { externalSessionId: testSessionId },
    });
    expect(payment?.status).toBe('needs_review');

    // Booking must remain in awaiting_payment!
    const booking = await prisma.booking.findUnique({ where: { code: testBookingCode } });
    expect(booking?.status).toBe('awaiting_payment');
  });

  let reusablePaidEventId: string;

  it('paid event with matching amount ends in payment_verified with two audit events', async () => {
    // Reset payment status to pending for the test session
    await prisma.payment.update({
      where: { externalSessionId: testSessionId },
      data: { status: 'pending' },
    });

    reusablePaidEventId = `evt_test_paid_valid_${Date.now()}`;
    const payload = {
      event_id: reusablePaidEventId,
      type: 'checkout.session.completed',
      session_id: testSessionId,
      hotel_booking_code: testBookingCode,
      amount_total: Math.round(quotedAmount * 100),
      currency: 'usd',
      payment_status: 'paid',
    };

    const headers = signPayload(payload);
    const res = await request(app)
      .post('/internal/payments/stripe-event')
      .set(headers)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('verified');

    // Payment must be verified
    const payment = await prisma.payment.findUnique({
      where: { externalSessionId: testSessionId },
    });
    expect(payment?.status).toBe('verified');
    expect(payment?.verifiedBy).toBe('system');

    // Booking must be payment_verified
    const booking = await prisma.booking.findUnique({
      where: { code: testBookingCode },
      include: { events: true },
    });
    expect(booking?.status).toBe('payment_verified');

    // Audit trail must contain TWO events: submit_payment then verify_payment
    const eventNames = booking!.events.map((e) => e.event);
    expect(eventNames).toContain('submit_payment');
    expect(eventNames).toContain('verify_payment');
  });

  it('replayed event id is a no-op', async () => {
    const payload = {
      event_id: reusablePaidEventId, // same event_id as previous test
      type: 'checkout.session.completed',
      session_id: testSessionId,
      hotel_booking_code: testBookingCode,
      amount_total: Math.round(quotedAmount * 100),
      currency: 'usd',
      payment_status: 'paid',
    };

    const headers = signPayload(payload);
    const res = await request(app)
      .post('/internal/payments/stripe-event')
      .set(headers)
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('already_processed');
  });

  it('reconciliation recovers a missed webhook', async () => {
    const uniqueReconCode = `VH-2026-REC${Date.now()}`;
    const newBooking = await prisma.booking.create({
      data: {
        code: uniqueReconCode,
        status: 'awaiting_payment',
        accessKey: crypto.randomUUID(),
        locale: 'es',
        contactName: 'Recon Test',
        contactEmail: 'recon@example.com',
        termsAcceptedAt: new Date(),
        totalsByMethod: [
          {
            method: 'stripe_card',
            currency: 'USD',
            amount: 200.0,
            iva_rate: 0,
            iva_amount: 0,
            exchange_rate_used: null,
            is_lowest: true,
          },
        ],
        fxSnapshot: {},
      },
    });

    const missedSessionId = `cs_test_missed_${Date.now()}`;
    // Create pending payment older than 10 minutes
    await prisma.payment.create({
      data: {
        bookingId: newBooking.id,
        method: 'stripe_card',
        currency: 'USD',
        amountQuoted: 200.0,
        reference: missedSessionId,
        status: 'pending',
        externalProvider: 'stripe',
        externalSessionId: missedSessionId,
        rawStatus: 'open',
        submittedAt: new Date(Date.now() - 15 * 60 * 1000), // 15 mins ago
      },
    });

    // Mock Flight getSessionStatus returning paid status
    vi.spyOn(flightInternalClient, 'getSessionStatus').mockResolvedValue({
      session_id: missedSessionId,
      status: 'complete',
      payment_status: 'paid',
      amount_total: 20000,
      currency: 'usd',
    });

    // Run reconciliation job
    await processStripeReconciliationJob();

    // Check payment row and booking were updated by reconciliation
    const updatedPayment = await prisma.payment.findUnique({
      where: { externalSessionId: missedSessionId },
    });
    expect(updatedPayment?.status).toBe('verified');

    const updatedBooking = await prisma.booking.findUnique({
      where: { id: newBooking.id },
    });
    expect(updatedBooking?.status).toBe('payment_verified');
  });
});
