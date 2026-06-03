-- Add scheduled cursor fields for incremental scheduled sync processing
ALTER TABLE "SyncConfiguration" ADD COLUMN "scheduledCursorProductId" TEXT;
ALTER TABLE "SyncConfiguration" ADD COLUMN "scheduledCursorProductUpdatedAt" DATETIME;
