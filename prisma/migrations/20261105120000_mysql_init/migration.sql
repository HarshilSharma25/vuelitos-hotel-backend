-- CreateTable
CREATE TABLE `hotels` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `destination` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `star_rating` INTEGER NULL,
    `base_currency` ENUM('USD', 'EUR') NOT NULL,
    `is_solo_divisas` BOOLEAN NOT NULL DEFAULT false,
    `default_commission_percent` DECIMAL(5, 2) NOT NULL DEFAULT 10.00,
    `availability_mode` ENUM('manual', 'api') NOT NULL DEFAULT 'manual',
    `is_active` BOOLEAN NOT NULL DEFAULT true,
    `pets_allowed` BOOLEAN NOT NULL DEFAULT false,
    `child_bands_enabled` BOOLEAN NOT NULL DEFAULT false,
    `description` TEXT NULL,
    `amenities` JSON NOT NULL DEFAULT ('[]'),
    `cover_image_key` VARCHAR(512) NULL,
    `cover_image_url` TEXT NULL,
    `pay_now_enabled` BOOLEAN NULL,
    `pay_at_hotel_enabled` BOOLEAN NULL,
    `payment_window_hours` INTEGER NULL,
    `reminder_offsets_pct` JSON NULL,
    `auto_confirm_after_payment` BOOLEAN NULL,

    UNIQUE INDEX `hotels_slug_key`(`slug`),
    INDEX `hotels_destination_is_active_idx`(`destination`, `is_active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `room_types` (
    `id` VARCHAR(191) NOT NULL,
    `hotel_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `max_occupancy` INTEGER NOT NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `seasons` (
    `id` VARCHAR(191) NOT NULL,
    `hotel_id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `priority` INTEGER NOT NULL,
    `date_from` DATE NOT NULL,
    `date_to` DATE NOT NULL,
    `booking_from` DATE NULL,
    `booking_to` DATE NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rates` (
    `id` VARCHAR(191) NOT NULL,
    `room_type_id` VARCHAR(191) NOT NULL,
    `season_id` VARCHAR(191) NOT NULL,
    `meal_plan` VARCHAR(191) NOT NULL,
    `concept` ENUM('OCUPACION', 'NINO', 'PAX_ADICIONAL') NULL,
    `price_kind` ENUM('IMPORTE', 'BAJO_PEDIDO', 'GRATIS', 'PORCENTAJE_ADULTO') NOT NULL,
    `occupancy` INTEGER NULL,
    `pricing_unit` ENUM('per_room', 'per_person') NOT NULL,
    `net_rate` DECIMAL(12, 2) NOT NULL,
    `markup_percent` DECIMAL(5, 2) NULL,
    `sell_rate` DECIMAL(12, 2) NULL,
    `percent_of_adult` DECIMAL(5, 2) NULL,
    `child_age_min` INTEGER NULL,
    `child_age_max` INTEGER NULL,
    `days_of_week` JSON NOT NULL DEFAULT ('[]'),
    `days_of_week_key` VARCHAR(64) NOT NULL DEFAULT '[]',
    `min_nights` INTEGER NOT NULL DEFAULT 1,
    `max_nights` INTEGER NULL,
    `package_nights` INTEGER NULL,
    `source_page` INTEGER NULL,
    `is_active` BOOLEAN NOT NULL DEFAULT true,

    UNIQUE INDEX `rates_unica_por_ocupacion`(`room_type_id`, `season_id`, `meal_plan`, `occupancy`, `concept`, `price_kind`, `days_of_week_key`, `min_nights`, `child_age_min`, `child_age_max`, `is_active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `exchange_rates` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `bcv_usd` DECIMAL(12, 4) NOT NULL,
    `bcv_eur` DECIMAL(12, 4) NOT NULL,
    `binance_usdt` DECIMAL(12, 4) NOT NULL,
    `bcv_usd_source` VARCHAR(191) NOT NULL,
    `bcv_eur_source` VARCHAR(191) NOT NULL,
    `usdt_source` VARCHAR(191) NOT NULL,
    `recorded_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `fetched_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `bcv_value_date` DATE NOT NULL,
    `source` ENUM('auto', 'manual') NOT NULL DEFAULT 'auto',
    `is_manual_override` BOOLEAN NOT NULL DEFAULT false,

    INDEX `exchange_rates_recorded_at_idx`(`recorded_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bcv_published_rates` (
    `value_date` DATE NOT NULL,
    `usd` DECIMAL(12, 4) NOT NULL,
    `eur` DECIMAL(12, 4) NOT NULL,
    `published_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`value_date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `hotel_payment_tax_rules` (
    `hotel_id` VARCHAR(191) NOT NULL,
    `method` ENUM('stripe_card', 'pago_movil', 'bs_transfer', 'zelle', 'usdt_binance', 'cash_usd', 'cash_eur') NOT NULL,
    `iva_rate` DECIMAL(5, 4) NOT NULL,
    `surcharge_percent` DECIMAL(5, 2) NULL,

    PRIMARY KEY (`hotel_id`, `method`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bookings` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `status` ENUM('requested', 'checking_availability', 'awaiting_payment', 'payment_submitted', 'payment_verified', 'confirmed', 'alternatives_offered', 'unavailable', 'cancelled', 'refund_pending', 'refunded') NOT NULL DEFAULT 'requested',
    `user_id` VARCHAR(191) NULL,
    `access_key` CHAR(36) NOT NULL,
    `locale` VARCHAR(191) NOT NULL DEFAULT 'es',
    `contact_name` VARCHAR(191) NOT NULL,
    `contact_email` VARCHAR(191) NOT NULL,
    `contact_phone` VARCHAR(191) NULL,
    `notes` TEXT NULL,
    `guest_details` JSON NULL,
    `payment_method_pref` ENUM('stripe_card', 'pago_movil', 'bs_transfer', 'zelle', 'usdt_binance', 'cash_usd', 'cash_eur') NULL,
    `terms_accepted_at` DATETIME(3) NOT NULL,
    `totals_by_method` JSON NOT NULL,
    `fx_snapshot` JSON NOT NULL,
    `sla_due_at` DATETIME(3) NULL,
    `payment_mode` ENUM('online', 'at_hotel') NOT NULL DEFAULT 'online',
    `payment_window_hours` INTEGER NULL,
    `reminders_sent` JSON NOT NULL DEFAULT ('[]'),
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `bookings_code_key`(`code`),
    INDEX `bookings_user_id_idx`(`user_id`),
    INDEX `bookings_status_sla_due_at_idx`(`status`, `sla_due_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund_requests` (
    `id` VARCHAR(191) NOT NULL,
    `booking_id` VARCHAR(191) NOT NULL,
    `status` ENUM('submitted', 'in_review', 'needs_info', 'approved', 'rejected', 'completed') NOT NULL DEFAULT 'submitted',
    `public_reference` VARCHAR(191) NULL,
    `reason_code` ENUM('change_of_plans', 'found_better_option', 'travel_cancelled', 'medical', 'duplicate_booking', 'hotel_issue', 'other') NOT NULL,
    `reason_text` TEXT NULL,
    `open_booking_key` CHAR(36) NULL,
    `requested_by` VARCHAR(191) NOT NULL,
    `destination_method` VARCHAR(191) NOT NULL,
    `destination_details_enc` TEXT NOT NULL,
    `approved_amount` DECIMAL(12, 2) NULL,
    `approved_currency` VARCHAR(191) NULL,
    `staff_message` VARCHAR(2000) NULL,
    `rejection_reason` VARCHAR(2000) NULL,
    `refund_reference` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `refund_requests_public_reference_key`(`public_reference`),
    UNIQUE INDEX `refund_requests_open_booking_key_key`(`open_booking_key`),
    INDEX `refund_requests_booking_id_idx`(`booking_id`),
    INDEX `refund_requests_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund_documents` (
    `id` VARCHAR(191) NOT NULL,
    `refund_request_id` VARCHAR(191) NOT NULL,
    `kind` ENUM('payment_proof', 'booking_confirmation', 'id_document', 'other', 'completion_proof') NOT NULL,
    `source` ENUM('uploaded', 'reused_receipt', 'card_record', 'system_confirmation') NOT NULL DEFAULT 'uploaded',
    `storage_key` VARCHAR(191) NOT NULL,
    `linked_payment_id` VARCHAR(191) NULL,
    `content_hash` VARCHAR(191) NULL,
    `original_name` VARCHAR(191) NOT NULL,
    `mime_type` VARCHAR(191) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `uploaded_by` ENUM('customer', 'staff') NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `refund_documents_refund_request_id_idx`(`refund_request_id`),
    INDEX `refund_documents_content_hash_idx`(`content_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund_staged_uploads` (
    `id` VARCHAR(191) NOT NULL,
    `booking_id` VARCHAR(191) NOT NULL,
    `uploader_key` VARCHAR(191) NOT NULL,
    `storage_key` VARCHAR(191) NOT NULL,
    `content_hash` VARCHAR(191) NOT NULL,
    `original_name` VARCHAR(191) NOT NULL,
    `mime_type` VARCHAR(191) NOT NULL,
    `size_bytes` INTEGER NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `consumed_at` DATETIME(3) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `refund_staged_uploads_booking_id_uploader_key_idx`(`booking_id`, `uploader_key`),
    INDEX `refund_staged_uploads_expires_at_idx`(`expires_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund_idempotency_keys` (
    `id` VARCHAR(191) NOT NULL,
    `booking_id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `response_json` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expires_at` DATETIME(3) NOT NULL,

    INDEX `refund_idempotency_keys_expires_at_idx`(`expires_at`),
    UNIQUE INDEX `refund_idempotency_keys_booking_id_key_key`(`booking_id`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `refund_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `refund_request_id` VARCHAR(191) NOT NULL,
    `from_status` ENUM('submitted', 'in_review', 'needs_info', 'approved', 'rejected', 'completed') NULL,
    `to_status` ENUM('submitted', 'in_review', 'needs_info', 'approved', 'rejected', 'completed') NOT NULL,
    `actor_type` VARCHAR(191) NOT NULL,
    `actor_id` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_items` (
    `id` VARCHAR(191) NOT NULL,
    `booking_id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'hotel_stay',
    `hotel_id` VARCHAR(191) NOT NULL,
    `check_in` DATE NOT NULL,
    `check_out` DATE NOT NULL,
    `meal_plan` VARCHAR(191) NOT NULL,
    `room_selections` JSON NOT NULL,
    `price_snapshot` JSON NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `booking_id` VARCHAR(191) NOT NULL,
    `event` VARCHAR(191) NOT NULL,
    `from_status` ENUM('requested', 'checking_availability', 'awaiting_payment', 'payment_submitted', 'payment_verified', 'confirmed', 'alternatives_offered', 'unavailable', 'cancelled', 'refund_pending', 'refunded') NULL,
    `to_status` ENUM('requested', 'checking_availability', 'awaiting_payment', 'payment_submitted', 'payment_verified', 'confirmed', 'alternatives_offered', 'unavailable', 'cancelled', 'refund_pending', 'refunded') NOT NULL,
    `actor_type` VARCHAR(191) NOT NULL,
    `actor_id` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` VARCHAR(191) NOT NULL,
    `booking_id` VARCHAR(191) NOT NULL,
    `method` ENUM('stripe_card', 'pago_movil', 'bs_transfer', 'zelle', 'usdt_binance', 'cash_usd', 'cash_eur') NOT NULL,
    `currency` VARCHAR(191) NOT NULL,
    `amount_quoted` DECIMAL(12, 2) NOT NULL,
    `amount_received` DECIMAL(12, 2) NULL,
    `reference` VARCHAR(191) NOT NULL,
    `status` ENUM('submitted', 'verified', 'rejected', 'refunded', 'pending', 'needs_review', 'expired', 'failed') NOT NULL DEFAULT 'submitted',
    `rejection_reason` TEXT NULL,
    `rejection_notes` TEXT NULL,
    `submitted_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `verified_at` DATETIME(3) NULL,
    `verified_by` VARCHAR(191) NULL,
    `external_provider` VARCHAR(191) NULL,
    `external_session_id` VARCHAR(191) NULL,
    `raw_status` VARCHAR(191) NULL,
    `proof_storage_key` VARCHAR(191) NULL,
    `proof_content_hash` VARCHAR(191) NULL,
    `proof_mime_type` VARCHAR(191) NULL,
    `proof_original_name` VARCHAR(191) NULL,

    UNIQUE INDEX `payments_external_session_id_key`(`external_session_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payment_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `provider` VARCHAR(191) NOT NULL,
    `event_id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payment_events_provider_event_id_key`(`provider`, `event_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `availability_checks` (
    `id` VARCHAR(191) NOT NULL,
    `booking_id` VARCHAR(191) NULL,
    `hotel_id` VARCHAR(191) NOT NULL,
    `check_in` DATE NOT NULL,
    `check_out` DATE NOT NULL,
    `status` ENUM('pending', 'available', 'unavailable', 'on_request') NOT NULL DEFAULT 'pending',
    `checked_by` VARCHAR(191) NULL,
    `checked_at` DATETIME(3) NULL,
    `note` TEXT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `hotel_images` (
    `id` VARCHAR(191) NOT NULL,
    `hotel_id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `source_url` TEXT NULL,
    `source_kind` VARCHAR(191) NULL,
    `status` ENUM('held', 'published') NOT NULL DEFAULT 'held',
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `alt` VARCHAR(191) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `quotes` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `token_key` CHAR(36) NOT NULL,
    `status` ENUM('draft', 'sent', 'accepted', 'declined', 'expired') NOT NULL DEFAULT 'draft',
    `lines` JSON NOT NULL,
    `commission_percent` DECIMAL(5, 2) NOT NULL,
    `commission_amount` DECIMAL(12, 2) NOT NULL,
    `internal_notes` TEXT NULL,
    `expires_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `quotes_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leads` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `message` TEXT NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_users` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NOT NULL,
    `password_hash` VARCHAR(191) NOT NULL,
    `role` ENUM('agent', 'admin', 'super_admin') NOT NULL DEFAULT 'agent',

    UNIQUE INDEX `staff_users_email_key`(`email`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(191) NOT NULL,
    `token_hash` VARCHAR(191) NOT NULL,
    `user_id` VARCHAR(191) NOT NULL,
    `expires_at` DATETIME(3) NOT NULL,
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `user_agent` TEXT NULL,

    UNIQUE INDEX `sessions_token_hash_key`(`token_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `holidays` (
    `date` DATE NOT NULL,
    `name` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`date`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `checkout_settings` (
    `id` VARCHAR(191) NOT NULL DEFAULT 'global',
    `pay_now_enabled` BOOLEAN NOT NULL DEFAULT true,
    `pay_at_hotel_enabled` BOOLEAN NOT NULL DEFAULT true,
    `card_payments_enabled` BOOLEAN NOT NULL DEFAULT true,
    `payment_window_hours` INTEGER NOT NULL DEFAULT 48,
    `reminder_offsets_pct` JSON NOT NULL DEFAULT ('[50, 90]'),
    `auto_confirm_after_payment` BOOLEAN NOT NULL DEFAULT false,
    `refund_review_sla_hours` INTEGER NOT NULL DEFAULT 48,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `booking_code_counters` (
    `id` INTEGER NOT NULL,
    `seq` BIGINT NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings_audit` (
    `id` VARCHAR(191) NOT NULL,
    `setting_type` VARCHAR(191) NOT NULL,
    `target_id` VARCHAR(191) NULL,
    `old_value` JSON NOT NULL,
    `new_value` JSON NOT NULL,
    `actor_id` VARCHAR(191) NOT NULL,
    `actor_type` VARCHAR(191) NOT NULL,
    `timestamp` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `settings_audit_setting_type_target_id_idx`(`setting_type`, `target_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `room_types` ADD CONSTRAINT `room_types_hotel_id_fkey` FOREIGN KEY (`hotel_id`) REFERENCES `hotels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `seasons` ADD CONSTRAINT `seasons_hotel_id_fkey` FOREIGN KEY (`hotel_id`) REFERENCES `hotels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rates` ADD CONSTRAINT `rates_room_type_id_fkey` FOREIGN KEY (`room_type_id`) REFERENCES `room_types`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rates` ADD CONSTRAINT `rates_season_id_fkey` FOREIGN KEY (`season_id`) REFERENCES `seasons`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `hotel_payment_tax_rules` ADD CONSTRAINT `hotel_payment_tax_rules_hotel_id_fkey` FOREIGN KEY (`hotel_id`) REFERENCES `hotels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refund_requests` ADD CONSTRAINT `refund_requests_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refund_documents` ADD CONSTRAINT `refund_documents_refund_request_id_fkey` FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refund_staged_uploads` ADD CONSTRAINT `refund_staged_uploads_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `refund_events` ADD CONSTRAINT `refund_events_refund_request_id_fkey` FOREIGN KEY (`refund_request_id`) REFERENCES `refund_requests`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_items` ADD CONSTRAINT `booking_items_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `booking_events` ADD CONSTRAINT `booking_events_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `availability_checks` ADD CONSTRAINT `availability_checks_booking_id_fkey` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `availability_checks` ADD CONSTRAINT `availability_checks_hotel_id_fkey` FOREIGN KEY (`hotel_id`) REFERENCES `hotels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `hotel_images` ADD CONSTRAINT `hotel_images_hotel_id_fkey` FOREIGN KEY (`hotel_id`) REFERENCES `hotels`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `staff_users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only booking history. MySQL cannot disable triggers per session the way Postgres can.
CREATE TRIGGER `booking_events_no_update`
BEFORE UPDATE ON `booking_events`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_events is append-only';

CREATE TRIGGER `booking_events_no_delete`
BEFORE DELETE ON `booking_events`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'booking_events is append-only';

-- Keep the rate unique key aligned with the JSON weekday list.
CREATE TRIGGER `rates_days_key_bi`
BEFORE INSERT ON `rates`
FOR EACH ROW
SET NEW.days_of_week_key = CAST(NEW.days_of_week AS CHAR(64));

CREATE TRIGGER `rates_days_key_bu`
BEFORE UPDATE ON `rates`
FOR EACH ROW
SET NEW.days_of_week_key = CAST(NEW.days_of_week AS CHAR(64));

-- One open refund request per booking. Closed rows store NULL, and MySQL unique indexes allow many NULLs.
CREATE TRIGGER `refund_requests_open_key_bi`
BEFORE INSERT ON `refund_requests`
FOR EACH ROW
SET NEW.open_booking_key = IF(NEW.status IN ('rejected', 'completed'), NULL, NEW.booking_id);

CREATE TRIGGER `refund_requests_open_key_bu`
BEFORE UPDATE ON `refund_requests`
FOR EACH ROW
SET NEW.open_booking_key = IF(NEW.status IN ('rejected', 'completed'), NULL, NEW.booking_id);

