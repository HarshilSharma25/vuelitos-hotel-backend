import { prisma } from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import { captureMessage } from '../../lib/sentry.js';
import { transition } from '../bookings/state-machine.js';
import { recordBookingTransition } from '../../lib/metrics.js';

export interface StripeEventPayload {
  event_id: string;
  type: string;
  session_id: string;
  hotel_booking_code: string;
  amount_total: number;
  currency: string;
  payment_status: string;
}

export async function handleStripeInternalEvent(body: StripeEventPayload): Promise<{ status: string }> {
  const existingEvent = await prisma.paymentEvent.findUnique({
    where: {
      provider_eventId: {
        provider: 'stripe',
        eventId: body.event_id,
      },
    },
  });

  if (existingEvent) {
    logger.info({ eventId: body.event_id }, 'Stripe event already processed, skipping');
    return { status: 'already_processed' };
  }

  const booking = await prisma.booking.findUnique({
    where: { code: body.hotel_booking_code },
    include: { payments: true },
  });

  if (!booking) {
    logger.error({ code: body.hotel_booking_code }, 'Booking not found for internal Stripe event');
    return { status: 'booking_not_found' };
  }

  const payment =
    (await prisma.payment.findUnique({
      where: { externalSessionId: body.session_id },
    })) ||
    booking.payments.find(
      (p) => p.externalSessionId === body.session_id || p.reference === body.session_id
    );

  if (body.type === 'checkout.session.completed' && body.payment_status === 'paid') {
    const totals = (booking.totalsByMethod as any[]) || [];
    const stripeEntry = totals.find((m: any) => m.method === 'stripe_card');

    const expectedCents = stripeEntry ? Math.round(Number(stripeEntry.amount) * 100) : null;
    const expectedCurrency = stripeEntry ? String(stripeEntry.currency).toLowerCase() : null;

    const receivedCents = Number(body.amount_total);
    const receivedCurrency = String(body.currency).toLowerCase();

    const isMatch =
      expectedCents !== null &&
      expectedCurrency !== null &&
      receivedCents === expectedCents &&
      receivedCurrency === expectedCurrency;

    if (isMatch) {
      await prisma.$transaction(async (tx) => {
        await tx.paymentEvent.create({
          data: {
            provider: 'stripe',
            eventId: body.event_id,
            type: body.type,
            payload: body as any,
          },
        });

        if (payment) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: 'verified',
              rawStatus: body.payment_status,
              verifiedAt: new Date(),
              verifiedBy: 'system',
            },
          });
        } else {
          await tx.payment.create({
            data: {
              bookingId: booking.id,
              method: 'stripe_card',
              currency: body.currency.toUpperCase(),
              amountQuoted: stripeEntry ? stripeEntry.amount : receivedCents / 100,
              reference: body.session_id,
              status: 'verified',
              externalProvider: 'stripe',
              externalSessionId: body.session_id,
              rawStatus: body.payment_status,
              verifiedAt: new Date(),
              verifiedBy: 'system',
            },
          });
        }

        if (booking.status === 'awaiting_payment') {
          const submitTrans = transition({
            currentStatus: 'awaiting_payment',
            event: 'submit_payment',
            actorType: 'system',
            note: `Stripe checkout completed (session: ${body.session_id})`,
          });

          const verifyTrans = transition({
            currentStatus: submitTrans.toStatus,
            event: 'verify_payment',
            actorType: 'system',
            note: `Stripe payment verified (event: ${body.event_id}, session: ${body.session_id})`,
          });

          await tx.booking.update({
            where: { id: booking.id },
            data: { status: verifyTrans.toStatus },
          });

          await tx.bookingEvent.create({
            data: {
              bookingId: booking.id,
              event: submitTrans.event,
              fromStatus: submitTrans.fromStatus,
              toStatus: submitTrans.toStatus,
              actorType: submitTrans.actorType,
              note: submitTrans.note,
            },
          });

          await tx.bookingEvent.create({
            data: {
              bookingId: booking.id,
              event: verifyTrans.event,
              fromStatus: verifyTrans.fromStatus,
              toStatus: verifyTrans.toStatus,
              actorType: verifyTrans.actorType,
              note: verifyTrans.note,
            },
          });

          recordBookingTransition('submit_payment');
          recordBookingTransition('verify_payment');
        } else if (booking.status === 'payment_submitted') {
          const verifyTrans = transition({
            currentStatus: 'payment_submitted',
            event: 'verify_payment',
            actorType: 'system',
            note: `Stripe payment verified (event: ${body.event_id}, session: ${body.session_id})`,
          });

          await tx.booking.update({
            where: { id: booking.id },
            data: { status: verifyTrans.toStatus },
          });

          await tx.bookingEvent.create({
            data: {
              bookingId: booking.id,
              event: verifyTrans.event,
              fromStatus: verifyTrans.fromStatus,
              toStatus: verifyTrans.toStatus,
              actorType: verifyTrans.actorType,
              note: verifyTrans.note,
            },
          });

          recordBookingTransition('verify_payment');
        }
      });

      logger.info(
        { bookingCode: booking.code, sessionId: body.session_id },
        'Stripe payment successfully verified'
      );
      return { status: 'verified' };
    } else {
      await prisma.$transaction(async (tx) => {
        await tx.paymentEvent.create({
          data: {
            provider: 'stripe',
            eventId: body.event_id,
            type: body.type,
            payload: body as any,
          },
        });

        if (payment) {
          await tx.payment.update({
            where: { id: payment.id },
            data: {
              status: 'needs_review',
              rawStatus: body.payment_status,
            },
          });
        } else {
          await tx.payment.create({
            data: {
              bookingId: booking.id,
              method: 'stripe_card',
              currency: body.currency.toUpperCase(),
              amountQuoted: stripeEntry ? stripeEntry.amount : 0,
              reference: body.session_id,
              status: 'needs_review',
              externalProvider: 'stripe',
              externalSessionId: body.session_id,
              rawStatus: body.payment_status,
            },
          });
        }
      });

      const alertMsg = `ALERT: Stripe payment mismatch for booking ${booking.code}. Expected: ${expectedCents} ${expectedCurrency}, Received: ${receivedCents} ${receivedCurrency}`;
      logger.error(
        {
          alert: 'stripe_payment_mismatch',
          bookingCode: booking.code,
          sessionId: body.session_id,
          expected: { amountCents: expectedCents, currency: expectedCurrency },
          received: { amountCents: receivedCents, currency: receivedCurrency },
        },
        alertMsg
      );
      captureMessage(alertMsg, {
        bookingCode: booking.code,
        sessionId: body.session_id,
      });

      return { status: 'needs_review' };
    }
  } else if (
    body.type === 'checkout.session.expired' ||
    body.payment_status === 'unpaid' ||
    body.payment_status === 'expired'
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.paymentEvent.create({
        data: {
          provider: 'stripe',
          eventId: body.event_id,
          type: body.type,
          payload: body as any,
        },
      });

      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'expired',
            rawStatus: 'expired',
          },
        });
      }
    });

    logger.info({ bookingCode: booking.code, sessionId: body.session_id }, 'Stripe payment marked expired');
    return { status: 'expired' };
  } else if (
    body.type === 'checkout.session.async_payment_failed' ||
    body.payment_status === 'failed'
  ) {
    await prisma.$transaction(async (tx) => {
      await tx.paymentEvent.create({
        data: {
          provider: 'stripe',
          eventId: body.event_id,
          type: body.type,
          payload: body as any,
        },
      });

      if (payment) {
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: 'failed',
            rawStatus: 'failed',
          },
        });
      }
    });

    logger.warn({ bookingCode: booking.code, sessionId: body.session_id }, 'Stripe payment marked failed');
    return { status: 'failed' };
  }

  return { status: 'ignored' };
}
