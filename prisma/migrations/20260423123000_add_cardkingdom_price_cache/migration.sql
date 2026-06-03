CREATE TABLE "CardKingdomPriceCache" (
  "scryfallId" TEXT NOT NULL PRIMARY KEY,
  "nonfoilPrice" TEXT,
  "foilPrice" TEXT,
  "snapshotAt" DATETIME NOT NULL,
  "sourceUpdatedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE INDEX "CardKingdomPriceCache_snapshotAt_idx" ON "CardKingdomPriceCache"("snapshotAt");
