const { PrismaClient } = require('@prisma/client');
const path = require('path');
const p = new PrismaClient({ datasourceUrl: 'file:' + path.join(process.env.TEMP || '/tmp', 'remote-dev.sqlite') });

async function main() {
  // Check hob62
  const hob62 = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: 'sku:hob:62:foil' } });
  console.log('sku:hob:62:foil:', !!hob62, hob62?.foilPrice);
  
  const hob62nf = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: 'sku:hob:62:nonfoil' } });
  console.log('sku:hob:62:nonfoil:', !!hob62nf, hob62nf?.nonfoilPrice);

  // Check hob248 (should be between 204 and 251)
  const hob248 = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: 'sku:hob:248:foil' } });
  console.log('sku:hob:248:foil:', !!hob248);
  
  // Check hob251 and hob259
  console.log('sku:hob:251:foil:', !!(await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: 'sku:hob:251:foil' } })));
  console.log('sku:hob:259:foil:', !!(await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: 'sku:hob:259:foil' } })));

  // Count total hob entries
  const total = await p.cardKingdomPriceCache.count({ where: { scryfallId: { startsWith: 'sku:hob:' } } });
  console.log('Total hob entries:', total);
  
  await p.$disconnect();
}
main();
