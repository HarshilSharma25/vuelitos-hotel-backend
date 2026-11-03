-- CreateEnum
CREATE TYPE "PaymentMode" AS ENUM ('online', 'at_hotel');

-- AlterTable
ALTER TABLE "hotels" ADD COLUMN "pay_now_enabled" BOOLEAN,
ADD COLUMN "pay_at_hotel_enabled" BOOLEAN,
ADD COLUMN "payment_window_hours" INTEGER,
ADD COLUMN "reminder_offsets_pct" JSONB,
ADD COLUMN "auto_confirm_after_payment" BOOLEAN;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "payment_mode" "PaymentMode" NOT NULL DEFAULT 'online',
ADD COLUMN "payment_window_hours" INTEGER,
ADD COLUMN "reminders_sent" INTEGER[] DEFAULT ARRAY[]::INTEGER[];

-- AlterTable
ALTER TABLE "payments" ADD COLUMN "amount_received" DECIMAL(12, 2),
ADD COLUMN "rejection_reason" TEXT,
ADD COLUMN "rejection_notes" TEXT;

-- CreateTable
CREATE TABLE "checkout_settings" (
    "id" TEXT NOT NULL DEFAULT 'global',
    "pay_now_enabled" BOOLEAN NOT NULL DEFAULT true,
    "pay_at_hotel_enabled" BOOLEAN NOT NULL DEFAULT true,
    "card_payments_enabled" BOOLEAN NOT NULL DEFAULT true,
    "payment_window_hours" INTEGER NOT NULL DEFAULT 48,
    "reminder_offsets_pct" INTEGER[] DEFAULT ARRAY[50, 90]::INTEGER[],
    "auto_confirm_after_payment" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "checkout_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings_audit" (
    "id" TEXT NOT NULL,
    "setting_type" TEXT NOT NULL,
    "target_id" TEXT,
    "old_value" JSONB NOT NULL,
    "new_value" JSONB NOT NULL,
    "actor_id" TEXT NOT NULL,
    "actor_type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "settings_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "settings_audit_setting_type_target_id_idx" ON "settings_audit"("setting_type", "target_id");
