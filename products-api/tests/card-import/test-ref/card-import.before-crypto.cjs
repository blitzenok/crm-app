'use strict';
// card-import.cjs — approved card payments (BLR-…) and price requests (QT-…) from the payment module's store become
// CRM orders in orders.json. The store belongs to the owner's agents' sidecar (/opt/crm-umg); it is only ever read.
// Loaded by products-api.cjs, the only writer of orders.json, which hands in its own functions (sanitizeOrder,
// priceCheck, discountFields, isExcludedIdentity, the Customer.io tracker) so an imported order has exactly the shape
// and the price check of a storefront order. Source of truth: services/card-import/ in biofirst-hosting.
// Spec: docs/superpowers/specs/2026-09-27-card-orders-into-crm-design.md

const SERVICE_SKUS = new Set(['DRY-RUN', 'probe', 'LIVE10']);
const SHOP_DOMAINS = ['biolabsresearch.co', 'blrcommerce.io'];
const RESERVED_REF_RE = /^(BLR|QT)-/i;
const REF_RE = { card: /^BLR-\d{1,9}$/, quote: /^QT-\d{1,9}$/ };
const COUPON_RE = /(?:^|[\s;,])coupon:([A-Za-z0-9_-]{1,40})/;
// What the payment module's own cascade treats as an approval (evidence/sidecar/server/lib/cascade.js:13,
// lib/decline.js:65 cascadeAction 'success'); UMG itself hands back CAPTURED. Anything narrower would call a real
// charge a test.
const APPROVED_STATUS_RE = /^(APPROVED|CAPTURED|PAID|SUCCESS)$/i;

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
function money(n) { return (Math.round(Number(n) * 100) / 100).toFixed(2); }
function cents(n) { return Math.round(Number(n) * 100); }

// The store as the sidecar writes it (checked 2026-09-27). Anything else is refused whole, never half-read.
function parseSource(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { return { ok: false, reason: 'source is not JSON' }; }
  if (!isObj(data)) return { ok: false, reason: 'source is not an object' };
  if (!Array.isArray(data.orders) || !Array.isArray(data.quotes)) return { ok: false, reason: 'source has no orders/quotes arrays' };
  return { ok: true, orders: data.orders, quotes: data.quotes };
}

// '' when the record carries every field the import reads, otherwise the first problem found.
function recordProblem(rec, kind) {
  if (!isObj(rec)) return 'not an object';
  if (typeof rec.id !== 'string' || !REF_RE[kind].test(rec.id)) return 'bad id';
  for (const k of ['createdAt', 'updatedAt']) {
    if (typeof rec[k] !== 'string' || !Number.isFinite(Date.parse(rec[k]))) return 'bad ' + k;
  }
  if (typeof rec.status !== 'string') return 'bad status';
  const amount = Number(rec.amount);
  if ((typeof rec.amount !== 'string' && typeof rec.amount !== 'number') || !Number.isFinite(amount) || amount < 0) return 'bad amount';
  if (!isObj(rec.customer)) return 'bad customer';
  if (!Array.isArray(rec.items) || !rec.items.length) return 'bad items';
  for (const it of rec.items) {
    if (!isObj(it) || typeof it.sku !== 'string' || typeof it.name !== 'string') return 'bad item';
    if (!Number.isInteger(Number(it.qty)) || Number(it.qty) < 1) return 'bad item qty';
    if (!Number.isFinite(Number(it.amount))) return 'bad item amount';
  }
  if (kind === 'card' && !Array.isArray(rec.attempts)) return 'bad attempts';
  return '';
}

function slugList(catalog) {
  return (Array.isArray(catalog) ? catalog : [])
    .filter(p => isObj(p) && typeof p.slug === 'string' && p.slug)
    .map(p => p.slug)
    .sort((a, b) => b.length - a.length);
}
// sku is "<catalog slug>-<strength>"; the longest slug wins, so "bpc-157-tb-500-blend-20mg" is the blend, not bpc-157.
// A cart line with no mg tier sends the bare slug (checkout-charge.js:94-97) — that is a real match too, mg: ''.
function splitSku(sku, slugs) {
  for (const slug of slugs) {
    if (sku === slug) return { slug, mg: '' };
    if (sku.startsWith(slug + '-') && sku.length > slug.length + 1) return { slug, mg: sku.slice(slug.length + 1) };
  }
  return null;
}
// The sidecar keeps the coupon only as "coupon:CODE" inside notes.
function couponFromNotes(notes) {
  const m = String(notes || '').match(COUPON_RE);
  return m ? m[1].toUpperCase() : '';
}
// The attempt that approved the charge — the last one saying so; null when none did. An attempt flagged doublePaid (a second
// Cleffo payment for an order that was already paid, cleffo part 4) is not the payment: the CRM records the first, real one.
function approvalOf(rec) {
  const list = Array.isArray(rec.attempts) ? rec.attempts : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const a = list[i];
    if (isObj(a) && !a.doublePaid && (APPROVED_STATUS_RE.test(String(a.processorStatus || '')) || a.cascadeAction === 'success')) return a;
  }
  return null;
}
// A test is anything that did not take real money from a real customer: sandbox approvals, the sidecar's own probes,
// and the team's addresses (products-api's rules plus the shop's own domains — its qa+… addresses are not in those rules).
function isTestRecord(rec, kind, isExcludedAddress) {
  if (kind === 'card') {
    const a = approvalOf(rec);
    if (!a || a.mode !== 'live') return true;
  }
  if (rec.items.some(i => SERVICE_SKUS.has(i.sku))) return true;
  if (String(rec.idempotencyKey || '').startsWith('DRY-')) return true;
  const email = String((rec.customer && rec.customer.email) || '').trim().toLowerCase();
  const domain = email.slice(email.lastIndexOf('@') + 1);
  if (SHOP_DOMAINS.includes(domain)) return true;
  // R3 (owner, 2026-09-28): a live card charge with no email at all is still real money — the address rule below
  // (isExcludedAddress treats anything without '@' as excluded) does not apply to it. Every other rule above still
  // does. A price request with no email stays a test: only a live card approval (checked above) reaches this line.
  if (kind === 'card' && email.indexOf('@') < 0) return false;
  return !!isExcludedAddress(email);
}

function paymentOf(rec) {
  const a = approvalOf(rec) || {};
  const at = typeof a.finishedAt === 'string' && Number.isFinite(Date.parse(a.finishedAt)) ? a.finishedAt : rec.updatedAt;
  const txn = a.processorTxnId || rec.winningTxnId;
  const note = [a.processor, txn].filter(x => typeof x === 'string' && x).join(' ').slice(0, 120)
    + (/^\d{4}$/.test(String(a.cardLast4 || '')) ? ' ····' + a.cardLast4 : '');
  return { id: 'card:' + rec.id, at, kind: 'payment', method: 'card', amount: Number(money(rec.amount)), note, by: 'card-import' };
}

// The storefront's order shape (sanitizeOrder) with the catalog's price check, plus what only this import knows.
// null = the catalog could not be read; the caller retries on the next tick instead of saving an unchecked order.
function buildOrder(rec, kind, ctx) {
  const c = rec.customer;
  let anyUnresolved = false;
  const items = rec.items.map(i => {
    const s = splitSku(i.sku, ctx.slugs);
    if (!s) anyUnresolved = true;
    return { name: i.name, slug: s ? s.slug : '', mg: s ? s.mg : '', qty: Number(i.qty), price: Number(i.amount) };
  });
  const subtotal = items.reduce((a, i) => a + i.price * i.qty, 0);
  const total = Number(rec.amount);
  const od = {
    ref: rec.id,
    customer: { firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone },
    shipping: { address1: c.address, city: c.city, state: c.state, zip: c.zip, country: c.country },
    items,
    subtotal: Number(money(subtotal)),
    shippingCost: Math.max(0, Number(money(total - subtotal))),
    total,
    notes: rec.notes,
    coupon: couponFromNotes(rec.notes),
    timestamp: rec.createdAt
  };
  if (kind === 'quote' && rec.attribution !== undefined) od.attribution = rec.attribution;
  const order = ctx.sanitizeOrder(od, kind === 'card' ? 'card' : 'quote-request');
  const check = ctx.priceCheck(order);
  if (!check || check.price_check === 'skipped') return null;
  for (const k of ['subtotal_server', 'total_server', 'price_mismatch', 'unknown_items']) {
    if (check[k] !== undefined) order[k] = check[k];
  }
  Object.assign(order, ctx.discountFields(order, check));
  if (kind === 'card') {
    // A line whose sku did not split into a catalog slug is unknown no matter what priceCheck says: the real
    // priceCheck can still match an item by name and price it at the base rate (products-api.cjs:456, :374-375),
    // which would turn a genuinely unrecognised item into a false "over/under" instead of "unknown".
    if (anyUnresolved || (check.unknown_items && check.unknown_items.length)) {
      order.charge_check = { charged: money(total), expected: null, diff: null, result: 'unknown' };
      order.total_due_server = money(total);   // spec: an item the catalog does not know -> amount due = amount charged
    } else {
      const diff = cents(total) - cents(order.total_due_server);
      order.charge_check = { charged: money(total), expected: money(order.total_due_server), diff: money(Math.abs(diff) / 100),
        result: Math.abs(diff) <= 1 ? 'match' : (diff < 0 ? 'under' : 'over') };
    }
    order.payments = [paymentOf(rec)];
  }
  order.status = kind === 'card' ? 'paid' : 'new';
  order.source = kind;
  order.source_ref = rec.id;
  order.source_created_at = rec.createdAt;
  order.source_updated_at = rec.updatedAt;
  if (isTestRecord(rec, kind, ctx.isExcludedAddress)) order.test = true;
  return order;
}

// New records go on top (newest first, as notify-order stores them). An already imported card record whose source
// changed gets only its payment facts refreshed: status, notes, items and money edited in CRM stay as the team left
// them. A ref held by an order this import did not create, or whose source record changed identity (the sidecar's
// seq restarted and reused the number), is reported, never overwritten. `seen` is every ref this import has ever
// created (kept by the caller across ticks and, ideally, restarts — see createCardImport): a built ref missing from
// `orders` but present in `seen` was removed in CRM on purpose and is not recreated.
function mergeInto(orders, built, seen) {
  const seenSet = seen instanceof Set ? seen : new Set(Array.isArray(seen) ? seen : []);
  const byRef = new Map();
  orders.forEach((o, i) => { if (isObj(o) && typeof o.ref === 'string') byRef.set(o.ref, i); });
  const next = orders.slice();
  const created = [], updated = [], taken = [], deleted = [];
  const claimed = new Set(); // guards a corrupt read where two records in the same batch share one ref
  for (const { order, kind } of built) {
    if (claimed.has(order.ref)) continue;
    claimed.add(order.ref);
    const i = byRef.get(order.ref);
    if (i === undefined) {
      if (seenSet.has(order.ref)) { deleted.push(order.ref); continue; }
      created.push(order); seenSet.add(order.ref); continue;
    }
    const cur = next[i];
    const sameSource = isObj(cur) && cur.source_ref === order.ref &&
      (!cur.source_created_at || !order.source_created_at || cur.source_created_at === order.source_created_at);
    if (!sameSource) {
      // 'foreign': this ref belongs to an order the import never created (e.g. QT-5021 from the old agents' bridge,
      // predating this import) — history, not an emergency. 'changed': the import DID create this ref, but the
      // source record's identity moved under it (the sidecar's seq restarted and reused the number) — a live
      // payment silently dropped, a real problem.
      taken.push({ ref: order.ref, reason: isObj(cur) && cur.source_ref === order.ref ? 'changed' : 'foreign' });
      continue;
    }
    seenSet.add(order.ref);
    if (kind !== 'card' || !(Date.parse(order.source_updated_at) > Date.parse(cur.source_updated_at))) continue;
    const pay = order.payments[0];
    const payments = (Array.isArray(cur.payments) ? cur.payments : []).filter(p => !(isObj(p) && p.id === pay.id)).concat([pay]);
    next[i] = Object.assign({}, cur, { payments, charge_check: order.charge_check, source_updated_at: order.source_updated_at });
    updated.push(next[i]);
  }
  return { next: created.slice().reverse().concat(next), created, updated, taken, deleted, seen: seenSet };
}

// F5: the payment module's webhook can flip an already-approved card record's status to REFUNDED or CHARGEBACK
// (evidence/sidecar/server/lib/cascade.js:249-251, applyProcessorUpdate — order.status = attempt.processorStatus in
// lower case); it never goes back to "approved", so these records never appear in `candidates` above. Only a ref
// this import already created (found by source_ref) gets the refund payment; a record refunded before this import
// ever approved it has no CRM order carrying that source_ref, so there is nothing to find — it is not "created" now
// just because it is refunded. CRM's own execution status (shipped, managerNote, ...) is never touched.
// R1: source_ref alone is not enough — the sidecar's seq can restart and reuse a ref (store.js:59-78), so the ref
// found by source_ref may now belong to a different source record than the one this order was built from. Same
// check as mergeInto's sameSource: source_created_at must also match (missing on the CRM order, the pre-F1 format,
// always counts as a match). A mismatch is reported in `mismatched`, never applied.
const REFUND_STATUS_RE = /^(refunded|chargeback)$/i;
function applyRefunds(orders, records) {
  const next = orders.slice();
  const refunded = [];
  const mismatched = [];
  for (const rec of records) {
    if (!isObj(rec) || typeof rec.id !== 'string' || !REFUND_STATUS_RE.test(String(rec.status || ''))) continue;
    const i = next.findIndex(o => isObj(o) && o.source_ref === rec.id);
    if (i === -1) continue;
    const cur = next[i];
    if (cur.source_created_at && cur.source_created_at !== rec.createdAt) { mismatched.push(rec.id); continue; }
    const refundId = 'refund:' + rec.id;
    if ((Array.isArray(cur.payments) ? cur.payments : []).some(p => isObj(p) && p.id === refundId)) continue;
    const status = String(rec.status).toLowerCase();
    const amount = Number.isFinite(Number(rec.amount)) ? Number(money(rec.amount)) : 0;
    const at = typeof rec.updatedAt === 'string' && Number.isFinite(Date.parse(rec.updatedAt)) ? rec.updatedAt : cur.source_updated_at;
    const payment = { id: refundId, at, kind: 'refund', method: 'card', amount, note: status, by: 'card-import' };
    next[i] = Object.assign({}, cur, { payments: (Array.isArray(cur.payments) ? cur.payments : []).concat([payment]),
      source_updated_at: at });
    refunded.push({ ref: rec.id, status, amount, test: cur.test === true });
  }
  return { next, refunded, mismatched };
}

const MODES = new Set(['off', 'dry', 'on']);

function describe(o) {
  return o.ref + ' ' + o.source + (o.test ? ' test' : ' live') + (o.charge_check ? ' check=' + o.charge_check.result : '');
}

function createCardImport(deps) {
  const log = deps.log || ((s) => console.log(s));
  const logError = deps.logError || ((s) => console.error(s));
  let mode = String(deps.mode === undefined ? 'off' : deps.mode).trim().toLowerCase();
  if (!MODES.has(mode)) {
    logError('[card-import] ERROR unknown CARD_IMPORT_MODE ' + JSON.stringify(deps.mode) + ', import is off');
    mode = 'off';
  }
  const since = Date.parse(String(deps.eventsSince || ''));
  if (mode === 'on' && !Number.isFinite(since)) {
    logError('[card-import] ERROR CARD_IMPORT_EVENTS_SINCE is not a date, no Customer.io events will be sent');
  }
  let lastProblem = '';
  let sourceFailStreak = 0; // source.json is written with a plain writeFileSync (not atomic): debounce one-tick blips
  let memSeen = new Set(); // refs this import has created, kept in-process even when the caller has no seen-log file
  const seenBad = new Set(), seenDry = new Set(), seenTaken = new Set(), seenNoApproval = new Set();
  let refundMismatchLogged = false; // R1: this specific alert, once for the life of the process, not once per ref
  let timer = null, firstTimer = null;

  // One line per change of state, not one per minute: ops-watch turns every new error line into a Telegram message.
  function problem(reason) {
    if (reason === lastProblem) return;
    if (reason) logError('[card-import] ERROR ' + reason);
    else if (lastProblem) log('[card-import] ok again (was: ' + lastProblem + ')');
    lastProblem = reason;
  }
  function alertIfMismatch(o) {
    const c = o.charge_check;
    if (!o.test && c && (c.result === 'under' || c.result === 'over')) {
      logError('[card-import] MISMATCH ' + o.ref + ' ' + c.result + ' charged=' + c.charged + ' expected=' + c.expected);
    }
  }

  function tick() {
    if (mode === 'off') return { skipped: 'off' };
    let text;
    try { text = deps.readSource(); } catch (e) { problem('source unreadable: ' + (e.code || e.message)); return { error: 'source' }; }
    const parsed = parseSource(text);
    if (!parsed.ok) {
      sourceFailStreak++;
      if (sourceFailStreak >= 2) problem(parsed.reason);
      return { error: 'source' };
    }
    sourceFailStreak = 0;
    const catalog = deps.readProducts();
    if (!Array.isArray(catalog) || !catalog.length) { problem('catalog unavailable'); return { error: 'catalog' }; }
    const ctx = { slugs: slugList(catalog), sanitizeOrder: deps.sanitizeOrder, priceCheck: deps.priceCheck,
      discountFields: deps.discountFields, isExcludedAddress: deps.isExcludedAddress };
    const built = [];
    const candidates = parsed.orders
      .filter(r => isObj(r) && r.status === 'approved' && r.inFlight !== true).map(rec => ({ rec, kind: 'card' }))
      .concat(parsed.quotes.map(rec => ({ rec, kind: 'quote' })));
    for (const { rec, kind } of candidates) {
      const bad = recordProblem(rec, kind);
      if (bad) {
        const id = String(isObj(rec) && rec.id !== undefined ? rec.id : '?').slice(0, 20);
        if (!seenBad.has(id + ':' + bad)) { seenBad.add(id + ':' + bad); logError('[card-import] ERROR skipped record ' + id + ': ' + bad); }
        continue;
      }
      if (kind === 'card' && !approvalOf(rec)) {
        // Status says approved but no attempt agrees — a payment-module bug, not an ordinary sandbox test.
        // buildOrder still falls back to test:true (the safe default), but this stays visible instead of silent.
        const id = String(rec.id).slice(0, 20);
        if (!seenNoApproval.has(id)) { seenNoApproval.add(id); logError('[card-import] ERROR approved record with no approving attempt: ' + id); }
      }
      const order = buildOrder(rec, kind, ctx);
      if (!order) { problem('catalog unavailable'); return { error: 'catalog' }; }
      built.push({ order, kind });
    }
    let orders;
    try { orders = deps.readOrders(); } catch (e) { problem('orders.json unreadable: ' + e.message); return { error: 'orders' }; }
    if (!Array.isArray(orders)) { problem('orders.json is not an array'); return { error: 'orders' }; }
    const seenSet = new Set(memSeen);
    if (deps.readSeen) {
      // F1: a missing file (ENOENT) is an empty journal, same as always — every other failure (bad JSON, EACCES) or
      // a value that is not a plain array of ref strings means the journal cannot be trusted, and mergeInto below
      // would then treat every previously-deleted ref as new again. Stop the whole tick before it reads orders.json
      // or sends anything, same as the other "cannot trust the data" guards above (source, catalog, orders.json).
      let list;
      try {
        list = deps.readSeen();
      } catch (e) {
        if (e && e.code === 'ENOENT') { list = []; }
        else { problem('seen log unreadable: ' + ((e && e.message) || e)); return { error: 'seen' }; }
      }
      if (!Array.isArray(list) || !list.every(r => typeof r === 'string')) {
        problem('seen log unreadable: not an array of strings');
        return { error: 'seen' };
      }
      list.forEach(r => seenSet.add(r));
    }
    const m = mergeInto(orders, built, seenSet);
    for (const t of m.taken) {
      if (seenTaken.has(t.ref)) continue;
      seenTaken.add(t.ref);
      if (t.reason === 'foreign') {
        // F4: history, not an emergency — a ref this import never created (e.g. QT-5021 from the old agents'
        // bridge) already sits in CRM. logError would forward it to Telegram through ops-watch; this does not.
        log('[card-import] ref already in CRM from before the import, left as is: ' + t.ref);
      } else {
        logError('[card-import] ERROR ref taken by another order, not imported: ' + t.ref);
      }
    }
    if (mode === 'dry') {
      if (!m.created.length && !m.updated.length) { problem(''); return { created: 0, updated: 0 }; }
      problem('');
      for (const o of m.created.concat(m.updated)) {
        const key = o.ref + '@' + o.source_updated_at;
        if (seenDry.has(key)) continue;
        seenDry.add(key);
        log('[card-import] DRY would ' + (m.created.includes(o) ? 'create ' : 'update ') + describe(o));
      }
      return { created: m.created.length, updated: m.updated.length, dry: true };
    }
    // F5: a refund/chargeback webhook moves a card record's status away from "approved" (applyRefunds above), so
    // these never appear in `built`/`m` — applied on top of mergeInto's result, before deciding if there is
    // anything to write this tick.
    const refundRecs = parsed.orders.filter(r => isObj(r) && REFUND_STATUS_RE.test(String((r && r.status) || '')));
    const rf = applyRefunds(m.next, refundRecs);
    // R1: logged once for the life of the process, not once per tick or per ref — a restarted sidecar seq reusing a
    // ref is a one-time anomaly to investigate, not a recurring alert to repeat every tick it stays unresolved.
    if (rf.mismatched.length && !refundMismatchLogged) {
      refundMismatchLogged = true;
      logError('[card-import] ERROR refund for a different record, not applied: ' + rf.mismatched[0]);
    }
    if (!m.created.length && !m.updated.length && !rf.refunded.length) { problem(''); return { created: 0, updated: 0 }; }
    try { deps.writeOrders(rf.next); } catch (e) { problem('orders.json write failed: ' + e.message); return { error: 'write' }; }
    memSeen = m.seen; // survives future ticks in this process even if the caller never wires a seen-log file
    if (deps.writeSeen) {
      try { deps.writeSeen(Array.from(m.seen)); } catch (e) { logError('[card-import] ERROR seen log write failed: ' + ((e && e.message) || e)); }
    }
    problem('');
    for (const o of m.created) {
      log('[card-import] created ' + describe(o));
      alertIfMismatch(o);
      // R3/C1: a live card order can have no email — nothing to send a Customer.io event to, and the tracker's
      // identifier is the address itself (AGENTS.md mailSafe), so that event is skipped below, not attempted and
      // caught. Logged here, once, only for a record actually created this tick in mode on: mergeInto only ever
      // puts a ref into m.created the first time it sees it (an already-imported or deleted-in-CRM ref goes to
      // 'updated'/'deleted' instead, per the seen journal), so this needs no dedup set of its own. Gated on
      // !o.test so a record that is a test for some other reason (sandbox, DRY- probe, service sku) never fires it.
      const email = o.customer && typeof o.customer.email === 'string' ? o.customer.email : '';
      if (!o.test && o.source === 'card' && email.indexOf('@') < 0) {
        logError('[card-import] LIVE-NO-EMAIL ' + o.ref + ' amount=' + money(o.total));
      }
      if (!o.test && email.indexOf('@') > -1 && Number.isFinite(since) && Date.parse(o.timestamp) >= since) {
        try { deps.track(o, rf.next); log('[card-import] event order_placed ' + o.ref); }
        catch (e) { logError('[card-import] ERROR event order_placed ' + o.ref + ': ' + ((e && e.message) || e)); }
      }
    }
    for (const o of m.updated) { log('[card-import] updated ' + describe(o)); alertIfMismatch(o); }
    for (const r of rf.refunded) {
      // Test refunds update CRM silently (a repeat tick must still see the guard payment already there); a real
      // one is the owner's money moving and must reach Telegram through ops-watch (logError), never just log().
      if (!r.test) logError('[card-import] REFUND ' + r.ref + ' ' + r.status + ' amount=' + money(r.amount));
    }
    return { created: m.created.length, updated: m.updated.length };
  }

  // A throw inside setInterval would be an uncaughtException and a pm2 restart of the whole shop API. Routed
  // through problem() so a dependency that keeps throwing (e.g. the catalog API is down) logs once, not every tick.
  function run() {
    try { tick(); } catch (e) { problem('tick failed: ' + ((e && e.message) || e)); }
  }
  function start() {
    if (mode === 'off') { log('[card-import] off'); return; }
    const every = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : 60000;
    firstTimer = setTimeout(run, Math.min(5000, every));
    timer = setInterval(run, every);
    if (firstTimer.unref) firstTimer.unref();
    if (timer.unref) timer.unref();
    log('[card-import] ' + mode + ', every ' + every + ' ms');
  }
  function stop() { clearTimeout(firstTimer); clearInterval(timer); }
  return { tick, start, stop, mode: () => mode };
}

module.exports = {
  RESERVED_REF_RE, parseSource, recordProblem, slugList, splitSku, couponFromNotes, approvalOf, isTestRecord,
  buildOrder, mergeInto, applyRefunds, createCardImport
};
