import {
  RefundDocumentKind,
  RefundDocumentSource,
  RefundRequestStatus,
} from '@prisma/client';
import {
  decryptRefundPayload,
  maskDestinationForList,
} from '../../lib/refund-crypto.js';

export function buildRequiredSlots(
  documents: {
    kind: string;
    source: RefundDocumentSource;
  }[]
) {
  const hasProof = documents.some((d) => d.kind === RefundDocumentKind.payment_proof);
  const hasConfirmation = documents.some((d) => d.kind === RefundDocumentKind.booking_confirmation);
  return [
    {
      slot: 'payment_proof' as const,
      satisfied: hasProof,
      source: documents.find((d) => d.kind === RefundDocumentKind.payment_proof)?.source || null,
    },
    {
      slot: 'booking_confirmation' as const,
      satisfied: hasConfirmation,
      source:
        documents.find((d) => d.kind === RefundDocumentKind.booking_confirmation)?.source || null,
    },
  ];
}

export function mapCustomerRefundRequest(
  rr: {
    id: string;
    status: RefundRequestStatus;
    publicReference: string | null;
    reasonCode: string;
    reasonText: string | null;
    destinationMethod: string;
    destinationDetailsEnc: string;
    staffMessage: string | null;
    approvedAmount: { toNumber?: () => number } | null;
    approvedCurrency: string | null;
    rejectionReason: string | null;
    refundReference: string | null;
    events: {
      createdAt: Date;
      fromStatus: RefundRequestStatus | null;
      toStatus: RefundRequestStatus;
      actorType: string;
      note: string | null;
    }[];
    documents: {
      id: string;
      kind: string;
      source: RefundDocumentSource;
      originalName: string;
      mimeType: string;
      sizeBytes: number;
      createdAt: Date;
    }[];
  },
  reviewHours: number
) {
  const dest = maskDestinationForList(
    decryptRefundPayload<Record<string, unknown>>(rr.destinationDetailsEnc)
  );

  return {
    id: rr.id,
    reference: rr.publicReference,
    status: rr.status,
    reason_code: rr.reasonCode,
    reason_text: rr.reasonText,
    destination_method: rr.destinationMethod,
    destination_details_masked: dest,
    staff_message: rr.status === RefundRequestStatus.needs_info ? rr.staffMessage : null,
    approved_amount: rr.approvedAmount ? Number(rr.approvedAmount) : null,
    approved_currency: rr.approvedCurrency,
    rejection_reason: rr.rejectionReason,
    refund_reference:
      rr.status === RefundRequestStatus.completed ? rr.refundReference : null,
    review_expectation_hours: reviewHours,
    required_slots: buildRequiredSlots(rr.documents),
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
      source: d.source,
      original_name: d.originalName,
      mime_type: d.mimeType,
      size_bytes: d.sizeBytes,
      created_at: d.createdAt.toISOString(),
    })),
  };
}
