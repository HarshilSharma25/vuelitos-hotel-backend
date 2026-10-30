-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "user_id" TEXT;

-- CreateIndex
CREATE INDEX "bookings_user_id_idx" ON "bookings"("user_id");
