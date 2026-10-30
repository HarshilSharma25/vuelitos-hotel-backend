-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('requested', 'checking_availability', 'awaiting_payment', 'payment_submitted', 'payment_verified', 'confirmed', 'alternatives_offered', 'unavailable', 'cancelled', 'refund_pending', 'refunded');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('stripe_card', 'pago_movil', 'bs_transfer', 'zelle', 'usdt_binance', 'cash_usd', 'cash_eur');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('USD', 'EUR');

-- CreateEnum
CREATE TYPE "AvailabilityMode" AS ENUM ('manual', 'api');

-- CreateEnum
CREATE TYPE "RateConcept" AS ENUM ('OCUPACION', 'NINO', 'PAX_ADICIONAL');

-- CreateEnum
CREATE TYPE "PriceKind" AS ENUM ('IMPORTE', 'BAJO_PEDIDO', 'GRATIS', 'PORCENTAJE_ADULTO');

-- CreateEnum
CREATE TYPE "PricingUnit" AS ENUM ('per_room', 'per_person');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('agent', 'admin', 'super_admin');

-- CreateEnum
CREATE TYPE "RateSource" AS ENUM ('auto', 'manual');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('submitted', 'verified', 'rejected', 'refunded');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('pending', 'available', 'unavailable', 'on_request');

-- CreateEnum
CREATE TYPE "ImageStatus" AS ENUM ('held', 'published');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('draft', 'sent', 'accepted', 'declined', 'expired');

-- CreateTable
CREATE TABLE "hotels" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "destination" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "star_rating" INTEGER,
    "base_currency" "Currency" NOT NULL,
    "is_solo_divisas" BOOLEAN NOT NULL DEFAULT false,
    "default_commission_percent" DECIMAL(5,2) NOT NULL DEFAULT 10.00,
    "availability_mode" "AvailabilityMode" NOT NULL DEFAULT 'manual',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,

    CONSTRAINT "hotels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_types" (
    "id" TEXT NOT NULL,
    "hotel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "max_occupancy" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "seasons" (
    "id" TEXT NOT NULL,
    "hotel_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "priority" INTEGER NOT NULL,
    "date_from" DATE NOT NULL,
    "date_to" DATE NOT NULL,
    "booking_from" DATE,
    "booking_to" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "seasons_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rates" (
    "id" TEXT NOT NULL,
    "room_type_id" TEXT NOT NULL,
    "season_id" TEXT NOT NULL,
    "meal_plan" TEXT NOT NULL,
    "concept" "RateConcept",
    "price_kind" "PriceKind" NOT NULL,
    "occupancy" INTEGER,
    "pricing_unit" "PricingUnit" NOT NULL,
    "net_rate" DECIMAL(12,2) NOT NULL,
    "markup_percent" DECIMAL(5,2),
    "sell_rate" DECIMAL(12,2),
    "percent_of_adult" DECIMAL(5,2),
    "child_age_min" INTEGER,
    "child_age_max" INTEGER,
    "days_of_week" INTEGER[],
    "min_nights" INTEGER NOT NULL DEFAULT 1,
    "max_nights" INTEGER,
    "package_nights" INTEGER,
    "source_page" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" BIGSERIAL NOT NULL,
    "bcv_usd" DECIMAL(12,4) NOT NULL,
    "bcv_eur" DECIMAL(12,4) NOT NULL,
    "binance_usdt" DECIMAL(12,4) NOT NULL,
    "bcv_usd_source" TEXT NOT NULL,
    "bcv_eur_source" TEXT NOT NULL,
    "usdt_source" TEXT NOT NULL,
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fetched_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "bcv_value_date" DATE NOT NULL,
    "source" "RateSource" NOT NULL DEFAULT 'auto',
    "is_manual_override" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bcv_published_rates" (
    "value_date" DATE NOT NULL,
    "usd" DECIMAL(12,4) NOT NULL,
    "eur" DECIMAL(12,4) NOT NULL,
    "published_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bcv_published_rates_pkey" PRIMARY KEY ("value_date")
);

-- CreateTable
CREATE TABLE "hotel_payment_tax_rules" (
    "hotel_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "iva_rate" DECIMAL(5,4) NOT NULL,
    "surcharge_percent" DECIMAL(5,2),

    CONSTRAINT "hotel_payment_tax_rules_pkey" PRIMARY KEY ("hotel_id","method")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'requested',
    "access_key" UUID NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'es',
    "contact_name" TEXT NOT NULL,
    "contact_email" TEXT NOT NULL,
    "contact_phone" TEXT,
    "notes" TEXT,
    "payment_method_pref" "PaymentMethod",
    "terms_accepted_at" TIMESTAMP(3) NOT NULL,
    "totals_by_method" JSONB NOT NULL,
    "fx_snapshot" JSONB NOT NULL,
    "sla_due_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_items" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'hotel_stay',
    "hotel_id" TEXT NOT NULL,
    "check_in" DATE NOT NULL,
    "check_out" DATE NOT NULL,
    "meal_plan" TEXT NOT NULL,
    "room_selections" JSONB NOT NULL,
    "price_snapshot" JSONB NOT NULL,

    CONSTRAINT "booking_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "booking_events" (
    "id" BIGSERIAL NOT NULL,
    "booking_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "from_status" "BookingStatus",
    "to_status" "BookingStatus" NOT NULL,
    "actor_type" TEXT NOT NULL,
    "actor_id" TEXT,
    "note" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "currency" TEXT NOT NULL,
    "amount_quoted" DECIMAL(12,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'submitted',
    "submitted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "verified_at" TIMESTAMP(3),
    "verified_by" TEXT,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_checks" (
    "id" TEXT NOT NULL,
    "booking_id" TEXT,
    "hotel_id" TEXT NOT NULL,
    "check_in" DATE NOT NULL,
    "check_out" DATE NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'pending',
    "checked_by" TEXT,
    "checked_at" TIMESTAMP(3),
    "note" TEXT,

    CONSTRAINT "availability_checks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hotel_images" (
    "id" TEXT NOT NULL,
    "hotel_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "source_url" TEXT,
    "source_kind" TEXT,
    "status" "ImageStatus" NOT NULL DEFAULT 'held',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "alt" TEXT,

    CONSTRAINT "hotel_images_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "token_key" UUID NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'draft',
    "lines" JSONB NOT NULL,
    "commission_percent" DECIMAL(5,2) NOT NULL,
    "commission_amount" DECIMAL(12,2) NOT NULL,
    "internal_notes" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'agent',

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("date")
);

-- CreateIndex
CREATE UNIQUE INDEX "hotels_slug_key" ON "hotels"("slug");

-- CreateIndex
CREATE INDEX "hotels_destination_is_active_idx" ON "hotels"("destination", "is_active");

-- CreateIndex
CREATE INDEX "exchange_rates_recorded_at_idx" ON "exchange_rates"("recorded_at");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_code_key" ON "bookings"("code");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_code_key" ON "quotes"("code");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");

-- AddForeignKey
ALTER TABLE "room_types" ADD CONSTRAINT "room_types_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "seasons" ADD CONSTRAINT "seasons_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rates" ADD CONSTRAINT "rates_room_type_id_fkey" FOREIGN KEY ("room_type_id") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rates" ADD CONSTRAINT "rates_season_id_fkey" FOREIGN KEY ("season_id") REFERENCES "seasons"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotel_payment_tax_rules" ADD CONSTRAINT "hotel_payment_tax_rules_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_items" ADD CONSTRAINT "booking_items_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "booking_events" ADD CONSTRAINT "booking_events_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_checks" ADD CONSTRAINT "availability_checks_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_checks" ADD CONSTRAINT "availability_checks_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hotel_images" ADD CONSTRAINT "hotel_images_hotel_id_fkey" FOREIGN KEY ("hotel_id") REFERENCES "hotels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "staff_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Raw SQL from spec
CREATE SEQUENCE booking_code_seq;
CREATE UNIQUE INDEX rates_unica_por_ocupacion ON rates (room_type_id, season_id, meal_plan, occupancy, concept, price_kind, days_of_week, min_nights, child_age_min, child_age_max) NULLS NOT DISTINCT WHERE is_active;
CREATE FUNCTION booking_events_immutable() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'booking_events is append-only' USING ERRCODE = 'restrict_violation'; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER booking_events_no_change BEFORE UPDATE OR DELETE ON booking_events FOR EACH ROW EXECUTE FUNCTION booking_events_immutable();
CREATE TRIGGER booking_events_no_truncate BEFORE TRUNCATE ON booking_events FOR EACH STATEMENT EXECUTE FUNCTION booking_events_immutable();
CREATE INDEX bookings_sla_due_at_idx ON bookings (sla_due_at) WHERE status IN ('requested','checking_availability');
