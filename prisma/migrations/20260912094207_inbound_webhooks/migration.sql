-- CreateEnum
CREATE TYPE "inbound_event_status" AS ENUM ('RECEIVED', 'PROCESSING', 'PROCESSED', 'SKIPPED', 'FAILED', 'DEFERRED', 'DEAD');

-- CreateTable
CREATE TABLE "webhook_deliveries" (
    "id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "raw_body" TEXT NOT NULL,
    "headers" JSONB NOT NULL,
    "signature_valid" BOOLEAN NOT NULL,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_events" (
    "id" UUID NOT NULL,
    "delivery_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "correlation_key" TEXT,
    "payload" JSONB NOT NULL,
    "status" "inbound_event_status" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ,
    "last_error" TEXT,
    "result" JSONB,
    "received_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMPTZ,

    CONSTRAINT "inbound_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "webhook_deliveries_provider_received_at_idx" ON "webhook_deliveries"("provider", "received_at");

-- CreateIndex
CREATE INDEX "inbound_events_status_next_attempt_at_idx" ON "inbound_events"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "inbound_events_provider_correlation_key_idx" ON "inbound_events"("provider", "correlation_key");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_events_provider_provider_event_id_key" ON "inbound_events"("provider", "provider_event_id");

-- AddForeignKey
ALTER TABLE "inbound_events" ADD CONSTRAINT "inbound_events_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "webhook_deliveries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
