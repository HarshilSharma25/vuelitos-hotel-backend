import { describe, it, expect } from 'vitest';
import {
  transition,
  getAllowedActions,
  getAdminAllowedActions,
  isTerminalStatus,
  normalizeEventName,
} from '../../src/modules/bookings/state-machine.js';
import { BookingStatus } from '@prisma/client';
import { InvalidTransitionError } from '../../src/lib/errors.js';

describe('Booking State Machine (Spec Aligned)', () => {
  it('normalizes aliases to canonical event names', () => {
    expect(normalizeEventName('start_check')).toBe('start_availability_check');
    expect(normalizeEventName('hotel_confirmed')).toBe('confirm_availability');
    expect(normalizeEventName('accept_alternative')).toBe('choose_alternative');
    expect(normalizeEventName('confirm_availability')).toBe('confirm_availability');
  });

  it('allows canonical transitions according to role', () => {
    // start_availability_check by agent, admin, system
    const res1 = transition({
      currentStatus: BookingStatus.requested,
      event: 'start_availability_check',
      actorType: 'agent',
    });
    expect(res1.toStatus).toBe(BookingStatus.checking_availability);
    expect(res1.event).toBe('start_availability_check');

    const res1Sys = transition({
      currentStatus: BookingStatus.requested,
      event: 'start_availability_check',
      actorType: 'system',
    });
    expect(res1Sys.toStatus).toBe(BookingStatus.checking_availability);

    // confirm_availability by admin / agent
    const res2 = transition({
      currentStatus: BookingStatus.checking_availability,
      event: 'confirm_availability',
      actorType: 'admin',
    });
    expect(res2.toStatus).toBe(BookingStatus.awaiting_payment);
    expect(res2.event).toBe('confirm_availability');

    // submit_payment allows customer AND system
    const res3Cust = transition({
      currentStatus: BookingStatus.awaiting_payment,
      event: 'submit_payment',
      actorType: 'customer',
    });
    expect(res3Cust.toStatus).toBe(BookingStatus.payment_submitted);

    const res3Sys = transition({
      currentStatus: BookingStatus.awaiting_payment,
      event: 'submit_payment',
      actorType: 'system',
    });
    expect(res3Sys.toStatus).toBe(BookingStatus.payment_submitted);

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

  it('supports alternative offerings, choosing alternative, and declining alternatives', () => {
    // offer_alternatives: checking_availability -> alternatives_offered
    const resOffer = transition({
      currentStatus: BookingStatus.checking_availability,
      event: 'offer_alternatives',
      actorType: 'agent',
    });
    expect(resOffer.toStatus).toBe(BookingStatus.alternatives_offered);

    // choose_alternative: alternatives_offered -> requested
    const resChoose = transition({
      currentStatus: BookingStatus.alternatives_offered,
      event: 'choose_alternative',
      actorType: 'customer',
    });
    expect(resChoose.toStatus).toBe(BookingStatus.requested);

    // decline_alternatives: alternatives_offered -> cancelled
    const resDecline = transition({
      currentStatus: BookingStatus.alternatives_offered,
      event: 'decline_alternatives',
      actorType: 'customer',
    });
    expect(resDecline.toStatus).toBe(BookingStatus.cancelled);
  });

  it('allows aliases and stores canonical name in output', () => {
    const resAlias = transition({
      currentStatus: BookingStatus.requested,
      event: 'start_check',
      actorType: 'agent',
    });
    expect(resAlias.toStatus).toBe(BookingStatus.checking_availability);
    expect(resAlias.event).toBe('start_availability_check');

    const resAlias2 = transition({
      currentStatus: BookingStatus.checking_availability,
      event: 'hotel_confirmed',
      actorType: 'agent',
    });
    expect(resAlias2.toStatus).toBe(BookingStatus.awaiting_payment);
    expect(resAlias2.event).toBe('confirm_availability');

    const resAlias3 = transition({
      currentStatus: BookingStatus.alternatives_offered,
      event: 'accept_alternative',
      actorType: 'customer',
    });
    expect(resAlias3.toStatus).toBe(BookingStatus.requested);
    expect(resAlias3.event).toBe('choose_alternative');
  });

  it('enforces that hotel_confirmed no longer works straight from requested or alternatives_offered', () => {
    expect(() =>
      transition({
        currentStatus: BookingStatus.requested,
        event: 'hotel_confirmed',
        actorType: 'agent',
      })
    ).toThrow(InvalidTransitionError);

    expect(() =>
      transition({
        currentStatus: BookingStatus.alternatives_offered,
        event: 'hotel_confirmed',
        actorType: 'agent',
      })
    ).toThrow(InvalidTransitionError);
  });

  it('transitions mark_unavailable to unavailable before payment, and refund_pending after payment', () => {
    // Before payment: checking_availability, requested, awaiting_payment -> unavailable
    const res = transition({
      currentStatus: BookingStatus.checking_availability,
      event: 'mark_unavailable',
      actorType: 'agent',
    });
    expect(res.toStatus).toBe(BookingStatus.unavailable);

    const resReq = transition({
      currentStatus: BookingStatus.requested,
      event: 'mark_unavailable',
      actorType: 'agent',
    });
    expect(resReq.toStatus).toBe(BookingStatus.unavailable);

    // After payment: payment_submitted, payment_verified, confirmed -> refund_pending
    const resPaid = transition({
      currentStatus: BookingStatus.payment_submitted,
      event: 'mark_unavailable',
      actorType: 'agent',
    });
    expect(resPaid.toStatus).toBe(BookingStatus.refund_pending);

    const resVer = transition({
      currentStatus: BookingStatus.payment_verified,
      event: 'mark_unavailable',
      actorType: 'agent',
    });
    expect(resVer.toStatus).toBe(BookingStatus.refund_pending);

    // alternatives_offered is not a valid source for mark_unavailable
    expect(() =>
      transition({
        currentStatus: BookingStatus.alternatives_offered,
        event: 'mark_unavailable',
        actorType: 'agent',
      })
    ).toThrow(InvalidTransitionError);
  });

  it('transitions cancel to cancelled before payment, and refund_pending after payment', () => {
    // Before payment: requested -> cancelled
    const res1 = transition({
      currentStatus: BookingStatus.requested,
      event: 'cancel',
      actorType: 'customer',
    });
    expect(res1.toStatus).toBe(BookingStatus.cancelled);

    // After payment submitted: payment_submitted -> refund_pending (documented deviation)
    const res2 = transition({
      currentStatus: BookingStatus.payment_submitted,
      event: 'cancel',
      actorType: 'customer',
    });
    expect(res2.toStatus).toBe(BookingStatus.refund_pending);

    // payment_verified -> refund_pending
    const res3 = transition({
      currentStatus: BookingStatus.payment_verified,
      event: 'cancel',
      actorType: 'customer',
    });
    expect(res3.toStatus).toBe(BookingStatus.refund_pending);

    // Confirmed -> refund_pending
    const res4 = transition({
      currentStatus: BookingStatus.confirmed,
      event: 'cancel',
      actorType: 'customer',
    });
    expect(res4.toStatus).toBe(BookingStatus.refund_pending);
  });

  it('allows complete_refund for both admin and super_admin, but not agent', () => {
    const resAdmin = transition({
      currentStatus: BookingStatus.refund_pending,
      event: 'complete_refund',
      actorType: 'admin',
    });
    expect(resAdmin.toStatus).toBe(BookingStatus.refunded);

    const resSuper = transition({
      currentStatus: BookingStatus.refund_pending,
      event: 'complete_refund',
      actorType: 'super_admin',
    });
    expect(resSuper.toStatus).toBe(BookingStatus.refunded);

    expect(() =>
      transition({
        currentStatus: BookingStatus.refund_pending,
        event: 'complete_refund',
        actorType: 'agent',
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

  it('handles post-payment admin approval and rejection with refund_pending', () => {
    // 1. Confirm booking from payment_verified or payment_submitted
    const resConfirmFromVer = transition({
      currentStatus: BookingStatus.payment_verified,
      event: 'confirm_booking',
      actorType: 'admin',
    });
    expect(resConfirmFromVer.toStatus).toBe(BookingStatus.confirmed);

    const resConfirmFromSub = transition({
      currentStatus: BookingStatus.payment_submitted,
      event: 'confirm_booking',
      actorType: 'admin',
    });
    expect(resConfirmFromSub.toStatus).toBe(BookingStatus.confirmed);

    // 2. Mark unavailable from paid statuses triggers refund_pending
    const resUnavailSub = transition({
      currentStatus: BookingStatus.payment_submitted,
      event: 'mark_unavailable',
      actorType: 'admin',
    });
    expect(resUnavailSub.toStatus).toBe(BookingStatus.refund_pending);

    const resUnavailVer = transition({
      currentStatus: BookingStatus.payment_verified,
      event: 'mark_unavailable',
      actorType: 'admin',
    });
    expect(resUnavailVer.toStatus).toBe(BookingStatus.refund_pending);

    const resUnavailConf = transition({
      currentStatus: BookingStatus.confirmed,
      event: 'mark_unavailable',
      actorType: 'admin',
    });
    expect(resUnavailConf.toStatus).toBe(BookingStatus.refund_pending);

    // 3. Admin actions for payment_verified and payment_submitted
    const actionsVer = getAdminAllowedActions(BookingStatus.payment_verified, 'online');
    expect(actionsVer).toContain('approve');
    expect(actionsVer).toContain('confirm_booking');
    expect(actionsVer).toContain('mark_unavailable');
    expect(actionsVer).toContain('cancel');

    const actionsSub = getAdminAllowedActions(BookingStatus.payment_submitted, 'online');
    expect(actionsSub).toContain('approve');
    expect(actionsSub).toContain('verify_payment');
    expect(actionsSub).toContain('mark_unavailable');
    expect(actionsSub).toContain('cancel');
  });
});
