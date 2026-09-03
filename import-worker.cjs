// Child process: imports a set into Shopify (no Remix, no framework)
const { PrismaClient } = require('@prisma/client');

const SHOPIFY_API_VERSION = '2025-01';
const CLP_RATE = 1000;
const SCRYFALL_MIN_INTERVAL = 100;

async function main() {
  const args = JSON.parse(process.argv[2]);
  const { jobId, shop, accessToken, setCode, createAsActive, genericDescription, lang, cardIds, cardSelections } = args;
  const langFilter = lang || 'en';
  const allowedCardIds = Array.isArray(cardIds) && cardIds.length > 0 ? new Set(cardIds.map(String)) : null;
  // Excel import selects a specific finish per card. Map scryfall_id -> Set of foil booleans.
  const allowedFinishes = Array.isArray(cardSelections) && cardSelections.length > 0
    ? cardSelections.reduce((map, sel) => {
        const key = String(sel.scryfallId);
        if (!map.has(key)) map.set(key, new Set());
        map.get(key).add(!!sel.foil);
        return map;
      }, new Map())
    : null;
  // Stock per variant (scryfall_id + foil). Key format: "<id>|<0|1>".
  const stockByVariant = Array.isArray(cardSelections) && cardSelections.length > 0
    ? cardSelections.reduce((map, sel) => {
        const key = `${String(sel.scryfallId)}|${sel.foil ? 1 : 0}`;
        map.set(key, Number(sel.stock) || 0);
        return map;
      }, new Map())
    : null;
  const langNames = { en: 'Inglés', es: 'Español', ja: 'Japonés', pt: 'Portugués' };
  const langTitleNames = { en: 'ingles', es: 'español', ja: 'japonés', pt: 'portugués' };
  function idiomaName(lang) {
    const name = langNames[lang];
    if (name) return name;
    return lang === 'en' ? 'Inglés' : lang === 'es' ? 'Español' : lang === 'ja' ? 'Japonés' : 'Otro';
  }

  const p = new PrismaClient({ datasourceUrl: process.env.DATABASE_URL || 'file:./prisma/dev.sqlite' });

  function log(msg) { console.log(`[import-worker] ${msg}`); }

  async function failJob(msg) {
    log(`FAIL: ${msg}`);
    try {
      await p.setImportJob.update({
        where: { id: jobId },
        data: { status: 'failed', message: msg, finishedAt: new Date() },
      });
    } catch {}
    await p.$disconnect();
    process.exit(1);
  }

  try {
    await p.setImportJob.update({
      where: { id: jobId },
      data: { status: 'running', startedAt: new Date() },
    });

    // --- Fetch cards from Scryfall (paginated) ---
    async function scryfallFetch(path) {
      const response = await fetch(`https://api.scryfall.com${path}`, {
        headers: { 'User-Agent': 'magic-pricer-singles/1.0' }
      });
      if (response.status === 404) {
        scryfallEmpty = true;
        return { data: [], total_cards: 0, has_more: false };
      }
      if (!response.ok) throw new Error(`Scryfall ${response.status}`);
      return response.json();
    }

    async function getSetCardsPage(code, pageUrl) {
      // Use a real space (encoded %20) as the AND operator. Scryfall treats `+`
      // differently and returns the English print even when a language is given.
      // When importing all languages (Excel whitelist), fetch every language.
      let query = `set%3A${code}`;
      if (langFilter === 'all') {
        query += `%20lang%3A%2A`;
      } else if (langFilter !== 'en') {
        query += `%20lang%3A${langFilter}`;
      }
      const url = pageUrl || `/cards/search?q=${query}&order=set&unique=prints`;
      const json = await scryfallFetch(url);
      const cards = json.data
        .filter(c => c.layout !== 'art_series')
        .map(c => ({
          id: c.id,
          name: c.name,
          setCode: c.set,
          set_name: c.set_name,
          collectorNumber: c.collector_number,
          rarity: c.rarity,
          oracleId: c.oracle_id,
          usdPrice: c.prices.usd ? parseFloat(c.prices.usd) : null,
          usdFoilPrice: c.prices.usd_foil ? parseFloat(c.prices.usd_foil) : null,
          imageUrl: c.image_uris?.large || c.image_uris?.normal || c.image_uris?.small,
          finishes: c.finishes || ['nonfoil'],
          hasFoil: (c.finishes || ['nonfoil']).includes('foil'),
          hasNonfoil: (c.finishes || ['nonfoil']).includes('nonfoil'),
          oracleText: c.oracle_text,
          typeLine: c.type_line,
          manaCost: c.mana_cost,
          cmc: c.cmc || null,
          colors: c.colors || [],
          keywords: c.keywords || [],
          artist: c.artist || null,
          power: c.power || null,
          toughness: c.toughness || null,
          lang: c.lang,
          releasedAt: c.released_at || null,
          fullArt: !!c.full_art,
          textless: !!c.textless,
          promo: !!c.promo,
        }));
      return {
        cards,
        nextPage: json.has_more ? json.next_page?.replace(/^https?:\/\/api\.scryfall\.com/, '') : null,
        total: json.total_cards,
      };
    }

    // --- Shopify API helper ---
    async function graphql(query, variables) {
      const res = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
        body: JSON.stringify({ query, variables }),
      });
      return res.json();
    }

    async function fetchExistingVariantSkus() {
      const skus = new Set();
      let cursor = null;
      const query = `query ExistingSkus($tag: String!, $cursor: String) {
        products(first: 100, after: $cursor, query: $tag) {
          edges {
            node {
              variants(first: 100) {
                edges { node { sku } }
              }
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }`;
      do {
        const json = await graphql(query, { tag: `tag:setcode-${setCode}`, cursor });
        const page = json?.data?.products;
        if (!page) break;
        for (const edge of page.edges) {
          for (const v of edge.node.variants?.edges || []) {
            if (v.node.sku) skus.add(String(v.node.sku).toLowerCase());
          }
        }
        cursor = page.pageInfo?.hasNextPage ? page.pageInfo?.endCursor : null;
      } while (cursor);
      return skus;
    }

    // Resolve the store's first physical location id (needed to set inventory levels).
    let cachedLocationId = null;
    async function getPrimaryLocationId() {
      if (cachedLocationId) return cachedLocationId;
      const json = await graphql(
        `query GetLocations { locations(first: 1) { edges { node { id } } } }`,
      );
      const locId = json?.data?.locations?.edges?.[0]?.node?.id;
      if (locId) cachedLocationId = locId;
      return locId || null;
    }

    // Set the available quantity for a variant's inventory item at the primary location.
    async function applyVariantStock(inventoryItemId, qty) {
      const locationId = await getPrimaryLocationId();
      if (!locationId) {
        log(`WARN: no location found, cannot set stock`);
        return false;
      }
      const mutation = `mutation SetInventory($input: [InventorySetQuantitiesInput!]!) {
        inventorySetQuantities(input: $input) {
          userErrors { field message }
          inventoryAdjustmentGroup { changes { name } }
        }
      }`;
      const json = await graphql(mutation, {
        input: [{
          name: 'available',
          quantity: qty,
          reason: 'correction',
          inventoryLevel: { locationId, itemId: inventoryItemId },
        }],
      });
      const userErrors = json?.data?.inventorySetQuantities?.userErrors || [];
      if (json.errors || userErrors.length > 0) {
        const msgs = [
          ...(json.errors || []).map((e) => e.message),
          ...userErrors.map((e) => `${e.field}: ${e.message}`),
        ];
        log(`WARN: set stock failed for ${inventoryItemId}: ${msgs.join('; ')}`);
        return false;
      }
      return true;
    }

    // Resolve an existing variant's inventory item id by its SKU.
    async function findInventoryItemIdBySku(sku) {
      const query = `query VariantBySku($sku: String!) {
        productVariants(first: 1, query: $sku) {
          edges { node { id inventoryItem { id } } }
        }
      }`;
      const json = await graphql(query, { sku });
      const v = json?.data?.productVariants?.edges?.[0]?.node;
      if (!v) return null;
      return v.inventoryItem?.id || null;
    }

    // Add an item (card already in the store) to the report, and apply stock if requested.
    const existingItems = [];
    async function recordExisting(scryfallId, name, sku, foil, stock) {
      existingItems.push({ scryfallId, name, sku, foil, stock });
      skipped++;
      log(`SKIP (already in store): ${sku}`);
      if (stock > 0) {
        try {
          const invItemId = await findInventoryItemIdBySku(sku);
          if (invItemId) {
            await applyVariantStock(invItemId, stock);
            log(`Updated stock for existing ${sku} -> ${stock}`);
          } else {
            log(`WARN: could not find inventory item for existing ${sku}`);
          }
        } catch (e) {
          log(`WARN: failed to update stock for ${sku}: ${e.message || e}`);
        }
      }
    }

    // --- Build product input ---
    function translateCardType(typeLine) {
      const main = (typeLine || '').split(/\s*[—\-]\s*/)[0].trim();
      const typeMap = {
        'Creature': 'Criatura', 'Artifact': 'Artefacto', 'Enchantment': 'Encantamiento',
        'Instant': 'Instantáneo', 'Sorcery': 'Conjuro', 'Planeswalker': 'Planeswalker',
        'Land': 'Tierra', 'Battle': 'Batalla',
      };
      for (const [en, es] of Object.entries(typeMap)) {
        if (main.toLowerCase().includes(en.toLowerCase())) return es;
      }
      return main;
    }

    function buildMetafields(card, foil) {
      const colorNames = { W: 'Blanco', U: 'Azul', B: 'Negro', R: 'Rojo', G: 'Verde' };
      const colorList = (card.colors || []).map(c => colorNames[c] || c);
      if (colorList.length === 0) colorList.push('Incolora');
      const legalFormats = Object.keys(card.legalities || {}).filter(k => card.legalities[k] === 'legal').map(f => f.charAt(0).toUpperCase() + f.slice(1));
      const mf = [
        { namespace: 'custom', key: 'scryfall_id', value: card.id, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'oracle_id', value: card.oracleId || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'set_single', value: JSON.stringify([card.setCode]), type: 'list.single_line_text_field' },
        { namespace: 'custom', key: 'collector_number', value: card.collectorNumber, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'foil', value: foil ? 'true' : 'false', type: 'boolean' },
        { namespace: 'custom', key: 'artist', value: card.artist || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'coste_de_mana_convertido', value: String(card.cmc || 0), type: 'number_integer' },
        { namespace: 'custom', key: 'single-color', value: JSON.stringify(colorList), type: 'list.single_line_text_field' },
        { namespace: 'custom', key: 'rarity', value: card.rarity, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'card_type', value: translateCardType(card.typeLine), type: 'single_line_text_field' },
        { namespace: 'custom', key: 'formato', value: JSON.stringify(legalFormats), type: 'list.single_line_text_field' },
        { namespace: 'custom', key: 'idioma', value: idiomaName(card.lang), type: 'single_line_text_field' },
        { namespace: 'custom', key: 'power', value: card.power || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'toughness', value: card.toughness || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'keywords', value: (card.keywords || []).join(', '), type: 'single_line_text_field' },
        { namespace: 'custom', key: 'released_at', value: card.releasedAt || '', type: 'date' },
        { namespace: 'custom', key: 'edicion', value: card.set_name, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'objeto', value: 'Carta', type: 'single_line_text_field' },
      ];

      return mf;
    }

    function rarityToSpanish(r) {
      const map = { common: 'Común', uncommon: 'Infrecuente', rare: 'Rara', mythic: 'Mítica' };
      return map[r?.toLowerCase()] || r;
    }

    function buildTitle(card, foil) {
      const langName = langTitleNames[card.lang] || card.lang;
      return `${card.name} Regular${foil ? ' Foil' : ''} (${langName}) ${card.collectorNumber}`;
    }

    // --- Load Card Kingdom prices ---
    let ckPrices = new Map();
    try {
      const ckRows = await p.cardKingdomPriceCache.findMany({
        select: { scryfallId: true, nonfoilPrice: true, foilPrice: true }
      });
      for (const r of ckRows) {
        ckPrices.set(r.scryfallId, { nonfoil: r.nonfoilPrice, foil: r.foilPrice });
      }
      log(`CK cache loaded: ${ckPrices.size} entries`);
    } catch (e) {
      log(`CK cache unavailable: ${e.message}`);
    }

    // --- English fallbacks for non-English cards ---
    // Non-English printings share the same oracle_id but have a different scryfall_id,
    // so the CK cache (keyed by scryfall_id) has no entry for them and Scryfall may
    // report no usd price. We load the English printing once and reuse its prices/
    // CK price for any non-English card with the same oracle_id.
    let enByOracle = new Map(); // oracle_id -> { usd, usdFoil, scryfallId }
    async function loadEnglishFallbacks() {
      let url = `/cards/search?q=set%3A${encodeURIComponent(setCode)}&order=set&unique=prints`;
      while (url) {
        const json = await scryfallFetch(url);
        for (const c of json.data || []) {
          if (c.lang !== 'en') continue;
          if (!c.oracle_id) continue;
          enByOracle.set(c.oracle_id, {
            usd: c.prices?.usd ? parseFloat(c.prices.usd) : null,
            usdFoil: c.prices?.usd_foil ? parseFloat(c.prices.usd_foil) : null,
            scryfallId: c.id,
          });
        }
        url = json.has_more && json.next_page ? json.next_page.replace(/^https?:\/\/api\.scryfall\.com/, '') : null;
      }
      log(`English fallbacks loaded: ${enByOracle.size} oracle_ids`);
    }
    try {
      await loadEnglishFallbacks();
    } catch (e) {
      log(`English fallbacks unavailable: ${e.message || e}`);
    }

    // Resolve a price for a (possibly non-English) card.
    // Priority: 1) CK by own scryfall_id, 2) English sibling (by oracle_id) CK price
    // or its Scryfall usd, 3) own Scryfall usd.
    function resolvePrice(card, foil) {
      const ownCk = ckPrices.get(card.id);
      if (ownCk) {
        const v = parseFloat(foil ? (ownCk.foil || ownCk.nonfoil) : (ownCk.nonfoil || ownCk.foil));
        if (!isNaN(v) && v > 0) return v;
      }
      const en = enByOracle.get(card.oracleId);
      if (en) {
        const enCk = ckPrices.get(en.scryfallId);
        if (enCk) {
          const v = parseFloat(foil ? (enCk.foil || enCk.nonfoil) : (enCk.nonfoil || enCk.foil));
          if (!isNaN(v) && v > 0) return v;
        }
        const enUsd = foil ? en.usdFoil : en.usd;
        if (enUsd && enUsd > 0) return enUsd;
      }
      const ownUsd = foil ? card.usdFoilPrice : card.usdPrice;
      if (ownUsd && ownUsd > 0) return ownUsd;
      return 0;
    }

    // --- Load existing Scryfall IDs from local DB to skip duplicates ---
    const existingScryfallIds = new Set();
    try {
      const ids = await p.importedScryfallId.findMany({ select: { scryfallId: true } });
      for (const r of ids) existingScryfallIds.add(r.scryfallId);
    } catch (e) {
      log(`Could not load imported IDs: ${e.message || e}`);
    }
    log(`Existing Scryfall IDs in DB: ${existingScryfallIds.size}`);

    // Whitelist mode (Excel import): trust the store, not the dedup table.
    // Fetch the set's existing variant SKUs so we only skip what is really published,
    // and create a marked card's finish (foil/nonfoil) even if its scryfall_id is
    // listed as "already imported" in the dedup table.
    const whitelistMode = allowedFinishes ? true : !!allowedCardIds;
    let existingVariantSkus = new Set();
    if (whitelistMode) {
      try {
        existingVariantSkus = await fetchExistingVariantSkus();
        log(`Whitelist mode: existing SKUs in store for ${setCode}: ${existingVariantSkus.size}`);
      } catch (e) {
        log(`Could not load existing SKUs: ${e.message || e}`);
      }
    }

    // --- Import each page ---
    let pageUrl = null;
    let totalCards = 0;
    let created = 0;
    let failed = 0;
    let skipped = 0;
    let scryfallEmpty = false;

    const descriptionHtml = genericDescription || '';

    // In whitelist mode (Excel import) the total is the number of selected variants,
    // not Scryfall's inflated total_cards (which counts every language/finish print).
    if (whitelistMode) {
      totalCards = (cardSelections && cardSelections.length > 0)
        ? cardSelections.length
        : (cardIds && cardIds.length > 0 ? cardIds.length : 0);
    }

    do {
      const page = await getSetCardsPage(setCode, pageUrl);
      pageUrl = page.nextPage;
      if (!whitelistMode) totalCards = page.total;

      for (const card of page.cards) {
        // Whitelist mode: skip only if the exact variant SKU is already in the store.
        // Otherwise (normal set import) skip by dedup scryfall_id.
        if (!whitelistMode && existingScryfallIds.has(card.id)) continue;
        // Card-level whitelist: skip if this card is not in the list of selected card IDs.
        if (allowedCardIds && !allowedCardIds.has(card.id)) continue;
        // Finish-level whitelist: skip if the card is not selected at all.
        if (allowedFinishes && !allowedFinishes.has(card.id)) continue;

        const finishes = [];
        if (card.hasNonfoil) finishes.push({ foil: false, price: resolvePrice(card, false) });
        if (card.hasFoil) finishes.push({ foil: true, price: resolvePrice(card, true) });

        // Finish-level whitelist: only keep the finishes the user marked for this card.
        const allowedFoilSet = allowedFinishes ? allowedFinishes.get(card.id) : null;
        const keptFinishes = allowedFoilSet ? finishes.filter((f) => allowedFoilSet.has(f.foil)) : finishes;

        for (const finish of keptFinishes) {
          const cardLangSuffix = card.lang === 'en' ? '' : card.lang;
          const sku = `${card.setCode}${card.collectorNumber}${cardLangSuffix}${finish.foil ? 'foil' : ''}`;
          // Stock provided via Excel for this exact variant.
          const variantStock = stockByVariant ? (stockByVariant.get(`${card.id}|${finish.foil ? 1 : 0}`) || 0) : 0;
          // Whitelist mode: this exact variant is already published.
          if (whitelistMode && existingVariantSkus.has(sku.toLowerCase())) {
            await recordExisting(card.id, card.name, sku, finish.foil, variantStock);
            continue;
          }
          const title = buildTitle(card, finish.foil);
          const finishTag = finish.foil ? 'foil' : 'nonfoil';

          const input = {
            title,
            descriptionHtml,
            vendor: '',
            productType: 'singlemtg',
            category: 'gid://shopify/TaxonomyCategory/tg-2-7',
            status: createAsActive ? 'ACTIVE' : 'DRAFT',
            published: true,
            tags: [card.setCode.toUpperCase(), card.rarity, finishTag, `setcode-${card.setCode}`, 'singlemtg'].join(','),
            templateSuffix: 'singles',
            metafields: buildMetafields(card, finish.foil),
          };

          const result = await graphql(
            `mutation CreateProduct($input: ProductInput!) {
              productCreate(input: $input) {
                product { id title }
                userErrors { field message }
              }
            }`,
            { input }
          );

          const apiErrors = result.errors || [];
          const userErrors = result.data?.productCreate?.userErrors || [];
          const productId = result.data?.productCreate?.product?.id;

          if (apiErrors.length > 0 || userErrors.length > 0) {
            failed++;
            const msgs = [...apiErrors.map(e => e.message), ...userErrors.map(e => `${e.field}: ${e.message}`)];
            log(`ERROR ${sku}: ${msgs.join(', ')}`);
            continue;
          }
          if (!productId) {
            failed++;
            log(`ERROR ${sku}: no product ID returned`);
            continue;
          }

          // Fetch variant ID
          const variantResult = await graphql(
            `query GetVariant($productId: ID!) {
              product(id: $productId) {
                variants(first: 1) { edges { node { id inventoryItem { id } } } }
              }
            }`,
            { productId }
          );
          const variant = variantResult.data?.product?.variants?.edges?.[0]?.node;
          if (!variant) {
            failed++;
            log(`ERROR ${sku}: no variant found`);
            continue;
          }

          // Update price and SKU via REST
          const variantNumericId = variant.id.split('/').pop();
          const restUrl = `https://${shop}/admin/api/${SHOPIFY_API_VERSION}/variants/${variantNumericId}.json`;
          const restResp = await fetch(restUrl, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
            body: JSON.stringify({ variant: { id: variantNumericId, price: Math.round(finish.price * CLP_RATE).toString(), sku, inventory_management: 'shopify', requires_shipping: true } }),
          });
          const restJson = await restResp.json();
          if (!restResp.ok || restJson.errors) {
            failed++;
            log(`ERROR ${sku}: REST variant update failed`);
            continue;
          }

          // Enable inventory tracking
          const invId = variant.inventoryItem?.id;
          if (invId) {
            const invNumericId = invId.split('/').pop();
            const trackResp = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/inventory_items/${invNumericId}.json`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
              body: JSON.stringify({ inventory_item: { id: invNumericId, tracked: true } }),
            });
            const trackJson = await trackResp.json();
            if (!trackResp.ok) {
              log(`WARN ${sku}: inventory tracking failed: ${JSON.stringify(trackJson)}`);
            }
            // Apply the stock provided via Excel (only when > 0).
            if (variantStock > 0) {
              await applyVariantStock(variant.inventoryItem.id, variantStock);
            }
          }

          // Add product image
          if (card.imageUrl) {
            const imgResult = await graphql(
              `mutation AddMedia($productId: ID!, $media: [CreateMediaInput!]!) {
                productCreateMedia(productId: $productId, media: $media) {
                  mediaUserErrors { field message }
                }
              }`,
              { productId, media: [{ mediaContentType: 'IMAGE', originalSource: card.imageUrl, alt: card.name }] }
            ).catch(() => null);
          }

          created++;
          existingScryfallIds.add(card.id);
          // Save to DB for future dedup
          p.importedScryfallId.create({ data: { scryfallId: card.id } }).catch(() => {});

          // Update progress
          await p.setImportJob.update({
            where: { id: jobId },
            data: { total: totalCards, processed: created + failed + skipped, created, failed, skipped },
          }).catch(() => {});

          // Check for cancellation every 10 products
          if (created % 10 === 0) {
            const current = await p.setImportJob.findUnique({ where: { id: jobId }, select: { status: true } }).catch(() => null);
            if (current?.status === 'cancelled') {
              log('Cancelled by user');
              await p.$disconnect();
              process.exit(0);
            }
          }
        }
      }

      // Force GC hint between pages
      if (global.gc) global.gc();

    } while (pageUrl);

    const langName = langTitleNames[langFilter] || langFilter;
    const message = scryfallEmpty && created === 0
      ? `Este set no tiene cartas en ${langName}`
      : null;

    await p.setImportJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        total: created + failed + skipped,
        processed: created + failed + skipped,
        created,
        failed,
        skipped,
        message,
        existingItems: existingItems.length > 0 ? JSON.stringify(existingItems) : null,
        finishedAt: new Date(),
      },
    });

    log(`DONE: created=${created} failed=${failed} skipped=${skipped} existing=${existingItems.length}`);
    await p.$disconnect();
  } catch (error) {
    await failJob(error.message);
  }
}

main();
