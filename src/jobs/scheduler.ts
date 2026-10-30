import { Queue } from 'bullmq';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { transition } from '../modules/bookings/state-machine.js';
import { fetchBinanceUsdtRate } from '../modules/rates/sources/binance.js';
import { fetchBcvRates } from '../modules/rates/sources/bcv.js';
import { composeAndPersistRates } from '../modules/rates/compose.js';

const connection = {
  url: env.REDIS_URL,
};

export const schedulerQueue = new Queue('hotel-scheduler', { connection });

export async function processExpiryJob() {
  const windowHours = env.PAYMENT_WINDOW_HOURS || 48;
  const expiryThreshold = new Date(Date.now() - windowHours * 60 * 60 * 1000);

  const staleBookings = await prisma.booking.findMany({
    where: {
      status: 'awaiting_payment',
      updatedAt: { lt: expiryThreshold },
    },
  });

  for (const b of staleBookings) {
    try {
      const next = transition({
        currentStatus: b.status,
        event: 'expire_payment_window',
        actorType: 'system',
        note: `Payment window expired (${windowHours}h)`,
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
      console.log(`[ExpiryJob] Expired booking ${b.code}`);
    } catch (err) {
      console.error(`[ExpiryJob] Failed to expire ${b.code}:`, err);
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
    console.warn(
      `[SLA Watch] ALERT: ${overdueBookings.length} bookings passed SLA due date: ${overdueBookings.map((b) => b.code).join(', ')}`
    );
  }
}

export async function processRatesUsdtJob() {
  try {
    const usdt = await fetchBinanceUsdtRate();
    const result = await composeAndPersistRates({ freshUsdt: usdt });
    console.log('[RatesJob] Processed rates.usdt successfully:', result);
  } catch (err: any) {
    console.error('[RatesJob] Failed to process rates.usdt:', err.message);
  }
}

export async function processRatesBcvJob() {
  try {
    const bcv = await fetchBcvRates();
    const result = await composeAndPersistRates({ freshBcv: bcv });
    console.log('[RatesJob] Processed rates.bcv successfully:', result);
  } catch (err: any) {
    console.error('[RatesJob] Failed to process rates.bcv:', err.message);
  }
}

export async function setupRepeatableJobs() {
  try {
    // 1. USDT every 2 hours
    await schedulerQueue.upsertJobScheduler(
      'rates-usdt-repeat',
      { pattern: '0 */2 * * *' },
      { name: 'rates.usdt' }
    );

    // 2. BCV hourly 12:00 to 20:00 Caracas (16:00 to 00:00 UTC)
    await schedulerQueue.upsertJobScheduler(
      'rates-bcv-repeat',
      { pattern: '0 16-23,0 * * *' },
      { name: 'rates.bcv' }
    );

    // 3. Expire payment window every 15 minutes
    await schedulerQueue.upsertJobScheduler(
      'expire-payment-repeat',
      { pattern: '*/15 * * * *' },
      { name: 'bookings.expire-payment-window' }
    );

    // 4. SLA watch every 5 minutes
    await schedulerQueue.upsertJobScheduler(
      'sla-watch-repeat',
      { pattern: '*/5 * * * *' },
      { name: 'bookings.sla-watch' }
    );

    console.log('[Scheduler] Registered BullMQ repeatable jobs.');
  } catch (err: any) {
    console.warn('[Scheduler] Could not register repeatable jobs (e.g. redis offline):', err.message);
  }
}
