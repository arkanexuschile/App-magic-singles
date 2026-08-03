import { writeSyncLog } from "../sync-log.server";
import type { ScryfallCard, ScryfallLookupResult } from "./types";

const LANG_CODES = new Set([
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "ko",
  "ru",
  "zhs",
  "zht",
]);

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

const SCRYFALL_TIMEOUT_MS = parseSafeMs(process.env.SCRYFALL_TIMEOUT_MS, 15000);
const SCRYFALL_MIN_INTERVAL_MS = (() => {
  const value = Number(process.env.SCRYFALL_MIN_INTERVAL_MS ?? "120");
  if (!Number.isFinite(value) || value < 0) {
    return 120;
  }
  return Math.min(1000, Math.floor(value));
})();
const SCRYFALL_MAX_RETRIES = (() => {
  const value = Number(process.env.SCRYFALL_MAX_RETRIES ?? "3");
  if (!Number.isFinite(value) || value < 0) {
    return 3;
  }
  return Math.min(5, Math.floor(value));
})();
const SCRYFALL_CACHE_TTL_MS = parseSafeTtlMs(process.env.SCRYFALL_CACHE_TTL_MS, 6 * 60 * 60 * 1000);

declare global {
  // eslint-disable-next-line no-var
  var __scryfallLastRequestAt: number | undefined;
  // eslint-disable-next-line no-var
  var __scryfallCooldownUntil: number | undefined;
  // eslint-disable-next-line no-var
  var __scryfallResponseCache:
    | Map<string, { expiresAt: number; value: unknown }>
    | undefined;
  // eslint-disable-next-line no-var
  var __scryfallInFlightRequests:
    | Map<string, Promise<unknown>>
    | undefined;
}

if (global.__scryfallLastRequestAt === undefined) {
  global.__scryfallLastRequestAt = 0;
}
if (global.__scryfallCooldownUntil === undefined) {
  global.__scryfallCooldownUntil = 0;
}
if (!global.__scryfallResponseCache) {
  global.__scryfallResponseCache = new Map();
}
if (!global.__scryfallInFlightRequests) {
  global.__scryfallInFlightRequests = new Map();
}

function isLikelyScryfallUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim(),
  );
}

export function normalizeScryfallIdentifier(rawValue: string | null | undefined): string | null {
  const trimmed = rawValue?.trim() ?? "";
  if (!trimmed) {
    return null;
  }

  const inlineUuid = trimmed.match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  )?.[0];
  if (inlineUuid) {
    return inlineUuid.toLowerCase();
  }

  const oraclePrefix = /^oracleid\s*:\s*(.+)$/i.exec(trimmed)?.[1]?.trim();
  if (oraclePrefix) {
    return oraclePrefix;
  }

  try {
    const parsed = new URL(trimmed);
    const fromPath = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .find((segment) => isLikelyScryfallUuid(segment));
    if (fromPath) {
      return fromPath.toLowerCase();
    }

    const oracleFromQuery =
      parsed.searchParams.get("oracleid") ?? parsed.searchParams.get("oracle_id");
    if (oracleFromQuery?.trim()) {
      return oracleFromQuery.trim();
    }
  } catch {
    // Non-URL values are expected in normal operation.
  }

  return trimmed;
}

function parseScryfallCardUrl(value: string): { setCode: string; collectorNumber: string } | null {
  try {
    const parsed = new URL(value.trim());
    if (!/(^|\.)scryfall\.com$/i.test(parsed.hostname)) {
      return null;
    }

    const [resource, setCode, collectorNumber] = parsed.pathname
      .split("/")
      .map((segment) => segment.trim())
      .filter(Boolean);
    if (resource !== "card" || !setCode || !collectorNumber) {
      return null;
    }

    return {
      setCode: setCode.toLowerCase(),
      collectorNumber,
    };
  } catch {
    return null;
  }
}

function parseSkuToken(rawSku: string): {
  setCode: string;
  collectorNumber: string;
  foilMode: "foil" | "nonfoil" | null;
  language: string;
} | null {
  // Imported products can carry a "-2", "-3", ... suffix when their SKU collided
  // with another card (see set-importer dedupe). Strip it before compacting so
  // the collector number is parsed correctly.
  const withoutDedupeSuffix = rawSku.replace(/-\d+$/i, "");
  const compact = withoutDedupeSuffix.replace(/[\s\-_]/g, "").toLowerCase();
  if (compact.length < 4) {
    return null;
  }

  const setCode = compact.slice(0, 3);
  let remainder = compact.slice(3);
  let language = "en";
  let foilMode: "foil" | "nonfoil" | null = null;

  if (remainder.length >= 2) {
    const maybeLang = remainder.slice(-2);
    if (LANG_CODES.has(maybeLang)) {
      language = maybeLang;
      remainder = remainder.slice(0, -2);
    }
  }

  if (remainder.endsWith("nonfoil")) {
    foilMode = "nonfoil";
    remainder = remainder.slice(0, -"nonfoil".length);
  } else if (remainder.endsWith("foil")) {
    foilMode = "foil";
    remainder = remainder.slice(0, -"foil".length);
  } else if (remainder.endsWith("nf")) {
    foilMode = "nonfoil";
    remainder = remainder.slice(0, -2);
  } else if (remainder.endsWith("f")) {
    foilMode = "foil";
    remainder = remainder.slice(0, -1);
  }

  if (!remainder) {
    return null;
  }

  return {
    setCode,
    collectorNumber: remainder,
    foilMode,
    language,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const now = Date.now();
  const cached = global.__scryfallResponseCache?.get(url);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const inFlight = global.__scryfallInFlightRequests?.get(url);
  if (inFlight) {
    return inFlight;
  }

  const requestPromise = (async () => {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= SCRYFALL_MAX_RETRIES; attempt += 1) {
      const requestNow = Date.now();
      const minAllowedAt = Math.max(
        (global.__scryfallLastRequestAt ?? 0) + SCRYFALL_MIN_INTERVAL_MS,
        global.__scryfallCooldownUntil ?? 0,
      );
      const waitMs = minAllowedAt - requestNow;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), SCRYFALL_TIMEOUT_MS);
      try {
        global.__scryfallLastRequestAt = Date.now();
        const response = await fetch(url, {
          headers: {
            Accept: "application/json",
            "User-Agent": "shopify-price-sync/1.0",
          },
          signal: controller.signal,
        });

        if (!response.ok) {
          if (response.status === 404) {
            global.__scryfallResponseCache?.set(url, {
              expiresAt: Date.now() + SCRYFALL_CACHE_TTL_MS,
              value: null,
            });
            return null;
          }

          const shouldRetry = response.status === 429 || response.status >= 500;
          if (shouldRetry && attempt < SCRYFALL_MAX_RETRIES) {
            const retryAfterRaw = response.headers.get("retry-after");
            const retryAfterSeconds = Number(retryAfterRaw ?? "");
            const retryDelayMs =
              Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
                ? Math.floor(retryAfterSeconds * 1000)
                : 400 * (attempt + 1);
            if (response.status === 429) {
              global.__scryfallCooldownUntil = Math.max(
                global.__scryfallCooldownUntil ?? 0,
                Date.now() + retryDelayMs,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }

          throw new Error(`Scryfall request failed: ${response.status}`);
        }

        const payload = await response.json();
        global.__scryfallResponseCache?.set(url, {
          expiresAt: Date.now() + SCRYFALL_CACHE_TTL_MS,
          value: payload,
        });
        return payload;
      } catch (error) {
        const isAbortError = error instanceof Error && error.name === "AbortError";
        const isRetriableNetworkError =
          error instanceof Error &&
          /(UND_ERR|ETIMEDOUT|ECONNRESET|EAI_AGAIN|fetch failed|timeout)/i.test(
            error.message,
          );
        if ((isAbortError || isRetriableNetworkError) && attempt < SCRYFALL_MAX_RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
          continue;
        }

        lastError = error instanceof Error ? error : new Error(String(error));
        break;
      } finally {
        clearTimeout(timeout);
      }
    }

    if (lastError) {
      throw lastError;
    }
    throw new Error("Scryfall request failed: unknown error");
  })();

  global.__scryfallInFlightRequests?.set(url, requestPromise);
  try {
    return await requestPromise;
  } finally {
    global.__scryfallInFlightRequests?.delete(url);
  }
}

export async function fetchScryfallCardBySku(sku: string): Promise<ScryfallLookupResult | null> {
  const token = parseSkuToken(sku);
  if (!token) {
    return null;
  }

  const withLanguage = `https://api.scryfall.com/cards/${token.setCode}/${encodeURIComponent(token.collectorNumber)}/${token.language}`;
  const withoutLanguage = `https://api.scryfall.com/cards/${token.setCode}/${encodeURIComponent(token.collectorNumber)}`;
  const payload = (await fetchJson(withLanguage)) ?? (await fetchJson(withoutLanguage));
  const searchFallbackQueries = [
    `set:${token.setCode} cn:${token.collectorNumber} lang:${token.language}`,
    `set:${token.setCode} cn:${token.collectorNumber}`,
  ];
  let searchFallbackPayload: unknown = null;
  if (!payload) {
    for (const query of searchFallbackQueries) {
      const searchUrl = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`;
      const searchResponse = await fetchJson(searchUrl);
      if (
        searchResponse &&
        typeof searchResponse === "object" &&
        "data" in searchResponse &&
        Array.isArray((searchResponse as { data?: unknown[] }).data) &&
        ((searchResponse as { data?: unknown[] }).data?.length ?? 0) > 0
      ) {
        searchFallbackPayload = (searchResponse as { data: unknown[] }).data[0];
        break;
      }
    }
  }
  const resolvedPayload = payload ?? searchFallbackPayload;
  if (!resolvedPayload || typeof resolvedPayload !== "object") {
    return null;
  }

  const card = resolvedPayload as ScryfallCard;
  if (token.foilMode && card.finishes && !card.finishes.includes(token.foilMode)) {
    return null;
  }

  return { card, foilMode: token.foilMode };
}

export async function fetchScryfallCardByTitle(title: string): Promise<ScryfallLookupResult | null> {
  const trimmedTitle = title.trim();
  if (!trimmedTitle) {
    return null;
  }

  // Stricter matching than search endpoint: requires an exact card name.
  const payload = await fetchJson(
    `https://api.scryfall.com/cards/named?exact=${encodeURIComponent(trimmedTitle)}`,
  );
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return { card: payload as ScryfallCard, foilMode: null };
}

export async function fetchScryfallCardById(id: string): Promise<ScryfallLookupResult | null> {
  const parsedCardUrl = parseScryfallCardUrl(id);
  if (parsedCardUrl) {
    const payload = await fetchJson(
      `https://api.scryfall.com/cards/${encodeURIComponent(
        parsedCardUrl.setCode,
      )}/${encodeURIComponent(parsedCardUrl.collectorNumber)}`,
    );
    if (!payload || typeof payload !== "object") {
      return null;
    }
    return { card: payload as ScryfallCard, foilMode: null };
  }

  const resolvedId = normalizeScryfallIdentifier(id);
  if (!resolvedId) {
    return null;
  }
  const payload = await fetchJson(`https://api.scryfall.com/cards/${encodeURIComponent(resolvedId)}`);
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return { card: payload as ScryfallCard, foilMode: null };
}

export async function fetchScryfallCardByOracleId(id: string): Promise<ScryfallLookupResult | null> {
  const resolvedId = normalizeScryfallIdentifier(id);
  if (!resolvedId) {
    return null;
  }
  const query = `oracleid:${resolvedId}`;
  const payload = await fetchJson(
    `https://api.scryfall.com/cards/search?q=${encodeURIComponent(query)}`,
  );
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const data = (payload as { data?: unknown[] }).data;
  if (!Array.isArray(data) || data.length === 0 || typeof data[0] !== "object") {
    return null;
  }
  return { card: data[0] as ScryfallCard, foilMode: null };
}

export async function doesScryfallIdExistForValidation(id: string): Promise<boolean> {
  const resolvedId = normalizeScryfallIdentifier(id);
  if (!resolvedId) {
    return false;
  }

  try {
    const byCardId = await fetchScryfallCardById(id);
    if (byCardId) {
      return true;
    }

    const byOracleId = await fetchScryfallCardByOracleId(id);
    return byOracleId !== null;
  } catch (error) {
    writeSyncLog("warn", "[product-debug] validation request failed", {
      scryfallId: id,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
