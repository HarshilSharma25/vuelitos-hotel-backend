import {
  BookingStatus,
  PaymentMethod,
  Prisma,
  RefundDocumentKind,
  RefundDocumentSource,
  RefundDocumentUploadedBy,
  RefundReasonCode,
  RefundRequestStatus,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import { BadRequestError, InvalidTransitionError } from '../../lib/errors.js';
import { transition } from '../bookings/state-machine.js';
import { recordBookingTransition } from '../../lib/metrics.js';
import { encryptRefundPayload } from '../../lib/refund-crypto.js';
import { allocateRefundPublicReference } from '../../lib/refund-reference.js';
import { validateRefundDestination } from './refund-destination.js';
import { stagedUploadService, uploaderKeyFor } from './staged-upload-service.js';
import { refundNotifier } from '../notifications/refund-notifier.js';
import { settingsService } from '../settings/service.js';

export type RefundDocumentInput = {
  slot: 'payment_proof' | 'booking_confirmation' | 'other';
  upload_id?: string;
  reuse?: 'payment_receipt' | 'card_record' | 'vuelitos_confirmation';
};

export type SubmitRefundJsonInput = {
  reason: RefundReasonCode;
  reason_text?: string;
  destination: { method: string; details: Record<string, unknown> };
  documents: RefundDocumentInput[];
  accept_cancellation: boolean;
};

type PaymentRow = {
  id: string;
  method: PaymentMethod;
  status: string;
  proofStorageKey: string | null;
  proofContentHash: string | null;
  proofMimeType: string | null;
  proofOriginalName: string | null;
};

const SYSTEM_CONFIRMATION_PREFIX = 'system:confirmation:';
const SYSTEM_CARD_PREFIX = 'system:card:';

export async function submitRefundRequestJson(
  booking: {
    id: string;
    code: string;
    status: BookingStatus;
    contactEmail: string;
    contactName: string;
    locale: string;
    userId: string | null;
    payments: PaymentRow[];
  },
  input: SubmitRefundJsonInput,
  actor: { user?: { id: string } }
) {
  if (!input.accept_cancellation) {
    throw new BadRequestError('accept_cancellation must be true');
  }
  if (!Object.values(RefundReasonCode).includes(input.reason)) {
    throw new BadRequestError('Invalid reason');
  }

  const uploaderKey = uploaderKeyFor(actor.user, booking.contactEmail);
  const paid =
    booking.payments.find((p) => p.status === 'verified') ||
    booking.payments.find((p) => p.status === 'submitted') ||
    booking.payments[0];
  const paidMethod = paid?.method;

  validateRefundDestination(input.destination.method, input.destination.details, paidMethod);

  const docRows = await resolveRefundDocuments(
    booking.id,
    uploaderKey,
    input.documents,
    paidMethod,
    booking.payments
  );

  const needsCancelTransition =
    booking.status === BookingStatus.payment_submitted ||
    booking.status === BookingStatus.payment_verified ||
    booking.status === BookingStatus.confirmed;

  const enc = encryptRefundPayload(input.destination.details);
  const requestedBy = actor.user?.id || booking.contactEmail;
  const publicReference = await allocateRefundPublicReference();
  const sla = await settingsService.getGlobalCheckoutSettings();
  const reviewHours = sla.refundReviewSlaHours ?? 48;

  const refundRequest = await prisma.$transaction(async (tx) => {
    if (needsCancelTransition) {
      const next = transition({
        currentStatus: booking.status,
        event: 'cancel',
        actorType: 'customer',
        paymentMode: 'online',
        note: 'Cancelación con solicitud de reembolso',
      });
      const updated = await tx.booking.updateMany({
        where: { id: booking.id, status: next.fromStatus },
        data: { status: next.toStatus },
      });
      if (updated.count === 0) throw new InvalidTransitionError('State transition conflict');
      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          event: next.event,
          fromStatus: next.fromStatus,
          toStatus: next.toStatus,
          actorType: next.actorType,
          note: next.note,
        },
      });
    } else if (booking.status !== BookingStatus.refund_pending) {
      throw new InvalidTransitionError('Cannot request refund from current booking status');
    }

    const rr = await tx.refundRequest.create({
      data: {
        bookingId: booking.id,
        status: RefundRequestStatus.submitted,
        publicReference,
        reasonCode: input.reason,
        reasonText: input.reason_text?.slice(0, 1000) || null,
        requestedBy,
        destinationMethod: input.destination.method,
        destinationDetailsEnc: enc,
      },
    });

    await tx.refundEvent.create({
      data: {
        refundRequestId: rr.id,
        fromStatus: null,
        toStatus: RefundRequestStatus.submitted,
        actorType: 'customer',
        actorId: actor.user?.id || null,
        note: 'Refund request submitted',
      },
    });

    for (const doc of docRows) {
      await tx.refundDocument.create({
        data: { refundRequestId: rr.id, ...doc },
      });
    }

    return rr;
  });

  recordBookingTransition('cancel');

  await refundNotifier.queueRefundEvent(booking.code, 'refund.request_received', {
    recipient: booking.contactEmail,
    name: booking.contactName,
    locale: booking.locale,
    userId: booking.userId,
    refundReference: publicReference,
  });

  return { refundRequest, reviewHours, publicReference };
}

async function resolveRefundDocuments(
  bookingId: string,
  uploaderKey: string,
  documents: RefundDocumentInput[],
  paidMethod: PaymentMethod | undefined,
  payments: PaymentRow[]
): Promise<Prisma.RefundDocumentUncheckedCreateWithoutRefundRequestInput[]> {
  const others = documents.filter((d) => d.slot === 'other');
  if (others.length > 3) throw new BadRequestError('Maximum 3 optional documents');
  if (documents.filter((d) => d.slot === 'payment_proof').length !== 1) {
    throw new BadRequestError('Exactly one payment_proof slot is required');
  }
  if (documents.filter((d) => d.slot === 'booking_confirmation').length !== 1) {
    throw new BadRequestError('Exactly one booking_confirmation slot is required');
  }
  if (documents.length > 6) throw new BadRequestError('Maximum 6 documents per request');

  const out: Prisma.RefundDocumentUncheckedCreateWithoutRefundRequestInput[] = [];

  for (const doc of documents) {
    const kind =
      doc.slot === 'payment_proof'
        ? RefundDocumentKind.payment_proof
        : doc.slot === 'booking_confirmation'
          ? RefundDocumentKind.booking_confirmation
          : RefundDocumentKind.other;

    if (doc.reuse === 'payment_receipt') {
      const pay =
        payments.find((p) => p.proofStorageKey) ||
        payments.find((p) => p.status === 'verified' || p.status === 'submitted');
      if (!pay?.proofStorageKey) {
        throw new BadRequestError('No payment receipt available to reuse');
      }
      out.push({
        kind,
        source: RefundDocumentSource.reused_receipt,
        storageKey: pay.proofStorageKey,
        linkedPaymentId: pay.id,
        contentHash: pay.proofContentHash,
        originalName: pay.proofOriginalName || 'payment-receipt',
        mimeType: pay.proofMimeType || 'application/octet-stream',
        sizeBytes: 0,
        uploadedBy: RefundDocumentUploadedBy.customer,
      });
      continue;
    }

    if (doc.reuse === 'card_record') {
      const pay = payments.find((p) => p.method === PaymentMethod.stripe_card);
      if (!pay) throw new BadRequestError('No card payment record for this booking');
      out.push({
        kind,
        source: RefundDocumentSource.card_record,
        storageKey: `${SYSTEM_CARD_PREFIX}${pay.id}`,
        linkedPaymentId: pay.id,
        contentHash: null,
        originalName: 'Stripe card payment record',
        mimeType: 'application/json',
        sizeBytes: 0,
        uploadedBy: RefundDocumentUploadedBy.customer,
      });
      continue;
    }

    if (doc.reuse === 'vuelitos_confirmation') {
      out.push({
        kind,
        source: RefundDocumentSource.system_confirmation,
        storageKey: `${SYSTEM_CONFIRMATION_PREFIX}${bookingId}`,
        contentHash: null,
        originalName: 'Vuelitos booking confirmation',
        mimeType: 'application/pdf',
        sizeBytes: 0,
        uploadedBy: RefundDocumentUploadedBy.customer,
      });
      continue;
    }

    if (!doc.upload_id) {
      throw new BadRequestError(`Missing upload for slot ${doc.slot}`);
    }

    const staged = await stagedUploadService.consumeStagedUpload(
      bookingId,
      uploaderKey,
      doc.upload_id
    );
    out.push({
      kind,
      source: RefundDocumentSource.uploaded,
      storageKey: staged.storageKey,
      contentHash: staged.contentHash,
      originalName: staged.originalName,
      mimeType: staged.mimeType,
      sizeBytes: staged.sizeBytes,
      uploadedBy: RefundDocumentUploadedBy.customer,
    });
  }

  if (
    paidMethod &&
    paidMethod !== PaymentMethod.stripe_card &&
    !out.some((d) => d.kind === RefundDocumentKind.payment_proof)
  ) {
    throw new BadRequestError('Payment proof is required');
  }

  return out;
}

export { SYSTEM_CONFIRMATION_PREFIX, SYSTEM_CARD_PREFIX };
