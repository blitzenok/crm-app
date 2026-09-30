#!/usr/bin/env node
'use strict';
// tg-daily.cjs — the morning summary for the team's Telegram group (topic «daily stats»): yesterday's orders, paid revenue,
// average order, new and returning buyers, payment methods, top items, and the month so far. Counted with the CRM's own
// models (orders-model.js, finance-model.js — the rules of Finance Reports: "paid" by the payments on the order, by order
// date), so the group and the CRM page never disagree. No name, address or e-mail goes out. Plus, when there are any, the line
// "Paid > 24h, no tracking: N" with the order numbers (untrackedPaid): paid and still without a tracking number.
// Run by cron every hour (/etc/cron.d/tg-daily); it sends once a day, from TG_DAILY_HOUR in TG_DAILY_TZ, for the day
// before, and a failed send is tried again the next hour. Settings in the env file next to the alerts' (ENV_FILE):
// TG_DAILY_MODE off|on, TG_DAILY_HOUR (0-23, default 9), TG_DAILY_TZ (default Asia/Jerusalem), TG_ALERTS_TOPIC_DAILY.
// Source: services/tg-alerts/ in biofirst-hosting; install — deploy/INSTALL.md.
const fs = require('fs');
const path = require('path');

const DEFAULT_HOUR = 9;
const DEFAULT_TZ = 'Asia/Jerusalem';
const FINANCE_URL = 'https://crm.biolabsresearch.co/crm/finance-reports.html';
const HEADING_SIZE = 5;
const TOP_ITEMS = 3;

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
function parseDaily(env) {
  const e = env || {};
  const problems = [];
  const mode = String(e.TG_DAILY_MODE || '').trim().toLowerCase() === 'on' ? 'on' : 'off';
  let hour = DEFAULT_HOUR;
  const rawHour = String(e.TG_DAILY_HOUR || '').trim();
  if (rawHour) {
    if (/^([01]?[0-9]|2[0-3])$/.test(rawHour)) hour = Number(rawHour);
    else problems.push('TG_DAILY_HOUR is not 0-23, using ' + DEFAULT_HOUR);
  }
  let tz = DEFAULT_TZ;
  const rawTz = String(e.TG_DAILY_TZ || '').trim();
  if (rawTz) {
    if (validTz(rawTz)) tz = rawTz;
    else problems.push('TG_DAILY_TZ is not a time zone, using ' + DEFAULT_TZ);
  }
  return { mode, hour, tz, problems };
}

// Calendar day and hour in the owner's zone (Intl handles summer time; no library).
function localParts(ms, tz) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { ymd: p.year + '-' + p.month + '-' + p.day, hour: Number(p.hour) };
}
function localYmd(ms, tz) { return localParts(ms, tz).ymd; }
function prevYmd(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
// Which day to report now: the day before today, once today has reached the hour and it was not sent yet.
function dueDay(nowMs, state, cfg) {
  const now = localParts(nowMs, cfg.tz);
  if (now.hour < cfg.hour) return null;
  const day = prevYmd(now.ymd);
  return state && state.lastDay >= day ? null : day;
}

function methodOf(r) {
  const m = String(r.paymentMethod || '').trim().toLowerCase();
  if (/^qt-/i.test(r.ref || '') || /^quote/.test(m)) return 'quote';
  if (/^card/.test(m)) return 'card';
  if (/crypto/.test(m)) return 'crypto';
  return m || 'other';
}
// records: OrdersModel.load(orders.json). Real orders only: not test, not a stored duplicate, not one of our own test addresses.
function stats(records, opts) {
  const { day, tz, OM, FM } = opts;
  const own = opts.ownAddresses instanceof Set ? opts.ownAddresses : new Set();
  const email = (r) => String(r.email || '').trim().toLowerCase();
  const when = (r) => FM.whenOf(r);
  const real = (Array.isArray(records) ? records : []).filter(r => r && r.kind === 'order' && !r.isTest && !r.duplicateOf && !own.has(email(r)));
  const dayOf = (r) => { const t = when(r); return Number.isNaN(t) ? '' : localYmd(t, tz); };
  const onDay = real.filter(r => dayOf(r) === day);
  const live = onDay.filter(r => r.group !== 'cancelled');
  const paidDay = FM.aov(FM.select(onDay, { paidOnly: true }));
  const month = real.filter(r => { const d = dayOf(r); return d && d.slice(0, 7) === day.slice(0, 7) && d <= day; });
  const paidMonth = FM.aov(FM.select(month, { paidOnly: true }));
  let newCustomers = 0, returning = 0;
  const seen = new Set();
  for (const r of live) {
    const e = email(r);
    if (!e || seen.has(e)) continue;
    seen.add(e);
    const t = when(r);
    const before = real.some(o => o !== r && email(o) === e && o.group !== 'cancelled' && when(o) < t && dayOf(o) < day);
    if (before) returning++; else newCustomers++;
  }
  const methods = {};
  for (const r of live) { const m = methodOf(r); methods[m] = (methods[m] || 0) + 1; }
  const top = FM.products(live, { top: TOP_ITEMS }).filter(p => p.key !== 'other').slice(0, TOP_ITEMS)
    .map(p => ({ name: [p.name, p.mg].filter(Boolean).join(' '), units: p.units }));
  const monthName = new Date(day + 'T12:00:00Z').toLocaleString('en-US', { month: 'long', timeZone: 'UTC' });
  return {
    day, orders: live.length, requests: live.filter(r => methodOf(r) === 'quote').length, cancelled: onDay.length - live.length,
    paidOrders: paidDay.orders, revenue: paidDay.value, average: paidDay.average, newCustomers, returning, methods, top,
    month: { paidOrders: paidMonth.orders, revenue: paidMonth.value, label: monthName }
  };
}

// "Paid, but no tracking number after 24 hours" (ad readiness 30.09): the warehouse order and the tracking number are still typed
// by hand, so this is the morning check that nobody paid is forgotten. Not day-bound: everything that stands right now.
// Paid = the statuses in which the money is in and the parcel is not yet delivered (paid / payment-confirmed / processing, and
// shipped / in-transit without a number); delivered is history. The moment of payment: the last payment on the order, else the
// last update (a status set by hand), else the order date. No date we can read: listed anyway, we cannot prove it is fresh.
const UNTRACKED_AFTER_H = 24;
const UNTRACKED_GROUPS = ['toship', 'shipped'];
const UNTRACKED_LIST = 10;
const ORDERS_URL = 'https://crm.biolabsresearch.co/crm/orders.html';
function untrackedPaid(records, opts) {
  const { now, OM } = opts;
  const own = opts.ownAddresses instanceof Set ? opts.ownAddresses : new Set();
  const out = [];
  for (const r of Array.isArray(records) ? records : []) {
    if (!r || r.kind !== 'order' || r.isTest || r.duplicateOf || !UNTRACKED_GROUPS.includes(r.group)) continue;
    if (String(r.trackingNumber || '').trim() || own.has(String(r.email || '').trim().toLowerCase())) continue;
    if (OM.paymentStatus(r).code === 'refunded') continue;
    const paidTimes = (r.payments || []).filter(p => p.kind === 'payment').map(p => OM.whenMs(p.at)).filter(t => !Number.isNaN(t));
    const t = paidTimes.length ? Math.max(...paidTimes) : [r.updatedAt, r.createdAt].map(s => OM.whenMs(s)).find(x => !Number.isNaN(x));
    const hours = t === undefined ? null : Math.floor((now - t) / 3600000);
    if (hours !== null && hours < UNTRACKED_AFTER_H) continue;
    out.push({ ref: r.ref, amount: typeof r.toPay === 'number' && r.toPay > 0 ? r.toPay : null, hours });
  }
  // the longest waiting first; an unreadable date goes first (worst case)
  return out.sort((a, b) => (b.hours === null ? Infinity : b.hours) - (a.hours === null ? Infinity : a.hours));
}
function ageLabel(h) { return h === null ? '' : h >= 48 ? Math.floor(h / 24) + 'd' : h + 'h'; }

function usd(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function plain(v, max) { return String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max); }
function cell(text, align) { return { text, align: align || 'left', valign: 'middle' }; }
function dayLabel(ymd) {
  return new Date(ymd + 'T12:00:00Z').toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
const METHOD_LABEL = { card: 'Card', crypto: 'Crypto', quote: 'Price request' };

function message(s) {
  const title = 'Daily stats · ' + dayLabel(s.day);
  const blocks = [{ type: 'heading', size: HEADING_SIZE, text: ['📊 ', { type: 'bold', text: title }] }];
  const lines = ['📊 ' + title];
  if (!s.orders && !s.cancelled) {
    blocks.push({ type: 'paragraph', text: { type: 'italic', text: 'No orders yesterday.' } });
    lines.push('No orders yesterday.');
  } else {
    const rows = [
      ['Orders', String(s.orders) + (s.requests ? ' (' + s.requests + ' price request' + (s.requests === 1 ? '' : 's') + ')' : '')],
      ['Revenue (paid)', usd(s.revenue) + (s.paidOrders ? ' · ' + s.paidOrders + ' paid' : '')],
      ['Average order', s.paidOrders ? usd(s.average) : '—'],
      ['New / returning', s.newCustomers + ' / ' + s.returning]
    ];
    if (s.cancelled) rows.push(['Cancelled', String(s.cancelled)]);
    blocks.push({ type: 'table', is_compact: true, is_striped: true, cells: rows.map(([k, v]) => [cell(k), cell(k === 'Revenue (paid)' ? { type: 'bold', text: v } : v, 'right')]) });
    for (const [k, v] of rows) lines.push(k + ': ' + v);
    const methods = Object.keys(s.methods || {}).sort((a, b) => s.methods[b] - s.methods[a]);
    if (methods.length) {
      const text = methods.map(m => (METHOD_LABEL[m] || plain(m, 20)) + ' ' + s.methods[m]).join(' · ');
      blocks.push({ type: 'paragraph', text: ['Payment: ', text] });
      lines.push('Payment: ' + text);
    }
    if (s.top && s.top.length) {
      blocks.push({ type: 'table', is_compact: true, is_bordered: true, cells: [[Object.assign(cell('Top items'), { is_header: true }), Object.assign(cell('Qty', 'right'), { is_header: true })]]
        .concat(s.top.map(t => [cell(plain(t.name, 60)), cell('×' + t.units, 'right')])) });
      lines.push('Top: ' + s.top.map(t => plain(t.name, 60) + ' ×' + t.units).join('; '));
    }
  }
  const stuck = Array.isArray(s.untracked) ? s.untracked : [];
  if (stuck.length) {
    const head = '⚠️ Paid > ' + UNTRACKED_AFTER_H + 'h, no tracking: ' + stuck.length;
    const shown = stuck.slice(0, UNTRACKED_LIST);
    const row = (u) => [plain(u.ref, 40), u.amount === null ? 'sum not set' : usd(u.amount), ageLabel(u.hours)].filter(Boolean);
    const more = stuck.length - shown.length;
    blocks.push({ type: 'paragraph', text: { type: 'bold', text: head } });
    blocks.push({ type: 'table', is_compact: true, is_bordered: true, cells: shown.map(u => { const [ref, sum, age] = row(u); return [cell(ref), cell(sum, 'right'), cell(age || '', 'right')]; }) });
    if (more > 0) blocks.push({ type: 'paragraph', text: { type: 'italic', text: '+' + more + ' more' } });
    lines.push(head);
    for (const u of shown) lines.push(row(u).join(' · '));
    if (more > 0) lines.push('+' + more + ' more');
    lines.push('Orders: ' + ORDERS_URL);
  }
  const monthLine = s.month.label + ' so far: ' + usd(s.month.revenue) + ' · ' + s.month.paidOrders + ' paid order' + (s.month.paidOrders === 1 ? '' : 's');
  blocks.push({ type: 'paragraph', text: { type: 'bold', text: monthLine } });
  lines.push(monthLine, 'Finance Reports: ' + FINANCE_URL);
  const buttons = [{ text: 'Finance Reports', url: FINANCE_URL, style: 'primary' }];
  if (stuck.length) buttons.push({ text: 'Orders', url: ORDERS_URL });
  blocks.push({ type: 'buttons', buttons });
  return { type: 'daily', text: lines.join('\n'), rich: { blocks, skip_entity_detection: true } };
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
function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');          // print, send nothing, keep the state
  const force = args.includes('--now');        // yesterday's summary now, whatever the hour or the state
  const ENV_FILE = process.env.ENV_FILE || '/opt/crm-api/.env';
  const ORDERS = process.env.ORDERS_FILE || path.join(__dirname, 'orders.json');
  const CRM_DIR = process.env.CRM_DIR || '/var/www/mastersol/html/CRM';
  const STATE = process.env.TG_DAILY_STATE || '/var/lib/biolabs-ops/tg-daily.json';
  const log = (s) => console.log(new Date().toISOString() + ' [tg-daily] ' + s);
  const env = readEnv(ENV_FILE);
  const A = require(path.join(__dirname, 'tg-alerts.cjs'));
  const cfg = parseDaily(env);
  for (const p of cfg.problems) log('ERROR ' + p);
  if (cfg.mode !== 'on' && !dry && !force) return;
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')) || {}; } catch (e) { state = {}; }
  const day = force || dry ? prevYmd(localYmd(Date.now(), cfg.tz)) : dueDay(Date.now(), state, cfg);
  if (!day) return;
  const OM = require(path.join(CRM_DIR, 'orders-model.js'));
  const FM = require(path.join(CRM_DIR, 'finance-model.js'));
  const alertsCfg = A.parseConfig(Object.assign({}, env, { TG_ALERTS_MODE: 'on', TG_ALERTS_SINCE: env.TG_ALERTS_SINCE || new Date().toISOString() }));
  const records = OM.load(JSON.parse(fs.readFileSync(ORDERS, 'utf8')));
  const s = stats(records, { day, tz: cfg.tz, OM, FM, ownAddresses: alertsCfg.ownAddresses });
  s.untracked = untrackedPaid(records, { now: Date.now(), OM, ownAddresses: alertsCfg.ownAddresses });
  const msg = message(s);
  if (dry) { console.log(msg.text); return; }
  if (!alertsCfg.token || !alertsCfg.chatId) { log('ERROR bot token or chat id missing, not sent'); process.exitCode = 1; return; }
  A.send(alertsCfg, msg, r => {
    if (!r.ok) { log('ERROR not sent for ' + day + ': ' + (r.status || '') + ' ' + (r.error || '') + ' (tried again next hour)'); process.exitCode = 1; return; }
    if (r.richRefused) log('WARN sent not as meant: ' + r.richRefused);
    try {
      fs.writeFileSync(STATE + '.tmp', JSON.stringify({ lastDay: day, sentAt: new Date().toISOString(), messageId: r.messageId }) + '\n');
      fs.renameSync(STATE + '.tmp', STATE);
    } catch (e) { log('ERROR sent but state not written (may repeat next hour): ' + e.message); }
    log('sent ' + day + ': ' + s.orders + ' orders, ' + usd(s.revenue) + ' paid, ' + s.untracked.length + ' paid without tracking');
  });
}

if (require.main === module) main();
module.exports = { parseDaily, localYmd, dueDay, stats, untrackedPaid, message, prevYmd };
