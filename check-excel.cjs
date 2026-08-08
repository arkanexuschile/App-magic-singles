const XLSX = require('xlsx');
const path = require('path');
const EXCEL_PATH = path.join(process.env.USERPROFILE, 'Downloads', 'REVISIÓN_PRECIOS.xlsx');
const wb = XLSX.readFile(EXCEL_PATH);
const ws = wb.Sheets[wb.SheetNames[0]];
const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
console.log('Header length:', data[0].length);
console.log('Full header (all cols):');
data[0].forEach((h, i) => console.log(`  [${i}] "${h}"`));
console.log('\nFirst 3 data rows (cols 10-20):');
for (let i = 1; i <= 3; i++) {
  console.log(`Row ${i}:`, data[i].slice(10, 21));
}
