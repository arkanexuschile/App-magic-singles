import * as XLSX from "xlsx";
import { i18n } from "../utils/i18n";
import {
  classifyHistoryRow,
  localizeHistoryReason,
  localizeHistoryRunKind,
  type SyncHistoryCsvRow,
} from "./sync-history-csv.server";

type AppLanguage = keyof typeof i18n;
type Translation = (typeof i18n)[AppLanguage];

type CellValue = string | number | { t: "n"; v: number; z: string };

function parsePriceNumber(value: string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const normalized = String(value).trim().replace(/\s+/g, "").replace(",", ".");
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatUtc(date: Date | null): string {
  if (!date) {
    return "";
  }
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

function priceCell(
  value: string | null | undefined,
  numberFormat: string,
): CellValue {
  const parsed = parsePriceNumber(value);
  return parsed == null ? "" : { t: "n", v: parsed, z: numberFormat };
}

function variationCell(previous: number | null, applied: number | null): CellValue {
  if (previous == null || applied == null || previous === 0) {
    return "";
  }
  return { t: "n", v: (applied - previous) / previous, z: "0.0%" };
}

export function buildSyncHistoryXlsx(params: {
  lang: AppLanguage;
  shop: string;
  priceSourceLabel: string;
  displayCurrency: string;
  rows: SyncHistoryCsvRow[];
}): Buffer {
  const t: Translation = i18n[params.lang];
  const first = params.rows[0] ?? null;
  const currency = params.displayCurrency.trim().toUpperCase() || "CLP";
  const priceFormat = currency === "USD" ? "#,##0.00" : "#,##0";

  let updatedCount = 0;
  let suspiciousCount = 0;
  let skippedCount = 0;

  const header: CellValue[][] = [
    [t.xlsxMetaShop, params.shop],
    [t.xlsxMetaRunType, first ? localizeHistoryRunKind(first.runKind, t) : ""],
    [t.xlsxMetaStarted, first ? formatUtc(first.startedAt) : ""],
    [t.xlsxMetaFinished, first?.finishedAt ? formatUtc(first.finishedAt) : ""],
    [t.xlsxMetaSource, params.priceSourceLabel],
    [t.xlsxMetaCurrency, currency],
  ];

  const tableHeader: CellValue[] = [
    t.xlsxColProduct,
    t.xlsxColVariant,
    t.xlsxColSku,
    t.xlsxColPreviousPrice,
    t.xlsxColNewPrice,
    t.xlsxColVariation,
    t.xlsxColStatus,
    t.xlsxColReason,
  ];

  const tableRows: CellValue[][] = params.rows.map((row) => {
    const itemReason = row.item.reason?.trim() ? row.item.reason : null;
    const rowReason = itemReason ?? (row.item.status === "failed" ? row.message : null);
    const previousPrice = row.item.previousPriceBackup ?? row.item.currentPrice ?? "";
    const classification = classifyHistoryRow({
      status: row.item.status,
      reason: rowReason,
      previousPrice,
      appliedPrice: row.item.appliedPrice ?? row.item.newPrice ?? row.item.currentPrice ?? "",
      t,
    });
    if (row.item.status === "updated") {
      updatedCount += 1;
    } else if (row.item.status === "suspicious") {
      suspiciousCount += 1;
    } else if (row.item.status === "skipped") {
      skippedCount += 1;
    }

    const itemStatus =
      row.item.status === "skipped" &&
      !/^No Scryfall match$/i.test((rowReason ?? "").trim())
        ? t.syncHistoryItemStatusSkipped
        : classification.itemStatus;
    // Show the resolved target only: updated/unchanged/suspicious always carry
    // newPrice; skipped/failed without a target stay blank instead of echoing
    // the current price like the legacy CSV does.
    const newPrice = row.item.newPrice?.trim() ? row.item.newPrice : null;
    const previousNumber = parsePriceNumber(previousPrice);
    const newNumber = parsePriceNumber(newPrice);
    return [
      row.item.productTitle ?? "",
      row.item.variantTitle ?? "",
      row.item.sku ?? "",
      priceCell(previousPrice, priceFormat),
      priceCell(newPrice, priceFormat),
      variationCell(previousNumber, newNumber),
      itemStatus,
      localizeHistoryReason(rowReason, params.lang),
    ];
  });

  const aoa: CellValue[][] = [
    ...header,
    [t.xlsxMetaVariants, params.rows.length],
    [t.xlsxMetaUpdated, updatedCount],
    [t.xlsxMetaSuspicious, suspiciousCount],
    [t.xlsxMetaSkipped, skippedCount],
    [],
    tableHeader,
    ...tableRows,
  ];

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [
    { wch: 42 },
    { wch: 30 },
    { wch: 18 },
    { wch: 16 },
    { wch: 16 },
    { wch: 12 },
    { wch: 16 },
    { wch: 64 },
  ];
  const firstTableRow = header.length + 6;
  const lastTableRow = firstTableRow + tableRows.length;
  // aoa_to_sheet keeps t/v from cell objects but drops the number format, so
  // apply it explicitly on the price and variation columns (D/E/F).
  for (let r = firstTableRow + 1; r <= lastTableRow; r += 1) {
    for (const [col, format] of [
      ["D", priceFormat],
      ["E", priceFormat],
      ["F", "0.0%"],
    ] as Array<[string, string]>) {
      const addr = `${col}${r}`;
      const cell = ws[addr] as { t?: string; z?: string } | undefined;
      if (cell && cell.t === "n") {
        cell.z = format;
      }
    }
  }
  ws["!autofilter"] = { ref: `A${firstTableRow}:H${lastTableRow}` };

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, t.xlsxSheetName);
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}
