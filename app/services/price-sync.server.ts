import db from "../db.server";
import { randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { matchCardForVariant } from "./price-sync-matchers/index.server";
import {
  doesScryfallIdExistForValidation,
  normalizeScryfallIdentifier,
} from "./price-sync-matchers/scryfall-api.server";
import {
  hasCustomScryfallIdentifierCandidate,
  resolveCustomScryfallIdentifier,
} from "./price-sync-matchers/custom-field.server";
import { resolveSkuForLookup } from "./price-sync-matchers/sku.server";
import type { ScryfallCard } from "./price-sync-matchers/types";
import type { AdminGraphqlClient } from "./shopify/admin-client.server";
import { writeSyncLog } from "./sync-log.server";

export type SearchMode = "sku" | "title" | "metafield";
export type PriceSource = "scryfall" | "justtcg" | "mtgjson" | "cardkingdom";
export type DisplayCurrency = "USD" | "CLP";
export type PriceAdjustmentMode = "percent" | "fixed";
const USD_CLP_PAIR = "USD_CLP";

export type SyncPreferences = {
  searchMode: SearchMode;
  searchMetafieldNamespace: string;
  searchMetafieldKey: string;
  useCustomScryfallIdField: boolean;
  allowProductLevelCustomScryfallFallback: boolean;
  customScryfallIdNs: string;
  customScryfallIdKey: string;
  priceSource: PriceSource;
  justTcgApiKey: string;
  mtgjsonApiKey: string;
  displayCurrency: DisplayCurrency;
  priceAdjustmentMode: PriceAdjustmentMode;
  priceAdjustmentPercent: number;
  priceAdjustmentFixed: number;
  minimumPrice: number;
  disableSuspiciousPriceAlert: boolean;
  suspiciousPriceAlertThresholdPercent: number;
  scryfallMetafieldNs: string;
  scryfallMetafieldKey: string;
  syncImage: boolean;
  metadataInitialized: boolean;
  imageSyncInitialized: boolean;
};

export type SyncRunResult = {
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
  scheduledCursorApplied: boolean;
  scheduledCursorWrapped: boolean;
  scheduledCursorSelectedProducts: number;
  scheduledCursorTotalProducts: number;
  nextScheduledCursorProductId: string | null;
  nextScheduledCursorProductUpdatedAt: string | null;
  historyItems: SyncRunHistoryItemResult[];
};

export type SyncRunHistoryItemResult = {
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
};

type ScheduledProductCursor = {
  productId: string | null;
  productUpdatedAt: string | null;
};

export type CustomScryfallIdCheckResult = {
  variantsScanned: number;
  variantsWithCustomId: number;
  variantsFoundInScryfall: number;
  productsWithCustomId: number;
  productsFoundInScryfall: number;
  notFoundInScryfall: number;
};

type MetafieldUpdateInput = {
  ownerId: string;
  namespace: string;
  key: string;
  value: string;
  type?: "single_line_text_field" | "number_decimal";
};

type ImageSyncQueueJob = {
  id: string;
  shop: string;
  productId: string;
  scryfallId: string | null;
  imageUrl: string;
  fingerprint: string;
  status: string;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  lockedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

type MetafieldNode = {
  namespace: string;
  key: string;
  value: string;
  type?: string | null;
};

type MetafieldConnection = {
  edges: Array<{
    node: MetafieldNode;
  }>;
};

function parseSafeDiagnosticEvery(rawValue: string | undefined): number {
  const value = Number(rawValue ?? "50");
  if (!Number.isFinite(value) || value <= 0) {
    return 50;
  }
  return Math.max(10, Math.floor(value));
}

function isRateLimitOrTimeoutReason(reason: string): boolean {
  return /(429|rate\s*limit|timeout|timed?\s*out|ETIMEDOUT|UND_ERR|ECONNRESET|fetch failed)/i.test(
    reason,
  );
}

function getTopFailureReasons(
  reasons: Map<string, number>,
  limit = 5,
): Array<{ reason: string; count: number }> {
  return Array.from(reasons.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([reason, count]) => ({ reason, count }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function getDynamicOperationTimeoutMs(itemCount: number): number {
  const safeItemCount = Number.isFinite(itemCount) && itemCount > 0 ? Math.floor(itemCount) : 0;
  const computedTimeout =
    SHOPIFY_OPERATION_TIMEOUT_MS + safeItemCount * SHOPIFY_OPERATION_TIMEOUT_PER_ITEM_MS;
  return Math.min(SHOPIFY_OPERATION_TIMEOUT_MAX_MS, computedTimeout);
}

function isRetryableShopifyMetafieldError(message: string): boolean {
  return /(throttle|rate limit|timeout|internal|temporar|try again|busy)/i.test(message);
}

function isRetryableShopifyMutationError(message: string): boolean {
  return /(throttle|rate limit|timeout|internal|temporar|try again|busy|429|5\d\d|UND_ERR|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|request to .* failed)/i.test(message);
}

function isMetafieldTypeConflict(message: string): boolean {
  return /(type|single_line_text_field|number_decimal|must be)/i.test(message);
}

type ProductImageSyncOutcome = {
  ok: boolean;
  changed: boolean;
  reason?: string;
};

function toImageFingerprint(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    const normalizedPath = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath}`.toLowerCase();
  } catch {
    return null;
  }
}

function isScryfallHostedImage(rawUrl: string | null | undefined): boolean {
  if (!rawUrl) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.endsWith("scryfall.io");
  } catch {
    return false;
  }
}

type VariantNode = {
  id: string;
  sku: string | null;
  title: string;
  price: string;
  customMetafields?: MetafieldConnection;
  product: {
    id: string;
    title: string;
    updatedAt?: string | null;
    totalVariants: number;
    customMetafields?: MetafieldConnection;
    variants: {
      edges: Array<{
        node: {
          sku: string | null;
        };
      }>;
    };
    scryfallIdField: { value: string } | null;
    customScryfallIdField: { value: string } | null;
    foilField: { value: string } | null;
  };
  lookupField: { value: string } | null;
  scryfallIdField: { value: string } | null;
  customScryfallIdField: { value: string } | null;
  foilField: { value: string } | null;
};

type VariantWithCustomScryfallId = {
  id?: string;
  customMetafields?: MetafieldConnection;
  product: {
    id: string;
    title?: string;
    totalVariants?: number;
    customMetafields?: MetafieldConnection;
    customScryfallIdField: { value: string } | null;
  };
  customScryfallIdField: { value: string } | null;
};

type CustomIdValidationVariantNode = VariantWithCustomScryfallId;

function getGraphqlErrorMessages(rawErrors: unknown): string[] {
  if (!rawErrors) {
    return [];
  }

  if (typeof rawErrors === "string") {
    const message = rawErrors.trim();
    return message ? [message] : [];
  }

  if (Array.isArray(rawErrors)) {
    return rawErrors
      .map((item) => {
        if (item && typeof item === "object" && "message" in item) {
          const message = (item as { message?: unknown }).message;
          if (typeof message === "string" && message.trim().length > 0) {
            return message;
          }
        }
        if (typeof item === "string" && item.trim().length > 0) {
          return item.trim();
        }
        return null;
      })
      .filter((message): message is string => Boolean(message));
  }

  if (typeof rawErrors === "object" && rawErrors !== null && "message" in rawErrors) {
    const message = (rawErrors as { message?: unknown }).message;
    if (typeof message === "string" && message.trim().length > 0) {
      return [message];
    }
  }

  return [];
}

type ShopifyGraphqlCostPayload = {
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: {
        currentlyAvailable?: number;
        restoreRate?: number;
      };
    };
  };
};

function isRetryableShopifyGraphqlError(message: string): boolean {
  return /(throttle|throttled|rate limit|temporar|try again|internal|timeout|timed out)/i.test(message);
}

function getShopifyGraphqlThrottleDelayMs(payload: ShopifyGraphqlCostPayload): number {
  const cost = payload.extensions?.cost;
  const throttleStatus = cost?.throttleStatus;
  const currentlyAvailable = Number(throttleStatus?.currentlyAvailable);
  const restoreRate = Number(throttleStatus?.restoreRate);
  if (
    !Number.isFinite(currentlyAvailable) ||
    !Number.isFinite(restoreRate) ||
    restoreRate <= 0
  ) {
    return 0;
  }

  const requestedCost = Math.max(
    Number(cost?.requestedQueryCost) || 0,
    Number(cost?.actualQueryCost) || 0,
  );
  const targetAvailable = Math.max(
    SHOPIFY_GRAPHQL_THROTTLE_MIN_AVAILABLE,
    requestedCost * 2,
  );
  if (currentlyAvailable >= targetAvailable) {
    return 0;
  }

  const restoreMs = Math.ceil(((targetAvailable - currentlyAvailable) / restoreRate) * 1000);
  return Math.min(SHOPIFY_GRAPHQL_THROTTLE_MAX_DELAY_MS, Math.max(1000, restoreMs + 250));
}

function getGraphqlThrottleErrorDelayMs(attempt: number): number {
  const baseDelayMs = 1000 * 2 ** attempt;
  const jitterMs = Math.floor(Math.random() * 250);
  return Math.min(SHOPIFY_GRAPHQL_THROTTLE_MAX_DELAY_MS, baseDelayMs + jitterMs);
}

async function readShopifyGraphqlJsonWithThrottleRetry<T extends ShopifyGraphqlCostPayload>(params: {
  admin: AdminGraphqlClient;
  query: string;
  variables: Record<string, unknown>;
  operationName: string;
  chunkIndex: number;
  cursor: string | null;
}): Promise<T> {
  for (let attempt = 0; attempt <= SHOPIFY_GRAPHQL_THROTTLE_ERROR_MAX_RETRIES; attempt += 1) {
    const response = await params.admin.graphql(params.query, {
      variables: params.variables,
    });
    const json = (await response.json()) as T & { errors?: unknown };
    const graphqlErrors = getGraphqlErrorMessages(json.errors);
    if (graphqlErrors.length === 0) {
      return json;
    }

    const canRetry =
      attempt < SHOPIFY_GRAPHQL_THROTTLE_ERROR_MAX_RETRIES &&
      graphqlErrors.some((message) => isRetryableShopifyGraphqlError(message));
    if (canRetry) {
      const throttleDelayMs = getShopifyGraphqlThrottleDelayMs(json);
      const retryDelayMs = Math.max(
        throttleDelayMs,
        getGraphqlThrottleErrorDelayMs(attempt),
      );
      writeSyncLog("warn", "[product-debug] Shopify GraphQL retryable error", {
        operation: params.operationName,
        chunk: params.chunkIndex,
        after: params.cursor,
        attempt: attempt + 1,
        retryDelayMs,
        reason: graphqlErrors.join("; "),
      });
      await sleep(retryDelayMs);
      continue;
    }

    throw new Error(
      [
        "Shopify GraphQL errors",
        `operation=${params.operationName}`,
        `chunk=${params.chunkIndex}`,
        `after=${params.cursor ?? "null"}`,
        `reason=${graphqlErrors.join("; ")}`,
      ].join(" "),
    );
  }

  throw new Error(
    [
      "Shopify GraphQL errors",
      `operation=${params.operationName}`,
      `chunk=${params.chunkIndex}`,
      `after=${params.cursor ?? "null"}`,
      "reason=retry attempts exhausted",
    ].join(" "),
  );
}

const VARIANTS_PAGE_SIZE = (() => {
  const value = Number(process.env.SHOPIFY_VARIANTS_PAGE_SIZE ?? "50");
  if (!Number.isFinite(value) || value < 10) {
    return 50;
  }
  return Math.min(100, Math.floor(value));
})();
const VALIDATION_VARIANTS_PAGE_SIZE = (() => {
  const value = Number(process.env.SHOPIFY_VALIDATION_VARIANTS_PAGE_SIZE ?? "100");
  if (!Number.isFinite(value) || value < 10) {
    return 100;
  }
  return Math.min(250, Math.floor(value));
})();
const PRICE_UPDATE_BATCH_SIZE = (() => {
  const value = Number(process.env.PRICE_UPDATE_BATCH_SIZE ?? "10");
  if (!Number.isFinite(value) || value < 1) {
    return 10;
  }
  return Math.min(50, Math.floor(value));
})();
const PRICE_UPDATE_PRODUCT_CONCURRENCY = (() => {
  const value = Number(process.env.PRICE_UPDATE_PRODUCT_CONCURRENCY ?? "1");
  if (!Number.isFinite(value) || value < 1) {
    return 1;
  }
  return Math.min(6, Math.floor(value));
})();
const METAFIELD_UPDATE_BATCH_SIZE = (() => {
  const value = Number(process.env.METAFIELD_UPDATE_BATCH_SIZE ?? "10");
  if (!Number.isFinite(value) || value < 1) {
    return 10;
  }
  // Shopify metafieldsSet input hard limit is 25 items per mutation.
  return Math.min(25, Math.floor(value));
})();
const PREVIOUS_PRICE_METAFIELD_NAMESPACE = "custom";
const PREVIOUS_PRICE_METAFIELD_KEY = "previous_price";
const FOIL_METAFIELD_NAMESPACE = "custom";
const FOIL_METAFIELD_KEY = "foil";
const PRODUCT_IMAGE_SYNC_FINGERPRINT_NAMESPACE = "custom";
const PRODUCT_IMAGE_SYNC_FINGERPRINT_KEY = "scryfall_image_fp";
const FX_TIMEOUT_MS = parseSafeMs(process.env.EXTERNAL_PRICES_API_TIMEOUT_MS, 15000);
const FX_CACHE_TTL_MS = parseSafeMs(
  process.env.EXCHANGE_RATE_CACHE_TTL_MS,
  24 * 60 * 60 * 1000,
);
const FX_CACHE_MAX_STALE_MS = parseSafeMs(
  process.env.EXCHANGE_RATE_CACHE_MAX_STALE_MS,
  48 * 60 * 60 * 1000,
);
const JUSTTCG_TIMEOUT_MS = parseSafeMs(process.env.EXTERNAL_PRICES_API_TIMEOUT_MS, 15000);
const JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE =
  process.env.JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE ?? "";
const JUSTTCG_API_TOKEN = process.env.JUSTTCG_API_TOKEN ?? "";
const CARDKINGDOM_TIMEOUT_MS = parseSafeMs(process.env.EXTERNAL_PRICES_API_TIMEOUT_MS, 30000);
const CARDKINGDOM_SYNC_INTERVAL_MS = parseSafeTtlMs(
  process.env.CARDKINGDOM_SYNC_INTERVAL_MS ?? process.env.CARDKINGDOM_PRICELIST_CACHE_TTL_MS,
  60 * 60 * 1000,
);
const CARDKINGDOM_DB_MEMORY_CACHE_TTL_MS = parseSafeTtlMs(
  process.env.CARDKINGDOM_DB_MEMORY_CACHE_TTL_MS,
  5 * 60 * 1000,
);
const CARDKINGDOM_DB_WRITE_BATCH_SIZE = (() => {
  const value = Number(process.env.CARDKINGDOM_DB_WRITE_BATCH_SIZE ?? "750");
  if (!Number.isFinite(value) || value < 50) {
    return 750;
  }
  return Math.min(5000, Math.floor(value));
})();
const CARDKINGDOM_PRICELIST_URL =
  process.env.CARDKINGDOM_PRICELIST_URL ?? "https://api.cardkingdom.com/api/pricelist";
const CARDKINGDOM_PRICELIST_FALLBACK_URL =
  process.env.CARDKINGDOM_PRICELIST_FALLBACK_URL ?? "https://api.cardkingdom.com/api/v2/pricelist";
const CARDKINGDOM_REFRESH_LOCK_LEASE_MS = parseSafeMs(
  process.env.CARDKINGDOM_REFRESH_LOCK_LEASE_MS,
  300_000,
);
const CARDKINGDOM_REFRESH_JOB_KEY = "cardkingdom_pricelist_refresh";
const MTGJSON_TIMEOUT_MS = parseSafeMs(process.env.EXTERNAL_PRICES_API_TIMEOUT_MS, 45000);
const MTGJSON_PRICES_TTL_MS = parseSafeTtlMs(
  process.env.MTGJSON_PRICES_CACHE_TTL_MS,
  6 * 60 * 60 * 1000,
);
const MTGJSON_SET_TTL_MS = parseSafeTtlMs(
  process.env.MTGJSON_SET_CACHE_TTL_MS,
  24 * 60 * 60 * 1000,
);
const MTGJSON_ALL_PRICES_URL =
  process.env.MTGJSON_ALL_PRICES_URL ??
  "https://mtgjson.com/api/v5/AllPricesToday.json.gz";
const MTGJSON_SET_URL_TEMPLATE =
  process.env.MTGJSON_SET_URL_TEMPLATE ?? "https://mtgjson.com/api/v5/{set}.json";
const SHOPIFY_OPERATION_TIMEOUT_MS = parseSafeMs(
  process.env.SHOPIFY_OPERATION_TIMEOUT_MS,
  90_000,
);
const SHOPIFY_OPERATION_TIMEOUT_PER_ITEM_MS = parseSafeMs(
  process.env.SHOPIFY_OPERATION_TIMEOUT_PER_ITEM_MS,
  150,
);
const SHOPIFY_OPERATION_TIMEOUT_MAX_MS = parseSafeMs(
  process.env.SHOPIFY_OPERATION_TIMEOUT_MAX_MS,
  15 * 60 * 1000,
);
const SHOPIFY_IMAGE_SYNC_TIMEOUT_MS = parseSafeMs(
  process.env.SHOPIFY_IMAGE_SYNC_TIMEOUT_MS,
  25_000,
);
const SHOPIFY_IMAGE_REORDER_MAX_ATTEMPTS = (() => {
  const value = Number(process.env.SHOPIFY_IMAGE_REORDER_MAX_ATTEMPTS ?? "6");
  if (!Number.isFinite(value) || value < 1) {
    return 6;
  }
  return Math.min(12, Math.floor(value));
})();
const SHOPIFY_IMAGE_REORDER_RETRY_DELAY_MS = parseSafeMs(
  process.env.SHOPIFY_IMAGE_REORDER_RETRY_DELAY_MS,
  1000,
);
const SHOPIFY_IMAGE_VERIFY_MAX_ATTEMPTS = (() => {
  const value = Number(process.env.SHOPIFY_IMAGE_VERIFY_MAX_ATTEMPTS ?? "4");
  if (!Number.isFinite(value) || value < 1) {
    return 4;
  }
  return Math.min(10, Math.floor(value));
})();
const SHOPIFY_IMAGE_VERIFY_RETRY_DELAY_MS = parseSafeMs(
  process.env.SHOPIFY_IMAGE_VERIFY_RETRY_DELAY_MS,
  1500,
);
const SHOPIFY_IMAGE_STAGE_BLOCK_SIZE = (() => {
  const value = Number(process.env.SHOPIFY_IMAGE_STAGE_BLOCK_SIZE ?? "400");
  if (!Number.isFinite(value) || value < 50) {
    return 400;
  }
  return Math.min(2_000, Math.floor(value));
})();
const SHOPIFY_IMAGE_STAGE_BLOCK_DELAY_MS = parseSafeMs(
  process.env.SHOPIFY_IMAGE_STAGE_BLOCK_DELAY_MS,
  3000,
);
const SHOPIFY_IMAGE_QUEUE_MAX_ITEMS_PER_RUN = (() => {
  const value = Number(process.env.SHOPIFY_IMAGE_QUEUE_MAX_ITEMS_PER_RUN ?? "1000");
  if (!Number.isFinite(value) || value < 1) {
    return 1000;
  }
  return Math.min(10_000, Math.floor(value));
})();
const SHOPIFY_IMAGE_QUEUE_MAX_RUNTIME_MS = parseSafeMs(
  process.env.SHOPIFY_IMAGE_QUEUE_MAX_RUNTIME_MS,
  45 * 60 * 1000,
);
const SHOPIFY_IMAGE_QUEUE_RUNTIME_HARD_CAP_MS = parseSafeMs(
  process.env.SHOPIFY_IMAGE_QUEUE_RUNTIME_HARD_CAP_MS,
  2 * 60 * 60 * 1000,
);
const SHOPIFY_IMAGE_QUEUE_STALE_LOCK_MS = parseSafeMs(
  process.env.SHOPIFY_IMAGE_QUEUE_STALE_LOCK_MS,
  10 * 60 * 1000,
);
const SHOPIFY_IMAGE_STAGE_CONCURRENCY = (() => {
  const value = Number(process.env.SHOPIFY_IMAGE_STAGE_CONCURRENCY ?? "2");
  if (!Number.isFinite(value) || value < 1) {
    return 2;
  }
  return Math.min(8, Math.floor(value));
})();
const SHOPIFY_IMAGE_PENDING_CREATE_TTL_MS = 6 * 60 * 60 * 1000;
const PRICE_SYNC_LOG_PER_VARIANT = process.env.PRICE_SYNC_LOG_PER_VARIANT === "1";
const SHOPIFY_GRAPHQL_THROTTLE_ERROR_MAX_RETRIES = (() => {
  const value = Number(process.env.SHOPIFY_GRAPHQL_THROTTLE_ERROR_MAX_RETRIES ?? "5");
  if (!Number.isFinite(value) || value < 0) {
    return 5;
  }
  return Math.min(10, Math.floor(value));
})();
const SHOPIFY_GRAPHQL_THROTTLE_MIN_AVAILABLE = (() => {
  const value = Number(process.env.SHOPIFY_GRAPHQL_THROTTLE_MIN_AVAILABLE ?? "250");
  if (!Number.isFinite(value) || value < 0) {
    return 250;
  }
  return Math.min(1000, Math.floor(value));
})();
const SHOPIFY_GRAPHQL_THROTTLE_MAX_DELAY_MS = parseSafeMs(
  process.env.SHOPIFY_GRAPHQL_THROTTLE_MAX_DELAY_MS,
  30_000,
);
const PRICE_SYNC_PROGRESS_FLUSH_MS = (() => {
  const value = Number(process.env.PRICE_SYNC_PROGRESS_FLUSH_MS ?? "1000");
  if (!Number.isFinite(value) || value < 250) {
    return 1000;
  }
  return Math.min(5000, Math.floor(value));
})();

type MtgjsonPriceEntry = {
  paper?: {
    tcgplayer?: {
      retail?: Record<string, { normal?: number; foil?: number }>;
    };
  };
};

type CardKingdomPriceEntry = {
  nonfoil: string | null;
  foil: string | null;
};

type CardKingdomPriceCacheRow = {
  scryfallId: string;
  nonfoilPrice: string | null;
  foilPrice: string | null;
  snapshotAt: Date;
  sourceUpdatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

declare global {
  // eslint-disable-next-line no-var
  var __mtgjsonAllPricesCache:
    | { expiresAt: number; pricesByUuid: Record<string, MtgjsonPriceEntry> }
    | undefined;
  // eslint-disable-next-line no-var
  var __mtgjsonSetCache:
    | Map<string, { expiresAt: number; scryfallToUuid: Map<string, string> }>
    | undefined;
  // eslint-disable-next-line no-var
  var __cardKingdomDbCache:
    | {
        expiresAt: number;
        pricesByScryfallId: Map<string, CardKingdomPriceEntry>;
        snapshotAt: string | null;
      }
    | undefined;
  var __shopifyImageCreatePendingByKey:
    | Map<string, number>
    | undefined;
}

if (!global.__mtgjsonSetCache) {
  global.__mtgjsonSetCache = new Map();
}
if (!global.__shopifyImageCreatePendingByKey) {
  global.__shopifyImageCreatePendingByKey = new Map();
}

function parseSafeMs(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue ?? fallback);
  if (!Number.isFinite(value) || value < 1000) {
    return fallback;
  }
  return Math.min(value, 5 * 60 * 1000);
}

function parseSafeTtlMs(rawValue: string | undefined, fallback: number): number {
  const value = Number(rawValue ?? fallback);
  if (!Number.isFinite(value) || value < 60 * 1000) {
    return fallback;
  }
  return Math.min(value, 7 * 24 * 60 * 60 * 1000);
}

function hasImageSyncQueueDelegate(): boolean {
  return (
    typeof db === "object" &&
    db !== null &&
    "imageSyncQueue" in db &&
    Boolean((db as unknown as { imageSyncQueue?: unknown }).imageSyncQueue)
  );
}

function getImageSyncQueueDelegate() {
  if (!hasImageSyncQueueDelegate()) {
    return null;
  }
  return (db as unknown as { imageSyncQueue?: {
    findMany: (args: Record<string, unknown>) => Promise<ImageSyncQueueJob[]>;
    findUnique: (args: Record<string, unknown>) => Promise<ImageSyncQueueJob | null>;
    count: (args: Record<string, unknown>) => Promise<number>;
    upsert: (args: Record<string, unknown>) => Promise<ImageSyncQueueJob>;
    update: (args: Record<string, unknown>) => Promise<ImageSyncQueueJob>;
    updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
  } }).imageSyncQueue ?? null;
}

function isMissingImageQueueTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ImageSyncQueue|image_sync_queue|no such table/i.test(message);
}

function normalizeMoney(value: string | number): string {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "0.00";
}

function getRelativePriceVariationRatio(
  currentPrice: string | number,
  nextPrice: string | number,
): number | null {
  const current = typeof currentPrice === "number" ? currentPrice : Number(currentPrice);
  const next = typeof nextPrice === "number" ? nextPrice : Number(nextPrice);
  if (!Number.isFinite(current) || !Number.isFinite(next) || current <= 0) {
    return null;
  }

  return Math.abs(next - current) / current;
}

function normalizeSuspiciousVariationThresholdPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 50;
  }
  return Math.min(1000, Math.max(0.1, value));
}

function applyConfiguredPriceAdjustments(
  basePrice: number,
  preferences: SyncPreferences,
): number | null {
  if (!Number.isFinite(basePrice) || basePrice < 0) {
    return null;
  }

  const percent = Number.isFinite(preferences.priceAdjustmentPercent)
    ? preferences.priceAdjustmentPercent
    : 0;
  const fixed = Number.isFinite(preferences.priceAdjustmentFixed)
    ? preferences.priceAdjustmentFixed
    : 0;
  const minimum = Number.isFinite(preferences.minimumPrice)
    ? Math.max(0, preferences.minimumPrice)
    : 0;
  const hasPercentAdjustment = Math.abs(percent) > 1e-9;
  const hasFixedAdjustment = Math.abs(fixed) > 1e-9;

  let adjusted = basePrice;
  if (preferences.priceAdjustmentMode === "percent") {
    if (hasPercentAdjustment) {
      const multiplier = 1 + percent / 100;
      if (Number.isFinite(multiplier) && multiplier >= 0) {
        adjusted = basePrice * multiplier;
      } else {
        // Invalid configuration should not block a valid source price update.
        adjusted = basePrice;
      }
    }
  } else {
    adjusted = hasFixedAdjustment ? basePrice + fixed : basePrice;
  }

  if (!Number.isFinite(adjusted) || adjusted < 0) {
    adjusted = basePrice;
  }

  if (minimum > 0) {
    adjusted = Math.max(minimum, adjusted);
  }

  return adjusted;
}

export async function fetchUsdToClpRate(): Promise<number> {
  const now = Date.now();
  const cached = await db.exchangeRateCache.findUnique({
    where: { pair: USD_CLP_PAIR },
  });
  if (cached && cached.expiresAt.getTime() > now) {
    return cached.rate;
  }

  let refreshed: { rate: number; source: string } | null = null;
  const errors: string[] = [];

  try {
    refreshed = await fetchUsdToClpRateFromMindicador();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "mindicador failed");
  }

  if (!refreshed) {
    try {
      refreshed = await fetchUsdToClpRateFromErApi();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : "open.er-api failed");
    }
  }

  if (refreshed) {
    const fetchedAt = new Date();
    const expiresAt = new Date(fetchedAt.getTime() + FX_CACHE_TTL_MS);
    await db.exchangeRateCache.upsert({
      where: { pair: USD_CLP_PAIR },
      create: {
        pair: USD_CLP_PAIR,
        rate: refreshed.rate,
        source: refreshed.source,
        fetchedAt,
        expiresAt,
      },
      update: {
        rate: refreshed.rate,
        source: refreshed.source,
        fetchedAt,
        expiresAt,
      },
    });
    return refreshed.rate;
  }

  if (cached && now - cached.fetchedAt.getTime() <= FX_CACHE_MAX_STALE_MS) {
    return cached.rate;
  }

  throw new Error(`USD/CLP rate unavailable. Sources failed: ${errors.join(" | ")}`);
}

async function fetchUsdToClpRateFromMindicador(): Promise<{ rate: number; source: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);

  try {
    const response = await fetch("https://mindicador.cl/api/dolar", {
      headers: {
        Accept: "application/json",
        "User-Agent": "shopify-price-sync/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`mindicador request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      serie?: Array<{ valor?: number }>;
    };
    const rate = payload.serie?.[0]?.valor;
    if (!Number.isFinite(rate) || (rate ?? 0) <= 0) {
      throw new Error("mindicador returned an invalid rate");
    }

    return { rate: Number(rate), source: "mindicador" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("mindicador timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchUsdToClpRateFromErApi(): Promise<{ rate: number; source: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FX_TIMEOUT_MS);

  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      headers: {
        Accept: "application/json",
        "User-Agent": "shopify-price-sync/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`open.er-api request failed: ${response.status}`);
    }

    const payload = (await response.json()) as {
      result?: string;
      rates?: Record<string, number>;
    };

    if (payload.result !== "success") {
      throw new Error("open.er-api returned non-success result");
    }

    const rate = payload.rates?.CLP;
    if (!Number.isFinite(rate) || (rate ?? 0) <= 0) {
      throw new Error("open.er-api returned an invalid CLP rate");
    }

    return { rate: Number(rate), source: "open.er-api" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("open.er-api timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function pickFirstNumericValue(payload: unknown): number | null {
  if (typeof payload === "number" && Number.isFinite(payload)) {
    return payload;
  }
  if (typeof payload === "string") {
    const parsed = Number(payload);
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const root = payload as Record<string, unknown>;
  const directCandidates = [
    root.price,
    root.usd,
    root.priceUsd,
    root.price_usd,
    (root.prices as Record<string, unknown> | undefined)?.usd,
    (root.data as Record<string, unknown> | undefined)?.price,
    (root.data as Record<string, unknown> | undefined)?.usd,
    ((root.data as Record<string, unknown> | undefined)?.prices as
      | Record<string, unknown>
      | undefined)?.usd,
  ];

  for (const candidate of directCandidates) {
    const picked = pickFirstNumericValue(candidate);
    if (picked !== null) {
      return picked;
    }
  }

  const collectionCandidates = [
    root.items,
    root.results,
    root.data,
    (root.data as Record<string, unknown> | undefined)?.items,
  ];
  for (const list of collectionCandidates) {
    if (!Array.isArray(list) || list.length === 0) {
      continue;
    }
    const picked = pickFirstNumericValue(list[0]);
    if (picked !== null) {
      return picked;
    }
  }

  return null;
}

function toProviderHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": "shopify-price-sync/1.0",
  };
  const normalized = apiKey?.trim();
  if (normalized) {
    headers.Authorization = `Bearer ${normalized}`;
    headers["X-API-Key"] = normalized;
  }
  return headers;
}

async function fetchJsonMaybeGzip(url: string, options?: { apiKey?: string }): Promise<unknown> {
  return fetchJsonMaybeGzipWithTimeout(url, {
    apiKey: options?.apiKey,
    timeoutMs: MTGJSON_TIMEOUT_MS,
    providerLabel: "External API",
  });
}

async function fetchJsonMaybeGzipWithTimeout(
  url: string,
  options: { apiKey?: string; timeoutMs: number; providerLabel: string },
): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(url, {
      headers: toProviderHeaders(options.apiKey),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`${options.providerLabel} request failed: ${response.status}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const isGzip = buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
    const text = isGzip ? gunzipSync(buffer).toString("utf8") : buffer.toString("utf8");
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`${options.providerLabel} timeout`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJustTcgUsdPriceByExternalId(
  scryfallId: string,
  apiKey?: string,
): Promise<string | null> {
  if (!JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE.trim()) {
    throw new Error(
      "JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE is required when price source is justtcg",
    );
  }

  const endpoint = JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE.includes("{id}")
    ? JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE.replace("{id}", encodeURIComponent(scryfallId))
    : `${JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE}${JUSTTCG_BY_EXTERNAL_ID_URL_TEMPLATE.includes("?") ? "&" : "?"}externalId=${encodeURIComponent(scryfallId)}`;
  assertSafeExternalEndpoint(endpoint, "JustTCG");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), JUSTTCG_TIMEOUT_MS);

  try {
    const headers = toProviderHeaders(apiKey?.trim() || JUSTTCG_API_TOKEN);

    const response = await fetch(endpoint, {
      method: "GET",
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`JustTCG request failed: ${response.status}`);
    }

    const payload = (await response.json()) as unknown;
    const parsed = pickFirstNumericValue(payload);
    if (parsed === null) {
      return null;
    }
    return normalizeMoney(parsed);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("JustTCG API timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function loadMtgjsonAllPrices(
  apiKey?: string,
): Promise<Record<string, MtgjsonPriceEntry>> {
  const now = Date.now();
  if (
    global.__mtgjsonAllPricesCache &&
    global.__mtgjsonAllPricesCache.expiresAt > now
  ) {
    return global.__mtgjsonAllPricesCache.pricesByUuid;
  }

  assertSafeExternalEndpoint(MTGJSON_ALL_PRICES_URL, "MTGJSON");
  const payload = (await fetchJsonMaybeGzip(MTGJSON_ALL_PRICES_URL, { apiKey })) as {
    data?: Record<string, MtgjsonPriceEntry>;
  } | null;
  const pricesByUuid = payload?.data ?? {};

  global.__mtgjsonAllPricesCache = {
    expiresAt: now + MTGJSON_PRICES_TTL_MS,
    pricesByUuid,
  };
  return pricesByUuid;
}

async function loadMtgjsonSetScryfallToUuidMap(
  setCode: string,
  apiKey?: string,
): Promise<Map<string, string>> {
  const key = setCode.toUpperCase();
  const now = Date.now();
  const cached = global.__mtgjsonSetCache?.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.scryfallToUuid;
  }

  const endpoint = MTGJSON_SET_URL_TEMPLATE.replace("{set}", encodeURIComponent(key));
  assertSafeExternalEndpoint(endpoint, "MTGJSON");
  const payload = (await fetchJsonMaybeGzip(endpoint, { apiKey })) as {
    data?: {
      cards?: Array<{
        uuid?: string;
        identifiers?: { scryfallId?: string };
      }>;
    };
  } | null;
  const map = new Map<string, string>();
  for (const card of payload?.data?.cards ?? []) {
    const scryfallId = card.identifiers?.scryfallId?.trim();
    const uuid = card.uuid?.trim();
    if (scryfallId && uuid) {
      map.set(scryfallId, uuid);
    }
  }

  global.__mtgjsonSetCache?.set(key, {
    expiresAt: now + MTGJSON_SET_TTL_MS,
    scryfallToUuid: map,
  });
  return map;
}

function pickMtgjsonPrice(
  priceEntry: MtgjsonPriceEntry | undefined,
  foilMode: "foil" | "nonfoil" | null,
): string | null {
  const retailByDate = priceEntry?.paper?.tcgplayer?.retail;
  if (!retailByDate || typeof retailByDate !== "object") {
    return null;
  }

  const sortedDates = Object.keys(retailByDate).sort((a, b) => b.localeCompare(a));
  for (const dateKey of sortedDates) {
    const point = retailByDate[dateKey];
    if (!point) {
      continue;
    }
    if (foilMode === "foil" && Number.isFinite(point.foil)) {
      return normalizeMoney(point.foil as number);
    }
    if (Number.isFinite(point.normal)) {
      return normalizeMoney(point.normal as number);
    }
    if (Number.isFinite(point.foil)) {
      return normalizeMoney(point.foil as number);
    }
  }

  return null;
}

async function fetchMtgjsonUsdPrice(params: {
  scryfallId: string;
  setCode?: string;
  foilMode: "foil" | "nonfoil" | null;
  apiKey?: string;
}): Promise<string | null> {
  const { scryfallId, setCode, foilMode, apiKey } = params;
  if (!setCode?.trim()) {
    return null;
  }

  const [pricesByUuid, scryfallToUuid] = await Promise.all([
    loadMtgjsonAllPrices(apiKey),
    loadMtgjsonSetScryfallToUuidMap(setCode, apiKey),
  ]);

  const uuid = scryfallToUuid.get(scryfallId);
  if (!uuid) {
    return null;
  }
  return pickMtgjsonPrice(pricesByUuid[uuid], foilMode);
}

function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseCardKingdomFoilFlag(rawValue: unknown): boolean | null {
  if (rawValue === null || rawValue === undefined) {
    return null;
  }
  if (typeof rawValue === "boolean") {
    return rawValue;
  }
  if (typeof rawValue === "number") {
    if (rawValue === 1) {
      return true;
    }
    if (rawValue === 0) {
      return false;
    }
  }
  if (typeof rawValue === "string") {
    const normalized = rawValue.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(normalized)) {
      return true;
    }
    if (["false", "0", "no", "n"].includes(normalized)) {
      return false;
    }
  }

  return false;
}

function pickCardKingdomRetailPrice(rawProduct: Record<string, unknown>): number | null {
  const directRetail = parseFiniteNumber(rawProduct.price_retail);
  if (directRetail !== null && directRetail > 0) {
    return directRetail;
  }

  const conditions = rawProduct.condition_values;
  if (!conditions || typeof conditions !== "object") {
    return null;
  }

  const conditionValues = conditions as Record<string, unknown>;
  const candidates = [
    conditionValues.nm_price,
    conditionValues.ex_price,
    conditionValues.vg_price,
    conditionValues.g_price,
  ];

  for (const candidate of candidates) {
    const parsed = parseFiniteNumber(candidate);
    if (parsed !== null && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

function upsertCardKingdomPrice(
  pricesByScryfallId: Map<string, CardKingdomPriceEntry>,
  scryfallId: string,
  foilState: boolean | null,
  normalizedPrice: string,
): void {
  const existing = pricesByScryfallId.get(scryfallId) ?? { nonfoil: null, foil: null };
  const keepLowest = (current: string | null, next: string): string => {
    if (!current) {
      return next;
    }
    return Number(next) < Number(current) ? next : current;
  };

  if (foilState === true) {
    existing.foil = keepLowest(existing.foil, normalizedPrice);
    pricesByScryfallId.set(scryfallId, existing);
    return;
  }

  if (foilState === false) {
    existing.nonfoil = keepLowest(existing.nonfoil, normalizedPrice);
    pricesByScryfallId.set(scryfallId, existing);
    return;
  }

  existing.nonfoil = keepLowest(existing.nonfoil, normalizedPrice);
  existing.foil = keepLowest(existing.foil, normalizedPrice);
  pricesByScryfallId.set(scryfallId, existing);
}

function extractCardKingdomRows(payload: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(payload)) {
    return payload.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
  }

  if (!payload || typeof payload !== "object") {
    return [];
  }

  const root = payload as Record<string, unknown>;
  if (Array.isArray(root.data)) {
    return root.data.filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
    );
  }
  return [];
}

function parseCardKingdomSourceUpdatedAt(payload: unknown): Date | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const root = payload as Record<string, unknown>;
  const rawDate =
    (root.meta && typeof root.meta === "object"
      ? (root.meta as Record<string, unknown>).created_at
      : null) ??
    root.created_at ??
    root.updated_at;
  if (typeof rawDate !== "string" || !rawDate.trim()) {
    return null;
  }
  const parsed = new Date(rawDate);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function hasCardKingdomPriceCacheDelegate(): boolean {
  return (
    typeof db === "object" &&
    db !== null &&
    "cardKingdomPriceCache" in db &&
    Boolean((db as unknown as { cardKingdomPriceCache?: unknown }).cardKingdomPriceCache)
  );
}

function hasBackgroundJobLockDelegate(): boolean {
  return (
    typeof db === "object" &&
    db !== null &&
    "backgroundJobLock" in db &&
    Boolean((db as unknown as { backgroundJobLock?: unknown }).backgroundJobLock)
  );
}

function getCardKingdomPriceCacheDelegate() {
  if (!hasCardKingdomPriceCacheDelegate()) {
    return null;
  }
  return (
    db as unknown as {
      cardKingdomPriceCache?: {
        findFirst: (args: Record<string, unknown>) => Promise<{ snapshotAt: Date } | null>;
        findMany: (args: Record<string, unknown>) => Promise<CardKingdomPriceCacheRow[]>;
      };
    }
  ).cardKingdomPriceCache;
}

function getBackgroundJobLockDelegate() {
  if (!hasBackgroundJobLockDelegate()) {
    return null;
  }
  return (
    db as unknown as {
      backgroundJobLock?: {
        upsert: (args: Record<string, unknown>) => Promise<unknown>;
        updateMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
      };
    }
  ).backgroundJobLock;
}

function isMissingCardKingdomPriceCacheTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /CardKingdomPriceCache|card_kingdom_price_cache|no such table/i.test(message);
}

function isMissingBackgroundJobLockTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /BackgroundJobLock|background_job_lock|no such table/i.test(message);
}

function clearCardKingdomDbMemoryCache(): void {
  global.__cardKingdomDbCache = undefined;
}

async function tryAcquireBackgroundJobLock(params: {
  jobKey: string;
  leaseMs: number;
}): Promise<{ acquired: boolean; token: string | null; reason?: string }> {
  const delegate = getBackgroundJobLockDelegate();
  if (!delegate) {
    // Fail-open for compatibility when migration has not been applied yet.
    return { acquired: true, token: null, reason: "delegate_unavailable" };
  }

  const token = randomUUID();
  const now = new Date();
  const lockedUntil = new Date(now.getTime() + params.leaseMs);

  try {
    await delegate.upsert({
      where: { jobKey: params.jobKey },
      create: {
        jobKey: params.jobKey,
        lockToken: null,
        lockedUntil: null,
      },
      update: {},
    });
    const updated = await delegate.updateMany({
      where: {
        jobKey: params.jobKey,
        OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }],
      },
      data: {
        lockToken: token,
        lockedUntil,
      },
    });
    if (updated.count > 0) {
      return { acquired: true, token };
    }
    return { acquired: false, token: null, reason: "locked_by_other_worker" };
  } catch (error) {
    if (isMissingBackgroundJobLockTableError(error)) {
      return { acquired: true, token: null, reason: "table_missing" };
    }
    throw error;
  }
}

async function releaseBackgroundJobLock(params: {
  jobKey: string;
  token: string | null;
}): Promise<void> {
  if (!params.token) {
    return;
  }
  const delegate = getBackgroundJobLockDelegate();
  if (!delegate) {
    return;
  }
  try {
    await delegate.updateMany({
      where: {
        jobKey: params.jobKey,
        lockToken: params.token,
      },
      data: {
        lockToken: null,
        lockedUntil: null,
      },
    });
  } catch (error) {
    if (isMissingBackgroundJobLockTableError(error)) {
      return;
    }
    throw error;
  }
}

async function fetchCardKingdomPricelistMapFromApi(): Promise<{
  pricesByScryfallId: Map<string, CardKingdomPriceEntry>;
  sourceUpdatedAt: Date | null;
}> {
  const endpoints = Array.from(
    new Set([CARDKINGDOM_PRICELIST_URL, CARDKINGDOM_PRICELIST_FALLBACK_URL]),
  ).filter((value) => value.trim().length > 0);

  if (endpoints.length === 0) {
    throw new Error("Card Kingdom endpoint URL is empty");
  }

  let lastError: Error | null = null;
  let selectedPayload: unknown = null;
  for (const endpoint of endpoints) {
    assertSafeExternalEndpoint(endpoint, "Card Kingdom");
    try {
      selectedPayload = await fetchJsonMaybeGzipWithTimeout(endpoint, {
        timeoutMs: CARDKINGDOM_TIMEOUT_MS,
        providerLabel: "Card Kingdom",
      });
      break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (selectedPayload === null) {
    throw lastError ?? new Error("Card Kingdom request failed");
  }

  const pricesByScryfallId = new Map<string, CardKingdomPriceEntry>();
  const sourceUpdatedAt = parseCardKingdomSourceUpdatedAt(selectedPayload);
  const rows = extractCardKingdomRows(selectedPayload);
  for (const row of rows) {
    if (row.scryfall_id == null) {
      continue;
    }
    const resolvedScryfallId = normalizeScryfallIdentifier(
      typeof row.scryfall_id === "string" ? row.scryfall_id : String(row.scryfall_id),
    );
    if (!resolvedScryfallId) {
      continue;
    }

    const retailPrice = pickCardKingdomRetailPrice(row);
    if (retailPrice === null) {
      continue;
    }

    const normalizedPrice = normalizeMoney(retailPrice);
    const foilState = parseCardKingdomFoilFlag(row.is_foil);
    if (foilState === null) {
      continue;
    }
    upsertCardKingdomPrice(pricesByScryfallId, resolvedScryfallId, foilState, normalizedPrice);
  }

  return {
    pricesByScryfallId,
    sourceUpdatedAt,
  };
}

async function readCardKingdomPricesFromDb(): Promise<Map<string, CardKingdomPriceEntry>> {
  const now = Date.now();
  const cached = global.__cardKingdomDbCache;
  if (cached && cached.expiresAt > now) {
    return cached.pricesByScryfallId;
  }

  const delegate = getCardKingdomPriceCacheDelegate();
  if (!delegate) {
    return new Map();
  }

  try {
    const rows = await delegate.findMany({
      select: {
        scryfallId: true,
        nonfoilPrice: true,
        foilPrice: true,
        snapshotAt: true,
      },
    });
    const pricesByScryfallId = new Map<string, CardKingdomPriceEntry>();
    let snapshotAt: string | null = null;
    for (const row of rows) {
      pricesByScryfallId.set(row.scryfallId, {
        nonfoil: row.nonfoilPrice,
        foil: row.foilPrice,
      });
      if (!snapshotAt) {
        snapshotAt = row.snapshotAt.toISOString();
      }
    }
    global.__cardKingdomDbCache = {
      expiresAt: now + CARDKINGDOM_DB_MEMORY_CACHE_TTL_MS,
      pricesByScryfallId,
      snapshotAt,
    };
    return pricesByScryfallId;
  } catch (error) {
    if (isMissingCardKingdomPriceCacheTableError(error)) {
      return new Map();
    }
    const message = error instanceof Error ? error.message : String(error);
    writeSyncLog("warn", "[cardkingdom] failed to read DB cache, using empty cache", {
      message,
    });
    return new Map();
  }
}

export async function refreshCardKingdomPriceCacheIfDue(params?: {
  force?: boolean;
}): Promise<{
  attempted: boolean;
  refreshed: boolean;
  rowCount: number;
  reason: string | null;
  snapshotAtUtc: string | null;
  previousSnapshotAtUtc: string | null;
  sourceUpdatedAtUtc: string | null;
}> {
  const delegate = getCardKingdomPriceCacheDelegate();
  if (!delegate) {
    return {
      attempted: false,
      refreshed: false,
      rowCount: 0,
      reason: "delegate_unavailable",
      snapshotAtUtc: null,
      previousSnapshotAtUtc: null,
      sourceUpdatedAtUtc: null,
    };
  }

  const getLatestSnapshotAt = async (): Promise<Date | null> => {
    const latest = await delegate.findFirst({
      orderBy: { snapshotAt: "desc" },
      select: { snapshotAt: true },
    });
    return latest?.snapshotAt ?? null;
  };

  let previousSnapshotAt: Date | null = null;
  try {
    previousSnapshotAt = await getLatestSnapshotAt();
  } catch (error) {
    if (isMissingCardKingdomPriceCacheTableError(error)) {
      return {
        attempted: false,
        refreshed: false,
        rowCount: 0,
        reason: "table_missing",
        snapshotAtUtc: null,
        previousSnapshotAtUtc: null,
        sourceUpdatedAtUtc: null,
      };
    }
    throw error;
  }

  if (
    !params?.force &&
    previousSnapshotAt &&
    Date.now() - previousSnapshotAt.getTime() < CARDKINGDOM_SYNC_INTERVAL_MS
  ) {
    return {
      attempted: false,
      refreshed: false,
      rowCount: 0,
      reason: "not_due",
      snapshotAtUtc: previousSnapshotAt.toISOString(),
      previousSnapshotAtUtc: previousSnapshotAt.toISOString(),
      sourceUpdatedAtUtc: null,
    };
  }

  const lock = await tryAcquireBackgroundJobLock({
    jobKey: CARDKINGDOM_REFRESH_JOB_KEY,
    leaseMs: CARDKINGDOM_REFRESH_LOCK_LEASE_MS,
  });
  if (!lock.acquired) {
    return {
      attempted: false,
      refreshed: false,
      rowCount: 0,
      reason: lock.reason ?? "locked_by_other_worker",
      snapshotAtUtc: previousSnapshotAt?.toISOString() ?? null,
      previousSnapshotAtUtc: previousSnapshotAt?.toISOString() ?? null,
      sourceUpdatedAtUtc: null,
    };
  }

  try {
    const latestSnapshotAt = await getLatestSnapshotAt();
    if (
      !params?.force &&
      latestSnapshotAt &&
      Date.now() - latestSnapshotAt.getTime() < CARDKINGDOM_SYNC_INTERVAL_MS
    ) {
      return {
        attempted: false,
        refreshed: false,
        rowCount: 0,
        reason: "not_due",
        snapshotAtUtc: latestSnapshotAt.toISOString(),
        previousSnapshotAtUtc: previousSnapshotAt?.toISOString() ?? null,
        sourceUpdatedAtUtc: null,
      };
    }

    const { pricesByScryfallId, sourceUpdatedAt } = await fetchCardKingdomPricelistMapFromApi();
    if (pricesByScryfallId.size === 0) {
      return {
        attempted: true,
        refreshed: false,
        rowCount: 0,
        reason: "no_valid_rows",
        snapshotAtUtc: latestSnapshotAt?.toISOString() ?? null,
        previousSnapshotAtUtc: previousSnapshotAt?.toISOString() ?? null,
        sourceUpdatedAtUtc: sourceUpdatedAt?.toISOString() ?? null,
      };
    }

    const snapshotAt = new Date();
    const dataRows = Array.from(pricesByScryfallId.entries()).map(([scryfallId, entry]) => ({
      scryfallId,
      nonfoilPrice: entry.nonfoil,
      foilPrice: entry.foil,
      snapshotAt,
      sourceUpdatedAt,
      createdAt: snapshotAt,
      updatedAt: snapshotAt,
    }));

    const writer = (
      db as unknown as {
        cardKingdomPriceCache?: {
          deleteMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
          createMany: (args: Record<string, unknown>) => Promise<{ count: number }>;
        };
      }
    ).cardKingdomPriceCache;
    if (!writer) {
      throw new Error("CardKingdomPriceCache delegate unavailable");
    }
    // Keep write operations short to reduce DB lock time under constrained databases.
    await writer.deleteMany({});
    for (let index = 0; index < dataRows.length; index += CARDKINGDOM_DB_WRITE_BATCH_SIZE) {
      const chunk = dataRows.slice(index, index + CARDKINGDOM_DB_WRITE_BATCH_SIZE);
      await writer.createMany({ data: chunk });
    }

    clearCardKingdomDbMemoryCache();
    return {
      attempted: true,
      refreshed: true,
      rowCount: pricesByScryfallId.size,
      reason: lock.reason === "delegate_unavailable" ? "lock_delegate_unavailable" : null,
      snapshotAtUtc: snapshotAt.toISOString(),
      previousSnapshotAtUtc: previousSnapshotAt?.toISOString() ?? null,
      sourceUpdatedAtUtc: sourceUpdatedAt?.toISOString() ?? null,
    };
  } catch (error) {
    if (isMissingCardKingdomPriceCacheTableError(error)) {
      return {
        attempted: false,
        refreshed: false,
        rowCount: 0,
        reason: "table_missing",
        snapshotAtUtc: null,
        previousSnapshotAtUtc: previousSnapshotAt?.toISOString() ?? null,
        sourceUpdatedAtUtc: null,
      };
    }
    throw error;
  } finally {
    await releaseBackgroundJobLock({
      jobKey: CARDKINGDOM_REFRESH_JOB_KEY,
      token: lock.token,
    });
  }
}

async function fetchCardKingdomUsdPrice(params: {
  scryfallId: string;
  foilMode: "foil" | "nonfoil" | null;
}): Promise<{ price: string | null; reason?: string }> {
  const pricesByScryfallId = await readCardKingdomPricesFromDb();
  const entry = pricesByScryfallId.get(params.scryfallId);
  if (!entry) {
    return { price: null, reason: "Card Kingdom has no cached entry for this Scryfall ID" };
  }

  const effectiveFoilMode = params.foilMode === "foil" ? "foil" : "nonfoil";
  const rawPrice = effectiveFoilMode === "foil" ? entry.foil : entry.nonfoil;
  if (!rawPrice) {
    return {
      price: null,
      reason:
        effectiveFoilMode === "foil"
          ? "Card Kingdom has no foil USD price for this card"
          : "Card Kingdom has no nonfoil USD price for this card",
    };
  }
  const parsed = Number(rawPrice);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      price: null,
      reason:
        effectiveFoilMode === "foil"
          ? "Card Kingdom foil USD price is invalid"
          : "Card Kingdom nonfoil USD price is invalid",
    };
  }
  return { price: normalizeMoney(parsed) };
}

function assertSafeExternalEndpoint(endpoint: string, provider: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error(`${provider} endpoint is not a valid URL`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${provider} endpoint must use https`);
  }
  if (!url.hostname) {
    throw new Error(`${provider} endpoint host is missing`);
  }
  if (url.username || url.password) {
    throw new Error(`${provider} endpoint must not include URL credentials`);
  }
}

function selectScryfallImage(card: ScryfallCard): string | null {
  if (card.image_uris?.normal) {
    return card.image_uris.normal;
  }
  for (const face of card.card_faces ?? []) {
    if (face.image_uris?.normal) {
      return face.image_uris.normal;
    }
  }
  if (card.image_uris?.large) {
    return card.image_uris.large;
  }
  for (const face of card.card_faces ?? []) {
    if (face.image_uris?.large) {
      return face.image_uris.large;
    }
  }
  return null;
}

async function resolvePriceFromSource(params: {
  source: PriceSource;
  card: ScryfallCard | null;
  foilMode: "foil" | "nonfoil" | null;
  scryfallId: string | null;
  justTcgApiKey?: string;
  mtgjsonApiKey?: string;
}): Promise<{ price: string | null; reason?: string }> {
  const { source, card, foilMode, scryfallId, justTcgApiKey, mtgjsonApiKey } = params;

  if (source === "justtcg") {
    if (!scryfallId) {
      return { price: null, reason: "Missing Scryfall ID for JustTCG byExternalID" };
    }
    const price = await fetchJustTcgUsdPriceByExternalId(scryfallId, justTcgApiKey);
    if (!price) {
      return { price: null, reason: "JustTCG has no price for that external ID" };
    }
    return { price };
  }

  if (source === "mtgjson") {
    if (!scryfallId) {
      return { price: null, reason: "Missing Scryfall ID for MTGJSON lookup" };
    }
    const price = await fetchMtgjsonUsdPrice({
      scryfallId,
      setCode: card?.set,
      foilMode,
      apiKey: mtgjsonApiKey,
    });
    if (!price) {
      return { price: null, reason: "MTGJSON has no USD price for this card" };
    }
    return { price };
  }

  if (source === "cardkingdom") {
    if (!scryfallId) {
      return { price: null, reason: "Missing Scryfall ID for Card Kingdom lookup" };
    }
    const { price, reason } = await fetchCardKingdomUsdPrice({ scryfallId, foilMode });
    if (!price) {
      return { price: null, reason: reason ?? "Card Kingdom has no USD price for this card" };
    }
    return { price };
  }

  if (!card) {
    return { price: null, reason: "Missing Scryfall card payload for price resolution" };
  }

  if (foilMode === "foil") {
    if (card.prices.usd_foil) {
      return { price: normalizeMoney(card.prices.usd_foil) };
    }
    if (card.prices.usd) {
      return { price: normalizeMoney(card.prices.usd) };
    }
    return { price: null, reason: "Scryfall has no usd_foil or usd price" };
  }

  if (card.prices.usd) {
    return { price: normalizeMoney(card.prices.usd) };
  }

  if (card.prices.usd_foil) {
    return { price: normalizeMoney(card.prices.usd_foil) };
  }

  return { price: null, reason: "Scryfall has no USD price" };
}

function compactMetafields(connection: MetafieldConnection | undefined): MetafieldNode[] {
  return (connection?.edges ?? []).map((edge) => ({
    namespace: edge.node.namespace,
    key: edge.node.key,
    value: edge.node.value,
    type: edge.node.type ?? null,
  }));
}

function summarizeProductDebug(variant: Pick<VariantNode, "id" | "sku" | "title" | "customMetafields" | "product">) {
  return {
    productId: variant.product.id,
    productTitle: variant.product.title,
    productCustomMetafields: compactMetafields(variant.product.customMetafields),
    variantId: variant.id,
    variantTitle: variant.title,
    variantSku: variant.sku,
    variantCustomMetafields: compactMetafields(variant.customMetafields),
  };
}

function summarizeCustomValidationProductDebug(variant: CustomIdValidationVariantNode) {
  return {
    productId: variant.product.id,
    productTitle: variant.product.title ?? null,
    productCustomMetafields: compactMetafields(variant.product.customMetafields),
    variantId: variant.id ?? null,
    variantCustomMetafields: compactMetafields(variant.customMetafields),
    selectedCustomScryfallId: resolveCustomScryfallIdentifier(variant, {
      allowProductLevelCustomScryfallFallback: true,
    }),
  };
}

function isScannableForSelectedSearchMethod(variant: VariantNode, prefs: SyncPreferences): boolean {
  if (prefs.useCustomScryfallIdField) {
    return hasCustomScryfallIdentifierCandidate(variant, prefs);
  }

  if (prefs.searchMode === "metafield") {
    return (variant.lookupField?.value?.trim() ?? "").length > 0;
  }

  if (prefs.searchMode === "sku") {
    return (resolveSkuForLookup(variant) ?? "").length > 0;
  }

  return (variant.product.title ?? "").trim().length > 0;
}

async function loadAllVariants(
  admin: AdminGraphqlClient,
  prefs: SyncPreferences,
): Promise<VariantNode[]> {
  const variants: VariantNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let chunkIndex = 0;

  while (hasNextPage) {
    const json = await readShopifyGraphqlJsonWithThrottleRetry<{
      errors?: Array<{ message: string }>;
      data?: {
        productVariants?: {
          edges: Array<{ cursor: string; node: VariantNode }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
    } & ShopifyGraphqlCostPayload>({
      admin,
      operationName: "SyncVariants",
      chunkIndex: chunkIndex + 1,
      cursor,
      query: `#graphql
        query SyncVariants(
          $first: Int!,
          $after: String,
          $lookupNs: String!,
          $lookupKey: String!,
          $idNs: String!,
          $idKey: String!,
          $customIdNs: String!,
          $customIdKey: String!
        ) {
          productVariants(first: $first, after: $after) {
            edges {
              cursor
              node {
                id
                sku
                title
                price
                product {
                  id
                  title
                  updatedAt
                  totalVariants
                  customMetafields: metafields(first: 50, namespace: "custom") {
                    edges {
                      node {
                        namespace
                        key
                        value
                        type
                      }
                    }
                  }
                  variants(first: 1) {
                    edges {
                      node {
                        sku
                      }
                    }
                  }
                  scryfallIdField: metafield(namespace: $idNs, key: $idKey) {
                    value
                  }
                  customScryfallIdField: metafield(
                    namespace: $customIdNs,
                    key: $customIdKey
                  ) {
                    value
                  }
                  foilField: metafield(
                    namespace: "${FOIL_METAFIELD_NAMESPACE}",
                    key: "${FOIL_METAFIELD_KEY}"
                  ) {
                    value
                  }
                }
                lookupField: metafield(namespace: $lookupNs, key: $lookupKey) {
                  value
                }
                customMetafields: metafields(first: 50, namespace: "custom") {
                  edges {
                    node {
                      namespace
                      key
                      value
                      type
                    }
                  }
                }
                scryfallIdField: metafield(namespace: $idNs, key: $idKey) {
                  value
                }
                customScryfallIdField: metafield(
                  namespace: $customIdNs,
                  key: $customIdKey
                ) {
                  value
                }
                foilField: metafield(
                  namespace: "${FOIL_METAFIELD_NAMESPACE}",
                  key: "${FOIL_METAFIELD_KEY}"
                ) {
                  value
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
      variables: {
        first: VARIANTS_PAGE_SIZE,
        after: cursor,
        lookupNs: prefs.searchMetafieldNamespace,
        lookupKey: prefs.searchMetafieldKey,
        idNs: prefs.scryfallMetafieldNs,
        idKey: prefs.scryfallMetafieldKey,
        customIdNs: prefs.customScryfallIdNs,
        customIdKey: prefs.customScryfallIdKey,
      },
    });

    const edges = json.data?.productVariants?.edges ?? [];
    chunkIndex += 1;
    if (edges.length > 0) {
      writeSyncLog("info", "[product-debug] chunk boundary products", {
        step: "chunk_products",
        chunkIndex,
        variantsInChunk: edges.length,
        firstProduct: summarizeProductDebug(edges[0].node),
        lastProduct: summarizeProductDebug(edges[edges.length - 1].node),
      });
    }
    variants.push(...edges.map((edge) => edge.node));
    hasNextPage = json.data?.productVariants?.pageInfo.hasNextPage ?? false;
    cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
    const throttleDelayMs = hasNextPage ? getShopifyGraphqlThrottleDelayMs(json) : 0;
    if (throttleDelayMs > 0) {
      writeSyncLog("info", "[product-debug] Shopify GraphQL throttle pacing", {
        operation: "SyncVariants",
        chunkIndex,
        throttleDelayMs,
      });
      await sleep(throttleDelayMs);
    }
  }

  return variants;
}

function toComparableUpdatedAtMs(value: string | null | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function selectProductsByScheduledCursor(params: {
  variants: VariantNode[];
  maxProducts: number;
  scheduledCursor?: ScheduledProductCursor;
}): {
  selectedProductIds: Set<string>;
  selectedProductsCount: number;
  totalProducts: number;
  cursorApplied: boolean;
  cursorWrapped: boolean;
  nextCursor: ScheduledProductCursor;
} {
  const productMetaById = new Map<
    string,
    { productId: string; updatedAtMs: number; updatedAtIso: string | null }
  >();
  for (const variant of params.variants) {
    if (productMetaById.has(variant.product.id)) {
      continue;
    }
    productMetaById.set(variant.product.id, {
      productId: variant.product.id,
      updatedAtMs: toComparableUpdatedAtMs(variant.product.updatedAt),
      updatedAtIso: variant.product.updatedAt ?? null,
    });
  }

  const sortedProducts = Array.from(productMetaById.values()).sort((a, b) => {
    if (a.updatedAtMs !== b.updatedAtMs) {
      return b.updatedAtMs - a.updatedAtMs;
    }
    return a.productId.localeCompare(b.productId);
  });

  if (sortedProducts.length === 0 || params.maxProducts <= 0) {
    return {
      selectedProductIds: new Set<string>(),
      selectedProductsCount: 0,
      totalProducts: sortedProducts.length,
      cursorApplied: false,
      cursorWrapped: false,
      nextCursor: {
        productId: null,
        productUpdatedAt: null,
      },
    };
  }

  let startIndex = 0;
  let cursorApplied = false;
  let cursorWrapped = false;
  const cursorProductId = params.scheduledCursor?.productId?.trim() ?? "";
  if (cursorProductId.length > 0) {
    const cursorIndex = sortedProducts.findIndex((item) => item.productId === cursorProductId);
    if (cursorIndex >= 0) {
      cursorApplied = true;
      startIndex = cursorIndex + 1;
      if (startIndex >= sortedProducts.length) {
        startIndex = 0;
        cursorWrapped = true;
      }
    }
  }

  const selected = sortedProducts.slice(startIndex, startIndex + params.maxProducts);
  const selectedProductIds = new Set(selected.map((item) => item.productId));
  const hasMoreAfterSelection = startIndex + selected.length < sortedProducts.length;
  const nextCursor = hasMoreAfterSelection
    ? {
        productId: selected[selected.length - 1]?.productId ?? null,
        productUpdatedAt: selected[selected.length - 1]?.updatedAtIso ?? null,
      }
    : { productId: null, productUpdatedAt: null };

  return {
    selectedProductIds,
    selectedProductsCount: selected.length,
    totalProducts: sortedProducts.length,
    cursorApplied,
    cursorWrapped,
    nextCursor,
  };
}

async function loadVariantsForCustomScryfallValidation(
  admin: AdminGraphqlClient,
  prefs: SyncPreferences,
): Promise<CustomIdValidationVariantNode[]> {
  const variants: CustomIdValidationVariantNode[] = [];
  let cursor: string | null = null;
  let hasNextPage = true;
  let chunkIndex = 0;

  while (hasNextPage) {
    const json = await readShopifyGraphqlJsonWithThrottleRetry<{
      errors?: Array<{ message: string }>;
      data?: {
        productVariants?: {
          edges: Array<{ cursor: string; node: CustomIdValidationVariantNode }>;
          pageInfo: { hasNextPage: boolean };
        };
      };
    } & ShopifyGraphqlCostPayload>({
      admin,
      operationName: "SyncVariantsForCustomScryfallValidation",
      chunkIndex: chunkIndex + 1,
      cursor,
      query: `#graphql
        query SyncVariantsForCustomScryfallValidation(
          $first: Int!,
          $after: String,
          $customIdNs: String!,
          $customIdKey: String!
        ) {
          productVariants(first: $first, after: $after) {
            edges {
              cursor
              node {
                id
                customMetafields: metafields(first: 50, namespace: "custom") {
                  edges {
                    node {
                      namespace
                      key
                      value
                      type
                    }
                  }
                }
                product {
                  id
                  title
                  totalVariants
                  customMetafields: metafields(first: 50, namespace: "custom") {
                    edges {
                      node {
                        namespace
                        key
                        value
                        type
                      }
                    }
                  }
                  customScryfallIdField: metafield(
                    namespace: $customIdNs,
                    key: $customIdKey
                  ) {
                    value
                  }
                }
                customScryfallIdField: metafield(
                  namespace: $customIdNs,
                  key: $customIdKey
                ) {
                  value
                }
              }
            }
            pageInfo {
              hasNextPage
            }
          }
        }
      `,
      variables: {
        first: VALIDATION_VARIANTS_PAGE_SIZE,
        after: cursor,
        customIdNs: prefs.customScryfallIdNs,
        customIdKey: prefs.customScryfallIdKey,
      },
    });

    const edges = json.data?.productVariants?.edges ?? [];
    chunkIndex += 1;
    if (edges.length > 0) {
      writeSyncLog("info", "[product-debug] custom validation chunk boundary products", {
        step: "custom_validation_chunk_products",
        chunkIndex,
        variantsInChunk: edges.length,
        firstProduct: summarizeCustomValidationProductDebug(edges[0].node),
        lastProduct: summarizeCustomValidationProductDebug(edges[edges.length - 1].node),
      });
    }
    variants.push(...edges.map((edge) => edge.node));
    hasNextPage = json.data?.productVariants?.pageInfo.hasNextPage ?? false;
    cursor = edges.length > 0 ? edges[edges.length - 1].cursor : null;
    const throttleDelayMs = hasNextPage ? getShopifyGraphqlThrottleDelayMs(json) : 0;
    if (throttleDelayMs > 0) {
      writeSyncLog("info", "[product-debug] Shopify GraphQL throttle pacing", {
        operation: "SyncVariantsForCustomScryfallValidation",
        chunkIndex,
        throttleDelayMs,
      });
      await sleep(throttleDelayMs);
    }
  }

  return variants;
}

async function updateVariantPrices(
  admin: AdminGraphqlClient,
  updates: Array<{
    productId: string;
    id: string;
    price: string;
    variantId: string;
    currentPrice: string;
  }>,
  onProgress?: (progress: {
    processedBatches: number;
    totalBatches: number;
    updatedCount: number;
    failures: number;
  }) => Promise<void> | void,
) {
  let updatedCount = 0;
  const failures: Array<{ variantId: string; reason: string }> = [];
  let progressUpdatedCount = 0;
  let progressFailuresCount = 0;
  const successfulUpdates: Array<{
    productId: string;
    id: string;
    price: string;
    variantId: string;
    currentPrice: string;
  }> = [];

  const grouped = new Map<string, typeof updates>();
  for (const update of updates) {
    const current = grouped.get(update.productId) ?? [];
    current.push(update);
    grouped.set(update.productId, current);
  }
  const totalBatches = Array.from(grouped.values()).reduce(
    (acc, productUpdates) => acc + Math.ceil(productUpdates.length / PRICE_UPDATE_BATCH_SIZE),
    0,
  );
  const totalProducts = grouped.size;

  const runBulkUpdate = async (
    productId: string,
    items: Array<{ id: string; price: string }>,
  ) => {
    try {
      const response = await admin.graphql(
        `#graphql
          mutation UpdateVariantPrices($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              userErrors {
                message
              }
            }
          }
        `,
        {
          variables: {
            productId,
            variants: items.map((item) => ({ id: item.id, price: item.price })),
          },
        },
      );

      const json = (await response.json()) as {
        errors?: Array<{ message: string }>;
        data?: {
          productVariantsBulkUpdate?: {
            userErrors: Array<{ message: string }>;
          };
        };
      };

      const errorMessages = [
        ...getGraphqlErrorMessages(json.errors),
        ...(json.data?.productVariantsBulkUpdate?.userErrors?.map((error) => error.message) ?? []),
      ];
      return {
        ok: errorMessages.length === 0,
        errorMessages,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        errorMessages: [message || "Shopify price update request failed"],
      };
    }
  };

  let processedBatches = 0;
  let processedProducts = 0;
  const productEntries = Array.from(grouped.entries());

  const processProductBatches = async (
    productId: string,
    productUpdates: Array<{
      productId: string;
      id: string;
      price: string;
      variantId: string;
      currentPrice: string;
    }>,
  ) => {
    let productUpdatedCount = 0;
    const productFailures: Array<{ variantId: string; reason: string }> = [];
    const productSuccessfulUpdates: Array<{
      productId: string;
      id: string;
      price: string;
      variantId: string;
      currentPrice: string;
    }> = [];
    for (let index = 0; index < productUpdates.length; index += PRICE_UPDATE_BATCH_SIZE) {
      const batch = productUpdates.slice(index, index + PRICE_UPDATE_BATCH_SIZE);
      let batchResult = await runBulkUpdate(
        productId,
        batch.map((item) => ({ id: item.id, price: item.price })),
      );
      const initialBatchErrors = [...batchResult.errorMessages];
      if (
        !batchResult.ok &&
        batchResult.errorMessages.some((message) => isRetryableShopifyMutationError(message))
      ) {
        for (let retry = 0; retry < 2; retry += 1) {
          await sleep(500 * (retry + 1));
          batchResult = await runBulkUpdate(
            productId,
            batch.map((item) => ({ id: item.id, price: item.price })),
          );
          if (batchResult.ok) {
            break;
          }
        }
      }

      if (batchResult.ok) {
        productUpdatedCount += batch.length;
        progressUpdatedCount += batch.length;
        productSuccessfulUpdates.push(...batch);
        processedBatches += 1;
        if (onProgress) {
          await onProgress({
            processedBatches,
            totalBatches,
            updatedCount: progressUpdatedCount,
            failures: progressFailuresCount,
          });
        }
        continue;
      }

      // Fallback: retry per variant to salvage partial successes.
      for (const item of batch) {
        let singleResult = await runBulkUpdate(productId, [{ id: item.id, price: item.price }]);
        if (
          !singleResult.ok &&
          singleResult.errorMessages.some((message) => isRetryableShopifyMutationError(message))
        ) {
          for (let retry = 0; retry < 2; retry += 1) {
            await sleep(500 * (retry + 1));
            singleResult = await runBulkUpdate(productId, [{ id: item.id, price: item.price }]);
            if (singleResult.ok) {
              break;
            }
          }
        }
        if (singleResult.ok) {
          productUpdatedCount += 1;
          progressUpdatedCount += 1;
          productSuccessfulUpdates.push(item);
          continue;
        }
        progressFailuresCount += 1;
        productFailures.push({
          variantId: item.variantId,
          reason: singleResult.errorMessages.join("; "),
        });
      }
      processedBatches += 1;
      if (onProgress) {
        await onProgress({
          processedBatches,
          totalBatches,
          updatedCount: progressUpdatedCount,
          failures: progressFailuresCount,
        });
      }
      writeSyncLog("warn", "[product-debug] price update batch failed", {
        step: "price_update_batch_failed",
        productId,
        batchSize: batch.length,
        productUpdatedCount,
        failures: productFailures.length,
        batchErrors: batchResult.errorMessages.slice(0, 3),
        initialBatchErrors: initialBatchErrors.slice(0, 3),
        latestFailureReason: productFailures[productFailures.length - 1]?.reason ?? null,
      });
    }

    processedProducts += 1;
    writeSyncLog("info", "[product-debug] price update product complete", {
      step: "price_update_product_complete",
      productId,
      processedProducts,
      totalProducts,
      productUpdatedCount,
      failures: productFailures.length,
      failureSamples: productFailures.slice(0, 3),
    });

    return {
      productUpdatedCount,
      productFailures,
      productSuccessfulUpdates,
    };
  };

  const workers = Math.min(PRICE_UPDATE_PRODUCT_CONCURRENCY, productEntries.length || 1);
  let nextProductIndex = 0;
  const workerTasks = Array.from({ length: workers }, async () => {
    const results: Array<{
      productUpdatedCount: number;
      productFailures: Array<{ variantId: string; reason: string }>;
      productSuccessfulUpdates: Array<{
        productId: string;
        id: string;
        price: string;
        variantId: string;
        currentPrice: string;
      }>;
    }> = [];
    while (nextProductIndex < productEntries.length) {
      const currentIndex = nextProductIndex;
      nextProductIndex += 1;
      const [productId, productUpdates] = productEntries[currentIndex];
      const result = await processProductBatches(productId, productUpdates);
      results.push(result);
    }
    return results;
  });

  const allWorkerResults = await Promise.all(workerTasks);
  for (const workerResults of allWorkerResults) {
    for (const result of workerResults) {
      updatedCount += result.productUpdatedCount;
      failures.push(...result.productFailures);
      successfulUpdates.push(...result.productSuccessfulUpdates);
    }
  }

  if (failures.length > 0) {
    const reasons = new Map<string, number>();
    for (const failure of failures) {
      const reason = (failure.reason ?? "").trim() || "Unknown mutation error";
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
    const topFailureReasons = Array.from(reasons.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, count]) => ({ reason, count }));
    writeSyncLog("warn", "[product-debug] price update failures summary", {
      requestedUpdates: updates.length,
      updatedCount,
      failures: failures.length,
      topFailureReasons,
      failureSamples: failures.slice(0, 5),
    });
    if (updatedCount === 0 && updates.length > 0) {
      writeSyncLog("error", "[product-debug] all price updates failed", {
        requestedUpdates: updates.length,
        failures: failures.length,
        topFailureReasons,
        hint:
          "Likely permissions/token/shop context issue if reason repeats across all products.",
      });
    }
  }

  return { updatedCount, failures, successfulUpdates };
}

async function setVariantTextMetafields(
  admin: AdminGraphqlClient,
  updates: MetafieldUpdateInput[],
) {
  if (updates.length === 0) {
    return 0;
  }

  let updated = 0;
  for (let index = 0; index < updates.length; index += METAFIELD_UPDATE_BATCH_SIZE) {
    const batch = updates.slice(index, index + METAFIELD_UPDATE_BATCH_SIZE);
    const runBatch = async (batchItems: MetafieldUpdateInput[]) => {
      const response = await admin.graphql(
        `#graphql
          mutation SetScryfallMetafields($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              metafields {
                id
              }
              userErrors {
                field
                message
              }
            }
          }
        `,
        {
          variables: {
            metafields: batchItems.map((item) => ({
              ownerId: item.ownerId,
              namespace: item.namespace,
              key: item.key,
              type: item.type ?? "single_line_text_field",
              value: item.value,
            })),
          },
        },
      );

      return (await response.json()) as {
        errors?: Array<{ message: string }>;
        data?: {
          metafieldsSet?: {
            metafields?: Array<{ id?: string }>;
            userErrors: Array<{ field?: string[]; message: string }>;
          };
        };
      };
    };

    let json = await runBatch(batch);
    let graphqlErrors = getGraphqlErrorMessages(json.errors);
    let userErrors = json.data?.metafieldsSet?.userErrors ?? [];

    if (
      userErrors.length > 0 &&
      batch.some((item) => item.type === "number_decimal") &&
      userErrors.some((error) => isMetafieldTypeConflict(error.message))
    ) {
      const fallbackBatch = batch.map((item) => ({
        ...item,
        type: item.type === "number_decimal" ? "single_line_text_field" : item.type,
      }));
      json = await runBatch(fallbackBatch);
      graphqlErrors = getGraphqlErrorMessages(json.errors);
      userErrors = json.data?.metafieldsSet?.userErrors ?? [];
    }

    if (graphqlErrors.length > 0 && graphqlErrors.some((error) => isRetryableShopifyMetafieldError(error))) {
      for (let retry = 0; retry < 2; retry += 1) {
        await sleep(500 * (retry + 1));
        json = await runBatch(batch);
        graphqlErrors = getGraphqlErrorMessages(json.errors);
        userErrors = json.data?.metafieldsSet?.userErrors ?? [];
        if (graphqlErrors.length === 0) {
          break;
        }
      }
    }

    if (
      userErrors.length > 0 &&
      userErrors.some((error) => isRetryableShopifyMetafieldError(error.message))
    ) {
      for (let retry = 0; retry < 2; retry += 1) {
        await sleep(500 * (retry + 1));
        json = await runBatch(batch);
        graphqlErrors = getGraphqlErrorMessages(json.errors);
        userErrors = json.data?.metafieldsSet?.userErrors ?? [];
        if (graphqlErrors.length === 0 && userErrors.length === 0) {
          break;
        }
      }
    }
    if (graphqlErrors.length > 0) {
      writeSyncLog("warn", "[product-debug] metafieldsSet graphql errors", {
        batchSize: batch.length,
        errors: graphqlErrors,
      });
      continue;
    }

    const createdCount = json.data?.metafieldsSet?.metafields?.length ?? 0;
    if (createdCount > 0) {
      updated += createdCount;
      continue;
    }

    if (userErrors.length > 0) {
      const failedIndexes = new Set<number>();
      for (const error of userErrors) {
        const rawField = error.field ?? [];
        const idx = rawField.find((part) => /^\d+$/.test(part));
        if (idx !== undefined) {
          failedIndexes.add(Number(idx));
        }
      }

      // If Shopify returns index-aware errors, count successful rows in the batch.
      if (failedIndexes.size > 0) {
        updated += Math.max(0, batch.length - failedIndexes.size);
      }

      writeSyncLog("warn", "[product-debug] metafieldsSet user errors", {
        batchSize: batch.length,
        failedIndexes: Array.from(failedIndexes.values()),
        errors: userErrors.slice(0, 10),
      });
      continue;
    }

    // No errors and no metafields payload: treat as full success fallback.
    updated += batch.length;
  }

  return updated;
}

async function setVariantTextMetafieldsWithRetry(
  admin: AdminGraphqlClient,
  updates: MetafieldUpdateInput[],
  attempts = 2,
): Promise<number> {
  let updated = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    updated = await setVariantTextMetafields(admin, updates);
    if (updated === updates.length) {
      return updated;
    }
  }
  return updated;
}

async function reorderProductMediaFirst(
  admin: AdminGraphqlClient,
  productId: string,
  mediaId: string,
): Promise<boolean> {
  const reorderResponse = await admin.graphql(
    `#graphql
      mutation MoveMediaFirst($id: ID!, $moves: [MoveInput!]!) {
        productReorderMedia(id: $id, moves: $moves) {
          userErrors {
            message
          }
        }
      }
    `,
    {
      variables: {
        id: productId,
        moves: [{ id: mediaId, newPosition: "0" }],
      },
    },
  );

  const reorderJson = (await reorderResponse.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      productReorderMedia?: {
        userErrors?: Array<{ message: string }>;
      };
    };
  };

  return (
    (reorderJson.errors?.length ?? 0) === 0 &&
    (reorderJson.data?.productReorderMedia?.userErrors?.length ?? 0) === 0
  );
}

async function reorderProductMediaFirstWithRetry(
  admin: AdminGraphqlClient,
  productId: string,
  mediaId: string,
): Promise<boolean> {
  for (let attempt = 1; attempt <= SHOPIFY_IMAGE_REORDER_MAX_ATTEMPTS; attempt += 1) {
    const reordered = await reorderProductMediaFirst(admin, productId, mediaId);
    if (reordered) {
      return true;
    }
    if (attempt < SHOPIFY_IMAGE_REORDER_MAX_ATTEMPTS) {
      await sleep(SHOPIFY_IMAGE_REORDER_RETRY_DELAY_MS * attempt);
    }
  }
  return false;
}

async function createOrReuseProductImage(
  admin: AdminGraphqlClient,
  productId: string,
  imageUrl: string,
): Promise<ProductImageSyncOutcome> {
  const targetFingerprint = toImageFingerprint(imageUrl);
  if (!targetFingerprint) {
    return { ok: false, changed: false, reason: "Invalid image URL fingerprint" };
  }
  const pendingCreateKey = `${productId}|${targetFingerprint}`;
  const now = Date.now();
  const pendingCreateMap = global.__shopifyImageCreatePendingByKey;
  if (pendingCreateMap) {
    const pendingUntil = pendingCreateMap.get(pendingCreateKey);
    if (typeof pendingUntil === "number") {
      if (pendingUntil > now) {
        return {
          ok: true,
          changed: false,
          reason: "Image create already accepted recently; waiting for media visibility",
        };
      }
      pendingCreateMap.delete(pendingCreateKey);
    }
  }

  const fetchProductMediaNodes = async () => {
    const response = await admin.graphql(
      `#graphql
        query ProductMediaForSync($id: ID!) {
          product(id: $id) {
            syncImageFingerprintField: metafield(
              namespace: "${PRODUCT_IMAGE_SYNC_FINGERPRINT_NAMESPACE}",
              key: "${PRODUCT_IMAGE_SYNC_FINGERPRINT_KEY}"
            ) {
              value
            }
            media(first: 100) {
              nodes {
                ... on MediaImage {
                  id
                  image {
                    url
                  }
                }
              }
            }
          }
        }
      `,
      { variables: { id: productId } },
    );
    return (await response.json()) as {
      errors?: Array<{ message: string }>;
      data?: {
        product?: {
          syncImageFingerprintField?: { value?: string | null } | null;
          media?: {
            nodes?: Array<{ id?: string; image?: { url?: string | null } | null }>;
          };
        };
      };
    };
  };

  const fetchProductMediaNodesWithRetry = async (
    attempts = 3,
    delayMs = SHOPIFY_IMAGE_VERIFY_RETRY_DELAY_MS,
  ) => {
    let lastJson = await fetchProductMediaNodes();
    for (let attempt = 1; attempt < attempts; attempt += 1) {
      const hasErrors = getGraphqlErrorMessages(lastJson.errors).length > 0;
      const hasProduct = Boolean(lastJson.data?.product);
      if (!hasErrors && hasProduct) {
        return lastJson;
      }
      await sleep(delayMs * attempt);
      lastJson = await fetchProductMediaNodes();
    }
    return lastJson;
  };

  const persistProductImageFingerprint = async (): Promise<boolean> => {
    try {
      const updated = await setVariantTextMetafields(admin, [
        {
          ownerId: productId,
          namespace: PRODUCT_IMAGE_SYNC_FINGERPRINT_NAMESPACE,
          key: PRODUCT_IMAGE_SYNC_FINGERPRINT_KEY,
          value: targetFingerprint,
        },
      ]);
      if (updated < 1) {
        writeSyncLog("warn", "[product-debug] image fingerprint marker write incomplete", {
          productId,
          imageUrl,
          updated,
        });
        return false;
      }
      return true;
    } catch (error) {
      writeSyncLog("warn", "[product-debug] image fingerprint marker write failed", {
        productId,
        imageUrl,
        reason: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  };

  const existingJson = await fetchProductMediaNodesWithRetry();
  const existingReadErrors = getGraphqlErrorMessages(existingJson.errors);
  const canInspectExistingMedia =
    existingReadErrors.length === 0 && Boolean(existingJson.data?.product);
  const existingMarkerFingerprint =
    existingJson.data?.product?.syncImageFingerprintField?.value?.trim() ?? null;
  const hasExistingMarkerFingerprint = Boolean(existingMarkerFingerprint);
  const mediaReadIssueReason =
    existingReadErrors.length > 0
      ? existingReadErrors.join("; ")
      : "media read returned empty product";
  if (hasExistingMarkerFingerprint && !canInspectExistingMedia) {
    pendingCreateMap?.delete(pendingCreateKey);
    return {
      ok: true,
      changed: false,
      reason: "Image fingerprint marker already exists; skipping create",
    };
  }
  if (existingMarkerFingerprint === targetFingerprint && !canInspectExistingMedia) {
    pendingCreateMap?.delete(pendingCreateKey);
    return {
      ok: true,
      changed: false,
      reason: "Image fingerprint marker already set for this product",
    };
  }
  if (!canInspectExistingMedia) {
    writeSyncLog("warn", "[product-debug] image create precheck inconclusive", {
      productId,
      imageUrl,
      reason: mediaReadIssueReason,
      action: "skip_create_to_avoid_duplicates",
    });
    return {
      ok: false,
      changed: false,
      reason: `media read unavailable before create (safe skip to avoid duplicates): ${mediaReadIssueReason}`,
    };
  }

  if (canInspectExistingMedia) {
    const mediaNodes = existingJson.data?.product?.media?.nodes ?? [];
    const firstNode = mediaNodes[0];
    const firstUrl = firstNode?.image?.url ?? null;
    const firstFingerprint = firstNode?.image?.url
      ? toImageFingerprint(firstNode.image.url)
      : null;
    if (isScryfallHostedImage(firstUrl)) {
      pendingCreateMap?.delete(pendingCreateKey);
      return {
        ok: true,
        changed: false,
        reason: "Primary image already from Scryfall",
      };
    }
    if (firstFingerprint === targetFingerprint) {
      pendingCreateMap?.delete(pendingCreateKey);
      await persistProductImageFingerprint();
      return { ok: true, changed: false };
    }

    const existingTarget = mediaNodes.find((node) => {
      if (!node?.id || !node?.image?.url) {
        return false;
      }
      return toImageFingerprint(node.image.url) === targetFingerprint;
    });
    if (existingTarget?.id) {
      pendingCreateMap?.delete(pendingCreateKey);
      const reordered = await reorderProductMediaFirstWithRetry(admin, productId, existingTarget.id);
      await persistProductImageFingerprint();
      return {
        ok: true,
        changed: reordered,
        reason: reordered
          ? undefined
          : "Existing product image found, but could not reorder to first position",
      };
    }

    const existingScryfallImage = mediaNodes.find((node) =>
      Boolean(node?.id) && isScryfallHostedImage(node?.image?.url ?? null),
    );
    if (existingScryfallImage?.id) {
      pendingCreateMap?.delete(pendingCreateKey);
      const reordered = await reorderProductMediaFirstWithRetry(
        admin,
        productId,
        existingScryfallImage.id,
      );
      return {
        ok: true,
        changed: reordered,
        reason: reordered
          ? undefined
          : "Scryfall image exists, but could not reorder to first position",
      };
    }

    if (hasExistingMarkerFingerprint) {
      pendingCreateMap?.delete(pendingCreateKey);
      return {
        ok: true,
        changed: false,
        reason: "Image fingerprint marker already exists; skipping create to prevent duplicates",
      };
    }
  }

  const response = await admin.graphql(
    `#graphql
      mutation AddProductImage($productId: ID!, $media: [CreateMediaInput!]!) {
        productCreateMedia(productId: $productId, media: $media) {
          media {
            ... on MediaImage {
              id
            }
          }
          mediaUserErrors {
            message
          }
        }
      }
    `,
    {
      variables: {
        productId,
        media: [
          {
            mediaContentType: "IMAGE",
            originalSource: imageUrl,
          },
        ],
      },
    },
  );

  const json = (await response.json()) as {
    errors?: Array<{ message: string }>;
    data?: {
      productCreateMedia?: {
        media?: Array<{ id?: string }>;
        mediaUserErrors: Array<{ message: string }>;
      };
    };
  };

  const hasErrors =
    (json.errors?.length ?? 0) > 0 ||
    (json.data?.productCreateMedia?.mediaUserErrors?.length ?? 0) > 0;
  if (hasErrors) {
    const gqlErrors = getGraphqlErrorMessages(json.errors);
    const mediaErrors = json.data?.productCreateMedia?.mediaUserErrors?.map((e) => e.message) ?? [];
    const readContext =
      !canInspectExistingMedia
        ? `media read unavailable before create: ${mediaReadIssueReason}`
        : existingReadErrors.length > 0
          ? `media read failed before create: ${existingReadErrors.join("; ")}`
          : null;
    return {
      ok: false,
      changed: false,
      reason: [...gqlErrors, ...mediaErrors, ...(readContext ? [readContext] : [])].join("; ") ||
        "productCreateMedia failed",
    };
  }

  const mediaId = json.data?.productCreateMedia?.media?.[0]?.id;
  let resolvedMediaId = mediaId;
  if (!resolvedMediaId) {
    for (let attempt = 1; attempt <= SHOPIFY_IMAGE_VERIFY_MAX_ATTEMPTS; attempt += 1) {
      const verifyJson = await fetchProductMediaNodesWithRetry(2, SHOPIFY_IMAGE_VERIFY_RETRY_DELAY_MS);
      const verifyErrors = getGraphqlErrorMessages(verifyJson.errors);
      if (verifyErrors.length === 0) {
        const nodes = verifyJson.data?.product?.media?.nodes ?? [];
        const matched = nodes.find((node) => {
          if (!node?.id || !node?.image?.url) {
            return false;
          }
          return toImageFingerprint(node.image.url) === targetFingerprint;
        });
        if (matched?.id) {
          resolvedMediaId = matched.id;
          break;
        }
      }
      if (attempt < SHOPIFY_IMAGE_VERIFY_MAX_ATTEMPTS) {
        await sleep(SHOPIFY_IMAGE_VERIFY_RETRY_DELAY_MS * attempt);
      }
    }
  }

  if (!resolvedMediaId) {
    const markerPersisted = await persistProductImageFingerprint();
    pendingCreateMap?.set(pendingCreateKey, Date.now() + SHOPIFY_IMAGE_PENDING_CREATE_TTL_MS);
    return {
      ok: true,
      changed: true,
      reason:
        markerPersisted
          ? "Image create accepted, but product media is not readable yet (verification pending)"
          : "Image create accepted, marker pending, and product media is not readable yet (verification pending)",
    };
  }

  pendingCreateMap?.delete(pendingCreateKey);
  const markerPersisted = await persistProductImageFingerprint();
  if (!markerPersisted) {
    // Keep temporary dedupe lock when marker persistence fails.
    pendingCreateMap?.set(pendingCreateKey, Date.now() + SHOPIFY_IMAGE_PENDING_CREATE_TTL_MS);
  }
  const reordered = await reorderProductMediaFirstWithRetry(admin, productId, resolvedMediaId);
  return {
    // Consider create success even if reorder fails, so image availability
    // is not reported as failed.
    ok: true,
    changed: true,
    reason: reordered ? undefined : "Image created, but could not reorder to first position",
  };
}

function parseFoilMetafieldValue(rawValue: string | null | undefined): "foil" | "nonfoil" | null {
  const normalized = rawValue?.trim().toLowerCase() ?? "";
  if (!normalized) {
    return null;
  }

  if (["1", "true", "yes", "y", "foil"].includes(normalized)) {
    return "foil";
  }

  if (["0", "false", "no", "n", "nonfoil", "non-foil"].includes(normalized)) {
    return "nonfoil";
  }

  return null;
}

function resolveFoilMetafieldDebug(variant: VariantNode): {
  rawValue: string | null;
  owner: "variant" | "product" | null;
  foilMode: "foil" | "nonfoil" | null;
} {
  const variantRawValue = variant.foilField?.value ?? null;
  const variantMode = parseFoilMetafieldValue(variantRawValue);
  if (variantMode) {
    return {
      rawValue: variantRawValue,
      owner: "variant",
      foilMode: variantMode,
    };
  }

  const productRawValue = variant.product.foilField?.value ?? null;
  const productMode = parseFoilMetafieldValue(productRawValue);
  if (productMode) {
    return {
      rawValue: productRawValue,
      owner: "product",
      foilMode: productMode,
    };
  }

  return {
    rawValue: null,
    owner: null,
    foilMode: null,
  };
}

function resolveFoilModeFromMetafields(variant: VariantNode): "foil" | "nonfoil" | null {
  return resolveFoilMetafieldDebug(variant).foilMode;
}

async function lookupCardForVariant(
  variant: VariantNode,
  prefs: SyncPreferences,
): Promise<{
  card: ScryfallCard | null;
  foilMode: "foil" | "nonfoil" | null;
  scryfallId: string | null;
  scryfallMetaOwner: "product" | "variant";
} | null> {
  return matchCardForVariant({
    variant,
    prefs,
    foilMode: resolveFoilModeFromMetafields(variant),
  });
}

async function runProductImageStage(params: {
  admin: AdminGraphqlClient;
  productImageUpdates: Map<string, string>;
  imageBlockDelayMsOverride?: number;
  queueProgressContext?: {
    globalBlockIndex: number;
    globalTotalBlocks: number;
    globalProcessedBefore: number;
    globalTotalItems: number;
  };
}): Promise<{
  imagesUpdated: number;
  failures: Array<{ productId: string; imageUrl: string; reason: string }>;
}> {
  const { admin, productImageUpdates, imageBlockDelayMsOverride, queueProgressContext } = params;
  const hasQueueProgressContext =
    typeof queueProgressContext?.globalBlockIndex === "number" &&
    typeof queueProgressContext?.globalTotalBlocks === "number" &&
    typeof queueProgressContext?.globalProcessedBefore === "number" &&
    typeof queueProgressContext?.globalTotalItems === "number";
  const effectiveImageBlockDelayMs =
    typeof imageBlockDelayMsOverride === "number" && Number.isFinite(imageBlockDelayMsOverride)
      ? Math.max(0, Math.floor(imageBlockDelayMsOverride))
      : SHOPIFY_IMAGE_STAGE_BLOCK_DELAY_MS;

  writeSyncLog("info", "[product-debug] image stage start", {
    productsToSync: productImageUpdates.size,
    blockSize: SHOPIFY_IMAGE_STAGE_BLOCK_SIZE,
    blockDelayMs: effectiveImageBlockDelayMs,
    concurrency: SHOPIFY_IMAGE_STAGE_CONCURRENCY,
    mode: "single-attempt-no-retry",
    globalBlock: hasQueueProgressContext ? queueProgressContext.globalBlockIndex : null,
    globalTotalBlocks: hasQueueProgressContext ? queueProgressContext.globalTotalBlocks : null,
    globalProcessedBefore: hasQueueProgressContext ? queueProgressContext.globalProcessedBefore : null,
    globalTotal: hasQueueProgressContext ? queueProgressContext.globalTotalItems : null,
  });

  let imagesUpdated = 0;
  let imageProcessed = 0;
  const imageProgressEvery = 25;
  const failedImages = new Map<string, { imageUrl: string; reason: string }>();
  const imageEntries = Array.from(productImageUpdates.entries());
  const imageBlockSize = Math.max(1, SHOPIFY_IMAGE_STAGE_BLOCK_SIZE);
  const imageTotalBlocks = Math.ceil(imageEntries.length / imageBlockSize);

  const processImageItem = async (params: {
    productId: string;
    imageUrl: string;
    blockNumber?: number;
    totalBlocks?: number;
  }) => {
    const { productId, imageUrl } = params;
    try {
      const outcome = await withTimeout(
        createOrReuseProductImage(admin, productId, imageUrl),
        SHOPIFY_IMAGE_SYNC_TIMEOUT_MS,
        "Timed out while syncing product image",
      );
      if (outcome.ok) {
        if (outcome.changed) {
          imagesUpdated += 1;
        }
        failedImages.delete(productId);
      } else {
        const failureReason = outcome.reason ?? "Image sync failed without explicit reason";
        failedImages.set(productId, {
          imageUrl,
          reason: failureReason,
        });
        writeSyncLog("warn", "[product-debug] image sync failed", {
          productId,
          imageUrl,
          reason: failureReason,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedImages.set(productId, { imageUrl, reason: message });
      writeSyncLog("warn", "[product-debug] image sync failed", {
        productId,
        reason: message,
        imageUrl,
      });
    } finally {
      imageProcessed += 1;
      if (
        imageProcessed % imageProgressEvery === 0 ||
        imageProcessed === productImageUpdates.size
      ) {
        const processedForLog = hasQueueProgressContext
          ? queueProgressContext.globalProcessedBefore + imageProcessed
          : imageProcessed;
        const totalForLog = hasQueueProgressContext
          ? queueProgressContext.globalTotalItems
          : productImageUpdates.size;
        const blockForLog = hasQueueProgressContext
          ? queueProgressContext.globalBlockIndex
          : params.blockNumber ?? null;
        const totalBlocksForLog = hasQueueProgressContext
          ? queueProgressContext.globalTotalBlocks
          : params.totalBlocks ?? null;
        writeSyncLog("info", "[product-debug] image stage progress", {
          block: blockForLog,
          totalBlocks: totalBlocksForLog,
          processed: processedForLog,
          total: totalForLog,
          localProcessed: imageProcessed,
          localTotal: productImageUpdates.size,
          imagesUpdated,
          failures: failedImages.size,
        });
      }
    }
  };

  for (let blockIndex = 0; blockIndex < imageEntries.length; blockIndex += imageBlockSize) {
    const blockNumber = Math.floor(blockIndex / imageBlockSize) + 1;
    const block = imageEntries.slice(blockIndex, blockIndex + imageBlockSize);
    const failuresBeforeBlock = failedImages.size;
    const processedBeforeForLog = hasQueueProgressContext
      ? queueProgressContext.globalProcessedBefore + imageProcessed
      : imageProcessed;
    const blockForLog = hasQueueProgressContext
      ? queueProgressContext.globalBlockIndex
      : blockNumber;
    const totalBlocksForLog = hasQueueProgressContext
      ? queueProgressContext.globalTotalBlocks
      : imageTotalBlocks;
    const totalForLog = hasQueueProgressContext
      ? queueProgressContext.globalTotalItems
      : productImageUpdates.size;
    writeSyncLog("info", "[product-debug] image block start", {
      block: blockForLog,
      totalBlocks: totalBlocksForLog,
      blockSize: block.length,
      blockConcurrency: Math.min(SHOPIFY_IMAGE_STAGE_CONCURRENCY, block.length),
      processedBeforeBlock: processedBeforeForLog,
      total: totalForLog,
      localBlock: blockNumber,
      localTotalBlocks: imageTotalBlocks,
      localTotal: productImageUpdates.size,
    });
    let blockCursor = 0;
    const workers = Array.from(
      { length: Math.max(1, Math.min(SHOPIFY_IMAGE_STAGE_CONCURRENCY, block.length)) },
      async () => {
        while (true) {
          const currentIndex = blockCursor;
          blockCursor += 1;
          if (currentIndex >= block.length) {
            break;
          }
          const [productId, imageUrl] = block[currentIndex];
          await processImageItem({
            productId,
            imageUrl,
            blockNumber,
            totalBlocks: imageTotalBlocks,
          });
        }
      },
    );
    await Promise.all(workers);

    const processedForLog = hasQueueProgressContext
      ? queueProgressContext.globalProcessedBefore + imageProcessed
      : imageProcessed;
    writeSyncLog("info", "[product-debug] image block end", {
      block: blockForLog,
      totalBlocks: totalBlocksForLog,
      processed: processedForLog,
      total: totalForLog,
      localBlock: blockNumber,
      localTotalBlocks: imageTotalBlocks,
      localProcessed: imageProcessed,
      localTotal: productImageUpdates.size,
      imagesUpdated,
      failures: failedImages.size,
    });
    if (blockNumber < imageTotalBlocks && effectiveImageBlockDelayMs > 0) {
      const blockIntroducedFailures = failedImages.size > failuresBeforeBlock;
      const nextBlockDelayMs = blockIntroducedFailures
        ? effectiveImageBlockDelayMs
        : Math.min(500, effectiveImageBlockDelayMs);
      if (nextBlockDelayMs > 0) {
        await sleep(nextBlockDelayMs);
      }
    }
  }

  for (const [productId, pending] of failedImages.entries()) {
    writeSyncLog("warn", "[product-debug] image sync failed (final)", {
      productId,
      imageUrl: pending.imageUrl,
      reason: pending.reason,
    });
  }

  const failureByReason = new Map<string, number>();
  for (const pending of failedImages.values()) {
    const reason = pending.reason || "Unknown image sync error";
    failureByReason.set(reason, (failureByReason.get(reason) ?? 0) + 1);
  }

  writeSyncLog("info", "[product-debug] image stage end", {
    attempted: productImageUpdates.size,
    productsToSync: productImageUpdates.size,
    imagesUpdated,
    failures: failedImages.size,
    globalBlock: hasQueueProgressContext ? queueProgressContext.globalBlockIndex : null,
    globalTotalBlocks: hasQueueProgressContext ? queueProgressContext.globalTotalBlocks : null,
    globalProcessed: hasQueueProgressContext
      ? queueProgressContext.globalProcessedBefore + imageProcessed
      : null,
    globalTotal: hasQueueProgressContext ? queueProgressContext.globalTotalItems : null,
    failureReasons: Array.from(failureByReason.entries()).map(([reason, count]) => ({
      reason,
      count,
    })),
  });

  return {
    imagesUpdated,
    failures: Array.from(failedImages.entries()).map(([productId, pending]) => ({
      productId,
      imageUrl: pending.imageUrl,
      reason: pending.reason,
    })),
  };
}

async function recoverStaleImageQueueLocks(shop: string): Promise<void> {
  const delegate = getImageSyncQueueDelegate();
  if (!delegate) {
    return;
  }
  const threshold = new Date(Date.now() - SHOPIFY_IMAGE_QUEUE_STALE_LOCK_MS);
  try {
    const recovered = await delegate.updateMany({
      where: {
        shop,
        status: "processing",
        lockedAt: { lt: threshold },
      },
      data: {
        status: "failed",
        lastError: "Recovered stale processing lock",
        nextAttemptAt: new Date(),
        lockedAt: null,
      },
    });
    if ((recovered?.count ?? 0) > 0) {
      writeSyncLog("warn", "[product-debug] recovered stale image queue locks", {
        shop,
        recovered: recovered.count,
      });
    }
  } catch (error) {
    if (isMissingImageQueueTableError(error)) {
      return;
    }
    throw error;
  }
}

async function enqueueImageSyncQueueJobs(params: {
  shop: string;
  productImageUpdates: Map<string, string>;
  productScryfallIds: Map<string, string>;
}): Promise<{ queued: number; skippedAlreadyDone: number }> {
  const delegate = getImageSyncQueueDelegate();
  if (!delegate || params.productImageUpdates.size === 0) {
    return { queued: 0, skippedAlreadyDone: 0 };
  }

  const rows: Array<{ productId: string; imageUrl: string; fingerprint: string; scryfallId: string | null }> =
    [];
  for (const [productId, imageUrl] of params.productImageUpdates.entries()) {
    const fingerprint = toImageFingerprint(imageUrl);
    if (!fingerprint) {
      continue;
    }
    rows.push({
      productId,
      imageUrl,
      fingerprint,
      scryfallId: params.productScryfallIds.get(productId) ?? null,
    });
  }
  if (rows.length === 0) {
    return { queued: 0, skippedAlreadyDone: 0 };
  }

  try {
    const existing = await delegate.findMany({
      where: {
        shop: params.shop,
        productId: { in: rows.map((row) => row.productId) },
      },
      select: {
        productId: true,
        fingerprint: true,
        status: true,
      },
    });
    const existingByProductId = new Map(
      existing.map((entry) => [
        entry.productId,
        {
          fingerprint: entry.fingerprint,
          status: entry.status,
        },
      ]),
    );

    let queued = 0;
    let skippedAlreadyDone = 0;
    for (const row of rows) {
      const previous = existingByProductId.get(row.productId);
      if (
        previous &&
        previous.fingerprint === row.fingerprint &&
        previous.status === "done"
      ) {
        skippedAlreadyDone += 1;
        continue;
      }

      await delegate.upsert({
        where: {
          shop_productId: {
            shop: params.shop,
            productId: row.productId,
          },
        },
        create: {
          shop: params.shop,
          productId: row.productId,
          scryfallId: row.scryfallId,
          imageUrl: row.imageUrl,
          fingerprint: row.fingerprint,
          status: "queued",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          lockedAt: null,
        },
        update: {
          scryfallId: row.scryfallId,
          imageUrl: row.imageUrl,
          fingerprint: row.fingerprint,
          status: "queued",
          attempts: 0,
          lastError: null,
          nextAttemptAt: null,
          lockedAt: null,
        },
      });
      queued += 1;
    }
    return { queued, skippedAlreadyDone };
  } catch (error) {
    if (isMissingImageQueueTableError(error)) {
      writeSyncLog("warn", "[product-debug] image queue table unavailable, skipping enqueue", {
        shop: params.shop,
      });
      return { queued: 0, skippedAlreadyDone: 0 };
    }
    throw error;
  }
}

async function processImageSyncQueueForShop(params: {
  shop: string;
  admin: AdminGraphqlClient;
  imageBlockDelayMsOverride?: number;
  maxItems?: number;
  maxRuntimeMs?: number;
  productIds?: string[];
}): Promise<{ processedJobs: number; imagesUpdated: number; pendingJobs: number }> {
  const delegate = getImageSyncQueueDelegate();
  if (!delegate) {
    return { processedJobs: 0, imagesUpdated: 0, pendingJobs: 0 };
  }

  const scopedProductIds = Array.from(
    new Set((params.productIds ?? []).map((productId) => productId.trim()).filter(Boolean)),
  );
  const hasScopedProducts = scopedProductIds.length > 0;
  if (params.productIds && !hasScopedProducts) {
    return { processedJobs: 0, imagesUpdated: 0, pendingJobs: 0 };
  }

  const maxItems = Math.max(
    1,
    Math.min(10_000, Math.floor(params.maxItems ?? SHOPIFY_IMAGE_QUEUE_MAX_ITEMS_PER_RUN)),
  );
  const maxRuntimeMs = Math.max(
    10_000,
    Math.min(
      SHOPIFY_IMAGE_QUEUE_RUNTIME_HARD_CAP_MS,
      Math.floor(params.maxRuntimeMs ?? SHOPIFY_IMAGE_QUEUE_MAX_RUNTIME_MS),
    ),
  );
  const startedAt = Date.now();
  let processedJobs = 0;
  let imagesUpdated = 0;

  await recoverStaleImageQueueLocks(params.shop);

  const eligibilityNow = new Date();
  const queueWhereBase = {
    shop: params.shop,
    ...(hasScopedProducts ? { productId: { in: scopedProductIds } } : {}),
    status: "queued" as const,
    OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: eligibilityNow } }],
  };
  const totalTargetJobsCount = await delegate.count({
    where: queueWhereBase,
  });
  const totalTargetJobs = Math.min(totalTargetJobsCount, maxItems);
  const totalTargetBlocks = Math.max(
    1,
    Math.ceil(totalTargetJobs / Math.max(1, SHOPIFY_IMAGE_STAGE_BLOCK_SIZE)),
  );
  let queueBlockIndex = 0;

  writeSyncLog("info", "[product-debug] image queue processing start", {
    shop: params.shop,
    maxItems,
    maxRuntimeMs,
    scopedProducts: hasScopedProducts ? scopedProductIds.length : null,
    targetJobs: totalTargetJobs,
    targetBlocks: totalTargetBlocks,
  });

  try {
    while (processedJobs < maxItems && Date.now() - startedAt < maxRuntimeMs) {
      const take = Math.min(SHOPIFY_IMAGE_STAGE_BLOCK_SIZE, maxItems - processedJobs);
      const now = new Date();
      const jobs = await delegate.findMany({
        where: {
          shop: params.shop,
          ...(hasScopedProducts ? { productId: { in: scopedProductIds } } : {}),
          status: "queued",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        orderBy: [{ nextAttemptAt: "asc" }, { updatedAt: "asc" }],
        take,
        select: {
          id: true,
          productId: true,
          imageUrl: true,
          attempts: true,
        },
      });

      if (jobs.length === 0) {
        break;
      }

      const jobIds = jobs.map((job) => job.id);
      queueBlockIndex += 1;
      await delegate.updateMany({
        where: { id: { in: jobIds } },
        data: {
          status: "processing",
          lockedAt: new Date(),
          lastError: null,
        },
      });

      let stageResult: { imagesUpdated: number; failures: Array<{ productId: string; imageUrl: string; reason: string }> };
      try {
        stageResult = await runProductImageStage({
          admin: params.admin,
          productImageUpdates: new Map(jobs.map((job) => [job.productId, job.imageUrl])),
          imageBlockDelayMsOverride: params.imageBlockDelayMsOverride,
          queueProgressContext: {
            globalBlockIndex: queueBlockIndex,
            globalTotalBlocks: totalTargetBlocks,
            globalProcessedBefore: processedJobs,
            globalTotalItems: totalTargetJobs,
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await delegate.updateMany({
          where: { id: { in: jobIds } },
          data: {
            status: "failed",
            attempts: { increment: 1 },
            lastError: `Image queue batch failed: ${message}`,
            nextAttemptAt: null,
            lockedAt: null,
          },
        });
        processedJobs += jobs.length;
        continue;
      }

      const failureByProduct = new Map(
        stageResult.failures.map((failure) => [failure.productId, failure]),
      );
      for (const job of jobs) {
        const failed = failureByProduct.get(job.productId);
        if (!failed) {
          await delegate.update({
            where: { id: job.id },
            data: {
              status: "done",
              lastError: null,
              nextAttemptAt: null,
              lockedAt: null,
            },
          });
          continue;
        }

        await delegate.update({
          where: { id: job.id },
          data: {
            status: "failed",
            attempts: (job.attempts ?? 0) + 1,
            lastError: failed.reason,
            nextAttemptAt: null,
            lockedAt: null,
          },
        });
      }

      processedJobs += jobs.length;
      imagesUpdated += stageResult.imagesUpdated;
    }

    const pendingJobs = await delegate.count({
      where: {
        shop: params.shop,
        ...(hasScopedProducts ? { productId: { in: scopedProductIds } } : {}),
        OR: [{ status: "queued" }, { status: "processing" }, { status: "failed" }],
      },
    });
    writeSyncLog("info", "[product-debug] image queue processing end", {
      shop: params.shop,
      processedJobs,
      imagesUpdated,
      pendingJobs,
      elapsedMs: Date.now() - startedAt,
    });

    return {
      processedJobs,
      imagesUpdated,
      pendingJobs,
    };
  } catch (error) {
    if (isMissingImageQueueTableError(error)) {
      writeSyncLog("warn", "[product-debug] image queue table unavailable during processing", {
        shop: params.shop,
      });
      return { processedJobs: 0, imagesUpdated: 0, pendingJobs: 0 };
    }
    throw error;
  }
}

export async function syncCatalogWithScryfall(params: {
  shop?: string;
  admin: AdminGraphqlClient;
  preferences: SyncPreferences;
  recurringPriceOnly: boolean;
  selectedProductIds?: string[];
  excludedProductIds?: string[];
  maxProducts?: number;
  scheduledCursor?: ScheduledProductCursor;
  imageBlockDelayMsOverride?: number;
  onProgress?: (progress: {
    phase?:
      | "scanning"
      | "updating_prices"
      | "updating_metadata"
      | "updating_images"
      | "finalizing"
      | "completed";
    totalVariants: number;
    processedVariants: number;
    cardsMatched: number;
    pricesUpdated?: number;
    imagesUpdated?: number;
    skippedForMissingPrice: number;
    suspiciousCount: number;
    failures: number;
  }) => Promise<void> | void;
  progressEvery?: number;
}): Promise<SyncRunResult> {
  const {
    shop,
    admin,
    preferences,
    recurringPriceOnly,
    selectedProductIds,
    excludedProductIds,
    maxProducts,
    scheduledCursor,
    imageBlockDelayMsOverride,
    onProgress,
  } = params;
  const progressEvery =
    typeof params.progressEvery === "number" && params.progressEvery > 0
      ? Math.floor(params.progressEvery)
      : 100;
  const diagnosticEnabled = process.env.PRICE_SYNC_DIAGNOSTIC === "1";
  const diagnosticErrorsOnly = process.env.PRICE_SYNC_DIAGNOSTIC_ERRORS_ONLY === "1";
  const diagnosticEvery = parseSafeDiagnosticEvery(
    process.env.PRICE_SYNC_DIAGNOSTIC_EVERY,
  );
  const syncStartedAt = new Date();
  writeSyncLog("info", "[product-sync]", {
    step: "start",
    date: syncStartedAt.toISOString(),
    shop: shop ?? null,
    searchType: preferences.useCustomScryfallIdField
      ? "custom_scryfall_id"
      : preferences.searchMode,
    syncType: recurringPriceOnly ? "recurring_price_only" : "full",
    priceSource: preferences.priceSource,
    displayCurrency: preferences.displayCurrency,
    syncImage: preferences.syncImage,
    selectedProducts: selectedProductIds?.length ?? null,
    maxProducts: maxProducts ?? null,
  });
  const loadedVariants = await loadAllVariants(admin, preferences);
  const allScannableVariants = loadedVariants.filter((variant) =>
    isScannableForSelectedSearchMethod(variant, preferences),
  );
  const excludedProductSet =
    excludedProductIds && excludedProductIds.length > 0
      ? new Set(excludedProductIds)
      : null;
  const allVariants = excludedProductSet
    ? allScannableVariants.filter((variant) => !excludedProductSet.has(variant.product.id))
    : allScannableVariants;
  writeSyncLog("info", "[product-debug] selected search method candidate filter", {
    step: "selected_search_method_candidate_filter",
    loadedVariants: loadedVariants.length,
    candidateVariants: allScannableVariants.length,
    excludedProductsAlreadyProcessed: excludedProductSet?.size ?? 0,
    candidateVariantsAfterExclusions: allVariants.length,
    skippedWithoutCandidateValue: loadedVariants.length - allScannableVariants.length,
    searchType: preferences.useCustomScryfallIdField
      ? "custom_scryfall_id"
      : preferences.searchMode,
    customScryfallField: preferences.useCustomScryfallIdField
      ? `${preferences.customScryfallIdNs}.${preferences.customScryfallIdKey}`
      : null,
    lookupMetafield: preferences.searchMode === "metafield"
      ? `${preferences.searchMetafieldNamespace}.${preferences.searchMetafieldKey}`
      : null,
    allowProductLevelFallback: preferences.allowProductLevelCustomScryfallFallback,
  });
  if (preferences.useCustomScryfallIdField) {
    writeSyncLog("info", "[product-debug] custom scryfall candidate filter", {
      step: "custom_scryfall_candidate_filter",
      loadedVariants: loadedVariants.length,
      variantsWithCustomFieldValue: allScannableVariants.length,
      variantsWithCustomFieldValueAfterExclusions: allVariants.length,
      skippedWithoutCustomFieldValue: loadedVariants.length - allScannableVariants.length,
      customScryfallField: `${preferences.customScryfallIdNs}.${preferences.customScryfallIdKey}`,
      allowProductLevelFallback: preferences.allowProductLevelCustomScryfallFallback,
    });
  }
  const explicitSelectedSet =
    selectedProductIds && selectedProductIds.length > 0
      ? new Set(selectedProductIds)
      : null;
  const effectiveMaxProducts =
    typeof maxProducts === "number" && Number.isFinite(maxProducts) && maxProducts > 0
      ? Math.floor(maxProducts)
      : null;

  let scheduledCursorApplied = false;
  let scheduledCursorWrapped = false;
  let scheduledCursorSelectedProducts = 0;
  let scheduledCursorTotalProducts = 0;
  let nextScheduledCursor: ScheduledProductCursor = {
    productId: null,
    productUpdatedAt: null,
  };

  let selectedSet: Set<string> | null = explicitSelectedSet;
  if (!selectedSet && effectiveMaxProducts !== null) {
    const cursorSelection = selectProductsByScheduledCursor({
      variants: allVariants,
      maxProducts: effectiveMaxProducts,
      scheduledCursor,
    });
    selectedSet = cursorSelection.selectedProductIds;
    scheduledCursorApplied = cursorSelection.cursorApplied;
    scheduledCursorWrapped = cursorSelection.cursorWrapped;
    scheduledCursorSelectedProducts = cursorSelection.selectedProductsCount;
    scheduledCursorTotalProducts = cursorSelection.totalProducts;
    nextScheduledCursor = cursorSelection.nextCursor;
    writeSyncLog("info", "[product-debug] scheduled cursor selection", {
      maxProducts: effectiveMaxProducts,
      cursorApplied: scheduledCursorApplied,
      cursorWrapped: scheduledCursorWrapped,
      selectedProducts: scheduledCursorSelectedProducts,
      totalProducts: scheduledCursorTotalProducts,
      startCursorProductId: scheduledCursor?.productId ?? null,
      startCursorProductUpdatedAt: scheduledCursor?.productUpdatedAt ?? null,
      nextCursorProductId: nextScheduledCursor.productId,
      nextCursorProductUpdatedAt: nextScheduledCursor.productUpdatedAt,
    });
  }

  let variants = selectedSet
    ? allVariants.filter((variant) => selectedSet.has(variant.product.id))
    : allVariants;

  const result: SyncRunResult = {
    catalogVariantsTotal: allScannableVariants.length,
    variantsScanned: variants.length,
    cardsMatched: 0,
    pricesUpdated: 0,
    suspiciousCount: 0,
    metafieldsUpdated: 0,
    imagesUpdated: 0,
    skippedForMissingPrice: 0,
    previousPricesStored: 0,
    failures: [],
    scheduledCursorApplied,
    scheduledCursorWrapped,
    scheduledCursorSelectedProducts,
    scheduledCursorTotalProducts,
    nextScheduledCursorProductId: nextScheduledCursor.productId,
    nextScheduledCursorProductUpdatedAt: nextScheduledCursor.productUpdatedAt,
    historyItems: [],
  };
  let processedVariants = 0;
  let lastProgressAt = Date.now();
  let lastProgressLogAt = Date.now();
  const failureReasons = new Map<string, number>();
  let unchangedPriceCount = 0;

  const priceUpdates: Array<{
    id: string;
    productId: string;
    variantId: string;
    currentPrice: string;
    price: string;
  }> = [];
  const variantMetafieldUpdates = new Map<
    string,
    MetafieldUpdateInput
  >();
  const productMetafieldUpdates = new Map<
    string,
    MetafieldUpdateInput
  >();
  const metafieldUpdates: MetafieldUpdateInput[] = [];
  const productImageUpdates = new Map<string, string>();
  const productScryfallIds = new Map<string, string>();
  const previousPriceByVariantId = new Map<
    string,
    MetafieldUpdateInput
  >();
  const previousPriceByProductId = new Map<
    string,
    MetafieldUpdateInput
  >();
  const variantsById = new Map(variants.map((variant) => [variant.id, variant]));
  const historyItemsByVariantId = new Map<string, SyncRunHistoryItemResult>();

  const buildHistoryItem = (
    variant: VariantNode,
    status: SyncRunHistoryItemResult["status"],
    reason: string | null = null,
    priceDetails?: { currentPrice?: string | null; newPrice?: string | null },
  ): SyncRunHistoryItemResult => ({
    productId: variant.product.id,
    productTitle: variant.product.title,
    variantId: variant.id,
    variantTitle: variant.title,
    sku: variant.sku?.trim() || null,
    metaValue: preferences.useCustomScryfallIdField
      ? resolveCustomScryfallIdentifier(variant, preferences)?.rawValue ?? null
      : preferences.searchMode === "metafield"
        ? variant.lookupField?.value?.trim() || null
        : null,
    currentPrice: priceDetails?.currentPrice ?? normalizeMoney(variant.price),
    newPrice: priceDetails?.newPrice ?? null,
    status,
    reason,
  });

  const shouldStoreMetadata = !recurringPriceOnly;
  const shouldSyncImages = preferences.syncImage;
  const usdToClpRate =
    preferences.displayCurrency === "CLP" ? await fetchUsdToClpRate() : null;

  if (diagnosticEnabled && !diagnosticErrorsOnly) {
    console.log("[product-debug-diagnostic] run start", {
      recurringPriceOnly,
      source: preferences.priceSource,
      syncImage: preferences.syncImage,
      displayCurrency: preferences.displayCurrency,
      fxRateUsed: usdToClpRate,
      priceAdjustmentMode: preferences.priceAdjustmentMode,
      priceAdjustmentPercent: preferences.priceAdjustmentPercent,
      priceAdjustmentFixed: preferences.priceAdjustmentFixed,
      minimumPrice: preferences.minimumPrice,
      variantsTotal: variants.length,
      diagnosticEvery,
    });
    writeSyncLog("info", "[product-debug-diagnostic] run start", {
      recurringPriceOnly,
      source: preferences.priceSource,
      syncImage: preferences.syncImage,
      displayCurrency: preferences.displayCurrency,
      fxRateUsed: usdToClpRate,
      priceAdjustmentMode: preferences.priceAdjustmentMode,
      priceAdjustmentPercent: preferences.priceAdjustmentPercent,
      priceAdjustmentFixed: preferences.priceAdjustmentFixed,
      minimumPrice: preferences.minimumPrice,
      variantsTotal: variants.length,
      diagnosticEvery,
    });
  }

  for (const variant of variants) {
    try {
      const match = await lookupCardForVariant(variant, preferences);
      if (!match) {
        historyItemsByVariantId.set(
          variant.id,
          buildHistoryItem(variant, "skipped", "No Scryfall match"),
        );
        if (PRICE_SYNC_LOG_PER_VARIANT) {
          const lookupSku = resolveSkuForLookup(variant);
          const lookupMetafield = variant.lookupField?.value?.trim() ?? null;
          const lookupCustomVariantId = variant.customScryfallIdField?.value?.trim() ?? null;
          const lookupCustomProductId =
            variant.product.customScryfallIdField?.value?.trim() ?? null;
          writeSyncLog("info", "[product-debug][variant]", {
            variantId: variant.id,
            action: "skipped",
            reason: "No Scryfall match",
            searchMode: preferences.searchMode,
            lookupSku,
            lookupTitle: variant.product.title,
            lookupMetafield,
            useCustomScryfallIdField: preferences.useCustomScryfallIdField,
            customScryfallVariantId: lookupCustomVariantId,
            customScryfallProductId: lookupCustomProductId,
          });
        }
        continue;
      }

      result.cardsMatched += 1;
      const foilDebug = resolveFoilMetafieldDebug(variant);

      const { price, reason } = await resolvePriceFromSource({
        source: preferences.priceSource,
        card: match.card,
        foilMode: match.foilMode,
        scryfallId: match.scryfallId,
        justTcgApiKey: preferences.justTcgApiKey,
        mtgjsonApiKey: preferences.mtgjsonApiKey,
      });

      let targetPrice: string | null = null;
      let sourcePriceUsd: number | null = null;
      let convertedPrice: number | null = null;
      if (price) {
        const parsedSourcePrice = Number(price);
        if (Number.isFinite(parsedSourcePrice)) {
          sourcePriceUsd = parsedSourcePrice;
          let priceInDisplayCurrency = parsedSourcePrice;
          if (preferences.displayCurrency === "CLP") {
            if (!usdToClpRate) {
              priceInDisplayCurrency = Number.NaN;
            } else {
              priceInDisplayCurrency = Math.round(parsedSourcePrice * usdToClpRate);
            }
          }
          convertedPrice = Number.isFinite(priceInDisplayCurrency)
            ? priceInDisplayCurrency
            : null;

          const adjustedPrice = applyConfiguredPriceAdjustments(
            priceInDisplayCurrency,
            preferences,
          );
          if (adjustedPrice !== null) {
            targetPrice = normalizeMoney(adjustedPrice);
          }
        }
      }

      const normalizedCurrentPrice = normalizeMoney(variant.price);
      if (targetPrice && normalizeMoney(targetPrice) !== normalizedCurrentPrice) {
        const suspiciousVariationRatio = getRelativePriceVariationRatio(
          normalizedCurrentPrice,
          targetPrice,
        );
        const suspiciousThresholdPercent = normalizeSuspiciousVariationThresholdPercent(
          preferences.suspiciousPriceAlertThresholdPercent,
        );
        const suspiciousThresholdRatio = suspiciousThresholdPercent / 100;
        if (
          !preferences.disableSuspiciousPriceAlert &&
          suspiciousVariationRatio !== null &&
          suspiciousVariationRatio > suspiciousThresholdRatio
        ) {
          result.suspiciousCount += 1;
          const suspiciousReason = `Suspicious price variation above ${suspiciousThresholdPercent}%`;
          historyItemsByVariantId.set(
            variant.id,
            buildHistoryItem(variant, "suspicious", suspiciousReason, {
              currentPrice: normalizedCurrentPrice,
              newPrice: normalizeMoney(targetPrice),
            }),
          );
          if (PRICE_SYNC_LOG_PER_VARIANT) {
            writeSyncLog("warn", "[product-debug][variant]", {
              variantId: variant.id,
              action: "suspicious",
              reason: suspiciousReason,
              currentPrice: normalizedCurrentPrice,
              adjustedPrice: normalizeMoney(targetPrice),
              variationPercent: Number((suspiciousVariationRatio * 100).toFixed(2)),
            });
          }
        } else {
          priceUpdates.push({
            id: variant.id,
            variantId: variant.id,
            productId: variant.product.id,
            currentPrice: normalizedCurrentPrice,
            price: normalizeMoney(targetPrice),
          });
          if (PRICE_SYNC_LOG_PER_VARIANT) {
            writeSyncLog("info", "[product-debug][variant]", {
              variantId: variant.id,
              action: "queued_for_update",
              cardkingdomFoilMode:
                preferences.priceSource === "cardkingdom"
                  ? match.foilMode === "foil"
                    ? "foil"
                    : "nonfoil"
                  : null,
              customFoilMetafieldOwner: foilDebug.owner,
              customFoilMetafieldValue: foilDebug.rawValue,
              sourcePrice: price,
              sourcePriceUsd,
              convertedPrice,
              displayCurrency: preferences.displayCurrency,
              fxRateUsed: usdToClpRate,
              adjustedPrice: targetPrice,
              currentPrice: normalizedCurrentPrice,
            });
          }
          if (variant.product.totalVariants > 1) {
            previousPriceByVariantId.set(variant.id, {
              ownerId: variant.id,
              namespace: PREVIOUS_PRICE_METAFIELD_NAMESPACE,
              key: PREVIOUS_PRICE_METAFIELD_KEY,
              type: "number_decimal",
              value: normalizeMoney(variant.price),
            });
          } else {
            previousPriceByProductId.set(variant.product.id, {
              ownerId: variant.product.id,
              namespace: PREVIOUS_PRICE_METAFIELD_NAMESPACE,
              key: PREVIOUS_PRICE_METAFIELD_KEY,
              type: "number_decimal",
              value: normalizeMoney(variant.price),
            });
          }
        }
      } else if (targetPrice && normalizeMoney(targetPrice) === normalizedCurrentPrice) {
        unchangedPriceCount += 1;
        historyItemsByVariantId.set(
          variant.id,
          buildHistoryItem(variant, "unchanged", "Price already up to date", {
            currentPrice: normalizedCurrentPrice,
            newPrice: normalizeMoney(targetPrice),
          }),
        );
        if (PRICE_SYNC_LOG_PER_VARIANT) {
          writeSyncLog("info", "[product-debug][variant]", {
            variantId: variant.id,
            action: "unchanged",
            cardkingdomFoilMode:
              preferences.priceSource === "cardkingdom"
                ? match.foilMode === "foil"
                  ? "foil"
                  : "nonfoil"
                : null,
            customFoilMetafieldOwner: foilDebug.owner,
            customFoilMetafieldValue: foilDebug.rawValue,
            sourcePrice: price,
            sourcePriceUsd,
            convertedPrice,
            displayCurrency: preferences.displayCurrency,
            fxRateUsed: usdToClpRate,
            adjustedPrice: targetPrice,
            currentPrice: normalizedCurrentPrice,
          });
        }
      } else if (!targetPrice) {
        result.skippedForMissingPrice += 1;
        if (preferences.priceSource === "cardkingdom") {
          const skipReason = "Card Kingdom has no cached price for this card; current price kept";
          historyItemsByVariantId.set(
            variant.id,
            buildHistoryItem(variant, "skipped", skipReason, {
              currentPrice: normalizedCurrentPrice,
            }),
          );
          if (PRICE_SYNC_LOG_PER_VARIANT) {
            writeSyncLog("info", "[product-debug][variant]", {
              variantId: variant.id,
              action: "skipped_missing_cardkingdom_price",
              reason: skipReason,
            });
          }
          continue;
        }
        const failureReason =
          reason ??
          "Price could not be resolved after conversion and configured adjustments";
        result.failures.push({ variantId: variant.id, reason: failureReason });
        historyItemsByVariantId.set(
          variant.id,
          buildHistoryItem(variant, "failed", failureReason, {
            currentPrice: normalizedCurrentPrice,
          }),
        );
        failureReasons.set(failureReason, (failureReasons.get(failureReason) ?? 0) + 1);
        if (PRICE_SYNC_LOG_PER_VARIANT) {
          writeSyncLog("warn", "[product-debug][variant]", {
            variantId: variant.id,
            action: "failed",
            reason: failureReason,
            cardkingdomFoilMode:
              preferences.priceSource === "cardkingdom"
                ? match.foilMode === "foil"
                  ? "foil"
                  : "nonfoil"
                : null,
            customFoilMetafieldOwner: foilDebug.owner,
            customFoilMetafieldValue: foilDebug.rawValue,
          });
        }
        if (diagnosticEnabled && diagnosticErrorsOnly && isRateLimitOrTimeoutReason(failureReason)) {
          const alertPayload = {
            variantId: variant.id,
            reason: failureReason,
            processedVariants,
            totalVariants: variants.length,
          };
          console.warn("[product-debug-diagnostic][ALERT] rate-limit/timeout detected", alertPayload);
          writeSyncLog("warn", "[product-debug-diagnostic][ALERT] rate-limit/timeout detected", alertPayload);
        }
      }

      if (shouldStoreMetadata && match.scryfallId) {
        if (variant.product.totalVariants > 1) {
          variantMetafieldUpdates.set(variant.id, {
            ownerId: variant.id,
            namespace: preferences.scryfallMetafieldNs,
            key: preferences.scryfallMetafieldKey,
            value: match.scryfallId,
          });
        } else {
          productMetafieldUpdates.set(variant.product.id, {
            ownerId: variant.product.id,
            namespace: preferences.scryfallMetafieldNs,
            key: preferences.scryfallMetafieldKey,
            value: match.scryfallId,
          });
        }
      }

      if (shouldSyncImages && !productImageUpdates.has(variant.product.id)) {
        if (!match.card) {
          continue;
        }
        const image = selectScryfallImage(match.card);
        if (image) {
          productImageUpdates.set(variant.product.id, image);
          if (match.scryfallId) {
            productScryfallIds.set(variant.product.id, match.scryfallId);
          }
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error";
      result.failures.push({ variantId: variant.id, reason: message });
      historyItemsByVariantId.set(
        variant.id,
        buildHistoryItem(variant, "failed", message, {
          currentPrice: normalizeMoney(variant.price),
        }),
      );
      failureReasons.set(message, (failureReasons.get(message) ?? 0) + 1);
      if (PRICE_SYNC_LOG_PER_VARIANT) {
        writeSyncLog("error", "[product-debug][variant]", {
          variantId: variant.id,
          action: "failed",
          reason: message,
        });
      }
      if (diagnosticEnabled && diagnosticErrorsOnly && isRateLimitOrTimeoutReason(message)) {
        const alertPayload = {
          variantId: variant.id,
          reason: message,
          processedVariants,
          totalVariants: variants.length,
        };
        console.warn("[product-debug-diagnostic][ALERT] rate-limit/timeout detected", alertPayload);
        writeSyncLog("warn", "[product-debug-diagnostic][ALERT] rate-limit/timeout detected", alertPayload);
      }
    } finally {
      processedVariants += 1;
      if (
        diagnosticEnabled &&
        !diagnosticErrorsOnly &&
        (processedVariants % diagnosticEvery === 0 || processedVariants === variants.length)
      ) {
        const chunkPayload = {
          processedVariants,
          totalVariants: variants.length,
          cardsMatched: result.cardsMatched,
          priceUpdatesQueued: priceUpdates.length,
          skippedForMissingPrice: result.skippedForMissingPrice,
          unchangedPriceCount,
          failures: result.failures.length,
          topFailureReasons: getTopFailureReasons(failureReasons, 3),
        };
        console.log("[product-debug-diagnostic] chunk", chunkPayload);
        writeSyncLog("info", "[product-debug-diagnostic] chunk", chunkPayload);
      }
      if (
        onProgress &&
        (processedVariants === variants.length ||
          processedVariants % progressEvery === 0 ||
          Date.now() - lastProgressAt >= PRICE_SYNC_PROGRESS_FLUSH_MS)
      ) {
        await onProgress({
          phase: "scanning",
          totalVariants: variants.length,
          processedVariants,
          cardsMatched: result.cardsMatched,
          pricesUpdated: result.pricesUpdated,
          imagesUpdated: result.imagesUpdated,
          skippedForMissingPrice: result.skippedForMissingPrice,
          suspiciousCount: result.suspiciousCount,
          failures: result.failures.length,
        });
        lastProgressAt = Date.now();
      }
      if (
        processedVariants === variants.length ||
        processedVariants % progressEvery === 0 ||
        Date.now() - lastProgressLogAt >= 15_000
      ) {
        writeSyncLog("info", "[product-debug] run progress", {
          step: "scan_progress",
          processedVariants,
          totalVariants: variants.length,
          cardsMatched: result.cardsMatched,
          priceUpdatesQueued: priceUpdates.length,
          skippedForMissingPrice: result.skippedForMissingPrice,
          failures: result.failures.length,
        });
        lastProgressLogAt = Date.now();
      }
    }
  }

  writeSyncLog("info", "[product-debug] price update stage start", {
    requestedUpdates: priceUpdates.length,
  });
  if (onProgress) {
    await onProgress({
      phase: "updating_prices",
      totalVariants: variants.length,
      processedVariants: variants.length,
      cardsMatched: result.cardsMatched,
      pricesUpdated: result.pricesUpdated,
      imagesUpdated: result.imagesUpdated,
      skippedForMissingPrice: result.skippedForMissingPrice,
      suspiciousCount: result.suspiciousCount,
      failures: result.failures.length,
    });
  }
  let priceSyncOutcome;
  let lastPriceProgressAt = 0;
  try {
    // Do not enforce a single stage-wide timeout for price updates.
    // Each GraphQL request already has its own timeout/retry policy and
    // updates are processed in chunks, so large runs can complete safely.
    priceSyncOutcome = await updateVariantPrices(admin, priceUpdates, async (priceProgress) => {
      if (!onProgress) {
        return;
      }
      const now = Date.now();
      const isFinalBatch = priceProgress.processedBatches >= priceProgress.totalBatches;
      if (!isFinalBatch && now - lastPriceProgressAt < 2000) {
        return;
      }
      await onProgress({
        phase: "updating_prices",
        totalVariants: variants.length,
        processedVariants: variants.length,
        cardsMatched: result.cardsMatched,
        pricesUpdated: priceProgress.updatedCount,
        imagesUpdated: result.imagesUpdated,
        skippedForMissingPrice: result.skippedForMissingPrice,
        suspiciousCount: result.suspiciousCount,
        failures: result.failures.length + priceProgress.failures,
      });
      lastPriceProgressAt = now;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeSyncLog("error", "[product-debug] price update stage failed", {
      requestedUpdates: priceUpdates.length,
      message,
    });
    throw new Error(`Price update stage failed: ${message}`);
  }
  writeSyncLog("info", "[product-debug] price update stage end", {
    requestedUpdates: priceUpdates.length,
    updatedCount: priceSyncOutcome.updatedCount,
    failedCount: priceSyncOutcome.failures.length,
  });
  result.pricesUpdated = priceSyncOutcome.updatedCount;
  result.failures.push(...priceSyncOutcome.failures);
  if (onProgress) {
    await onProgress({
      phase: "updating_metadata",
      totalVariants: variants.length,
      processedVariants: variants.length,
      cardsMatched: result.cardsMatched,
      pricesUpdated: result.pricesUpdated,
      imagesUpdated: result.imagesUpdated,
      skippedForMissingPrice: result.skippedForMissingPrice,
      suspiciousCount: result.suspiciousCount,
      failures: result.failures.length,
    });
  }
  writeSyncLog("info", "[product-debug] price update batch finished", {
    requestedUpdates: priceUpdates.length,
    updatedCount: priceSyncOutcome.updatedCount,
    failedCount: priceSyncOutcome.failures.length,
  });
  const attemptedUpdatesByVariantId = new Map(
    priceUpdates.map((item) => [item.variantId, item] as const),
  );
  for (const item of priceSyncOutcome.successfulUpdates) {
    const variant = variantsById.get(item.variantId);
    if (!variant) {
      continue;
    }
    historyItemsByVariantId.set(
      variant.id,
      buildHistoryItem(variant, "updated", null, {
        currentPrice: item.currentPrice,
        newPrice: item.price,
      }),
    );
  }
  for (const failure of priceSyncOutcome.failures) {
    const variant = variantsById.get(failure.variantId);
    if (!variant) {
      continue;
    }
    const attemptedUpdate = attemptedUpdatesByVariantId.get(failure.variantId);
    historyItemsByVariantId.set(
      variant.id,
      buildHistoryItem(variant, "failed", failure.reason, {
        currentPrice: attemptedUpdate?.currentPrice ?? normalizeMoney(variant.price),
        newPrice: attemptedUpdate?.price ?? null,
      }),
    );
  }
  if (PRICE_SYNC_LOG_PER_VARIANT) {
    for (const item of priceSyncOutcome.successfulUpdates) {
      writeSyncLog("info", "[product-debug][variant]", {
        variantId: item.variantId,
        action: "update_applied",
        appliedPrice: item.price,
      });
    }
    for (const failure of priceSyncOutcome.failures) {
      writeSyncLog("warn", "[product-debug][variant]", {
        variantId: failure.variantId,
        action: "update_failed",
        reason: failure.reason,
      });
    }
  }
  const previousPriceVariantUpdates = priceSyncOutcome.successfulUpdates
    .map((item) => previousPriceByVariantId.get(item.variantId))
    .filter(
      (
        item,
      ): item is MetafieldUpdateInput =>
        Boolean(item),
    );
  const previousPriceProductUpdates = Array.from(
    new Set(priceSyncOutcome.successfulUpdates.map((item) => item.productId)),
  )
    .map((productId) => previousPriceByProductId.get(productId))
    .filter(
      (
        item,
      ): item is MetafieldUpdateInput =>
        Boolean(item),
    );

  const previousPriceUpdates = [
    ...previousPriceProductUpdates,
    ...previousPriceVariantUpdates,
  ];

  writeSyncLog("info", "[product-debug] previous price metafield stage start", {
    requestedUpdates: previousPriceUpdates.length,
  });
  const previousPriceStageTimeoutMs = getDynamicOperationTimeoutMs(previousPriceUpdates.length);
  try {
    result.previousPricesStored = await withTimeout(
      setVariantTextMetafieldsWithRetry(admin, previousPriceUpdates),
      previousPriceStageTimeoutMs,
      "Timed out while storing previous price metafields",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeSyncLog("error", "[product-debug] previous price metafield stage failed", {
      requestedUpdates: previousPriceUpdates.length,
      message,
    });
    throw new Error(`Previous price metafield stage failed: ${message}`);
  }
  writeSyncLog("info", "[product-debug] previous price metafield stage end", {
    requestedUpdates: previousPriceUpdates.length,
    timeoutMs: previousPriceStageTimeoutMs,
    stored: result.previousPricesStored,
  });
  if (previousPriceUpdates.length > result.previousPricesStored) {
    const failureReason = `Failed to store previous price metafield for ${previousPriceUpdates.length - result.previousPricesStored} updated variants`;
    result.failures.push({
      variantId: "backup_meta",
      reason: failureReason,
    });
    failureReasons.set(failureReason, (failureReasons.get(failureReason) ?? 0) + 1);
  }

  if (shouldStoreMetadata) {
    writeSyncLog("info", "[product-debug] scryfall metadata stage start", {
      variantUpdates: variantMetafieldUpdates.size,
      productUpdates: productMetafieldUpdates.size,
    });
    metafieldUpdates.push(
      ...variantMetafieldUpdates.values(),
      ...productMetafieldUpdates.values(),
    );
    const metadataStageTimeoutMs = getDynamicOperationTimeoutMs(metafieldUpdates.length);
    try {
      result.metafieldsUpdated = await withTimeout(
        setVariantTextMetafields(admin, metafieldUpdates),
        metadataStageTimeoutMs,
        "Timed out while storing Scryfall metafields",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeSyncLog("error", "[product-debug] scryfall metadata stage failed", {
        requestedUpdates: metafieldUpdates.length,
        message,
      });
      throw new Error(`Scryfall metadata stage failed: ${message}`);
    }
    writeSyncLog("info", "[product-debug] scryfall metadata stage end", {
      requestedUpdates: metafieldUpdates.length,
      timeoutMs: metadataStageTimeoutMs,
      stored: result.metafieldsUpdated,
    });
    if (onProgress) {
      await onProgress({
        phase: "updating_images",
        totalVariants: variants.length,
        processedVariants: variants.length,
        cardsMatched: result.cardsMatched,
        pricesUpdated: result.pricesUpdated,
        imagesUpdated: result.imagesUpdated,
        skippedForMissingPrice: result.skippedForMissingPrice,
        suspiciousCount: result.suspiciousCount,
        failures: result.failures.length,
      });
    }
  }

  if (shouldSyncImages) {
    writeSyncLog("info", "[product-debug] image stage deferred until after price+metadata", {
      productsToSync: productImageUpdates.size,
      pricesUpdatedAlreadyApplied: result.pricesUpdated,
      metafieldsUpdatedAlreadyApplied: result.metafieldsUpdated,
    });
    try {
      if (shop && hasImageSyncQueueDelegate()) {
        const scopedProductIds = Array.from(productImageUpdates.keys());
        if (scopedProductIds.length === 0) {
          writeSyncLog("info", "[product-debug] image queue run skipped (no products in current run)", {
            shop,
          });
        } else {
          const enqueued = await enqueueImageSyncQueueJobs({
            shop,
            productImageUpdates,
            productScryfallIds,
          });
          writeSyncLog("info", "[product-debug] image queue enqueue summary", {
            shop,
            queued: enqueued.queued,
            skippedAlreadyDone: enqueued.skippedAlreadyDone,
            scopedProducts: scopedProductIds.length,
          });
          const queueRun = await processImageSyncQueueForShop({
            shop,
            admin,
            imageBlockDelayMsOverride,
            maxItems: scopedProductIds.length,
            maxRuntimeMs: Math.max(
              SHOPIFY_IMAGE_QUEUE_MAX_RUNTIME_MS,
              Math.min(
                SHOPIFY_IMAGE_QUEUE_RUNTIME_HARD_CAP_MS,
                Math.ceil(
                  (scopedProductIds.length / Math.max(1, SHOPIFY_IMAGE_STAGE_CONCURRENCY)) *
                    6_000 +
                    2 * 60 * 1000,
                ),
              ),
            ),
            productIds: scopedProductIds,
          });
          if (queueRun.imagesUpdated > scopedProductIds.length) {
            writeSyncLog("warn", "[product-debug] image queue updated count exceeded scoped products", {
              shop,
              imagesUpdated: queueRun.imagesUpdated,
              scopedProducts: scopedProductIds.length,
            });
          }
          result.imagesUpdated = Math.min(queueRun.imagesUpdated, scopedProductIds.length);
          writeSyncLog("info", "[product-debug] image queue run summary", {
            shop,
            processedJobs: queueRun.processedJobs,
            imagesUpdated: result.imagesUpdated,
            pendingJobs: queueRun.pendingJobs,
            scopedProducts: scopedProductIds.length,
          });
        }
      } else {
        const stageResult = await runProductImageStage({
          admin,
          productImageUpdates,
          imageBlockDelayMsOverride,
        });
        result.imagesUpdated = stageResult.imagesUpdated;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureReason = `Image stage failed after price+metadata: ${message}`;
      writeSyncLog("error", "[product-debug] image stage failed (non-blocking)", {
        message,
        productsToSync: productImageUpdates.size,
      });
      result.failures.push({
        variantId: "image_stage",
        reason: failureReason,
      });
      failureReasons.set(failureReason, (failureReasons.get(failureReason) ?? 0) + 1);
    }
  }
  if (onProgress) {
    await onProgress({
      phase: "finalizing",
      totalVariants: variants.length,
      processedVariants: variants.length,
      cardsMatched: result.cardsMatched,
      pricesUpdated: result.pricesUpdated,
      imagesUpdated: result.imagesUpdated,
      skippedForMissingPrice: result.skippedForMissingPrice,
      suspiciousCount: result.suspiciousCount,
      failures: result.failures.length,
    });
  }

  if (diagnosticEnabled && !diagnosticErrorsOnly) {
    const endPayload = {
      variantsScanned: result.variantsScanned,
      cardsMatched: result.cardsMatched,
      pricesUpdated: result.pricesUpdated,
      skippedForMissingPrice: result.skippedForMissingPrice,
      unchangedPriceCount,
      failures: result.failures.length,
      topFailureReasons: getTopFailureReasons(failureReasons, 5),
    };
    console.log("[product-debug-diagnostic] run end", endPayload);
    writeSyncLog("info", "[product-debug-diagnostic] run end", endPayload);
  }
  if (diagnosticEnabled && diagnosticErrorsOnly && result.failures.length > 0) {
    const summaryPayload = {
      variantsScanned: result.variantsScanned,
      cardsMatched: result.cardsMatched,
      pricesUpdated: result.pricesUpdated,
      unchangedPriceCount,
      failures: result.failures.length,
      topFailureReasons: getTopFailureReasons(failureReasons, 5),
    };
    console.warn("[product-debug-diagnostic][SUMMARY]", summaryPayload);
    writeSyncLog("warn", "[product-debug-diagnostic][SUMMARY]", summaryPayload);
  }

  writeSyncLog("info", "[product-sync]", {
    step: "end",
    date: new Date().toISOString(),
    shop: shop ?? null,
    durationMs: Date.now() - syncStartedAt.getTime(),
    status: result.failures.length > 0 ? "completed_with_failures" : "success",
    searchType: preferences.useCustomScryfallIdField
      ? "custom_scryfall_id"
      : preferences.searchMode,
    syncType: recurringPriceOnly ? "recurring_price_only" : "full",
    priceSource: preferences.priceSource,
    variantsScanned: result.variantsScanned,
    cardsMatched: result.cardsMatched,
    priceUpdatesQueued: priceUpdates.length,
    pricesUpdated: result.pricesUpdated,
    metafieldsUpdated: result.metafieldsUpdated,
    imagesUpdated: result.imagesUpdated,
    skippedForMissingPrice: result.skippedForMissingPrice,
    previousPricesStored: result.previousPricesStored,
    failures: result.failures.length,
    scheduledCursorApplied: result.scheduledCursorApplied,
    scheduledCursorWrapped: result.scheduledCursorWrapped,
    scheduledCursorSelectedProducts: result.scheduledCursorSelectedProducts,
    scheduledCursorTotalProducts: result.scheduledCursorTotalProducts,
    hasMoreScheduledChunks: Boolean(result.nextScheduledCursorProductId),
    nextScheduledCursorProductId: result.nextScheduledCursorProductId,
    nextScheduledCursorProductUpdatedAt: result.nextScheduledCursorProductUpdatedAt,
  });

  result.historyItems = variants
    .map((variant) => historyItemsByVariantId.get(variant.id) ?? null)
    .filter((item): item is SyncRunHistoryItemResult => Boolean(item));

  return result;
}

export async function validateCustomScryfallIds(params: {
  admin: AdminGraphqlClient;
  preferences: SyncPreferences;
}): Promise<CustomScryfallIdCheckResult> {
  const { admin, preferences } = params;
  const startedAtMs = Date.now();
  const variants = await loadVariantsForCustomScryfallValidation(admin, preferences);

  const productsWithCustomId = new Set<string>();
  const productsFoundInScryfall = new Set<string>();
  const idToVariantCount = new Map<string, number>();
  const idToProductIds = new Map<string, Set<string>>();
  const idToRawValue = new Map<string, string>();

  const result: CustomScryfallIdCheckResult = {
    variantsScanned: variants.length,
    variantsWithCustomId: 0,
    variantsFoundInScryfall: 0,
    productsWithCustomId: 0,
    productsFoundInScryfall: 0,
    notFoundInScryfall: 0,
  };

  for (const variant of variants) {
    const customIdentifier = resolveCustomScryfallIdentifier(variant, preferences);
    if (!customIdentifier) {
      continue;
    }

    result.variantsWithCustomId += 1;
    productsWithCustomId.add(variant.product.id);
    const customId = customIdentifier.id;
    idToVariantCount.set(customId, (idToVariantCount.get(customId) ?? 0) + 1);
    idToRawValue.set(customId, customIdentifier.rawValue);
    const products = idToProductIds.get(customId) ?? new Set<string>();
    products.add(variant.product.id);
    idToProductIds.set(customId, products);
  }

  const uniqueIds = Array.from(idToVariantCount.keys());
  const chunkSize = 25;
  for (let index = 0; index < uniqueIds.length; index += chunkSize) {
    const chunk = uniqueIds.slice(index, index + chunkSize);
    const chunkResults = await Promise.all(
      chunk.map(async (id) => ({
        id,
        exists: await doesScryfallIdExistForValidation(idToRawValue.get(id) ?? id),
      })),
    );
    for (const item of chunkResults) {
      const variantCount = idToVariantCount.get(item.id) ?? 0;
      if (item.exists) {
        result.variantsFoundInScryfall += variantCount;
        for (const productId of idToProductIds.get(item.id) ?? []) {
          productsFoundInScryfall.add(productId);
        }
      } else {
        result.notFoundInScryfall += variantCount;
      }
    }
  }

  result.productsWithCustomId = productsWithCustomId.size;
  result.productsFoundInScryfall = productsFoundInScryfall.size;
  writeSyncLog("info", "[product-debug] custom scryfall validation finished", {
    variantsScanned: result.variantsScanned,
    variantsWithCustomId: result.variantsWithCustomId,
    uniqueIds: uniqueIds.length,
    notFoundInScryfall: result.notFoundInScryfall,
    durationMs: Date.now() - startedAtMs,
  });

  return result;
}
