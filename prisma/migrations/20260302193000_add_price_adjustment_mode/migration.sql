ALTER TABLE "SyncConfiguration"
ADD COLUMN "priceAdjustmentMode" TEXT NOT NULL DEFAULT 'percent';

UPDATE "SyncConfiguration"
SET "priceAdjustmentMode" = CASE
  WHEN "priceAdjustmentFixed" != 0 AND "priceAdjustmentPercent" = 0 THEN 'fixed'
  ELSE 'percent'
END;
