-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SyncConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyTime" TEXT NOT NULL DEFAULT '03:00',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "syncImage" BOOLEAN NOT NULL DEFAULT false,
    "searchMode" TEXT NOT NULL DEFAULT 'sku',
    "searchMetafieldNamespace" TEXT NOT NULL DEFAULT 'custom',
    "searchMetafieldKey" TEXT NOT NULL DEFAULT 'card_lookup',
    "useCustomScryfallIdField" BOOLEAN NOT NULL DEFAULT false,
    "customScryfallIdNs" TEXT NOT NULL DEFAULT 'custom',
    "customScryfallIdKey" TEXT NOT NULL DEFAULT 'scryfall_id',
    "priceSource" TEXT NOT NULL DEFAULT 'scryfall',
    "justTcgApiKey" TEXT NOT NULL DEFAULT '',
    "mtgjsonApiKey" TEXT NOT NULL DEFAULT '',
    "displayCurrency" TEXT NOT NULL DEFAULT 'USD',
    "scryfallMetafieldNs" TEXT NOT NULL DEFAULT 'custom',
    "scryfallMetafieldKey" TEXT NOT NULL DEFAULT 'scryfall_meta',
    "metadataInitialized" BOOLEAN NOT NULL DEFAULT false,
    "imageSyncInitialized" BOOLEAN NOT NULL DEFAULT false,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_SyncConfiguration" ("createdAt", "customScryfallIdKey", "customScryfallIdNs", "dailyTime", "displayCurrency", "enabled", "id", "imageSyncInitialized", "justTcgApiKey", "lastError", "lastRunAt", "lastRunStatus", "metadataInitialized", "mtgjsonApiKey", "nextRunAt", "priceSource", "scryfallMetafieldKey", "scryfallMetafieldNs", "searchMetafieldKey", "searchMetafieldNamespace", "searchMode", "shop", "syncImage", "timezone", "updatedAt", "useCustomScryfallIdField") SELECT "createdAt", "customScryfallIdKey", "customScryfallIdNs", "dailyTime", "displayCurrency", "enabled", "id", "imageSyncInitialized", "justTcgApiKey", "lastError", "lastRunAt", "lastRunStatus", "metadataInitialized", "mtgjsonApiKey", "nextRunAt", "priceSource", "scryfallMetafieldKey", "scryfallMetafieldNs", "searchMetafieldKey", "searchMetafieldNamespace", "searchMode", "shop", "syncImage", "timezone", "updatedAt", "useCustomScryfallIdField" FROM "SyncConfiguration";
DROP TABLE "SyncConfiguration";
ALTER TABLE "new_SyncConfiguration" RENAME TO "SyncConfiguration";
CREATE UNIQUE INDEX "SyncConfiguration_shop_key" ON "SyncConfiguration"("shop");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
