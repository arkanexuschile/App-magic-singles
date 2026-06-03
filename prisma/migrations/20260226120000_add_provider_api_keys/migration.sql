-- AlterTable
ALTER TABLE "SyncConfiguration" ADD COLUMN "justTcgApiKey" TEXT NOT NULL DEFAULT '';
ALTER TABLE "SyncConfiguration" ADD COLUMN "mtgjsonApiKey" TEXT NOT NULL DEFAULT '';
