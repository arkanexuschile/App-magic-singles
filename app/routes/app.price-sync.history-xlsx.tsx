import type { LoaderFunctionArgs } from "@remix-run/node";
import { getOrCreateSyncConfiguration } from "../services/sync-config.server";
import { enrichSyncHistoryCsvRowsWithShopifyPrices } from "../services/sync-history-csv.server";
import { buildSyncHistoryXlsx } from "../services/sync-history-xlsx.server";
import { listSyncRunHistoryItemsForRun } from "../services/sync-run-history.server";
import { authenticate } from "../shopify.server";
import { detectLanguage, i18n, normalizeAppLanguage } from "../utils/i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const lang =
    normalizeAppLanguage(url.searchParams.get("lang")) ??
    normalizeAppLanguage(url.searchParams.get("shopLocale")) ??
    detectLanguage(request);
  const t = i18n[lang];
  const runId = url.searchParams.get("runId")?.trim() ?? "";
  const rows = runId
    ? await listSyncRunHistoryItemsForRun({ shop: session.shop, runId, includeTestKinds: true })
    : [];
  const enrichedRows = await enrichSyncHistoryCsvRowsWithShopifyPrices({
    adminGraphql: admin.graphql,
    rows,
  });
  const config = await getOrCreateSyncConfiguration(session.shop);
  const priceSourceLabel =
    config.priceSource === "cardkingdom"
      ? t.priceCardkingdom
      : config.priceSource === "justtcg"
        ? t.priceJusttcg
        : config.priceSource === "mtgjson"
          ? t.priceMtgjson
          : t.priceScryfall;
  const buffer = buildSyncHistoryXlsx({
    lang,
    shop: session.shop,
    priceSourceLabel,
    displayCurrency: config.displayCurrency,
    rows: enrichedRows,
  });
  const fileSuffix = runId || new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  return new Response(new Uint8Array(buffer), {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="sync-history-${fileSuffix}.xlsx"`,
      "Cache-Control": "no-store",
    },
  });
};
