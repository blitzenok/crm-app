'use strict';
// adspend-section.js with a fake document and the page's globals: what is drawn (tiles, table, entries), that every piece of
// user text is escaped, the "Add spend" window (source chips, its own calendar, POST body, the "other" source), delete through
// the CRM dialog, no browser dialogs or native pickers, errors, and an older answer never drawing over a newer one.
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
function el(id) {
  return els[id] || (els[id] = { id, innerHTML: '', textContent: '', value: '', hidden: false, disabled: false, style: {}, attrs: {}, handlers: {},
    addEventListener(t, f) { this.handlers[t] = f; }, setAttribute(k, v) { this.attrs[k] = v; } });
}
const bodyEl = { innerHTML: '', handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } };
const overlays = [], styles = [], docHandlers = {};
global.document = {
  getElementById: id => el(id),
  querySelector: sel => { assert.equal(sel, '#fin-adspend .fin-body'); return bodyEl; },
  createElement: tag => ({ tag, innerHTML: '', textContent: '', className: '', parentNode: null, handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } }),
  head: { appendChild(n) { styles.push(n); } },
  body: { appendChild(n) { n.parentNode = this; overlays.push(n); }, removeChild(n) { overlays.splice(overlays.indexOf(n), 1); n.parentNode = null; } },
  addEventListener(t, f) { docHandlers[t] = f; },
  removeEventListener(t) { delete docHandlers[t]; }
};
let calls = [];
let apiImpl = async () => ({ entries: [] });
global.api = (p, o) => { calls.push({ path: p, opts: o }); return apiImpl(p, o); };
let confirmAnswer = true;
let confirms = [], toasts = [];
global.confirmDialog = (msg, opts) => { confirms.push([msg, opts]); return Promise.resolve(confirmAnswer); };
global.confirm = () => { throw new Error('the browser dialog must not be used'); };
global.toast = (msg, type) => { toasts.push([msg, type]); };
global.periodVal = () => '30d';
global.paidOnlyVal = () => true;
global.OrdersModel = OM;
global.costIdx = FM.costIndex({ items: [{ id: 'bpc', cost: 10, source: 'purchase', match: [{ slug: 'bpc-157', mg: '10mg' }] }] });
const d = new Date();
const dayAgo = n => new Date(d.getTime() - n * 86400000).toISOString().slice(0, 10);
// the window works in the manager's local days, as the old <input type="date"> did
const localDay = n => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - n); return x.getFullYear() + '-' + ('0' + (x.getMonth() + 1)).slice(-2) + '-' + ('0' + x.getDate()).slice(-2); };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const shown = day => MONTHS[Number(day.slice(5, 7)) - 1].slice(0, 3) + ' ' + Number(day.slice(8)) + ', ' + day.slice(0, 4);
function rawOrder(ref, email, daysAgo, source, due, qty) {
  return { ref, customer: { email }, savedAt: new Date(d.getTime() - daysAgo * 86400000).toISOString(), total_due_server: due.toFixed(2), status: 'new',
    items: [{ slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty, price: due / qty }], attribution: source ? { source } : undefined,
    payments: [{ id: 'p' + ref, at: new Date(d.getTime() - daysAgo * 86400000).toISOString(), kind: 'payment', method: 'card', amount: due }] };
}
const BASE_ORDERS = () => OM.load([rawOrder('BLR-7001', 'a@x.com', 5, 'facebook', 100, 2), rawOrder('BLR-7002', 'b@x.com', 6, 'ram', 50, 1)]);
global.allOrders = BASE_ORDERS();
loadJs(ADSECTION);
const S = global.AdSpendSection;
const tick = () => new Promise(r => setImmediate(r));
// a click whose target carries the attributes; `inside` puts the target one level below (an icon inside a button)
function target(attrs, inside) {
  const node = { disabled: false, attrs: {}, getAttribute: a => (a in attrs ? attrs[a] : null), setAttribute(k, v) { this.attrs[k] = v; }, parentNode: null };
  return inside ? { getAttribute: () => null, parentNode: node, button: node } : node;
}
const clickSection = (attrs, inside) => { const t = target(attrs, inside); bodyEl.handlers.click({ target: t }); return t.button || t; };
const clickWindow = attrs => overlays[0].handlers.click({ target: target(attrs) });
const openWindow = () => { for (const id of ['ad-amount', 'ad-other', 'ad-campaign', 'ad-note']) el(id).value = ''; clickSection({ 'data-ad-add': '1' }); };
const submit = () => { let prevented = false; el('ad-form').handlers.submit({ preventDefault() { prevented = true; } }); return () => prevented; };

const ENTRIES = [
  { id: 'sp_aaaaaaaaaaaa', date: dayAgo(3), source: 'facebook', campaign: 'Launch', amountCents: 25000, note: 'n1', createdBy: 'ann@example.com', createdAt: '' },
  { id: 'sp_bbbbbbbbbbbb', date: dayAgo(4), source: 'other:ram', campaign: '', amountCents: 10000, note: '', createdBy: 'bob@example.com', createdAt: '' },
  { id: 'sp_cccccccccccc', date: dayAgo(5), source: 'tiktok', campaign: '', amountCents: 5000, note: '', createdBy: 'bob@example.com', createdAt: '' }
];

test('render: fetches the period\'s entries, builds the section once, draws the tiles and the table with a total row and the "no orders" flag', async () => {
  apiImpl = async () => ({ entries: ENTRIES, totalCents: 40000 });
  await S.render();
  assert.equal(calls.length, 1);
  assert.match(calls[0].path, /^\/api\/marketing\/spend\?from=\d{4}-\d{2}-\d{2}$/);
  assert.equal(calls[0].opts.toast, false);
  assert.match(bodyEl.innerHTML, /class="btn btn-primary" data-ad-add="1">Add spend</);
  assert.doesNotMatch(bodyEl.innerHTML, /<select|type="date"|id="ad-form"/);   // the form lives in its own window now
  const roas = el('ad-roas').innerHTML;
  const kpis = roas.match(/<div class="fin-tiles ad-kpis">[^]*?<\/div><\/div>(?=<p)/)[0];
  assert.equal((kpis.match(/data-tile="adspend"/g) || []).length, 5);
  assert.match(kpis, /Spend<\/div><div class="tile-value">\$400\.00</);          // the Paid channels row: 250 + 100 + 50
  assert.match(kpis, /Revenue, paid channels<\/div><div class="tile-value">\$150\.00</);
  assert.match(kpis, /Cost per new customer<\/div><div class="tile-value">\$200\.00</);   // 400 / 2 new customers
  assert.match(roas, /id="ad-how" hidden>/);                                   // the explanation is one click away
  assert.match(roas, /data-table="adspend"/);
  assert.match(roas, /<th>Revenue<\/th>/);
  assert.match(roas, /data-key="meta"/);
  assert.match(roas, />\$250\.00</);                                       // facebook spend
  assert.match(roas, />\$100\.00</);                                       // facebook revenue
  assert.match(roas, /<span class="ad-pill">0\.40×<\/span>/);         // 100 / 250
  assert.match(roas, /data-key="tiktok"[^]*?no orders/);                   // spend, no orders: the signal
  assert.match(roas.match(/<tr data-key="tiktok">[^]*?<\/tr>/)[0], /no new customers/);
  assert.match(roas, /class="ad-total"/);
  assert.match(roas, /Total/);
  assert.match(roas, /class="ad-total">[^]*Paid&#32;channels|class="ad-total">[^]*Paid channels/);
  assert.doesNotMatch(roas, /—/);                                     // words, not dashes, where a number would divide by zero
  assert.doesNotMatch(roas, /NaN|Infinity|undefined|null/);
  assert.match(el('ad-entries').innerHTML, /data-del="sp_aaaaaaaaaaaa"/);
  assert.match(el('ad-entries').innerHTML, /Other|Ram/);
  assert.match(el('ad-entries').innerHTML, new RegExp(shown(dayAgo(3))));
  // a second render must not rebuild the section but does fetch again; the styles are added once
  const section = bodyEl.innerHTML;
  calls = [];
  await S.render();
  assert.equal(bodyEl.innerHTML, section);
  assert.equal(calls.length, 1);
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /\.ad-modal/);
});

test('no spend at all: the tiles and rows say why there is no number, the empty list offers the button', async () => {
  global.allOrders = OM.load([rawOrder('BLR-7030', 'd@x.com', 2, '', 40, 1), rawOrder('BLR-7031', 'e@x.com', 2, 'google', 60, 1)]);
  apiImpl = async () => ({ entries: [] });
  await S.render();
  const roas = el('ad-roas').innerHTML;
  assert.equal((roas.match(/<tr data-key="direct">[^]*?<\/tr>/)[0].match(/not ads/g) || []).length, 2, 'CAC and ROAS of the direct row');
  assert.equal((roas.match(/<tr data-key="google">[^]*?<\/tr>/)[0].match(/no spend/g) || []).length, 2);
  assert.match(roas, /ROAS<\/div><div class="tile-value ad-muted">no spend</);
  assert.match(roas, /Cost per new customer<\/div><div class="tile-value ad-muted">no spend</);
  assert.match(roas, /Profit after ads<\/div><div class="tile-value ad-muted">no spend</);
  assert.doesNotMatch(roas, /—/);
  assert.match(el('ad-entries').innerHTML, /No spend entered for this period/);
  assert.match(el('ad-entries').innerHTML, /data-ad-add="1">Add spend</);
  global.allOrders = BASE_ORDERS();
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
  global.allOrders = BASE_ORDERS();
});

test('"How it\'s counted" opens the explanation and it stays open across a redraw', async () => {
  apiImpl = async () => ({ entries: ENTRIES });
  await S.render();
  const btn = clickSection({ 'data-ad-how': '1' });
  assert.equal(el('ad-how').hidden, false);
  assert.equal(btn.attrs['aria-expanded'], 'true');
  await S.render();
  assert.match(el('ad-roas').innerHTML, /id="ad-how">Spend is what was entered/);
  clickSection({ 'data-ad-how': '1' });
  assert.equal(el('ad-how').hidden, true);
});

test('Add spend window: source chips and its own calendar, no native select or date input; POST body, the window closes, the list reloads', async () => {
  apiImpl = async (p, o) => (o && o.method === 'POST' ? { entry: { id: 'sp_eeeeeeeeeeee' } } : { entries: ENTRIES.concat([{ id: 'sp_eeeeeeeeeeee', date: dayAgo(0), source: 'google', campaign: 'c', amountCents: 1234, note: '', createdBy: 'me', createdAt: '' }]) });
  await S.render();
  calls = []; toasts = [];
  openWindow();
  assert.equal(overlays.length, 1);
  assert.equal(overlays[0].className, 'modal-overlay open');
  assert.doesNotMatch(overlays[0].innerHTML, /<select|type="date"/);
  const chips = el('ad-src').innerHTML;
  assert.match(chips, /data-ad-src="meta" title="Meta[^"]*fbclid\)"[^>]*><span class="ad-dot"[^>]*><\/span>Meta<\/button>/);
  assert.match(chips, /data-ad-src="other"/);
  assert.doesNotMatch(chips, /data-ad-src="direct"|data-ad-src="facebook"|data-ad-src="instagram"|is-on/);
  assert.equal(el('ad-date').textContent, shown(localDay(0)));
  assert.equal(el('ad-cal').hidden, true);
  openWindow();
  assert.equal(overlays.length, 1, 'a second click does not open a second window');

  el('ad-amount').value = ' 12.34 '; el('ad-campaign').value = 'c'; el('ad-note').value = 'hello';
  submit();
  assert.equal(calls.length, 0, 'nothing is sent without a source');
  assert.equal(el('ad-msg').textContent, 'Choose a source');
  clickWindow({ 'data-ad-src': 'google' });
  assert.match(el('ad-src').innerHTML, /class="ad-chip is-on" data-ad-src="google"/);
  assert.equal(el('ad-other-wrap').hidden, true);
  assert.equal(el('ad-msg').textContent, '');

  clickWindow({ 'data-ad-cal': 'toggle' });
  assert.equal(el('ad-cal').hidden, false);
  assert.equal(el('ad-date').attrs['aria-expanded'], 'true');
  const cal = el('ad-cal').innerHTML;
  assert.match(cal, new RegExp('<span>' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + '</span>'));
  assert.match(cal, new RegExp('class="ad-day is-sel is-today" data-ad-day="' + localDay(0) + '"'));
  assert.doesNotMatch(cal, new RegExp('data-ad-day="' + localDay(-1) + '"'), 'a day after today cannot be picked');
  assert.match(cal, /data-ad-cal="next" aria-label="Next month" disabled/);
  clickWindow({ 'data-ad-cal': 'prev' });
  const before = new Date(d.getFullYear(), d.getMonth() - 1, 1);
  assert.match(el('ad-cal').innerHTML, new RegExp('<span>' + MONTHS[before.getMonth()] + ' ' + before.getFullYear() + '</span>'));
  assert.doesNotMatch(el('ad-cal').innerHTML, /data-ad-cal="next" aria-label="Next month" disabled/);
  clickWindow({ 'data-ad-day': localDay(1) });
  assert.equal(el('ad-cal').hidden, true);
  assert.equal(el('ad-date').textContent, shown(localDay(1)));

  const prevented = submit();
  await tick(); await tick(); await tick();
  assert.equal(prevented(), true);
  assert.equal(calls[0].path, '/api/marketing/spend');
  assert.equal(calls[0].opts.method, 'POST');
  assert.deepEqual(calls[0].opts.body, { date: localDay(1), source: 'google', campaign: 'c', amount: '12.34', note: 'hello' });
  assert.equal(calls[0].opts.toast, false);
  assert.match(calls[1].path, /^\/api\/marketing\/spend\?from=/);
  assert.equal(overlays.length, 0, 'the window closed');
  assert.equal(docHandlers.keydown, undefined);
  assert.deepEqual(toasts, [['Spend added', undefined]]);
});

test('window with "Other": needs a name and an amount, sends other:<name>; a server refusal stays in the window; Cancel and Escape close it', async () => {
  apiImpl = async () => ({ entries: ENTRIES });
  await S.render();
  calls = []; toasts = [];
  openWindow();
  clickWindow({ 'data-ad-src': 'other' });
  assert.equal(el('ad-other-wrap').hidden, false);
  el('ad-amount').value = '5';
  submit();
  assert.equal(calls.length, 0, 'nothing is sent without a name');
  assert.equal(el('ad-msg').textContent, 'Type the source name');
  el('ad-other').value = 'Ram'; el('ad-amount').value = '  ';
  submit();
  assert.equal(calls.length, 0, 'nothing is sent without an amount');
  assert.equal(el('ad-msg').textContent, 'Enter the amount');
  el('ad-amount').value = '5';
  apiImpl = async () => { const e = new Error('amount must be a USD number above 0'); e.status = 400; throw e; };
  submit();
  assert.equal(el('ad-submit').disabled, true);
  clickWindow({ 'data-ad-close': '1' });
  assert.equal(overlays.length, 1, 'a request on its way keeps the window');
  await tick(); await tick();
  assert.equal(calls[0].opts.body.source, 'other:Ram');
  assert.equal(calls[0].opts.body.date, localDay(0));
  assert.equal(el('ad-msg').textContent, 'amount must be a USD number above 0');
  assert.equal(el('ad-submit').disabled, false);
  assert.equal(overlays.length, 1);
  assert.deepEqual(toasts, []);
  clickWindow({ 'data-ad-src': 'google' });
  assert.equal(el('ad-other-wrap').hidden, true);
  clickWindow({ 'data-ad-close': '1' });
  assert.equal(overlays.length, 0);

  openWindow();
  clickWindow({ 'data-ad-cal': 'toggle' });
  let prevented = 0;
  docHandlers.keydown({ key: 'Escape', preventDefault() { prevented++; } });
  assert.equal(el('ad-cal').hidden, true, 'Escape closes the calendar first');
  assert.equal(overlays.length, 1);
  docHandlers.keydown({ key: 'a', preventDefault() { prevented++; } });
  assert.equal(overlays.length, 1);
  docHandlers.keydown({ key: 'Escape', preventDefault() { prevented++; } });
  assert.equal(overlays.length, 0);
  assert.equal(prevented, 2);
});

test('delete: asks in the CRM dialog (never the browser one), then DELETE with the encoded id and a reload; "no" sends nothing; a failure is said', async () => {
  apiImpl = async () => ({ entries: ENTRIES });
  await S.render();
  calls = []; confirms = []; toasts = [];
  confirmAnswer = false;
  clickSection({ 'data-del': 'sp_aaaaaaaaaaaa' }, true);                   // the click lands on the icon inside the button
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(confirms[0][0], 'Delete this spend entry (Facebook, $250.00, ' + shown(dayAgo(3)) + ')? It stays in the audit log.');
  assert.deepEqual(confirms[0][1], { ok: 'Delete' });
  confirmAnswer = true;
  clickSection({ 'data-del': 'sp_aaaaaaaaaaaa' }, true);
  await tick(); await tick(); await tick();
  assert.equal(calls[0].path, '/api/marketing/spend/sp_aaaaaaaaaaaa');
  assert.equal(calls[0].opts.method, 'DELETE');
  assert.match(calls[1].path, /^\/api\/marketing\/spend\?from=/);
  assert.deepEqual(toasts, [['Spend entry deleted', undefined]]);
  toasts = [];
  apiImpl = async () => { throw new Error('Not found'); };
  const btn = clickSection({ 'data-del': 'sp_aaaaaaaaaaaa' });
  await tick(); await tick(); await tick();
  assert.deepEqual(toasts, [['Not found', 'error']]);
  assert.equal(btn.disabled, false);
  calls = [];
  bodyEl.handlers.click({ target: { getAttribute: () => null, parentNode: null } });   // a click on the section itself
  assert.equal(calls.length, 0);
  assert.equal(overlays.length, 0);
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

test('error(): the orders did not load; the next render builds the section again and its button still works', async () => {
  S.error();
  assert.match(bodyEl.innerHTML, /Could not load orders/);
  apiImpl = async () => ({ entries: [] });
  await S.render();
  assert.match(bodyEl.innerHTML, /data-ad-add="1"/);
  assert.match(el('ad-entries').innerHTML, /No spend entered for this period/);
  openWindow();
  assert.equal(overlays.length, 1);
  clickWindow({ 'data-ad-close': '1' });
  assert.equal(overlays.length, 0);
  assert.equal(styles.length, 1);
});

test('partial cost coverage shows "(N of M orders)" on gross profit, profit after ads, the totals and the tile; no cost at all is "cost unknown"', async () => {
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
  assert.match(ram, /\$80\.00 <span class="ad-muted">\(1 of 2 orders\)<\/span>/);            // 100 - 2*10 cost = 80 profit of the costed order
  assert.match(ram, /\$70\.00 <span class="ad-muted">\(1 of 2 orders\)<\/span>/);            // 80 - 10 spend
  assert.doesNotMatch(ram, /ad-pos|ad-neg/, 'a partly known profit is not coloured');
  const g = rowOf('google');
  assert.doesNotMatch(g, /orders\)/);
  assert.equal((g.match(/cost unknown/g) || []).length, 2, 'gross profit and profit after ads: no order of this row has a cost');
  const totals = html.match(/<tr class="ad-total">[^]*?<\/tr>/g);
  assert.equal(totals.length, 2);
  assert.match(totals[0], /\(1 of 3 orders\)/);                  // Total: 3 orders, one costed
  assert.match(totals[1], /Paid.channels/);
  assert.match(totals[1], /\(1 of 3 orders\)/);                  // both sources have spend
  assert.match(html, /Profit after ads<\/div><div class="tile-value">\$65\.00<\/div><div class="ad-kpi-s">cost known for 1 of 3 orders</);   // 80 - 15
  // every order costed: the profit after ads is coloured by its sign
  global.allOrders = OM.load([rawOrder('BLR-7023', 's@x.com', 3, 'google', 100, 2)]);
  await S.render();
  assert.match(el('ad-roas').innerHTML.match(/<tr data-key="google">[^]*?<\/tr>/)[0], /<span class="ad-pos">\$75\.00<\/span>/);   // 80 - 5
  global.allOrders = BASE_ORDERS();
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
