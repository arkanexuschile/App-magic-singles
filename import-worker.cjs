// Child process: imports a set into Shopify (no Remix, no framework)
const { PrismaClient } = require('@prisma/client');

const SHOPIFY_API_VERSION = '2025-01';
const CLP_RATE = 1000;
const SCRYFALL_MIN_INTERVAL = 100;

async function main() {
  const args = JSON.parse(process.argv[2]);
  const { jobId, shop, accessToken, setCode, createAsActive, genericDescription, dbUrl } = args;

  const p = new PrismaClient({ datasourceUrl: dbUrl || process.env.DATABASE_URL });

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
      if (!response.ok) throw new Error(`Scryfall ${response.status}`);
      return response.json();
    }

    async function getSetCardsPage(code, pageUrl) {
      const url = pageUrl || `/cards/search?q=set%3A${code}&order=set&unique=prints`;
      const json = await scryfallFetch(url);
      const cards = json.data
        .filter(c => c.lang === 'en' && c.layout !== 'art_series')
        .map(c => ({
          id: c.id,
          name: c.name,
          setCode: c.set,
          set_name: c.set_name,
          collectorNumber: c.collector_number,
          rarity: c.rarity,
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
        nextPage: json.has_more ? json.next_page : null,
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

    // --- Build product input ---
    function buildMetafields(card, foil) {
      const mf = [
        { namespace: 'custom', key: 'scryfall_id', value: card.id, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'oracle_id', value: card.oracleId || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'set_single', value: JSON.stringify([card.setCode]), type: 'list.single_line_text_field' },
        { namespace: 'custom', key: 'collector_number', value: card.collectorNumber, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'foil', value: foil ? 'true' : 'false', type: 'boolean' },
        { namespace: 'custom', key: 'artist', value: card.artist || '', type: 'single_line_text_field' },
        { namespace: 'custom', key: 'coste_de_mana_convertido', value: String(card.cmc || 0), type: 'number_integer' },
        { namespace: 'custom', key: 'single-color', value: JSON.stringify(card.colors || []), type: 'list.single_line_text_field' },
        { namespace: 'custom', key: 'rarity', value: card.rarity, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'card_type', value: card.typeLine, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'formato', value: JSON.stringify(Object.keys(card.legalities || {}).filter(k => card.legalities[k] === 'legal')), type: 'list.single_line_text_field' },
        { namespace: 'custom', key: 'idioma', value: card.lang === 'en' ? 'Inglés' : (card.lang || ''), type: 'single_line_text_field' },
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
      return `${card.name} Regular${foil ? ' Foil' : ''} (ingles) ${card.collectorNumber}`;
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

    // --- Import each page ---
    let pageUrl = null;
    let totalCards = 0;
    let created = 0;
    let failed = 0;

    const descriptionHtml = genericDescription || '';

    do {
      const page = await getSetCardsPage(setCode, pageUrl);
      pageUrl = page.nextPage;
      totalCards = page.total;

      for (const card of page.cards) {
        const finishes = [];
        if (card.hasNonfoil) { let p = card.usdPrice || 0; const ck = ckPrices.get(card.id); if (ck?.nonfoil) { const v = parseFloat(ck.nonfoil); if (!isNaN(v) && v > 0) p = v; } finishes.push({ foil: false, price: p }); }
        if (card.hasFoil) { let p = card.usdFoilPrice || 0; const ck = ckPrices.get(card.id); if (ck?.foil) { const v = parseFloat(ck.foil); if (!isNaN(v) && v > 0) p = v; } finishes.push({ foil: true, price: p }); }

        for (const finish of finishes) {
          const sku = `${card.setCode}${card.collectorNumber}${finish.foil ? 'foil' : ''}`;
          const title = buildTitle(card, finish.foil);
          const finishTag = finish.foil ? 'foil' : 'nonfoil';

          const input = {
            title,
            descriptionHtml,
            vendor: '',
            productType: 'Magic: The Gathering Single',
            status: createAsActive ? 'ACTIVE' : 'DRAFT',
            tags: [card.setCode.toUpperCase(), card.rarity, finishTag, `set:${card.setCode}`].join(','),
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
            body: JSON.stringify({ variant: { id: variantNumericId, price: Math.round(finish.price * CLP_RATE).toString(), sku } }),
          });
          const restJson = await restResp.json();
          if (!restResp.ok || restJson.errors) {
            failed++;
            log(`ERROR ${sku}: REST variant update failed`);
            continue;
          }

          // Set inventory to trackable at default location
          const invId = variant.inventoryItem?.id;
          if (invId) {
            const invNumericId = invId.split('/').pop();
            await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/inventory_levels/set.json`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
              body: JSON.stringify({ location_id: 1, inventory_item_id: invNumericId, available: 1 }),
            }).catch(() => {});
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

          // Update progress
          await p.setImportJob.update({
            where: { id: jobId },
            data: { total: totalCards, processed: created + failed, created, failed },
          }).catch(() => {});
        }
      }

      // Force GC hint between pages
      if (global.gc) global.gc();

    } while (pageUrl);

    await p.setImportJob.update({
      where: { id: jobId },
      data: {
        status: 'completed',
        total: created + failed,
        processed: created + failed,
        created,
        failed,
        finishedAt: new Date(),
      },
    });

    log(`DONE: created=${created} failed=${failed}`);
    await p.$disconnect();
  } catch (error) {
    await failJob(error.message);
  }
}

main();
