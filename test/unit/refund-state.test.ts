import { describe, it, expect } from 'vitest';
import { BookingStatus } from '@prisma/client';
import { transition } from '../../src/modules/bookings/state-machine.js';
import { InvalidTransitionError } from '../../src/lib/errors.js';

describe('reject_refund transition', () => {
  it('moves refund_pending to cancelled for admin', () => {
    const res = transition({
      currentStatus: BookingStatus.refund_pending,
      event: 'reject_refund',
      actorType: 'admin',
      paymentMode: 'online',
    });
    expect(res.toStatus).toBe(BookingStatus.cancelled);
  });

  it('does not allow agent to reject_refund', () => {
    expect(() =>
      transition({
        currentStatus: BookingStatus.refund_pending,
        event: 'reject_refund',
        actorType: 'agent',
        paymentMode: 'online',
      })
    ).toThrow(InvalidTransitionError);
  });
});
