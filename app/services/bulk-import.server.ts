import * as XLSX from "xlsx";
import { mapScryfallCard, SCRYFALL_API } from "./set-importer.server";
import type { ScryfallCardInfo, ScryfallCardJson } from "./set-importer.server";

export type ExportGroup = {
  setCode: string;
  cardIds: string[];
};

const SCRYFALL_MIN_INTERVAL = 100;
let lastScryfallCall = 0;

async function scryfallFetch(path: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastScryfallCall;
  if (elapsed < SCRYFALL_MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, SCRYFALL_MIN_INTERVAL - elapsed));
  }
  lastScryfallCall = Date.now();
  return fetch(`${SCRYFALL_API}${path}`, {
    headers: { "User-Agent": "magic-pricer-singles/1.0" },
  });
}

/** Fetch every printable card for a set across all languages. */
export async function fetchAllCards(setCode: string): Promise<ScryfallCardInfo[]> {
  const cards: ScryfallCardInfo[] = [];
  let url = `/cards/search?q=set:${encodeURIComponent(setCode)}&order=set&unique=prints`;
  while (url) {
    const response = await scryfallFetch(url);
    if (!response.ok) {
      throw new Error(`Scryfall ${response.status} for set ${setCode}`);
    }
    const json = (await response.json()) as {
      data: ScryfallCardJson[];
      has_more: boolean;
      next_page?: string;
    };
    for (const card of json.data) {
      if (card.layout === "art_series") continue;
      cards.push(mapScryfallCard(card));
    }
    url = json.has_more && json.next_page ? json.next_page.replace(SCRYFALL_API, "") : "";
  }
  return cards;
}

/** Assemble an Excel catalog buffer from the given cards. */
export function buildCatalogBuffer(cards: ScryfallCardInfo[]): Buffer {
  const header = [
    "set_code",
    "scryfall_id",
    "nombre",
    "nº colección",
    "raridad",
    "idioma",
    "edición",
    "imagen_url",
    "INCLUIR",
  ];
  const rows: Array<Array<string>> = [header];
  for (const c of cards) {
    rows.push([
      c.setCode,
      c.id,
      c.name,
      c.collectorNumber,
      c.rarity,
      c.lang,
      c.set_name,
      c.imageUrl || "",
      "",
    ]);
  }

  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws["!cols"] = [
    { wch: 10 },
    { wch: 36 },
    { wch: 40 },
    { wch: 12 },
    { wch: 12 },
    { wch: 10 },
    { wch: 40 },
    { wch: 60 },
    { wch: 10 },
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Catálogo");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * Parse an uploaded Excel and return the selected (marked) cards grouped by set.
 * Selection is driven by the "INCLUIR" column: a row is included when it is
 * non-empty and not a "no" value (0 / no / falso / false).
 */
export function parseImportBuffer(buffer: ArrayBuffer): ExportGroup[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as Array<Array<unknown>>;
  if (!rows || rows.length < 2) {
    return [];
  }

  const header = rows[0].map((h) => String(h ?? "").trim().toLowerCase());
  const setCol = header.indexOf("set_code");
  const idCol = header.indexOf("scryfall_id");
  const includeCol = header.indexOf("incluir");

  if (setCol < 0 || idCol < 0) {
    throw new Error("El Excel debe tener las columnas set_code y scryfall_id.");
  }

  const grouped = new Map<string, ExportGroup>();
  const isMarked = (value: unknown): boolean => {
    if (includeCol < 0) return true;
    const v = String(value ?? "").trim().toLowerCase();
    return v !== "" && v !== "0" && v !== "no" && v !== "falso" && v !== "false";
  };

  for (const row of rows.slice(1)) {
    if (!row || row.length === 0) continue;
    const setCode = String(row[setCol] ?? "").trim();
    const cardId = String(row[idCol] ?? "").trim();
    if (!setCode || !cardId) continue;
    if (!isMarked(row[includeCol])) continue;

    const group = grouped.get(setCode) ?? { setCode, cardIds: [] };
    group.cardIds.push(cardId);
    grouped.set(setCode, group);
  }

  return Array.from(grouped.values());
}
