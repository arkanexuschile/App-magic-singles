-- CreateTable
CREATE TABLE "SetsCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "fetchedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "SetsCache_key_key" ON "SetsCache"("key");

-- CreateIndex
CREATE INDEX "SetsCache_key_expiresAt_idx" ON "SetsCache"("key", "expiresAt");
