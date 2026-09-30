'use strict';
// adspend-section.js with a fake document and the page's globals: what is drawn, that every piece of user text is escaped,
// the form (POST body, the "other" source), delete with confirm, errors, and an older answer never drawing over a newer one.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { CRM_DIR, ADMODEL, ADSECTION } = require('./helpers.cjs');
const { loadJs } = require('./helpers.cjs');

loadJs(path.join(CRM_DIR, 'crm-utils.js'));           // the real esc / escAttr (they register on globalThis)
const OM = loadJs(path.join(CRM_DIR, 'orders-model.js'));
const FM = loadJs(path.join(CRM_DIR, 'finance-model.js'));
loadJs(ADMODEL);

const els = {};
function el(id) { return els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, style: {}, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } }); }
const bodyEl = { innerHTML: '' };
global.document = { getElementById: id => el(id), querySelector: sel => { assert.equal(sel, '#fin-adspend .fin-body'); return bodyEl; } };
let calls = [];
let apiImpl = async () => ({ entries: [] });
global.api = (p, o) => { calls.push({ path: p, opts: o }); return apiImpl(p, o); };
let confirmAnswer = true;
global.confirm = () => confirmAnswer;
global.periodVal = () => '30d';
global.paidOnlyVal = () => true;
global.OrdersModel = OM;
global.costIdx = FM.costIndex({ items: [{ id: 'bpc', cost: 10, source: 'purchase', match: [{ slug: 'bpc-157', mg: '10mg' }] }] });
const d = new Date();
const dayAgo = n => new Date(d.getTime() - n * 86400000).toISOString().slice(0, 10);
function rawOrder(ref, email, daysAgo, source, due, qty) {
  return { ref, customer: { email }, savedAt: new Date(d.getTime() - daysAgo * 86400000).toISOString(), total_due_server: due.toFixed(2), status: 'new',
    items: [{ slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty, price: due / qty }], attribution: source ? { source } : undefined,
    payments: [{ id: 'p' + ref, at: new Date(d.getTime() - daysAgo * 86400000).toISOString(), kind: 'payment', method: 'card', amount: due }] };
}
global.allOrders = OM.load([rawOrder('BLR-7001', 'a@x.com', 5, 'facebook', 100, 2), rawOrder('BLR-7002', 'b@x.com', 6, 'ram', 50, 1)]);
loadJs(ADSECTION);
const S = global.AdSpendSection;
const tick = () => new Promise(r => setImmediate(r));

const ENTRIES = [
  { id: 'sp_aaaaaaaaaaaa', date: dayAgo(3), source: 'facebook', campaign: 'Launch', amountCents: 25000, note: 'n1', createdBy: 'ann@example.com', createdAt: '' },
  { id: 'sp_bbbbbbbbbbbb', date: dayAgo(4), source: 'other:ram', campaign: '', amountCents: 10000, note: '', createdBy: 'bob@example.com', createdAt: '' },
  { id: 'sp_cccccccccccc', date: dayAgo(5), source: 'tiktok', campaign: '', amountCents: 5000, note: '', createdBy: 'bob@example.com', createdAt: '' }
];

test('render: fetches the period\'s entries, builds the form once, draws the table with a total row and the "no orders" flag', async () => {
  apiImpl = async () => ({ entries: ENTRIES, totalCents: 40000 });
  await S.render();
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /^\/api\/marketing\/spend\?from=\d{4}-\d{2}-\d{2}$/);
  assert.equal(calls[0].opts.toast, false);
  assert.match(bodyEl.innerHTML, /id="ad-form"/);
  assert.match(bodyEl.innerHTML, /<option value="meta">Meta \(facebook, instagram, fbclid\)<\/option>/);
  assert.doesNotMatch(bodyEl.innerHTML, /Direct/);
  assert.doesNotMatch(bodyEl.innerHTML, /value="facebook"|value="instagram"/);
  assert.match(bodyEl.innerHTML, /<option value="other">Other/);
  const roas = el('ad-roas').innerHTML;
  assert.match(roas, /data-table="adspend"/);
  assert.match(roas, /<th>Revenue<\/th>/);
  assert.match(roas, /data-key="meta"/);
  assert.match(roas, />\$250\.00</);                                       // facebook spend
  assert.match(roas, />\$100\.00</);                                       // facebook revenue
  assert.match(roas, />0\.40×</);                                     // 100 / 250
  assert.match(roas, /data-key="tiktok"[^]*?no orders/);                   // spend, no orders: the signal
  assert.match(roas, /class="ad-total"/);
  assert.match(roas, /Total/);
  assert.match(roas, /class="ad-total">[^]*Paid&#32;channels|class="ad-total">[^]*Paid channels/);
  assert.match(roas, /—/);                                            // dashes where a number would divide by zero
  assert.doesNotMatch(roas, /NaN|Infinity|undefined|null/);
  assert.match(el('ad-entries').innerHTML, /data-del="sp_aaaaaaaaaaaa"/);
  assert.match(el('ad-entries').innerHTML, /Other|Ram/);
  // a second render must not rebuild the form (typed text would be lost) but does fetch again
  el('ad-campaign').value = 'typed';
  const form = bodyEl.innerHTML;
  calls = [];
  await S.render();
  assert.equal(bodyEl.innerHTML, form);
  assert.equal(calls.length, 1);
  assert.equal(el('ad-campaign').value, 'typed');
});

test('every piece of user text is escaped: campaign, note, who added it, a source name', async () => {
  const evil = '<img src=x onerror=alert(1)>"\'';
  apiImpl = async () => ({ entries: [{ id: 'sp_dddddddddddd', date: dayAgo(1), source: 'other:' + 'x', campaign: evil, amountCents: 100, note: evil, createdBy: evil, createdAt: '' }] });
  await S.render();
  const all = el('ad-entries').innerHTML + el('ad-roas').innerHTML;
  assert.doesNotMatch(all, /<img/);
  assert.match(all, /&lt;img&#32;src&#61;x&#32;onerror&#61;alert\(1\)&gt;|&lt;img src=x onerror=alert\(1\)&gt;/);
  // a source label made from an order's attribution is text too
  global.allOrders = OM.load([rawOrder('BLR-7010', 'z@x.com', 2, 'a<b>c', 10, 1)]);
  await S.render();
  assert.doesNotMatch(el('ad-roas').innerHTML, /<b>/);
  global.allOrders = OM.load([rawOrder('BLR-7001', 'a@x.com', 5, 'facebook', 100, 2), rawOrder('BLR-7002', 'b@x.com', 6, 'ram', 50, 1)]);
});

test('submit: POST body with the typed values, the field cleared, the list reloaded, a readable message', async () => {
  apiImpl = async (p, o) => (o && o.method === 'POST' ? { entry: { id: 'sp_eeeeeeeeeeee' } } : { entries: ENTRIES.concat([{ id: 'sp_eeeeeeeeeeee', date: dayAgo(0), source: 'google', campaign: 'c', amountCents: 1234, note: '', createdBy: 'me', createdAt: '' }]) });
  await S.render();
  calls = [];
  el('ad-date').value = dayAgo(0); el('ad-source').value = 'google'; el('ad-campaign').value = 'c'; el('ad-amount').value = ' 12.34 '; el('ad-note').value = 'hello';
  let prevented = false;
  el('ad-form').handlers.submit({ preventDefault() { prevented = true; } });
  await tick(); await tick(); await tick();
  assert.equal(prevented, true);
  assert.equal(calls[0].path, '/api/marketing/spend');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { date: dayAgo(0), source: 'google', campaign: 'c', amount: '12.34', note: 'hello' });
  assert.equal(calls[0].opts.toast, false);
  assert.match(calls[1].path, /^\/api\/marketing\/spend\?from=/);
  assert.equal(el('ad-amount').value, '');
  assert.equal(el('ad-campaign').value, '');
  assert.equal(el('ad-msg').textContent, 'Added');
  assert.equal(el('ad-submit').disabled, false);
});

test('submit with "Other": needs a name, sends other:<name>; a server refusal is shown, the button comes back', async () => {
  await S.render();
  calls = [];
  el('ad-source').value = 'other'; el('ad-other').value = ''; el('ad-amount').value = '5';
  el('ad-source').handlers.change();
  assert.equal(el('ad-other-wrap').hidden, false);
  el('ad-form').handlers.submit({ preventDefault() {} });
  await tick();
  assert.equal(calls.length, 0, 'nothing is sent without a name');
  assert.equal(el('ad-msg').textContent, 'Type the source name');
  el('ad-other').value = 'Ram';
  apiImpl = async () => { const e = new Error('amount must be a USD number above 0'); e.status = 400; throw e; };
  el('ad-form').handlers.submit({ preventDefault() {} });
  await tick(); await tick();
  assert.equal(calls[0].opts.body.source, 'other:Ram');
  assert.equal(el('ad-msg').textContent, 'amount must be a USD number above 0');
  assert.equal(el('ad-msg').style.color, '#C62828');
  assert.equal(el('ad-submit').disabled, false);
  el('ad-source').value = 'google'; el('ad-source').handlers.change();
  assert.equal(el('ad-other-wrap').hidden, true);
});

test('delete: asks first, then DELETE with the encoded id and a reload; "no" sends nothing', async () => {
  apiImpl = async () => ({ entries: ENTRIES });
  await S.render();
  calls = [];
  const btn = { disabled: false, getAttribute: a => (a === 'data-del' ? 'sp_aaaaaaaaaaaa' : null) };
  confirmAnswer = false;
  el('ad-entries').handlers.click({ target: btn });
  await tick();
  assert.equal(calls.length, 0);
  confirmAnswer = true;
  el('ad-entries').handlers.click({ target: btn });
  await tick(); await tick(); await tick();
  assert.equal(calls[0].path, '/api/marketing/spend/sp_aaaaaaaaaaaa');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.match(calls[1].path, /^\/api\/marketing\/spend\?from=/);
  assert.equal(el('ad-msg').textContent, 'Deleted');
  calls = [];
  el('ad-entries').handlers.click({ target: { getAttribute: () => null } });   // a click on the table itself
  assert.equal(calls.length, 0);
});

test('a failed load says so and draws no numbers; a newer render wins over a slower older one', async () => {
  apiImpl = async () => { throw new Error('boom'); };
  await S.render();
  assert.match(el('ad-roas').innerHTML, /Could not load ad spend/);
  assert.equal(el('ad-entries').innerHTML, '');
  let release;
  const slow = new Promise(r => { release = r; });
  let n = 0;
  apiImpl = () => (++n === 1 ? slow : Promise.resolve({ entries: [ENTRIES[2]] }));
  const first = S.render();
  const second = S.render();
  await second;
  const afterSecond = el('ad-entries').innerHTML;
  assert.match(afterSecond, /sp_cccccccccccc/);
  release({ entries: [ENTRIES[0]] });
  await first;
  assert.equal(el('ad-entries').innerHTML, afterSecond, 'the older answer did not draw over the newer one');
});

test('error(): the orders did not load; the next render builds the form again', async () => {
  S.error();
  assert.match(bodyEl.innerHTML, /Could not load orders/);
  apiImpl = async () => ({ entries: [] });
  await S.render();
  assert.match(bodyEl.innerHTML, /id="ad-form"/);
  assert.match(el('ad-entries').innerHTML, /No spend entered for this period/);
});

test('partial cost coverage shows "(N of M orders)" on gross profit, profit after ads and the totals; no cost at all is a dash', async () => {
  global.allOrders = OM.load([rawOrder('BLR-7020', 'p@x.com', 3, 'ram', 100, 2),
    { ref: 'BLR-7021', customer: { email: 'q@x.com' }, savedAt: new Date(d.getTime() - 3 * 86400000).toISOString(), total_due_server: '50.00', status: 'new', items: [], attribution: { source: 'ram' },
      payments: [{ id: 'pq', at: new Date(d.getTime() - 3 * 86400000).toISOString(), kind: 'payment', method: 'card', amount: 50 }] },
    { ref: 'BLR-7022', customer: { email: 'r@x.com' }, savedAt: new Date(d.getTime() - 3 * 86400000).toISOString(), total_due_server: '25.00', status: 'new', items: [], attribution: { source: 'google' },
      payments: [{ id: 'pr', at: new Date(d.getTime() - 3 * 86400000).toISOString(), kind: 'payment', method: 'card', amount: 25 }] }]);
  apiImpl = async () => ({ entries: [{ id: 'sp_ffffffffffff', date: dayAgo(1), source: 'other:ram', campaign: '', amountCents: 1000, note: '', createdBy: 'x', createdAt: '' },
    { id: 'sp_gggggggggggg', date: dayAgo(1), source: 'google', campaign: '', amountCents: 500, note: '', createdBy: 'x', createdAt: '' }] });
  await S.render();
  const html = el('ad-roas').innerHTML;
  const rowOf = key => html.match(new RegExp('<tr data-key="' + key + '">[^]*?</tr>'))[0];
  const ram = rowOf('ram');
  assert.equal((ram.match(/\(1 of 2 orders\)/g) || []).length, 2, 'gross profit and profit after ads of the ram row');
  assert.match(ram, /\$80\.00 \(1 of 2 orders\)/);            // 100 - 2*10 cost = 80 profit of the costed order
  assert.match(ram, /\$70\.00 \(1 of 2 orders\)/);            // 80 - 10 spend
  const g = rowOf('google');
  assert.doesNotMatch(g, /orders\)/);
  assert.equal((g.match(/\u2014/g) || []).length, 2, 'gross profit and profit after ads are dashes: no order of this row has a cost');
  const totals = html.match(/<tr class="ad-total">[^]*?<\/tr>/g);
  assert.equal(totals.length, 2);
  assert.match(totals[0], /\(1 of 3 orders\)/);                  // Total: 3 orders, one costed
  assert.match(totals[1], /Paid.channels/);
  assert.match(totals[1], /\(1 of 3 orders\)/);                  // both sources have spend
  global.allOrders = OM.load([rawOrder('BLR-7001', 'a@x.com', 5, 'facebook', 100, 2), rawOrder('BLR-7002', 'b@x.com', 6, 'ram', 50, 1)]);
});

test('error() cancels a spend answer still on its way', async () => {
  let release;
  const slow = new Promise(r => { release = r; });
  apiImpl = () => slow;
  const pending = S.render();
  S.error();
  release({ entries: [ENTRIES[0]] });
  await pending;
  assert.match(bodyEl.innerHTML, /Could not load orders/);
  assert.equal(el('ad-entries').innerHTML.includes('sp_aaaaaaaaaaaa'), false);
  apiImpl = async () => ({ entries: [] });
  await S.render();
});
