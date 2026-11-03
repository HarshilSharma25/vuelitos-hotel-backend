import { bookingMailNotifier } from './booking-mail-notifier.js';
import { prisma } from '../../lib/prisma.js';

const STATUS_EVENT: Record<string, string> = {
  awaiting_payment: 'booking.approved_payment_due',
  payment_submitted: 'booking.payment_submitted',
  confirmed: 'booking.confirmed',
  unavailable: 'booking.unavailable',
  alternatives_offered: 'booking.alternatives_offered',
  cancelled: 'booking.cancelled',
};

export async function notifyBookingStatusChange(code: string, toStatus: string) {
  const event = STATUS_EVENT[toStatus];
  if (!event) return;
  const booking = await prisma.booking.findUnique({ where: { code } });
  if (!booking) return;
  await bookingMailNotifier.queueHotelMail(code, event, {
    recipient: booking.contactEmail,
    name: booking.contactName,
    locale: booking.locale,
    userId: booking.userId,
  });
}
