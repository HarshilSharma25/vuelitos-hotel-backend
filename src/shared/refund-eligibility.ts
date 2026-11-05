import {
  BookingStatus,
  PaymentMode,
  PaymentStatus,
  RefundRequestStatus,
} from '@prisma/client';

export type RefundIneligibleReason =
  | 'pay_at_hotel'
  | 'not_paid'
  | 'already_requested'
  | 'already_refunded'
  | 'cancelled_unpaid'
  | 'status_not_eligible';

export type RefundEligibility = {
  eligible: boolean;
  reason?: RefundIneligibleReason;
  message_key: string;
};

const OPEN_REFUND: RefundRequestStatus[] = [
  RefundRequestStatus.submitted,
  RefundRequestStatus.in_review,
  RefundRequestStatus.needs_info,
  RefundRequestStatus.approved,
];

const PAID_STATUSES: BookingStatus[] = [
  BookingStatus.payment_submitted,
  BookingStatus.payment_verified,
  BookingStatus.confirmed,
];

export function computeRefundEligibility(input: {
  bookingStatus: BookingStatus;
  paymentMode: PaymentMode;
  hasOpenRefundRequest: boolean;
  hasAnyRefundRequest: boolean;
  latestRefundStatus?: RefundRequestStatus | null;
  hasVerifiedOrSubmittedPayment: boolean;
}): RefundEligibility {
  if (input.paymentMode === PaymentMode.at_hotel) {
    return { eligible: false, reason: 'pay_at_hotel', message_key: 'refund.ineligible.pay_at_hotel' };
  }

  if (input.bookingStatus === BookingStatus.refunded) {
    return { eligible: false, reason: 'already_refunded', message_key: 'refund.ineligible.already_refunded' };
  }

  if (input.hasOpenRefundRequest) {
    return {
      eligible: false,
      reason: 'already_requested',
      message_key: 'refund.ineligible.already_requested',
    };
  }

  if (input.bookingStatus === BookingStatus.cancelled) {
    return {
      eligible: false,
      reason: 'cancelled_unpaid',
      message_key: 'refund.ineligible.cancelled_unpaid',
    };
  }

  if (input.bookingStatus === BookingStatus.refund_pending) {
    if (input.hasAnyRefundRequest && input.latestRefundStatus === RefundRequestStatus.rejected) {
      return { eligible: false, reason: 'status_not_eligible', message_key: 'refund.ineligible.status' };
    }
    return { eligible: true, message_key: 'refund.eligible' };
  }

  if (PAID_STATUSES.includes(input.bookingStatus)) {
    if (!input.hasVerifiedOrSubmittedPayment && input.bookingStatus === BookingStatus.awaiting_payment) {
      return { eligible: false, reason: 'not_paid', message_key: 'refund.ineligible.not_paid' };
    }
    return { eligible: true, message_key: 'refund.eligible' };
  }

  return { eligible: false, reason: 'not_paid', message_key: 'refund.ineligible.not_paid' };
}

export function bookingHasMeaningfulPayment(payments: { status: PaymentStatus }[]): boolean {
  return payments.some(
    (p) => p.status === PaymentStatus.verified || p.status === PaymentStatus.submitted
  );
}

export { OPEN_REFUND as OPEN_REFUND_STATUSES };
