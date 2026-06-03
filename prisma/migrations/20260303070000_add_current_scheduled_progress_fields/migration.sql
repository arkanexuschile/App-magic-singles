-- Add live progress fields for scheduled sync runs
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledStatus" TEXT;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledStartedAt" DATETIME;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledUpdatedAt" DATETIME;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledTotalVariants" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledProcessedVariants" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledCardsMatched" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledPricesUpdated" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledSkippedForMissingPrice" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledFailures" INTEGER;
