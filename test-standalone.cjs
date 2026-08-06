// Standalone import test - no shopify-app-remix, no scheduler, no CK warmup
const { PrismaClient } = require('/var/www/shopify-price-singles/node_modules/@prisma/client');
const p = new PrismaClient({ datasourceUrl: 'file:/var/www/shopify-price-singles/prisma/dev.sqlite' });

function mem(label) {
  const m = process.memoryUsage();
  console.log(`MEM ${label}: heap=${Math.round(m.heapUsed/1024/1024)}MB rss=${Math.round(m.rss/1024/1024)}MB`);
}

const SHOPIFY_API_VERSION = '2025-01';

async function shopifyGraphql(shop, token, query, variables) {
  const response = await fetch(`https://${shop}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': token,
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

async function main() {
  mem('start');
  const session = await p.session.findFirst();
  if (!session) { console.log('NO SESSION'); return; }
  const { shop, accessToken } = session;
  console.log('SHOP:', shop);

  // Fetch cards from Scryfall
  mem('before scryfall');
  const scryfallResp = await fetch(`https://api.scryfall.com/cards/search?q=set%3Afra&order=set&unique=prints`, {
    headers: { 'User-Agent': 'magic-pricer-singles/1.0' }
  });
  const scryfallJson = await scryfallResp.json();
  const cards = scryfallJson.data.filter(c => c.lang === 'en' && c.layout !== 'art_series');
  console.log(`CARDS: ${cards.length}`);
  mem('after scryfall');

  // Create each product
  let created = 0;
  for (let i = 0; i < Math.min(cards.length, 5); i++) {
    const card = cards[i];
    const sku = `fra${card.collector_number}`;
    const title = card.name;
    const price = card.prices.usd ? parseFloat(card.prices.usd) : 0;

    const input = {
      title,
      vendor: 'Magic: The Gathering',
      productType: 'Magic: The Gathering Single',
      status: 'DRAFT',
      tags: ['FRA', card.rarity, 'nonfoil', 'set:fra'].join(','),
      variants: [{ price: price.toFixed(2), sku }],
    };

    const result = await shopifyGraphql(shop, accessToken, `
      mutation CreateProduct($input: ProductInput!) {
        productCreate(input: $input) {
          product { id title }
          userErrors { field message }
        }
      }
    `, { input });

    if (result.data?.productCreate?.userErrors?.length) {
      console.log(`FAIL ${sku}: ${result.data.productCreate.userErrors.map(e => e.message).join(', ')}`);
    } else {
      created++;
      console.log(`OK ${sku} (${created}/${cards.length})`);
    }
    mem(`after product ${created}`);
  }

  console.log(`DONE: ${created} products`);
  mem('final');
  await p.$disconnect();
}

main().catch(e => { console.error(e); p.$disconnect(); });
