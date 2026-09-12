-- CreateEnum
CREATE TYPE "conversation_mode" AS ENUM ('BOT', 'HUMAN');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL,
    "business_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "mode" "conversation_mode" NOT NULL DEFAULT 'BOT',
    "transcript" JSONB NOT NULL DEFAULT '[]',
    "state" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_customer_id_key" ON "conversations"("customer_id");

-- CreateIndex
CREATE INDEX "conversations_business_id_updated_at_idx" ON "conversations"("business_id", "updated_at");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

