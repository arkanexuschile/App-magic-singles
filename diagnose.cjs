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
  const newCol = h.indexOf('PRECIO ACTUALIZADO 0708');

  // Collect unmatched entries
  const unmatched = [];
  for (let i = 1; i < data.length; i++) {
    const sku = data[i][skuCol]?.toString().trim();
    const sid = data[i][sidCol]?.toString().trim();
    const price = data[i][newCol];
    if ((!price || price === '' || price === 0) && sku) {
      unmatched.push({ row: i, sku, sid });
    }
  }

  console.log(`Unmatched: ${unmatched.length}/${data.length - 1}\n`);

  // Analyze SKU patterns
  const patterns = new Map();
  for (const u of unmatched) {
    // Try different regex patterns
    let cat = 'unknown';
    if (/^[a-z]+\d+$/i.test(u.sku)) cat = 'setCN (no foil)';
    else if (/^[a-z]+\d+foil$/i.test(u.sku)) cat = 'setCNfoil';
    else if (/[a-z]+\d+-[a-z0-9]+/i.test(u.sku)) cat = 'setCN-suffix';
    else if (/\d+$/.test(u.sku)) cat = 'ends with number';
    else cat = `other: "${u.sku}"`;
    if (!patterns.has(cat)) patterns.set(cat, []);
    patterns.get(cat).push(u);
  }

  console.log('SKU patterns in unmatched:');
  for (const [p, arr] of patterns) {
    console.log(`  ${p}: ${arr.length} cards`);
    if (arr.length <= 5) arr.forEach(u => console.log(`    ${u.sku} (sid: ${u.sid?.slice(0,12)})`));
    else arr.slice(0, 5).forEach(u => console.log(`    ${u.sku} ...`));
  }

  // Check: how many unmatched have "foil" in SKU?
  const foilUnmatched = unmatched.filter(u => u.sku.toLowerCase().includes('foil'));
  console.log(`\nFoil in unmatched: ${foilUnmatched.length}/${unmatched.length}`);

  // Sample CK cache SKU entries to understand format
  console.log('\nCK SKU entries sample:');
  const samples = await p.cardKingdomPriceCache.findMany({
    where: { scryfallId: { startsWith: 'sku:' } },
    take: 10,
    orderBy: { scryfallId: 'asc' }
  });
  for (const s of samples) {
    console.log(`  ${s.scryfallId} nf=${s.nonfoilPrice} f=${s.foilPrice}`);
  }

  // Check: for "setCNfoil" unmatched, does the SKU key exist in CK?
  const m = unmatched.find(u => /^[a-z]+\d+foil$/i.test(u.sku));
  if (m) {
    const set = m.sku.match(/^[a-z]+/i)?.[0].toLowerCase();
    const cn = m.sku.match(/\d+/)?.[0];
    const lookupKey = `sku:${set}:${cn}:foil`;
    const ck = await p.cardKingdomPriceCache.findUnique({ where: { scryfallId: lookupKey } });
    console.log(`\nTest lookup for "${m.sku}" -> "${lookupKey}": ${!!ck}`);
    if (ck) console.log(`  Found: nf=${ck.nonfoilPrice} f=${ck.foilPrice}`);
    
    // Search for similar keys in CK
    const similar = await p.cardKingdomPriceCache.findMany({
      where: { scryfallId: { startsWith: `sku:${set}:` } },
      take: 5
    });
    console.log(`  Similar SKU entries for "${set}":`);
    for (const s of similar) console.log(`    ${s.scryfallId} nf=${s.nonfoilPrice} f=${s.foilPrice}`);
  }

  await p.$disconnect();
}
main().catch(e => { console.error(e); p.$disconnect(); });
