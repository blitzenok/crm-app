'use strict';
// finance-view.js with a fake document and the page's globals: the period switch drives the page's own hidden controls,
// the overview and the five sections show hand-counted numbers, user text is escaped, no number is invented where there
// is none (words, never a dash or a $0.00), and nothing is named "ad-".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Two layouts. biofirst-hosting: services/finance-view/{crm,test} next to server-snapshot/. crm-app: crm-web/finance-view.js with
// this file in crm-web/tests/finance-view/. CRM_DIR overrides both (fresh live copies before a deploy).
const INFRA = fs.existsSync(path.join(__dirname, '..', 'crm', 'finance-view.js'));
const CRM_DIR = process.env.CRM_DIR || (INFRA ? path.join(__dirname, '..', '..', '..', 'server-snapshot', 'var/www/mastersol/html/CRM') : path.join(__dirname, '..', '..'));
const VIEW = INFRA ? path.join(__dirname, '..', 'crm', 'finance-view.js') : path.join(CRM_DIR, 'finance-view.js');
// crm-app's package.json says "type": "module", so a classic page script is loaded through a .cjs copy
function load(file) {
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'finview-js-')), path.basename(file, '.js') + '.cjs');
  fs.copyFileSync(file, tmp);
  return require(tmp);
}
load(path.join(CRM_DIR, 'crm-utils.js'));              // the real esc / escAttr (they register on globalThis)
const OM = load(path.join(CRM_DIR, 'orders-model.js'));
const FM = load(path.join(CRM_DIR, 'finance-model.js'));
global.OrdersModel = OM;
global.FinanceModel = FM;

const nodes = {};
function node(id) {
  return nodes[id] || (nodes[id] = { id, innerHTML: '', textContent: '', value: '', checked: false, hidden: false, attrs: {}, handlers: {}, events: [], clicks: 0,
    addEventListener(t, f) { this.handlers[t] = f; }, dispatchEvent(e) { this.events.push(e.type); if (this.handlers[e.type]) this.handlers[e.type](e); },
    setAttribute(k, v) { this.attrs[k] = v; }, click() { this.clicks++; } });
}
const bodies = {};
const styles = [];
const docHandlers = {};
const content = { classes: [], handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } };
content.classList = { add: c => content.classes.push(c) };
const panelEl = { children: [], appendChild(n) { this.children.push(n); }, parentNode: content };
global.document = {
  getElementById: id => node(id),
  querySelector: sel => {
    if (sel === '.fin-panel') return panelEl;
    const m = /^#(fin-[a-z]+) \.fin-body$/.exec(sel);
    assert.ok(m, 'unexpected selector ' + sel);
    return bodies[m[1]] || (bodies[m[1]] = { innerHTML: '' });
  },
  createElement: tag => ({ tag, innerHTML: '', textContent: '', className: '', handlers: {}, addEventListener(t, f) { this.handlers[t] = f; } }),
  head: { appendChild(n) { styles.push(n); } },
  addEventListener(t, f) { docHandlers[t] = f; }
};
global.Event = class { constructor(type) { this.type = type; } };
load(VIEW);
const V = global.FinanceView;

function rawOrder(ref, email, day, source, due, items, name) {
  return { ref, customer: { email, firstName: name || '' }, savedAt: day + 'T12:00:00.000Z', total_due_server: due.toFixed(2), status: 'new',
    items, attribution: source ? { source } : undefined,
    payments: [{ id: 'p' + ref, at: day + 'T12:00:00.000Z', kind: 'payment', method: 'card', amount: due }] };
}
const bpc = (qty, price) => ({ slug: 'bpc-157', name: 'BPC-157', mg: '10mg', qty, price });
const tb = (qty, price) => ({ slug: 'tb-500', name: 'TB-500', mg: '5mg', qty, price });
const ORDERS = () => OM.load([
  rawOrder('BLR-9001', 'a@x.com', '2026-09-26', 'facebook', 100, [bpc(2, 50)], 'Ann'),
  rawOrder('BLR-9002', 'b@x.com', '2026-08-20', 'google', 50, [bpc(1, 50)], 'Bob'),
  rawOrder('BLR-9003', 'a@x.com', '2026-07-15', '', 30, [tb(1, 30)], 'Ann')
]);
const COSTS = FM.costIndex({ items: [{ id: 'bpc', cost: 10, source: 'purchase', match: [{ slug: 'bpc-157', mg: '10mg' }] }] });
const NOW = new Date('2026-10-01T12:00:00Z');
const ctx = over => Object.assign({ orders: ORDERS(), period: 'all', paidOnly: true, costIdx: COSTS, costsError: '', now: NOW }, over);
const all = () => [node('fin-summary').innerHTML].concat(['fin-aov', 'fin-products', 'fin-margin', 'fin-sources', 'fin-repeat'].map(id => bodies[id].innerHTML)).join('\n');
const tileOf = (html, name) => html.match(new RegExp('<div data-tile="' + name + '">[^]*?</div></div>'))[0];
const target = attrs => ({ attrs: {}, getAttribute: a => (a in attrs ? attrs[a] : null), setAttribute(k, v) { this.attrs[k] = v; }, parentNode: null });

node('fin-period').value = 'all';
node('fin-paid-only').checked = true;

test('overview: five tiles from the model, the figure split into number and small cents, what the numbers are in one caption', () => {
  V.render(ctx());
  const s = node('fin-summary').innerHTML;
  assert.equal((s.match(/data-tile="o-/g) || []).length, 5);
  assert.match(tileOf(s, 'o-orders'), /Orders<\/div><div class="tile-value">3<\/div>/);
  assert.match(tileOf(s, 'o-value'), /\$180<span class="finv-small">\.00<\/span>/);
  assert.match(tileOf(s, 'o-average'), /\$60<span class="finv-small">\.00<\/span>/);
  assert.match(tileOf(s, 'o-margin'), /cost known for 2 of 3 orders<\/div><div class="tile-value">80<span class="finv-small">%<\/span>/);   // (150 - 30) / 150
  assert.match(tileOf(s, 'o-repeat'), /1 of 2 bought twice or more<\/div><div class="tile-value">50<span class="finv-small">%<\/span>/);
  assert.match(s, /class="fin-caption">Order value = amount due \(not cash received\) · paid orders, all time</);
});

test('sections: month columns and best month, product share bars, margin with its coverage, source strip, repeat list', () => {
  V.render(ctx());
  const aov = bodies['fin-aov'].innerHTML;
  assert.match(tileOf(aov, 'average'), /\$60</);
  assert.match(tileOf(aov, 'median'), /\$50</);
  assert.match(tileOf(aov, 'best-month'), /Sep 2026, 1 order<\/div><div class="tile-value">\$100</);
  assert.equal((aov.match(/class="finv-month"/g) || []).length, 3);
  assert.match(aov, /<b>\$100\.00<\/b><i style="height:96px"><\/i><span>Sep 2026<\/span>/);     // the tallest column is the best month
  assert.match(aov, /<b>\$30\.00<\/b><i style="height:29px"><\/i><span>Jul 2026<\/span>/);
  assert.equal((aov.match(/<tr><td>/g) || []).length, 3);
  assert.doesNotMatch(aov, /<svg/, 'no stretched chart');

  const prod = bodies['fin-products'].innerHTML;
  assert.match(prod, /data-key="bpc-157"><td>BPC-157 10mg<\/td><td class="finv-num">3<\/td><td class="finv-num">2<\/td><td class="finv-num">\$150\.00<\/td><td class="finv-num">75%<span class="finv-bar"><i style="width:75%">/);
  assert.match(prod, /data-key="tb-500">[^]*?25%/);

  const mar = bodies['fin-margin'].innerHTML;
  assert.match(tileOf(mar, 'm-revenue'), /\$150</);
  assert.match(tileOf(mar, 'm-cost'), /\$30</);
  assert.match(tileOf(mar, 'm-profit'), /\$120</);
  assert.match(tileOf(mar, 'm-pct'), />80<span class="finv-small">%</);
  assert.match(mar, /data-margin-coverage[^>]*>2 of 3 orders have a cost for every item/);
  assert.match(mar, /data-table="margin"[^]*BPC-157 10mg[^]*Purchase avg/);
  assert.match(mar, /No cost in the price list<\/div>[^]*data-table="margin-missing"[^]*TB-500 5mg/);
  assert.match(mar, /id="finv-how-margin" hidden>Product revenue = amount due minus/);

  const src = bodies['fin-sources'].innerHTML;
  assert.equal((src.match(/<i style="width:33\.33%;background:/g) || []).length, 3);
  assert.match(src, /<span class="finv-dot" style="background:#1877F2"><\/span>Facebook/);
  assert.match(src, /<span class="finv-dot" style="background:#B8C4DC"><\/span>Not recorded/);

  const rep = bodies['fin-repeat'].innerHTML;
  assert.match(tileOf(rep, 'customers'), />2<\/div>/);
  assert.match(tileOf(rep, 'repeat'), />1<\/div>/);
  assert.match(rep, /<td>Ann<\/td><td>a@x\.com<\/td><td class="finv-num">2<\/td><td class="finv-num">\$130\.00<\/td><td class="finv-num">Jul 15, 2026<\/td><td class="finv-num">Sep 26, 2026<\/td>/);
});

test('no number where there is none: words, never a dash, a $0.00 or NaN; one month has no chart; nobody bought twice says so', () => {
  V.render(ctx({ orders: OM.load([rawOrder('BLR-9010', 'c@x.com', '2026-07-30', '', 89.99, [tb(1, 89.99)], 'C')]) }));
  const s = node('fin-summary').innerHTML;
  assert.match(tileOf(s, 'o-margin'), /class="tile-value finv-quiet">cost unknown</);
  assert.match(tileOf(s, 'o-repeat'), /0 of 1 bought twice or more<\/div><div class="tile-value">0<span/);
  const mar = bodies['fin-margin'].innerHTML;
  assert.equal((mar.match(/class="tile-value finv-quiet">cost unknown</g) || []).length, 4, 'all four margin tiles');
  assert.doesNotMatch(mar, /\$0\.00|\$0</);
  assert.doesNotMatch(bodies['fin-aov'].innerHTML, /finv-months/, 'one month is a table row, not a chart');
  assert.match(bodies['fin-repeat'].innerHTML, /class="finv-empty">Nobody has bought twice in this period yet</);
  assert.doesNotMatch(bodies['fin-repeat'].innerHTML, /data-table="repeat"/, 'no empty table head');
  assert.doesNotMatch(all(), /—|NaN|Infinity|undefined|null/);
});

test('an empty period: every section says so, the overview has no invented average or margin', () => {
  V.render(ctx({ orders: [] }));
  for (const id of ['fin-aov', 'fin-products', 'fin-margin', 'fin-sources', 'fin-repeat']) assert.equal(bodies[id].innerHTML, '<div class="finv-empty">No orders in this period</div>', id);
  const s = node('fin-summary').innerHTML;
  assert.match(tileOf(s, 'o-orders'), />0<\/div>/);
  assert.match(tileOf(s, 'o-average'), /finv-quiet">no orders</);
  assert.match(tileOf(s, 'o-margin'), /finv-quiet">no orders</);
  assert.match(tileOf(s, 'o-repeat'), /finv-quiet">no customers</);
  assert.doesNotMatch(all(), /—|NaN/);
});

test('the cost list did not load: the margin section and the overview say so, the rest is drawn', () => {
  V.render(ctx({ costIdx: null, costsError: 'Could not load the cost list' }));
  assert.equal(bodies['fin-margin'].innerHTML, '<div class="fin-error">Could not load the cost list</div>');
  assert.match(tileOf(node('fin-summary').innerHTML, 'o-margin'), /finv-quiet">cost list not loaded</);
  assert.match(bodies['fin-products'].innerHTML, /data-table="products"/);
});

test('every piece of order text is escaped: product, source, customer name and e-mail', () => {
  const evil = '<img src=x onerror=alert(1)>';
  V.render(ctx({ orders: OM.load([
    rawOrder('BLR-9020', 'e@x.com', '2026-09-01', 'a<b>c', 10, [{ slug: '', name: evil, mg: '', qty: 1, price: 10 }], evil),
    rawOrder('BLR-9021', 'e@x.com', '2026-09-02', 'a<b>c', 10, [{ slug: '', name: evil, mg: '', qty: 1, price: 10 }], evil)]) }));
  assert.doesNotMatch(all(), /<img|<b>/);
  assert.match(bodies['fin-repeat'].innerHTML, /&lt;img/);
  assert.match(bodies['fin-products'].innerHTML, /&lt;img/);
});

test('period switch: built once over the page\'s hidden controls, mirrors them, a click sets the control and fires its change', () => {
  node('fin-period').value = '90d';
  node('fin-paid-only').checked = false;
  V.panel();
  V.render(ctx());
  assert.equal(panelEl.children.length, 1, 'one switch, however many redraws');
  assert.deepEqual(content.classes, ['finv']);
  assert.equal(styles.length, 1);
  assert.match(styles[0].textContent, /\.finv \.fin-panel>\*:not\(\.finv-ctl\)\{display:none;\}/, 'the native select, checkbox and button are hidden');
  const ctl = panelEl.children[0];
  assert.equal(ctl.className, 'finv-ctl');
  assert.equal((ctl.innerHTML.match(/data-finv-period=/g) || []).length, 4);
  assert.match(ctl.innerHTML, /data-finv-period="90d" class="is-on" aria-pressed="true">90 days</);
  assert.match(ctl.innerHTML, /role="switch" data-finv-paid="1" aria-checked="false"/);
  assert.doesNotMatch(ctl.innerHTML, /<select|type="checkbox"/);

  node('fin-period').events = [];
  ctl.handlers.click({ target: target({ 'data-finv-period': '30d' }) });
  assert.equal(node('fin-period').value, '30d');
  assert.deepEqual(node('fin-period').events, ['change']);
  ctl.handlers.click({ target: target({ 'data-finv-period': '30d' }) });
  assert.deepEqual(node('fin-period').events, ['change'], 'the period already chosen does not reload');
  V.panel();
  assert.match(ctl.innerHTML, /data-finv-period="30d" class="is-on"/);

  ctl.handlers.click({ target: target({ 'data-finv-paid': '1' }) });
  assert.equal(node('fin-paid-only').checked, true);
  assert.deepEqual(node('fin-paid-only').events, ['change']);
  ctl.handlers.click({ target: target({ 'data-finv-refresh': '1' }) });
  assert.equal(node('fin-refresh').clicks, 1);
  ctl.handlers.click({ target: target({}) });                                 // a click between the buttons
  assert.equal(node('fin-refresh').clicks, 1);
  assert.equal(typeof docHandlers.DOMContentLoaded, 'function', 'the switch is built before the orders arrive');
  node('fin-period').value = 'all';
});

test('"How it\'s counted" under Margin opens and stays open across a redraw', () => {
  V.render(ctx());
  const btn = target({ 'data-finv-how': 'margin' });
  content.handlers.click({ target: btn });
  assert.equal(node('finv-how-margin').hidden, false);
  assert.equal(btn.attrs['aria-expanded'], 'true');
  V.render(ctx());
  assert.match(bodies['fin-margin'].innerHTML, /aria-expanded="true">[^<]*<\/button><p class="fin-note finv-how" id="finv-how-margin">/);
  content.handlers.click({ target: target({ 'data-finv-how': 'margin' }) });
  assert.equal(node('finv-how-margin').hidden, true);
  content.handlers.click({ target: target({}) });                             // any other click on the page
});

test('no class, id or data attribute starts with "ad-" (ad blockers hide such elements)', () => {
  V.render(ctx());
  const markup = all() + panelEl.children[0].innerHTML;
  assert.doesNotMatch(markup, /(class|id|for)="([^"]* )?ad-|data-ad-/);
  assert.doesNotMatch(styles[0].textContent, /[.#]ad-/);
});
