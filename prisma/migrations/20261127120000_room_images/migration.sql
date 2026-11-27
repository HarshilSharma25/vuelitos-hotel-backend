-- CreateTable
CREATE TABLE `room_images` (
    `id` VARCHAR(191) NOT NULL,
    `room_type_id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(512) NOT NULL,
    `alt` VARCHAR(191) NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `source_hotel_image_id` VARCHAR(191) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `room_images_room_type_id_sort_order_idx` ON `room_images`(`room_type_id`, `sort_order`);

-- AddForeignKey
ALTER TABLE `room_images` ADD CONSTRAINT `room_images_room_type_id_fkey` FOREIGN KEY (`room_type_id`) REFERENCES `room_types`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
