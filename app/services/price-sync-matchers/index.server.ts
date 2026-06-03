import {
  fetchScryfallCardById,
  fetchScryfallCardByOracleId,
  fetchScryfallCardBySku,
  fetchScryfallCardByTitle,
} from "./scryfall-api.server";
import {
  matchByCustomScryfallField,
  matchByMetafield,
  matchByStoredScryfallField,
} from "./custom-field.server";
import { matchBySku } from "./sku.server";
import { matchByTitle } from "./title.server";
import type {
  CardLookupMatch,
  CustomScryfallPrefs,
  FoilMode,
  VariantForLookup,
} from "./types";

const scryfallFetchers = {
  bySku: fetchScryfallCardBySku,
  byTitle: fetchScryfallCardByTitle,
  byId: fetchScryfallCardById,
  byOracleId: fetchScryfallCardByOracleId,
};

export async function matchCardForVariant(params: {
  variant: VariantForLookup;
  prefs: CustomScryfallPrefs & {
    searchMode: "sku" | "title" | "metafield";
    useCustomScryfallIdField: boolean;
  };
  foilMode: FoilMode;
}): Promise<CardLookupMatch | null> {
  const { variant, prefs, foilMode } = params;

  if (prefs.useCustomScryfallIdField) {
    return matchByCustomScryfallField({
      variant,
      prefs,
      foilMode,
      fetchers: scryfallFetchers,
    });
  }

  const storedScryfallMatch = await matchByStoredScryfallField({
    variant,
    prefs,
    foilMode,
    fetchers: scryfallFetchers,
  });
  if (storedScryfallMatch) {
    return storedScryfallMatch;
  }

  if (prefs.searchMode === "title") {
    return matchByTitle({ variant, foilMode, fetchers: scryfallFetchers });
  }

  if (prefs.searchMode === "metafield") {
    return matchByMetafield({ variant, foilMode, fetchers: scryfallFetchers });
  }

  return matchBySku({ variant, foilMode, fetchers: scryfallFetchers });
}
