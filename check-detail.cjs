const XLSX = require('xlsx');
const path = require('path');
const f = path.join(process.env.USERPROFILE, 'Downloads', 'Revision_precios.xlsx');
const wb = XLSX.readFile(f);
const data = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
const newCol = 27;
let found = 0;
for (let i = 1; i < data.length; i++) {
  const v = data[i][newCol];
  if (v !== '' && v !== undefined && v !== null) {
    console.log(`Row ${i}: sku=${data[i][11]} scryfall=${data[i][1].slice(0,12)} PRICE=${v} type=${typeof v}`);
    found++;
    if (found >= 5) break;
  }
}
