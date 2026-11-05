-- Allow explicit pet-friendly flag on hotels (admin onboarding + search filter)
ALTER TABLE "hotels" ADD COLUMN "pets_allowed" BOOLEAN NOT NULL DEFAULT false;
