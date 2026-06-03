import type { LoaderFunctionArgs } from "@remix-run/node";
import {
  buildSyncHistoryCsv,
  enrichSyncHistoryCsvRowsWithShopifyPrices,
} from "../services/sync-history-csv.server";
import { listSyncRunHistoryItemsForRun } from "../services/sync-run-history.server";
import { authenticate } from "../shopify.server";
import { detectLanguage, normalizeAppLanguage } from "../utils/i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const lang =
    normalizeAppLanguage(url.searchParams.get("lang")) ??
    normalizeAppLanguage(url.searchParams.get("shopLocale")) ??
    detectLanguage(request);
  const runId = url.searchParams.get("runId")?.trim() ?? "";
  const rows = runId
    ? await listSyncRunHistoryItemsForRun({ shop: session.shop, runId })
    : [];
  const enrichedRows = await enrichSyncHistoryCsvRowsWithShopifyPrices({
    adminGraphql: admin.graphql,
    rows,
  });
  const csv = buildSyncHistoryCsv({ lang, rows: enrichedRows });
  const fileSuffix = runId || new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

  return new Response(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sync-history-${fileSuffix}.csv"`,
      "Cache-Control": "no-store",
    },
  });
};
