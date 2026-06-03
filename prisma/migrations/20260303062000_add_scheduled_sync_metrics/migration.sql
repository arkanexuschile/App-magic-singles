-- Add persisted summary metrics for the latest scheduled sync run
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledVariantsScanned" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledCardsMatched" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledPricesUpdated" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledMetafieldsUpdated" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledImagesUpdated" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledSkippedForMissingPrice" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledPreviousPricesStored" INTEGER;
ALTER TABLE "SyncConfiguration" ADD COLUMN "lastScheduledFailures" INTEGER;
