CREATE TABLE "SyncRunHistory" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "runKind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "durationMs" INTEGER,
    "message" TEXT,
    "selectedProductsCount" INTEGER,
    "maxProducts" INTEGER,
    "catalogVariantsTotal" INTEGER,
    "variantsScanned" INTEGER,
    "cardsMatched" INTEGER,
    "pricesUpdated" INTEGER,
    "metafieldsUpdated" INTEGER,
    "imagesUpdated" INTEGER,
    "skippedForMissingPrice" INTEGER,
    "previousPricesStored" INTEGER,
    "failuresCount" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "SyncRunHistory_shop_startedAt_idx" ON "SyncRunHistory"("shop", "startedAt");
