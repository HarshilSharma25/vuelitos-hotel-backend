-- Hotel catalog amenities (pets, wifi, pool, etc.)
ALTER TABLE "hotels" ADD COLUMN "amenities" JSONB NOT NULL DEFAULT '[]';
