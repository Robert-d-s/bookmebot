-- CreateEnum
CREATE TYPE "channel" AS ENUM ('WHATSAPP', 'SIMULATOR');

-- CreateEnum
CREATE TYPE "message_direction" AS ENUM ('IN', 'OUT');

-- AlterTable
ALTER TABLE "businesses" ADD COLUMN     "whatsapp_phone_number_id" TEXT;

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "channel" "channel" NOT NULL,
    "direction" "message_direction" NOT NULL,
    "kind" TEXT NOT NULL,
    "text" TEXT,
    "payload" JSONB,
    "provider_message_id" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "messages_customer_id_created_at_idx" ON "messages"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "messages_business_id_created_at_idx" ON "messages"("business_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_channel_provider_message_id_key" ON "messages"("channel", "provider_message_id");

-- CreateIndex
CREATE UNIQUE INDEX "businesses_whatsapp_phone_number_id_key" ON "businesses"("whatsapp_phone_number_id");

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

