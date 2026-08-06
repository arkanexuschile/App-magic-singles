import db from "../db.server";
import type { CardKingdomPriceEntry } from "./price-sync.server";

const SCRYFALL_API = "https://api.scryfall.com";
const SCRYFALL_MIN_INTERVAL = 100;
const SETS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

type ScryfallSetJson = {
  id: string;
  code: string;
  name: string;
  released_at: string;
  card_count: number;
  icon_svg_uri?: string;
  set_type: string;
  digital: boolean;
  parent_set_code?: string;
};

export type ScryfallSetInfo = {
  id: string;
  code: string;
  name: string;
  releasedAt: string;
  cardCount: number;
  iconUri?: string;
  setType: string;
  isDigital: boolean;
};

type ScryfallCardJson = {
  id: string;
  oracle_id?: string;
  name: string;
  set: string;
  set_name: string;
  collector_number: string;
  rarity: string;
  prices: { usd: string | null; usd_foil: string | null; eur?: string | null };
  image_uris?: { small: string; normal: string; large: string };
  card_faces?: Array<{ image_uris?: { small: string; normal: string; large: string }; name?: string }>;
  oracle_text?: string;
  type_line: string;
  mana_cost?: string;
  cmc?: number;
  finishes?: string[];
  colors?: string[];
  color_identity?: string[];
  keywords?: string[];
  lang: string;
  layout: string;
  artist?: string;
  power?: string;
  toughness?: string;
  frame?: string;
  full_art?: boolean;
  textless?: boolean;
  promo?: boolean;
  booster?: boolean;
  story_spotlight?: boolean;
  released_at?: string;
  legalities?: Record<string, string>;
};

export type ScryfallCardInfo = {
  id: string;
  oracleId: string;
  name: string;
  setCode: string;
  set_name: string;
  collectorNumber: string;
  rarity: string;
  usdPrice: number | null;
  usdFoilPrice: number | null;
  eurPrice: number | null;
  imageUrl?: string;
  oracleText?: string;
  typeLine: string;
  manaCost?: string;
  cmc: number | null;
  finishes: string[];
  colors: string[];
  colorIdentity: string[];
  keywords: string[];
  lang: string;
  artist: string | null;
  power: string | null;
  toughness: string | null;
  frame: string | null;
  fullArt: boolean;
  textless: boolean;
  promo: boolean;
  booster: boolean;
  storySpotlight: boolean;
  releasedAt: string | null;
  legalities: Record<string, string>;
  hasFoil: boolean;
  hasNonfoil: boolean;
};

export type ImportResult = {
  created: number;
  failed: number;
  skipped: number;
  errors: Array<{ card: string; error: string }>;
};

let lastScryfallCall = 0;

async function scryfallFetch(path: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastScryfallCall;
  if (elapsed < SCRYFALL_MIN_INTERVAL) {
    await new Promise((r) => setTimeout(r, SCRYFALL_MIN_INTERVAL - elapsed));
  }
  lastScryfallCall = Date.now();
  const response = await fetch(`${SCRYFALL_API}${path}`, {
    headers: { "User-Agent": "magic-pricer-singles/1.0" },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Scryfall API error ${response.status}: ${text.slice(0, 200)}`);
  }
  return response;
}

export async function listScryfallSets(): Promise<ScryfallSetInfo[]> {
  const cached = await db.setsCache.findUnique({ where: { key: "all_sets" } });
  if (cached && cached.expiresAt > new Date()) {
    const allSets = JSON.parse(cached.data) as ScryfallSetInfo[];
    const filtered = allSets.filter(
      (s) => s.setType !== "token" && s.setType !== "box" && s.setType !== "memorabilia",
    );
    return filtered.sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));
  }

  const response = await scryfallFetch("/sets");
  const json = (await response.json()) as {
    data: ScryfallSetJson[];
  };
  const sets = json.data
    .filter((s) => !s.digital && s.set_type !== "token" && s.set_type !== "box" && s.set_type !== "memorabilia")
    .map((s) => ({
      id: s.id,
      code: s.code,
      name: s.name,
      releasedAt: s.released_at,
      cardCount: s.card_count,
      iconUri: s.icon_svg_uri,
      setType: s.set_type,
      isDigital: s.digital,
    }))
    .sort((a, b) => b.releasedAt.localeCompare(a.releasedAt));

  const now = new Date();
  await db.setsCache.upsert({
    where: { key: "all_sets" },
    update: { data: JSON.stringify(sets), fetchedAt: now, expiresAt: new Date(now.getTime() + SETS_CACHE_TTL_MS) },
    create: { key: "all_sets", data: JSON.stringify(sets), fetchedAt: now, expiresAt: new Date(now.getTime() + SETS_CACHE_TTL_MS) },
  });

  return sets;
}

export async function searchScryfallSets(query: string): Promise<ScryfallSetInfo[]> {
  const all = await listScryfallSets();
  const q = query.toLowerCase();
  return all.filter(
    (s) =>
      s.code.toLowerCase().includes(q) ||
      s.name.toLowerCase().includes(q),
  ).slice(0, 20);
}

export async function getScryfallSet(code: string): Promise<ScryfallSetInfo | null> {
  try {
    const response = await scryfallFetch(`/sets/${code.toLowerCase()}`);
    const json = (await response.json()) as ScryfallSetJson;
    if (json.digital || json.set_type === "token" || json.set_type === "box" || json.set_type === "memorabilia") return null;
    return {
      id: json.id,
      code: json.code,
      name: json.name,
      releasedAt: json.released_at,
      cardCount: json.card_count,
      iconUri: json.icon_svg_uri,
      setType: json.set_type,
      isDigital: json.digital,
    };
  } catch {
    return null;
  }
}

export async function getSetCards(setCode: string): Promise<ScryfallCardInfo[]> {
  const cards: ScryfallCardInfo[] = [];
  let url = `/cards/search?q=set:${setCode}&order=set&unique=prints`;
  while (url) {
    const response = await scryfallFetch(url);
    const json = (await response.json()) as {
      data: ScryfallCardJson[];
      has_more: boolean;
      next_page?: string;
    };
    for (const card of json.data) {
      if (card.lang !== "en") continue;
      if (card.layout === "art_series") continue;
      cards.push(mapScryfallCard(card));
    }
    url = json.has_more && json.next_page
      ? json.next_page.replace(SCRYFALL_API, "")
      : "";
  }
  return cards;
}

function mapScryfallCard(card: ScryfallCardJson): ScryfallCardInfo {
  const imgUrl =
    card.image_uris?.large ||
    card.image_uris?.normal ||
    card.image_uris?.small ||
    card.card_faces?.[0]?.image_uris?.large ||
    card.card_faces?.[0]?.image_uris?.normal;
  const finishes = card.finishes ?? ["nonfoil"];
  return {
    id: card.id,
    oracleId: card.oracle_id ?? "",
    name: card.name,
    setCode: card.set,
    set_name: card.set_name,
    collectorNumber: card.collector_number,
    rarity: card.rarity,
    usdPrice: card.prices.usd ? parseFloat(card.prices.usd) : null,
    usdFoilPrice: card.prices.usd_foil ? parseFloat(card.prices.usd_foil) : null,
    eurPrice: card.prices.eur ? parseFloat(card.prices.eur) : null,
    imageUrl: imgUrl,
    oracleText: card.oracle_text,
    typeLine: card.type_line,
    manaCost: card.mana_cost,
    cmc: card.cmc ?? null,
    finishes,
    colors: card.colors ?? [],
    colorIdentity: card.color_identity ?? [],
    keywords: card.keywords ?? [],
    lang: card.lang,
    artist: card.artist ?? null,
    power: card.power ?? null,
    toughness: card.toughness ?? null,
    frame: card.frame ?? null,
    fullArt: Boolean(card.full_art),
    textless: Boolean(card.textless),
    promo: Boolean(card.promo),
    booster: Boolean(card.booster),
    storySpotlight: Boolean(card.story_spotlight),
    releasedAt: card.released_at ?? null,
    legalities: card.legalities ?? {},
    hasFoil: finishes.includes("foil") || finishes.includes("etched"),
    hasNonfoil: finishes.includes("nonfoil"),
  };
}

/**
 * Returns a page of cards for a set. Each page has at most ~175 cards (Scryfall max page size).
 */
export async function getSetCardsPage(setCode: string, pageUrl?: string): Promise<{
  cards: ScryfallCardInfo[];
  nextPage?: string;
  total: number;
}> {
  const url = pageUrl || `/cards/search?q=set:${setCode}&order=set&unique=prints`;
  const response = await scryfallFetch(url);
  const json = (await response.json()) as {
    data: ScryfallCardJson[];
    has_more: boolean;
    next_page?: string;
    total_cards: number;
  };
  const cards: ScryfallCardInfo[] = [];
  for (const card of json.data) {
    if (card.lang !== "en") continue;
    if (card.layout === "art_series") continue;
    cards.push(mapScryfallCard(card));
  }
  return {
    cards,
    nextPage: json.has_more ? json.next_page?.replace(SCRYFALL_API, "") : undefined,
    total: json.total_cards,
  };
}

const PRODUCT_CREATE_QUERY = `#graphql
  mutation CreateSetProduct($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        title
      }
      userErrors { field message }
    }
  }
`;

const GET_VARIANT_ID_QUERY = `#graphql
  query GetProductVariants($productId: ID!) {
    product(id: $productId) {
      variants(first: 1) {
        edges { node { id, inventoryItem { id } } }
      }
    }
  }
`;



const ADD_MEDIA_QUERY = `#graphql
  mutation AddMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        id
      }
      mediaUserErrors { field message }
    }
  }
`;



const RARITY_ES: Record<string, string> = {
  common: "Común",
  uncommon: "Infrecuente",
  rare: "Rara",
  mythic: "Mítica",
  bonus: "Bonus",
  special: "Especial",
};

const COLOR_ES: Record<string, string> = {
  W: "Blanco",
  U: "Azul",
  B: "Negro",
  R: "Rojo",
  G: "Verde",
};

const CARD_TYPE_ES: Record<string, string> = {
  Artifact: "Artefacto",
  Conspiracy: "Conspiración",
  Creature: "Criatura",
  Enchantment: "Encantamiento",
  Instant: "Instantáneo",
  Kindred: "Parentesco",
  Land: "Tierra",
  Phenomenon: "Fenómeno",
  Plane: "Plano",
  Planeswalker: "Planeswalker",
  Scheme: "Plan",
  Sorcery: "Conjuro",
  Tribal: "Tribal",
  Vanguard: "Vanguardia",
};

const LANGUAGE_ES: Record<string, string> = {
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
};

function colorsToSpanish(colors: string[]): string {
  const named = colors.map((c) => COLOR_ES[c] ?? c).filter(Boolean);
  if (named.length === 0) return "Incolora";
  if (named.length > 1) return `Multicolor, ${named.join(", ")}`;
  return named[0];
}

function rarityToSpanish(rarity: string): string {
  return RARITY_ES[rarity.toLowerCase()] ?? rarity;
}

function cardTypesToSpanish(typeLine: string): string {
  const types = typeLine.split(/\s*—\s*/)[0];
  const found: string[] = [];
  for (const [en, es] of Object.entries(CARD_TYPE_ES)) {
    if (new RegExp(`\\b${en}\\b`, "i").test(types)) found.push(es);
  }
  return found.length > 0 ? found.join(" ") : types.trim();
}

function legalFormats(legalities: Record<string, string>): string {
  const order = ["standard", "pauper", "commander", "legacy"];
  return order
    .filter((f) => legalities[f] === "legal")
    .map((f) => f.charAt(0).toUpperCase() + f.slice(1))
    .join(", ");
}

function buildProductTitle(card: ScryfallCardInfo, foil: boolean): string {
  return `${card.name} Regular${foil ? " Foil" : ""} (ingles) ${card.collectorNumber}`;
}

function buildProductDescription(card: ScryfallCardInfo): string {
  const lines: string[] = [];
  if (card.manaCost) {
    lines.push(`**Coste de maná:** ${card.manaCost}${card.cmc != null ? ` (${card.cmc})` : ""}`);
  }
  lines.push(`**Tipo:** ${card.typeLine}`);
  lines.push(`**Rareza:** ${rarityToSpanish(card.rarity)}`);
  const colorsEs = colorsToSpanish(card.colors);
  if (colorsEs) lines.push(`**Color:** ${colorsEs}`);
  if (card.artist) lines.push(`**Artista:** ${card.artist}`);
  if (card.power || card.toughness) {
    lines.push(`**Fuerza/Resistencia:** ${card.power ?? "-"} / ${card.toughness ?? "-"}`);
  }
  const formats = legalFormats(card.legalities);
  if (formats) lines.push(`**Formatos:** ${formats}`);
  lines.push(`**Idioma:** ${LANGUAGE_ES[card.lang] ?? card.lang}`);
  if (card.oracleText) lines.push(`\n${card.oracleText}`);
  lines.push(`\n---`);
  lines.push(`**Edición:** ${card.set_name} (${card.setCode.toUpperCase()})`);
  lines.push(`**Nº de colección:** ${card.collectorNumber}`);
  if (card.keywords.length > 0) lines.push(`**Palabras clave:** ${card.keywords.join(", ")}`);
  const flags: string[] = [];
  if (card.fullArt) flags.push("Full art");
  if (card.textless) flags.push("Textless");
  if (card.promo) flags.push("Promo");
  if (card.storySpotlight) flags.push("Story spotlight");
  if (flags.length > 0) lines.push(`**Extras:** ${flags.join(", ")}`);
  return lines.join("\n");
}

type ProductToCreate = {
  title: string;
  sku: string;
  price: number;
  foil: boolean;
  card: ScryfallCardInfo;
};

export type SetImportProgress = {
  total: number;
  processed: number;
  created: number;
  failed: number;
  skipped: number;
};

const EXISTING_PRODUCTS_QUERY = `#graphql
  query ExistingSetProducts($query: String!, $cursor: String) {
    products(first: 250, after: $cursor, query: $query) {
      edges {
        node {
          id
          title
          metafields(namespace: "custom", keys: ["scryfall_id"]) {
            edges {
              node {
                key
                value
              }
            }
          }
          variants(first: 250) {
            edges {
              node {
                id
                sku
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

async function fetchExistingSetProducts(
  adminGraphql: (query: string, options?: Record<string, unknown>) => Promise<Response>,
  setCode: string,
): Promise<Array<{ id: string; title: string; scryfallId: string | null; skus: Array<string | null> }>> {
  const products: Array<{ id: string; title: string; scryfallId: string | null; skus: Array<string | null> }> = [];
  let cursor: string | null = null;
  do {
    const response = await adminGraphql(EXISTING_PRODUCTS_QUERY, {
      variables: { query: `tag:set:${setCode}`, cursor },
    });
    const json = (await response.json()) as {
      data?: {
        products?: {
          edges: Array<{
            node: {
              id: string;
              title: string;
              metafields?: { edges: Array<{ node: { key: string; value: string } }> };
              variants?: { edges: Array<{ node: { id: string; sku: string | null } }> };
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };
    };
    const page = json.data?.products;
    if (!page) {
      break;
    }
    for (const edge of page.edges) {
      const node = edge.node;
      const scryfallIdValue =
        node.metafields?.edges?.find((e) => e.node.key === "scryfall_id")?.node?.value ?? null;
      products.push({
        id: node.id,
        title: node.title,
        scryfallId: scryfallIdValue?.trim() || null,
        skus: node.variants?.edges?.map((v) => v.node.sku) ?? [],
      });
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return products;
}

async function putWithRetry(url: string, accessToken: string, body: unknown): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt <= 4; attempt += 1) {
    const response = await fetch(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify(body),
    });
    lastResponse = response;
    if (response.ok) {
      return response;
    }
    if (response.status === 429 || response.status >= 500) {
      const retryAfterRaw = Number(response.headers.get("retry-after") ?? "");
      const retryAfterMs = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0 ? retryAfterRaw * 1000 : 0;
      await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfterMs || 500 * (attempt + 1), 60_000)));
      continue;
    }
    return response;
  }
  return lastResponse ?? new Response(null, { status: 500 });
}

export async function importCardsToShopify(params: {
  cards: ScryfallCardInfo[];
  setInfo: ScryfallSetInfo;
  adminGraphql: (query: string, options?: Record<string, unknown>) => Promise<Response>;
  shop: string;
  accessToken: string;
  createAsActive: boolean;
  onProgress?: (progress: SetImportProgress) => void;
  genericDescription?: string;
  cardKingdomPrices?: Map<string, CardKingdomPriceEntry>;
}): Promise<ImportResult> {
  const { cards, setInfo, adminGraphql, shop, accessToken, createAsActive, onProgress, genericDescription, cardKingdomPrices } = params;
  const result: ImportResult = { created: 0, failed: 0, skipped: 0, errors: [] };

  // Load products that already exist for this set so re-runs are idempotent and
  // SKU collisions between different cards get a "-2", "-3", ... suffix.
  const existingProducts = await fetchExistingSetProducts(adminGraphql, setInfo.code.toLowerCase());
  const existingSkus = new Map<string, string | null>(); // normalized sku -> scryfall id (or null)
  for (const product of existingProducts) {
    const ownerId = product.scryfallId?.toLowerCase() ?? null;
    for (const sku of product.skus) {
      const normalized = sku?.trim().toLowerCase();
      if (normalized) {
        existingSkus.set(normalized, ownerId);
      }
    }
  }

  const productsToCreate: ProductToCreate[] = [];
  const batchSkus = new Map<string, string>(); // normalized sku -> scryfall id for this run
  let skippedExisting = 0;

  const assignSku = (baseSku: string, cardId: string): string | null => {
    const normalizedBase = baseSku.toLowerCase();
    const existingOwner = existingSkus.get(normalizedBase);
    if (existingOwner === cardId.toLowerCase()) {
      return null; // this exact finish was already imported for the same card
    }
    let candidate = normalizedBase;
    let n = 2;
    while (existingSkus.has(candidate) || batchSkus.has(candidate)) {
      candidate = `${normalizedBase}-${n}`;
      n += 1;
    }
    batchSkus.set(candidate, cardId.toLowerCase());
    return candidate;
  };

  const buildItem = (card: ScryfallCardInfo, baseSku: string, price: number, foil: boolean): void => {
    const sku = assignSku(baseSku, card.id);
    if (!sku) {
      skippedExisting += 1;
      return;
    }
    productsToCreate.push({
      title: card.name,
      sku,
      price,
      foil,
      card,
    });
  };

  for (const card of cards) {
    const baseNonfoil = `${card.setCode}${card.collectorNumber}`;
    const baseFoil = `${baseNonfoil}foil`;

    let nonfoilPrice = card.usdPrice ?? 0;
    let foilPrice = card.usdFoilPrice ?? 0;
    if (cardKingdomPrices) {
      const ck = cardKingdomPrices.get(card.id);
      if (ck) {
        if (ck.nonfoil != null) {
          const p = parseFloat(ck.nonfoil);
          if (!isNaN(p) && p > 0) nonfoilPrice = p;
        }
        if (ck.foil != null) {
          const p = parseFloat(ck.foil);
          if (!isNaN(p) && p > 0) foilPrice = p;
        }
      }
    }

    if (card.hasNonfoil) {
      buildItem(card, baseNonfoil, nonfoilPrice, false);
    }
    if (card.hasFoil) {
      buildItem(card, baseFoil, foilPrice, true);
    }
  }

  const cardsWithoutFinishes = cards.filter((card) => !card.hasNonfoil && !card.hasFoil).length;
  result.skipped = skippedExisting + cardsWithoutFinishes;

  const concurrency = 2;
  const queue = [...productsToCreate];
  const running: Array<Promise<void>> = [];
  let processed = 0;

  async function createProduct(item: ProductToCreate): Promise<void> {
    const { sku, price, foil, card } = item;
    const displayTitle = buildProductTitle(card, foil);
    const finishTag = foil ? "foil" : "nonfoil";

    try {
      const metafields: Array<Record<string, unknown>> = [
        { namespace: "custom", key: "scryfall_id", value: card.id, type: "single_line_text_field" },
        { namespace: "custom", key: "oracle_id", value: card.oracleId, type: "single_line_text_field" },
        { namespace: "custom", key: "set_code", value: card.setCode, type: "single_line_text_field" },
        { namespace: "custom", key: "collector_number", value: card.collectorNumber, type: "single_line_text_field" },
        { namespace: "custom", key: "foil", value: foil ? "true" : "false", type: "boolean" },
        { namespace: "custom", key: "artist", value: card.artist ?? "", type: "single_line_text_field" },
        { namespace: "custom", key: "mana_cost", value: card.manaCost ?? "", type: "single_line_text_field" },
        { namespace: "custom", key: "colors", value: colorsToSpanish(card.colors), type: "single_line_text_field" },
        { namespace: "custom", key: "rarity", value: rarityToSpanish(card.rarity), type: "single_line_text_field" },
        { namespace: "custom", key: "card_types", value: cardTypesToSpanish(card.typeLine), type: "single_line_text_field" },
        { namespace: "custom", key: "formats", value: legalFormats(card.legalities), type: "single_line_text_field" },
        { namespace: "custom", key: "language", value: LANGUAGE_ES[card.lang] ?? card.lang, type: "single_line_text_field" },
        { namespace: "custom", key: "oracle_text", value: card.oracleText ?? "", type: "multi_line_text_field" },
        { namespace: "custom", key: "power", value: card.power ?? "", type: "single_line_text_field" },
        { namespace: "custom", key: "toughness", value: card.toughness ?? "", type: "single_line_text_field" },
        { namespace: "custom", key: "keywords", value: card.keywords.join(", "), type: "single_line_text_field" },
        { namespace: "custom", key: "full_art", value: card.fullArt ? "true" : "false", type: "boolean" },
        { namespace: "custom", key: "textless", value: card.textless ? "true" : "false", type: "boolean" },
        { namespace: "custom", key: "promo", value: card.promo ? "true" : "false", type: "boolean" },
      ];
      if (card.cmc != null) {
        metafields.push({ namespace: "custom", key: "cmc", value: String(card.cmc), type: "number_decimal" });
      }
      if (card.eurPrice != null) {
        metafields.push({ namespace: "custom", key: "eur", value: String(card.eurPrice), type: "number_decimal" });
      }
      if (card.releasedAt) {
        metafields.push({ namespace: "custom", key: "released_at", value: card.releasedAt, type: "date" });
      }

      const input: Record<string, unknown> = {
        title: displayTitle,
        descriptionHtml: (genericDescription && genericDescription.trim()) ? genericDescription.trim().replace(/\n/g, "<br>") : buildProductDescription(card).replace(/\n/g, "<br>"),
        vendor: setInfo.name,
        productType: "Magic: The Gathering Single",
        status: createAsActive ? "ACTIVE" : "DRAFT",
        tags: [card.setCode.toUpperCase(), card.rarity, finishTag, `set:${card.setCode}`].join(","),
        metafields,
      };

      const response = await adminGraphql(PRODUCT_CREATE_QUERY, {
        variables: { input },
      });
      const json = (await response.json()) as {
        errors?: Array<{ message: string }>;
        data?: {
          productCreate?: {
            product?: { id: string; title: string };
            userErrors: Array<{ field: string; message: string }>;
          };
        };
      };
      const data = json.data?.productCreate;
      const userErrors = data?.userErrors ?? [];
      const apiErrors = json.errors ?? [];

      if (userErrors.length > 0 || apiErrors.length > 0) {
        const errMsgs = [
          ...userErrors.map((e) => `${e.field}: ${e.message}`),
          ...apiErrors.map((e) => e.message),
        ];
        result.failed++;
        result.errors.push({ card: displayTitle, error: errMsgs.join("; ") });
        return;
      }

      const productId = data?.product?.id;
      if (!productId) {
        result.failed++;
        result.errors.push({ card: displayTitle, error: "No product ID returned" });
        return;
      }

      const variantQueryResponse = await adminGraphql(GET_VARIANT_ID_QUERY, {
        variables: { productId },
      });
      const variantQueryJson = (await variantQueryResponse.json()) as {
        data?: {
          product?: {
            variants?: { edges: Array<{ node: { id: string; inventoryItem: { id: string } } }> };
          };
        };
      };
      const variant = variantQueryJson.data?.product?.variants?.edges?.[0]?.node;
      if (!variant) {
        result.failed++;
        result.errors.push({ card: displayTitle, error: "No variant found" });
        return;
      }

      const variantNumericId = variant.id.split("/").pop();
      const restUrl = `https://${shop}/admin/api/2025-01/variants/${variantNumericId}.json`;
      const restResponse = await putWithRetry(restUrl, accessToken, {
        variant: {
          id: variantNumericId,
          price: price.toFixed(2),
          sku,
        },
      });
      const restJson = (await restResponse.json()) as { errors?: string; variant?: unknown };
      if (!restResponse.ok || restJson.errors) {
        result.failed++;
        result.errors.push({
          card: displayTitle,
          error: `REST variant error: ${restJson.errors || restResponse.statusText}`,
        });
        return;
      }

      if (card.imageUrl) {
        const mediaResponse = await adminGraphql(ADD_MEDIA_QUERY, {
          variables: {
            productId,
            media: [
              {
                mediaContentType: "IMAGE",
                originalSource: card.imageUrl,
                alt: card.name,
              },
            ],
          },
        });
        const mediaJson = (await mediaResponse.json()) as {
          errors?: Array<{ message: string }>;
          data?: {
            productCreateMedia?: {
              mediaUserErrors: Array<{ field: string; message: string }>;
            };
          };
        };
        const mediaErrors = mediaJson.data?.productCreateMedia?.mediaUserErrors ?? mediaJson.errors ?? [];
        if (mediaErrors.length > 0) {
          result.errors.push({
            card: displayTitle,
            error: `Media warning: ${mediaErrors.map((e: any) => e.message || e).join("; ")}`,
          });
        }
      }

      result.created++;
    } catch (error) {
      result.failed++;
      result.errors.push({
        card: displayTitle,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const trackFinished = (promise: Promise<void>): Promise<void> =>
    promise.finally(() => {
      const idx = running.indexOf(promise);
      if (idx >= 0) running.splice(idx, 1);
      processed += 1;
      onProgress?.({
        total: productsToCreate.length,
        processed,
        created: result.created,
        failed: result.failed,
        skipped: result.skipped,
      });
    });

  while (queue.length > 0 || running.length > 0) {
    while (running.length < concurrency && queue.length > 0) {
      const item = queue.shift()!;
      running.push(trackFinished(createProduct(item)));
    }
    if (running.length > 0) {
      await Promise.race(running);
    }
  }

  return result;
}
