async function test() {
  // Try CK API endpoints for a specific card
  const apiBase = 'https://api.cardkingdom.com';
  const sku = 'FHOB-0259';
  
  // Try various API endpoints
  const urls = [
    `${apiBase}/api/card/${sku}`,
    `${apiBase}/api/v2/card/${sku}`,
    `${apiBase}/api/product/${sku}`,
    `https://www.cardkingdom.com/api/mtg/card/${sku}`,
  ];
  
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      console.log(`${url.split('/').pop()}: ${res.status} ${res.status > 400 ? '' : await res.text().then(t => t.slice(0,100))}`);
    } catch(e) { console.log(`${url.split('/').pop()}: ${e.message}`); }
  }
}
test();
