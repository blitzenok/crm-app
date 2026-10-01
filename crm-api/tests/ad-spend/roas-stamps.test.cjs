'use strict';
// The ROAS change in crm-app: one attribution line of orders-model.js carries source, medium, click and click_id of the trail, and the three
// pages that load the file stamp it with the first 10 hex of its sha256 (a wrong stamp serves the old file from the browser cache). The deploy
// patch / unpatch scripts and their tests live in biofirst-hosting (services/ad-spend).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { CRM_DIR, loadOrdersModel } = require('./helpers.cjs');

const read = f => fs.readFileSync(path.join(CRM_DIR, f), 'utf8');
const sha10 = t => crypto.createHash('sha256').update(t).digest('hex').slice(0, 10);

test('orders-model.js keeps medium, click and click_id next to source, each cut to its length and lower-cased (click_id as it came)', () => {
  const src = read('orders-model.js');
  assert.ok(src.includes("source: text(raw.attribution && raw.attribution.source).slice(0, 40).toLowerCase(),"));
  assert.ok(src.includes("medium: text(raw.attribution && raw.attribution.medium).slice(0, 40).toLowerCase(),"));
  assert.ok(src.includes("click: text(raw.attribution && raw.attribution.click).slice(0, 20).toLowerCase(),"));
  assert.ok(src.includes("click_id: text(raw.attribution && raw.attribution.click_id).slice(0, 200)"));
  const OM = loadOrdersModel();
  const r = OM.load([{ ref: 'BLR-1', customer: { email: 'a@x.com' }, savedAt: '2026-09-10T10:00:00Z', total_due_server: '10.00', status: 'new', items: [],
    attribution: { source: 'Meta', medium: 'Paid_Social', click: 'FBCLID', click_id: 'IwAR0AbC' } }])[0];
  assert.deepEqual(r.attribution, { source: 'meta', medium: 'paid_social', click: 'fbclid', click_id: 'IwAR0AbC' });
  assert.deepEqual(OM.load([{ ref: 'BLR-2', customer: { email: 'b@x.com' }, savedAt: '2026-09-10T10:00:00Z', total_due_server: '10.00', status: 'new', items: [] }])[0].attribution,
    { source: '', medium: '', click: '', click_id: '' }, 'an order with no trail still reads');
});

test('the three pages stamp orders-model.js with the sha of the file', () => {
  const stamp = sha10(read('orders-model.js'));
  for (const page of ['orders.html', 'dashboard.html', 'finance-reports.html']) {
    const m = read(page).match(/orders-model\.js\?v=([0-9a-f]{10})/g);
    assert.equal(m && m.length, 1, page + ': one stamp');
    assert.equal(m[0], 'orders-model.js?v=' + stamp, page);
  }
});
