const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const EXCEL_PATH = path.join(process.env.USERPROFILE, 'Downloads', 'Revision_precios.xlsx');
const DB_PATH = path.join(process.env.TEMP || '/tmp', 'remote-dev.sqlite');
const p = new PrismaClient({ datasourceUrl: `file:${DB_PATH}` });

async function main() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const h = data[0];
  const sidCol = h.indexOf('scryfall_id');
  const skuCol = h.indexOf('Variant SKU');
  const titleCol = h.indexOf('Title');
  const newCol = h.indexOf('PRECIO ACTUALIZADO 0708');

  const unmatched = [];
  for (let i = 1; i < data.length; i++) {
    const price = data[i][newCol];
    const sku = data[i][skuCol];
    if ((!price || price === '' || price === 0) && sku) {
      unmatched.push(i);
    }
  }
  console.log(`Unmatched: ${unmatched.length}`);
  
  // Group by set
  const bySet = new Map();
  for (const i of unmatched) {
    const sku = (data[i][skuCol] || '').toString().trim();
    const set = sku.replace(/[0-9].*/, '').toLowerCase();
    if (!bySet.has(set)) bySet.set(set, []);
    bySet.get(set).push(sku);
  }
  console.log('\nBy set:');
  for (const [set, skus] of bySet) {
    console.log(`  ${set}: ${skus.length} cards`);
    console.log(`    SKUs: ${skus.slice(0,5).join(', ')}${skus.length > 5 ? '...' : ''}`);
    
    // Check a sample in CK
    const sampleSku = skus[0];
    const sampleFoiled = sampleSku.toLowerCase().includes('foil');
    const sampleSet = sampleSku.replace(/[0-9].*/, '').toLowerCase();
    const sampleCn = sampleSku.match(/\d+/)?.[0];
    const skuKey = `sku:${sampleSet}:${sampleCn}:${sampleFoiled ? 'foil' : 'nonfoil'}`;
    const ck = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: skuKey } });
    console.log(`    Test ${skuKey}: ${ck ? 'FOUND' : 'NOT FOUND'}`);
    
    // Check alternate finish
    const altKey = `sku:${sampleSet}:${sampleCn}:${sampleFoiled ? 'nonfoil' : 'foil'}`;
    const ck2 = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: altKey } });
    console.log(`    Test ${altKey}: ${ck2 ? 'FOUND' : 'NOT FOUND'}`);
    
    // Check scryfall
    const sid = data[unmatched.find(u => data[u][skuCol].includes(sampleSku))][sidCol];
    if (sid) {
      const ck3 = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: sid.toString().trim() } });
      console.log(`    Scryfall ${sid?.toString().slice(0,12)}: ${ck3 ? 'FOUND' : 'NOT FOUND'}`);
    }
  }
  await p.$disconnect();
}
main();
