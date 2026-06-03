CREATE TABLE "SyncRunHistoryItem" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "runId" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "productTitle" TEXT,
    "variantId" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "SyncRunHistoryItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "SyncRunHistory" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "SyncRunHistoryItem_runId_status_idx" ON "SyncRunHistoryItem"("runId", "status");
CREATE INDEX "SyncRunHistoryItem_shop_createdAt_idx" ON "SyncRunHistoryItem"("shop", "createdAt");
