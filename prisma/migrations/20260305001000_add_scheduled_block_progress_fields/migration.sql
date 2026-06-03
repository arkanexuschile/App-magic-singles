-- Add scheduled chunk/block progress fields
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledTotalBlocks" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledProcessedBlocks" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledRemainingBlocks" INTEGER;
