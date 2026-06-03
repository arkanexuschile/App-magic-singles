import { matchByTitle } from "./title.server";
import type { CardLookupMatch, FoilMode, ScryfallFetchers, VariantForLookup } from "./types";

export function resolveSkuForLookup(variant: Pick<VariantForLookup, "sku" | "product">): string | null {
  const variantSku = variant.sku?.trim();
  if (variantSku) {
    return variantSku;
  }
  const productLevelSku = variant.product.variants.edges[0]?.node?.sku?.trim();
  if (productLevelSku) {
    return productLevelSku;
  }
  return null;
}

export async function matchBySku(params: {
  variant: VariantForLookup;
  foilMode: FoilMode;
  fetchers: Pick<ScryfallFetchers, "bySku" | "byTitle">;
}): Promise<CardLookupMatch | null> {
  const skuForLookup = resolveSkuForLookup(params.variant);
  if (!skuForLookup) {
    return matchByTitle({
      variant: params.variant,
      foilMode: params.foilMode,
      fetchers: params.fetchers,
    });
  }

  const bySku = await params.fetchers.bySku(skuForLookup);
  if (!bySku) {
    return null;
  }
  return {
    card: bySku.card,
    foilMode: params.foilMode ?? bySku.foilMode,
    scryfallId: bySku.card.id,
    scryfallMetaOwner: "variant",
  };
}
