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
import { getPrivateFileStorage } from '../files/private-storage.js';
import {
  assertUploadSize,
  detectMime,
  normalizeUpload,
} from '../files/upload-validation.js';
import { refundNotifier } from '../notifications/refund-notifier.js';
import {
  bookingHasMeaningfulPayment,
  computeRefundEligibility,
  OPEN_REFUND_STATUSES,
} from '../../shared/refund-eligibility.js';
import { settingsService } from '../settings/service.js';
import { stagedUploadService, uploaderKeyFor } from './staged-upload-service.js';
import { submitRefundRequestJson, SubmitRefundJsonInput, SYSTEM_CARD_PREFIX, SYSTEM_CONFIRMATION_PREFIX } from './refund-submit.js';
import { mapCustomerRefundRequest } from './refund-customer-view.js';

export class RefundService {
  async assertBookingAccess(
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

  async computeEligibilityForBooking(booking: {
    id: string;
    status: BookingStatus;
    paymentMode: string;
    payments: { status: string }[];
  }) {
    const openRefund = await this.getOpenRefundForBooking(booking.id);
    const latestRefund = await prisma.refundRequest.findFirst({
      where: { bookingId: booking.id },
      orderBy: { createdAt: 'desc' },
    });
    const hasAny = Boolean(latestRefund);
    return computeRefundEligibility({
      bookingStatus: booking.status,
      paymentMode: booking.paymentMode as any,
      hasOpenRefundRequest: Boolean(openRefund),
      hasAnyRefundRequest: hasAny,
      latestRefundStatus: latestRefund?.status,
      hasVerifiedOrSubmittedPayment: bookingHasMeaningfulPayment(booking.payments as any),
    });
  }

  filterAllowedActions(
    actions: ('report_payment' | 'cancel' | 'request_refund')[],
    eligibility: ReturnType<typeof computeRefundEligibility>
  ) {
    let out = [...actions];
    if (!eligibility.eligible) {
      out = out.filter((a) => a !== 'request_refund');
    }
    return out;
  }

  async stageUpload(
    code: string,
    file: Express.Multer.File,
    token?: string,
    user?: { id: string; role?: string }
  ) {
    const { booking } = await this.assertBookingAccess(code, token, user);
    const key = uploaderKeyFor(user, booking.contactEmail);
    return stagedUploadService.createStagedUpload(booking.id, key, file);
  }

  async deleteStagedUpload(
    code: string,
    uploadId: string,
    token?: string,
    user?: { id: string; role?: string }
  ) {
    const { booking } = await this.assertBookingAccess(code, token, user);
    const key = uploaderKeyFor(user, booking.contactEmail);
    await stagedUploadService.deleteStagedUpload(booking.id, key, uploadId);
  }

  async submitJson(
    code: string,
    input: SubmitRefundJsonInput,
    idempotencyKey: string | undefined,
    token?: string,
    user?: { id: string; role?: string }
  ) {
    const { booking } = await this.assertBookingAccess(code, token, user);
    const eligibility = await this.computeEligibilityForBooking(booking);
    if (!eligibility.eligible) {
      throw new BadRequestError(eligibility.message_key);
    }

    if (idempotencyKey) {
      const existing = await prisma.refundIdempotencyKey.findUnique({
        where: { bookingId_key: { bookingId: booking.id, key: idempotencyKey } },
      });
      if (existing && existing.expiresAt > new Date()) {
        return existing.responseJson as object;
      }
    }

    const open = await this.getOpenRefundForBooking(booking.id);
    if (open) throw new BadRequestError('A refund request is already open for this booking');

    await submitRefundRequestJson(booking, input, { user });

    const response = await this.getRefundRequestForCustomer(code, token, user);

    if (idempotencyKey) {
      await prisma.refundIdempotencyKey.upsert({
        where: { bookingId_key: { bookingId: booking.id, key: idempotencyKey } },
        create: {
          bookingId: booking.id,
          key: idempotencyKey,
          responseJson: response as any,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        update: {
          responseJson: response as any,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
      });
    }

    return response;
  }

  /** Legacy multipart submit (backward compatible). */
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
    const documents = input.document_kinds.map((kind, i) => ({
      slot: (kind === 'payment_proof'
        ? 'payment_proof'
        : kind === 'booking_confirmation'
          ? 'booking_confirmation'
          : 'other') as 'payment_proof' | 'booking_confirmation' | 'other',
      upload_id: undefined as string | undefined,
      reuse: undefined as undefined,
    }));

    const { booking } = await this.assertBookingAccess(code, token, user);
    const uploaderKey = uploaderKeyFor(user, booking.contactEmail);
    const uploadIds: string[] = [];
    for (const file of input.files) {
      const staged = await stagedUploadService.createStagedUpload(booking.id, uploaderKey, file);
      uploadIds.push(staged.upload_id);
    }
    let fileIdx = 0;
    for (const doc of documents) {
      if (doc.slot === 'other' && !input.files.length) continue;
      if (fileIdx < uploadIds.length) {
        doc.upload_id = uploadIds[fileIdx++];
      }
    }

    return this.submitJson(
      code,
      {
        reason: input.reason_code,
        reason_text: input.reason_text,
        destination: {
          method: input.destination_method,
          details: input.destination_details,
        },
        documents: documents.filter((d) => d.upload_id || d.slot !== 'other'),
        accept_cancellation: true,
      },
      undefined,
      token,
      user
    );
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

    const sla = await settingsService.getGlobalCheckoutSettings();
    const reviewHours = sla.refundReviewSlaHours ?? 48;
    return mapCustomerRefundRequest(rr, reviewHours);
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

    if (doc.storageKey.startsWith(SYSTEM_CONFIRMATION_PREFIX)) {
      const { bookingService } = await import('../bookings/service.js');
      const { buffer, filename } = await bookingService.streamConfirmationPdf(code, token, user);
      return {
        data: buffer,
        doc: { ...doc, mimeType: 'application/pdf', originalName: filename },
      };
    }
    if (doc.storageKey.startsWith(SYSTEM_CARD_PREFIX)) {
      const payId = doc.linkedPaymentId || doc.storageKey.slice(SYSTEM_CARD_PREFIX.length);
      const pay = await prisma.payment.findUnique({ where: { id: payId } });
      const payload = Buffer.from(
        JSON.stringify({
          payment_id: pay?.id,
          method: pay?.method,
          reference: pay?.reference,
          status: pay?.status,
          external_session_id: pay?.externalSessionId,
        }),
        'utf8'
      );
      return {
        data: payload,
        doc: { ...doc, mimeType: 'application/json', originalName: 'card-payment-record.json' },
      };
    }

    const data = await getPrivateFileStorage().read(doc.storageKey);
    return { data, doc };
  }
}

export const refundService = new RefundService();
