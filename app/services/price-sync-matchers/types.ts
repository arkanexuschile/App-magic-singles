export type FoilMode = "foil" | "nonfoil" | null;

export type ScryfallCard = {
  id: string;
  name: string;
  set?: string;
  image_uris?: Record<string, string>;
  card_faces?: Array<{ image_uris?: Record<string, string> }>;
  prices: {
    usd: string | null;
    usd_foil: string | null;
  };
  finishes?: string[];
};

export type ScryfallLookupResult = {
  card: ScryfallCard;
  foilMode: FoilMode;
};

export type ResolvedScryfallIdentifier = {
  id: string;
  rawValue: string;
  owner: "product" | "variant";
};

export type CardLookupMatch = {
  card: ScryfallCard | null;
  foilMode: FoilMode;
  scryfallId: string | null;
  scryfallMetaOwner: "product" | "variant";
};

export type VariantForLookup = {
  id: string;
  sku: string | null;
  title: string;
  lookupField: { value: string } | null;
  scryfallIdField: { value: string } | null;
  customScryfallIdField: { value: string } | null;
  product: {
    id: string;
    title: string;
    totalVariants?: number;
    variants: {
      edges: Array<{
        node: {
          sku: string | null;
        };
      }>;
    };
    scryfallIdField: { value: string } | null;
    customScryfallIdField: { value: string } | null;
  };
};

export type CustomScryfallPrefs = {
  allowProductLevelCustomScryfallFallback: boolean;
  priceSource: "scryfall" | "justtcg" | "mtgjson" | "cardkingdom";
  syncImage: boolean;
};

export type ScryfallFetchers = {
  bySku: (sku: string) => Promise<ScryfallLookupResult | null>;
  byTitle: (title: string) => Promise<ScryfallLookupResult | null>;
  byId: (id: string) => Promise<ScryfallLookupResult | null>;
  byOracleId: (id: string) => Promise<ScryfallLookupResult | null>;
};
