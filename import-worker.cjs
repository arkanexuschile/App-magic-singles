// Child process: imports a set into Shopify (no Remix, no framework)
const { PrismaClient } = require('@prisma/client');

const SHOPIFY_API_VERSION = '2025-01';
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
        { namespace: 'custom', key: 'set_code', value: card.setCode, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'collector_number', value: card.collectorNumber, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'foil', value: foil ? 'true' : 'false', type: 'boolean' },
        { namespace: 'custom', key: 'rarity', value: card.rarity, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'card_types', value: card.typeLine, type: 'single_line_text_field' },
        { namespace: 'custom', key: 'language', value: card.lang === 'en' ? 'Inglés' : card.lang, type: 'single_line_text_field' },
      ];
      if (card.artist) mf.push({ namespace: 'custom', key: 'artist', value: card.artist, type: 'single_line_text_field' });
      if (card.colors.length) mf.push({ namespace: 'custom', key: 'colors', value: card.colors.join(','), type: 'single_line_text_field' });
      if (card.keywords.length) mf.push({ namespace: 'custom', key: 'keywords', value: card.keywords.join(', '), type: 'single_line_text_field' });
      return mf;
    }

    function rarityToSpanish(r) {
      const map = { common: 'Común', uncommon: 'Infrecuente', rare: 'Rara', mythic: 'Mítica' };
      return map[r?.toLowerCase()] || r;
    }

    function buildTitle(card, foil) {
      let t = card.name;
      const parts = [];
      if (card.power && card.toughness) parts.push(`${card.power}/${card.toughness}`);
      if (card.manaCost) parts.push(card.manaCost);
      if (parts.length) t += ` (${parts.join(' - ')})`;
      t += ` - ${rarityToSpanish(card.rarity)}`;
      if (foil) t += ' FOIL';
      t += ` (${card.setCode.toUpperCase()}) ${card.collectorNumber}`;
      return t;
    }

    // --- Import each page ---
    let pageUrl = null;
    let totalCards = 0;
    let created = 0;
    let failed = 0;

    const descriptionHtml = genericDescription ? genericDescription.replace(/\n/g, '<br>') : '';

    do {
      const page = await getSetCardsPage(setCode, pageUrl);
      pageUrl = page.nextPage;
      totalCards = page.total;

      for (const card of page.cards) {
        const finishes = [];
        if (card.hasNonfoil) finishes.push({ foil: false, price: card.usdPrice || 0 });
        if (card.hasFoil) finishes.push({ foil: true, price: card.usdFoilPrice || 0 });

        for (const finish of finishes) {
          const sku = `${card.setCode}${card.collectorNumber}${finish.foil ? 'foil' : ''}`;
          const title = buildTitle(card, finish.foil);
          const finishTag = finish.foil ? 'foil' : 'nonfoil';

          const input = {
            title,
            descriptionHtml,
            vendor: card.set_name,
            productType: 'Magic: The Gathering Single',
            status: createAsActive ? 'ACTIVE' : 'DRAFT',
            tags: [card.setCode.toUpperCase(), card.rarity, finishTag, `set:${card.setCode}`].join(','),
            metafields: buildMetafields(card, finish.foil),
            variants: [{ price: finish.price.toFixed(2), sku }],
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

          const userErrors = result.data?.productCreate?.userErrors || [];
          if (userErrors.length > 0) {
            failed++;
            log(`ERROR ${sku}: ${userErrors.map(e => e.message).join(', ')}`);
          } else {
            created++;
          }

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
