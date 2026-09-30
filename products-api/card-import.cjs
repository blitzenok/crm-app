'use strict';
// card-import.cjs — approved card payments (BLR-…) and price requests (QT-…) from the payment module's store become
// CRM orders in orders.json. The store belongs to the owner's agents' sidecar (/opt/crm-umg); it is only ever read.
// Loaded by products-api.cjs, the only writer of orders.json, which hands in its own functions (sanitizeOrder,
// priceCheck, discountFields, isExcludedIdentity, the Customer.io tracker) so an imported order has exactly the shape
// and the price check of a storefront order. Source of truth: services/card-import/ in biofirst-hosting.
// Spec: docs/superpowers/specs/2026-09-27-card-orders-into-crm-design.md
//
// Crypto part (2026-09-30, its own mode CRYPTO_IMPORT_MODE off|dry|on and CRYPTO_IMPORT_SINCE, independent of the card
// mode; same tick, one read of the store and of orders.json, one write). The payment module checks a USDT/USDC transfer
// on the chain itself and records the verdict in the store (orders[], paymentMethod 'crypto', orderRef CR-XXXXXXXX,
// cryptoPayment{...}). A record the module has verified on-chain is a candidate:
//   - the CRM already holds the order (the browser sent notify-order): after it matches the module's record on e-mail,
//     cart lines and amount, a new/pending order becomes paid and gets the payment crypto:<ref>; a mismatch changes
//     nothing and raises CRYPTO MISMATCH (the CR- number is known to the buyer, and whoever sends notify-order first
//     sets the cart in the CRM, so the CRM order is compared with the module's, never trusted);
//   - the CRM has no order (the page never sent it): the import creates it, paid, from the module's record;
//   - later the module can cancel or refund a record the import already booked: the payment list gets the refund and
//     ops-watch gets a CRYPTO line, the CRM status stays as the team left it.
// The paid letter for a crypto order is allowed only with the payment crypto:<ref> written here (order-letters.cjs).
// Review, hold, confirming and awaiting records are the module's own business and are never written.

const SERVICE_SKUS = new Set(['DRY-RUN', 'probe', 'LIVE10']);
const SHOP_DOMAINS = ['biolabsresearch.co', 'blrcommerce.io'];
const RESERVED_REF_RE = /^(BLR|QT)-/i;
const REF_RE = { card: /^BLR-\d{1,9}$/, quote: /^QT-\d{1,9}$/ };
const COUPON_RE = /(?:^|[\s;,])coupon:([A-Za-z0-9_-]{1,40})/;
// What the payment module's own cascade treats as an approval (evidence/sidecar/server/lib/cascade.js:13,
// lib/decline.js:65 cascadeAction 'success'); UMG itself hands back CAPTURED. Anything narrower would call a real
// charge a test.
const APPROVED_STATUS_RE = /^(APPROVED|CAPTURED|PAID|SUCCESS)$/i;
// The payment module's REF_ALPHABET (crypto-checkout.js): no I, O, 0, 1.
const CRYPTO_REF_RE = /^CR-[A-HJ-NP-Z2-9]{8}$/;
const CRYPTO_OPEN_STATUS = new Set(['', 'new', 'pending']);
const CRYPTO_PAID_STATUS = new Set(['paid', 'payment-confirmed', 'processing']);
const CRYPTO_SHIPPED_STATUS = new Set(['shipped', 'in-transit', 'delivered']);
const CRYPTO_NOTE_BY = 'card-import';

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
  // The record's own attribution (price requests always carry it; card and crypto records once the module keeps it). Folding,
  // validation and size limits are sanitizeOrder's (attributionOf): a non-object is dropped, every field is cut down.
  if (rec.attribution !== undefined) od.attribution = rec.attribution;
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

// ---- crypto (2026-09-30) ---------------------------------------------------------------------------------------------

function normEmail(v) { return String(v === undefined || v === null ? '' : v).trim().toLowerCase(); }
function normMg(v) { return String(v === undefined || v === null ? '' : v).replace(/\s+/g, '').toLowerCase(); }
function paymentsOf(order) { return Array.isArray(order.payments) ? order.payments : []; }
function hasPayment(order, id) { return paymentsOf(order).some(p => isObj(p) && p.id === id); }

// The conditions the payment module itself calls "verified" (lib/crypto-payment.js isCryptoVerified), repeated here and
// not imported: the module is the agents' code and this must keep meaning "the chain said so" if they refactor it.
function isCryptoVerified(rec) {
  const cp = rec.cryptoPayment;
  return rec.paymentMethod === 'crypto' && isObj(cp) && cp.status === 'paid' && cp.verifiedOnChain === true &&
    isObj(cp.sanctions) && (cp.sanctions.status === 'clear' || cp.sanctions.status === 'skipped_fail_open') &&
    rec.status === 'crypto_paid' && rec.paymentConfirmed === true;
}
// null = not ours to book (not verified, in flight, a ref the shop does not issue, verified before SINCE); '' = a
// candidate the import can read; anything else is the first thing wrong with a record the chain did verify.
function cryptoCandidate(rec, sinceMs) {
  if (!isObj(rec) || rec.inFlight === true || !isCryptoVerified(rec)) return null;
  if (typeof rec.orderRef !== 'string' || !CRYPTO_REF_RE.test(rec.orderRef)) return null;
  const cp = rec.cryptoPayment;
  const verifiedAt = Date.parse(cp.verifiedAt);
  if (!Number.isFinite(verifiedAt)) return 'bad verifiedAt';
  if (verifiedAt < sinceMs) return null;
  const received = Number(cp.receivedAmount);
  if (!(Number.isFinite(received) && received > 0)) return 'bad receivedAmount';
  for (const k of ['createdAt', 'updatedAt']) {
    if (typeof rec[k] !== 'string' || !Number.isFinite(Date.parse(rec[k]))) return 'bad ' + k;
  }
  if (!isObj(rec.customer) || typeof rec.customer.email !== 'string') return 'bad customer';
  if ((typeof rec.amount !== 'string' && typeof rec.amount !== 'number') || !Number.isFinite(Number(rec.amount))) return 'bad amount';
  if (!Array.isArray(rec.items) || !rec.items.length) return 'bad items';
  for (const it of rec.items) {
    if (!isObj(it) || typeof it.sku !== 'string' || !it.sku || typeof it.name !== 'string') return 'bad item';
    if (!Number.isInteger(Number(it.qty)) || Number(it.qty) < 1) return 'bad item qty';
    if (!Number.isFinite(Number(it.amount))) return 'bad item amount';
  }
  if (cp.token !== 'USDT' && cp.token !== 'USDC') return 'bad token';
  if (cp.network !== 'trc20' && cp.network !== 'erc20') return 'bad network';
  return '';
}
// The names the storefront gives the method (checkout.html): crypto-usdt-trc, crypto-usdt-erc, crypto-usdc-erc.
function cryptoMethodOf(cp) { return 'crypto-' + cp.token.toLowerCase() + '-' + (cp.network === 'trc20' ? 'trc' : 'erc'); }

// The booking of the transfer in the CRM payment list. Same id for the whole life of the order: its presence is what
// makes a tick a no-op, and what order-letters.cjs asks for before the paid letter may go out.
function cryptoPaymentOf(rec) {
  const cp = rec.cryptoPayment;
  const transfer = (Array.isArray(cp.transfers) ? cp.transfers : []).find(t => isObj(t) && t.success !== false && typeof t.txHash === 'string' && t.txHash) || {};
  const tx = (isObj(rec.crypto) && typeof rec.crypto.txHash === 'string' && rec.crypto.txHash) || transfer.txHash || '';
  const note = [cp.token, cp.network, tx ? 'tx ' + tx.slice(0, 10) + '…' : '', typeof cp.verifiedVia === 'string' ? cp.verifiedVia : '']
    .filter(Boolean).join(' ').slice(0, 120);
  return { id: 'crypto:' + rec.orderRef, at: cp.verifiedAt, kind: 'payment', method: 'crypto', amount: Number(money(cp.receivedAmount)), note, by: CRYPTO_NOTE_BY };
}

// Is the CRM order the one the module verified? The module's record is what the buyer paid for; the CRM order is what
// the first caller of notify-order said it was. Returns the list of what differs (empty = the same order).
function cryptoMismatches(rec, cur, ctx) {
  const why = [];
  if (normEmail(rec.customer.email) !== normEmail(isObj(cur.customer) ? cur.customer.email : '')) why.push('email');
  // Lines are compared by sku, not through the catalog: the module's sku is what the page built (slug + '-' + mg without spaces,
  // checkout.html cryptoItemsPayload), and the CRM order holds the same slug and mg. A product taken out of the catalog since
  // (the free research-solvent gift) must not turn every order into a mismatch.
  const skuOf = (slug, mg) => (String(slug || '') + (String(mg || '').trim() ? '-' + mg : '')).replace(/\s+/g, '').toLowerCase();
  const want = new Map();
  for (const it of rec.items) {
    const key = it.sku.replace(/\s+/g, '').toLowerCase() + '|' + Number(it.qty);
    want.set(key, (want.get(key) || 0) + 1);
  }
  const have = new Map();
  let unresolved = false;
  for (const it of Array.isArray(cur.items) ? cur.items : []) {
    if (!isObj(it)) { unresolved = true; break; }
    const key = skuOf(it.slug, it.mg) + '|' + Number(it.qty);
    have.set(key, (have.get(key) || 0) + 1);
  }
  const same = !unresolved && want.size === have.size && Array.from(want).every(([k, n]) => have.get(k) === n);
  if (!same) why.push('items');
  const due = Number(ctx.moneyDue(cur));
  if (!(Number.isFinite(due) && due > 0 && cents(rec.cryptoPayment.receivedAmount) >= cents(due))) why.push('amount');
  return why;
}
function cryptoDueText(cur, ctx) {
  const due = Number(ctx.moneyDue(cur));
  return Number.isFinite(due) ? money(due) : 'n/a';
}

// A test is anything that moved no real money for a real customer: the module's own flags and probes, plus the same
// address rules as a card record.
function isCryptoTest(rec, isExcludedAddress) {
  if (rec.test === true || rec.dryRun === true) return true;
  if (String(rec.descriptor || '').toUpperCase().includes('STUB')) return true;
  return isTestRecord(rec, 'crypto', isExcludedAddress);
}

// The order the page never sent, built from the module's record. A crypto line's `amount` is the line total (the page
// sends unit price x qty), so the unit price is amount / qty. null = the catalog could not be read, retry next tick.
function buildCryptoOrder(rec, ctx) {
  const c = rec.customer, cp = rec.cryptoPayment, pc = isObj(rec.priceCheck) ? rec.priceCheck : {};
  const items = rec.items.map(i => {
    const s = splitSku(i.sku, ctx.slugs);
    const qty = Number(i.qty);
    return { name: i.name, slug: s ? s.slug : '', mg: s ? s.mg : '', qty, price: Math.round(Number(i.amount) / qty * 100) / 100 };
  });
  const subtotal = rec.items.reduce((a, i) => a + Number(i.amount), 0);
  const total = Number(rec.amount);
  const shipCost = pc.shipping !== undefined && pc.shipping !== null && pc.shipping !== '' && Number.isFinite(Number(pc.shipping))
    ? Math.max(0, Number(pc.shipping)) : Math.max(0, Number(money(total - subtotal)));
  const od = {
    ref: rec.orderRef,
    customer: { firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone },
    shipping: { address1: c.address, city: c.city, state: c.state, zip: c.zip, country: c.country, method: pc.shipMethod, cost: shipCost },
    items,
    subtotal: Number(money(subtotal)),
    shippingCost: shipCost,
    total,
    notes: 'Created by payment import: the shop page did not send this order' + (rec.notes ? ' | ' + rec.notes : ''),
    coupon: typeof pc.coupon === 'string' ? pc.coupon : '',
    timestamp: rec.createdAt
  };
  if (rec.attribution !== undefined) od.attribution = rec.attribution;   // same as buildOrder
  const order = ctx.sanitizeOrder(od, cryptoMethodOf(cp));
  const check = ctx.priceCheck(order);
  if (!check || check.price_check === 'skipped') return null;
  for (const k of ['subtotal_server', 'total_server', 'price_mismatch', 'unknown_items']) {
    if (check[k] !== undefined) order[k] = check[k];
  }
  Object.assign(order, ctx.discountFields(order, check));
  order.channel = 'shop';
  order.status = 'paid';
  order.payments = [cryptoPaymentOf(rec)];
  order.source = 'crypto';
  order.source_ref = rec.orderRef;
  order.source_created_at = rec.createdAt;
  order.source_updated_at = rec.updatedAt;
  if (isCryptoTest(rec, ctx.isExcludedAddress)) order.test = true;
  return order;
}

// One pass over the module's crypto records against the CRM orders. Pure: returns the new list and what happened, the
// caller decides whether to write (dry writes nothing) and what to say. Events with wrote:true changed the list.
//   mark-paid     new/pending order matched the record -> paid + payment                       (statusChanged)
//   payment-paid  order already paid/processing (a manager was first) -> payment               (the letter may follow)
//   payment-only  order already shipped/in-transit/delivered -> payment, no letter
//   create        the page never sent the order -> created paid
//   refund        the module recorded a refund of a booked payment -> refund in the payment list
//   mismatch, paid-but-cancelled, cancelled-after-paid, bad-record, deleted: nothing written, only reported
function reconcileCrypto(orders, records, ctx) {
  const next = orders.slice();
  const events = [];
  const created = [];
  const claimed = new Set(); // guards a corrupt read where two records share one orderRef
  const byRef = new Map();
  next.forEach((o, i) => {
    if (!isObj(o) || typeof o.ref !== 'string') return;
    if (byRef.has(o.ref)) byRef.get(o.ref).push(i); else byRef.set(o.ref, [i]);
  });
  let changed = false;
  for (const rec of records) {
    if (!isObj(rec) || rec.paymentMethod !== 'crypto' || typeof rec.orderRef !== 'string' || !CRYPTO_REF_RE.test(rec.orderRef)) continue;
    const ref = rec.orderRef;
    const cp = rec.cryptoPayment;
    if (!isObj(cp) || claimed.has(ref)) continue;
    claimed.add(ref);
    const idx = byRef.get(ref) || [];
    let cur = idx.length === 1 ? next[idx[0]] : null;
    // The import already booked this transfer: what can still happen is the module cancelling or refunding it.
    if (cur && hasPayment(cur, 'crypto:' + ref)) {
      const test = cur.test === true;
      if (cp.status === 'cancelled') events.push({ type: 'cancelled-after-paid', ref, test });
      for (const r of Array.isArray(cp.refunds) ? cp.refunds : []) {
        if (!isObj(r) || typeof r.txHash !== 'string' || !r.txHash || !(Number(r.amount) > 0)) continue;
        const id = 'crypto-refund:' + r.txHash;
        if (hasPayment(cur, id)) continue;
        const at = typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : rec.updatedAt;
        const pay = { id, at, kind: 'refund', method: 'crypto', amount: Number(money(r.amount)), note: ('refund tx ' + r.txHash.slice(0, 10) + '…').slice(0, 120), by: CRYPTO_NOTE_BY };
        cur = Object.assign({}, cur, { payments: paymentsOf(cur).concat([pay]) });
        next[idx[0]] = cur;
        changed = true;
        events.push({ type: 'refund', ref, amount: pay.amount, order: cur, test, wrote: true });
      }
      continue;
    }
    const bad = cryptoCandidate(rec, ctx.sinceMs);
    if (bad === null) continue;
    if (bad) { events.push({ type: 'bad-record', ref, problem: bad }); continue; }
    const received = money(cp.receivedAmount);
    // A probe is a probe from either side: the module's flags and address rules, or the CRM order the page marked as a test.
    const test = isCryptoTest(rec, ctx.isExcludedAddress) || (cur !== null && cur.test === true);
    if (idx.length > 1) { events.push({ type: 'mismatch', ref, reason: 'duplicate', received, due: 'n/a', test }); continue; }
    if (!cur) {
      if (ctx.seen.has(ref)) { events.push({ type: 'deleted', ref }); continue; }
      const order = buildCryptoOrder(rec, ctx);
      if (!order) return { error: 'catalog' };
      created.push(order);
      ctx.seen.add(ref);
      changed = true;
      events.push({ type: 'create', ref, order, received, test: order.test === true, wrote: true });
      continue;
    }
    const status = String(cur.status === undefined || cur.status === null ? '' : cur.status).trim().toLowerCase();
    if (status === 'cancelled') { events.push({ type: 'paid-but-cancelled', ref, received, test }); continue; }
    const why = cryptoMismatches(rec, cur, ctx);
    if (why.length) {
      const due = cryptoDueText(cur, ctx);
      for (const reason of why) events.push({ type: 'mismatch', ref, reason, received, due, test });
      continue;
    }
    const pay = cryptoPaymentOf(rec);
    if (CRYPTO_OPEN_STATUS.has(status)) {
      next[idx[0]] = Object.assign({}, cur, { status: 'paid', updated_at: ctx.now().toISOString(), payments: paymentsOf(cur).concat([pay]) });
      ctx.seen.add(ref);   // booked: an order deleted in the CRM afterwards is not made again (see create above)
      events.push({ type: 'mark-paid', ref, order: next[idx[0]], test, wrote: true, statusChanged: true });
    } else if (CRYPTO_PAID_STATUS.has(status) || CRYPTO_SHIPPED_STATUS.has(status)) {
      next[idx[0]] = Object.assign({}, cur, { payments: paymentsOf(cur).concat([pay]) });
      ctx.seen.add(ref);
      events.push({ type: CRYPTO_PAID_STATUS.has(status) ? 'payment-paid' : 'payment-only', ref, order: next[idx[0]], test, wrote: true });
    } else {
      // a status the CRM does not know: left alone, and said once
      events.push({ type: 'mismatch', ref, reason: 'status', received, due: cryptoDueText(cur, ctx), test });
      continue;
    }
    changed = true;
  }
  return { next: created.slice().reverse().concat(next), events, created, changed };
}

const MODES = new Set(['off', 'dry', 'on']);

function describe(o) {
  return o.ref + ' ' + o.source + (o.test ? ' test' : ' live') + (o.charge_check ? ' check=' + o.charge_check.result : '');
}

function createCardImport(deps) {
  const log = deps.log || ((s) => console.log(s));
  const logError = deps.logError || ((s) => console.error(s));
  const now = deps.now || (() => new Date());
  let mode = String(deps.mode === undefined ? 'off' : deps.mode).trim().toLowerCase();
  if (!MODES.has(mode)) {
    logError('[card-import] ERROR unknown CARD_IMPORT_MODE ' + JSON.stringify(deps.mode) + ', import is off');
    mode = 'off';
  }
  const since = Date.parse(String(deps.eventsSince || ''));
  if (mode === 'on' && !Number.isFinite(since)) {
    logError('[card-import] ERROR CARD_IMPORT_EVENTS_SINCE is not a date, no Customer.io events will be sent');
  }
  // The crypto part has a mode of its own. No value at all is off without a word; a wrong value, a missing date or a
  // missing dependency never turns it on.
  let cryptoMode = String(deps.cryptoMode === undefined || deps.cryptoMode === null ? 'off' : deps.cryptoMode).trim().toLowerCase() || 'off';
  if (!MODES.has(cryptoMode)) {
    logError('[card-import] ERROR unknown CRYPTO_IMPORT_MODE ' + JSON.stringify(String(deps.cryptoMode).slice(0, 20)) + ', crypto import is off');
    cryptoMode = 'off';
  }
  const cryptoSince = Date.parse(String(deps.cryptoSince || ''));
  if (cryptoMode !== 'off' && !Number.isFinite(cryptoSince)) {
    logError('[card-import] ERROR CRYPTO_IMPORT_SINCE is not a date, crypto import is off');
    cryptoMode = 'off';
  }
  if (cryptoMode !== 'off' && typeof deps.moneyDue !== 'function') {
    logError('[card-import] ERROR crypto import needs moneyDue, crypto import is off');
    cryptoMode = 'off';
  }
  let lastProblem = '';
  let sourceFailStreak = 0; // source.json is written with a plain writeFileSync (not atomic): debounce one-tick blips
  let memSeen = new Set(); // refs this import has created, kept in-process even when the caller has no seen-log file
  const seenBad = new Set(), seenDry = new Set(), seenTaken = new Set(), seenNoApproval = new Set();
  const seenCrypto = new Set(); // crypto lines already said once (a mismatch stays true every tick until someone fixes it)
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

  // Crypto lines never carry an address, a name or a wallet: the ref, the reason and the amounts are all that is said.
  // A test order is only logged (log() does not reach Telegram), a live one goes through logError. Not-written events are
  // said here (once per ref and reason); the written ones after the write, from cryptoAfterWrite.
  function cryptoSay(ev, text) {
    if (ev.test) log('[card-import] crypto (test) ' + text); else logError('[card-import] CRYPTO ' + text);
  }
  function cryptoOnce(key, fn) {
    if (seenCrypto.has(key)) return;
    seenCrypto.add(key);
    fn();
  }
  function cryptoReportUnwritten(cx) {
    for (const ev of cx.events) {
      if (ev.wrote) continue;
      if (ev.type === 'bad-record') {
        cryptoOnce('bad:' + ev.ref + ':' + ev.problem, () => logError('[card-import] ERROR skipped crypto record ' + ev.ref + ': ' + ev.problem));
      } else if (ev.type === 'deleted') {
        cryptoOnce('deleted:' + ev.ref, () => log('[card-import] crypto ' + ev.ref + ' was removed in CRM, not recreated'));
      } else if (ev.type === 'mismatch') {
        cryptoOnce('mismatch:' + ev.ref + ':' + ev.reason, () => cryptoSay(ev, 'MISMATCH ' + ev.ref + ' ' + ev.reason + ' received=' + ev.received + ' due=' + ev.due));
      } else if (ev.type === 'paid-but-cancelled') {
        cryptoOnce('pbc:' + ev.ref, () => cryptoSay(ev, 'PAID-BUT-CANCELLED ' + ev.ref + ' received=' + ev.received));
      } else if (ev.type === 'cancelled-after-paid') {
        cryptoOnce('cap:' + ev.ref, () => cryptoSay(ev, 'CANCELLED-AFTER-PAID ' + ev.ref));
      }
    }
  }
  // Dry: what a real tick would do, one log line per ref and action for the life of the process. Log only, never an error.
  function cryptoReportDry(cx) {
    for (const ev of cx.events) {
      let action;
      if (ev.type === 'mark-paid') action = 'mark-paid';
      else if (ev.type === 'payment-paid' || ev.type === 'payment-only') action = 'payment-only';
      else if (ev.type === 'create') action = 'create';
      else if (ev.type === 'mismatch') action = 'mismatch ' + ev.reason;
      else if (ev.type === 'refund') action = 'refund';
      else if (ev.type === 'cancelled-after-paid') action = 'cancelled-after-paid';
      else if (ev.type === 'paid-but-cancelled') action = 'paid-but-cancelled';
      else if (ev.type === 'bad-record') { cryptoOnce('bad:' + ev.ref + ':' + ev.problem, () => logError('[card-import] ERROR skipped crypto record ' + ev.ref + ': ' + ev.problem)); continue; }
      else continue;
      if (seenDry.has('crypto:' + action + ':' + ev.ref)) continue;
      seenDry.add('crypto:' + action + ':' + ev.ref);
      log('[card-import] DRY crypto would ' + action + ' ' + ev.ref);
    }
  }
  // After a successful write. A callback that throws is reported and does not stop the others: the order is saved, the
  // paid letter and the status event are the queue's job, and a failure here must not turn into a retry of the write.
  function cryptoAfterWrite(cx) {
    const safe = (name, ev, fn) => {
      if (typeof fn !== 'function' || ev.test || ev.order.test === true) return;
      try { fn(); } catch (e) { logError('[card-import] ERROR crypto ' + name + ' ' + ev.ref + ': ' + ((e && e.message) || e)); }
    };
    for (const ev of cx.events) {
      if (!ev.wrote) continue;
      if (ev.type === 'create') {
        log('[card-import] crypto created ' + describe(ev.order));
        cryptoSay(ev, 'CREATED ' + ev.ref + ' amount=' + ev.received);
        safe('onCryptoCreated', ev, () => deps.onCryptoCreated(ev.order, cx.next));
      } else if (ev.type === 'mark-paid') {
        log('[card-import] crypto paid ' + ev.ref);
        safe('onCryptoPaid', ev, () => deps.onCryptoPaid(ev.order, cx.next, { statusChanged: true }));
      } else if (ev.type === 'payment-paid') {
        log('[card-import] crypto payment booked on an already paid order ' + ev.ref);
        safe('onCryptoPaid', ev, () => deps.onCryptoPaid(ev.order, cx.next, { statusChanged: false }));
      } else if (ev.type === 'payment-only') {
        log('[card-import] crypto payment booked on a shipped order ' + ev.ref);
      } else if (ev.type === 'refund') {
        cryptoSay(ev, 'REFUND ' + ev.ref + ' amount=' + money(ev.amount));
      }
    }
  }

  function tick() {
    const cryptoOn = cryptoMode !== 'off';
    if (mode === 'off' && !cryptoOn) return { skipped: 'off' };
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
    // Card off (the crypto part alone is running): no card or quote record is looked at, as if the source had none.
    const candidates = mode === 'off' ? [] : parsed.orders
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
    const seenBefore = new Set(seenSet); // mergeInto adds to seenSet; a dry card pass must not leave its refs in the crypto part's copy
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
      if (!m.created.length && !m.updated.length) {
        problem('');
      } else {
        problem('');
        for (const o of m.created.concat(m.updated)) {
          const key = o.ref + '@' + o.source_updated_at;
          if (seenDry.has(key)) continue;
          seenDry.add(key);
          log('[card-import] DRY would ' + (m.created.includes(o) ? 'create ' : 'update ') + describe(o));
        }
      }
      if (!cryptoOn) {
        return m.created.length || m.updated.length ? { created: m.created.length, updated: m.updated.length, dry: true } : { created: 0, updated: 0 };
      }
    }
    // F5: a refund/chargeback webhook moves a card record's status away from "approved" (applyRefunds above), so
    // these never appear in `built`/`m` — applied on top of mergeInto's result, before deciding if there is
    // anything to write this tick.
    const refundRecs = mode === 'on' ? parsed.orders.filter(r => isObj(r) && REFUND_STATUS_RE.test(String((r && r.status) || ''))) : [];
    const rf = mode === 'on' ? applyRefunds(m.next, refundRecs) : { next: m.next, refunded: [], mismatched: [] };
    // R1: logged once for the life of the process, not once per tick or per ref — a restarted sidecar seq reusing a
    // ref is a one-time anomaly to investigate, not a recurring alert to repeat every tick it stays unresolved.
    if (rf.mismatched.length && !refundMismatchLogged) {
      refundMismatchLogged = true;
      logError('[card-import] ERROR refund for a different record, not applied: ' + rf.mismatched[0]);
    }
    // The crypto part works on what the card part is about to write (card on), or on the file as it is (card off or dry).
    let cx = null;
    let finalSeen = m.seen;
    if (cryptoOn) {
      finalSeen = mode === 'on' ? m.seen : seenBefore;
      const cryptoRecs = parsed.orders.filter(r => isObj(r) && r.paymentMethod === 'crypto');
      cx = reconcileCrypto(mode === 'on' ? rf.next : orders, cryptoRecs, Object.assign({}, ctx, {
        sinceMs: cryptoSince, moneyDue: deps.moneyDue, now,
        // dry adds "would create" refs to the set it is given: a copy, or the journal would remember an order that was never made
        seen: cryptoMode === 'on' ? finalSeen : new Set(finalSeen) }));
      if (cx.error) { problem('catalog unavailable'); return { error: 'catalog' }; }
      if (cryptoMode === 'dry') cryptoReportDry(cx); else cryptoReportUnwritten(cx);
    }
    const cryptoWrites = !!cx && cryptoMode === 'on' && cx.changed;
    const cardWrites = mode === 'on' && (m.created.length || m.updated.length || rf.refunded.length);
    if (!cardWrites && !cryptoWrites) {
      problem('');
      return mode === 'dry' ? { created: m.created.length, updated: m.updated.length, dry: true } : { created: 0, updated: 0 };
    }
    try { deps.writeOrders(cryptoWrites ? cx.next : rf.next); } catch (e) { problem('orders.json write failed: ' + e.message); return { error: 'write' }; }
    memSeen = finalSeen; // survives future ticks in this process even if the caller never wires a seen-log file
    if (deps.writeSeen) {
      try { deps.writeSeen(Array.from(finalSeen)); } catch (e) { logError('[card-import] ERROR seen log write failed: ' + ((e && e.message) || e)); }
    }
    problem('');
    if (mode === 'on') {
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
          try { deps.track(o, cryptoWrites ? cx.next : rf.next); log('[card-import] event order_placed ' + o.ref); }
          catch (e) { logError('[card-import] ERROR event order_placed ' + o.ref + ': ' + ((e && e.message) || e)); }
        }
      }
      for (const o of m.updated) { log('[card-import] updated ' + describe(o)); alertIfMismatch(o); }
      for (const r of rf.refunded) {
        // Test refunds update CRM silently (a repeat tick must still see the guard payment already there); a real
        // one is the owner's money moving and must reach Telegram through ops-watch (logError), never just log().
        if (!r.test) logError('[card-import] REFUND ' + r.ref + ' ' + r.status + ' amount=' + money(r.amount));
      }
    }
    if (cryptoWrites) cryptoAfterWrite(cx);
    const res = { created: mode === 'on' ? m.created.length : 0, updated: mode === 'on' ? m.updated.length : 0 };
    if (cx) res.crypto = { created: cx.created.length, changed: cx.events.filter(e => e.wrote).length };
    return res;
  }

  // A throw inside setInterval would be an uncaughtException and a pm2 restart of the whole shop API. Routed
  // through problem() so a dependency that keeps throwing (e.g. the catalog API is down) logs once, not every tick.
  function run() {
    try { tick(); } catch (e) { problem('tick failed: ' + ((e && e.message) || e)); }
  }
  function start() {
    if (mode === 'off' && cryptoMode === 'off') { log('[card-import] off'); return; }
    const every = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : 60000;
    firstTimer = setTimeout(run, Math.min(5000, every));
    timer = setInterval(run, every);
    if (firstTimer.unref) firstTimer.unref();
    if (timer.unref) timer.unref();
    log('[card-import] ' + mode + (cryptoMode !== 'off' ? ', crypto ' + cryptoMode : '') + ', every ' + every + ' ms');
  }
  function stop() { clearTimeout(firstTimer); clearInterval(timer); }
  return { tick, start, stop, mode: () => mode, cryptoMode: () => cryptoMode };
}

module.exports = {
  RESERVED_REF_RE, CRYPTO_REF_RE, parseSource, recordProblem, slugList, splitSku, couponFromNotes, approvalOf, isTestRecord,
  buildOrder, mergeInto, applyRefunds, isCryptoVerified, cryptoCandidate, cryptoMismatches, buildCryptoOrder, reconcileCrypto,
  createCardImport
};
