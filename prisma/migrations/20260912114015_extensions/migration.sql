-- AlterEnum
ALTER TYPE "payment_status" ADD VALUE 'FORFEITED';

-- DropIndex
DROP INDEX "calendar_connections_business_id_key";

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "refund_cutoff_hours" INTEGER NOT NULL DEFAULT 24;

-- AlterTable
ALTER TABLE "calendar_blocks" ADD COLUMN     "staff_id" UUID;

-- AlterTable
ALTER TABLE "calendar_connections" ADD COLUMN     "staff_id" UUID;

-- CreateIndex
CREATE UNIQUE INDEX "calendar_connections_staff_id_key" ON "calendar_connections"("staff_id");

-- CreateIndex
CREATE INDEX "calendar_connections_business_id_idx" ON "calendar_connections"("business_id");

-- AddForeignKey
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_blocks" ADD CONSTRAINT "calendar_blocks_staff_id_fkey" FOREIGN KEY ("staff_id") REFERENCES "staff"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Hand-written: at most one business-level (shared) calendar per business.
-- Prisma cannot express a partial unique index; NULL staff_id rows would
-- otherwise all be "distinct".
CREATE UNIQUE INDEX "calendar_connections_business_shared_key"
  ON "calendar_connections" ("business_id") WHERE "staff_id" IS NULL;

-- RLS for the new column-less change: nothing to add, tenant policies key on business_id.
