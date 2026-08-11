const { PrismaClient } = require('@prisma/client');
const path = require('path');
const p = new PrismaClient({ datasourceUrl: 'file:' + path.join(process.env.TEMP || '/tmp', 'remote-dev.sqlite') });
async function main() {
  const tests = ['sku:hoc:53:foil', 'sku:hoc:53:nonfoil', 'sku:hoc:54', 'sku:hoc:55'];
  for (const t of tests) {
    const r = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: t } });
    console.log(`${t}: ${r ? 'nf='+r.nonfoilPrice+' f='+r.foilPrice : 'NOT FOUND'}`);
  }
  // Count hoc entries
  const c = await p.cardKingdomPriceCache.count({ where: { scryfallId: { startsWith: 'sku:hoc:' } } });
  console.log(`\nTotal hoc SKU entries: ${c}`);
  
  // Show a sample
  const s = await p.cardKingdomPriceCache.findMany({
    where: { scryfallId: { startsWith: 'sku:hoc:' } },
    take: 10, orderBy: { scryfallId: 'asc' }
  });
  console.log('Sample hoc entries:');
  s.forEach(e => console.log(`  ${e.scryfallId} nf=${e.nonfoilPrice} f=${e.foilPrice}`));
  
  await p.$disconnect();
}
main();
