-- CreateEnum
CREATE TYPE "RefundRequestStatus" AS ENUM ('submitted', 'in_review', 'needs_info', 'approved', 'rejected', 'completed');

-- CreateEnum
CREATE TYPE "RefundReasonCode" AS ENUM ('change_of_plans', 'found_better_option', 'travel_cancelled', 'medical', 'duplicate_booking', 'hotel_issue', 'other');

-- CreateEnum
CREATE TYPE "RefundDocumentKind" AS ENUM ('payment_proof', 'id_document', 'other', 'completion_proof');

-- CreateEnum
CREATE TYPE "RefundDocumentUploadedBy" AS ENUM ('customer', 'staff');

-- CreateTable
CREATE TABLE "refund_requests" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "status" "RefundRequestStatus" NOT NULL DEFAULT 'submitted',
    "reason_code" "RefundReasonCode" NOT NULL,
    "reason_text" VARCHAR(1000),
    "requested_by" TEXT NOT NULL,
    "destination_method" TEXT NOT NULL,
    "destination_details_enc" TEXT NOT NULL,
    "approved_amount" DECIMAL(12,2),
    "approved_currency" TEXT,
    "staff_message" VARCHAR(2000),
    "rejection_reason" VARCHAR(2000),
    "refund_reference" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_documents" (
    "id" TEXT NOT NULL,
    "refund_request_id" TEXT NOT NULL,
    "kind" "RefundDocumentKind" NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "uploaded_by" "RefundDocumentUploadedBy" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refund_events" (
    "id" BIGSERIAL NOT NULL,
    "refund_request_id" TEXT NOT NULL,
    "from_status" "RefundRequestStatus",
    "to_status" "RefundRequestStatus" NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "refund_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "refund_requests_booking_id_idx" ON "refund_requests"("booking_id");

-- CreateIndex
CREATE INDEX "refund_requests_status_created_at_idx" ON "refund_requests"("status", "created_at");

-- CreateIndex
CREATE INDEX "refund_documents_refund_request_id_idx" ON "refund_documents"("refund_request_id");

-- AddForeignKey
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_documents" ADD CONSTRAINT "refund_documents_refund_request_id_fkey" FOREIGN KEY ("refund_request_id") REFERENCES "refund_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refund_events" ADD CONSTRAINT "refund_events_refund_request_id_fkey" FOREIGN KEY ("refund_request_id") REFERENCES "refund_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One open refund request per booking (partial unique index)
CREATE UNIQUE INDEX "refund_requests_one_open_per_booking" ON "refund_requests" ("booking_id")
WHERE "status" NOT IN ('rejected', 'completed');
