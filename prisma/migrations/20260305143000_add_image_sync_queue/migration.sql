CREATE TABLE "ImageSyncQueue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "scryfallId" TEXT,
    "imageUrl" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "lockedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "ImageSyncQueue_shop_productId_key" ON "ImageSyncQueue"("shop", "productId");
CREATE INDEX "ImageSyncQueue_shop_status_nextAttemptAt_updatedAt_idx" ON "ImageSyncQueue"("shop", "status", "nextAttemptAt", "updatedAt");

