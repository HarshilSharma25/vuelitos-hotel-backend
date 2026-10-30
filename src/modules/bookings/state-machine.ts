import { BookingStatus, Role } from '@prisma/client';
import { InvalidTransitionError } from '../../lib/errors.js';

export type BookingEventName =
  | 'start_check'
  | 'hotel_confirmed'
  | 'offer_alternatives'
  | 'accept_alternative'
  | 'mark_unavailable'
  | 'submit_payment'
  | 'verify_payment'
  | 'reject_payment'
  | 'confirm_booking'
  | 'expire_payment_window'
  | 'cancel'
  | 'complete_refund';

export type ActorType = 'customer' | 'agent' | 'admin' | 'system';

export interface TransitionRule {
  event: BookingEventName;
  from: BookingStatus[];
  to: BookingStatus;
  allowedActors: ActorType[];
}

export const TRANSITION_RULES: TransitionRule[] = [
  {
    event: 'start_check',
    from: [BookingStatus.requested],
    to: BookingStatus.checking_availability,
    allowedActors: ['agent', 'admin'],
  },
  {
    event: 'hotel_confirmed',
    from: [
      BookingStatus.requested,
      BookingStatus.checking_availability,
      BookingStatus.alternatives_offered,
    ],
    to: BookingStatus.awaiting_payment,
    allowedActors: ['agent', 'admin'],
  },
  {
    event: 'offer_alternatives',
    from: [BookingStatus.checking_availability],
    to: BookingStatus.alternatives_offered,
    allowedActors: ['agent', 'admin'],
  },
  {
    event: 'accept_alternative',
    from: [BookingStatus.alternatives_offered],
    to: BookingStatus.checking_availability,
    allowedActors: ['customer'],
  },
  {
    event: 'mark_unavailable',
    from: [BookingStatus.checking_availability, BookingStatus.alternatives_offered],
    to: BookingStatus.unavailable,
    allowedActors: ['agent', 'admin'],
  },
  {
    event: 'submit_payment',
    from: [BookingStatus.awaiting_payment],
    to: BookingStatus.payment_submitted,
    allowedActors: ['customer'],
  },
  {
    event: 'verify_payment',
    from: [BookingStatus.payment_submitted],
    to: BookingStatus.payment_verified,
    allowedActors: ['agent', 'admin'],
  },
  {
    event: 'reject_payment',
    from: [BookingStatus.payment_submitted],
    to: BookingStatus.awaiting_payment,
    allowedActors: ['agent', 'admin'],
  },
  {
    event: 'confirm_booking',
    from: [BookingStatus.payment_verified],
    to: BookingStatus.confirmed,
    allowedActors: ['agent', 'admin'],
  },
  {
    event: 'expire_payment_window',
    from: [BookingStatus.awaiting_payment],
    to: BookingStatus.cancelled,
    allowedActors: ['system'],
  },
  {
    event: 'cancel',
    from: [
      BookingStatus.requested,
      BookingStatus.checking_availability,
      BookingStatus.awaiting_payment,
      BookingStatus.alternatives_offered,
    ],
    to: BookingStatus.cancelled,
    allowedActors: ['customer', 'agent', 'admin'],
  },
  {
    event: 'cancel',
    from: [
      BookingStatus.payment_submitted,
      BookingStatus.payment_verified,
      BookingStatus.confirmed,
    ],
    to: BookingStatus.refund_pending,
    allowedActors: ['customer', 'agent', 'admin'],
  },
  {
    event: 'complete_refund',
    from: [BookingStatus.refund_pending],
    to: BookingStatus.refunded,
    allowedActors: ['admin'],
  },
];

export const TERMINAL_STATUSES: BookingStatus[] = [
  BookingStatus.unavailable,
  BookingStatus.cancelled,
  BookingStatus.refunded,
];

export function isTerminalStatus(status: BookingStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function getAllowedActions(status: BookingStatus): ('report_payment' | 'cancel')[] {
  switch (status) {
    case BookingStatus.requested:
    case BookingStatus.checking_availability:
    case BookingStatus.payment_submitted:
    case BookingStatus.payment_verified:
    case BookingStatus.confirmed:
    case BookingStatus.alternatives_offered:
      return ['cancel'];
    case BookingStatus.awaiting_payment:
      return ['report_payment', 'cancel'];
    case BookingStatus.unavailable:
    case BookingStatus.cancelled:
    case BookingStatus.refund_pending:
    case BookingStatus.refunded:
    default:
      return [];
  }
}

export interface TransitionInput {
  currentStatus: BookingStatus;
  event: BookingEventName;
  actorType: ActorType;
  actorId?: string;
  note?: string;
}

export interface TransitionOutput {
  fromStatus: BookingStatus;
  toStatus: BookingStatus;
  event: string;
  actorType: ActorType;
  actorId?: string;
  note?: string;
}

export function transition(input: TransitionInput): TransitionOutput {
  const matchingRule = TRANSITION_RULES.find(
    (r) =>
      r.event === input.event &&
      r.from.includes(input.currentStatus) &&
      r.allowedActors.includes(input.actorType)
  );

  if (!matchingRule) {
    throw new InvalidTransitionError(
      `Cannot perform event '${input.event}' from status '${input.currentStatus}' by actor '${input.actorType}'`
    );
  }

  return {
    fromStatus: input.currentStatus,
    toStatus: matchingRule.to,
    event: input.event,
    actorType: input.actorType,
    actorId: input.actorId,
    note: input.note,
  };
}
