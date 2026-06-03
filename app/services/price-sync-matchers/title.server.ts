import type { CardLookupMatch, FoilMode, ScryfallFetchers, VariantForLookup } from "./types";

export async function matchByTitle(params: {
  variant: Pick<VariantForLookup, "product">;
  foilMode: FoilMode;
  fetchers: Pick<ScryfallFetchers, "byTitle">;
}): Promise<CardLookupMatch | null> {
  const byTitle = await params.fetchers.byTitle(params.variant.product.title);
  if (!byTitle) {
    return null;
  }
  return {
    card: byTitle.card,
    foilMode: params.foilMode ?? byTitle.foilMode,
    scryfallId: byTitle.card.id,
    scryfallMetaOwner: "variant",
  };
}
