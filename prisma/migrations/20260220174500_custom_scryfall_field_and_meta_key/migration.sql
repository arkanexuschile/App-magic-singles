ALTER TABLE "SyncConfiguration" ADD COLUMN "useCustomScryfallIdField" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SyncConfiguration" ADD COLUMN "customScryfallIdNs" TEXT NOT NULL DEFAULT 'custom';
ALTER TABLE "SyncConfiguration" ADD COLUMN "customScryfallIdKey" TEXT NOT NULL DEFAULT 'scryfall_id';
UPDATE "SyncConfiguration"
SET "scryfallMetafieldKey" = 'scryfall_meta'
WHERE "scryfallMetafieldKey" = 'scryfall_id';
