import { describe, it, expect } from 'vitest';
import { BookingStatus } from '@prisma/client';
import { derivePaymentStatus } from '../../src/lib/payment-status.js';

describe('derivePaymentStatus', () => {
  const cases: [BookingStatus, 'online' | 'at_hotel', string][] = [
    [BookingStatus.requested, 'online', 'unpaid'],
    [BookingStatus.checking_availability, 'online', 'unpaid'],
    [BookingStatus.awaiting_payment, 'online', 'unpaid'],
    [BookingStatus.payment_submitted, 'online', 'pending_verification'],
    [BookingStatus.payment_verified, 'online', 'paid'],
    [BookingStatus.confirmed, 'online', 'paid'],
    [BookingStatus.refund_pending, 'online', 'refund_pending'],
    [BookingStatus.refunded, 'online', 'refunded'],
    [BookingStatus.cancelled, 'online', 'not_applicable'],
    [BookingStatus.unavailable, 'online', 'not_applicable'],
    [BookingStatus.confirmed, 'at_hotel', 'pay_at_hotel'],
    [BookingStatus.cancelled, 'at_hotel', 'not_applicable'],
  ];

  it.each(cases)('maps %s + %s → %s', (status, mode, expected) => {
    expect(
      derivePaymentStatus({ status, paymentMode: mode })
    ).toBe(expected);
  });
});
