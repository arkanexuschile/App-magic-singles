-- Add live suspicious-count progress for scheduled sync runs
ALTER TABLE "SyncConfiguration" ADD COLUMN "currentScheduledSuspiciousCount" INTEGER;
