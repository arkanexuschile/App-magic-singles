CREATE TABLE "BackgroundJobLock" (
  "jobKey" TEXT NOT NULL PRIMARY KEY,
  "lockToken" TEXT,
  "lockedUntil" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "BackgroundJobLock_lockedUntil_idx" ON "BackgroundJobLock"("lockedUntil");
