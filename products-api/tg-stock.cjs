#!/usr/bin/env node
'use strict';
// tg-stock.cjs — the stock table for the team's Telegram group: one pinned message, edited in place every hour (no new
// message, no notification). Calculated, not counted on a shelf (owner 30.09, option A): what the agents' warehouse says
// came in (/opt/crm-umg, file data/inventory.json: SKUs and intake movements; we only read it) minus what paid orders took
// (orders.json through the CRM's orders-model.js, the same test and duplicate rules as the order pages). An order is written
// off while its status is in a paid group (paid, payment-confirmed, processing, shipped, in-transit, delivered — the CRM's
// PAID_GROUPS and products-api ORDER_PAID_STATUSES); cancelled or refunded later, it drops out and the stock comes back.
// Which shop item is which warehouse SKU is the agents' map (config/rapid-sku-map[.draft].json, key <slug>-<mg>): their
// inventory_code, or their product_id when it is a warehouse SKU code. Anything else is listed apart as "no warehouse SKU",
// never guessed. Deleted message -> a new one is sent and pinned. Settings in the env file of the alerts (ENV_FILE):
// TG_STOCK_MODE off|on, TG_ALERTS_TOPIC_STOCK, TG_STOCK_SALES_SINCE (optional: count sales from this moment), TG_STOCK_LOW_PCT.
// Alerts in the same topic (owner 30.09), one message per run: new stock came in (the SKU's intake grew), running low (left at
// or under TG_STOCK_LOW_PCT %, default 20, of what was there right after its last intake; 0 = off), out of stock. Each once,
// until the next intake or a cancelled order lifts it back. The first run only remembers the figures.
// Source: services/tg-alerts/ in biofirst-hosting; install — deploy/INSTALL.md.
const fs = require('fs');
const path = require('path');
const A = require('./tg-alerts.cjs');

const DEFAULT_TZ = 'Asia/Jerusalem';
const INVENTORY_URL = 'https://crm.biolabsresearch.co/crm/inventory-intake.html';
const HEADING_SIZE = 6;   // the smallest; 5 still read too big for the pinned table (owner 30.09)
const DEFAULT_LOW_PCT = 20;
// orders-model.js GROUPS: toship = paid, payment-confirmed, processing; shipped = shipped, in-transit; delivered.
const PAID_GROUPS = ['toship', 'shipped', 'delivered'];
const MAX_UNMATCHED = 15;

function parseStock(env) {
  const e = env || {};
  const problems = [];
  const mode = String(e.TG_STOCK_MODE || '').trim().toLowerCase() === 'on' ? 'on' : 'off';
  let topic = null;
  const rawTopic = String(e.TG_ALERTS_TOPIC_STOCK || '').trim();
  if (rawTopic) {
    if (/^[1-9][0-9]{0,9}$/.test(rawTopic)) topic = Number(rawTopic);
    else problems.push('TG_ALERTS_TOPIC_STOCK is not a topic id, the table goes to General');
  }
  let sinceMs = NaN;
  const rawSince = String(e.TG_STOCK_SALES_SINCE || '').trim();
  if (rawSince) {
    sinceMs = Date.parse(rawSince);
    if (!Number.isFinite(sinceMs)) problems.push('TG_STOCK_SALES_SINCE is not a date, counting all paid orders');
  }
  let tz = String(e.TG_DAILY_TZ || '').trim() || DEFAULT_TZ;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); } catch (err) { tz = DEFAULT_TZ; }
  let lowPct = DEFAULT_LOW_PCT;
  const rawPct = String(e.TG_STOCK_LOW_PCT || '').trim();
  if (rawPct) {
    if (/^([0-9]|[1-9][0-9])$/.test(rawPct)) lowPct = Number(rawPct);
    else problems.push('TG_STOCK_LOW_PCT is not 0-99, using ' + DEFAULT_LOW_PCT);
  }
  return { mode, topic, sinceMs, tz, lowPct, problems };
}

function text(v) { return v === undefined || v === null ? '' : String(v).trim(); }
function plain(v, max) { return text(v).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').slice(0, max); }
// The map's key for an order line: "<slug>-<mg>" ("g3-r-10mg"); no strength -> the slug alone, no slug -> ''.
function shopKey(item) {
  const slug = text(item && item.slug).toLowerCase();
  if (!slug) return '';
  const mg = text(item.mg).toLowerCase().replace(/\s+/g, '');
  return mg ? slug + '-' + mg : slug;
}
// map: the agents' rapid-sku-map; skus: the warehouse SKUs. -> { codes: Map(shopKey -> SKU code), gifts: Set(shopKey) }
function skuMap(map, skus) {
  const known = new Set((Array.isArray(skus) ? skus : []).map(s => text(s && s.code)).filter(Boolean));
  const codes = new Map();
  const gifts = new Set();
  for (const [key, v] of Object.entries(map && typeof map === 'object' ? map : {})) {
    if (!v || typeof v !== 'object') continue;
    if (v.gift === true) { gifts.add(key.toLowerCase()); continue; }
    const code = text(v.inventory_code) || (known.has(text(v.product_id)) ? text(v.product_id) : '');
    if (code) codes.set(key.toLowerCase(), code);
  }
  return { codes, gifts };
}

// inventory: the agents' file; records: OrdersModel.load(orders.json). On hand per SKU is their rule (onHandQty: the sum
// of the SKU's movements), so our "In" is the number their Inventory Intake page shows.
function compute(opts) {
  const inv = opts.inventory && typeof opts.inventory === 'object' ? opts.inventory : {};
  const skus = (Array.isArray(inv.skus) ? inv.skus : []).filter(s => s && text(s.code));
  const moves = Array.isArray(inv.inventory_movements) ? inv.inventory_movements : [];
  const own = opts.ownAddresses instanceof Set ? opts.ownAddresses : new Set();
  const since = Number.isFinite(opts.sinceMs) ? opts.sinceMs : -Infinity;
  const map = opts.map || { codes: new Map(), gifts: new Set() };

  const rows = skus.map(s => {
    const received = moves.filter(m => m && m.sku_id === s.id).reduce((sum, m) => sum + (Number(m.qty) || 0), 0);
    return { code: text(s.code), name: plain(s.name, 60) || text(s.code), received, sold: 0, left: 0 };
  });
  const byCode = new Map(rows.map(r => [r.code, r]));
  const unmatched = new Map();
  let paidOrders = 0;
  for (const r of Array.isArray(opts.records) ? opts.records : []) {
    if (!r || r.kind !== 'order' || r.isTest || r.duplicateOf || !PAID_GROUPS.includes(r.group)) continue;
    if (own.has(text(r.email).toLowerCase())) continue;
    const made = Date.parse(r.createdAt);
    if (since > -Infinity && !(made >= since)) continue;
    paidOrders++;
    for (const i of Array.isArray(r.items) ? r.items : []) {
      const qty = Number(i && i.qty) || 0;
      const key = shopKey(i);
      if (!qty || map.gifts.has(key)) continue;
      const row = byCode.get(map.codes.get(key));
      if (row) { row.sold += qty; continue; }
      const k = key || plain(i.name, 60).toLowerCase();
      const u = unmatched.get(k) || { key: k, label: plain([plain(i.name, 60), plain(i.mg, 12)].filter(Boolean).join(' '), 80) || k, sold: 0 };
      u.sold += qty;
      unmatched.set(k, u);
    }
  }
  for (const r of rows) r.left = r.received - r.sold;
  return {
    rows,
    negative: rows.filter(r => r.left < 0).map(r => r.code),
    unmatched: [...unmatched.values()].sort((a, b) => b.sold - a.sold || a.label.localeCompare(b.label)),
    paidOrders
  };
}

function cell(t, align, header) {
  const c = { text: t, align: align || 'left', valign: 'middle' };
  if (header) c.is_header = true;
  return c;
}
function leftText(n) { return n < 0 ? '⚠ ' + n : String(n); }
function stamp(ms, tz) {
  return new Date(ms).toLocaleString('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

function message(res, opts) {
  const title = 'Stock · calculated';
  const blocks = [{ type: 'heading', size: HEADING_SIZE, text: ['📦 ', { type: 'bold', text: title }] }];
  const lines = ['📦 ' + title];
  if (res.rows.length) {
    const cells = [[cell('Item', 'left', true), cell('In', 'right', true), cell('Sold', 'right', true), cell('Left', 'right', true)]];
    for (const r of res.rows) {
      const left = leftText(r.left);
      cells.push([cell(r.name), cell(String(r.received), 'right'), cell(String(r.sold), 'right'), cell(r.left < 0 ? { type: 'bold', text: left } : left, 'right')]);
      lines.push(r.name + ': ' + r.received + ' in − ' + r.sold + ' sold = ' + left);
    }
    blocks.push({ type: 'table', is_compact: true, is_striped: true, cells });
  } else {
    blocks.push({ type: 'paragraph', text: 'The warehouse has no SKUs yet.' });
    lines.push('The warehouse has no SKUs yet.');
  }
  if (res.negative.length) {
    const t = '⚠ Below zero: sold more than came in (' + res.negative.length + ')';
    blocks.push({ type: 'paragraph', text: { type: 'bold', text: t } });
    lines.push(t);
  }
  if (res.unmatched.length) {
    const head = 'Selling, no warehouse SKU';
    const shown = res.unmatched.slice(0, MAX_UNMATCHED);
    const cells = [[cell(head, 'left', true), cell('Sold', 'right', true)]].concat(shown.map(u => [cell(u.label), cell('×' + u.sold, 'right')]));
    if (res.unmatched.length > shown.length) cells.push([Object.assign(cell('+' + (res.unmatched.length - shown.length) + ' more'), { colspan: 2 })]);
    blocks.push({ type: 'table', is_compact: true, is_bordered: true, cells });
    lines.push(head + ': ' + shown.map(u => u.label + ' ×' + u.sold).join('; '));
  }
  const foot = 'Updated ' + stamp(opts.nowMs, opts.tz);
  blocks.push({ type: 'paragraph', text: foot });
  lines.push(foot, 'Inventory in CRM: ' + INVENTORY_URL);
  blocks.push({ type: 'buttons', buttons: [{ text: 'Inventory in CRM', url: INVENTORY_URL, style: 'primary' }] });
  return { type: 'stock', text: lines.join('\n').slice(0, 4096), rich: { blocks, skip_entity_detection: true } };
}

// ---- alerts ----
// rows: compute().rows; prev: what the last run remembered ({received, peak, level} by SKU code), none on the first run.
// peak = what was there right after the SKU's last intake (or the most since: a cancelled order adds back); the low line is a
// percent of it, not of everything ever received, which after a few deliveries would warn with a full shelf.
// level: none (nothing ever came in; below zero shows in the table) | ok | low | out; an alert fires only when it gets worse.
const RANK = { none: 0, ok: 0, low: 1, out: 2 };
function levelOf(row, peak, pct) {
  if (!(row.received > 0)) return 'none';
  if (row.left <= 0) return 'out';
  return pct > 0 && row.left <= peak * pct / 100 ? 'low' : 'ok';
}
function stockEvents(rows, prev, pct) {
  const first = !prev || typeof prev !== 'object' || !prev.received;
  const p = first ? { received: {}, peak: {}, level: {} } : { received: prev.received || {}, peak: prev.peak || {}, level: prev.level || {} };
  const next = { received: {}, peak: {}, level: {} };
  const intakes = [], low = [];
  for (const r of rows) {
    const before = Number(p.received[r.code]) || 0;
    const came = !first && r.received > before;
    const peak = first || came || !Number.isFinite(Number(p.peak[r.code])) ? r.left : Math.max(Number(p.peak[r.code]), r.left);
    const level = levelOf(r, peak, pct);
    if (came) intakes.push({ code: r.code, name: r.name, added: r.received - before, left: r.left });
    else if (!first && RANK[level] > (RANK[p.level[r.code]] || 0)) low.push({ code: r.code, name: r.name, left: r.left, peak, out: level === 'out' });
    next.received[r.code] = r.received;
    next.peak[r.code] = peak;
    next.level[r.code] = level;
  }
  return { intakes, low, next };
}
function alertMessage(ev) {
  if (!ev.intakes.length && !ev.low.length) return null;
  const title = ev.intakes.length && ev.low.length ? ['📦 ', 'Stock update'] : ev.intakes.length ? ['📥 ', 'New stock'] : ['⚠️ ', 'Stock running low'];
  const blocks = [{ type: 'heading', size: HEADING_SIZE, text: [title[0], { type: 'bold', text: title[1] }] }];
  const lines = [title.join('')];
  if (ev.intakes.length) {
    const cells = [[cell('Came in', 'left', true), cell('Added', 'right', true), cell('Now', 'right', true)]];
    for (const x of ev.intakes) {
      cells.push([cell(x.name), cell('+' + x.added, 'right'), cell(leftText(x.left), 'right')]);
      lines.push(x.name + ': +' + x.added + ', now ' + x.left);
    }
    blocks.push({ type: 'table', is_compact: true, is_striped: true, cells });
  }
  if (ev.low.length) {
    const cells = [[cell('Running low', 'left', true), cell('Left', 'right', true)]];
    for (const x of ev.low) {
      const t = x.out ? 'out of stock' : x.left + ' of ' + x.peak + ' (' + Math.round(x.left * 100 / x.peak) + '%)';
      cells.push([cell(x.name), cell(x.out ? { type: 'bold', text: t } : t, 'right')]);
      lines.push(x.name + ': ' + (x.out ? t : x.left + ' left of ' + x.peak + ' (' + Math.round(x.left * 100 / x.peak) + '%)'));
    }
    blocks.push({ type: 'table', is_compact: true, is_bordered: true, cells });
  }
  return { type: 'stock', text: lines.join('\n').slice(0, 4096), rich: { blocks, skip_entity_detection: true } };
}

// Edit the table in place; the message is gone (deleted, or state from another chat) -> send a new one and pin it silently.
// cb({ok, action: edited|unchanged|sent, messageId, topic, pinned, pinError, richRefused, status, error}).
const GONE_RE = /message to edit not found|message can't be edited|message_id_invalid/i;
const SAME_RE = /message is not modified/i;
function publish(cfg, state, msg, cb) {
  const st = state || {};
  const sendNew = () => A.send(cfg, msg, r => {
    if (!r.ok) return cb({ ok: false, status: r.status, error: r.error });
    A.post(cfg, 'pinChatMessage', { chat_id: cfg.chatId, message_id: r.messageId, disable_notification: true }, p =>
      cb(Object.assign({ ok: true, action: 'sent', messageId: r.messageId, topic: r.topic, pinned: p.ok },
        p.ok ? {} : { pinError: p.error }, r.richRefused ? { richRefused: r.richRefused } : {})));
  });
  if (!Number.isInteger(st.messageId) || String(st.chatId) !== String(cfg.chatId)) return sendNew();
  const where = { chat_id: cfg.chatId, message_id: st.messageId };
  const edited = (action, extra) => cb(Object.assign({ ok: true, action, messageId: st.messageId, topic: st.topic }, extra));
  A.post(cfg, 'editMessageText', Object.assign({ rich_message: msg.rich }, where), r => {
    if (r.ok) return edited('edited');
    if (r.status === 400 && SAME_RE.test(r.error)) return edited('unchanged');
    if (r.status === 400 && GONE_RE.test(r.error)) return sendNew();
    if (r.status !== 400 || r.migrate) return cb({ ok: false, status: r.status, error: r.error });
    // Our layout refused (a new API rule): the same edit as plain text, as the alerts do.
    A.post(cfg, 'editMessageText', Object.assign({ text: msg.text, link_preview_options: { is_disabled: true } }, where), p => {
      if (p.ok) return edited('edited', { richRefused: r.error });
      if (p.status === 400 && SAME_RE.test(p.error)) return edited('unchanged', { richRefused: r.error });
      if (p.status === 400 && GONE_RE.test(p.error)) return sendNew();
      cb({ ok: false, status: p.status, error: p.error });
    });
  });
}

// ---- cron entry ----
function readEnv(file) {
  const out = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function main() {
  const dry = process.argv.includes('--dry');   // print the table, send nothing, keep the state
  const ENV_FILE = process.env.ENV_FILE || '/opt/crm-api/.env';
  const ORDERS = process.env.ORDERS_FILE || path.join(__dirname, 'orders.json');
  const CRM_DIR = process.env.CRM_DIR || '/var/www/mastersol/html/CRM';
  const UMG = process.env.CRM_UMG_DIR || '/opt/crm-umg/server';
  const STATE = process.env.TG_STOCK_STATE || '/var/lib/biolabs-ops/tg-stock.json';
  const log = (s) => console.log(new Date().toISOString() + ' [tg-stock] ' + s);
  const env = readEnv(ENV_FILE);
  const cfg = parseStock(env);
  for (const p of cfg.problems) log('ERROR ' + p);
  if (cfg.mode !== 'on' && !dry) return;
  // Unreadable warehouse or orders (the agents' file is written in place, a read can land mid-write): the pinned table
  // keeps its last figures and the next hour tries again. Never publish a table built from half a file.
  let res;
  try {
    const inventory = readJson(path.join(UMG, 'data', 'inventory.json'));
    const mapFile = ['rapid-sku-map.json', 'rapid-sku-map.draft.json'].map(f => path.join(UMG, 'config', f)).find(f => fs.existsSync(f));
    const map = skuMap(mapFile ? readJson(mapFile) : {}, inventory.skus);
    if (!mapFile) log('WARN no rapid-sku-map in ' + path.join(UMG, 'config') + ': every sale is listed as no warehouse SKU');
    const OM = require(path.join(CRM_DIR, 'orders-model.js'));
    const alertsCfg = A.parseConfig(Object.assign({}, env, { TG_ALERTS_MODE: 'off' }));
    res = compute({ inventory, map, records: OM.load(readJson(ORDERS)), ownAddresses: alertsCfg.ownAddresses, sinceMs: cfg.sinceMs });
  } catch (e) { log('ERROR data not read, table left as it was: ' + String((e && e.message) || e).slice(0, 200)); process.exitCode = 1; return; }
  const msg = message(res, { nowMs: Date.now(), tz: cfg.tz });
  let state = {};
  try { state = readJson(STATE) || {}; } catch (e) { state = {}; }
  const ev = stockEvents(res.rows, state.stock, cfg.lowPct);
  const alert = alertMessage(ev);
  if (dry) { console.log(msg.text + (alert ? '\n\n--- alert ---\n' + alert.text : '\n\n(no alert)')); return; }
  const tg = A.parseConfig(Object.assign({}, env, { TG_ALERTS_MODE: 'on', TG_ALERTS_SINCE: new Date().toISOString() }));
  if (!tg.token || !tg.chatId) { log('ERROR bot token or chat id missing, not sent'); process.exitCode = 1; return; }
  tg.topics = Object.assign({}, tg.topics, cfg.topic ? { stock: cfg.topic } : {});
  const save = () => {
    try {
      fs.writeFileSync(STATE + '.tmp', JSON.stringify(state) + '\n');
      fs.renameSync(STATE + '.tmp', STATE);
    } catch (e) { log('ERROR state not written (a new table or a repeated alert may follow): ' + e.message); }
  };
  publish(tg, state, msg, r => {
    if (!r.ok) { log('ERROR table not updated: ' + (r.status || '') + ' ' + (r.error || '') + ' (tried again next hour)'); process.exitCode = 1; }
    else {
      if (r.richRefused) log('WARN sent not as meant: ' + r.richRefused);
      if (r.action === 'sent' && !r.pinned) log('WARN new table message ' + r.messageId + ' not pinned: ' + (r.pinError || '') + ' (give the bot the Pin messages right)');
      if (r.action === 'sent' || !state.createdAt) Object.assign(state, { messageId: r.messageId, chatId: String(tg.chatId), topic: r.topic, createdAt: new Date().toISOString() });
      log(r.action + ' ' + r.messageId + ': ' + res.rows.length + ' SKUs, ' + res.negative.length + ' below zero, ' + res.unmatched.length + ' unmatched, ' + res.paidOrders + ' paid orders');
    }
    // The alert goes whatever happened to the table; its figures are remembered only once it is sent, so a failed one is
    // tried again next hour.
    if (!alert) { state.stock = ev.next; return save(); }
    A.send(tg, alert, a => {
      if (!a.ok) { log('ERROR alert not sent: ' + (a.status || '') + ' ' + (a.error || '') + ' (tried again next hour)'); process.exitCode = 1; return save(); }
      if (a.richRefused) log('WARN alert sent not as meant: ' + a.richRefused);
      state.stock = ev.next;
      save();
      log('alert ' + a.messageId + ': ' + ev.intakes.length + ' new stock, ' + ev.low.length + ' low/out');
    });
  });
}

if (require.main === module) main();
module.exports = { parseStock, shopKey, skuMap, compute, message, publish, stockEvents, alertMessage, PAID_GROUPS };
