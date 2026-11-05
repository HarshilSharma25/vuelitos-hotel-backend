import { describe, it, expect } from 'vitest';
import { BookingStatus, PaymentMode, RefundRequestStatus } from '@prisma/client';
import { computeRefundEligibility } from '../../src/shared/refund-eligibility.js';

describe('computeRefundEligibility', () => {
  it('allows online paid statuses when no open request', () => {
    for (const status of [
      BookingStatus.payment_submitted,
      BookingStatus.payment_verified,
      BookingStatus.confirmed,
    ]) {
      const r = computeRefundEligibility({
        bookingStatus: status,
        paymentMode: PaymentMode.online,
        hasOpenRefundRequest: false,
        hasAnyRefundRequest: false,
        hasVerifiedOrSubmittedPayment: true,
      });
      expect(r.eligible).toBe(true);
    }
  });

  it('blocks pay at hotel', () => {
    const r = computeRefundEligibility({
      bookingStatus: BookingStatus.confirmed,
      paymentMode: PaymentMode.at_hotel,
      hasOpenRefundRequest: false,
      hasAnyRefundRequest: false,
      hasVerifiedOrSubmittedPayment: false,
    });
    expect(r.reason).toBe('pay_at_hotel');
  });

  it('blocks when open request exists', () => {
    const r = computeRefundEligibility({
      bookingStatus: BookingStatus.refund_pending,
      paymentMode: PaymentMode.online,
      hasOpenRefundRequest: true,
      hasAnyRefundRequest: true,
      latestRefundStatus: RefundRequestStatus.submitted,
      hasVerifiedOrSubmittedPayment: true,
    });
    expect(r.reason).toBe('already_requested');
  });

  it('allows refund_pending without request yet', () => {
    const r = computeRefundEligibility({
      bookingStatus: BookingStatus.refund_pending,
      paymentMode: PaymentMode.online,
      hasOpenRefundRequest: false,
      hasAnyRefundRequest: false,
      hasVerifiedOrSubmittedPayment: true,
    });
    expect(r.eligible).toBe(true);
  });
});
