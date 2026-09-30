'use strict';
// One-time Sheets → leads.json import. Never prints tokens/secrets.
const path = require('path');
const fs = require('fs');
const store = require('./leads-store.cjs');
const DATA_DIR = path.join(__dirname, 'data');
const file = path.join(DATA_DIR, 'leads.json');
function writeLeads(leads) {
  const tmp = file + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(leads, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}
function readLeads() {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch { return []; }
}
(async () => {
  try {
    const result = await store.importFromSheets({ DATA_DIR, file, writeLeads, readLeads });
    const safe = { ok: !!result.ok, imported: result.imported || 0, total: result.total || 0, error: result.error || null, note: result.note || null };
    console.log(JSON.stringify(safe));
    if (!result.ok) {
      if (!fs.existsSync(file)) writeLeads([]);
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    console.error('import_failed', e.message);
    if (!fs.existsSync(file)) writeLeads([]);
    process.exit(1);
  }
})();
