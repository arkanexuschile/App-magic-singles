import db from "../db.server";
import type {
  DisplayCurrency,
  PriceAdjustmentMode,
  PriceSource,
  SearchMode,
  SyncRunResult,
  SyncPreferences,
} from "./price-sync.server";

export type SyncConfigurationRecord = {
  shop: string;
  enabled: boolean;
  dailyTime: string;
  timezone: string;
  syncImage: boolean;
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
  metadataInitialized: boolean;
  imageSyncInitialized: boolean;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastError: string | null;
  lastScheduledVariantsScanned: number | null;
  lastScheduledCardsMatched: number | null;
  lastScheduledPricesUpdated: number | null;
  lastScheduledMetafieldsUpdated: number | null;
  lastScheduledImagesUpdated: number | null;
  lastScheduledSkippedForMissingPrice: number | null;
  lastScheduledPreviousPricesStored: number | null;
  lastScheduledFailures: number | null;
  currentScheduledStatus: string | null;
  currentScheduledStartedAt: Date | null;
  currentScheduledUpdatedAt: Date | null;
  currentScheduledTotalVariants: number | null;
  currentScheduledProcessedVariants: number | null;
  currentScheduledCardsMatched: number | null;
  currentScheduledPricesUpdated: number | null;
  currentScheduledSkippedForMissingPrice: number | null;
  currentScheduledFailures: number | null;
  currentScheduledSuspiciousCount: number | null;
  currentScheduledTotalBlocks: number | null;
  currentScheduledProcessedBlocks: number | null;
  currentScheduledRemainingBlocks: number | null;
  scheduledCursorProductId: string | null;
  scheduledCursorProductUpdatedAt: Date | null;
  genericDescription: string;
};

const DEFAULT_CONFIG: Omit<SyncConfigurationRecord, "shop"> = {
  enabled: false,
  dailyTime: "03:00",
  timezone: "UTC",
  syncImage: false,
  searchMode: "sku",
  searchMetafieldNamespace: "custom",
  searchMetafieldKey: "card_lookup",
  useCustomScryfallIdField: false,
  allowProductLevelCustomScryfallFallback: false,
  customScryfallIdNs: "custom",
  customScryfallIdKey: "scryfall_id",
  priceSource: "scryfall",
  justTcgApiKey: "",
  mtgjsonApiKey: "",
  displayCurrency: "CLP",
  priceAdjustmentMode: "percent",
  priceAdjustmentPercent: 0,
  priceAdjustmentFixed: 0,
  minimumPrice: 0,
  disableSuspiciousPriceAlert: false,
  suspiciousPriceAlertThresholdPercent: 50,
  scryfallMetafieldNs: "custom",
  scryfallMetafieldKey: "scryfall_meta",
  metadataInitialized: false,
  imageSyncInitialized: false,
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: null,
  lastError: null,
  lastScheduledVariantsScanned: null,
  lastScheduledCardsMatched: null,
  lastScheduledPricesUpdated: null,
  lastScheduledMetafieldsUpdated: null,
  lastScheduledImagesUpdated: null,
  lastScheduledSkippedForMissingPrice: null,
  lastScheduledPreviousPricesStored: null,
  lastScheduledFailures: null,
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
  scheduledCursorProductId: null,
  scheduledCursorProductUpdatedAt: null,
  genericDescription:
    `<p>Ganar en Magic: The Gathering muchas veces depende de tener la carta correcta. En la apertura al azar de <a href="https://piedrabruja.cl/collections/magic-the-gathering-mtg" title="Colección Todo Magic The Gathering" rel="noopener" target="_blank">productos sellados</a> no puedes asegurar que obtendrás la carta específica ni el playset completo (las cuatro copias permitidas en algunos formatos), por eso buscar cartas sueltas o singles Magic es una estrategia clave en el deckbuilding y la construcción de tu mazo.</p><p>Las cartas Magic individuales te permiten optimizar tu estrategia en formatos como Commander, Standard, Pauper o Legacy, asegurando exactamente la pieza que necesitas sin depender del azar.</p> ` +
    `<p>Magic no es solo un juego competitivo; también es colección, historia y comunidad. Cada mazo que construyes cuenta algo, y a veces solo te falta ese comandante, planeswalker o criatura que completa tu idea.</p> ` +
    `<p>Los precios de nuestros singles de Magic: The Gathering se ajustan según la base de datos internacional Scryfall. El valor de una carta puede variar día a día, pero las colecciones de Magic han demostrado valorizarse con el tiempo.</p> ` +
    `<div style="border: 1px solid #F59E0B; border-radius: 10px; padding: 16px; margin: 20px 0;"><strong style="color: #f59e0b;">✨ Explora nuestro mundo de Singles MTG</strong><p style="margin-top: 10px;">Conoce las últimas cartas agregadas, los singles más visitados y nuestras políticas de compra y venta.</p><a href="https://piedrabruja.cl/pages/magic-singles-piedrabruja" target="_blank" rel="noopener" style="display:inline-block;background:#F59E0B;color:white;padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:bold;">Ver página de Singles</a></div> ` +
    `<div style="border: 1px solid #002447; border-radius: 10px; padding: 16px; margin: 20px 0;"><strong style="color: #002447;">🔎 ¿No encuentras la carta que buscas?</strong><p style="margin-top: 10px;">También puedes explorar nuestro catálogo extendido en Card Kingdom x PiedraBruja.</p><a href="https://www.cardkingdom.com/?partner=PiedraBruja&amp;utm_source=PiedraBruja&amp;utm_medium=affiliate&amp;utm_campaign=PiedraBruja" target="_blank" rel="noopener" style="display:inline-block;background:#002447;color:white;padding:10px 14px;border-radius:8px;text-decoration:none;font-weight:bold;">Buscar en Card Kingdom</a></div> ` +
    `<p>Realizamos envíos el mismo día dentro de Santiago hasta las 11:00 am y entregas en 1 a 2 días hábiles según tu ubicación.</p>`,
};

type ZonedDateParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

const DATE_TIME_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function parseDailyTime(time: string): { hour: number; minute: number } {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!match) {
    return { hour: 3, minute: 0 };
  }
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function parseHourlyFrequency(time: string): number | null {
  const match = /^every_(1[0-2]|[1-9])h$/.exec(time);
  if (!match) {
    return null;
  }
  return Number(match[1]);
}

function parseMinuteFrequency(time: string): number | null {
  if (time === "every_30m" || time === "every_10m" || time === "every_5m") {
    // Legacy minute frequencies are normalized to 30 minutes.
    return 30;
  }
  return null;
}

function isValidIanaTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function normalizeTimeZone(timezone: string | null | undefined): string {
  if (!timezone) {
    return "UTC";
  }
  return isValidIanaTimeZone(timezone) ? timezone : "UTC";
}

function getDateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  const normalized = normalizeTimeZone(timezone);
  const cached = DATE_TIME_FORMATTER_CACHE.get(normalized);
  if (cached) {
    return cached;
  }
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: normalized,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  DATE_TIME_FORMATTER_CACHE.set(normalized, formatter);
  return formatter;
}

function getZonedDateParts(date: Date, timezone: string): ZonedDateParts {
  const formatter = getDateTimeFormatter(timezone);
  const parts = formatter.formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(byType.get("year") ?? 0),
    month: Number(byType.get("month") ?? 1),
    day: Number(byType.get("day") ?? 1),
    hour: Number(byType.get("hour") ?? 0),
    minute: Number(byType.get("minute") ?? 0),
    second: Number(byType.get("second") ?? 0),
  };
}

function addDaysToDateParts(parts: {
  year: number;
  month: number;
  day: number;
}, days: number): { year: number; month: number; day: number } {
  const base = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + days);
  return {
    year: base.getUTCFullYear(),
    month: base.getUTCMonth() + 1,
    day: base.getUTCDate(),
  };
}

function zonedDateTimeToUtc(params: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}): Date {
  const timezone = normalizeTimeZone(params.timezone);
  let guess = new Date(
    Date.UTC(params.year, params.month - 1, params.day, params.hour, params.minute, 0, 0),
  );

  for (let index = 0; index < 6; index += 1) {
    const zoned = getZonedDateParts(guess, timezone);
    const targetAsUtc = Date.UTC(
      params.year,
      params.month - 1,
      params.day,
      params.hour,
      params.minute,
      0,
      0,
    );
    const zonedAsUtc = Date.UTC(
      zoned.year,
      zoned.month - 1,
      zoned.day,
      zoned.hour,
      zoned.minute,
      0,
      0,
    );
    const diffMs = targetAsUtc - zonedAsUtc;
    if (diffMs === 0) {
      break;
    }
    guess = new Date(guess.getTime() + diffMs);
  }

  guess.setUTCSeconds(0, 0);
  return guess;
}

export function computeNextRunAt(
  dailyTime: string,
  timezone = "UTC",
  now = new Date(),
): Date {
  const everyMinutes = parseMinuteFrequency(dailyTime);
  if (everyMinutes) {
    const next = new Date(now);
    const currentMinutes = next.getUTCMinutes();
    const nextMinuteSlot = Math.ceil((currentMinutes + 1) / everyMinutes) * everyMinutes;
    next.setUTCSeconds(0, 0);
    if (nextMinuteSlot >= 60) {
      next.setUTCHours(next.getUTCHours() + 1, 0, 0, 0);
    } else {
      next.setUTCMinutes(nextMinuteSlot, 0, 0);
    }
    return next;
  }

  const everyHours = parseHourlyFrequency(dailyTime);
  if (everyHours) {
    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0);
    const currentHour = now.getUTCHours();
    const alignedHour = Math.floor(currentHour / everyHours) * everyHours;
    next.setUTCHours(alignedHour, 0, 0, 0);
    if (next <= now) {
      next.setUTCHours(next.getUTCHours() + everyHours, 0, 0, 0);
    }
    return next;
  }

  const { hour, minute } = parseDailyTime(dailyTime);
  const normalizedTimeZone = normalizeTimeZone(timezone);
  const nowZoned = getZonedDateParts(now, normalizedTimeZone);
  const shouldRunTomorrow =
    nowZoned.hour > hour || (nowZoned.hour === hour && nowZoned.minute >= minute);
  const targetDateParts = shouldRunTomorrow
    ? addDaysToDateParts(nowZoned, 1)
    : {
        year: nowZoned.year,
        month: nowZoned.month,
        day: nowZoned.day,
      };
  let next = zonedDateTimeToUtc({
    ...targetDateParts,
    hour,
    minute,
    timezone: normalizedTimeZone,
  });
  if (next <= now) {
    const tomorrow = addDaysToDateParts(targetDateParts, 1);
    next = zonedDateTimeToUtc({
      ...tomorrow,
      hour,
      minute,
      timezone: normalizedTimeZone,
    });
  }
  return next;
}

export function toSyncPreferences(record: SyncConfigurationRecord): SyncPreferences {
  return {
    searchMode: record.searchMode,
    searchMetafieldNamespace: record.searchMetafieldNamespace,
    searchMetafieldKey: record.searchMetafieldKey,
    useCustomScryfallIdField: record.useCustomScryfallIdField,
    allowProductLevelCustomScryfallFallback:
      record.allowProductLevelCustomScryfallFallback,
    customScryfallIdNs: record.customScryfallIdNs,
    customScryfallIdKey: record.customScryfallIdKey,
    priceSource: record.priceSource,
    justTcgApiKey: record.justTcgApiKey,
    mtgjsonApiKey: record.mtgjsonApiKey,
    displayCurrency: record.displayCurrency,
    priceAdjustmentMode: record.priceAdjustmentMode,
    priceAdjustmentPercent: record.priceAdjustmentPercent,
    priceAdjustmentFixed: record.priceAdjustmentFixed,
    minimumPrice: record.minimumPrice,
    disableSuspiciousPriceAlert: record.disableSuspiciousPriceAlert,
    suspiciousPriceAlertThresholdPercent: record.suspiciousPriceAlertThresholdPercent,
    scryfallMetafieldNs: record.scryfallMetafieldNs,
    scryfallMetafieldKey: record.scryfallMetafieldKey,
    syncImage: record.syncImage,
    metadataInitialized: record.metadataInitialized,
    imageSyncInitialized: record.imageSyncInitialized,
  };
}

export async function getOrCreateSyncConfiguration(
  shop: string,
): Promise<SyncConfigurationRecord> {
  const existing = await db.syncConfiguration.findUnique({ where: { shop } });
  if (existing) {
    return existing as SyncConfigurationRecord;
  }

  const created = await db.syncConfiguration.create({
    data: {
      shop,
      ...DEFAULT_CONFIG,
    },
  });
  return created as SyncConfigurationRecord;
}

export async function updateSyncConfiguration(
  shop: string,
  data: Partial<SyncConfigurationRecord>,
): Promise<SyncConfigurationRecord> {
  const merged = { ...data } as Partial<SyncConfigurationRecord>;
  const timezone = merged.timezone ?? DEFAULT_CONFIG.timezone;

  if (typeof merged.dailyTime === "string" && merged.enabled !== false) {
    merged.nextRunAt = computeNextRunAt(merged.dailyTime, timezone);
  }

  if (merged.enabled === false) {
    merged.nextRunAt = null;
  }

  const updated = await db.syncConfiguration.upsert({
    where: { shop },
    create: {
      shop,
      ...DEFAULT_CONFIG,
      ...merged,
    },
    update: merged,
  });

  return updated as SyncConfigurationRecord;
}

export async function markSyncRun(params: {
  shop: string;
  success: boolean;
  message?: string;
  summary?: SyncRunResult;
}) {
  const current = await getOrCreateSyncConfiguration(params.shop);
  const nextRunAt = current.enabled
    ? computeNextRunAt(current.dailyTime, current.timezone)
    : null;
  const summaryData = params.summary
    ? {
        lastScheduledVariantsScanned: params.summary.variantsScanned,
        lastScheduledCardsMatched: params.summary.cardsMatched,
        lastScheduledPricesUpdated: params.summary.pricesUpdated,
        lastScheduledMetafieldsUpdated: params.summary.metafieldsUpdated,
        lastScheduledImagesUpdated: params.summary.imagesUpdated,
        lastScheduledSkippedForMissingPrice: params.summary.skippedForMissingPrice,
        lastScheduledPreviousPricesStored: params.summary.previousPricesStored,
        lastScheduledFailures: params.summary.failures.length,
      }
    : {};

  await db.syncConfiguration.update({
    where: { shop: params.shop },
    data: {
      lastRunAt: new Date(),
      lastRunStatus: params.success ? "success" : "failed",
      lastError: params.success ? null : params.message ?? "Unknown error",
      nextRunAt,
      currentScheduledStatus: params.success ? "success" : "failed",
      currentScheduledUpdatedAt: new Date(),
      currentScheduledPricesUpdated: params.summary?.pricesUpdated ?? undefined,
      currentScheduledFailures: params.summary?.failures.length ?? undefined,
      currentScheduledSuspiciousCount: params.summary?.suspiciousCount ?? undefined,
      currentScheduledSkippedForMissingPrice:
        params.summary?.skippedForMissingPrice ?? undefined,
      ...summaryData,
    },
  });
}
