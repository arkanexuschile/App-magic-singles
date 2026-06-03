CREATE TABLE "SyncConfiguration" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "dailyTime" TEXT NOT NULL DEFAULT '03:00',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "syncImage" BOOLEAN NOT NULL DEFAULT false,
    "searchMode" TEXT NOT NULL DEFAULT 'sku',
    "searchMetafieldNamespace" TEXT NOT NULL DEFAULT 'custom',
    "searchMetafieldKey" TEXT NOT NULL DEFAULT 'card_lookup',
    "priceSource" TEXT NOT NULL DEFAULT 'scryfall',
    "scryfallMetafieldNs" TEXT NOT NULL DEFAULT 'custom',
    "scryfallMetafieldKey" TEXT NOT NULL DEFAULT 'scryfall_id',
    "metadataInitialized" BOOLEAN NOT NULL DEFAULT false,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastRunStatus" TEXT,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "SyncConfiguration_shop_key" ON "SyncConfiguration"("shop");
