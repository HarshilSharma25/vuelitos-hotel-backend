import {
  BookingStatus,
  PaymentMethod,
  RefundDocumentKind,
  RefundDocumentUploadedBy,
  RefundReasonCode,
  RefundRequestStatus,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  BadRequestError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from '../../lib/errors.js';
import { verifyAccessToken } from '../../lib/ids.js';
import {
  decryptRefundPayload,
  encryptRefundPayload,
  maskDestinationForList,
} from '../../lib/refund-crypto.js';
import { transition } from '../bookings/state-machine.js';
import { recordBookingTransition } from '../../lib/metrics.js';
import { getPrivateFileStorage } from '../files/private-storage.js';
import {
  assertUploadSize,
  detectMime,
  normalizeUpload,
} from '../files/upload-validation.js';
import { refundNotifier } from '../notifications/refund-notifier.js';

const MANUAL_PAYMENT_METHODS: PaymentMethod[] = [
  PaymentMethod.pago_movil,
  PaymentMethod.bs_transfer,
  PaymentMethod.zelle,
  PaymentMethod.usdt_binance,
];

const OPEN_REFUND_STATUSES: RefundRequestStatus[] = [
  RefundRequestStatus.submitted,
  RefundRequestStatus.in_review,
  RefundRequestStatus.needs_info,
  RefundRequestStatus.approved,
];

export class RefundService {
  private async assertBookingAccess(
    code: string,
    token?: string,
    user?: { id: string; role?: string }
  ) {
    const booking = await prisma.booking.findUnique({
      where: { code },
      include: { payments: { orderBy: { submittedAt: 'desc' } } },
    });
    if (!booking) throw new NotFoundError('Booking not found');

    const hasToken = token ? verifyAccessToken(token, booking.accessKey) : false;
    let isOwner = false;
    let isStaff = false;
    if (user) {
      if (booking.userId && String(booking.userId) === String(user.id)) isOwner = true;
      const roleStr = String(user.role || '').toLowerCase();
      if (roleStr.includes('admin') || roleStr.includes('agent') || roleStr.includes('super')) {
        isStaff = true;
      }
    }
    if (booking.userId && user && !isOwner && !isStaff) {
      throw new ForbiddenError('Access forbidden to this booking');
    }
    if (!hasToken && !isOwner && !isStaff) {
      throw new NotFoundError('Booking not found');
    }
    return { booking, isOwner, isStaff };
  }

  async getOpenRefundForBooking(bookingId: string) {
    return prisma.refundRequest.findFirst({
      where: {
        bookingId,
        status: { in: OPEN_REFUND_STATUSES },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createRefundRequest(
    code: string,
    input: {
      reason_code: RefundReasonCode;
      reason_text?: string;
      destination_method: string;
      destination_details: Record<string, unknown>;
      files: Express.Multer.File[];
      document_kinds: string[];
    },
    token?: string,
    user?: { id: string; role?: string }
  ) {
    const { booking } = await this.assertBookingAccess(code, token, user);

    if (booking.paymentMode === 'at_hotel') {
      throw new BadRequestError('Refunds are not available for pay-at-hotel bookings');
    }

    const existingOpen = await this.getOpenRefundForBooking(booking.id);
    const needsCancelTransition =
      booking.status === BookingStatus.payment_submitted ||
      booking.status === BookingStatus.payment_verified ||
      booking.status === BookingStatus.confirmed;

    if (booking.status === BookingStatus.refund_pending && existingOpen) {
      throw new BadRequestError('A refund request is already open for this booking');
    }
    if (needsCancelTransition) {
    } else if (booking.status === BookingStatus.refund_pending && !existingOpen) {
    } else {
      throw new InvalidTransitionError('Cannot request refund from current booking status');
    }

    const paidMethod =
      booking.payments.find((p) => p.status === 'verified')?.method ||
      booking.paymentMethodPref ||
      booking.payments[0]?.method;

    const requiresProof =
      paidMethod && MANUAL_PAYMENT_METHODS.includes(paidMethod as PaymentMethod);
    const kinds = input.document_kinds || [];
    if (requiresProof && !kinds.includes('payment_proof')) {
      throw new BadRequestError('Payment proof document is required for this payment method');
    }

    if (input.files.length > 5) {
      throw new BadRequestError('Maximum 5 files per request');
    }

    const enc = encryptRefundPayload(input.destination_details);
    const requestedBy = user?.id || booking.contactEmail;

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
      }

      const rr = await tx.refundRequest.create({
        data: {
          bookingId: booking.id,
          status: RefundRequestStatus.submitted,
          reasonCode: input.reason_code,
          reasonText: input.reason_text?.slice(0, 1000) || null,
          requestedBy,
          destinationMethod: input.destination_method,
          destinationDetailsEnc: enc,
        },
      });

      await tx.refundEvent.create({
        data: {
          refundRequestId: rr.id,
          fromStatus: null,
          toStatus: RefundRequestStatus.submitted,
          actorType: 'customer',
          actorId: user?.id || null,
          note: 'Refund request submitted',
        },
      });

      return rr;
    });

    recordBookingTransition('cancel');

    const storage = getPrivateFileStorage();
    for (let i = 0; i < input.files.length; i++) {
      const file = input.files[i];
      assertUploadSize(file.buffer);
      const mime = detectMime(file.buffer);
      if (!mime) throw new BadRequestError('Unsupported file type');
      const normalized = await normalizeUpload(file.buffer, mime);
      await storage.scanHook('', normalized.data);
      const ext =
        normalized.mime === 'application/pdf'
          ? '.pdf'
          : normalized.mime === 'image/png'
            ? '.png'
            : '.jpg';
      const key = await storage.put(normalized.data, { ext });
      const kind = (kinds[i] as RefundDocumentKind) || RefundDocumentKind.other;
      await prisma.refundDocument.create({
        data: {
          refundRequestId: refundRequest.id,
          kind,
          storageKey: key,
          originalName: file.originalname.slice(0, 255),
          mimeType: normalized.mime,
          sizeBytes: normalized.data.length,
          uploadedBy: RefundDocumentUploadedBy.customer,
        },
      });
    }

    await refundNotifier.queueRefundEvent(booking.code, 'refund.request_received', {
      recipient: booking.contactEmail,
      name: booking.contactName,
      locale: booking.locale,
      userId: booking.userId,
    });

    return this.getRefundRequestForCustomer(code, token, user);
  }

  async getRefundRequestForCustomer(code: string, token?: string, user?: { id: string; role?: string }) {
    const { booking } = await this.assertBookingAccess(code, token, user);
    const rr = await prisma.refundRequest.findFirst({
      where: { bookingId: booking.id },
      orderBy: { createdAt: 'desc' },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        documents: true,
      },
    });
    if (!rr) {
      return { status: 'none' as const };
    }

    const dest = maskDestinationForList(
      decryptRefundPayload<Record<string, unknown>>(rr.destinationDetailsEnc)
    );

    return {
      id: rr.id,
      status: rr.status,
      reason_code: rr.reasonCode,
      reason_text: rr.reasonText,
      destination_method: rr.destinationMethod,
      destination_details_masked: dest,
      staff_message: rr.staffMessage,
      approved_amount: rr.approvedAmount ? Number(rr.approvedAmount) : null,
      approved_currency: rr.approvedCurrency,
      rejection_reason: rr.rejectionReason,
      refund_reference:
        rr.status === RefundRequestStatus.completed ? rr.refundReference : null,
      timeline: rr.events.map((e) => ({
        at: e.createdAt.toISOString(),
        from_status: e.fromStatus,
        to_status: e.toStatus,
        actor_type: e.actorType,
        note: e.note,
      })),
      documents: rr.documents.map((d) => ({
        id: d.id,
        kind: d.kind,
        original_name: d.originalName,
        mime_type: d.mimeType,
        size_bytes: d.sizeBytes,
        created_at: d.createdAt.toISOString(),
      })),
    };
  }

  async addDocuments(
    code: string,
    files: Express.Multer.File[],
    kinds: string[],
    token?: string,
    user?: { id: string; role?: string }
  ) {
    const { booking } = await this.assertBookingAccess(code, token, user);
    const rr = await this.getOpenRefundForBooking(booking.id);
    if (!rr || rr.status !== RefundRequestStatus.needs_info) {
      throw new BadRequestError('Documents can only be added when more information is needed');
    }
    if (files.length > 5) throw new BadRequestError('Maximum 5 files per request');

    const storage = getPrivateFileStorage();
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      assertUploadSize(file.buffer);
      const mime = detectMime(file.buffer);
      if (!mime) throw new BadRequestError('Unsupported file type');
      const normalized = await normalizeUpload(file.buffer, mime);
      await storage.scanHook('', normalized.data);
      const ext =
        normalized.mime === 'application/pdf'
          ? '.pdf'
          : normalized.mime === 'image/png'
            ? '.png'
            : '.jpg';
      const key = await storage.put(normalized.data, { ext });
      await prisma.refundDocument.create({
        data: {
          refundRequestId: rr.id,
          kind: (kinds[i] as RefundDocumentKind) || RefundDocumentKind.other,
          storageKey: key,
          originalName: file.originalname.slice(0, 255),
          mimeType: normalized.mime,
          sizeBytes: normalized.data.length,
          uploadedBy: RefundDocumentUploadedBy.customer,
        },
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.refundRequest.update({
        where: { id: rr.id },
        data: { status: RefundRequestStatus.in_review },
      });
      await tx.refundEvent.create({
        data: {
          refundRequestId: rr.id,
          fromStatus: RefundRequestStatus.needs_info,
          toStatus: RefundRequestStatus.in_review,
          actorType: 'customer',
          actorId: user?.id || null,
          note: 'Customer uploaded additional documents',
        },
      });
    });

    return this.getRefundRequestForCustomer(code, token, user);
  }

  async downloadDocument(
    code: string,
    documentId: string,
    token?: string,
    user?: { id: string; role?: string }
  ) {
    const { booking } = await this.assertBookingAccess(code, token, user);
    const doc = await prisma.refundDocument.findFirst({
      where: {
        id: documentId,
        refundRequest: { bookingId: booking.id },
      },
    });
    if (!doc) throw new NotFoundError('Document not found');
    const data = await getPrivateFileStorage().read(doc.storageKey);
    return { data, doc };
  }

  filterAllowedActions(
    actions: ('report_payment' | 'cancel' | 'request_refund')[],
    bookingStatus: BookingStatus,
    hasOpenRefund: boolean
  ) {
    if (bookingStatus === BookingStatus.refund_pending && hasOpenRefund) {
      return actions.filter((a) => a !== 'request_refund');
    }
    return actions;
  }
}

export const refundService = new RefundService();
