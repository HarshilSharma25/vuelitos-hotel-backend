-- Refund flow v2: staged uploads, document sources, SLA setting, payment proof, idempotency

CREATE TYPE "RefundDocumentSource" AS ENUM ('uploaded', 'reused_receipt', 'card_record', 'system_confirmation');

ALTER TYPE "RefundDocumentKind" ADD VALUE IF NOT EXISTS 'booking_confirmation';

ALTER TABLE "refund_requests" ADD COLUMN IF NOT EXISTS "public_reference" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "refund_requests_public_reference_key" ON "refund_requests"("public_reference");

ALTER TABLE "refund_documents" ADD COLUMN IF NOT EXISTS "source" "RefundDocumentSource" NOT NULL DEFAULT 'uploaded';
ALTER TABLE "refund_documents" ADD COLUMN IF NOT EXISTS "linked_payment_id" TEXT;
ALTER TABLE "refund_documents" ADD COLUMN IF NOT EXISTS "content_hash" TEXT;
CREATE INDEX IF NOT EXISTS "refund_documents_content_hash_idx" ON "refund_documents"("content_hash");

CREATE TABLE IF NOT EXISTS "refund_staged_uploads" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "uploader_key" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "original_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "refund_staged_uploads_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "refund_idempotency_keys" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "response_json" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "refund_idempotency_keys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "refund_idempotency_keys_booking_id_key_key" ON "refund_idempotency_keys"("booking_id", "key");
CREATE INDEX IF NOT EXISTS "refund_staged_uploads_booking_id_uploader_key_idx" ON "refund_staged_uploads"("booking_id", "uploader_key");
CREATE INDEX IF NOT EXISTS "refund_staged_uploads_expires_at_idx" ON "refund_staged_uploads"("expires_at");
CREATE INDEX IF NOT EXISTS "refund_idempotency_keys_expires_at_idx" ON "refund_idempotency_keys"("expires_at");

ALTER TABLE "refund_staged_uploads" ADD CONSTRAINT "refund_staged_uploads_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE UNIQUE INDEX IF NOT EXISTS "refund_requests_one_open_per_booking"
ON "refund_requests" ("booking_id")
WHERE "status" IN ('submitted', 'in_review', 'needs_info', 'approved');

ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "proof_storage_key" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "proof_content_hash" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "proof_mime_type" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "proof_original_name" TEXT;

ALTER TABLE "checkout_settings" ADD COLUMN IF NOT EXISTS "refund_review_sla_hours" INTEGER NOT NULL DEFAULT 48;
