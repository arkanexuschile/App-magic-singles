import { writeSyncLog } from "../sync-log.server";
import { normalizeScryfallIdentifier } from "./scryfall-api.server";
import type {
  CardLookupMatch,
  CustomScryfallPrefs,
  FoilMode,
  ResolvedScryfallIdentifier,
  ScryfallFetchers,
  VariantForLookup,
} from "./types";

type CustomIdentifierVariant = {
  customScryfallIdField: { value: string } | null;
  product: {
    totalVariants?: number;
    customScryfallIdField: { value: string } | null;
  };
};

export function resolveCustomScryfallIdentifier(
  variant: CustomIdentifierVariant,
  prefs: Pick<CustomScryfallPrefs, "allowProductLevelCustomScryfallFallback">,
): ResolvedScryfallIdentifier | null {
  // Custom Scryfall matching starts here:
  // Shopify custom.<key> value is normalized by normalizeScryfallIdentifier,
  // then matchByCustomScryfallField uses Scryfall's card UUID endpoint.
  const variantRawValue = variant.customScryfallIdField?.value?.trim() ?? "";
  const variantLevelId = normalizeScryfallIdentifier(variantRawValue);
  if (variantLevelId) {
    return {
      id: variantLevelId,
      rawValue: variantRawValue,
      owner: "variant",
    };
  }

  const canUseProductLevelFallback =
    prefs.allowProductLevelCustomScryfallFallback ||
    (variant.product.totalVariants ?? 1) <= 1;
  if (!canUseProductLevelFallback) {
    return null;
  }

  const productRawValue = variant.product.customScryfallIdField?.value?.trim() ?? "";
  const productLevelId = normalizeScryfallIdentifier(productRawValue);
  if (!productLevelId) {
    return null;
  }

  return {
    id: productLevelId,
    rawValue: productRawValue,
    owner: "product",
  };
}

export function hasCustomScryfallIdentifierCandidate(
  variant: CustomIdentifierVariant,
  prefs: Pick<CustomScryfallPrefs, "allowProductLevelCustomScryfallFallback">,
): boolean {
  const variantRawValue = variant.customScryfallIdField?.value?.trim() ?? "";
  if (variantRawValue.length > 0) {
    return true;
  }

  const canUseProductLevelFallback =
    prefs.allowProductLevelCustomScryfallFallback ||
    (variant.product.totalVariants ?? 1) <= 1;
  if (!canUseProductLevelFallback) {
    return false;
  }

  return (variant.product.customScryfallIdField?.value?.trim() ?? "").length > 0;
}

export function resolveStoredScryfallId(
  variant: Pick<VariantForLookup, "scryfallIdField" | "product">,
): ResolvedScryfallIdentifier | null {
  const variantRawValue = variant.scryfallIdField?.value?.trim() ?? "";
  const variantLevelId = normalizeScryfallIdentifier(variantRawValue);
  if (variantLevelId) {
    return { id: variantLevelId, rawValue: variantRawValue, owner: "variant" };
  }

  const productRawValue = variant.product.scryfallIdField?.value?.trim() ?? "";
  const productLevelId = normalizeScryfallIdentifier(productRawValue);
  if (productLevelId) {
    return { id: productLevelId, rawValue: productRawValue, owner: "product" };
  }

  return null;
}

export async function matchByCustomScryfallField(params: {
  variant: VariantForLookup;
  prefs: CustomScryfallPrefs;
  foilMode: FoilMode;
  fetchers: Pick<ScryfallFetchers, "byId" | "byOracleId">;
}): Promise<CardLookupMatch | null> {
  const { variant, prefs, foilMode, fetchers } = params;
  const customIdentifier = resolveCustomScryfallIdentifier(variant, prefs);
  if (!customIdentifier) {
    return null;
  }

  const requiresScryfallCard =
    prefs.priceSource === "scryfall" || prefs.priceSource === "mtgjson";
  if (requiresScryfallCard || prefs.syncImage) {
    const byId = await fetchers.byId(customIdentifier.rawValue);
    const byOracleId = byId ? null : await fetchers.byOracleId(customIdentifier.rawValue);
    const resolvedByCustomId = byId ?? byOracleId;
    if (!resolvedByCustomId) {
      writeSyncLog("warn", "[product-debug][variant]", {
        variantId: variant.id,
        action: "custom_id_unresolved",
        customId: customIdentifier.id,
        customIdSource: customIdentifier.owner,
        tried: ["card_id", "oracle_id"],
      });
      if (!requiresScryfallCard) {
        return {
          card: null,
          foilMode,
          scryfallId: customIdentifier.id,
          scryfallMetaOwner: customIdentifier.owner,
        };
      }
      return null;
    }
    return {
      card: resolvedByCustomId.card,
      foilMode: foilMode ?? resolvedByCustomId.foilMode,
      scryfallId: resolvedByCustomId.card.id,
      scryfallMetaOwner: customIdentifier.owner,
    };
  }

  return {
    card: null,
    foilMode,
    scryfallId: customIdentifier.id,
    scryfallMetaOwner: customIdentifier.owner,
  };
}

export async function matchByStoredScryfallField(params: {
  variant: VariantForLookup;
  prefs: Pick<CustomScryfallPrefs, "priceSource" | "syncImage">;
  foilMode: FoilMode;
  fetchers: Pick<ScryfallFetchers, "byId" | "byOracleId">;
}): Promise<CardLookupMatch | null> {
  const { variant, prefs, foilMode, fetchers } = params;
  const storedScryfall = resolveStoredScryfallId(variant);
  if (!storedScryfall) {
    return null;
  }

  const requiresScryfallCard =
    prefs.priceSource === "scryfall" || prefs.priceSource === "mtgjson";
  if (requiresScryfallCard || prefs.syncImage) {
    const byId = await fetchers.byId(storedScryfall.rawValue);
    const byOracleId = byId ? null : await fetchers.byOracleId(storedScryfall.rawValue);
    const resolvedByStoredId = byId ?? byOracleId;
    if (resolvedByStoredId) {
      return {
        card: resolvedByStoredId.card,
        foilMode: foilMode ?? resolvedByStoredId.foilMode,
        scryfallId: resolvedByStoredId.card.id,
        scryfallMetaOwner: storedScryfall.owner,
      };
    }
    return null;
  }

  return {
    card: null,
    foilMode,
    scryfallId: storedScryfall.id,
    scryfallMetaOwner: storedScryfall.owner,
  };
}

export async function matchByMetafield(params: {
  variant: VariantForLookup;
  foilMode: FoilMode;
  fetchers: Pick<ScryfallFetchers, "byId">;
}): Promise<CardLookupMatch | null> {
  const value = params.variant.lookupField?.value?.trim();
  if (!value) {
    return null;
  }
  const byId = await params.fetchers.byId(value);
  if (!byId) {
    return null;
  }
  return {
    card: byId.card,
    foilMode: params.foilMode ?? byId.foilMode,
    scryfallId: byId.card.id,
    scryfallMetaOwner: "variant",
  };
}
