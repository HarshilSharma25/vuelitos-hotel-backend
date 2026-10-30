import { describe, it, expect } from 'vitest';
import {
  transition,
  getAllowedActions,
  isTerminalStatus,
} from '../../src/modules/bookings/state-machine.js';
import { BookingStatus } from '@prisma/client';
import { InvalidTransitionError } from '../../src/lib/errors.js';

describe('Booking State Machine', () => {
  it('allows valid transitions according to role', () => {
    // start_check by agent
    const res1 = transition({
      currentStatus: BookingStatus.requested,
      event: 'start_check',
      actorType: 'agent',
    });
    expect(res1.toStatus).toBe(BookingStatus.checking_availability);

    // hotel_confirmed by agent
    const res2 = transition({
      currentStatus: BookingStatus.checking_availability,
      event: 'hotel_confirmed',
      actorType: 'agent',
    });
    expect(res2.toStatus).toBe(BookingStatus.awaiting_payment);

    // submit_payment by customer
    const res3 = transition({
      currentStatus: BookingStatus.awaiting_payment,
      event: 'submit_payment',
      actorType: 'customer',
    });
    expect(res3.toStatus).toBe(BookingStatus.payment_submitted);

    // verify_payment by agent
    const res4 = transition({
      currentStatus: BookingStatus.payment_submitted,
      event: 'verify_payment',
      actorType: 'agent',
    });
    expect(res4.toStatus).toBe(BookingStatus.payment_verified);

    // confirm_booking by agent
    const res5 = transition({
      currentStatus: BookingStatus.payment_verified,
      event: 'confirm_booking',
      actorType: 'agent',
    });
    expect(res5.toStatus).toBe(BookingStatus.confirmed);
  });

  it('transitions cancel to cancelled before payment, and refund_pending after payment', () => {
    // Before payment: requested -> cancelled
    const res1 = transition({
      currentStatus: BookingStatus.requested,
      event: 'cancel',
      actorType: 'customer',
    });
    expect(res1.toStatus).toBe(BookingStatus.cancelled);

    // After payment submitted: payment_submitted -> refund_pending
    const res2 = transition({
      currentStatus: BookingStatus.payment_submitted,
      event: 'cancel',
      actorType: 'customer',
    });
    expect(res2.toStatus).toBe(BookingStatus.refund_pending);

    // Confirmed -> refund_pending
    const res3 = transition({
      currentStatus: BookingStatus.confirmed,
      event: 'cancel',
      actorType: 'customer',
    });
    expect(res3.toStatus).toBe(BookingStatus.refund_pending);
  });

  it('rejects invalid transitions', () => {
    expect(() =>
      transition({
        currentStatus: BookingStatus.confirmed,
        event: 'hotel_confirmed',
        actorType: 'agent',
      })
    ).toThrow(InvalidTransitionError);

    // Customer cannot verify_payment
    expect(() =>
      transition({
        currentStatus: BookingStatus.payment_submitted,
        event: 'verify_payment',
        actorType: 'customer',
      })
    ).toThrow(InvalidTransitionError);
  });

  it('identifies terminal statuses and allowed actions', () => {
    expect(isTerminalStatus(BookingStatus.cancelled)).toBe(true);
    expect(isTerminalStatus(BookingStatus.unavailable)).toBe(true);
    expect(isTerminalStatus(BookingStatus.refunded)).toBe(true);
    expect(isTerminalStatus(BookingStatus.confirmed)).toBe(false);

    expect(getAllowedActions(BookingStatus.awaiting_payment)).toEqual([
      'report_payment',
      'cancel',
    ]);
    expect(getAllowedActions(BookingStatus.requested)).toEqual(['cancel']);
    expect(getAllowedActions(BookingStatus.cancelled)).toEqual([]);
  });
});
