ALTER TABLE "SyncConfiguration"
ADD COLUMN "priceAdjustmentPercent" REAL NOT NULL DEFAULT 0;

ALTER TABLE "SyncConfiguration"
ADD COLUMN "priceAdjustmentFixed" REAL NOT NULL DEFAULT 0;

ALTER TABLE "SyncConfiguration"
ADD COLUMN "minimumPrice" REAL NOT NULL DEFAULT 0;
