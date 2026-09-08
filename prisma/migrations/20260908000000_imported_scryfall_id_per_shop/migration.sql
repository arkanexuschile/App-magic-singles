-- AlterTable: make ImportedScryfallId per-shop.
-- SQLite cannot alter a primary key in place, so rebuild the table.
-- Backfill: every pre-existing scryfallId is duplicated for both known shops
-- (piedrabruja + arkanexus), preserving today's global-skip behavior exactly.
CREATE TABLE "NewImportedScryfallId" (
    "shop" TEXT NOT NULL,
    "scryfallId" TEXT NOT NULL,
    PRIMARY KEY ("shop", "scryfallId")
);
INSERT INTO "NewImportedScryfallId" ("shop", "scryfallId")
    SELECT 'piedrabruja.myshopify.com', "scryfallId" FROM "ImportedScryfallId";
INSERT INTO "NewImportedScryfallId" ("shop", "scryfallId")
    SELECT 'arkanexus.myshopify.com', "scryfallId" FROM "ImportedScryfallId";
DROP TABLE "ImportedScryfallId";
ALTER TABLE "NewImportedScryfallId" RENAME TO "ImportedScryfallId";
