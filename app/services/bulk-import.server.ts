import * as XLSX from "xlsx";
import { mapScryfallCard, SCRYFALL_API } from "./set-importer.server";
import type { ScryfallCardInfo, ScryfallCardJson } from "./set-importer.server";

export type CardSelection = {
  scryfallId: string;
  foil: boolean;
  stock: number;
};

export type ExportGroup = {
  setCode: string;
  cardSelections: CardSelection[];
};

const SCRYFALL_MIN_INTERVAL = 100;
const SCRYFALL_MAX_RETRIES = 3;
let lastScryfallCall = 0;

async function scryfallFetch(path: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastScryfallCall;
  if (elapsed < SCRYFALL_MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, SCRYFALL_MIN_INTERVAL - elapsed));
  }
  lastScryfallCall = Date.now();

  for (let attempt = 0; attempt <= SCRYFALL_MAX_RETRIES; attempt += 1) {
    const response = await fetch(`${SCRYFALL_API}${path}`, {
      headers: { "User-Agent": "magic-pricer-singles/1.0" },
    });
    if (response.ok) {
      return response;
    }
    // Retry on throttling / server errors with backoff.
    if (response.status === 429 || response.status >= 500) {
      const retryAfterRaw = Number(response.headers.get("retry-after") ?? "");
      const retryAfterMs =
        Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
          ? retryAfterRaw * 1000
          : Math.min(500 * (attempt + 1), 10_000);
      await new Promise((r) => setTimeout(r, retryAfterMs));
      continue;
    }
    return response;
  }
  // Give up after retries; caller decides how to handle.
  const last = await fetch(`${SCRYFALL_API}${path}`, {
    headers: { "User-Agent": "magic-pricer-singles/1.0" },
  }).catch(() => null);
  return last ?? new Response(null, { status: 500 });
}

/**
 * Build the Scryfall search query for a set, optionally restricted to languages.
 * Scryfall treats `+` differently (returns English), so we must use a real space
 * as the AND operator. Multiple languages use: `<set> (lang:es OR lang:ja)`.
 */
function buildSetQuery(setCode: string, langs: string[]): string {
  const base = `set:${setCode}`;
  if (!langs || langs.length === 0) {
    // No language filter -> all languages.
    return `${base} lang:*`;
  }
  if (langs.length === 1) {
    return `${base} lang:${langs[0]}`;
  }
  const or = langs.map((l) => `lang:${l}`).join(" OR ");
  return `${base} (${or})`;
}

/** Fetch every printable card for a set (optionally limited to given languages). */
export async function fetchAllCards(setCode: string, langs?: string[]): Promise<ScryfallCardInfo[]> {
  const cards: ScryfallCardInfo[] = [];
  const q = buildSetQuery(setCode, langs ?? []);
  let url = `/cards/search?q=${encodeURIComponent(q)}&order=set&unique=prints`;
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

const CATALOG_HEADER = [
  "set_code",
  "scryfall_id",
  "nombre",
  "nº colección",
  "raridad",
  "idioma",
  "edición",
  "acabado",
  "imagen_url",
  "cantidad",
  "INCLUIR",
];

const LANG_NAME: Record<string, string> = {
  en: "Inglés",
  es: "Español",
  fr: "Francés",
  de: "Alemán",
  it: "Italiano",
  pt: "Portugués",
  ja: "Japonés",
  ko: "Coreano",
  ru: "Ruso",
  zh: "Chino",
  zhs: "Chino (simplificado)",
  zht: "Chino (tradicional)",
  he: "Hebreo",
  la: "Latín",
  sa: "Sánscrito",
  ar: "Árabe",
  grc: "Griego",
  ph: "Filo (Phyrexian)",
  dw: "Enano (Dwarvish)",
};

function langName(code: string): string {
  return LANG_NAME[code] || code;
}

const CATALOG_COLS = [
  { wch: 10 },
  { wch: 36 },
  { wch: 40 },
  { wch: 12 },
  { wch: 12 },
  { wch: 10 },
  { wch: 40 },
  { wch: 10 },
  { wch: 60 },
  { wch: 10 },
  { wch: 10 },
];

function sheetNameForSet(setCode: string, used: Set<string>): string {
  let name = setCode.toUpperCase();
  if (name.length > 28) name = name.slice(0, 28);
  let candidate = name;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${name}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

/** Assemble an Excel catalog buffer. One sheet per edition (set). */
export function buildCatalogBuffer(cards: ScryfallCardInfo[]): Buffer {
  const grouped = new Map<string, ScryfallCardInfo[]>();
  for (const c of cards) {
    const set = grouped.get(c.setCode) ?? [];
    set.push(c);
    grouped.set(c.setCode, set);
  }

  const wb = XLSX.utils.book_new();
  const usedNames = new Set<string>();
  for (const [setCode, setCards] of grouped) {
    const rows: Array<Array<string>> = [CATALOG_HEADER];
    for (const c of setCards) {
      const finished = c.finishes?.length ? c.finishes : [];
      const emit = finished.length > 0 ? finished : ["nonfoil"];
      for (const finish of emit) {
        rows.push([
          c.setCode,
          c.id,
          c.name,
          c.collectorNumber,
          c.rarity,
          langName(c.lang),
          c.set_name,
          finish === "foil" ? "foil" : "no-foil",
          c.imageUrl || "",
          "",
          "",
        ]);
      }
    }
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = CATALOG_COLS;
    XLSX.utils.book_append_sheet(wb, ws, sheetNameForSet(setCode, usedNames));
  }

  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/**
 * Parse an uploaded Excel and return the selected (marked) cards grouped by set.
 * Iterates over every sheet (one per edition). Selection is driven by the
 * "INCLUIR" column: a row is included when it is non-empty and not a "no" value
 * (0 / no / falso / false). The finish is taken from the "acabado" column
 * (no-foil / foil). When the column is missing, foil is inferred as false.
 */
export function parseImportBuffer(buffer: ArrayBuffer): ExportGroup[] {
  const wb = XLSX.read(buffer, { type: "array" });
  const grouped = new Map<string, ExportGroup>();

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as Array<Array<unknown>>;
    if (!rows || rows.length < 2) {
      continue;
    }

    const header = rows[0].map((h) => String(h ?? "").trim().toLowerCase());
    const setCol = header.indexOf("set_code");
    const idCol = header.indexOf("scryfall_id");
    const finishCol = header.indexOf("acabado");
    const includeCol = header.indexOf("incluir");
    const stockCol = header.indexOf("cantidad");

    if (setCol < 0 || idCol < 0) {
      throw new Error("El Excel debe tener las columnas set_code y scryfall_id.");
    }

    const isMarked = (value: unknown): boolean => {
      if (includeCol < 0) return true;
      const v = String(value ?? "").trim().toLowerCase();
      return v !== "" && v !== "0" && v !== "no" && v !== "falso" && v !== "false";
    };
    const parseFoil = (value: unknown): boolean => {
      if (finishCol < 0) return false;
      const v = String(value ?? "").trim().toLowerCase();
      return v === "foil" || v === "si" || v === "sí" || v === "true" || v === "1";
    };
    const parseStock = (value: unknown): number => {
      if (stockCol < 0) return 0;
      const n = Number(String(value ?? "").trim());
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    };

    for (const row of rows.slice(1)) {
      if (!row || row.length === 0) continue;
      const setCode = String(row[setCol] ?? "").trim();
      const cardId = String(row[idCol] ?? "").trim();
      if (!setCode || !cardId) continue;
      if (!isMarked(row[includeCol])) continue;

      const group = grouped.get(setCode) ?? { setCode, cardSelections: [] };
      group.cardSelections.push({ scryfallId: cardId, foil: parseFoil(row[finishCol]), stock: parseStock(row[stockCol]) });
      grouped.set(setCode, group);
    }
  }

  return Array.from(grouped.values());
}
