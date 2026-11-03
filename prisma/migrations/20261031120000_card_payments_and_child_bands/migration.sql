-- AlterEnum
ALTER TYPE "PaymentStatus" ADD VALUE 'pending';
ALTER TYPE "PaymentStatus" ADD VALUE 'needs_review';
ALTER TYPE "PaymentStatus" ADD VALUE 'expired';
ALTER TYPE "PaymentStatus" ADD VALUE 'failed';

-- AlterTable
ALTER TABLE "hotels" ADD COLUMN "child_bands_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "external_provider" TEXT,
ADD COLUMN "external_session_id" TEXT,
ADD COLUMN "raw_status" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "payments_external_session_id_key" ON "payments"("external_session_id");

-- CreateTable
CREATE TABLE "payment_events" (
    "id" BIGSERIAL NOT NULL,
    "provider" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_events_provider_event_id_key" ON "payment_events"("provider", "event_id");
