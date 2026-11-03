import {
  RefundDocumentKind,
  RefundDocumentUploadedBy,
  RefundRequestStatus,
  Role,
} from '@prisma/client';
import { prisma } from '../../lib/prisma.js';
import {
  BadRequestError,
  ForbiddenError,
  InvalidTransitionError,
  NotFoundError,
} from '../../lib/errors.js';
import { decryptRefundPayload } from '../../lib/refund-crypto.js';
import { transition } from '../bookings/state-machine.js';
import { recordBookingTransition } from '../../lib/metrics.js';
import { getPrivateFileStorage } from '../files/private-storage.js';
import {
  assertUploadSize,
  detectMime,
  normalizeUpload,
} from '../files/upload-validation.js';
import { derivePaymentStatus } from '../../lib/payment-status.js';
import { refundNotifier } from '../notifications/refund-notifier.js';

const OPEN_STATUSES: RefundRequestStatus[] = [
  RefundRequestStatus.submitted,
  RefundRequestStatus.in_review,
  RefundRequestStatus.needs_info,
  RefundRequestStatus.approved,
];

export class AdminRefundService {
  async list(filters: {
    status?: string;
    hotelId?: string;
    paymentMethod?: string;
    from?: string;
    to?: string;
    page?: number;
    limit?: number;
  }) {
    const page = Math.max(1, filters.page || 1);
    const take = Math.min(100, Math.max(1, filters.limit || 20));
    const skip = (page - 1) * take;

    const where: any = {};
    if (filters.status && filters.status !== 'all') {
      where.status = filters.status;
    }
    if (filters.from || filters.to) {
      where.createdAt = {};
      if (filters.from) where.createdAt.gte = new Date(filters.from);
      if (filters.to) where.createdAt.lte = new Date(filters.to);
    }
    if (filters.hotelId || filters.paymentMethod) {
      where.booking = {};
      if (filters.hotelId) {
        where.booking.items = { some: { hotelId: filters.hotelId } };
      }
    }

    const [items, total, counts] = await Promise.all([
      prisma.refundRequest.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take,
        include: {
          booking: {
            include: {
              items: true,
              payments: { orderBy: { submittedAt: 'desc' }, take: 1 },
            },
          },
        },
      }),
      prisma.refundRequest.count({ where }),
      prisma.refundRequest.groupBy({
        by: ['status'],
        _count: { _all: true },
      }),
    ]);

    const statusCounts: Record<string, number> = {};
    for (const c of counts) {
      statusCounts[c.status] = c._count._all;
    }

    let mapped = items.map((rr) => {
      const b = rr.booking;
      const pay = b.payments[0];
      return {
        id: rr.id,
        status: rr.status,
        created_at: rr.createdAt.toISOString(),
        booking_code: b.code,
        booking_status: b.status,
        payment_status: derivePaymentStatus({ status: b.status, paymentMode: b.paymentMode }),
        hotel_id: b.items[0]?.hotelId,
        payment_method: pay?.method ?? b.paymentMethodPref,
        contact_name: b.contactName,
        allowed_actions: this.getAllowedActions(rr.status),
      };
    });

    if (filters.paymentMethod) {
      mapped = mapped.filter((m) => m.payment_method === filters.paymentMethod);
    }

    return { items: mapped, total, page, limit: take, status_counts: statusCounts };
  }

  getAllowedActions(status: RefundRequestStatus): string[] {
    switch (status) {
      case RefundRequestStatus.submitted:
      case RefundRequestStatus.in_review:
        return ['request_info', 'approve', 'reject'];
      case RefundRequestStatus.needs_info:
        return ['request_info'];
      case RefundRequestStatus.approved:
        return ['complete'];
      default:
        return [];
    }
  }

  async getDetail(id: string) {
    const rr = await prisma.refundRequest.findUnique({
      where: { id },
      include: {
        booking: {
          include: {
            items: true,
            payments: { orderBy: { submittedAt: 'desc' } },
            events: { orderBy: { createdAt: 'desc' }, take: 20 },
          },
        },
        documents: true,
        events: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!rr) throw new NotFoundError('Refund request not found');

    const destination = decryptRefundPayload<Record<string, unknown>>(rr.destinationDetailsEnc);

    return {
      id: rr.id,
      status: rr.status,
      reason_code: rr.reasonCode,
      reason_text: rr.reasonText,
      destination_method: rr.destinationMethod,
      destination_details: destination,
      staff_message: rr.staffMessage,
      approved_amount: rr.approvedAmount ? Number(rr.approvedAmount) : null,
      approved_currency: rr.approvedCurrency,
      rejection_reason: rr.rejectionReason,
      refund_reference: rr.refundReference,
      allowed_actions: this.getAllowedActions(rr.status),
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
        uploaded_by: d.uploadedBy,
      })),
      booking: {
        code: rr.booking.code,
        status: rr.booking.status,
        payment_status: derivePaymentStatus({
          status: rr.booking.status,
          paymentMode: rr.booking.paymentMode,
        }),
        contact: { name: rr.booking.contactName, email: rr.booking.contactEmail },
        payments: rr.booking.payments.map((p) => ({
          method: p.method,
          currency: p.currency,
          amount: Number(p.amountQuoted),
          status: p.status,
          reference: p.reference,
        })),
        totals_by_method: rr.booking.totalsByMethod,
      },
    };
  }

  async downloadDocument(refundId: string, documentId: string) {
    const doc = await prisma.refundDocument.findFirst({
      where: { id: documentId, refundRequestId: refundId },
    });
    if (!doc) throw new NotFoundError('Document not found');
    const data = await getPrivateFileStorage().read(doc.storageKey);
    return { data, doc };
  }

  private assertRole(role: Role | string, min: 'agent' | 'admin') {
    if (min === 'agent') return;
    if (role === 'agent') throw new ForbiddenError('Admin role required');
  }

  async requestInfo(id: string, actor: { id: string; role: Role }, message: string) {
    this.assertRole(actor.role, 'agent');
    if (!message?.trim()) throw new BadRequestError('Message is required');
    const rr = await prisma.refundRequest.findUnique({ where: { id }, include: { booking: true } });
    if (!rr) throw new NotFoundError('Refund request not found');
    if (!OPEN_STATUSES.includes(rr.status)) {
      throw new BadRequestError('Refund request is not open');
    }

    await prisma.$transaction(async (tx) => {
      await tx.refundRequest.update({
        where: { id },
        data: { status: RefundRequestStatus.needs_info, staffMessage: message.slice(0, 2000) },
      });
      await tx.refundEvent.create({
        data: {
          refundRequestId: id,
          fromStatus: rr.status,
          toStatus: RefundRequestStatus.needs_info,
          actorType: actor.role,
          actorId: actor.id,
          note: message,
        },
      });
    });

    await refundNotifier.queueRefundEvent(rr.booking.code, 'refund.needs_info', {
      recipient: rr.booking.contactEmail,
      name: rr.booking.contactName,
      locale: rr.booking.locale,
      userId: rr.booking.userId,
      staffMessage: message,
    });

    return this.getDetail(id);
  }

  async approve(
    id: string,
    actor: { id: string; role: Role },
    input: { approved_amount: number; approved_currency: string; note?: string }
  ) {
    this.assertRole(actor.role, 'admin');
    const rr = await prisma.refundRequest.findUnique({ where: { id }, include: { booking: true } });
    if (!rr) throw new NotFoundError('Refund request not found');
    if (rr.status !== RefundRequestStatus.submitted && rr.status !== RefundRequestStatus.in_review) {
      throw new BadRequestError('Cannot approve in current status');
    }

    await prisma.$transaction(async (tx) => {
      await tx.refundRequest.update({
        where: { id },
        data: {
          status: RefundRequestStatus.approved,
          approvedAmount: input.approved_amount,
          approvedCurrency: input.approved_currency,
          staffMessage: input.note?.slice(0, 2000) || rr.staffMessage,
        },
      });
      await tx.refundEvent.create({
        data: {
          refundRequestId: id,
          fromStatus: rr.status,
          toStatus: RefundRequestStatus.approved,
          actorType: actor.role,
          actorId: actor.id,
          note: input.note || 'Refund approved',
        },
      });
    });

    await refundNotifier.queueRefundEvent(rr.booking.code, 'refund.approved', {
      recipient: rr.booking.contactEmail,
      name: rr.booking.contactName,
      locale: rr.booking.locale,
      userId: rr.booking.userId,
      approvedAmount: input.approved_amount,
      approvedCurrency: input.approved_currency,
    });

    return this.getDetail(id);
  }

  async reject(id: string, actor: { id: string; role: Role }, reason: string) {
    this.assertRole(actor.role, 'admin');
    if (!reason?.trim()) throw new BadRequestError('Rejection reason is required');

    const rr = await prisma.refundRequest.findUnique({
      where: { id },
      include: { booking: true },
    });
    if (!rr) throw new NotFoundError('Refund request not found');

    const booking = rr.booking;
    if (booking.status !== 'refund_pending') {
      throw new InvalidTransitionError('Booking must be in refund_pending to reject refund');
    }

    const next = transition({
      currentStatus: booking.status,
      event: 'reject_refund',
      actorType: actor.role,
      actorId: actor.id,
      note: reason,
      paymentMode: booking.paymentMode as any,
    });

    await prisma.$transaction(async (tx) => {
      await tx.refundRequest.update({
        where: { id },
        data: { status: RefundRequestStatus.rejected, rejectionReason: reason.slice(0, 2000) },
      });
      await tx.refundEvent.create({
        data: {
          refundRequestId: id,
          fromStatus: rr.status,
          toStatus: RefundRequestStatus.rejected,
          actorType: actor.role,
          actorId: actor.id,
          note: reason,
        },
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
          actorId: actor.id,
          note: next.note,
        },
      });
    });

    recordBookingTransition('reject_refund');

    await refundNotifier.queueRefundEvent(booking.code, 'refund.rejected', {
      recipient: booking.contactEmail,
      name: booking.contactName,
      locale: booking.locale,
      userId: booking.userId,
      rejectionReason: reason,
    });

    return this.getDetail(id);
  }

  async complete(
    id: string,
    actor: { id: string; role: Role },
    input: { refund_reference: string; proofFile?: Express.Multer.File }
  ) {
    this.assertRole(actor.role, 'admin');
    if (!input.refund_reference?.trim()) {
      throw new BadRequestError('refund_reference is required');
    }

    const rr = await prisma.refundRequest.findUnique({
      where: { id },
      include: { booking: true },
    });
    if (!rr) throw new NotFoundError('Refund request not found');

    const hasLegacy = !rr.approvedAmount;
    if (!hasLegacy) {
      if (rr.status !== RefundRequestStatus.approved) {
        throw new BadRequestError('Refund must be approved before completion');
      }
      if (!rr.approvedAmount || !rr.approvedCurrency) {
        throw new BadRequestError('Approved amount and currency are required');
      }
    }

    const booking = rr.booking;
    const next = transition({
      currentStatus: booking.status,
      event: 'complete_refund',
      actorType: actor.role,
      actorId: actor.id,
      paymentMode: booking.paymentMode as any,
    });

    if (input.proofFile) {
      assertUploadSize(input.proofFile.buffer);
      const mime = detectMime(input.proofFile.buffer);
      if (!mime) throw new BadRequestError('Unsupported file type');
      const normalized = await normalizeUpload(input.proofFile.buffer, mime);
      const storage = getPrivateFileStorage();
      const key = await storage.put(normalized.data, {
        ext: mime === 'application/pdf' ? '.pdf' : '.jpg',
      });
      await prisma.refundDocument.create({
        data: {
          refundRequestId: id,
          kind: RefundDocumentKind.completion_proof,
          storageKey: key,
          originalName: input.proofFile.originalname.slice(0, 255),
          mimeType: normalized.mime,
          sizeBytes: normalized.data.length,
          uploadedBy: RefundDocumentUploadedBy.staff,
        },
      });
    }

    await prisma.$transaction(async (tx) => {
      await tx.refundRequest.update({
        where: { id },
        data: {
          status: RefundRequestStatus.completed,
          refundReference: input.refund_reference,
        },
      });
      await tx.refundEvent.create({
        data: {
          refundRequestId: id,
          fromStatus: rr.status,
          toStatus: RefundRequestStatus.completed,
          actorType: actor.role,
          actorId: actor.id,
          note: `Refund completed: ${input.refund_reference}`,
        },
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
          actorId: actor.id,
          note: next.note,
        },
      });
    });

    recordBookingTransition('complete_refund');

    await refundNotifier.queueRefundEvent(booking.code, 'refund.completed', {
      recipient: booking.contactEmail,
      name: booking.contactName,
      locale: booking.locale,
      userId: booking.userId,
      refundReference: input.refund_reference,
      approvedAmount: rr.approvedAmount ? Number(rr.approvedAmount) : undefined,
      approvedCurrency: rr.approvedCurrency || undefined,
    });

    return this.getDetail(id);
  }

  async assertCompleteRefundAllowed(bookingId: string) {
    const open = await prisma.refundRequest.findFirst({
      where: { bookingId, status: { in: OPEN_STATUSES } },
    });
    if (!open) {
      return null;
    }
    if (open.status !== RefundRequestStatus.approved) {
      throw new BadRequestError(
        'An open refund request must be approved before completing the refund'
      );
    }
    if (!open.approvedAmount || !open.approvedCurrency) {
      throw new BadRequestError('Approved amount and currency are required');
    }
    return open;
  }
}

export const adminRefundService = new AdminRefundService();
