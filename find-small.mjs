async function check(code, name) {
  const res = await fetch(`https://api.scryfall.com/cards/search?q=set%3A${code}+lang%3Aes&unique=prints&order=set`, {
    headers: { 'User-Agent': 'magic-pricer/1.0' }
  });
  const json = await res.json();
  console.log(`${code} (${name}): ${json.total_cards || 0} ES cards`);
}

async function main() {
  // Potentially small sets
  const codes = [
    ['spg', 'Special Guests'],
    ['big', 'Big Score'],
    ['otp', 'Breaking News'],
    ['otc', 'OTJ Commander'],
    ['moc', 'MH3 Commander'],
    ['lcc', 'LCI Commander'],
    ['40k', 'Warhammer 40K'],
    ['brc', 'Brothers War Commander'],
    ['dmu', 'Dominaria United Cmdr'],
    ['snc', 'New Capenna Cmdr'],
  ];
  for (const [c, n] of codes) {
    await check(c, n);
    await new Promise(r => setTimeout(r, 150));
  }
}
main();
