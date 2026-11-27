DROP TRIGGER IF EXISTS `rates_days_key_bi`;
DROP TRIGGER IF EXISTS `rates_days_key_bu`;

DROP INDEX `rates_unica_por_ocupacion` ON `rates`;

ALTER TABLE `rates`
    DROP COLUMN `occupancy`,
    DROP COLUMN `percent_of_adult`,
    DROP COLUMN `child_age_min`,
    DROP COLUMN `child_age_max`,
    DROP COLUMN `days_of_week`,
    DROP COLUMN `days_of_week_key`,
    DROP COLUMN `max_nights`,
    DROP COLUMN `package_nights`,
    DROP COLUMN `source_page`;

CREATE UNIQUE INDEX `rates_unique_key` ON `rates`(
    `room_type_id`,
    `season_id`,
    `meal_plan`,
    `concept`,
    `price_kind`,
    `min_nights`,
    `is_active`
);