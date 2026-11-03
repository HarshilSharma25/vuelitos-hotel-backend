import { BookingStatus, PaymentMode } from '@prisma/client';
import type { RefundRequestStatus } from '@prisma/client';

export type DerivedPaymentStatus =
  | 'unpaid'
  | 'pending_verification'
  | 'paid'
  | 'pay_at_hotel'
  | 'refund_pending'
  | 'refunded'
  | 'not_applicable';

export function derivePaymentStatus(input: {
  status: BookingStatus;
  paymentMode: PaymentMode;
}): DerivedPaymentStatus {
  const { status, paymentMode } = input;

  if (paymentMode === 'at_hotel') {
    if (status === BookingStatus.cancelled || status === BookingStatus.unavailable) {
      return 'not_applicable';
    }
    return 'pay_at_hotel';
  }

  switch (status) {
    case BookingStatus.requested:
    case BookingStatus.checking_availability:
    case BookingStatus.alternatives_offered:
    case BookingStatus.awaiting_payment:
      return 'unpaid';
    case BookingStatus.payment_submitted:
      return 'pending_verification';
    case BookingStatus.payment_verified:
    case BookingStatus.confirmed:
      return 'paid';
    case BookingStatus.refund_pending:
      return 'refund_pending';
    case BookingStatus.refunded:
      return 'refunded';
    case BookingStatus.cancelled:
    case BookingStatus.unavailable:
      return 'not_applicable';
    default:
      return 'not_applicable';
  }
}

export type RefundStatusPublic = 'none' | RefundRequestStatus;

export function deriveRefundStatus(
  openOrLatest: { status: RefundRequestStatus } | null | undefined
): RefundStatusPublic {
  if (!openOrLatest) return 'none';
  return openOrLatest.status;
}

export function hasConfirmationDocument(status: BookingStatus): boolean {
  const order: BookingStatus[] = [
    BookingStatus.requested,
    BookingStatus.checking_availability,
    BookingStatus.awaiting_payment,
    BookingStatus.payment_submitted,
    BookingStatus.payment_verified,
    BookingStatus.confirmed,
    BookingStatus.alternatives_offered,
    BookingStatus.unavailable,
    BookingStatus.cancelled,
    BookingStatus.refund_pending,
    BookingStatus.refunded,
  ];
  return order.includes(status);
}
