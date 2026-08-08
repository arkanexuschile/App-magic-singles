const { PrismaClient } = require('@prisma/client');
const path = require('path');
const p = new PrismaClient({ datasourceUrl: 'file:' + path.join(process.env.TEMP || '/tmp', 'remote-dev.sqlite') });

async function main() {
  // Check the specific card
  const sid = '79892a5d-80df-4ee1-b482-30e57aaabf21';
  const ck = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: sid } });
  console.log('By scryfall_id:', !!ck);
  if (ck) console.log('  nf:', ck.nonfoilPrice, 'f:', ck.foilPrice);
  
  // Check SKU key
  const sk = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: 'sku:hob:254:foil' } });
  console.log('By SKU:', !!sk);
  if (sk) console.log('  nf:', sk.nonfoilPrice, 'f:', sk.foilPrice);

  // Get the Excel row for this card
  const XLSX = require('xlsx');
  const EXCEL = path.join(process.env.USERPROFILE, 'Downloads', 'Revision_precios.xlsx');
  const wb = XLSX.readFile(EXCEL);
  const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  const sidCol = data[0].indexOf('scryfall_id');
  const skuCol = data[0].indexOf('Variant SKU');
  const newCol = data[0].indexOf('PRECIO ACTUALIZADO 0708');
  
  for (let i = 1; i < data.length; i++) {
    const s = (data[i][sidCol] || '').toString().trim();
    if (s === sid) {
      console.log(`\nExcel row ${i}: sku=${data[i][skuCol]} newCol=${data[i][newCol]} sid=${s.slice(0,12)}`);
      break;
    }
  }
  
  await p.$disconnect();
}
main();
