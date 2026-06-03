import db from "../db.server";
import {
  refreshCardKingdomPriceCacheIfDue,
  syncCatalogWithScryfall,
} from "./price-sync.server";
import { createShopAdminClient } from "./shopify/admin-client.server";
import { writeSyncLog } from "./sync-log.server";
import {
  computeNextRunAt,
  getOrCreateSyncConfiguration,
  markSyncRun,
  toSyncPreferences,
} from "./sync-config.server";
import {
  finishSyncRunHistory,
  startSyncRunHistory,
  updateSyncRunHistoryProgress,
} from "./sync-run-history.server";

const CHECK_INTERVAL_MS = 60_000;
const RUN_LOCK_STALE_MS = 30 * 60 * 1000;
const ORPHAN_RUNNING_GRACE_MS = 2 * CHECK_INTERVAL_MS;
const SCHEDULER_LOG_PREFIX = "[product-sync-scheduler]";
const SCHEDULED_WAIT_FOR_ACTIVE_RUN_TIMEOUT_MS = (() => {
  const value = Number(process.env.SCHEDULED_WAIT_FOR_ACTIVE_RUN_TIMEOUT_MS ?? "1200000");
  if (!Number.isFinite(value) || value < 10_000) {
    return 1_200_000;
  }
  return Math.min(3_600_000, Math.floor(value));
})();
const SCHEDULED_WAIT_FOR_ACTIVE_RUN_POLL_MS = (() => {
  const value = Number(process.env.SCHEDULED_WAIT_FOR_ACTIVE_RUN_POLL_MS ?? "2000");
  if (!Number.isFinite(value) || value < 250) {
    return 2_000;
  }
  return Math.min(10_000, Math.floor(value));
})();
const SCHEDULED_SYNC_MAX_PRODUCTS_PER_RUN = (() => {
  const value = Number(process.env.SCHEDULED_SYNC_MAX_PRODUCTS_PER_RUN ?? "100");
  if (!Number.isFinite(value) || value < 0) {
    return 100;
  }
  return Math.min(10_000, Math.floor(value));
})();
const SCHEDULED_SHOP_CONCURRENCY = (() => {
  const value = Number(process.env.SCHEDULED_SHOP_CONCURRENCY ?? "1");
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(10, Math.floor(value));
})();
const SCHEDULED_THROTTLE_MAX_RETRIES = (() => {
  const value = Number(process.env.SCHEDULED_THROTTLE_MAX_RETRIES ?? "5");
  if (!Number.isFinite(value) || value < 0) {
    return 5;
  }
  return Math.min(10, Math.floor(value));
})();
const SCHEDULED_THROTTLE_RETRY_BASE_MS = (() => {
  const value = Number(process.env.SCHEDULED_THROTTLE_RETRY_BASE_MS ?? "5000");
  if (!Number.isFinite(value) || value < 500) {
    return 5000;
  }
  return Math.min(60_000, Math.floor(value));
})();
const SYNC_PROGRESS_EVERY_VARIANTS = (() => {
  const value = Number(process.env.SYNC_PROGRESS_EVERY_VARIANTS ?? "10");
  if (!Number.isFinite(value) || value < 1) {
    return 10;
  }
  return Math.min(100, Math.floor(value));
})();
const CARDKINGDOM_WARMUP_ON_BOOT = process.env.CARDKINGDOM_WARMUP_ON_BOOT !== "0";
const TERMINAL_STATUSES = new Set(["success", "failed"]);
const SHOPIFY_OFFLINE_TOKEN_INVALID_RE =
  /(Invalid API key or access token|unrecognized login or wrong password|unauthorized|invalid[_\s-]*token|401)/i;
let warnedMissingBlockProgressColumns = false;
type SyncRunOptions = {
  recurringPriceOnly: boolean;
  selectedProductIds?: string[];
  excludedProductIds?: string[];
  maxProducts?: number;
};
type ManualSyncKind = "manual" | "test";
type ActiveRunKind = "scheduled" | "manual" | "test";
type TrackableRunKind = ManualSyncKind;
type ManualSyncStatus = {
  status: "queued" | "running" | "success" | "failed";
  message: string | null;
  startedAtUtc: string | null;
  updatedAtUtc: string;
  phase:
    | "scanning"
    | "updating_prices"
    | "updating_metadata"
    | "updating_images"
    | "finalizing"
    | "completed"
    | null;
  totalVariants: number | null;
  processedVariants: number | null;
  cardsMatched: number | null;
  pricesUpdated: number | null;
  imagesUpdated: number | null;
  skippedForMissingPrice: number | null;
  suspiciousCount: number | null;
  failures: number | null;
};
const MANUAL_STATUS_RETENTION_MS = 2 * 60 * 1000;
type NextDueSnapshot = {
  shop: string;
  nextRunAtUtc: string;
  secondsUntil: number;
} | null;
type OfflineSessionCandidate = {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  expires: Date | null;
};
type OfflineTokenResolution = {
  ok: boolean;
  accessToken?: string;
  sessionId?: string;
  refreshToken?: string | null;
  message?: string;
};
type RecoveringAdminClient = ReturnType<typeof createShopAdminClient>;

function summarizeSyncResult(result: {
  catalogVariantsTotal: number;
  variantsScanned: number;
  cardsMatched: number;
  pricesUpdated: number;
  suspiciousCount: number;
  metafieldsUpdated: number;
  imagesUpdated: number;
  skippedForMissingPrice: number;
  previousPricesStored: number;
  failures: Array<{ variantId: string; reason: string }>;
}) {
  return {
    catalogVariantsTotal: result.catalogVariantsTotal,
    variantsScanned: result.variantsScanned,
    cardsMatched: result.cardsMatched,
    pricesUpdated: result.pricesUpdated,
    suspiciousCount: result.suspiciousCount,
    metafieldsUpdated: result.metafieldsUpdated,
    imagesUpdated: result.imagesUpdated,
    skippedForMissingPrice: result.skippedForMissingPrice,
    previousPricesStored: result.previousPricesStored,
    failuresCount: result.failures.length,
    failureSamples: result.failures.slice(0, 3),
  };
}

function logPriceImpactValidation(params: {
  shop: string;
  runKind: ActiveRunKind;
  variantsScanned: number;
  cardsMatched: number;
  pricesUpdated: number;
}) {
  if (params.cardsMatched > 0 && params.pricesUpdated === 0) {
    logScheduler("runner completed with zero price impact", {
      shop: params.shop,
      runKind: params.runKind,
      variantsScanned: params.variantsScanned,
      cardsMatched: params.cardsMatched,
      pricesUpdated: params.pricesUpdated,
    });
    return;
  }

  logScheduler("runner price impact", {
    shop: params.shop,
    runKind: params.runKind,
    variantsScanned: params.variantsScanned,
    cardsMatched: params.cardsMatched,
    pricesUpdated: params.pricesUpdated,
  });
}

declare global {
  // eslint-disable-next-line no-var
  var __priceSyncSchedulerStarted: boolean | undefined;
  // eslint-disable-next-line no-var
  var __priceSyncShopsRunning: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __priceSyncManualShopsRunning: Set<string> | undefined;
  // eslint-disable-next-line no-var
  var __priceSyncTickInFlight: boolean | undefined;
  // eslint-disable-next-line no-var
  var __priceSyncTickRequested: boolean | undefined;
  // eslint-disable-next-line no-var
  var __priceSyncManualStatusByShop: Map<string, ManualSyncStatus> | undefined;
  // eslint-disable-next-line no-var
  var __priceSyncTestStatusByShop: Map<string, ManualSyncStatus> | undefined;
  // eslint-disable-next-line no-var
  var __priceSyncActiveRunKindByShop: Map<string, ActiveRunKind> | undefined;
}

if (!global.__priceSyncShopsRunning) {
  global.__priceSyncShopsRunning = new Set<string>();
}
if (!global.__priceSyncManualShopsRunning) {
  global.__priceSyncManualShopsRunning = new Set<string>();
}
if (global.__priceSyncTickInFlight === undefined) {
  global.__priceSyncTickInFlight = false;
}
if (global.__priceSyncTickRequested === undefined) {
  global.__priceSyncTickRequested = false;
}
if (!global.__priceSyncManualStatusByShop) {
  global.__priceSyncManualStatusByShop = new Map<string, ManualSyncStatus>();
}
if (!global.__priceSyncTestStatusByShop) {
  global.__priceSyncTestStatusByShop = new Map<string, ManualSyncStatus>();
}
if (!global.__priceSyncActiveRunKindByShop) {
  global.__priceSyncActiveRunKindByShop = new Map<string, ActiveRunKind>();
}

function normalizeManualKind(kind?: ManualSyncKind): TrackableRunKind {
  return kind === "test" ? "test" : "manual";
}

function getStatusMapForKind(kind: TrackableRunKind): Map<string, ManualSyncStatus> | null {
  if (kind === "test") {
    return global.__priceSyncTestStatusByShop ?? null;
  }
  return global.__priceSyncManualStatusByShop ?? null;
}

function setStatusForKind(params: {
  shop: string;
  kind: TrackableRunKind;
  status: ManualSyncStatus["status"];
  message?: string | null;
  startedAtUtc?: string | null;
  progress?: {
    phase?:
      | "scanning"
      | "updating_prices"
      | "updating_metadata"
      | "updating_images"
      | "finalizing"
      | "completed"
      | null;
    totalVariants?: number | null;
    processedVariants?: number | null;
    cardsMatched?: number | null;
    pricesUpdated?: number | null;
    imagesUpdated?: number | null;
    skippedForMissingPrice?: number | null;
    suspiciousCount?: number | null;
    failures?: number | null;
  };
}) {
  const statusMap = getStatusMapForKind(params.kind);
  if (!statusMap) {
    return;
  }
  const previous = statusMap.get(params.shop);
  const progress = params.progress;
  const readProgress = <T,>(key: keyof NonNullable<typeof progress>, fallback: T): T => {
    if (!progress || !(key in progress)) {
      return fallback;
    }
    const value = progress[key] as T | undefined;
    return value === undefined ? fallback : value;
  };
  statusMap.set(params.shop, {
    status: params.status,
    message: params.message ?? null,
    startedAtUtc:
      params.startedAtUtc !== undefined
        ? params.startedAtUtc
        : previous?.startedAtUtc ?? null,
    updatedAtUtc: new Date().toISOString(),
    phase: readProgress("phase", previous?.phase ?? null),
    totalVariants: readProgress("totalVariants", previous?.totalVariants ?? null),
    processedVariants: readProgress("processedVariants", previous?.processedVariants ?? null),
    cardsMatched: readProgress("cardsMatched", previous?.cardsMatched ?? null),
    pricesUpdated: readProgress("pricesUpdated", previous?.pricesUpdated ?? null),
    imagesUpdated: readProgress("imagesUpdated", previous?.imagesUpdated ?? null),
    skippedForMissingPrice: readProgress(
      "skippedForMissingPrice",
      previous?.skippedForMissingPrice ?? null,
    ),
    suspiciousCount: readProgress("suspiciousCount", previous?.suspiciousCount ?? null),
    failures: readProgress("failures", previous?.failures ?? null),
  });
}

function getStatusForKind(shop: string, kind: TrackableRunKind): ManualSyncStatus | null {
  const statusMap = getStatusMapForKind(kind);
  if (!statusMap) {
    return null;
  }
  const status = statusMap.get(shop) ?? null;
  if (!status) {
    return null;
  }
  if (
    TERMINAL_STATUSES.has(status.status) &&
    Date.now() - new Date(status.updatedAtUtc).getTime() > MANUAL_STATUS_RETENTION_MS
  ) {
    statusMap.delete(shop);
    return null;
  }
  if (
    (status.status === "queued" || status.status === "running") &&
    Date.now() - new Date(status.updatedAtUtc).getTime() > RUN_LOCK_STALE_MS &&
    !isShopRunActive(shop)
  ) {
    statusMap.delete(shop);
    return null;
  }
  return status;
}

function getActiveRunKind(shop: string): ActiveRunKind | null {
  if (!global.__priceSyncActiveRunKindByShop) {
    return null;
  }
  return global.__priceSyncActiveRunKindByShop.get(shop) ?? null;
}

function acquireInMemoryRunLock(shop: string, kind: ActiveRunKind): boolean {
  if (
    !global.__priceSyncActiveRunKindByShop ||
    !global.__priceSyncShopsRunning ||
    !global.__priceSyncManualShopsRunning
  ) {
    return false;
  }

  if (
    global.__priceSyncShopsRunning.has(shop) ||
    global.__priceSyncManualShopsRunning.has(shop) ||
    global.__priceSyncActiveRunKindByShop.has(shop)
  ) {
    return false;
  }

  global.__priceSyncActiveRunKindByShop.set(shop, kind);
  global.__priceSyncShopsRunning.add(shop);
  if (kind === "manual" || kind === "test") {
    global.__priceSyncManualShopsRunning.add(shop);
  }
  return true;
}

function releaseInMemoryRunLock(shop: string) {
  global.__priceSyncActiveRunKindByShop?.delete(shop);
  global.__priceSyncShopsRunning?.delete(shop);
  global.__priceSyncManualShopsRunning?.delete(shop);
}

function isShopRunActive(shop: string): boolean {
  return Boolean(
    global.__priceSyncShopsRunning?.has(shop) ||
      global.__priceSyncManualShopsRunning?.has(shop) ||
      global.__priceSyncActiveRunKindByShop?.has(shop),
  );
}

async function waitForShopToBeIdle(shop: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (!isShopRunActive(shop)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, SCHEDULED_WAIT_FOR_ACTIVE_RUN_POLL_MS));
  }
  return !isShopRunActive(shop);
}

function logScheduler(message: string, extra?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  if (extra) {
    console.log(`${SCHEDULER_LOG_PREFIX} ${timestamp} ${message}`, extra);
    writeSyncLog("info", `${SCHEDULER_LOG_PREFIX} ${message}`, extra);
    return;
  }
  console.log(`${SCHEDULER_LOG_PREFIX} ${timestamp} ${message}`);
  writeSyncLog("info", `${SCHEDULER_LOG_PREFIX} ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isThrottleErrorMessage(message: string): boolean {
  return /(throttled|rate.?limit|too many requests|429)/i.test(message);
}

function toSafeNonNegativeInt(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.max(0, Math.floor(value));
}

function hasAnySyncProgress(result: {
  catalogVariantsTotal: number;
  variantsScanned: number;
  cardsMatched: number;
  pricesUpdated: number;
  metafieldsUpdated: number;
  imagesUpdated: number;
  skippedForMissingPrice: number;
  previousPricesStored: number;
  failures: Array<{ variantId: string; reason: string }>;
}): boolean {
  return (
    result.catalogVariantsTotal > 0 ||
    result.variantsScanned > 0 ||
    result.cardsMatched > 0 ||
    result.pricesUpdated > 0 ||
    result.metafieldsUpdated > 0 ||
    result.imagesUpdated > 0 ||
    result.skippedForMissingPrice > 0 ||
    result.previousPricesStored > 0 ||
    result.failures.length > 0
  );
}

function parseJsonSafely(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractApiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const root = payload as {
    error?: unknown;
    errors?: unknown;
  };

  if (typeof root.error === "string" && root.error.trim()) {
    return root.error.trim();
  }

  if (Array.isArray(root.errors) && root.errors.length > 0) {
    const first = root.errors[0];
    if (typeof first === "string" && first.trim()) {
      return first.trim();
    }
    if (first && typeof first === "object" && "message" in first) {
      const message = (first as { message?: unknown }).message;
      if (typeof message === "string" && message.trim()) {
        return message.trim();
      }
    }
  }

  if (root.errors && typeof root.errors === "object" && "message" in root.errors) {
    const message = (root.errors as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }
  }

  return null;
}

async function probeOfflineAdminToken(shop: string, accessToken: string): Promise<{
  ok: boolean;
  message?: string;
}> {
  const admin = createShopAdminClient(shop, accessToken);
  try {
    const response = await admin.graphql(
      `#graphql
        query PriceSyncAuthProbe {
          shop {
            id
          }
        }
      `,
    );
    const raw = await response.text();
    const payload = parseJsonSafely(raw);
    const payloadMessage = extractApiErrorMessage(payload);

    if (!response.ok) {
      return {
        ok: false,
        message: payloadMessage ?? `Shopify auth probe failed: HTTP ${response.status}`,
      };
    }

    if (payloadMessage) {
      return { ok: false, message: payloadMessage };
    }

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function refreshOfflineAccessToken(params: {
  shop: string;
  sessionId: string;
  refreshToken: string;
  runKind: ActiveRunKind;
}): Promise<{
  ok: boolean;
  accessToken?: string;
  message?: string;
}> {
  if (!process.env.SHOPIFY_API_KEY || !process.env.SHOPIFY_API_SECRET) {
    return {
      ok: false,
      message: "Missing SHOPIFY_API_KEY/SHOPIFY_API_SECRET for token refresh",
    };
  }

  try {
    const response = await fetch(`https://${params.shop}/admin/oauth/access_token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        grant_type: "refresh_token",
        refresh_token: params.refreshToken,
      }),
    });

    const raw = await response.text();
    const payload = parseJsonSafely(raw) as
      | {
          access_token?: unknown;
          scope?: unknown;
          refresh_token?: unknown;
          error?: unknown;
          errors?: unknown;
        }
      | null;
    const payloadMessage = extractApiErrorMessage(payload);

    if (!response.ok) {
      return {
        ok: false,
        message: payloadMessage ?? `Shopify refresh failed: HTTP ${response.status}`,
      };
    }

    const nextAccessToken =
      payload && typeof payload.access_token === "string" ? payload.access_token.trim() : "";
    if (!nextAccessToken) {
      return {
        ok: false,
        message: payloadMessage ?? "Shopify refresh did not return access_token",
      };
    }

    const nextRefreshToken =
      payload && typeof payload.refresh_token === "string" && payload.refresh_token.trim().length > 0
        ? payload.refresh_token.trim()
        : null;
    const nextScope =
      payload && typeof payload.scope === "string" && payload.scope.trim().length > 0
        ? payload.scope.trim()
        : null;

    await db.session.update({
      where: { id: params.sessionId },
      data: {
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken ?? undefined,
        scope: nextScope ?? undefined,
      },
    });

    logScheduler("offline token refreshed", {
      shop: params.shop,
      runKind: params.runKind,
    });

    return { ok: true, accessToken: nextAccessToken };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function ensureValidOfflineAccessToken(params: {
  shop: string;
  runKind: ActiveRunKind;
  session: {
    id: string;
    accessToken: string;
    refreshToken: string | null;
  };
}): Promise<{
  ok: boolean;
  accessToken?: string;
  message?: string;
}> {
  const probe = await probeOfflineAdminToken(params.shop, params.session.accessToken);
  if (probe.ok) {
    return { ok: true, accessToken: params.session.accessToken };
  }

  const probeMessage = probe.message ?? "Shopify offline token probe failed";
  if (!SHOPIFY_OFFLINE_TOKEN_INVALID_RE.test(probeMessage)) {
    return { ok: false, message: probeMessage };
  }

  if (!params.session.refreshToken) {
    return {
      ok: false,
      message: `${probeMessage} (missing refresh token)`,
    };
  }

  logScheduler("offline token rejected, attempting refresh", {
    shop: params.shop,
    runKind: params.runKind,
    message: probeMessage,
  });

  const refreshed = await refreshOfflineAccessToken({
    shop: params.shop,
    sessionId: params.session.id,
    refreshToken: params.session.refreshToken,
    runKind: params.runKind,
  });
  if (!refreshed.ok || !refreshed.accessToken) {
    return {
      ok: false,
      message: refreshed.message ?? probeMessage,
    };
  }

  const reProbe = await probeOfflineAdminToken(params.shop, refreshed.accessToken);
  if (!reProbe.ok) {
    return {
      ok: false,
      message: reProbe.message ?? "Refreshed token is still rejected",
    };
  }

  return { ok: true, accessToken: refreshed.accessToken };
}

function scoreOfflineSession(session: OfflineSessionCandidate, shop: string, now: Date): number {
  let score = 0;
  if (session.id === `offline_${shop}` || session.id.includes(shop)) {
    score += 100;
  }
  if (!session.expires || session.expires > now) {
    score += 50;
  }
  if (session.refreshToken) {
    score += 25;
  }
  if (session.accessToken) {
    score += 10;
  }
  return score;
}

async function resolveValidOfflineAccessTokenForShop(params: {
  shop: string;
  runKind: ActiveRunKind;
}): Promise<OfflineTokenResolution> {
  const sessions = await db.session.findMany({
    where: {
      shop: params.shop,
      isOnline: false,
    },
    select: {
      id: true,
      accessToken: true,
      refreshToken: true,
      expires: true,
    },
  });

  const now = new Date();
  const candidates = sessions
    .filter((session) => Boolean(session.id && session.accessToken))
    .sort((a, b) => {
      const scoreDiff =
        scoreOfflineSession(b, params.shop, now) - scoreOfflineSession(a, params.shop, now);
      return scoreDiff !== 0 ? scoreDiff : b.id.localeCompare(a.id);
    });

  if (candidates.length === 0) {
    return { ok: false, message: "No offline session available" };
  }

  const failures: string[] = [];
  for (const session of candidates) {
    const ensured = await ensureValidOfflineAccessToken({
      shop: params.shop,
      runKind: params.runKind,
      session: {
        id: session.id,
        accessToken: session.accessToken,
        refreshToken: session.refreshToken ?? null,
      },
    });
    if (ensured.ok && ensured.accessToken) {
      logScheduler("offline session selected", {
        shop: params.shop,
        runKind: params.runKind,
        sessionId: session.id,
        hadRefreshToken: Boolean(session.refreshToken),
        expiresAt: session.expires?.toISOString() ?? null,
        candidates: candidates.length,
      });
      return {
        ok: true,
        accessToken: ensured.accessToken,
        sessionId: session.id,
        refreshToken: session.refreshToken ?? null,
      };
    }
    failures.push(`${session.id}: ${ensured.message ?? "invalid token"}`);
  }

  return {
    ok: false,
    message: `No valid offline session available (${failures.slice(0, 3).join(" | ")})`,
  };
}

function createRecoveringShopAdminClient(params: {
  shop: string;
  runKind: ActiveRunKind;
  accessToken: string;
}): RecoveringAdminClient {
  let activeAccessToken = params.accessToken;
  let delegate = createShopAdminClient(params.shop, activeAccessToken);
  let refreshInFlight: Promise<OfflineTokenResolution> | null = null;

  const recoverToken = async (message: string): Promise<boolean> => {
    if (!SHOPIFY_OFFLINE_TOKEN_INVALID_RE.test(message)) {
      return false;
    }
    if (!refreshInFlight) {
      logScheduler("admin client recovering invalid token", {
        shop: params.shop,
        runKind: params.runKind,
        message,
      });
      refreshInFlight = resolveValidOfflineAccessTokenForShop({
        shop: params.shop,
        runKind: params.runKind,
      }).finally(() => {
        refreshInFlight = null;
      });
    }

    const refreshed = await refreshInFlight;
    if (!refreshed.ok || !refreshed.accessToken || refreshed.accessToken === activeAccessToken) {
      return false;
    }
    activeAccessToken = refreshed.accessToken;
    delegate = createShopAdminClient(params.shop, activeAccessToken);
    return true;
  };

  return {
    graphql: async (query, options) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          return await delegate.graphql(query, options);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const recovered = await recoverToken(message);
          if (!recovered || attempt >= 1) {
            throw error;
          }
        }
      }
      return delegate.graphql(query, options);
    },
    restGet: async (path) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          if (!delegate.restGet) {
            throw new Error("Shopify REST client unavailable");
          }
          return await delegate.restGet(path);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const recovered = await recoverToken(message);
          if (!recovered || attempt >= 1) {
            throw error;
          }
        }
      }
      if (!delegate.restGet) {
        throw new Error("Shopify REST client unavailable");
      }
      return delegate.restGet(path);
    },
  };
}

function isMissingBlockProgressColumnsError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Unknown argument `currentScheduledTotalBlocks`") ||
    message.includes("Unknown argument `currentScheduledProcessedBlocks`") ||
    message.includes("Unknown argument `currentScheduledRemainingBlocks`") ||
    message.includes("Unknown argument `currentScheduledSuspiciousCount`") ||
    message.includes("currentScheduledSuspiciousCount")
  );
}

function stripBlockProgressFields<T extends Record<string, unknown>>(data: T): T {
  const cloned = { ...data } as Record<string, unknown>;
  delete cloned.currentScheduledTotalBlocks;
  delete cloned.currentScheduledProcessedBlocks;
  delete cloned.currentScheduledRemainingBlocks;
  delete cloned.currentScheduledSuspiciousCount;
  return cloned as T;
}

async function updateSyncConfigurationWithCompat(params: {
  shop: string;
  data: Record<string, unknown>;
}) {
  try {
    await db.syncConfiguration.update({
      where: { shop: params.shop },
      data: params.data,
    });
  } catch (error) {
    if (!isMissingBlockProgressColumnsError(error)) {
      throw error;
    }

    if (!warnedMissingBlockProgressColumns) {
      warnedMissingBlockProgressColumns = true;
      logScheduler("block progress columns missing in DB, using compatibility fallback", {
        shop: params.shop,
      });
    }

    await db.syncConfiguration.update({
      where: { shop: params.shop },
      data: stripBlockProgressFields(params.data),
    });
  }
}

async function getNextDueSnapshot(now = new Date()): Promise<NextDueSnapshot> {
  const next = await db.syncConfiguration.findFirst({
    where: {
      enabled: true,
      nextRunAt: {
        not: null,
      },
    },
    select: {
      shop: true,
      nextRunAt: true,
      dailyTime: true,
      timezone: true,
      lastRunStatus: true,
    },
    orderBy: { nextRunAt: "asc" },
  });

  if (!next?.nextRunAt) {
    return null;
  }

  const projectedNextRunAt =
    next.nextRunAt <= now
      ? computeNextRunAt(next.dailyTime, next.timezone, now)
      : next.nextRunAt;
  const secondsUntil = Math.max(
    0,
    Math.floor((projectedNextRunAt.getTime() - now.getTime()) / 1000),
  );
  return {
    shop: next.shop,
    nextRunAtUtc: projectedNextRunAt.toISOString(),
    secondsUntil,
  };
}

export async function getSchedulerNextDueSnapshot(): Promise<{
  nextDueAtUtc: string | null;
  nextDueShop: string | null;
  secondsUntilNextDue: number | null;
}> {
  const snapshot = await getNextDueSnapshot(new Date());
  return {
    nextDueAtUtc: snapshot?.nextRunAtUtc ?? null,
    nextDueShop: snapshot?.shop ?? null,
    secondsUntilNextDue: snapshot?.secondsUntil ?? null,
  };
}

export async function getSchedulerDueCountPreview(now = new Date()): Promise<number> {
  return db.syncConfiguration.count({
    where: {
      enabled: true,
      nextRunAt: {
        lte: now,
      },
      ...getRunnableFilter(now),
    },
  });
}

async function recoverOrphanRunningShops(now = new Date()): Promise<number> {
  if (!global.__priceSyncShopsRunning || !global.__priceSyncManualShopsRunning) {
    return 0;
  }

  const threshold = new Date(now.getTime() - ORPHAN_RUNNING_GRACE_MS);
  const candidates = await db.syncConfiguration.findMany({
    where: {
      lastRunStatus: "running",
      lastRunAt: {
        lte: threshold,
      },
      nextRunAt: {
        lte: now,
      },
    },
    select: { shop: true },
  });

  let recovered = 0;
  for (const candidate of candidates) {
    const isActiveInMemory =
      global.__priceSyncShopsRunning.has(candidate.shop) ||
      global.__priceSyncManualShopsRunning.has(candidate.shop);
    if (isActiveInMemory) {
      continue;
    }

    const updated = await db.syncConfiguration.updateMany({
      where: {
        shop: candidate.shop,
        lastRunStatus: "running",
      },
      data: {
        lastRunStatus: "failed",
        lastError: "Recovered orphan running state before next scheduler tick",
        lastRunAt: now,
        currentScheduledStatus: "failed",
        currentScheduledUpdatedAt: now,
      },
    });
    if (updated.count > 0) {
      recovered += 1;
    }
  }

  return recovered;
}

export async function recoverStaleRunningStateForShop(
  shop: string,
  now = new Date(),
): Promise<boolean> {
  if (!global.__priceSyncShopsRunning || !global.__priceSyncManualShopsRunning) {
    return false;
  }

  const isActiveInMemory =
    global.__priceSyncShopsRunning.has(shop) ||
    global.__priceSyncManualShopsRunning.has(shop);
  if (isActiveInMemory) {
    return false;
  }

  const threshold = new Date(now.getTime() - RUN_LOCK_STALE_MS);
  const updated = await db.syncConfiguration.updateMany({
    where: {
      shop,
      lastRunStatus: "running",
      OR: [
        {
          currentScheduledUpdatedAt: {
            lte: threshold,
          },
        },
        {
          currentScheduledUpdatedAt: null,
          lastRunAt: {
            lte: threshold,
          },
        },
      ],
    },
    data: {
      lastRunStatus: "failed",
      lastError: "Recovered stale running state while loading sync status",
      lastRunAt: now,
      currentScheduledStatus: "failed",
      currentScheduledUpdatedAt: now,
    },
  });

  return updated.count > 0;
}

function getStaleRunThreshold(now = new Date()): Date {
  return new Date(now.getTime() - RUN_LOCK_STALE_MS);
}

function getRunnableFilter(now = new Date()) {
  return {
    OR: [
      { lastRunStatus: null },
      { lastRunStatus: { not: "running" } },
      { lastRunAt: { lt: getStaleRunThreshold(now) } },
    ],
  };
}

async function acquireRunLock(shop: string): Promise<boolean> {
  const now = new Date();
  const acquired = await db.syncConfiguration.updateMany({
    where: {
      shop,
      ...getRunnableFilter(now),
    },
    data: {
      lastRunAt: now,
      lastRunStatus: "running",
      lastError: null,
    },
  });
  return acquired.count > 0;
}

async function runScheduledSyncForShop(shop: string, options: SyncRunOptions) {
  if (!global.__priceSyncShopsRunning) {
    logScheduler("runner skipped: global running set unavailable", { shop });
    return;
  }
  const manualStatus = getStatusForKind(shop, "manual");
  if (manualStatus && (manualStatus.status === "queued" || manualStatus.status === "running")) {
    logScheduler("runner skipped: manual sync in progress", {
      shop,
      runKind: "scheduled",
      manualStatus: manualStatus.status,
      manualUpdatedAt: manualStatus.updatedAtUtc,
    });
    return;
  }
  const activeKindBefore = getActiveRunKind(shop);
  if (activeKindBefore === "manual") {
    logScheduler("runner waiting for active run to finish", {
      shop,
      runKind: "scheduled",
      activeKind: activeKindBefore,
      timeoutMs: SCHEDULED_WAIT_FOR_ACTIVE_RUN_TIMEOUT_MS,
      pollMs: SCHEDULED_WAIT_FOR_ACTIVE_RUN_POLL_MS,
    });
    const idle = await waitForShopToBeIdle(shop, SCHEDULED_WAIT_FOR_ACTIVE_RUN_TIMEOUT_MS);
    if (!idle) {
      logScheduler("runner skipped: timed out waiting for active run", {
        shop,
        runKind: "scheduled",
        activeKind: getActiveRunKind(shop),
      });
      return;
    }
  }
  const lockAcquiredInMemory = acquireInMemoryRunLock(shop, "scheduled");
  if (!lockAcquiredInMemory) {
    logScheduler("runner skipped: shop already running", {
      shop,
      runKind: "scheduled",
      activeKind: getActiveRunKind(shop),
    });
    return;
  }
  logScheduler("runner started", {
    shop,
    runKind: "scheduled",
    recurringPriceOnly: options.recurringPriceOnly,
    selectedProducts: options.selectedProductIds?.length ?? 0,
    maxProducts: options.maxProducts ?? null,
  });
  let runHistoryId: string | null = null;
  let runHistoryFinalized = false;
  let hasPersistableProgress = false;
  const aggregated = {
    catalogVariantsTotal: 0,
    variantsScanned: 0,
    cardsMatched: 0,
    pricesUpdated: 0,
    suspiciousCount: 0,
    metafieldsUpdated: 0,
    imagesUpdated: 0,
    skippedForMissingPrice: 0,
    previousPricesStored: 0,
    failures: [] as Array<{ variantId: string; reason: string }>,
    historyItems: [] as Array<{
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
    }>,
    scheduledCursorApplied: false,
    scheduledCursorWrapped: false,
    scheduledCursorSelectedProducts: 0,
    scheduledCursorTotalProducts: 0,
    nextScheduledCursorProductId: null as string | null,
    nextScheduledCursorProductUpdatedAt: null as string | null,
  };

  try {
    const lockAcquired = await acquireRunLock(shop);
    if (!lockAcquired) {
      logScheduler("runner skipped: db lock not acquired", {
        shop,
        runKind: "scheduled",
      });
      return;
    }
    const effectiveMaxProducts =
      typeof options.maxProducts === "number"
        ? options.maxProducts
        : SCHEDULED_SYNC_MAX_PRODUCTS_PER_RUN > 0
          ? SCHEDULED_SYNC_MAX_PRODUCTS_PER_RUN
          : undefined;
    runHistoryId = await startSyncRunHistory({
      shop,
      runKind: "scheduled",
      selectedProductsCount: options.selectedProductIds?.length ?? null,
      maxProducts: effectiveMaxProducts ?? null,
    });

    const ensuredToken = await resolveValidOfflineAccessTokenForShop({
      shop,
      runKind: "scheduled",
    });
    if (!ensuredToken.ok || !ensuredToken.accessToken) {
      const authMessage = ensuredToken.message ?? "Offline session token is invalid";
      logScheduler("runner failed: offline token validation failed", {
        shop,
        runKind: "scheduled",
        message: authMessage,
      });
      await markSyncRun({
        shop,
        success: false,
        message: authMessage,
      });
      if (runHistoryId) {
        await finishSyncRunHistory({
          runId: runHistoryId,
          shop,
          status: "failed",
          message: authMessage,
        });
        runHistoryFinalized = true;
      }
      return;
    }

    const config = await getOrCreateSyncConfiguration(shop);
    let admin = createRecoveringShopAdminClient({
      shop,
      runKind: "scheduled",
      accessToken: ensuredToken.accessToken,
    });
    logScheduler("shop config loaded", {
      shop,
      runKind: "scheduled",
      dailyTime: config.dailyTime,
      nextRunAt: config.nextRunAt?.toISOString() ?? null,
      enabled: config.enabled,
      scheduledCursorProductId: config.scheduledCursorProductId ?? null,
      scheduledCursorProductUpdatedAt:
        config.scheduledCursorProductUpdatedAt?.toISOString() ?? null,
      maxProducts: effectiveMaxProducts ?? null,
    });

    const shouldResumeScheduledProgress = Boolean(
      config.scheduledCursorProductId || config.scheduledCursorProductUpdatedAt,
    );
    const resumedProcessedVariants = shouldResumeScheduledProgress
      ? toSafeNonNegativeInt(config.currentScheduledProcessedVariants)
      : 0;
    const resumedCardsMatched = shouldResumeScheduledProgress
      ? Math.min(
          toSafeNonNegativeInt(config.currentScheduledCardsMatched),
          resumedProcessedVariants,
        )
      : 0;
    const resumedPricesUpdated = shouldResumeScheduledProgress
      ? Math.min(
          toSafeNonNegativeInt(config.currentScheduledPricesUpdated),
          resumedCardsMatched,
        )
      : 0;
    const resumedSkippedForMissingPrice = shouldResumeScheduledProgress
      ? toSafeNonNegativeInt(config.currentScheduledSkippedForMissingPrice)
      : 0;
    const resumedFailures = shouldResumeScheduledProgress
      ? toSafeNonNegativeInt(config.currentScheduledFailures)
      : 0;
    const resumedSuspiciousCount = shouldResumeScheduledProgress
      ? toSafeNonNegativeInt(config.currentScheduledSuspiciousCount)
      : 0;
    const resumedTotalVariants = shouldResumeScheduledProgress
      ? Math.max(
          resumedProcessedVariants,
          toSafeNonNegativeInt(config.currentScheduledTotalVariants, resumedProcessedVariants),
        )
      : 0;
    const runStartedAt =
      shouldResumeScheduledProgress && config.currentScheduledStartedAt
        ? config.currentScheduledStartedAt
        : new Date();
    const initialTotalBlocks =
      typeof config.currentScheduledTotalBlocks === "number" &&
      Number.isFinite(config.currentScheduledTotalBlocks) &&
      config.currentScheduledTotalBlocks > 0
        ? Math.floor(config.currentScheduledTotalBlocks)
        : 1;
    const initialProcessedBlocks = shouldResumeScheduledProgress
      ? Math.max(1, toSafeNonNegativeInt(config.currentScheduledProcessedBlocks, 1))
      : 1;
    const initialRemainingBlocks = shouldResumeScheduledProgress
      ? toSafeNonNegativeInt(
          config.currentScheduledRemainingBlocks,
          Math.max(initialTotalBlocks - initialProcessedBlocks, 0),
        )
      : Math.max(initialTotalBlocks - 1, 0);
    await updateSyncConfigurationWithCompat({
      shop,
      data: {
        currentScheduledStatus: "running",
        currentScheduledStartedAt: runStartedAt,
        currentScheduledUpdatedAt: runStartedAt,
        currentScheduledTotalVariants: shouldResumeScheduledProgress
          ? resumedTotalVariants
          : null,
        currentScheduledProcessedVariants: resumedProcessedVariants,
        currentScheduledCardsMatched: resumedCardsMatched,
        currentScheduledPricesUpdated: resumedPricesUpdated,
        currentScheduledSkippedForMissingPrice: resumedSkippedForMissingPrice,
        currentScheduledFailures: resumedFailures,
        currentScheduledSuspiciousCount: resumedSuspiciousCount,
        currentScheduledTotalBlocks: initialTotalBlocks,
        currentScheduledProcessedBlocks: initialProcessedBlocks,
        currentScheduledRemainingBlocks: initialRemainingBlocks,
      },
    });

    let chunkCursorProductId = config.scheduledCursorProductId ?? null;
    let chunkCursorProductUpdatedAt = config.scheduledCursorProductUpdatedAt?.toISOString() ?? null;
    let chunkNumber = 0;
    const seenCursors = new Set<string>();
    const processedProductIdsInRun = new Set<string>();
    aggregated.catalogVariantsTotal = resumedTotalVariants;
    aggregated.variantsScanned = resumedProcessedVariants;
    aggregated.cardsMatched = resumedCardsMatched;
    aggregated.pricesUpdated = resumedPricesUpdated;
    aggregated.suspiciousCount = resumedSuspiciousCount;
    aggregated.skippedForMissingPrice = resumedSkippedForMissingPrice;
    hasPersistableProgress = hasAnySyncProgress(aggregated);

    while (true) {
      chunkNumber += 1;
      const currentCursorKey = `${chunkCursorProductId ?? "null"}|${chunkCursorProductUpdatedAt ?? "null"}`;
      if (seenCursors.has(currentCursorKey)) {
        throw new Error(
          `Scheduled cursor loop detected at chunk ${chunkNumber} (cursor ${currentCursorKey})`,
        );
      }
      seenCursors.add(currentCursorKey);

      const baseProcessedVariants = aggregated.variantsScanned;
      const baseCardsMatched = aggregated.cardsMatched;
      const baseSuspiciousCount = aggregated.suspiciousCount;
      const baseSkipped = aggregated.skippedForMissingPrice;
      const baseFailures = aggregated.failures.length;

      let chunkResult: Awaited<ReturnType<typeof syncCatalogWithScryfall>> | null = null;
      let tokenRetryDone = false;
      for (
        let throttleAttempt = 0;
        throttleAttempt <= SCHEDULED_THROTTLE_MAX_RETRIES;
        throttleAttempt += 1
      ) {
        try {
          chunkResult = await syncCatalogWithScryfall({
            shop,
            admin,
            preferences: toSyncPreferences(config),
            recurringPriceOnly: options.recurringPriceOnly,
            selectedProductIds: options.selectedProductIds,
            excludedProductIds:
              options.selectedProductIds && options.selectedProductIds.length > 0
                ? options.excludedProductIds
                : Array.from(processedProductIdsInRun),
            maxProducts: effectiveMaxProducts,
            scheduledCursor: {
              productId: chunkCursorProductId,
              productUpdatedAt: chunkCursorProductUpdatedAt,
            },
            onProgress: async (progress) => {
              const currentTotalVariants = Math.max(
                aggregated.catalogVariantsTotal,
                baseProcessedVariants + progress.totalVariants,
              );
              const currentVariantsScanned = Math.min(
                baseProcessedVariants + progress.processedVariants,
                currentTotalVariants,
              );
              const currentCardsMatched = Math.min(
                baseCardsMatched + progress.cardsMatched,
                currentVariantsScanned,
              );
              const currentPricesUpdated = Math.min(
                aggregated.pricesUpdated + (progress.pricesUpdated ?? 0),
                currentCardsMatched,
              );
              const currentFailures = baseFailures + progress.failures;
              const currentSuspiciousCount = Math.min(
                baseSuspiciousCount + progress.suspiciousCount,
                currentCardsMatched,
              );
              await updateSyncConfigurationWithCompat({
                shop,
                data: {
                  currentScheduledStatus: "running",
                  currentScheduledUpdatedAt: new Date(),
                  currentScheduledTotalVariants: currentTotalVariants,
                  currentScheduledProcessedVariants: currentVariantsScanned,
                  currentScheduledCardsMatched: currentCardsMatched,
                  currentScheduledPricesUpdated: currentPricesUpdated,
                  currentScheduledSkippedForMissingPrice:
                    baseSkipped + progress.skippedForMissingPrice,
                  currentScheduledFailures: currentFailures,
                  currentScheduledSuspiciousCount: currentSuspiciousCount,
                },
              });
              if (runHistoryId) {
                await updateSyncRunHistoryProgress({
                  runId: runHistoryId,
                  summary: {
                    variantsScanned: currentVariantsScanned,
                    cardsMatched: currentCardsMatched,
                    pricesUpdated: currentPricesUpdated,
                    failuresCount: currentFailures,
                  },
                });
              }
              hasPersistableProgress = true;
            },
            progressEvery: SYNC_PROGRESS_EVERY_VARIANTS,
          });
          break;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (
            SHOPIFY_OFFLINE_TOKEN_INVALID_RE.test(message) &&
            !tokenRetryDone
          ) {
            tokenRetryDone = true;
            logScheduler("runner chunk retrying after invalid offline token", {
              shop,
              runKind: "scheduled",
              chunk: chunkNumber,
              message,
            });
            const refreshed = await resolveValidOfflineAccessTokenForShop({
              shop,
              runKind: "scheduled",
            });
            if (!refreshed.ok || !refreshed.accessToken) {
              throw error;
            }
            admin = createRecoveringShopAdminClient({
              shop,
              runKind: "scheduled",
              accessToken: refreshed.accessToken,
            });
            throttleAttempt -= 1;
            continue;
          }
          const canRetryThrottle =
            isThrottleErrorMessage(message) && throttleAttempt < SCHEDULED_THROTTLE_MAX_RETRIES;
          if (!canRetryThrottle) {
            throw error;
          }
          const retryDelayMs = SCHEDULED_THROTTLE_RETRY_BASE_MS * (throttleAttempt + 1);
          logScheduler("runner chunk throttled, retrying", {
            shop,
            runKind: "scheduled",
            chunk: chunkNumber,
            attempt: throttleAttempt + 1,
            retryInMs: retryDelayMs,
            message,
          });
          await sleep(retryDelayMs);
        }
      }
      if (!chunkResult) {
        throw new Error("Chunk sync failed after throttled retries");
      }

      aggregated.catalogVariantsTotal = Math.max(
        aggregated.catalogVariantsTotal,
        chunkResult.catalogVariantsTotal,
      );
      aggregated.variantsScanned =
        aggregated.catalogVariantsTotal > 0
          ? Math.min(
              aggregated.variantsScanned + chunkResult.variantsScanned,
              aggregated.catalogVariantsTotal,
            )
          : aggregated.variantsScanned + chunkResult.variantsScanned;
      aggregated.cardsMatched = Math.min(
        aggregated.cardsMatched + chunkResult.cardsMatched,
        aggregated.variantsScanned,
      );
      aggregated.pricesUpdated = Math.min(
        aggregated.pricesUpdated + chunkResult.pricesUpdated,
        aggregated.cardsMatched,
      );
      aggregated.suspiciousCount += chunkResult.suspiciousCount;
      aggregated.metafieldsUpdated += chunkResult.metafieldsUpdated;
      aggregated.imagesUpdated += chunkResult.imagesUpdated;
      aggregated.skippedForMissingPrice += chunkResult.skippedForMissingPrice;
      aggregated.previousPricesStored += chunkResult.previousPricesStored;
      aggregated.failures.push(...chunkResult.failures);
      aggregated.historyItems.push(...chunkResult.historyItems);
      for (const item of chunkResult.historyItems) {
        if (item.productId) {
          processedProductIdsInRun.add(item.productId);
        }
      }
      aggregated.scheduledCursorApplied = chunkResult.scheduledCursorApplied;
      aggregated.scheduledCursorWrapped = chunkResult.scheduledCursorWrapped;
      aggregated.scheduledCursorSelectedProducts = chunkResult.scheduledCursorSelectedProducts;
      aggregated.scheduledCursorTotalProducts = chunkResult.scheduledCursorTotalProducts;
      aggregated.nextScheduledCursorProductId = chunkResult.nextScheduledCursorProductId;
      aggregated.nextScheduledCursorProductUpdatedAt =
        chunkResult.nextScheduledCursorProductUpdatedAt;

      const hasMoreChunks = Boolean(chunkResult.nextScheduledCursorProductId);
      const totalBlocksEstimate =
        typeof effectiveMaxProducts === "number" &&
        effectiveMaxProducts > 0 &&
        chunkResult.scheduledCursorTotalProducts > 0
          ? Math.max(1, Math.ceil(chunkResult.scheduledCursorTotalProducts / effectiveMaxProducts))
          : null;
      const processedBlocks = totalBlocksEstimate
        ? Math.min(chunkNumber, totalBlocksEstimate)
        : chunkNumber;
      const totalBlocksForDisplay = totalBlocksEstimate
        ? Math.max(totalBlocksEstimate, processedBlocks)
        : hasMoreChunks
          ? processedBlocks + 1
          : processedBlocks;
      const remainingBlocks = hasMoreChunks
        ? Math.max(totalBlocksForDisplay - processedBlocks, 1)
        : 0;
      logScheduler("runner chunk sync outcome", {
        shop,
        runKind: "scheduled",
        chunk: chunkNumber,
        recurringPriceOnly: options.recurringPriceOnly,
        hasMoreChunks,
        totalBlocksEstimate: totalBlocksForDisplay,
        processedBlocks,
        remainingBlocks,
        ...summarizeSyncResult(chunkResult),
        scheduledCursorApplied: chunkResult.scheduledCursorApplied,
        scheduledCursorWrapped: chunkResult.scheduledCursorWrapped,
        scheduledCursorSelectedProducts: chunkResult.scheduledCursorSelectedProducts,
        scheduledCursorTotalProducts: chunkResult.scheduledCursorTotalProducts,
        nextScheduledCursorProductId: chunkResult.nextScheduledCursorProductId,
        nextScheduledCursorProductUpdatedAt: chunkResult.nextScheduledCursorProductUpdatedAt,
      });

      chunkCursorProductId = chunkResult.nextScheduledCursorProductId;
      chunkCursorProductUpdatedAt = chunkResult.nextScheduledCursorProductUpdatedAt;

      await updateSyncConfigurationWithCompat({
        shop,
        data: {
          scheduledCursorProductId: chunkCursorProductId,
          scheduledCursorProductUpdatedAt: chunkCursorProductUpdatedAt
            ? new Date(chunkCursorProductUpdatedAt)
            : null,
          currentScheduledUpdatedAt: new Date(),
          currentScheduledStatus: "running",
          currentScheduledTotalVariants: Math.max(
            aggregated.catalogVariantsTotal,
            aggregated.variantsScanned,
          ),
          currentScheduledProcessedVariants: aggregated.variantsScanned,
          currentScheduledCardsMatched: aggregated.cardsMatched,
          currentScheduledPricesUpdated: aggregated.pricesUpdated,
          currentScheduledSkippedForMissingPrice: aggregated.skippedForMissingPrice,
          currentScheduledFailures: aggregated.failures.length,
          currentScheduledSuspiciousCount: aggregated.suspiciousCount,
          currentScheduledTotalBlocks: totalBlocksForDisplay,
          currentScheduledProcessedBlocks: processedBlocks,
          currentScheduledRemainingBlocks: remainingBlocks,
        },
      });
      hasPersistableProgress = hasAnySyncProgress(aggregated);

      if (!hasMoreChunks) {
        break;
      }
    }

    logScheduler("runner sync outcome", {
      shop,
      runKind: "scheduled",
      recurringPriceOnly: options.recurringPriceOnly,
      chunksProcessed: chunkNumber,
      ...summarizeSyncResult(aggregated),
      scheduledCursorApplied: aggregated.scheduledCursorApplied,
      scheduledCursorWrapped: aggregated.scheduledCursorWrapped,
      scheduledCursorSelectedProducts: aggregated.scheduledCursorSelectedProducts,
      scheduledCursorTotalProducts: aggregated.scheduledCursorTotalProducts,
      nextScheduledCursorProductId: aggregated.nextScheduledCursorProductId,
      nextScheduledCursorProductUpdatedAt: aggregated.nextScheduledCursorProductUpdatedAt,
    });

    await markSyncRun({ shop, success: true, summary: aggregated });
    if (runHistoryId) {
      await finishSyncRunHistory({
        runId: runHistoryId,
        shop,
        status: "success",
        summary: aggregated,
      });
      runHistoryFinalized = true;
    }
    logPriceImpactValidation({
      shop,
      runKind: "scheduled",
      variantsScanned: aggregated.variantsScanned,
      cardsMatched: aggregated.cardsMatched,
      pricesUpdated: aggregated.pricesUpdated,
    });
    await updateSyncConfigurationWithCompat({
      shop,
      data: {
        currentScheduledTotalBlocks:
          typeof effectiveMaxProducts === "number" &&
          effectiveMaxProducts > 0 &&
          aggregated.scheduledCursorTotalProducts > 0
            ? Math.max(
                1,
                Math.ceil(aggregated.scheduledCursorTotalProducts / effectiveMaxProducts),
              )
            : chunkNumber,
        currentScheduledProcessedBlocks:
          typeof effectiveMaxProducts === "number" &&
          effectiveMaxProducts > 0 &&
          aggregated.scheduledCursorTotalProducts > 0
            ? Math.max(
                1,
                Math.ceil(aggregated.scheduledCursorTotalProducts / effectiveMaxProducts),
              )
            : chunkNumber,
        currentScheduledRemainingBlocks: 0,
      },
    });
    logScheduler("runner completed successfully", { shop, runKind: "scheduled" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    logScheduler("runner failed", { shop, runKind: "scheduled", message });
    const partialSummary = hasPersistableProgress ? aggregated : undefined;
    if (runHistoryId && !runHistoryFinalized) {
      await finishSyncRunHistory({
        runId: runHistoryId,
        shop,
        status: "failed",
        message,
        summary: partialSummary,
      });
      runHistoryFinalized = true;
    }
    await markSyncRun({
      shop,
      success: false,
      message,
      summary: partialSummary,
    });
  } finally {
    if (runHistoryId && !runHistoryFinalized) {
      await finishSyncRunHistory({
        runId: runHistoryId,
        shop,
        status: "failed",
        message: "Run exited unexpectedly before completion",
      });
    }
    releaseInMemoryRunLock(shop);
    logScheduler("runner finished (lock released)", { shop, runKind: "scheduled" });
  }
}

async function runManualSyncForShop(
  shop: string,
  options?: {
    selectedProductIds?: string[];
    maxProducts?: number;
    kind?: ManualSyncKind;
  },
) {
  if (!global.__priceSyncManualShopsRunning || !global.__priceSyncShopsRunning) {
    logScheduler("manual runner skipped: running set unavailable", { shop });
    return;
  }
  const manualKind = normalizeManualKind(options?.kind);
  const lockAcquiredInMemory = acquireInMemoryRunLock(shop, manualKind);
  if (!lockAcquiredInMemory) {
    logScheduler("manual runner skipped: shop already running", {
      shop,
      runKind: manualKind,
      activeKind: getActiveRunKind(shop),
    });
    return;
  }
  const nowIso = new Date().toISOString();
  setStatusForKind({
    shop,
    kind: manualKind,
    status: "running",
    startedAtUtc: nowIso,
    progress: {
      phase: "scanning",
      totalVariants: null,
      processedVariants: 0,
      cardsMatched: 0,
      pricesUpdated: 0,
      imagesUpdated: 0,
      skippedForMissingPrice: 0,
      suspiciousCount: 0,
      failures: 0,
    },
  });
  logScheduler("manual runner started", {
    shop,
    runKind: manualKind,
    selectedProducts: options?.selectedProductIds?.length ?? 0,
    maxProducts: options?.maxProducts ?? null,
  });
  let runHistoryId: string | null = null;
  let runHistoryFinalized = false;

  try {
    runHistoryId = await startSyncRunHistory({
      shop,
      runKind: manualKind,
      selectedProductsCount: options?.selectedProductIds?.length ?? null,
      maxProducts: options?.maxProducts ?? null,
    });
    const ensuredToken = await resolveValidOfflineAccessTokenForShop({
      shop,
      runKind: manualKind,
    });
    if (!ensuredToken.ok || !ensuredToken.accessToken) {
      const authMessage = ensuredToken.message ?? "Offline session token is invalid";
      logScheduler("manual runner failed: offline token validation failed", {
        shop,
        runKind: manualKind,
        message: authMessage,
      });
      if (runHistoryId) {
        await finishSyncRunHistory({
          runId: runHistoryId,
          shop,
          status: "failed",
          message: authMessage,
        });
        runHistoryFinalized = true;
      }
      setStatusForKind({
        shop,
        kind: manualKind,
        status: "failed",
        message: authMessage,
      });
      return;
    }

    const config = await getOrCreateSyncConfiguration(shop);
    const runSync = (accessToken: string) =>
      syncCatalogWithScryfall({
        shop,
        admin: createRecoveringShopAdminClient({
          shop,
          runKind: manualKind,
          accessToken,
        }),
        preferences: toSyncPreferences(config),
        recurringPriceOnly: false,
        selectedProductIds: options?.selectedProductIds,
        maxProducts: options?.maxProducts,
        onProgress: async (progress) => {
          setStatusForKind({
            shop,
            kind: manualKind,
            status: "running",
            startedAtUtc: nowIso,
            progress: {
              phase: progress.phase ?? "scanning",
              totalVariants: progress.totalVariants,
              processedVariants: progress.processedVariants,
              cardsMatched: progress.cardsMatched,
              pricesUpdated: progress.pricesUpdated,
              imagesUpdated: progress.imagesUpdated,
              skippedForMissingPrice: progress.skippedForMissingPrice,
              suspiciousCount: progress.suspiciousCount,
              failures: progress.failures,
            },
          });
          if (runHistoryId) {
            await updateSyncRunHistoryProgress({
              runId: runHistoryId,
              summary: {
                variantsScanned: progress.processedVariants,
                cardsMatched: progress.cardsMatched,
                pricesUpdated: progress.pricesUpdated ?? 0,
                failuresCount: progress.failures,
              },
            });
          }
        },
        progressEvery: SYNC_PROGRESS_EVERY_VARIANTS,
      });

    let result;
    try {
      result = await runSync(ensuredToken.accessToken);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!SHOPIFY_OFFLINE_TOKEN_INVALID_RE.test(message)) {
        throw error;
      }
      logScheduler("manual runner retrying after invalid offline token", {
        shop,
        runKind: manualKind,
        message,
      });
      const refreshed = await resolveValidOfflineAccessTokenForShop({
        shop,
        runKind: manualKind,
      });
      if (!refreshed.ok || !refreshed.accessToken) {
        throw error;
      }
      result = await runSync(refreshed.accessToken);
    }
    logScheduler("manual runner sync outcome", {
      shop,
      runKind: manualKind,
      ...summarizeSyncResult(result),
    });
    if (runHistoryId) {
      await finishSyncRunHistory({
        runId: runHistoryId,
        shop,
        status: "success",
        summary: result,
      });
      runHistoryFinalized = true;
    }
    logPriceImpactValidation({
      shop,
      runKind: manualKind,
      variantsScanned: result.variantsScanned,
      cardsMatched: result.cardsMatched,
      pricesUpdated: result.pricesUpdated,
    });

    logScheduler("manual runner completed successfully", { shop, runKind: manualKind });
    setStatusForKind({
      shop,
      kind: manualKind,
      status: "success",
      startedAtUtc: nowIso,
      progress: {
        phase: "completed",
        totalVariants: result.variantsScanned,
        processedVariants: result.variantsScanned,
        cardsMatched: result.cardsMatched,
        pricesUpdated: result.pricesUpdated,
        imagesUpdated: result.imagesUpdated,
        skippedForMissingPrice: result.skippedForMissingPrice,
        suspiciousCount: result.suspiciousCount,
        failures: result.failures.length,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error";
    logScheduler("manual runner failed", { shop, runKind: manualKind, message });
    if (runHistoryId && !runHistoryFinalized) {
      await finishSyncRunHistory({
        runId: runHistoryId,
        shop,
        status: "failed",
        message,
      });
      runHistoryFinalized = true;
    }
    setStatusForKind({
      shop,
      kind: manualKind,
      status: "failed",
      message,
      startedAtUtc: nowIso,
    });
  } finally {
    if (runHistoryId && !runHistoryFinalized) {
      await finishSyncRunHistory({
        runId: runHistoryId,
        shop,
        status: "failed",
        message: "Manual run exited unexpectedly before completion",
      });
    }
    releaseInMemoryRunLock(shop);
    logScheduler("manual runner finished (lock released)", {
      shop,
      runKind: manualKind,
    });
  }
}

export async function runSchedulerTickOnce(params?: {
  trigger?: "http" | "interval" | "manual";
}): Promise<{
  dueCount: number;
  processed: number;
  nextDueAtUtc: string | null;
  nextDueShop: string | null;
  secondsUntilNextDue: number | null;
}> {
  const now = new Date();
  const trigger = params?.trigger ?? "manual";
  const recoveredOrphans = await recoverOrphanRunningShops(now);
  const nextDueBefore = await getNextDueSnapshot(now);
  logScheduler("tick start", { nowUtc: now.toISOString(), trigger });
  if (recoveredOrphans > 0) {
    logScheduler("tick orphan recovery", { recoveredOrphans });
  }
  logScheduler("tick next due snapshot", {
    nextDueShop: nextDueBefore?.shop ?? null,
    nextDueAtUtc: nextDueBefore?.nextRunAtUtc ?? null,
    secondsUntilNextDue: nextDueBefore?.secondsUntil ?? null,
  });
  try {
    const cardKingdomShopsCount = await db.syncConfiguration.count({
      where: {
        priceSource: "cardkingdom",
      },
    });
    if (cardKingdomShopsCount > 0) {
      const cardKingdomCache = await refreshCardKingdomPriceCacheIfDue();
      if (cardKingdomCache.attempted || cardKingdomCache.reason !== "not_due") {
        logScheduler("tick cardkingdom cache", {
          ...cardKingdomCache,
          cardKingdomShopsCount,
        });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logScheduler("tick cardkingdom cache failed", { message });
  }
  const due = await db.syncConfiguration.findMany({
    where: {
      enabled: true,
      nextRunAt: {
        lte: now,
      },
      ...getRunnableFilter(now),
    },
    select: { shop: true, dailyTime: true, nextRunAt: true, lastRunStatus: true },
    orderBy: { nextRunAt: "asc" },
  });
  logScheduler("tick due shops", {
    count: due.length,
    shops: due.map((item) => ({
      shop: item.shop,
      dailyTime: item.dailyTime,
      nextRunAt: item.nextRunAt?.toISOString() ?? null,
      lastRunStatus: item.lastRunStatus ?? null,
    })),
  });

  const workerCount = Math.min(SCHEDULED_SHOP_CONCURRENCY, due.length || 1);
  const workers = Array.from({ length: workerCount }, async (_, workerIndex) => {
    let localProcessed = 0;
    for (let index = workerIndex; index < due.length; index += workerCount) {
      const item = due[index];
      await runScheduledSyncForShop(item.shop, {
        recurringPriceOnly: false,
      });
      localProcessed += 1;
    }
    return localProcessed;
  });
  const processedByWorker = await Promise.all(workers);
  const processed = processedByWorker.reduce((sum, value) => sum + value, 0);
  const nextDueAfter = await getNextDueSnapshot(new Date());
  logScheduler("tick end", { processed });
  return {
    dueCount: due.length,
    processed,
    nextDueAtUtc: nextDueAfter?.nextRunAtUtc ?? null,
    nextDueShop: nextDueAfter?.shop ?? null,
    secondsUntilNextDue: nextDueAfter?.secondsUntil ?? null,
  };
}

export async function enqueueManualSyncForShop(
  shop: string,
  options?: {
    selectedProductIds?: string[];
    maxProducts?: number;
    kind?: ManualSyncKind;
  },
): Promise<{ queued: boolean }> {
  if (
    !global.__priceSyncShopsRunning ||
    !global.__priceSyncManualShopsRunning ||
    !global.__priceSyncActiveRunKindByShop
  ) {
    logScheduler("manual enqueue rejected: global running set unavailable", { shop });
    return { queued: false };
  }

  if (
    global.__priceSyncShopsRunning.has(shop) ||
    global.__priceSyncManualShopsRunning.has(shop) ||
    global.__priceSyncActiveRunKindByShop.has(shop)
  ) {
    const kind = normalizeManualKind(options?.kind);
    logScheduler("manual enqueue rejected: shop already running", {
      shop,
      runKind: kind,
      activeKind: getActiveRunKind(shop),
    });
    return { queued: false };
  }

  const kind = normalizeManualKind(options?.kind);
  logScheduler("manual enqueue accepted", {
    shop,
    runKind: kind,
    selectedProducts: options?.selectedProductIds?.length ?? 0,
    maxProducts: options?.maxProducts ?? null,
  });
  setStatusForKind({
    shop,
    kind,
    status: "queued",
    startedAtUtc: new Date().toISOString(),
    progress: {
      phase: null,
      totalVariants: null,
      processedVariants: 0,
      cardsMatched: 0,
      pricesUpdated: 0,
      imagesUpdated: 0,
      skippedForMissingPrice: 0,
      suspiciousCount: 0,
      failures: 0,
    },
  });
  void runManualSyncForShop(shop, {
    selectedProductIds: options?.selectedProductIds,
    maxProducts: options?.maxProducts,
    kind,
  });

  return { queued: true };
}

export function getManualSyncStatusForShop(shop: string): ManualSyncStatus | null {
  return getStatusForKind(shop, "manual");
}

export function getTestSyncStatusForShop(shop: string): ManualSyncStatus | null {
  return getStatusForKind(shop, "test");
}

export function clearInMemorySyncStatusForShop(shop: string) {
  global.__priceSyncManualStatusByShop?.delete(shop);
  global.__priceSyncTestStatusByShop?.delete(shop);
}

export function startPriceSyncScheduler() {
  if (CARDKINGDOM_WARMUP_ON_BOOT) {
    void (async () => {
      try {
        const delegate = (
          db as unknown as {
            cardKingdomPriceCache?: { count: (args?: Record<string, unknown>) => Promise<number> };
          }
        ).cardKingdomPriceCache;
        if (!delegate) {
          return;
        }
        let currentRows = 0;
        try {
          currentRows = await delegate.count();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/CardKingdomPriceCache|card_kingdom_price_cache|no such table/i.test(message)) {
            return;
          }
          throw error;
        }
        if (currentRows > 0) {
          logScheduler("cardkingdom warmup skipped (cache already present)", {
            currentRows,
          });
          return;
        }
        const warmupResult = await refreshCardKingdomPriceCacheIfDue({ force: true });
        logScheduler("cardkingdom warmup completed", warmupResult);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logScheduler("cardkingdom warmup failed", { message });
      }
    })();
  }

  const mode = process.env.SYNC_SCHEDULER_MODE ?? "http";
  if (mode !== "interval") {
    logScheduler("scheduler interval disabled (using external HTTP tick mode)", { mode });
    return;
  }

  if (global.__priceSyncSchedulerStarted) {
    logScheduler("scheduler already started");
    return;
  }
  global.__priceSyncSchedulerStarted = true;
  logScheduler("scheduler started", { checkIntervalMs: CHECK_INTERVAL_MS });

  // Fire once at boot and then poll every minute.
  triggerSchedulerTickInBackground({ trigger: "interval" });
  setInterval(() => {
    triggerSchedulerTickInBackground({ trigger: "interval" });
  }, CHECK_INTERVAL_MS);
}

export function triggerSchedulerTickInBackground(params?: {
  trigger?: "http" | "interval" | "manual";
}): { started: boolean } {
  if (global.__priceSyncTickInFlight) {
    global.__priceSyncTickRequested = true;
    return { started: false };
  }

  global.__priceSyncTickInFlight = true;
  global.__priceSyncTickRequested = false;
  void runSchedulerTickOnce({ trigger: params?.trigger ?? "manual" })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      logScheduler("tick background failed", { trigger: params?.trigger ?? "manual", message });
    })
    .finally(() => {
      global.__priceSyncTickInFlight = false;
      if (global.__priceSyncTickRequested) {
        global.__priceSyncTickRequested = false;
        setTimeout(() => {
          triggerSchedulerTickInBackground({ trigger: params?.trigger ?? "manual" });
        }, 0);
      }
    });

  return { started: true };
}
