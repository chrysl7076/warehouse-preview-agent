// Writes the sample site to data/ as JSON (site + rules) and CSV (every pallet position).
// Run: node scripts/export-data.js
const fs = require('fs');
const path = require('path');
const W = require('../src/core.js');

const slots = W.generateSlots(2026);
const model = new W.WarehouseModel(slots);
const out = path.join(__dirname, '..', 'data');
fs.mkdirSync(out, { recursive: true });

fs.writeFileSync(path.join(out, 'slots.csv'), W.toCSV(slots));
fs.writeFileSync(path.join(out, 'site.json'), JSON.stringify({
  site: W.SITE, geometry_m: W.GEOM, assumptions: W.ASSUMPTIONS,
  zones: W.ZONES, docks: W.DOCKS, not_offered: W.NOT_OFFERED,
  csv_columns: W.CSV_COLUMNS, summary: model.siteSummary(),
}, null, 2));

console.log(JSON.stringify(model.siteSummary(), null, 2));
