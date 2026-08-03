import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import {
  Form,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useSubmit,
} from "@remix-run/react";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import {
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  FormLayout,
  InlineGrid,
  Layout,
  List,
  Modal,
  Page,
  Select,
  Text,
  TextField,
  Tooltip,
} from "@shopify/polaris";
import { useEffect, useRef, useState } from "react";
import db from "../db.server";
import {
  computeNextRunAt,
  getOrCreateSyncConfiguration,
  toSyncPreferences,
} from "../services/sync-config.server";
import { writeSyncLog } from "../services/sync-log.server";
import {
  enqueueScryfallCheckForShop,
  getScryfallCheckStatusForShop,
} from "../services/scryfall-check-queue.server";
import {
  clearInMemorySyncStatusForShop,
  enqueueManualSyncForShop,
  getManualSyncStatusForShop,
  recoverStaleRunningStateForShop,
  getTestSyncStatusForShop,
  triggerSchedulerTickInBackground,
} from "../services/sync-scheduler.server";
import {
  clearSyncRunHistoryForShop,
  listRecentSyncRunsForShop,
} from "../services/sync-run-history.server";
import { authenticate } from "../shopify.server";
import { detectLanguage, i18n } from "../utils/i18n";

type ActionData =
  | { ok: true; type: "save"; message: string }
  | { ok: true; type: "clearHistory"; message: string }
  | {
      ok: true;
      type: "run";
      message: string;
      result: {
        variantsScanned: number;
        cardsMatched: number;
        pricesUpdated: number;
        metafieldsUpdated: number;
        imagesUpdated: number;
        skippedForMissingPrice: number;
        previousPricesStored: number;
        failures: Array<{ variantId: string; reason: string }>;
      };
    }
  | { ok: true; type: "runQueued"; message: string }
  | {
      ok: true;
      type: "runTestQueued";
      message: string;
      details: {
        selectedCount: number;
        maxProducts: number | null;
        selectedProductIds: string[];
      };
    }
  | {
      ok: true;
      type: "checkCustomScryfallQueued";
      queued: boolean;
      message: string;
    }
  | {
      ok: true;
      type: "searchProducts";
      results: ProductOption[];
    }
  | { ok: false; message: string };

type ProductOption = {
  id: string;
  title: string;
};

type SyncHistoryTableRow = {
  id: string;
  status: string;
  message: string | null;
  startedAt: Date;
  variantsScanned: number | null;
  cardsMatched: number | null;
  pricesUpdated: number | null;
  failuresCount: number | null;
  suspiciousCount: number | null;
  isLive: boolean;
  downloadRunId: string | null;
};

type PriceSyncLoaderData = {
  config: Awaited<ReturnType<typeof getOrCreateSyncConfiguration>>;
  hasCardKingdomData: boolean;
  lang: "es" | "en";
  nextRunAtDisplay: Date | null;
  manualStatus: ReturnType<typeof getManualSyncStatusForShop>;
  testStatus: ReturnType<typeof getTestSyncStatusForShop>;
  scryfallCheckStatus: ReturnType<typeof getScryfallCheckStatusForShop>;
  recentSyncRuns: Awaited<ReturnType<typeof listRecentSyncRunsForShop>>;
};

type ScryfallCheckStatusForUi = NonNullable<PriceSyncLoaderData["scryfallCheckStatus"]>;

const OPTIMISTIC_STATUS_UPDATED_AT = "1970-01-01T00:00:00.000Z";

async function hasCardKingdomDataInDb(): Promise<boolean> {
  const delegate = (
    db as unknown as {
      cardKingdomPriceCache?: { count: (args?: Record<string, unknown>) => Promise<number> };
    }
  ).cardKingdomPriceCache;
  if (!delegate) {
    return false;
  }
  try {
    const count = await delegate.count();
    return count > 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/CardKingdomPriceCache|card_kingdom_price_cache|no such table/i.test(message)) {
      return false;
    }
    writeSyncLog("warn", "[product-debug-route] cardkingdom cache availability check failed", {
      message,
    });
    return false;
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const lang = detectLanguage(request);
  await recoverStaleRunningStateForShop(session.shop);
  const config = await getOrCreateSyncConfiguration(session.shop);
  const hasCardKingdomData = await hasCardKingdomDataInDb();
  const manualStatus = getManualSyncStatusForShop(session.shop);
  const testStatus = getTestSyncStatusForShop(session.shop);
  const scryfallCheckStatus = getScryfallCheckStatusForShop(session.shop);
  const recentSyncRuns = await listRecentSyncRunsForShop(session.shop, 5);
  const now = new Date();
  const nextRunAtDisplay =
    config.enabled && (!config.nextRunAt || config.nextRunAt <= now)
      ? computeNextRunAt(config.dailyTime, config.timezone, now)
      : config.nextRunAt;
  return {
    config,
    hasCardKingdomData,
    lang,
    nextRunAtDisplay,
    manualStatus,
    testStatus,
    scryfallCheckStatus,
    recentSyncRuns,
  } satisfies PriceSyncLoaderData;
};

function isValidSearchMode(value: string): value is "sku" | "title" | "metafield" {
  return value === "sku" || value === "title" || value === "metafield";
}

function isValidPriceSource(
  value: string,
): value is "scryfall" | "justtcg" | "mtgjson" | "cardkingdom" {
  return (
    value === "scryfall" ||
    value === "justtcg" ||
    value === "mtgjson" ||
    value === "cardkingdom"
  );
}

function isValidDisplayCurrency(value: string): value is "USD" | "CLP" {
  return value === "USD" || value === "CLP";
}

function isValidPriceAdjustmentMode(value: string): value is "percent" | "fixed" {
  return value === "percent" || value === "fixed";
}

const METAFIELD_TOKEN_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
const DAILY_TIME_REGEX = /^([01]\d|2[0-3]):([0-5]\d)$/;
const HOURLY_FREQUENCY_TOKEN_REGEX = /^every_(1[0-2]|[1-9])h$/;
const THIRTY_MINUTES_FREQUENCY_TOKEN = "every_30m";
const LEGACY_TEN_MINUTES_FREQUENCY_TOKEN = "every_10m";
const LEGACY_FIVE_MINUTES_FREQUENCY_TOKEN = "every_5m";
const PRICE_ADJUSTMENT_PERCENT_MIN = -99;
const PRICE_ADJUSTMENT_PERCENT_MAX = 1000;
const PRICE_ADJUSTMENT_FIXED_ABS_MAX = 1_000_000_000;
const MINIMUM_PRICE_MAX = 1_000_000_000;
const SUSPICIOUS_ALERT_THRESHOLD_PERCENT_MIN = 0.1;
const SUSPICIOUS_ALERT_THRESHOLD_PERCENT_MAX = 1000;

function isHourlyFrequencyToken(value: string): boolean {
  return HOURLY_FREQUENCY_TOKEN_REGEX.test(value.trim());
}

function isThirtyMinutesFrequencyToken(value: string): boolean {
  return value.trim() === THIRTY_MINUTES_FREQUENCY_TOKEN;
}

function isLegacyTenMinutesFrequencyToken(value: string): boolean {
  return value.trim() === LEGACY_TEN_MINUTES_FREQUENCY_TOKEN;
}

function isLegacyFiveMinutesFrequencyToken(value: string): boolean {
  return value.trim() === LEGACY_FIVE_MINUTES_FREQUENCY_TOKEN;
}

function sanitizeMetafieldToken(value: string, fallback: string): string {
  const normalized = value.trim();
  return METAFIELD_TOKEN_REGEX.test(normalized) ? normalized : fallback;
}

function sanitizeMetafieldPath(params: {
  namespace: string;
  key: string;
  fallbackNamespace: string;
  fallbackKey: string;
}): { namespace: string; key: string } {
  const rawNamespace = params.namespace.trim();
  const rawKey = params.key.trim();
  const combined = rawNamespace.includes(".")
    ? rawNamespace
    : rawKey.includes(".") && !rawNamespace
      ? rawKey
      : "";
  if (combined) {
    const [namespace, ...keyParts] = combined.split(".");
    const key = keyParts.join(".");
    return {
      namespace: sanitizeMetafieldToken(namespace, params.fallbackNamespace),
      key: sanitizeMetafieldToken(key, params.fallbackKey),
    };
  }
  return {
    namespace: sanitizeMetafieldToken(rawNamespace, params.fallbackNamespace),
    key: sanitizeMetafieldToken(rawKey, params.fallbackKey),
  };
}

function sanitizeDailyTime(value: string, fallback = "03:00"): string {
  const normalized = value.trim();
  if (
    DAILY_TIME_REGEX.test(normalized) ||
    HOURLY_FREQUENCY_TOKEN_REGEX.test(normalized) ||
    isThirtyMinutesFrequencyToken(normalized) ||
    isLegacyTenMinutesFrequencyToken(normalized) ||
    isLegacyFiveMinutesFrequencyToken(normalized)
  ) {
    return normalized;
  }
  return fallback;
}

function sanitizeApiKey(value: FormDataEntryValue | null, fallback = ""): string {
  if (value === null) {
    return fallback;
  }
  return String(value).trim().slice(0, 512);
}

function sanitizeNumericInput(
  value: FormDataEntryValue | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (value === null) {
    return fallback;
  }

  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function parseHourlyToken(value: string): number | null {
  const match = /^every_(1[0-2]|[1-9])h$/.exec(value.trim());
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function formatDuration(seconds: number, lang: "es" | "en"): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(safeSeconds / 60);
  const remainingSeconds = safeSeconds % 60;
  if (lang === "es") {
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${minutes}m ${remainingSeconds}s`;
}

function formatUtcDateTime(date: Date, lang: "es" | "en"): string {
  return new Intl.DateTimeFormat(lang === "es" ? "es-CL" : "en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
}

function formatSchedulePreview(
  lang: "es" | "en",
  scheduleMode: "daily_once" | "custom_hourly",
  scheduleFrequencyValue: string,
  dailyTime: string,
): { cron: string; nextRunUtc: string } {
  const now = new Date();
  if (scheduleMode === "custom_hourly" && scheduleFrequencyValue === THIRTY_MINUTES_FREQUENCY_TOKEN) {
    const nextRun = new Date(now);
    const nextMinuteSlot = Math.ceil((nextRun.getUTCMinutes() + 1) / 30) * 30;
    nextRun.setUTCSeconds(0, 0);
    if (nextMinuteSlot >= 60) {
      nextRun.setUTCHours(nextRun.getUTCHours() + 1, 0, 0, 0);
    } else {
      nextRun.setUTCMinutes(nextMinuteSlot, 0, 0);
    }
    return {
      cron: "*/30 * * * *",
      nextRunUtc: formatUtcDateTime(nextRun, lang),
    };
  }
  const hourly = scheduleMode === "custom_hourly" ? parseHourlyToken(scheduleFrequencyValue) : null;

  if (hourly) {
    const nextRun = new Date(now);
    nextRun.setUTCMinutes(0, 0, 0);
    const currentHour = now.getUTCHours();
    const alignedHour = Math.floor(currentHour / hourly) * hourly;
    nextRun.setUTCHours(alignedHour, 0, 0, 0);
    if (nextRun <= now) {
      nextRun.setUTCHours(nextRun.getUTCHours() + hourly, 0, 0, 0);
    }
    return {
      cron: `0 */${hourly} * * *`,
      nextRunUtc: formatUtcDateTime(nextRun, lang),
    };
  }

  const [hourRaw, minuteRaw] = dailyTime.split(":");
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const nextRun = new Date(now);
  nextRun.setUTCSeconds(0, 0);
  if (Number.isFinite(hour) && Number.isFinite(minute)) {
    nextRun.setUTCHours(hour, minute, 0, 0);
  } else {
    nextRun.setUTCHours(3, 0, 0, 0);
  }
  if (nextRun <= now) {
    nextRun.setUTCDate(nextRun.getUTCDate() + 1);
  }

  const cronHour = Number.isFinite(hour) ? hour : 3;
  const cronMinute = Number.isFinite(minute) ? minute : 0;
  return {
    cron: `${cronMinute} ${cronHour} * * *`,
    nextRunUtc: formatUtcDateTime(nextRun, lang),
  };
}

function toSafeUiError(error: unknown): string {
  if (error instanceof Response) {
    return "Request failed";
  }
  if (error instanceof Error) {
    if (error.name === "AbortError") {
      return "Request timeout";
    }
  }
  return "Unexpected sync error";
}

function isValidIanaTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

async function resolveShopTimezone(params: {
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };
  fallback: string;
}): Promise<string> {
  const safeFallback = isValidIanaTimeZone(params.fallback) ? params.fallback : "UTC";
  try {
    const response = await params.admin.graphql(
      `#graphql
        query ShopIanaTimezone {
          shop {
            ianaTimezone
          }
        }
      `,
    );
    const json = (await response.json()) as {
      data?: { shop?: { ianaTimezone?: string | null } };
    };
    const timezone = json.data?.shop?.ianaTimezone?.trim() ?? "";
    if (timezone && isValidIanaTimeZone(timezone)) {
      return timezone;
    }
    return safeFallback;
  } catch (error) {
    console.warn("Could not resolve shop timezone, using fallback", {
      message: error instanceof Error ? error.message : String(error),
    });
    return safeFallback;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const rawIntent = String(formData.get("intent") ?? "").trim();
  const looksLikeSettingsSubmit =
    formData.has("enabled") ||
    formData.has("scheduleFrequency") ||
    formData.has("dailyTime") ||
    formData.has("priceSource") ||
    formData.has("displayCurrency");
  const intent = rawIntent || (looksLikeSettingsSubmit ? "save" : "");
  const shop = session.shop;
  const lang = detectLanguage(request);
  const t = i18n[lang];

  try {
    if (intent === "searchProducts") {
      const queryRaw = String(formData.get("query") ?? "").trim();
      if (queryRaw.length < 2) {
        return { ok: true, type: "searchProducts", results: [] } satisfies ActionData;
      }
      const safeQuery = queryRaw.replace(/"/g, "");

      const response = await admin.graphql(
        `#graphql
          query SearchScopeProducts($query: String!) {
            products(first: 10, sortKey: UPDATED_AT, reverse: true, query: $query) {
              edges {
                node {
                  id
                  title
                }
              }
            }
          }
        `,
        {
          variables: {
            query: `title:*${safeQuery}* OR sku:${safeQuery}`,
          },
        },
      );
      const json = (await response.json()) as {
        data?: { products?: { edges: Array<{ node: ProductOption }> } };
      };
      const results = (json.data?.products?.edges ?? []).map((edge) => edge.node);
      return { ok: true, type: "searchProducts", results } satisfies ActionData;
    }

    if (intent === "save") {
      const currentConfig = await getOrCreateSyncConfiguration(shop);
      const enabled = formData.get("enabled") === "on";
      const scheduleFrequencyRaw = String(formData.get("scheduleFrequency") ?? "daily_once");
      const scheduleFrequency = (() => {
        if (
          isLegacyFiveMinutesFrequencyToken(scheduleFrequencyRaw) ||
          isLegacyTenMinutesFrequencyToken(scheduleFrequencyRaw)
        ) {
          return THIRTY_MINUTES_FREQUENCY_TOKEN;
        }
        if (
          scheduleFrequencyRaw === "daily_once" ||
          isHourlyFrequencyToken(scheduleFrequencyRaw) ||
          isThirtyMinutesFrequencyToken(scheduleFrequencyRaw)
        ) {
          return scheduleFrequencyRaw;
        }
        return "daily_once";
      })();
      const dailyTimeInput = sanitizeDailyTime(String(formData.get("dailyTime") ?? "03:00"));
      const dailyTime =
        scheduleFrequency !== "daily_once"
          ? scheduleFrequency
          : sanitizeDailyTime(dailyTimeInput, "03:00");
      const syncImage = formData.get("syncImage") === "on";
      const disableSuspiciousPriceAlert =
        formData.get("disableSuspiciousPriceAlert") === "on";
      const searchModeValue = String(formData.get("searchMode") ?? "sku");
      const priceSourceValue = String(formData.get("priceSource") ?? "scryfall");
      const useCustomScryfallIdField = formData.get("useCustomScryfallIdField") === "on";
      const allowProductLevelCustomScryfallFallback =
        formData.get("allowProductLevelCustomScryfallFallback") === "on";
      const justTcgApiKey = sanitizeApiKey(
        formData.get("justTcgApiKey"),
        currentConfig.justTcgApiKey,
      );
      const mtgjsonApiKey = sanitizeApiKey(
        formData.get("mtgjsonApiKey"),
        currentConfig.mtgjsonApiKey,
      );
      const displayCurrencyValue = String(
        formData.get("displayCurrency") ?? currentConfig.displayCurrency,
      );
      const priceAdjustmentPercent = sanitizeNumericInput(
        formData.get("priceAdjustmentPercent"),
        currentConfig.priceAdjustmentPercent,
        PRICE_ADJUSTMENT_PERCENT_MIN,
        PRICE_ADJUSTMENT_PERCENT_MAX,
      );
      const priceAdjustmentFixed = sanitizeNumericInput(
        formData.get("priceAdjustmentFixed"),
        currentConfig.priceAdjustmentFixed,
        -PRICE_ADJUSTMENT_FIXED_ABS_MAX,
        PRICE_ADJUSTMENT_FIXED_ABS_MAX,
      );
      const minimumPrice = sanitizeNumericInput(
        formData.get("minimumPrice"),
        currentConfig.minimumPrice,
        0,
        MINIMUM_PRICE_MAX,
      );
      const suspiciousPriceAlertThresholdPercent = sanitizeNumericInput(
        formData.get("suspiciousPriceAlertThresholdPercent"),
        currentConfig.suspiciousPriceAlertThresholdPercent ?? 50,
        SUSPICIOUS_ALERT_THRESHOLD_PERCENT_MIN,
        SUSPICIOUS_ALERT_THRESHOLD_PERCENT_MAX,
      );
      const priceAdjustmentModeValue = String(
        formData.get("priceAdjustmentMode") ?? currentConfig.priceAdjustmentMode ?? "percent",
      );

      if (!isValidSearchMode(searchModeValue)) {
        return { ok: false, message: "Invalid search mode" } satisfies ActionData;
      }
      if (!isValidPriceSource(priceSourceValue)) {
        return { ok: false, message: "Invalid price source" } satisfies ActionData;
      }
      if (!isValidDisplayCurrency(displayCurrencyValue)) {
        return { ok: false, message: "Invalid display currency" } satisfies ActionData;
      }
      if (!isValidPriceAdjustmentMode(priceAdjustmentModeValue)) {
        return { ok: false, message: "Invalid price adjustment mode" } satisfies ActionData;
      }

      const resolvedPriceAdjustmentPercent =
        priceAdjustmentModeValue === "percent" ? priceAdjustmentPercent : 0;
      const resolvedPriceAdjustmentFixed =
        priceAdjustmentModeValue === "fixed" ? priceAdjustmentFixed : 0;

      const searchMetafieldNamespace =
        sanitizeMetafieldToken(
          String(
            formData.get("searchMetafieldNamespace") ??
              currentConfig.searchMetafieldNamespace,
          ),
          "custom",
        ) || "custom";
      const searchMetafieldKey =
        sanitizeMetafieldToken(
          String(formData.get("searchMetafieldKey") ?? currentConfig.searchMetafieldKey),
          "card_lookup",
        ) || "card_lookup";
      const customScryfallPath = sanitizeMetafieldPath({
        namespace: String(formData.get("customScryfallIdNs") ?? currentConfig.customScryfallIdNs),
        key: String(formData.get("customScryfallIdKey") ?? currentConfig.customScryfallIdKey),
        fallbackNamespace: "custom",
        fallbackKey: "scryfall_id",
      });
      const customScryfallIdNs = customScryfallPath.namespace || "custom";
      const customScryfallIdKey = customScryfallPath.key || "scryfall_id";
      const scryfallMetafieldNs = "custom";
      const scryfallMetafieldKey = "scryfall_meta";
      const timezone = await resolveShopTimezone({
        admin,
        fallback: currentConfig.timezone,
      });
      const scheduleChanged =
        currentConfig.dailyTime !== dailyTime || currentConfig.timezone !== timezone;
      const hasValidHalfHourAlignment = (date: Date | null): boolean => {
        if (!date) {
          return false;
        }
        const minutes = date.getUTCMinutes();
        return (minutes === 0 || minutes === 30) && date.getUTCSeconds() === 0;
      };
      const requiresHalfHourRealignment =
        dailyTime === THIRTY_MINUTES_FREQUENCY_TOKEN &&
        !hasValidHalfHourAlignment(currentConfig.nextRunAt);
      const nextRunAtForSave = (() => {
        if (!enabled) {
          return null;
        }
        if (!currentConfig.enabled) {
          return computeNextRunAt(dailyTime, timezone);
        }
        if (scheduleChanged) {
          return computeNextRunAt(dailyTime, timezone);
        }
        if (requiresHalfHourRealignment) {
          return computeNextRunAt(dailyTime, timezone);
        }
        return currentConfig.nextRunAt ?? computeNextRunAt(dailyTime, timezone);
      })();

      await db.syncConfiguration.upsert({
        where: { shop },
        create: {
          shop,
          enabled,
          dailyTime,
          timezone,
          syncImage,
          searchMode: searchModeValue,
          searchMetafieldNamespace,
          searchMetafieldKey,
          useCustomScryfallIdField,
          allowProductLevelCustomScryfallFallback,
          customScryfallIdNs,
          customScryfallIdKey,
          priceSource: priceSourceValue,
          justTcgApiKey,
          mtgjsonApiKey,
          displayCurrency: displayCurrencyValue,
          priceAdjustmentMode: priceAdjustmentModeValue,
          priceAdjustmentPercent: resolvedPriceAdjustmentPercent,
          priceAdjustmentFixed: resolvedPriceAdjustmentFixed,
          minimumPrice,
          disableSuspiciousPriceAlert,
          suspiciousPriceAlertThresholdPercent,
          scryfallMetafieldNs,
          scryfallMetafieldKey,
          nextRunAt: nextRunAtForSave,
        },
        update: {
          enabled,
          dailyTime,
          timezone,
          syncImage,
          searchMode: searchModeValue,
          searchMetafieldNamespace,
          searchMetafieldKey,
          useCustomScryfallIdField,
          allowProductLevelCustomScryfallFallback,
          customScryfallIdNs,
          customScryfallIdKey,
          priceSource: priceSourceValue,
          justTcgApiKey,
          mtgjsonApiKey,
          displayCurrency: displayCurrencyValue,
          priceAdjustmentMode: priceAdjustmentModeValue,
          priceAdjustmentPercent: resolvedPriceAdjustmentPercent,
          priceAdjustmentFixed: resolvedPriceAdjustmentFixed,
          minimumPrice,
          disableSuspiciousPriceAlert,
          suspiciousPriceAlertThresholdPercent,
          scryfallMetafieldNs,
          scryfallMetafieldKey,
          nextRunAt: nextRunAtForSave,
        },
      });

      if (priceSourceValue === "cardkingdom") {
        triggerSchedulerTickInBackground({ trigger: "manual" });
      }

      return {
        ok: true,
        type: "save",
        message: t.syncSettingsUpdated,
      } satisfies ActionData;
    }

    if (intent === "run") {
      await getOrCreateSyncConfiguration(shop);
      const manualLimitMode = String(formData.get("manualLimitMode") ?? "all");
      const parsedManualMaxProducts = Number(formData.get("manualMaxProducts") ?? "");
      const manualMaxProducts =
        manualLimitMode === "latest" &&
        Number.isFinite(parsedManualMaxProducts) &&
        parsedManualMaxProducts > 0
          ? Math.min(1000, Math.floor(parsedManualMaxProducts))
          : undefined;
      const enqueueResult = await enqueueManualSyncForShop(shop, {
        selectedProductIds: undefined,
        maxProducts: manualMaxProducts,
        kind: "manual",
      });
      if (!enqueueResult.queued) {
        return { ok: false, message: t.syncAlreadyRunning } satisfies ActionData;
      }

      return {
        ok: true,
        type: "runQueued",
        message: t.manualSyncQueued,
      } satisfies ActionData;
    }

    if (intent === "runTest") {
      await getOrCreateSyncConfiguration(shop);
      const selectedProductIds = String(formData.get("selectedProductIds") ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (selectedProductIds.length === 0) {
        return { ok: false, message: t.runScopeSelectionRequired } satisfies ActionData;
      }
      const rawMaxProducts = Number(formData.get("maxProducts") ?? "");
      const maxProducts =
        Number.isFinite(rawMaxProducts) && rawMaxProducts > 0
          ? Math.min(250, Math.floor(rawMaxProducts))
          : undefined;
      const enqueueResult = await enqueueManualSyncForShop(shop, {
        selectedProductIds,
        maxProducts,
        kind: "test",
      });
      if (!enqueueResult.queued) {
        return { ok: false, message: t.syncAlreadyRunning } satisfies ActionData;
      }

      return {
        ok: true,
        type: "runTestQueued",
        message: t.testSyncQueued,
        details: {
          selectedCount: selectedProductIds.length,
          maxProducts: maxProducts ?? null,
          selectedProductIds,
        },
      } satisfies ActionData;
    }

    if (intent === "checkCustomScryfall") {
      const config = await getOrCreateSyncConfiguration(shop);
      const customScryfallPath = sanitizeMetafieldPath({
        namespace: String(formData.get("customScryfallIdNs") ?? config.customScryfallIdNs),
        key: String(formData.get("customScryfallIdKey") ?? config.customScryfallIdKey),
        fallbackNamespace: "custom",
        fallbackKey: "scryfall_id",
      });
      const customScryfallIdNs = customScryfallPath.namespace || "custom";
      const customScryfallIdKey = customScryfallPath.key || "scryfall_id";
      const preferences = toSyncPreferences(config);
      writeSyncLog("info", "[product-debug-route] checkCustomScryfall requested", {
        shop,
        customScryfallIdNs,
        customScryfallIdKey,
      });
      const enqueueResult = enqueueScryfallCheckForShop({
        shop,
        admin,
        preferences: {
          ...preferences,
          customScryfallIdNs,
          customScryfallIdKey,
          useCustomScryfallIdField: true,
          allowProductLevelCustomScryfallFallback:
            formData.get("allowProductLevelCustomScryfallFallback") === "on",
        },
      });
      writeSyncLog("info", "[product-debug-route] checkCustomScryfall enqueue result", {
        shop,
        queued: enqueueResult.queued,
      });

      return {
        ok: true,
        type: "checkCustomScryfallQueued",
        queued: enqueueResult.queued,
        message: enqueueResult.queued
          ? t.scryfallCheckQueued
          : t.scryfallCheckAlreadyRunning,
      } satisfies ActionData;
    }

    if (intent === "clearHistory") {
      await clearSyncRunHistoryForShop(shop);
      clearInMemorySyncStatusForShop(shop);
      await db.syncConfiguration.update({
        where: { shop },
        data: {
          currentScheduledStatus: null,
          currentScheduledStartedAt: null,
          currentScheduledUpdatedAt: null,
          currentScheduledTotalVariants: null,
          currentScheduledProcessedVariants: null,
          currentScheduledCardsMatched: null,
          currentScheduledPricesUpdated: null,
          currentScheduledSkippedForMissingPrice: null,
          currentScheduledFailures: null,
          currentScheduledSuspiciousCount: null,
          currentScheduledTotalBlocks: null,
          currentScheduledProcessedBlocks: null,
          currentScheduledRemainingBlocks: null,
        },
      });
      return {
        ok: true,
        type: "clearHistory",
        message: t.syncHistoryCleared,
      } satisfies ActionData;
    }

    return { ok: false, message: "Invalid action" } satisfies ActionData;
  } catch (error) {
    const internalError = error instanceof Error ? error.message : String(error);
    const message =
      intent === "checkCustomScryfall"
        ? `${t.scryfallCheckFailedPrefix}: ${internalError}`
        : toSafeUiError(error);
    console.error("product-sync action failed", {
      shop,
      intent,
      internalError,
    });
    await db.syncConfiguration.upsert({
      where: { shop },
      create: {
        shop,
        lastRunAt: new Date(),
        lastRunStatus: "failed",
        lastError: internalError,
      },
      update: {
        lastRunAt: new Date(),
        lastRunStatus: "failed",
        lastError: internalError,
      },
    });
    return { ok: false, message } satisfies ActionData;
  }
};

export default function PriceSyncPage() {
  const {
    config,
    hasCardKingdomData,
    lang,
    nextRunAtDisplay,
    manualStatus,
    testStatus,
    scryfallCheckStatus,
    recentSyncRuns,
  } = useLoaderData<PriceSyncLoaderData>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const submit = useSubmit();
  const t = i18n[lang];
  const actionData = useActionData<ActionData>();
  const productSearchFetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const isEs = lang === "es";
  const [enabled, setEnabled] = useState(config.enabled);
  const [dailyTime, setDailyTime] = useState(
    isHourlyFrequencyToken(config.dailyTime) ||
      isThirtyMinutesFrequencyToken(config.dailyTime) ||
      isLegacyTenMinutesFrequencyToken(config.dailyTime) ||
      isLegacyFiveMinutesFrequencyToken(config.dailyTime)
      ? "03:00"
      : config.dailyTime,
  );
  const [scheduleMode, setScheduleMode] = useState<"daily_once" | "custom_hourly">(
    isThirtyMinutesFrequencyToken(config.dailyTime) ||
      isLegacyTenMinutesFrequencyToken(config.dailyTime) ||
      isLegacyFiveMinutesFrequencyToken(config.dailyTime)
      ? "custom_hourly"
      : isHourlyFrequencyToken(config.dailyTime)
        ? "custom_hourly"
        : "daily_once",
  );
  const [customUseThirtyMinutes, setCustomUseThirtyMinutes] = useState(
    isThirtyMinutesFrequencyToken(config.dailyTime) ||
      isLegacyTenMinutesFrequencyToken(config.dailyTime) ||
      isLegacyFiveMinutesFrequencyToken(config.dailyTime),
  );
  const [customIntervalHours, setCustomIntervalHours] = useState<number>(
    parseHourlyToken(config.dailyTime) ?? 1,
  );
  const [searchMode, setSearchMode] = useState(config.searchMode);
  const [searchMetafieldNamespace, setSearchMetafieldNamespace] = useState(
    config.searchMetafieldNamespace,
  );
  const [searchMetafieldKey, setSearchMetafieldKey] = useState(
    config.searchMetafieldKey,
  );
  const [useCustomScryfallIdField, setUseCustomScryfallIdField] = useState(
    config.useCustomScryfallIdField,
  );
  const [allowProductLevelCustomScryfallFallback, setAllowProductLevelCustomScryfallFallback] =
    useState(config.allowProductLevelCustomScryfallFallback);
  const [customScryfallIdNs, setCustomScryfallIdNs] = useState(config.customScryfallIdNs);
  const [customScryfallIdKey, setCustomScryfallIdKey] = useState(config.customScryfallIdKey);
  const [priceSource, setPriceSource] = useState(config.priceSource);
  const [justTcgApiKey, setJustTcgApiKey] = useState(config.justTcgApiKey ?? "");
  const [mtgjsonApiKey, setMtgjsonApiKey] = useState(config.mtgjsonApiKey ?? "");
  const [displayCurrency, setDisplayCurrency] = useState<"USD" | "CLP">(
    config.displayCurrency === "CLP" ? "CLP" : "USD",
  );
  const [priceAdjustmentMode, setPriceAdjustmentMode] = useState<"percent" | "fixed">(
    config.priceAdjustmentMode === "fixed" ? "fixed" : "percent",
  );
  const [priceAdjustmentPercent, setPriceAdjustmentPercent] = useState(
    String(config.priceAdjustmentPercent ?? 0),
  );
  const [priceAdjustmentFixed, setPriceAdjustmentFixed] = useState(
    String(config.priceAdjustmentFixed ?? 0),
  );
  const [minimumPrice, setMinimumPrice] = useState(String(config.minimumPrice ?? 0));
  const [syncImage, setSyncImage] = useState(config.syncImage);
  const [disableSuspiciousPriceAlert, setDisableSuspiciousPriceAlert] = useState(
    config.disableSuspiciousPriceAlert ?? false,
  );
  const [suspiciousPriceAlertThresholdPercent, setSuspiciousPriceAlertThresholdPercent] = useState(
    String(config.suspiciousPriceAlertThresholdPercent ?? 50),
  );
  const [isCheckModalOpen, setIsCheckModalOpen] = useState(false);
  const [isRunScopeModalOpen, setIsRunScopeModalOpen] = useState(false);
  const [manualLimitMode, setManualLimitMode] = useState<"all" | "latest">("all");
  const [manualMaxProducts, setManualMaxProducts] = useState("100");
  const [manualStatusStartedAtMs, setManualStatusStartedAtMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [maxProducts, setMaxProducts] = useState("10");
  const [selectedProductIds, setSelectedProductIds] = useState<string[]>([]);
  const [selectedProducts, setSelectedProducts] = useState<ProductOption[]>([]);
  const [productSearchQuery, setProductSearchQuery] = useState("");
  const [productSearchResults, setProductSearchResults] = useState<ProductOption[]>([]);
  const productSearchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousScryfallCheckStatusRef = useRef<string | null>(null);
  const [downloadingRunId, setDownloadingRunId] = useState<string | null>(null);
  const showSearchConfig = !useCustomScryfallIdField;
  const isSubmittingCustomScryfallCheck =
    navigation.state !== "idle" &&
    navigation.formData?.get("intent") === "checkCustomScryfall";
  const optimisticScryfallCheckStatus: ScryfallCheckStatusForUi | null =
    isSubmittingCustomScryfallCheck
      ? {
          status: "queued",
          message: t.scryfallCheckQueuedInlineText,
          startedAtUtc: null,
          updatedAtUtc: OPTIMISTIC_STATUS_UPDATED_AT,
          completedAtUtc: null,
          result: null,
        }
      : actionData?.ok && actionData.type === "checkCustomScryfallQueued"
        ? {
            status: actionData.queued ? "queued" : "running",
            message: actionData.message,
            startedAtUtc: null,
            updatedAtUtc: OPTIMISTIC_STATUS_UPDATED_AT,
            completedAtUtc: null,
            result: null,
          }
        : null;
  const visibleScryfallCheckStatus = scryfallCheckStatus ?? optimisticScryfallCheckStatus;
  const isScryfallCheckActive =
    visibleScryfallCheckStatus?.status === "queued" ||
    visibleScryfallCheckStatus?.status === "running";
  const isCheckingCustomScryfall =
    isSubmittingCustomScryfallCheck || isScryfallCheckActive;
  const isRunningSync =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "run";
  const isTestingSync =
    navigation.state !== "idle" && navigation.formData?.get("intent") === "runTest";
  const optimisticSyncStatus =
    isRunningSync
      ? "running"
      : actionData?.ok && actionData.type === "runQueued"
        ? "queued"
        : null;
  const currentSyncStatus = manualStatus?.status ?? optimisticSyncStatus;
  const optimisticTestStatus =
    isTestingSync
      ? "running"
      : actionData?.ok && actionData.type === "runTestQueued"
        ? "queued"
        : null;
  const currentTestStatus = testStatus?.status ?? optimisticTestStatus;
  const isTestSyncActive =
    currentTestStatus === "queued" || currentTestStatus === "running";
  const isScheduledSyncRunning =
    config.currentScheduledStatus === "running" && config.lastRunStatus === "running";
  const isManualSyncActive =
    currentSyncStatus === "queued" || currentSyncStatus === "running";
  const syncStartedAtMs =
    manualStatus?.startedAtUtc != null
      ? new Date(manualStatus.startedAtUtc).getTime()
      : currentSyncStatus !== null
        ? manualStatusStartedAtMs
        : null;
  const elapsedSeconds = syncStartedAtMs
    ? Math.max(0, Math.floor((nowMs - syncStartedAtMs) / 1000))
    : 0;
  const showManualStatusCard = currentSyncStatus !== null;
  const statusTitle =
    currentSyncStatus === "failed"
      ? t.manualSyncStatusFailed
      : currentSyncStatus === "success"
        ? t.manualSyncStatusSuccess
        : currentSyncStatus === "running"
      ? t.manualSyncStatusRunning
      : t.manualSyncStatusQueued;
  const statusText =
    currentSyncStatus === "failed"
      ? `${t.manualSyncFailedText}${manualStatus?.message ? ` (${manualStatus.message})` : ""}`
      : currentSyncStatus === "success"
        ? t.manualSyncSuccessText
        : currentSyncStatus === "running"
          ? t.manualSyncRunningText
          : t.manualSyncQueuedInlineText;
  const manualProcessedVariants = Math.max(0, manualStatus?.processedVariants ?? 0);
  const manualPricesUpdated = Math.max(0, manualStatus?.pricesUpdated ?? 0);
  const manualImagesUpdated = Math.max(0, manualStatus?.imagesUpdated ?? 0);
  const manualTotalVariants = Math.max(
    manualProcessedVariants,
    manualStatus?.totalVariants ?? 0,
  );
  const manualRemainingVariants = Math.max(0, manualTotalVariants - manualProcessedVariants);
  const manualPhaseLabel = (() => {
    const phase = manualStatus?.phase ?? null;
    if (phase === "updating_prices") return t.manualSyncStageUpdatingPrices;
    if (phase === "updating_metadata") return t.manualSyncStageUpdatingMetadata;
    if (phase === "updating_images") return t.manualSyncStageUpdatingImages;
    if (phase === "finalizing") return t.manualSyncStageFinalizing;
    if (phase === "completed") return t.manualSyncStageCompleted;
    return t.manualSyncStageScanning;
  })();
  const showManualProgress =
    currentSyncStatus === "running" &&
    (manualTotalVariants > 0 ||
      manualProcessedVariants > 0 ||
      (manualStatus?.cardsMatched ?? 0) > 0 ||
      manualPricesUpdated > 0);
  const showTestStatusCard = currentTestStatus !== null;
  const testStatusTitle =
    currentTestStatus === "failed"
      ? t.testSyncStatusFailed
      : currentTestStatus === "success"
        ? t.testSyncStatusSuccess
        : currentTestStatus === "running"
          ? t.testSyncStatusRunning
          : t.testSyncStatusQueued;
  const testStatusText =
    currentTestStatus === "failed"
      ? `${t.testSyncFailedText}${testStatus?.message ? ` (${testStatus.message})` : ""}`
      : currentTestStatus === "success"
        ? t.testSyncSuccessText
        : currentTestStatus === "running"
          ? t.testSyncRunningText
          : t.testSyncQueuedInlineText;
  const scryfallCheckStatusTitle =
    visibleScryfallCheckStatus?.status === "failed"
      ? t.scryfallCheckStatusFailed
      : visibleScryfallCheckStatus?.status === "success"
        ? t.scryfallCheckStatusSuccess
        : visibleScryfallCheckStatus?.status === "running"
          ? t.scryfallCheckStatusRunning
          : visibleScryfallCheckStatus?.status === "queued"
            ? t.scryfallCheckStatusQueued
            : null;
  const scryfallCheckStatusText =
    visibleScryfallCheckStatus?.status === "failed"
      ? `${t.scryfallCheckFailedPrefix}: ${visibleScryfallCheckStatus.message ?? t.syncErrorTitle}`
      : visibleScryfallCheckStatus?.status === "success"
        ? t.scryfallCheckCompleted
        : visibleScryfallCheckStatus?.status === "running"
          ? t.scryfallCheckRunningText
          : visibleScryfallCheckStatus?.status === "queued"
            ? t.scryfallCheckQueuedInlineText
            : null;
  const scryfallCheckWaitingText =
    visibleScryfallCheckStatus?.status === "queued"
      ? t.scryfallCheckQueuedInlineText
      : t.scryfallCheckRunningText;
  const checkModalResult = visibleScryfallCheckStatus?.result ?? null;
  const customScheduleFrequency = `every_${customIntervalHours}h`;
  const scheduleFrequencyValue =
    scheduleMode === "daily_once"
      ? "daily_once"
      : customUseThirtyMinutes
        ? THIRTY_MINUTES_FREQUENCY_TOKEN
        : customScheduleFrequency;
  const schedulePreview = formatSchedulePreview(
    lang,
    scheduleMode,
    scheduleFrequencyValue,
    dailyTime,
  );
  const matcherSummary = useCustomScryfallIdField
    ? `${t.useCustomScryfallIdField} (${customScryfallIdNs}.${customScryfallIdKey})`
    : searchMode === "metafield"
      ? `${t.searchMetafield} (${searchMetafieldNamespace}.${searchMetafieldKey})`
      : searchMode === "title"
        ? t.searchTitle
        : t.searchSku;
  const priceSourceOptions = [
    { label: t.priceScryfall, value: "scryfall" },
    { label: t.priceJusttcg, value: "justtcg" },
    { label: t.priceMtgjson, value: "mtgjson" },
    { label: t.priceCardkingdom + (hasCardKingdomData ? "" : " (sin cache)"), value: "cardkingdom" },
  ];
  const priceSourceSummary =
    priceSource === "justtcg"
      ? t.priceJusttcg
      : priceSource === "mtgjson"
        ? t.priceMtgjson
        : priceSource === "cardkingdom"
          ? t.priceCardkingdom
        : t.priceScryfall;
  const currencySummary = displayCurrency === "CLP" ? t.currencyCLP : t.currencyUSD;
  const testProcessedVariants = Math.max(0, testStatus?.processedVariants ?? 0);
  const testPricesUpdated = Math.max(0, testStatus?.pricesUpdated ?? 0);
  const liveHistoryRows: SyncHistoryTableRow[] = [];

  if (isManualSyncActive) {
    liveHistoryRows.push({
      id: "live-manual",
      status: manualStatus?.status ?? "running",
      message: manualStatus?.message ?? null,
      startedAt: manualStatus?.startedAtUtc
        ? new Date(manualStatus.startedAtUtc)
        : new Date(),
      variantsScanned: manualProcessedVariants,
      cardsMatched: Math.max(0, manualStatus?.cardsMatched ?? 0),
      pricesUpdated: manualPricesUpdated,
      failuresCount: Math.max(0, manualStatus?.failures ?? 0),
      suspiciousCount: Math.max(0, manualStatus?.suspiciousCount ?? 0),
      isLive: true,
      downloadRunId: null,
    });
  }

  if (isTestSyncActive) {
    liveHistoryRows.push({
      id: "live-test",
      status: testStatus?.status ?? "running",
      message: testStatus?.message ?? null,
      startedAt: testStatus?.startedAtUtc
        ? new Date(testStatus.startedAtUtc)
        : new Date(),
      variantsScanned: testProcessedVariants,
      cardsMatched: Math.max(0, testStatus?.cardsMatched ?? 0),
      pricesUpdated: testPricesUpdated,
      failuresCount: Math.max(0, testStatus?.failures ?? 0),
      suspiciousCount: Math.max(0, testStatus?.suspiciousCount ?? 0),
      isLive: true,
      downloadRunId: null,
    });
  }

  if (isScheduledSyncRunning) {
    const scheduledVariantsScanned = Math.max(
      0,
      config.currentScheduledProcessedVariants ?? config.currentScheduledTotalVariants ?? 0,
    );
    const scheduledCardsMatched = Math.min(
      Math.max(0, config.currentScheduledCardsMatched ?? 0),
      scheduledVariantsScanned,
    );
    const scheduledPricesUpdated = Math.min(
      Math.max(0, config.currentScheduledPricesUpdated ?? 0),
      scheduledCardsMatched,
    );
    liveHistoryRows.push({
      id: "live-scheduled",
      status: config.currentScheduledStatus ?? "running",
      message: config.lastError ?? null,
      startedAt: config.currentScheduledStartedAt
        ? new Date(config.currentScheduledStartedAt)
        : new Date(),
      variantsScanned: scheduledVariantsScanned,
      cardsMatched: scheduledCardsMatched,
      pricesUpdated: scheduledPricesUpdated,
      failuresCount: Math.max(0, config.currentScheduledFailures ?? 0),
      suspiciousCount: Math.max(0, config.currentScheduledSuspiciousCount ?? 0),
      isLive: true,
      downloadRunId: null,
    });
  }

  const syncHistoryRows: SyncHistoryTableRow[] = [
    ...liveHistoryRows,
    ...recentSyncRuns
      .filter((run) => run.status !== "running")
      .map((run) => ({
        id: run.id,
        status: run.status,
        message: run.message,
        startedAt: new Date(run.startedAt),
        variantsScanned: run.variantsScanned,
        cardsMatched: run.cardsMatched,
        pricesUpdated: run.pricesUpdated,
        failuresCount: run.failuresCount,
        suspiciousCount: run.suspiciousCount,
        isLive: false,
        downloadRunId: run.id,
      })),
  ].slice(0, 5);

  useEffect(() => {
    if (
      isThirtyMinutesFrequencyToken(config.dailyTime) ||
      isLegacyTenMinutesFrequencyToken(config.dailyTime) ||
      isLegacyFiveMinutesFrequencyToken(config.dailyTime)
    ) {
      setDailyTime("03:00");
      setScheduleMode("custom_hourly");
      setCustomUseThirtyMinutes(true);
      setCustomIntervalHours(1);
    } else if (isHourlyFrequencyToken(config.dailyTime)) {
      setDailyTime("03:00");
      setScheduleMode("custom_hourly");
      setCustomUseThirtyMinutes(false);
      setCustomIntervalHours(parseHourlyToken(config.dailyTime) ?? 1);
    } else {
      setDailyTime(config.dailyTime);
      setScheduleMode("daily_once");
      setCustomUseThirtyMinutes(false);
      setCustomIntervalHours(1);
    }
  }, [config.dailyTime]);

  useEffect(() => {
    if (!actionData) {
      return;
    }
    if (actionData.ok && actionData.type !== "searchProducts") {
      if (actionData.type === "checkCustomScryfallQueued") {
        setIsCheckModalOpen(true);
        return;
      }
      shopify.toast.show(actionData.message);
      return;
    }
    if (!actionData.ok) {
      shopify.toast.show(actionData.message);
    }
  }, [actionData, shopify]);

  useEffect(() => {
    const currentStatus = visibleScryfallCheckStatus?.status ?? null;
    const previousStatus = previousScryfallCheckStatusRef.current;

    const finishedAfterActiveRun =
      (currentStatus === "success" || currentStatus === "failed") &&
      (previousStatus === "queued" || previousStatus === "running");
    if (finishedAfterActiveRun) {
      setIsCheckModalOpen(true);
    }

    previousScryfallCheckStatusRef.current = currentStatus;
  }, [visibleScryfallCheckStatus?.status]);

  useEffect(() => {
    return () => {
      if (productSearchDebounceRef.current) {
        clearTimeout(productSearchDebounceRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (
      productSearchFetcher.data?.ok &&
      productSearchFetcher.data.type === "searchProducts"
    ) {
      setProductSearchResults(productSearchFetcher.data.results);
    }
  }, [productSearchFetcher.data]);

  useEffect(() => {
    if (
      actionData?.ok &&
      (actionData.type === "run" ||
        actionData.type === "runQueued" ||
        actionData.type === "runTestQueued")
    ) {
      setIsRunScopeModalOpen(false);
      if (actionData.type === "runQueued" && manualStatusStartedAtMs === null) {
        setManualStatusStartedAtMs(Date.now());
      }
    }
  }, [actionData, manualStatusStartedAtMs]);

  const isAnyPollingActive =
    isManualSyncActive || isScheduledSyncRunning || isTestSyncActive || isScryfallCheckActive;

  useEffect(() => {
    if (!isAnyPollingActive) {
      return;
    }
    const intervalId = setInterval(() => {
      revalidator.revalidate();
    }, 2_000);
    return () => clearInterval(intervalId);
  }, [isAnyPollingActive, revalidator]);

  useEffect(() => {
    if (!isManualSyncActive) {
      return;
    }
    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, 1_000);
    return () => clearInterval(intervalId);
  }, [isManualSyncActive]);

  const downloadHistoryCsv = async (runId: string) => {
    if (!runId || downloadingRunId) {
      return;
    }

    setDownloadingRunId(runId);
    try {
      const query = new URLSearchParams({ runId });
      query.set("lang", lang);
      const shopLocale = shopify.config.locale?.trim();
      if (shopLocale) {
        query.set("shopLocale", shopLocale);
      }

      const response = await fetch(
        `/app/price-sync/history-csv?${query.toString()}`,
        {
          method: "GET",
          credentials: "same-origin",
          headers: {
            Accept: "text/csv",
          },
        },
      );

      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || /text\/html/i.test(contentType)) {
        throw new Error("Download returned HTML instead of CSV");
      }

      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fileNameMatch = /filename="?([^"]+)"?/i.exec(disposition);
      const fileName = fileNameMatch?.[1] ?? `sync-history-${runId}.csv`;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      console.error("history csv download failed", {
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
      shopify.toast.show(
        lang === "es"
          ? "No se pudo descargar el CSV del historial"
          : "Could not download history CSV",
        { isError: true },
      );
    } finally {
      setDownloadingRunId((current) => (current === runId ? null : current));
    }
  };

  const submitSettingsFormWithIntent = (intent: "save" | "checkCustomScryfall") => {
    const form = document.getElementById("price-sync-settings-form") as HTMLFormElement | null;
    if (!form) {
      return;
    }
    const formData = new FormData(form);
    formData.set("intent", intent);
    if (intent === "checkCustomScryfall") {
      setIsCheckModalOpen(true);
    }
    submit(formData, { method: "post" });
  };

  return (
    <Page>
      <TitleBar title={t.priceSyncTitle} />
      <Layout>
        <Layout.Section>
          <Card>
            <Form method="post" id="price-sync-settings-form">
              <input type="hidden" name="intent" value="save" />
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  {t.settingsTitle}
                </Text>
                <FormLayout>
                  <Checkbox
                    label={t.enableDaily}
                    name="enabled"
                    checked={enabled}
                    value="on"
                    onChange={setEnabled}
                  />
                  <input
                    type="hidden"
                    name="scheduleFrequency"
                    value={scheduleFrequencyValue}
                  />
                  <Select
                    label={t.scheduleModeLabel}
                    options={[
                      { label: t.scheduleModeDaily, value: "daily_once" },
                      { label: t.scheduleModeCustom, value: "custom_hourly" },
                    ]}
                    value={scheduleMode}
                    onChange={(value) => {
                      if (
                        value === "daily_once" ||
                        value === "custom_hourly"
                      ) {
                        setScheduleMode(value as "daily_once" | "custom_hourly");
                      }
                    }}
                  />
                  <TextField
                    label={t.dailyTime}
                    type="time"
                    autoComplete="off"
                    name="dailyTime"
                    value={dailyTime}
                    onChange={setDailyTime}
                    disabled={scheduleMode !== "daily_once"}
                  />
                  {scheduleMode === "custom_hourly" && (
                    <Box>
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.syncFrequency}
                      </Text>
                      <Box paddingBlockStart="200">
                        <InlineGrid columns={6} gap="100">
                          <Button
                            variant={customUseThirtyMinutes ? "primary" : "secondary"}
                            onClick={() => setCustomUseThirtyMinutes(true)}
                          >
                            {isEs ? "Cada 30m" : "Every 30m"}
                          </Button>
                          {Array.from({ length: 12 }, (_, idx) => idx + 1).map((hours) => (
                            <Button
                              key={hours}
                              variant={
                                !customUseThirtyMinutes && customIntervalHours === hours
                                  ? "primary"
                                  : "secondary"
                              }
                              onClick={() => {
                                setCustomUseThirtyMinutes(false);
                                setCustomIntervalHours(hours);
                              }}
                            >
                              {isEs
                                ? `Cada ${hours}h`
                                : `Every ${hours}h`}
                            </Button>
                          ))}
                        </InlineGrid>
                      </Box>
                    </Box>
                  )}
                  <Box>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.schedulePreviewLabel}: <code>{schedulePreview.cron}</code>
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.scheduleNextRunLabel}: {schedulePreview.nextRunUtc}
                    </Text>
                  </Box>
                  <Checkbox
                    label={t.useCustomScryfallIdField}
                    name="useCustomScryfallIdField"
                    checked={useCustomScryfallIdField}
                    value="on"
                    onChange={setUseCustomScryfallIdField}
                  />
                  {useCustomScryfallIdField && (
                    <>
                      <InlineGrid columns={2} gap="300">
                        <TextField
                          label={t.customScryfallIdNs}
                          name="customScryfallIdNs"
                          autoComplete="off"
                          value={customScryfallIdNs}
                          onChange={setCustomScryfallIdNs}
                        />
                        <TextField
                          label={t.customScryfallIdKey}
                          name="customScryfallIdKey"
                          autoComplete="off"
                          value={customScryfallIdKey}
                          onChange={setCustomScryfallIdKey}
                        />
                      </InlineGrid>
                      <Box paddingBlockStart="300">
                        <Checkbox
                          label={t.allowProductLevelCustomScryfallFallback}
                          name="allowProductLevelCustomScryfallFallback"
                          checked={allowProductLevelCustomScryfallFallback}
                          value="on"
                          onChange={setAllowProductLevelCustomScryfallFallback}
                        />
                      </Box>
                      <Box paddingBlockStart="300">
                        <Banner tone="info" title={t.customScryfallIdHintTitle}>
                          <p>{t.customScryfallIdHintText}</p>
                          <p>{t.productFallbackHint}</p>
                        </Banner>
                      </Box>
                      <Box paddingBlockStart="300">
                        <Button
                          variant="secondary"
                          loading={isCheckingCustomScryfall}
                          onClick={() => submitSettingsFormWithIntent("checkCustomScryfall")}
                        >
                          {t.checkAgainstScryfall}
                        </Button>
                      </Box>
                      {(isSubmittingCustomScryfallCheck || isScryfallCheckActive) && (
                        <Box paddingBlockStart="300">
                          <Banner tone="info" title={t.scryfallCheckStatusRunning}>
                            <p>{scryfallCheckWaitingText}</p>
                          </Banner>
                        </Box>
                      )}
                      {scryfallCheckStatusTitle &&
                        scryfallCheckStatusText &&
                        visibleScryfallCheckStatus?.status === "failed" && (
                        <Box paddingBlockStart="300">
                          <Banner
                            tone="critical"
                            title={scryfallCheckStatusTitle}
                          >
                            <p>{scryfallCheckStatusText}</p>
                          </Banner>
                        </Box>
                        )}
                    </>
                  )}
                  {showSearchConfig ? (
                    <>
                      <Select
                        label={t.searchMode}
                        name="searchMode"
                        options={[
                          { label: t.searchSku, value: "sku" },
                          { label: t.searchTitle, value: "title" },
                          { label: t.searchMetafield, value: "metafield" },
                        ]}
                        value={searchMode}
                        onChange={(value) => {
                          if (isValidSearchMode(value)) {
                            setSearchMode(value);
                          }
                        }}
                      />
                      {searchMode === "metafield" && (
                        <>
                          <InlineGrid columns={2} gap="300">
                            <TextField
                              label={t.searchMetaNs}
                              name="searchMetafieldNamespace"
                              autoComplete="off"
                              value={searchMetafieldNamespace}
                              onChange={setSearchMetafieldNamespace}
                            />
                            <TextField
                              label={t.searchMetaKey}
                              name="searchMetafieldKey"
                              autoComplete="off"
                              value={searchMetafieldKey}
                              onChange={setSearchMetafieldKey}
                            />
                          </InlineGrid>
                          <Box paddingBlockStart="300">
                            <Banner tone="info" title={t.metafieldHintTitle}>
                              <p>{t.metafieldHintText}</p>
                            </Banner>
                          </Box>
                        </>
                      )}
                      <Box paddingBlockStart="300">
                        <Banner tone="info" title={t.internalScryfallMetaTitle}>
                          <p>{t.internalScryfallMetaText}</p>
                        </Banner>
                      </Box>
                    </>
                  ) : null}
                  {showSearchConfig && (
                    <Text as="p" variant="bodySm" tone="subdued">
                      {t.skuFieldHint}
                    </Text>
                  )}
                  <Select
                    label={t.priceSource}
                    name="priceSource"
                    options={priceSourceOptions}
                    value={priceSource}
                    onChange={(value) => {
                      if (isValidPriceSource(value)) {
                        setPriceSource(value);
                      }
                    }}
                  />
                  {(priceSource === "justtcg" || priceSource === "mtgjson") && (
                    <>
                      {priceSource === "justtcg" ? (
                        <TextField
                          label={t.justtcgApiKey}
                          name="justTcgApiKey"
                          type="password"
                          autoComplete="off"
                          value={justTcgApiKey}
                          onChange={setJustTcgApiKey}
                        />
                      ) : (
                        <TextField
                          label={t.mtgjsonApiKey}
                          name="mtgjsonApiKey"
                          type="password"
                          autoComplete="off"
                          value={mtgjsonApiKey}
                          onChange={setMtgjsonApiKey}
                        />
                      )}
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.pricingApiKeysHint}
                      </Text>
                    </>
                  )}
                  <Select
                    label={t.currencyLabel}
                    name="displayCurrency"
                    options={[
                      { label: t.currencyUSD, value: "USD" },
                      { label: t.currencyCLP, value: "CLP" },
                    ]}
                    value={displayCurrency}
                    onChange={(value) => {
                      if (isValidDisplayCurrency(value)) {
                        setDisplayCurrency(value);
                      }
                    }}
                  />
                  <Select
                    label={t.priceAdjustmentModeLabel}
                    name="priceAdjustmentMode"
                    options={[
                      { label: t.priceAdjustmentModePercent, value: "percent" },
                      { label: t.priceAdjustmentModeFixed, value: "fixed" },
                    ]}
                    value={priceAdjustmentMode}
                    onChange={(value) => {
                      if (isValidPriceAdjustmentMode(value)) {
                        setPriceAdjustmentMode(value);
                      }
                    }}
                  />
                  <InlineGrid columns={2} gap="300">
                    {priceAdjustmentMode === "percent" ? (
                      <TextField
                        label={t.priceAdjustmentPercentLabel}
                        name="priceAdjustmentPercent"
                        type="number"
                        autoComplete="off"
                        value={priceAdjustmentPercent}
                        onChange={setPriceAdjustmentPercent}
                        step={0.01}
                      />
                    ) : (
                      <TextField
                        label={`${t.priceAdjustmentFixedLabel} (${displayCurrency})`}
                        name="priceAdjustmentFixed"
                        type="number"
                        autoComplete="off"
                        value={priceAdjustmentFixed}
                        onChange={setPriceAdjustmentFixed}
                        step={0.01}
                      />
                    )}
                    <TextField
                      label={`${t.minimumPriceLabel} (${displayCurrency})`}
                      name="minimumPrice"
                      type="number"
                      autoComplete="off"
                      value={minimumPrice}
                      onChange={setMinimumPrice}
                      step={0.01}
                      min={0}
                    />
                  </InlineGrid>
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.priceAdjustmentHint}
                  </Text>
                  <BlockStack gap="300">
                    <BlockStack gap="100">
                      <Checkbox
                        label={t.disableSuspiciousPriceAlert}
                        name="disableSuspiciousPriceAlert"
                        checked={disableSuspiciousPriceAlert}
                        value="on"
                        onChange={setDisableSuspiciousPriceAlert}
                      />
                      <Text as="p" variant="bodySm" tone="subdued">
                        {t.disableSuspiciousPriceAlertHint}
                      </Text>
                      <TextField
                        label={t.suspiciousPriceAlertThresholdPercentLabel}
                        name="suspiciousPriceAlertThresholdPercent"
                        type="number"
                        autoComplete="off"
                        value={suspiciousPriceAlertThresholdPercent}
                        onChange={setSuspiciousPriceAlertThresholdPercent}
                        step={0.1}
                        min={SUSPICIOUS_ALERT_THRESHOLD_PERCENT_MIN}
                        max={SUSPICIOUS_ALERT_THRESHOLD_PERCENT_MAX}
                        disabled={disableSuspiciousPriceAlert}
                      />
                    </BlockStack>
                    <Checkbox
                      label={t.syncImage}
                      name="syncImage"
                      checked={syncImage}
                      value="on"
                      onChange={setSyncImage}
                    />
                  </BlockStack>
                  <Button
                    variant="primary"
                    onClick={() => submitSettingsFormWithIntent("save")}
                  >
                    {t.saveSettings}
                  </Button>
                </FormLayout>
              </BlockStack>
            </Form>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                {t.manualTitle}
              </Text>
              <Text as="p" variant="bodyMd">
                {t.manualText}
              </Text>
              <Form
                method="post"
                onSubmit={() => {
                  setManualStatusStartedAtMs(Date.now());
                }}
              >
                <input type="hidden" name="intent" value="run" />
                <Select
                  label={t.manualLimitModeLabel}
                  name="manualLimitMode"
                  options={[
                    { label: t.manualLimitModeAll, value: "all" },
                    { label: t.manualLimitModeLatest, value: "latest" },
                  ]}
                  value={manualLimitMode}
                  onChange={(value) => {
                    if (value === "all" || value === "latest") {
                      setManualLimitMode(value);
                    }
                  }}
                />
                {manualLimitMode === "latest" && (
                  <TextField
                    label={t.manualMaxProductsLabel}
                    name="manualMaxProducts"
                    type="number"
                    autoComplete="off"
                    value={manualMaxProducts}
                    onChange={setManualMaxProducts}
                    min={1}
                    max={1000}
                  />
                )}
                <input type="hidden" name="selectedProductIds" value="" />
                <input type="hidden" name="scopedRun" value="" />
                <Box paddingBlockStart="300">
                  <Button
                    submit
                    variant="primary"
                    loading={isManualSyncActive}
                    disabled={isManualSyncActive}
                  >
                    {t.runNow}
                  </Button>
                </Box>
              </Form>
              {showManualStatusCard && (
                <Box paddingBlockStart="300">
                  <Banner
                    tone={
                      currentSyncStatus === "failed"
                        ? "critical"
                        : currentSyncStatus === "success"
                          ? "success"
                          : "info"
                    }
                    title={statusTitle}
                  >
                    <p>{statusText}</p>
                    {(currentSyncStatus === "queued" || currentSyncStatus === "running") &&
                    syncStartedAtMs ? (
                      <>
                        <p>
                          {t.manualSyncElapsedLabel}: {formatDuration(elapsedSeconds, lang)}
                        </p>
                      </>
                    ) : currentSyncStatus === "queued" || currentSyncStatus === "running" ? (
                      <p>{t.manualSyncElapsedLabel}: {formatDuration(0, lang)}</p>
                    ) : null}
                    {showManualProgress ? (
                      <List>
                        <List.Item>
                          {t.manualSyncProgressLabel}: {manualProcessedVariants} / {manualTotalVariants}
                        </List.Item>
                        <List.Item>
                          {t.manualSyncCurrentStageLabel}: {manualPhaseLabel}
                        </List.Item>
                        <List.Item>
                          {t.lastScheduledMatchedSoFarLabel}: {manualStatus?.cardsMatched ?? 0}
                        </List.Item>
                        <List.Item>
                          {t.lastScheduledPricesUpdatedSoFarLabel}: {manualPricesUpdated}
                        </List.Item>
                        <List.Item>
                          {t.manualSyncRemainingCardsLabel}: {manualRemainingVariants}
                        </List.Item>
                        <List.Item>
                          {t.productImagesUpdatedLabel}: {manualImagesUpdated}
                        </List.Item>
                        <List.Item>
                          {t.lastScheduledMissingPriceSoFarLabel}:{" "}
                          {manualStatus?.skippedForMissingPrice ?? 0}
                        </List.Item>
                        <List.Item>
                          {t.lastScheduledFailuresSoFarLabel}: {manualStatus?.failures ?? 0}
                        </List.Item>
                      </List>
                    ) : null}
                  </Banner>
                </Box>
              )}
              <Button variant="secondary" onClick={() => setIsRunScopeModalOpen(true)}>
                {t.runScopeOpen}
              </Button>
              {showTestStatusCard && (
                <Box paddingBlockStart="300">
                  <Banner
                    tone={
                      currentTestStatus === "failed"
                        ? "critical"
                        : currentTestStatus === "success"
                          ? "success"
                          : "info"
                    }
                    title={testStatusTitle}
                  >
                    <p>{testStatusText}</p>
                    {actionData?.ok && actionData.type === "runTestQueued" ? (
                      <List>
                        <List.Item>
                          {t.testSyncDetailsSelectedCount}: {actionData.details.selectedCount}
                        </List.Item>
                        <List.Item>
                          {t.testSyncDetailsMaxProducts}:{" "}
                          {actionData.details.maxProducts ?? t.testSyncDetailsNoLimit}
                        </List.Item>
                        <List.Item>
                          {t.testSyncDetailsProductIds}:{" "}
                          {actionData.details.selectedProductIds.join(", ")}
                        </List.Item>
                      </List>
                    ) : null}
                  </Banner>
                </Box>
              )}
              <Box>
                <List>
                  <List.Item>
                    {t.metadataInit}: {config.metadataInitialized ? t.yes : t.no}
                  </List.Item>
                  <List.Item>
                    {t.lastScheduledRunStatusLabel}: {config.lastRunStatus ?? t.neverLabel}
                  </List.Item>
                  <List.Item>
                    {t.lastScheduledRunAtLabel}:{" "}
                    {config.lastRunAt ? formatUtcDateTime(new Date(config.lastRunAt), lang) : t.neverLabel}
                  </List.Item>
                  <List.Item>
                    {t.nextScheduledRunLabel}:{" "}
                    {nextRunAtDisplay
                      ? formatUtcDateTime(new Date(nextRunAtDisplay), lang)
                      : t.disabledLabel}
                  </List.Item>
                </List>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "12px",
                }}
              >
                <Text as="h2" variant="headingMd">
                  {t.syncHistoryTitle}
                </Text>
                <Form method="post">
                  <input type="hidden" name="intent" value="clearHistory" />
                  <Button submit variant="secondary" tone="critical" size="slim">
                    {t.clearSyncHistoryButton}
                  </Button>
                </Form>
              </div>
              {syncHistoryRows.length === 0 ? (
                <Text as="p" variant="bodySm" tone="subdued">
                  {t.syncHistoryEmpty}
                </Text>
              ) : (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
                    <thead>
                      <tr>
                        <th style={{ textAlign: "left", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                          {t.syncHistoryColumnDateTime}
                        </th>
                        <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                          {t.syncHistoryColumnProductsScanned}
                        </th>
                        <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                          {t.syncHistoryColumnCardsMatched}
                        </th>
                        <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                          {t.syncHistoryColumnCardsUpdated}
                        </th>
                        <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                          {t.syncHistoryColumnFailures}
                        </th>
                        <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                          {t.syncHistoryColumnSuspicious}
                        </th>
                        <th style={{ textAlign: "right", padding: "8px", borderBottom: "1px solid #dfe3e8" }}>
                          {t.syncHistoryColumnDownload}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {syncHistoryRows.map((run) => (
                        <tr key={run.id}>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5" }}>
                            {formatUtcDateTime(run.startedAt, lang)}
                            {run.isLive ? ` (${t.syncHistoryStatusRunning})` : ""}
                            {!run.isLive && run.status === "failed" ? (
                              <Tooltip content={run.message ?? t.syncErrorTitle}>
                                <Text as="span" variant="bodySm" tone="critical">
                                  {" "}
                                  (failed)
                                </Text>
                              </Tooltip>
                            ) : null}
                          </td>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {run.variantsScanned ?? "-"}
                          </td>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {run.cardsMatched ?? "-"}
                          </td>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {run.pricesUpdated ?? "-"}
                          </td>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {run.failuresCount ?? "-"}
                          </td>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {run.suspiciousCount ?? "-"}
                          </td>
                          <td style={{ padding: "8px", borderBottom: "1px solid #f1f3f5", textAlign: "right" }}>
                            {run.downloadRunId ? (
                              <Button
                                onClick={() => {
                                  if (run.downloadRunId) {
                                    void downloadHistoryCsv(run.downloadRunId);
                                  }
                                }}
                                loading={downloadingRunId === run.downloadRunId}
                                variant="secondary"
                                size="micro"
                              >
                                {t.downloadSyncHistoryButton}
                              </Button>
                            ) : (
                              <Text as="span" variant="bodySm" tone="subdued">
                                -
                              </Text>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        {actionData?.ok && actionData.type === "run" && (
          <Layout.Section>
            <Banner tone="success" title={t.syncCompletedTitle}>
              <List>
                <List.Item>
                  {t.variantsScannedLabel}: {actionData.result.variantsScanned}
                </List.Item>
                <List.Item>
                  {t.cardsMatchedLabel}: {actionData.result.cardsMatched}
                </List.Item>
                <List.Item>
                  {t.pricesUpdatedLabel}: {actionData.result.pricesUpdated}
                </List.Item>
                <List.Item>
                  {t.scryfallMetadataStoredLabel}:{" "}
                  {actionData.result.metafieldsUpdated}
                </List.Item>
                <List.Item>
                  {t.productImagesUpdatedLabel}: {actionData.result.imagesUpdated}
                </List.Item>
                <List.Item>
                  {t.missingSourcePricesLabel}: {actionData.result.skippedForMissingPrice}
                </List.Item>
                <List.Item>
                  {t.previousPriceStoredLabel}: {actionData.result.previousPricesStored}
                </List.Item>
                <List.Item>{t.failuresLabel}: {actionData.result.failures.length}</List.Item>
              </List>
              {actionData.result.previousPricesStored === 0 && (
                <Box paddingBlockStart="200">
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.previousPriceNoChangesHint}
                  </Text>
                </Box>
              )}
              {actionData.result.failures.length > 0 && (
                <Box paddingBlockStart="300">
                  <Text as="p" variant="bodySm" tone="critical">
                    {t.failureDetailsFirstTenLabel}:
                  </Text>
                  <List>
                    {actionData.result.failures.slice(0, 10).map((failure, index) => (
                      <List.Item key={`${failure.variantId}-${index}`}>
                        {failure.variantId}: {failure.reason}
                      </List.Item>
                    ))}
                  </List>
                </Box>
              )}
            </Banner>
          </Layout.Section>
        )}
        {actionData && !actionData.ok && (
          <Layout.Section>
            <Banner tone="critical" title={t.syncErrorTitle}>
              <p>{actionData.message}</p>
            </Banner>
          </Layout.Section>
        )}
      </Layout>
      {isCheckModalOpen && visibleScryfallCheckStatus && (
        <Modal
          open={isCheckModalOpen}
          onClose={() => setIsCheckModalOpen(false)}
          title={t.checkModalTitle}
          primaryAction={{
            content: t.checkModalClose,
            onAction: () => setIsCheckModalOpen(false),
          }}
        >
          <Modal.Section>
            <BlockStack gap="400">
              <Text as="p" variant="bodyMd" tone="subdued">
                {t.checkModalSubtitle}
              </Text>
              {(visibleScryfallCheckStatus.status === "queued" ||
                visibleScryfallCheckStatus.status === "running") && (
                <Banner tone="info" title={scryfallCheckStatusTitle ?? t.checkModalTitle}>
                  <p>{scryfallCheckStatusText ?? t.scryfallCheckRunningText}</p>
                </Banner>
              )}
              {visibleScryfallCheckStatus.status === "failed" && (
                <Banner tone="critical" title={scryfallCheckStatusTitle ?? t.syncErrorTitle}>
                  <p>{scryfallCheckStatusText ?? t.scryfallCheckFailedPrefix}</p>
                </Banner>
              )}
              {visibleScryfallCheckStatus.status === "success" && checkModalResult && (
                <>
                  <InlineGrid columns={2} gap="300">
                    <Card>
                      <BlockStack gap="200">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.checkVariantsAnalyzed}
                        </Text>
                        <Text as="p" variant="headingLg">
                          {checkModalResult.variantsScanned}
                        </Text>
                      </BlockStack>
                    </Card>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.checkVariantsWithCustomId}
                        </Text>
                        <Text as="p" variant="headingLg">
                          {checkModalResult.variantsWithCustomId}
                        </Text>
                      </BlockStack>
                    </Card>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.checkVariantsFound}
                        </Text>
                        <Text as="p" variant="headingLg" tone="success">
                          {checkModalResult.variantsFoundInScryfall}
                        </Text>
                      </BlockStack>
                    </Card>
                    <Card>
                      <BlockStack gap="200">
                        <Text as="p" variant="bodySm" tone="subdued">
                          {t.checkProductsFound}
                        </Text>
                        <Text as="p" variant="headingLg" tone="success">
                          {checkModalResult.productsFoundInScryfall} /{" "}
                          {checkModalResult.productsWithCustomId}
                        </Text>
                      </BlockStack>
                    </Card>
                  </InlineGrid>
                  <Banner tone="info" title={t.checkNotFoundTitle}>
                    <p>
                      {t.checkNotFoundLabel}: {checkModalResult.notFoundInScryfall}
                    </p>
                  </Banner>
                </>
              )}
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
      <Modal
        open={isRunScopeModalOpen}
        onClose={() => setIsRunScopeModalOpen(false)}
        title={t.runScopeModalTitle}
        primaryAction={{
          content: t.runScopeStart,
          loading: isTestingSync,
          disabled: selectedProductIds.length === 0,
          onAction: () => {
            const form = document.getElementById("scoped-run-form") as HTMLFormElement | null;
            form?.requestSubmit();
          },
        }}
        secondaryActions={[
          {
            content: t.runScopeClear,
            onAction: () => {
              setSelectedProductIds([]);
              setSelectedProducts([]);
            },
          },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="300">
            <Text as="p" variant="bodyMd" tone="subdued">
              {t.runScopeModalSubtitle}
            </Text>
            <Banner tone="info" title={t.runScopeConfigTitle}>
              <List>
                <List.Item>
                  {t.runScopeConfigMatcher}: {matcherSummary}
                </List.Item>
                <List.Item>
                  {t.runScopeConfigPriceSource}: {priceSourceSummary}
                </List.Item>
                <List.Item>
                  {t.runScopeConfigCurrency}: {currencySummary}
                </List.Item>
              </List>
            </Banner>
            <TextField
              label={t.runScopeMaxProducts}
              type="number"
              autoComplete="off"
              value={maxProducts}
              onChange={setMaxProducts}
              min={1}
              max={250}
            />
            <Form method="post" id="scoped-run-form">
              <input type="hidden" name="intent" value="runTest" />
              <input type="hidden" name="scopedRun" value="on" />
              <input type="hidden" name="maxProducts" value={maxProducts} />
              <input type="hidden" name="selectedProductIds" value={selectedProductIds.join(",")} />
            </Form>
            <Text as="p" variant="bodySm" tone={selectedProductIds.length === 0 ? "critical" : "subdued"}>
              {t.runScopePickProducts}
            </Text>
            <TextField
              label={t.runScopeSearchProducts}
              autoComplete="off"
              value={productSearchQuery}
              placeholder={t.runScopeSearchPlaceholder}
              onChange={(value) => {
                setProductSearchQuery(value);
                if (productSearchDebounceRef.current) {
                  clearTimeout(productSearchDebounceRef.current);
                }
                const query = value.trim();
                if (query.length < 2) {
                  setProductSearchResults([]);
                  return;
                }
                productSearchDebounceRef.current = setTimeout(() => {
                  const formData = new FormData();
                  formData.set("intent", "searchProducts");
                  formData.set("query", query);
                  productSearchFetcher.submit(formData, { method: "post" });
                }, 250);
              }}
            />
            <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #dfe3e8", borderRadius: 8, padding: 12 }}>
              <BlockStack gap="200">
                {productSearchResults.map((product) => (
                  <Button
                    key={product.id}
                    variant="secondary"
                    disabled={selectedProductIds.includes(product.id)}
                    onClick={() => {
                      setSelectedProductIds((current) =>
                        current.includes(product.id) ? current : [...current, product.id],
                      );
                      setSelectedProducts((current) =>
                        current.some((item) => item.id === product.id)
                          ? current
                          : [...current, product],
                      );
                    }}
                  >
                    {product.title}
                  </Button>
                ))}
              </BlockStack>
            </div>
            <Text as="p" variant="bodySm" tone="subdued">
              {t.runScopeSelectedProducts}
            </Text>
            <div style={{ maxHeight: 160, overflowY: "auto", border: "1px solid #dfe3e8", borderRadius: 8, padding: 12 }}>
              <BlockStack gap="200">
                {selectedProducts.length === 0 ? (
                  <Text as="p" variant="bodySm" tone="subdued">
                    {t.runScopeNoSelectedProducts}
                  </Text>
                ) : (
                  selectedProducts.map((product) => (
                    <Box key={product.id}>
                      <Button
                        variant="plain"
                        onClick={() => {
                          setSelectedProductIds((current) =>
                            current.filter((id) => id !== product.id),
                          );
                          setSelectedProducts((current) =>
                            current.filter((item) => item.id !== product.id),
                          );
                        }}
                      >
                        {product.title} x
                      </Button>
                    </Box>
                  ))
                )}
              </BlockStack>
            </div>
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Page>
  );
}
