import { i18n } from "../utils/i18n";

export type SyncHistoryCsvRow = {
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
    previousPriceBackup?: string | null;
    appliedPrice?: string | null;
    status: string;
    reason: string | null;
  };
};

type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
) => Promise<Response>;

type AppLanguage = keyof typeof i18n;
type Translation = (typeof i18n)[AppLanguage];

function escapeCsvValue(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (!/[",\r\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function localizeHistoryRunKind(value: string, t: Translation): string {
  switch (value) {
    case "scheduled":
      return t.syncHistoryRunKindScheduled;
    case "manual":
      return t.syncHistoryRunKindManual;
    case "test":
      return t.syncHistoryRunKindTest;
    default:
      return value;
  }
}

function localizeHistoryRunStatus(value: string, t: Translation): string {
  switch (value) {
    case "running":
      return t.syncHistoryStatusRunning;
    case "success":
      return t.syncHistoryStatusSuccess;
    case "failed":
      return t.syncHistoryStatusFailed;
    default:
      return value;
  }
}

function localizeCsvRowRunStatus(params: {
  runStatus: string;
  itemStatus: string;
  itemReason: string | null;
  t: Translation;
}): string {
  const normalizedReason = params.itemReason?.trim() ?? "";
  if (
    params.runStatus === "failed" &&
    params.itemStatus === "unchanged" &&
    /^Price already up to date$/i.test(normalizedReason)
  ) {
    return params.t.syncHistoryItemStatusUnchanged;
  }

  return localizeHistoryRunStatus(params.runStatus, params.t);
}

function localizeHistoryItemStatus(value: string, t: Translation): string {
  switch (value) {
    case "updated":
      return t.syncHistoryItemStatusUpdated;
    case "unchanged":
      return t.syncHistoryItemStatusUnchanged;
    case "failed":
    case "skipped":
      return t.syncHistoryItemStatusFailed;
    case "suspicious":
      return t.syncHistoryItemStatusSuspicious;
    default:
      return t.syncHistoryItemStatusFailed;
  }
}

function classifyHistoryRow(params: {
  status: string;
  reason: string | null;
  previousPrice: string | null;
  appliedPrice: string | null;
  t: Translation;
}): { foundInScryfall: string; suspicious: string; itemStatus: string } {
  const normalizedReason = params.reason?.trim() ?? "";
  const isNotFound = params.status === "skipped" && /^No Scryfall match$/i.test(normalizedReason);
  const hasDetectedPriceChange =
    params.status === "unchanged" &&
    Boolean(params.previousPrice) &&
    Boolean(params.appliedPrice) &&
    params.previousPrice !== params.appliedPrice;

  if (isNotFound) {
    return {
      foundInScryfall: params.t.no,
      suspicious: params.t.no,
      itemStatus: params.t.syncHistoryItemStatusNotFound,
    };
  }

  if (params.status === "suspicious") {
    return {
      foundInScryfall: params.t.yes,
      suspicious: params.t.yes,
      itemStatus: params.t.syncHistoryItemStatusSuspicious,
    };
  }

  if (params.status === "updated") {
    return {
      foundInScryfall: params.t.yes,
      suspicious: params.t.no,
      itemStatus: params.t.syncHistoryItemStatusUpdated,
    };
  }

  if (hasDetectedPriceChange) {
    return {
      foundInScryfall: params.t.yes,
      suspicious: params.t.no,
      itemStatus: params.t.syncHistoryItemStatusUpdated,
    };
  }

  if (params.status === "unchanged") {
    return {
      foundInScryfall: params.t.yes,
      suspicious: params.t.no,
      itemStatus: params.t.syncHistoryItemStatusUnchanged,
    };
  }

  if (params.status === "failed") {
    return {
      foundInScryfall: params.t.yes,
      suspicious: params.t.no,
      itemStatus: params.t.syncHistoryItemStatusFailed,
    };
  }

  return {
    foundInScryfall: params.t.yes,
    suspicious: params.t.no,
    itemStatus: localizeHistoryItemStatus(params.status, params.t),
  };
}

function localizeHistoryReason(reason: string | null, lang: AppLanguage): string {
  const normalized = reason?.trim() ?? "";
  if (!normalized) {
    return "";
  }

  if (/^No Scryfall match$/i.test(normalized)) {
    return lang === "es" ? "Sin coincidencia en Scryfall" : "No Scryfall match";
  }
  if (/^Price already up to date$/i.test(normalized)) {
    return lang === "es" ? "El precio ya estaba actualizado" : "Price already up to date";
  }
  if (/Missing Scryfall card payload/i.test(normalized)) {
    return lang === "es"
      ? "Falta la respuesta de carta de Scryfall para resolver el precio"
      : "Missing Scryfall card payload for price resolution";
  }
  if (/Missing Scryfall ID for JustTCG/i.test(normalized)) {
    return lang === "es"
      ? "Falta Scryfall ID para consultar JustTCG"
      : "Missing Scryfall ID for JustTCG lookup";
  }
  if (/JustTCG has no price/i.test(normalized)) {
    return lang === "es"
      ? "JustTCG no tiene precio para ese ID externo"
      : "JustTCG has no price for that external ID";
  }
  if (/Card Kingdom has no cached entry/i.test(normalized)) {
    return lang === "es"
      ? "Card Kingdom no tiene entrada cacheada para este Scryfall ID"
      : "Card Kingdom has no cached entry for this Scryfall ID";
  }
  if (/Card Kingdom has no foil USD price/i.test(normalized)) {
    return lang === "es"
      ? "Card Kingdom no tiene precio USD foil para esta carta"
      : "Card Kingdom has no foil USD price for this card";
  }
  if (/Card Kingdom has no nonfoil USD price/i.test(normalized)) {
    return lang === "es"
      ? "Card Kingdom no tiene precio USD nonfoil para esta carta"
      : "Card Kingdom has no nonfoil USD price for this card";
  }
  if (/Card Kingdom foil USD price is invalid/i.test(normalized)) {
    return lang === "es"
      ? "El precio USD foil de Card Kingdom no es valido"
      : "Card Kingdom foil USD price is invalid";
  }
  if (/Card Kingdom nonfoil USD price is invalid/i.test(normalized)) {
    return lang === "es"
      ? "El precio USD nonfoil de Card Kingdom no es valido"
      : "Card Kingdom nonfoil USD price is invalid";
  }
  if (/Missing Scryfall ID for MTGJSON/i.test(normalized)) {
    return lang === "es"
      ? "Falta Scryfall ID para consultar MTGJSON"
      : "Missing Scryfall ID for MTGJSON lookup";
  }
  if (/MTGJSON has no USD price/i.test(normalized)) {
    return lang === "es"
      ? "MTGJSON no tiene precio USD para esta carta"
      : "MTGJSON has no USD price for this card";
  }
  if (/Scryfall has no usd_foil or usd price/i.test(normalized)) {
    return lang === "es"
      ? "Scryfall no tiene precio usd_foil ni usd"
      : "Scryfall has no usd_foil or usd price";
  }
  if (/Scryfall has no USD price/i.test(normalized)) {
    return lang === "es" ? "Scryfall no tiene precio USD" : "Scryfall has no USD price";
  }
  if (/Price could not be resolved after conversion/i.test(normalized)) {
    return lang === "es"
      ? "No se pudo resolver el precio tras conversion y ajustes configurados"
      : "Price could not be resolved after conversion and configured adjustments";
  }
  if (/offline session/i.test(normalized)) {
    return lang === "es" ? "No hay sesion offline disponible" : "No offline session available";
  }
  if (/timed out/i.test(normalized)) {
    return lang === "es" ? "La operacion excedio el tiempo de espera" : normalized;
  }
  if (/rate limit|429/i.test(normalized)) {
    return lang === "es" ? "Limite de tasa alcanzado" : normalized;
  }
  const suspiciousVariationMatch = /^Suspicious price variation above ([0-9]+(?:\.[0-9]+)?)%$/i.exec(
    normalized,
  );
  if (suspiciousVariationMatch) {
    const threshold = suspiciousVariationMatch[1];
    return lang === "es"
      ? `Variacion de precio sospechosa superior al ${threshold}%`
      : `Suspicious price variation above ${threshold}%`;
  }

  return normalized;
}

export function buildSyncHistoryCsv(params: {
  lang: AppLanguage;
  rows: SyncHistoryCsvRow[];
}): string {
  const t = i18n[params.lang];
  const header = [
    t.syncHistoryCsvRunId,
    t.syncHistoryCsvRunKind,
    t.syncHistoryCsvRunStatus,
    t.syncHistoryCsvStartedAt,
    t.syncHistoryCsvFinishedAt,
    t.syncHistoryCsvProductId,
    t.syncHistoryCsvProductTitle,
    t.syncHistoryCsvSku,
    t.syncHistoryCsvMeta,
    t.syncHistoryCsvCurrentPrice,
    t.syncHistoryCsvNewPrice,
    t.syncHistoryCsvPreviousPrice,
    t.syncHistoryCsvAppliedPrice,
    t.syncHistoryCsvFoundInScryfall,
    t.syncHistoryCsvSuspicious,
    t.syncHistoryCsvItemStatus,
    t.syncHistoryCsvItemReason,
  ];

  const lines = params.rows.map((row) => {
    const itemReason = row.item.reason?.trim() ? row.item.reason : null;
    const rowReason = itemReason ?? (row.item.status === "failed" ? row.message : null);
    const previousPrice = row.item.previousPriceBackup ?? row.item.currentPrice ?? "";
    const appliedPrice = row.item.appliedPrice ?? row.item.newPrice ?? row.item.currentPrice ?? "";
    const classification = classifyHistoryRow({
      status: row.item.status,
      reason: rowReason,
      previousPrice,
      appliedPrice,
      t,
    });

    return [
      row.id,
      localizeHistoryRunKind(row.runKind, t),
      localizeCsvRowRunStatus({
        runStatus: row.status,
        itemStatus: row.item.status,
        itemReason: row.item.reason,
        t,
      }),
      row.startedAt.toISOString(),
      row.finishedAt?.toISOString() ?? "",
      row.item.productId,
      row.item.productTitle ?? "",
      row.item.sku ?? "",
      row.item.metaValue ?? "",
      row.item.currentPrice ?? "",
      row.item.newPrice ?? "",
      previousPrice,
      appliedPrice,
      classification.foundInScryfall,
      classification.suspicious,
      classification.itemStatus,
      localizeHistoryReason(rowReason, params.lang),
    ];
  });

  return [header, ...lines]
    .map((line) => line.map((value) => escapeCsvValue(value)).join(","))
    .join("\r\n");
}

function normalizePriceValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : normalized;
}

export async function enrichSyncHistoryCsvRowsWithShopifyPrices(params: {
  adminGraphql: AdminGraphql;
  rows: SyncHistoryCsvRow[];
}): Promise<SyncHistoryCsvRow[]> {
  const variantIds = Array.from(
    new Set(
      params.rows
        .map((row) => row.item.variantId)
        .filter((id) => id.startsWith("gid://shopify/ProductVariant/")),
    ),
  );
  if (variantIds.length === 0) {
    return params.rows;
  }

  const previousByVariantId = new Map<string, string | null>();
  const previousByProductId = new Map<string, string | null>();
  const currentByVariantId = new Map<string, string | null>();

  try {
    for (let index = 0; index < variantIds.length; index += 100) {
      const ids = variantIds.slice(index, index + 100);
      const response = await params.adminGraphql(
        `#graphql
          query SyncHistoryPreviousPrices($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on ProductVariant {
                id
                price
                previousPrice: metafield(namespace: "custom", key: "previous_price") {
                  value
                }
                product {
                  id
                  previousPrice: metafield(namespace: "custom", key: "previous_price") {
                    value
                  }
                }
              }
            }
          }
        `,
        { variables: { ids } },
      );
      const json = (await response.json()) as {
        data?: {
          nodes?: Array<{
            id?: string;
            price?: string | null;
            previousPrice?: { value?: string | null } | null;
            product?: {
              id?: string;
              previousPrice?: { value?: string | null } | null;
            } | null;
          } | null>;
        };
      };

      for (const node of json.data?.nodes ?? []) {
        if (!node?.id) {
          continue;
        }
        previousByVariantId.set(node.id, normalizePriceValue(node.previousPrice?.value));
        currentByVariantId.set(node.id, normalizePriceValue(node.price));
        if (node.product?.id) {
          previousByProductId.set(
            node.product.id,
            normalizePriceValue(node.product.previousPrice?.value),
          );
        }
      }
    }
  } catch {
    return params.rows;
  }

  return params.rows.map((row) => {
    const previousPriceBackup =
      previousByVariantId.get(row.item.variantId) ??
      previousByProductId.get(row.item.productId) ??
      row.item.currentPrice;
    const appliedPrice =
      currentByVariantId.get(row.item.variantId) ??
      row.item.newPrice ??
      row.item.currentPrice;

    return {
      ...row,
      item: {
        ...row.item,
        previousPriceBackup,
        appliedPrice,
      },
    };
  });
}
