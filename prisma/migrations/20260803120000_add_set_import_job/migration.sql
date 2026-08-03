-- CreateTable
CREATE TABLE "SetImportJob" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "setCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createAsActive" BOOLEAN NOT NULL DEFAULT false,
    "total" INTEGER NOT NULL DEFAULT 0,
    "processed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "errors" TEXT,
    "message" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SetImportJob_shop_status_idx" ON "SetImportJob"("shop", "status");

-- CreateIndex
CREATE INDEX "SetImportJob_shop_setCode_createdAt_idx" ON "SetImportJob"("shop", "setCode", "createdAt");
