const XLSX = require('xlsx');
const { PrismaClient } = require('@prisma/client');
const path = require('path');

const EXCEL_PATH = path.join(process.env.USERPROFILE, 'Downloads', 'Revision_precios.xlsx');
const DB_PATH = path.join(process.env.TEMP || '/tmp', 'remote-dev.sqlite');
const CLP_RATE = 1000;

const p = new PrismaClient({ datasourceUrl: `file:${DB_PATH}` });

async function main() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const header = data[0];

  const scryfallCol = header.indexOf('scryfall_id');
  const skuCol = header.indexOf('Variant SKU');
  const NEW_COL = 'PRECIO ACTUALIZADO 0708';

  // Remove existing
  const existingIdx = header.indexOf(NEW_COL);
  if (existingIdx >= 0) {
    header.splice(existingIdx, 1);
    for (let i = 1; i < data.length; i++) data[i].splice(existingIdx, 1);
  }

  // Insert after Precio CLP
  const insertAt = header.findIndex(h => h.includes('Precio CLP')) + 1;
  header.splice(insertAt, 0, NEW_COL);
  for (let i = 1; i < data.length; i++) data[i].splice(insertAt, 0, '');

  // Load ALL CK prices (both scryfall and SKU-based)
  console.log('Loading CK prices...');
  const ckPrices = new Map();
  const ckRows = await p.cardKingdomPriceCache.findMany({ select: { scryfallId: true, nonfoilPrice: true, foilPrice: true } });
  for (const r of ckRows) ckPrices.set(r.scryfallId, { nonfoil: r.nonfoilPrice, foil: r.foilPrice });
  console.log(`CK entries: ${ckPrices.size}`);

  function makeSkuKey(sku) {
    // "hob62foil" -> "hob:62:foil" or "hob62" -> "hob:62:nonfoil"
    const m = sku.match(/^([a-z]+)(\d+)(foil)?$/i);
    if (!m) return null;
    const set = m[1].toLowerCase();
    const cn = parseInt(m[2]).toString();
    const foil = m[3] ? 'foil' : 'nonfoil';
    return `sku:${set}:${cn}:${foil}`;
  }

  let updated = 0, notFound = 0;
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const sid = (row[scryfallCol] || '').toString().trim();
    const sku = (row[skuCol] || '').toString().trim();
    if (!sid && !sku) { notFound++; continue; }

    const isFoil = sku.toLowerCase().includes('foil');

    // Try scryfall_id first, then SKU key
    let ck = sid ? ckPrices.get(sid) : null;
    if (!ck && sku) {
      const skuKey = makeSkuKey(sku);
      if (skuKey) ck = ckPrices.get(skuKey);
    }

    if (!ck) { notFound++; continue; }

    // Prefer requested finish, fallback to other finish if null
    const price = parseFloat(isFoil ? (ck.foil || ck.nonfoil || '0') : (ck.nonfoil || ck.foil || '0'));
    if (price > 0) {
      row[insertAt] = Math.round(price * CLP_RATE);
      updated++;
    } else {
      notFound++;
    }
  }

  console.log(`Updated: ${updated}, Not found: ${notFound}`);
  console.log(`Total: ${data.length - 1}`);

  const newWs = XLSX.utils.aoa_to_sheet(data);
  wb.Sheets[wb.SheetNames[0]] = newWs;
  XLSX.writeFile(wb, EXCEL_PATH);
  console.log('Saved!');
  await p.$disconnect();
}

main().catch(e => { console.error(e); p.$disconnect(); process.exit(1); });
