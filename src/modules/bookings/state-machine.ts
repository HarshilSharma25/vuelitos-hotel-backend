import { BookingStatus } from '@prisma/client';
import { InvalidTransitionError } from '../../lib/errors.js';

export type BookingCanonicalEventName =
  | 'start_availability_check'
  | 'confirm_availability'
  | 'confirm_pay_at_hotel'
  | 'offer_alternatives'
  | 'choose_alternative'
  | 'decline_alternatives'
  | 'mark_unavailable'
  | 'submit_payment'
  | 'verify_payment'
  | 'reject_payment'
  | 'confirm_booking'
  | 'expire_payment_window'
  | 'cancel'
  | 'request_refund'
  | 'reject_refund'
  | 'complete_refund';

export type BookingEventAlias =
  | 'start_check'
  | 'hotel_confirmed'
  | 'accept_alternative';

export type BookingEventName = BookingCanonicalEventName | BookingEventAlias;

export const EVENT_ALIASES: Record<BookingEventAlias, BookingCanonicalEventName> = {
  start_check: 'start_availability_check',
  hotel_confirmed: 'confirm_availability',
  accept_alternative: 'choose_alternative',
};

export function normalizeEventName(event: string): BookingCanonicalEventName {
  if (event in EVENT_ALIASES) {
    return EVENT_ALIASES[event as BookingEventAlias];
  }
  return event as BookingCanonicalEventName;
}

export type ActorType = 'customer' | 'agent' | 'admin' | 'super_admin' | 'system';
export type PaymentMode = 'online' | 'at_hotel';

export interface TransitionRule {
  event: BookingCanonicalEventName;
  from: BookingStatus[];
  to: BookingStatus;
  allowedActors: ActorType[];
  allowedPaymentModes?: PaymentMode[];
}

export const TRANSITION_RULES: TransitionRule[] = [
  {
    event: 'start_availability_check',
    from: [BookingStatus.requested],
    to: BookingStatus.checking_availability,
    allowedActors: ['agent', 'admin', 'super_admin', 'system'],
  },
  {
    event: 'confirm_availability',
    from: [BookingStatus.checking_availability],
    to: BookingStatus.awaiting_payment,
    allowedActors: ['agent', 'admin', 'super_admin'],
    allowedPaymentModes: ['online'],
  },
  {
    event: 'confirm_pay_at_hotel',
    from: [BookingStatus.checking_availability],
    to: BookingStatus.confirmed,
    allowedActors: ['agent', 'admin', 'super_admin'],
    allowedPaymentModes: ['at_hotel'],
  },
  {
    event: 'offer_alternatives',
    from: [BookingStatus.checking_availability],
    to: BookingStatus.alternatives_offered,
    allowedActors: ['agent', 'admin', 'super_admin'],
  },
  {
    event: 'mark_unavailable',
    from: [
      BookingStatus.requested,
      BookingStatus.checking_availability,
      BookingStatus.awaiting_payment,
    ],
    to: BookingStatus.unavailable,
    allowedActors: ['agent', 'admin', 'super_admin'],
  },
  {
    event: 'mark_unavailable',
    from: [
      BookingStatus.payment_submitted,
      BookingStatus.payment_verified,
      BookingStatus.confirmed,
    ],
    to: BookingStatus.refund_pending,
    allowedActors: ['agent', 'admin', 'super_admin'],
    allowedPaymentModes: ['online'],
  },
  {
    event: 'choose_alternative',
    from: [BookingStatus.alternatives_offered],
    to: BookingStatus.requested,
    allowedActors: ['customer', 'agent', 'admin', 'super_admin'],
  },
  {
    event: 'decline_alternatives',
    from: [BookingStatus.alternatives_offered],
    to: BookingStatus.cancelled,
    allowedActors: ['customer', 'agent', 'admin', 'super_admin'],
  },
  {
    event: 'submit_payment',
    from: [BookingStatus.awaiting_payment],
    to: BookingStatus.payment_submitted,
    allowedActors: ['customer', 'system'],
    allowedPaymentModes: ['online'],
  },
  {
    event: 'verify_payment',
    from: [BookingStatus.payment_submitted],
    to: BookingStatus.payment_verified,
    allowedActors: ['agent', 'admin', 'super_admin', 'system'],
    allowedPaymentModes: ['online'],
  },
  {
    event: 'reject_payment',
    from: [BookingStatus.payment_submitted],
    to: BookingStatus.awaiting_payment,
    allowedActors: ['agent', 'admin', 'super_admin'],
    allowedPaymentModes: ['online'],
  },
  {
    event: 'confirm_booking',
    from: [BookingStatus.payment_verified, BookingStatus.payment_submitted],
    to: BookingStatus.confirmed,
    allowedActors: ['agent', 'admin', 'super_admin', 'system'],
    allowedPaymentModes: ['online'],
  },
  {
    event: 'expire_payment_window',
    from: [BookingStatus.awaiting_payment],
    to: BookingStatus.cancelled,
    allowedActors: ['system'],
    allowedPaymentModes: ['online'],
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
    allowedActors: ['customer', 'agent', 'admin', 'super_admin'],
  },
  {
    event: 'cancel',
    from: [BookingStatus.confirmed],
    to: BookingStatus.cancelled,
    allowedActors: ['customer', 'agent', 'admin', 'super_admin'],
    allowedPaymentModes: ['at_hotel'],
  },
  {
    event: 'cancel',
    from: [
      BookingStatus.payment_submitted,
      BookingStatus.payment_verified,
      BookingStatus.confirmed,
    ],
    to: BookingStatus.refund_pending,
    allowedActors: ['customer', 'agent', 'admin', 'super_admin'],
    allowedPaymentModes: ['online'],
  },
  {
    event: 'complete_refund',
    from: [BookingStatus.refund_pending],
    to: BookingStatus.refunded,
    allowedActors: ['admin', 'super_admin'],
  },
  {
    event: 'reject_refund',
    from: [BookingStatus.refund_pending],
    to: BookingStatus.cancelled,
    allowedActors: ['admin', 'super_admin'],
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

export function getAllowedActions(
  status: BookingStatus,
  paymentMode: PaymentMode = 'online',
  checkInDate?: Date | string | null
): ('report_payment' | 'cancel' | 'request_refund')[] {
  if (checkInDate && new Date(checkInDate).getTime() <= Date.now()) {
    if (status === BookingStatus.confirmed) {
      return [];
    }
  }

  if (paymentMode === 'at_hotel') {
    switch (status) {
      case BookingStatus.requested:
      case BookingStatus.checking_availability:
      case BookingStatus.confirmed:
      case BookingStatus.alternatives_offered:
        return ['cancel'];
      case BookingStatus.awaiting_payment:
      case BookingStatus.payment_submitted:
      case BookingStatus.payment_verified:
      case BookingStatus.unavailable:
      case BookingStatus.cancelled:
      case BookingStatus.refund_pending:
      case BookingStatus.refunded:
      default:
        return [];
    }
  }

  switch (status) {
    case BookingStatus.requested:
    case BookingStatus.checking_availability:
    case BookingStatus.alternatives_offered:
      return ['cancel'];
    case BookingStatus.payment_submitted:
    case BookingStatus.payment_verified:
    case BookingStatus.confirmed:
      return ['cancel', 'request_refund'];
    case BookingStatus.awaiting_payment:
      return ['report_payment', 'cancel'];
    case BookingStatus.refund_pending:
      return ['request_refund'];
    case BookingStatus.unavailable:
    case BookingStatus.cancelled:
    case BookingStatus.refunded:
    default:
      return [];
  }
}

export function getAdminAllowedActions(
  status: BookingStatus | string,
  paymentMode: PaymentMode | string = 'online',
  checkInDate?: Date | null
): string[] {
  const mode = (paymentMode as PaymentMode) || 'online';
  switch (status) {
    case BookingStatus.requested:
      return ['approve', 'start_check', 'hotel_confirmed', 'mark_unavailable', 'cancel'];
    case BookingStatus.checking_availability:
      if (mode === 'at_hotel') {
        return ['approve', 'confirm_pay_at_hotel', 'offer_alternatives', 'mark_unavailable', 'cancel'];
      }
      return ['approve', 'hotel_confirmed', 'offer_alternatives', 'mark_unavailable', 'cancel'];
    case BookingStatus.awaiting_payment:
      return ['extend_payment_window', 'mark_unavailable', 'cancel'];
    case BookingStatus.payment_submitted:
      return ['approve', 'verify_payment', 'reject_payment', 'mark_unavailable', 'cancel'];
    case BookingStatus.payment_verified:
      return ['approve', 'confirm_booking', 'mark_unavailable', 'cancel'];
    case BookingStatus.alternatives_offered:
      return ['choose_alternative', 'decline_alternatives', 'cancel'];
    case BookingStatus.refund_pending:
      return ['complete_refund', 'reject_refund', 'cancel'];
    case BookingStatus.confirmed:
      if (mode === 'at_hotel') {
        if (checkInDate && checkInDate <= new Date()) {
          return [];
        }
        return ['cancel'];
      }
      return ['mark_unavailable', 'cancel'];
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
  paymentMode?: PaymentMode;
}

export interface TransitionOutput {
  fromStatus: BookingStatus;
  toStatus: BookingStatus;
  event: BookingCanonicalEventName;
  actorType: ActorType;
  actorId?: string;
  note?: string;
}

export function transition(input: TransitionInput): TransitionOutput {
  const canonicalEvent = normalizeEventName(input.event);
  const mode = input.paymentMode ?? 'online';

  const matchingRule = TRANSITION_RULES.find(
    (r) =>
      r.event === canonicalEvent &&
      r.from.includes(input.currentStatus) &&
      r.allowedActors.includes(input.actorType) &&
      (!r.allowedPaymentModes || r.allowedPaymentModes.includes(mode))
  );

  if (!matchingRule) {
    throw new InvalidTransitionError(
      `Cannot perform event '${input.event}' from status '${input.currentStatus}' by actor '${input.actorType}'${input.paymentMode ? ` for paymentMode '${input.paymentMode}'` : ''}`
    );
  }

  return {
    fromStatus: input.currentStatus,
    toStatus: matchingRule.to,
    event: canonicalEvent,
    actorType: input.actorType,
    actorId: input.actorId,
    note: input.note,
  };
}
