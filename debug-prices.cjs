const { PrismaClient } = require('@prisma/client');
const path = require('path');
const DB_PATH = path.join(process.env.TEMP || '/tmp', 'remote-dev.sqlite');
const p = new PrismaClient({ datasourceUrl: `file:${DB_PATH}` });

async function main() {
  // Search for a specific HOB card
  const sid = '17892c93-b9b2-4720-933b-998ed0200492';
  const exact = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: sid } });
  console.log('Exact match:', !!exact);
  
  // Search with LIKE
  const like = await p.cardKingdomPriceCache.findMany({ 
    where: { scryfallId: { contains: '17892c93' } },
    take: 3
  });
  console.log('LIKE matches:', like.length);
  if (like.length > 0) console.log('  Found:', like[0].scryfallId, 'len:', like[0].scryfallId.length);
  console.log('  Searched:', sid, 'len:', sid.length);
  
  // Check if there's a format difference
  const row = await p.cardKingdomPriceCache.findFirst({
    where: { scryfallId: { startsWith: '17892c93' } }
  });
  console.log('Starts with:', !!row);
  if (row) console.log('  DB value:', row.scryfallId);
  
  await p.$disconnect();
}
main().catch(e => { console.error(e); p.$disconnect(); });
