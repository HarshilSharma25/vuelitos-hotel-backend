import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { captureException, captureMessage } from '../lib/sentry.js';
import { flightInternalClient } from '../lib/flight-internal.js';
import { transition } from '../modules/bookings/state-machine.js';
import { fetchBinanceUsdtRate } from '../modules/rates/sources/binance.js';
import { fetchBcvRates } from '../modules/rates/sources/bcv.js';
import { composeAndPersistRates } from '../modules/rates/compose.js';
import { handleStripeInternalEvent } from '../modules/payments/internal.service.js';
import { recordBookingTransition } from '../lib/metrics.js';
import { notifier } from '../modules/notifications/notifier.js';
import { settingsService } from '../modules/settings/service.js';
import { asNumberArray } from '../lib/json.js';

const connection = {
  url: env.REDIS_URL,
};

export const schedulerQueue = new Queue('hotel-scheduler', { connection });

export async function processExpiryJob() {
  const now = new Date();
  const staleBookings = await prisma.booking.findMany({
    where: {
      status: 'awaiting_payment',
      paymentMode: 'online',
      slaDueAt: { lt: now },
    },
    include: {
      payments: true,
      items: true,
    },
  });

  const twentyFourHoursMs = 24 * 60 * 60 * 1000;
  let expiredCount = 0;

  for (const b of staleBookings) {
    try {
      const hasActivePendingStripe = b.payments.some((p) => {
        if (p.method !== 'stripe_card' || p.status !== 'pending') return false;
        if (p.rawStatus === 'expired' || p.rawStatus === 'failed') return false;
        const isNotExpired = Date.now() - p.submittedAt.getTime() < twentyFourHoursMs;
        return isNotExpired;
      });

      if (hasActivePendingStripe) {
        logger.info(
          { bookingCode: b.code },
          '[ExpiryJob] Skipping expiry for booking with active pending Stripe session'
        );
        continue;
      }

      const windowHours = b.paymentWindowHours ?? 48;
      const next = transition({
        currentStatus: b.status,
        event: 'expire_payment_window',
        actorType: 'system',
        note: `Payment window expired (${windowHours}h)`,
        paymentMode: 'online',
      });

      await prisma.$transaction(async (tx) => {
        await tx.booking.update({
          where: { id: b.id },
          data: { status: next.toStatus },
        });

        await tx.bookingEvent.create({
          data: {
            bookingId: b.id,
            event: next.event,
            fromStatus: next.fromStatus,
            toStatus: next.toStatus,
            actorType: next.actorType,
            note: next.note,
          },
        });
      });
      recordBookingTransition(next.event);
      expiredCount++;
      logger.info({ bookingCode: b.code }, `[ExpiryJob] Expired booking ${b.code}`);

      await notifier.sendPaymentExpiredNotice({
        code: b.code,
        contactName: b.contactName,
        contactEmail: b.contactEmail,
      });
    } catch (err: any) {
      logger.error({ err: err.message, bookingCode: b.code }, `[ExpiryJob] Failed to expire ${b.code}`);
    }
  }

  return expiredCount;
}

export async function processPaymentRemindersJob() {
  const now = Date.now();
  const awaitingBookings = await prisma.booking.findMany({
    where: {
      status: 'awaiting_payment',
      paymentMode: 'online',
      slaDueAt: { not: null },
    },
    include: {
      items: true,
    },
  });

  for (const b of awaitingBookings) {
    if (!b.slaDueAt) continue;
    const slaDueMs = b.slaDueAt.getTime();
    if (slaDueMs <= now) continue;

    const windowHours = b.paymentWindowHours ?? 48;
    const totalDurationMs = windowHours * 3600 * 1000;
    const startMs = slaDueMs - totalDurationMs;
    const elapsedMs = Math.max(0, now - startMs);
    const elapsedPct = Math.floor((elapsedMs / totalDurationMs) * 100);

    const hotelId = b.items[0]?.hotelId;
    const effective = await settingsService.getEffectiveCheckoutSettings(hotelId);
    const reminderOffsets = effective.reminderOffsetsPct || [50, 90];

    const sent = asNumberArray(b.remindersSent);

    for (const offset of reminderOffsets) {
      if (elapsedPct >= offset && !sent.includes(offset)) {
        try {
          const hoursRemaining = Math.max(0, Math.round((slaDueMs - now) / (3600 * 1000)));

          await notifier.sendPaymentReminderNotice({
            code: b.code,
            contactName: b.contactName,
            contactEmail: b.contactEmail,
            pct: offset,
            hoursRemaining,
          });

          sent.push(offset);
          await prisma.booking.update({
            where: { id: b.id },
            data: {
              remindersSent: sent,
            },
          });

          logger.info(
            { bookingCode: b.code, offsetPct: offset },
            `[RemindersJob] Enqueued reminder at ${offset}% milestone for ${b.code}`
          );
        } catch (err: any) {
          logger.error(
            { err: err.message, bookingCode: b.code, offset },
            `[RemindersJob] Failed to trigger reminder for ${b.code}`
          );
        }
      }
    }
  }
}

export async function processSlaWatchJob() {
  const overdueBookings = await prisma.booking.findMany({
    where: {
      status: { in: ['requested', 'checking_availability'] },
      slaDueAt: { lt: new Date() },
    },
  });

  if (overdueBookings.length > 0) {
    const codes = overdueBookings.map((b) => b.code);
    const alertMsg = `ALERT: ${overdueBookings.length} bookings passed SLA due date: ${codes.join(', ')}`;
    logger.error(
      { alert: 'sla_breach', count: overdueBookings.length, codes },
      alertMsg
    );
    captureMessage(alertMsg, { codes, count: overdueBookings.length });
  }
}

export async function processStripeReconciliationJob() {
  try {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const pendingPayments = await prisma.payment.findMany({
      where: {
        method: 'stripe_card',
        status: 'pending',
        externalSessionId: { not: null },
        submittedAt: { lt: tenMinutesAgo },
      },
      include: {
        booking: true,
      },
    });

    for (const p of pendingPayments) {
      if (!p.externalSessionId) continue;
      try {
        const liveStatus = await flightInternalClient.getSessionStatus(p.externalSessionId);
        logger.info(
          { paymentId: p.id, sessionId: p.externalSessionId, liveStatus },
          '[Reconciliation] Fetched live status for pending payment'
        );

        let eventType = 'checkout.session.status';
        if (liveStatus.status === 'complete' && liveStatus.payment_status === 'paid') {
          eventType = 'checkout.session.completed';
        } else if (liveStatus.status === 'expired') {
          eventType = 'checkout.session.expired';
        }

        await handleStripeInternalEvent({
          event_id: `reconcile-${p.externalSessionId}-${liveStatus.status}-${liveStatus.payment_status}`,
          type: eventType,
          session_id: p.externalSessionId,
          hotel_booking_code: p.booking.code,
          amount_total: liveStatus.amount_total,
          currency: liveStatus.currency,
          payment_status: liveStatus.payment_status,
        });
      } catch (err: any) {
        logger.warn(
          { err: err.message, paymentId: p.id, sessionId: p.externalSessionId },
          '[Reconciliation] Could not fetch status from Flight'
        );
      }
    }
  } catch (err: any) {
    logger.error({ err: err.message }, '[Reconciliation] Job failed');
  }
}

export async function checkStaleFxRates() {
  try {
    const latestFx = await prisma.exchangeRate.findFirst({
      orderBy: { recordedAt: 'desc' },
    });
    if (latestFx) {
      const ageHours = (Date.now() - latestFx.recordedAt.getTime()) / (1000 * 60 * 60);
      if (ageHours > 24) {
        const alertMsg = `ALERT: Latest FX rate is older than 24 hours (${ageHours.toFixed(1)}h old)`;
        logger.error({ alert: 'fx_rate_stale', ageHours }, alertMsg);
        captureMessage(alertMsg, { ageHours });
      }
    }
  } catch (err: any) {
    logger.warn({ err: err.message }, 'Failed to check FX rate freshness');
  }
}

export async function processRatesUsdtJob() {
  try {
    const usdt = await fetchBinanceUsdtRate();
    const result = await composeAndPersistRates({ freshUsdt: usdt });
    logger.info({ result }, '[RatesJob] Processed rates.usdt successfully');
    await checkStaleFxRates();
  } catch (err: any) {
    const alertMsg = `ALERT: USDT rate fetch failure: ${err.message}`;
    logger.error({ alert: 'usdt_fetch_failure', error: err.message }, alertMsg);
    captureException(err, { alert: 'usdt_fetch_failure' });
  }
}

export async function processRatesBcvJob() {
  try {
    const bcv = await fetchBcvRates();
    const result = await composeAndPersistRates({ freshBcv: bcv });
    logger.info({ result }, '[RatesJob] Processed rates.bcv successfully');
    await checkStaleFxRates();
  } catch (err: any) {
    const alertMsg = `ALERT: BCV rate fetch failure: ${err.message}`;
    logger.error({ alert: 'bcv_fetch_failure', error: err.message }, alertMsg);
    captureException(err, { alert: 'bcv_fetch_failure' });
  }
}

export async function setupRepeatableJobs() {
  try {
    await schedulerQueue.upsertJobScheduler(
      'rates-usdt-repeat',
      { pattern: '0 */2 * * *' },
      { name: 'rates.usdt' }
    );

    await schedulerQueue.upsertJobScheduler(
      'rates-bcv-repeat',
      { pattern: '0 16-23,0 * * *' },
      { name: 'rates.bcv' }
    );

    await schedulerQueue.upsertJobScheduler(
      'expire-payment-repeat',
      { pattern: '*/15 * * * *' },
      { name: 'bookings.expire-payment-window' }
    );

    await schedulerQueue.upsertJobScheduler(
      'sla-watch-repeat',
      { pattern: '*/5 * * * *' },
      { name: 'bookings.sla-watch' }
    );

    await schedulerQueue.upsertJobScheduler(
      'reconcile-stripe-repeat',
      { pattern: '*/15 * * * *' },
      { name: 'bookings.reconcile-stripe-payments' }
    );

    await schedulerQueue.upsertJobScheduler(
      'payment-reminders-repeat',
      { pattern: '*/5 * * * *' },
      { name: 'bookings.payment-reminders' }
    );

    await schedulerQueue.upsertJobScheduler(
      'refund-staged-uploads-cleanup',
      { pattern: '0 * * * *' },
      { name: 'refunds.purge-staged-uploads' }
    );

    logger.info('[Scheduler] Registered BullMQ repeatable jobs.');
  } catch (err: any) {
    logger.warn({ err: err.message }, '[Scheduler] Could not register repeatable jobs (e.g. redis offline)');
  }
}

