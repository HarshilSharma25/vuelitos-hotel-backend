import { Queue } from 'bullmq';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { captureMessage } from '../../lib/sentry.js';
import type { BookingNoticePayload } from './notifier.js';

export const notificationsQueue = new Queue('hotel-notifications', {
  connection: { url: env.REDIS_URL },
});

const EVENT_TEMPLATE: Record<string, 'hotel-confirmation' | 'hotel-update'> = {
  'notification.booking-created': 'hotel-confirmation',
  'notification.payment-reminder': 'hotel-update',
  'notification.payment-expired': 'hotel-update',
  'notification.resend-access': 'hotel-update',
  'booking.approved_payment_due': 'hotel-update',
  'booking.payment_submitted': 'hotel-update',
  'booking.confirmed': 'hotel-confirmation',
  'booking.unavailable': 'hotel-update',
  'booking.alternatives_offered': 'hotel-update',
  'booking.cancelled': 'hotel-update',
  'refund.request_received': 'hotel-update',
  'refund.needs_info': 'hotel-update',
  'refund.approved': 'hotel-update',
  'refund.rejected': 'hotel-update',
  'refund.completed': 'hotel-update',
};

export class BookingMailNotifier {
  private async enqueue(
    jobName: string,
    code: string,
    payload: Record<string, unknown>,
    attachConfirmationPdf = false
  ) {
    const template = EVENT_TEMPLATE[jobName] || 'hotel-update';
    const eventKey = jobName.replace(/^notification\./, '').replace(/\./g, '-');
    const jobId = `${code}-${eventKey}`;

    try {
      await notificationsQueue.add(
        jobName,
        {
          code,
          template,
          attachConfirmationPdf,
          ...payload,
        },
        {
          jobId,
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 5,
          backoff: { type: 'exponential', delay: 30_000 },
        }
      );
    } catch (err: any) {
      logger.warn({ err: err.message, bookingCode: code, jobName }, '[MailNotifier] enqueue failed');
      captureMessage(`Hotel mail enqueue failed for ${code}: ${jobName}`);
    }
  }

  async queueHotelMail(code: string, event: string, ctx: Record<string, unknown>) {
    await this.enqueue(event, code, ctx, event === 'booking.confirmed');
  }

  async sendBookingCreatedNotice(booking: BookingNoticePayload) {
    await this.enqueue('notification.booking-created', booking.code, {
      recipient: booking.contactEmail,
      name: booking.contactName,
      includeAccessToken: true,
      accessToken: booking.accessToken,
    });
  }

  async sendPaymentReminderNotice(booking: BookingNoticePayload) {
    await this.enqueue('notification.payment-reminder', booking.code, {
      recipient: booking.contactEmail,
      name: booking.contactName,
      pct: booking.pct,
      hoursRemaining: booking.hoursRemaining,
    });
  }

  async sendPaymentExpiredNotice(booking: BookingNoticePayload) {
    await this.enqueue('notification.payment-expired', booking.code, {
      recipient: booking.contactEmail,
      name: booking.contactName,
    });
  }

  async sendAccessLinkNotice(booking: BookingNoticePayload) {
    await this.enqueue('notification.resend-access', booking.code, {
      recipient: booking.contactEmail,
      name: booking.contactName,
      includeAccessToken: true,
      accessToken: booking.accessToken,
    });
  }
}

export const bookingMailNotifier = new BookingMailNotifier();
