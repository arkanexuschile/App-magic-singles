import db from "../db.server";
import { writeSyncLog } from "./sync-log.server";

const STALE_RUNNING_HISTORY_MS = 30 * 60 * 1000;

type SyncRunSummary = {
  catalogVariantsTotal: number;
  variantsScanned: number;
  cardsMatched: number;
  pricesUpdated: number;
  metafieldsUpdated: number;
  imagesUpdated: number;
  skippedForMissingPrice: number;
  previousPricesStored: number;
  failures: Array<{ variantId: string; reason: string }>;
  historyItems?: Array<{
    productId: string;
    productTitle: string;
    variantId: string;
    variantTitle: string;
    sku: string | null;
    metaValue: string | null;
    currentPrice: string | null;
    newPrice: string | null;
    status: "updated" | "failed" | "unchanged" | "skipped" | "suspicious";
    reason: string | null;
  }>;
};

function createEmptySyncRunSummary(): SyncRunSummary {
  return {
    catalogVariantsTotal: 0,
    variantsScanned: 0,
    cardsMatched: 0,
    pricesUpdated: 0,
    metafieldsUpdated: 0,
    imagesUpdated: 0,
    skippedForMissingPrice: 0,
    previousPricesStored: 0,
    failures: [],
    historyItems: [],
  };
}

function hasHistoryDelegate() {
  return (
    typeof db === "object" &&
    db !== null &&
    "syncRunHistory" in db &&
    Boolean((db as unknown as { syncRunHistory?: unknown }).syncRunHistory)
  );
}

function hasHistoryItemDelegate() {
  return (
    typeof db === "object" &&
    db !== null &&
    "syncRunHistoryItem" in db &&
    Boolean((db as unknown as { syncRunHistoryItem?: unknown }).syncRunHistoryItem)
  );
}

function isMissingTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table|sync_run_history|syncRunHistory|sync_run_history_item|syncRunHistoryItem/i.test(message);
}

function isMissingColumnError(error: unknown, column: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.toLowerCase().includes(column.toLowerCase()) &&
    /(no such column|does not exist|unknown (field|arg|argument)|p2022)/i.test(message)
  );
}

function isMissingMetaValueColumnError(error: unknown): boolean {
  return isMissingColumnError(error, "metaValue");
}

function buildHistoryItemCreateData(params: {
  runId: string;
  shop: string;
  item: NonNullable<SyncRunSummary["historyItems"]>[number];
  includeMetaValue: boolean;
}) {
  return {
    runId: params.runId,
    shop: params.shop,
    productId: params.item.productId,
    productTitle: params.item.productTitle,
    variantId: params.item.variantId,
    variantTitle: params.item.variantTitle,
    sku: params.item.sku,
    ...(params.includeMetaValue ? { metaValue: params.item.metaValue } : {}),
    currentPrice: params.item.currentPrice,
    newPrice: params.item.newPrice,
    status: params.item.status,
    reason: params.item.reason,
  };
}

function buildHistoryItemSelect(includeMetaValue: boolean) {
  return {
    productId: true,
    productTitle: true,
    variantId: true,
    variantTitle: true,
    sku: true,
    ...(includeMetaValue ? { metaValue: true } : {}),
    currentPrice: true,
    newPrice: true,
    status: true,
    reason: true,
  };
}

async function replaceSyncRunHistoryItems(params: {
  runId: string;
  shop: string;
  items: NonNullable<SyncRunSummary["historyItems"]>;
}) {
  if (!hasHistoryItemDelegate()) {
    return;
  }

  const historyItemDelegate = (
    db as unknown as {
      syncRunHistoryItem?: {
        deleteMany: (args: Record<string, unknown>) => Promise<{ count?: number }>;
        createMany: (args: Record<string, unknown>) => Promise<{ count?: number }>;
      };
    }
  ).syncRunHistoryItem;
  if (!historyItemDelegate) {
    return;
  }

  const dedupedItems = dedupeSummaryHistoryItems(params.items);

  try {
    await historyItemDelegate.deleteMany({
      where: { runId: params.runId },
    });

    if (dedupedItems.length === 0) {
      return;
    }

    const createItems = (includeMetaValue: boolean) =>
      historyItemDelegate.createMany({
        data: dedupedItems.map((item) =>
          buildHistoryItemCreateData({
            runId: params.runId,
            shop: params.shop,
            item,
            includeMetaValue,
          }),
        ),
      });

    try {
      await createItems(true);
    } catch (error) {
      if (!isMissingMetaValueColumnError(error)) {
        throw error;
      }
      writeSyncLog("warn", "[price-sync-run-history] metaValue column unavailable, writing history without meta", {
        runId: params.runId,
        shop: params.shop,
      });
      await createItems(false);
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw error;
  }
}

function dedupeRunHistoryRows<T extends {
  item: { variantId: string; status?: string };
}>(rows: T[]): T[] {
  const deduped = new Map<string, T>();
  for (const row of rows) {
    const current = deduped.get(row.item.variantId);
    if (!current || shouldReplaceHistoryItem(current.item, row.item)) {
      deduped.set(row.item.variantId, row);
    }
  }
  return Array.from(deduped.values());
}

function getHistoryItemPriority(item: { status?: string }): number {
  switch (item.status) {
    case "failed":
      return 50;
    case "updated":
      return 40;
    case "suspicious":
      return 35;
    case "skipped":
      return 30;
    case "unchanged":
      return 10;
    default:
      return 0;
  }
}

function shouldReplaceHistoryItem(
  current: { status?: string },
  candidate: { status?: string },
): boolean {
  return getHistoryItemPriority(candidate) >= getHistoryItemPriority(current);
}

function dedupeSummaryHistoryItems(
  items: NonNullable<SyncRunSummary["historyItems"]> | undefined,
) {
  if (!items || items.length === 0) {
    return [] as NonNullable<SyncRunSummary["historyItems"]>;
  }

  const deduped = new Map<string, NonNullable<SyncRunSummary["historyItems"]>[number]>();
  for (const item of items) {
    const current = deduped.get(item.variantId);
    if (!current || shouldReplaceHistoryItem(current, item)) {
      deduped.set(item.variantId, item);
    }
  }
  return Array.from(deduped.values());
}

function getFailuresCountFromSummary(summary: SyncRunSummary | undefined): number | null {
  if (!summary) {
    return null;
  }

  if (summary.historyItems && summary.historyItems.length > 0) {
    return dedupeSummaryHistoryItems(summary.historyItems).filter(
      (item) => item.status === "failed",
    ).length;
  }

  return summary.failures.length;
}

function getPricesUpdatedFromSummary(summary: SyncRunSummary | undefined): number | null {
  if (!summary) {
    return null;
  }

  const updatedItemsCount =
    summary.historyItems && summary.historyItems.length > 0
      ? dedupeSummaryHistoryItems(summary.historyItems).filter(
          (item) => item.status === "updated",
        ).length
      : 0;

  return Math.max(summary.pricesUpdated, updatedItemsCount);
}

export async function startSyncRunHistory(params: {
  shop: string;
  runKind: "scheduled" | "manual" | "test";
  selectedProductsCount?: number | null;
  maxProducts?: number | null;
}): Promise<string | null> {
  if (params.runKind === "test") {
    return null;
  }

  if (!hasHistoryDelegate()) {
    writeSyncLog("warn", "[price-sync-run-history] prisma delegate unavailable, skipping start", {
      shop: params.shop,
      runKind: params.runKind,
    });
    return null;
  }

  try {
    const created = await db.syncRunHistory.create({
      data: {
        shop: params.shop,
        runKind: params.runKind,
        status: "running",
        selectedProductsCount: params.selectedProductsCount ?? null,
        maxProducts: params.maxProducts ?? null,
      },
      select: { id: true },
    });
    return created.id;
  } catch (error) {
    if (isMissingTableError(error)) {
      writeSyncLog("warn", "[price-sync-run-history] table unavailable, skipping start", {
        shop: params.shop,
        runKind: params.runKind,
      });
      return null;
    }
    throw error;
  }
}

export async function finishSyncRunHistory(params: {
  runId: string;
  shop?: string;
  status: "success" | "failed";
  message?: string;
  summary?: SyncRunSummary;
}) {
  if (!hasHistoryDelegate()) {
    return;
  }

  const finishedAt = new Date();
  const summary = params.summary;
  const hasSummary = Boolean(summary);
  try {
    const current = await db.syncRunHistory.findUnique({
      where: { id: params.runId },
      select: {
        startedAt: true,
        catalogVariantsTotal: true,
        variantsScanned: true,
        cardsMatched: true,
        pricesUpdated: true,
        metafieldsUpdated: true,
        imagesUpdated: true,
        skippedForMissingPrice: true,
        previousPricesStored: true,
        failuresCount: true,
      },
    });
    const durationMs = current?.startedAt
      ? Math.max(0, finishedAt.getTime() - current.startedAt.getTime())
      : null;
    const failedWithoutSummary = params.status === "failed" && !hasSummary;
    const emptySummary = failedWithoutSummary ? createEmptySyncRunSummary() : undefined;

    await db.syncRunHistory.update({
      where: { id: params.runId },
      data: {
        status: params.status,
        finishedAt,
        durationMs,
        message: params.message ?? null,
        catalogVariantsTotal: hasSummary
          ? summary?.catalogVariantsTotal ?? null
          : failedWithoutSummary
            ? current?.catalogVariantsTotal ?? emptySummary?.catalogVariantsTotal ?? 0
          : undefined,
        variantsScanned: hasSummary
          ? summary?.variantsScanned ?? null
          : failedWithoutSummary
            ? current?.variantsScanned ?? emptySummary?.variantsScanned ?? 0
            : undefined,
        cardsMatched: hasSummary
          ? summary?.cardsMatched ?? null
          : failedWithoutSummary
            ? current?.cardsMatched ?? emptySummary?.cardsMatched ?? 0
            : undefined,
        pricesUpdated: hasSummary
          ? getPricesUpdatedFromSummary(summary)
          : failedWithoutSummary
            ? current?.pricesUpdated ?? emptySummary?.pricesUpdated ?? 0
            : undefined,
        metafieldsUpdated: hasSummary
          ? summary?.metafieldsUpdated ?? null
          : failedWithoutSummary
            ? current?.metafieldsUpdated ?? emptySummary?.metafieldsUpdated ?? 0
            : undefined,
        imagesUpdated: hasSummary
          ? summary?.imagesUpdated ?? null
          : failedWithoutSummary
            ? current?.imagesUpdated ?? emptySummary?.imagesUpdated ?? 0
            : undefined,
        skippedForMissingPrice: hasSummary
          ? summary?.skippedForMissingPrice ?? null
          : failedWithoutSummary
            ? current?.skippedForMissingPrice ?? emptySummary?.skippedForMissingPrice ?? 0
          : undefined,
        previousPricesStored: hasSummary
          ? summary?.previousPricesStored ?? null
          : failedWithoutSummary
            ? current?.previousPricesStored ?? emptySummary?.previousPricesStored ?? 0
          : undefined,
        failuresCount: hasSummary
          ? getFailuresCountFromSummary(summary)
          : failedWithoutSummary
            ? current?.failuresCount ?? 0
          : undefined,
      },
    });

    if (params.shop && summary?.historyItems) {
      await replaceSyncRunHistoryItems({
        runId: params.runId,
        shop: params.shop,
        items: summary.historyItems,
      });
    }
  } catch (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw error;
  }
}

export async function listSyncRunHistoryItemsForShop(shop: string) {
  if (!hasHistoryDelegate() || !hasHistoryItemDelegate()) {
    return [] as Array<{
      id: string;
      runKind: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      message: string | null;
      item: {
        productId: string;
        productTitle: string | null;
        variantId: string;
        variantTitle: string | null;
        sku: string | null;
        metaValue: string | null;
        currentPrice: string | null;
        newPrice: string | null;
        status: string;
        reason: string | null;
      };
    }>;
  }

  const fetchRows = async (includeMetaValue: boolean) => {
    const runs = await db.syncRunHistory.findMany({
      where: {
        shop,
        runKind: { not: "test" },
      },
      orderBy: { startedAt: "desc" },
      take: 50,
      select: {
        id: true,
        runKind: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        message: true,
        items: {
          orderBy: [{ createdAt: "asc" }, { variantId: "asc" }],
          select: buildHistoryItemSelect(includeMetaValue),
        },
      },
    });

    return runs.flatMap((run) =>
      dedupeRunHistoryRows(
        run.items.map((item) => ({
          id: run.id,
          runKind: run.runKind,
          status: run.status,
          startedAt: run.startedAt,
          finishedAt: run.finishedAt,
          message: run.message,
          item: {
            ...item,
            metaValue: "metaValue" in item ? item.metaValue ?? null : null,
          },
        })),
      ),
    );
  };

  try {
    return await fetchRows(true);
  } catch (error) {
    if (isMissingMetaValueColumnError(error)) {
      writeSyncLog("warn", "[price-sync-run-history] metaValue column unavailable, reading history without meta", {
        shop,
      });
      return fetchRows(false);
    }
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function listSyncRunHistoryItemsForRun(params: {
  shop: string;
  runId: string;
}) {
  if (!hasHistoryDelegate() || !hasHistoryItemDelegate()) {
    return [] as Array<{
      id: string;
      runKind: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      message: string | null;
      item: {
        productId: string;
        productTitle: string | null;
        variantId: string;
        variantTitle: string | null;
        sku: string | null;
        metaValue: string | null;
        currentPrice: string | null;
        newPrice: string | null;
        status: string;
        reason: string | null;
      };
    }>;
  }

  const fetchRun = async (includeMetaValue: boolean) =>
    db.syncRunHistory.findFirst({
      where: {
        id: params.runId,
        shop: params.shop,
        runKind: { not: "test" },
      },
      select: {
        id: true,
        runKind: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        message: true,
        items: {
          orderBy: [{ createdAt: "asc" }, { variantId: "asc" }],
          select: buildHistoryItemSelect(includeMetaValue),
        },
      },
    });

  const buildRowsForRun = (run: Awaited<ReturnType<typeof fetchRun>>) => {
    if (!run) {
      return [];
    }

    const rows = dedupeRunHistoryRows(
      run.items.map((item) => ({
        id: run.id,
        runKind: run.runKind,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        message: run.message,
        item: {
          ...item,
          metaValue: "metaValue" in item ? item.metaValue ?? null : null,
        },
      })),
    );

    if (rows.length > 0) {
      return rows;
    }

    // Some runs can fail before per-item details are persisted (for example auth/token errors).
    // Return a synthetic row so CSV exports still contain actionable run-level diagnostics.
    return [
      {
        id: run.id,
        runKind: run.runKind,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        message: run.message,
        item: {
          productId: "",
          productTitle: null,
          variantId: `run:${run.id}`,
          variantTitle: null,
          sku: null,
          metaValue: null,
          currentPrice: null,
          newPrice: null,
          status: run.status === "success" ? "unchanged" : "failed",
          reason:
            run.message ??
            (run.status === "success"
              ? "Run completed without item-level details"
              : "Run failed before item-level details were recorded"),
        },
      },
    ];
  };

  try {
    return buildRowsForRun(await fetchRun(true));
  } catch (error) {
    if (isMissingMetaValueColumnError(error)) {
      writeSyncLog("warn", "[price-sync-run-history] metaValue column unavailable, reading run history without meta", {
        runId: params.runId,
        shop: params.shop,
      });
      return buildRowsForRun(await fetchRun(false));
    }
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function updateSyncRunHistoryProgress(params: {
  runId: string;
  summary: Pick<
    SyncRunSummary,
    "variantsScanned" | "cardsMatched" | "pricesUpdated"
  > & { failuresCount?: number };
}) {
  if (!hasHistoryDelegate()) {
    return;
  }

  try {
    await db.syncRunHistory.update({
      where: { id: params.runId },
      data: {
        variantsScanned: params.summary.variantsScanned,
        cardsMatched: params.summary.cardsMatched,
        pricesUpdated: params.summary.pricesUpdated,
        failuresCount: params.summary.failuresCount ?? null,
      },
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return;
    }
    throw error;
  }
}

export async function listRecentSyncRunsForShop(shop: string, limit = 5) {
  if (!hasHistoryDelegate()) {
    return [] as Array<{
      id: string;
      runKind: string;
      status: string;
      startedAt: Date;
      finishedAt: Date | null;
      durationMs: number | null;
      variantsScanned: number | null;
      cardsMatched: number | null;
      pricesUpdated: number | null;
      failuresCount: number | null;
      suspiciousCount: number | null;
      message: string | null;
    }>;
  }

  try {
    const staleThreshold = new Date(Date.now() - STALE_RUNNING_HISTORY_MS);
    await db.syncRunHistory.updateMany({
      where: {
        shop,
        status: "running",
        startedAt: { lt: staleThreshold },
      },
      data: {
        status: "failed",
        finishedAt: new Date(),
        message: "Recovered stale running sync history entry",
      },
    });

    const runs = await db.syncRunHistory.findMany({
      where: {
        shop,
        runKind: { not: "test" },
      },
      orderBy: { startedAt: "desc" },
      take: Math.max(1, Math.min(20, Math.floor(limit))),
      select: {
        id: true,
        runKind: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        durationMs: true,
        variantsScanned: true,
        cardsMatched: true,
        pricesUpdated: true,
        failuresCount: true,
        message: true,
        items: hasHistoryItemDelegate()
          ? {
              select: {
                variantId: true,
                status: true,
              },
            }
          : false,
      },
    });

    return runs.map((run) => {
      const items = Array.isArray(run.items) ? run.items : [];
      const failuresCount =
        items.length > 0
          ? dedupeRunHistoryRows(
              items.map((item) => ({
                item: { variantId: item.variantId },
                status: item.status,
              })),
            ).filter((item) => item.status === "failed").length
          : run.failuresCount;
      const suspiciousCount =
        items.length > 0
          ? dedupeRunHistoryRows(
              items.map((item) => ({
                item: { variantId: item.variantId },
                status: item.status,
              })),
            ).filter((item) => item.status === "suspicious").length
          : 0;
      const updatedItemsCount =
        items.length > 0
          ? dedupeRunHistoryRows(
              items.map((item) => ({
                item: { variantId: item.variantId },
                status: item.status,
              })),
            ).filter((item) => item.status === "updated").length
          : 0;

      return {
        id: run.id,
        runKind: run.runKind,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
        variantsScanned: run.variantsScanned ?? 0,
        cardsMatched: run.cardsMatched ?? 0,
        pricesUpdated: Math.max(run.pricesUpdated ?? 0, updatedItemsCount),
        failuresCount: failuresCount ?? 0,
        suspiciousCount,
        message: run.message,
      };
    });
  } catch (error) {
    if (isMissingTableError(error)) {
      return [];
    }
    throw error;
  }
}

export async function clearSyncRunHistoryForShop(shop: string): Promise<number> {
  if (!hasHistoryDelegate()) {
    return 0;
  }

  try {
    const result = await db.syncRunHistory.deleteMany({
      where: { shop },
    });
    return result.count ?? 0;
  } catch (error) {
    if (isMissingTableError(error)) {
      return 0;
    }
    throw error;
  }
}
