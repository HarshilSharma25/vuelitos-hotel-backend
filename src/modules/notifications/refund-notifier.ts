import { bookingMailNotifier } from './booking-mail-notifier.js';

export const refundNotifier = {
  async queueRefundEvent(
    code: string,
    event: string,
    ctx: {
      recipient: string;
      name: string;
      locale: string;
      userId?: string | null;
      staffMessage?: string;
      approvedAmount?: number;
      approvedCurrency?: string;
      rejectionReason?: string;
      refundReference?: string;
    }
  ) {
    await bookingMailNotifier.queueHotelMail(code, event, ctx);
  },
};
