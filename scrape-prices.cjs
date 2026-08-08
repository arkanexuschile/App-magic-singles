const XLSX = require('xlsx');
const path = require('path');

const EXCEL_PATH = path.join(process.env.USERPROFILE, 'Downloads', 'Revision_precios.xlsx');
const CLP_RATE = 1000;

// Extract card name from title like "Bilbo's Deadly Slice Regular Foil (ingles) 62"
function extractCardName(title) {
  return (title || '').split(' Regular')[0].split(' Foil')[0].split(' Extended')[0].trim();
}

// Scrape CK for a card price
async function scrapeCKPrice(cardName, setCode, foil) {
  const searchTerm = encodeURIComponent(`${cardName} ${setCode}`);
  // Try CK search first
  try {
    const searchUrl = `https://www.cardkingdom.com/catalog/search?search=header&filter%5Bname%5D=${encodeURIComponent(cardName)}&filter%5Bedition_eq%5D=${setCode.toUpperCase()}`;
    const res = await fetch(searchUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    const html = await res.text();
    
    // Look for price pattern: $XX.XX
    // CK shows prices in the search results as "addToCart" data-price attribute
    const priceMatches = html.match(/data-price="(\d+\.\d+)"/g);
    if (!priceMatches) return null;
    
    for (const m of priceMatches) {
      const price = parseFloat(m.match(/"(\d+\.\d+)"/)[1]);
      if (price > 0) return price;
    }
    
    // Try alt pattern: $XX.XX in text
    const altMatch = html.match(/\$(\d+\.\d+)/);
    if (altMatch) return parseFloat(altMatch[1]);
    
  } catch (e) {
    // Timeout or network error
  }
  return null;
}

async function main() {
  const wb = XLSX.readFile(EXCEL_PATH);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  const h = data[0];
  
  const titleCol = h.indexOf('Title');
  const skuCol = h.indexOf('Variant SKU');
  const newCol = h.indexOf('PRECIO ACTUALIZADO 0708');

  // Find unmatched
  const unmatched = [];
  for (let i = 1; i < data.length; i++) {
    const sku = data[i][skuCol]?.toString().trim();
    const price = data[i][newCol];
    if ((!price || price === '' || price === 0) && sku) {
      unmatched.push(i);
    }
  }
  console.log(`Unmatched: ${unmatched.length}`);
  
  let scraped = 0;
  for (let j = 0; j < unmatched.length; j++) {
    const i = unmatched[j];
    const title = (data[i][titleCol] || '').toString().trim();
    const sku = (data[i][skuCol] || '').toString().trim();
    const cardName = extractCardName(title);
    const setCode = sku.replace(/[0-9].*/, '').toLowerCase(); // hob, hoc, etc.
    const isFoil = sku.toLowerCase().includes('foil');
    
    const price = await scrapeCKPrice(cardName, setCode, isFoil);
    if (price && price > 0) {
      data[i][newCol] = Math.round(price * CLP_RATE);
      scraped++;
    }
    
    if ((j + 1) % 20 === 0) console.log(`  ${j + 1}/${unmatched.length} done, ${scraped} found`);
    
    // Delay to avoid rate limiting
    await new Promise(r => setTimeout(r, 500));
  }
  
  console.log(`Scraped: ${scraped}/${unmatched.length}`);
  
  const newWs = XLSX.utils.aoa_to_sheet(data);
  wb.Sheets[wb.SheetNames[0]] = newWs;
  XLSX.writeFile(wb, EXCEL_PATH);
  console.log('Saved!');
}

main().catch(e => console.error(e));
