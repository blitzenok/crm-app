// infra 2026-09-29 honest-charge: coupon-quote amount, unknown charge outcome (find-by-ext-id) and the repeat-order guard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { priceCardCart, priceCryptoCart, couponFromInput } from "../lib/pricing.js";
import { buildNotifyPayload } from "../lib/store-forward.js";
import { orderTotals } from "../lib/email-templates.js";
import { chargeCart, ADAPTERS } from "../lib/cascade.js";
import { pollPending, UNKNOWN_GRACE_MS } from "../lib/poller.js";
import { classifyForRetry } from "../lib/retry-class.js";
import * as umg from "../lib/processors/umg.js";
import { startCrmServer } from "../index.js";
import { couponQuoteFake } from "./helpers/coupon-quote-fake.js";

const CUSTOMER = { first_name: "Ada", last_name: "Nguyen", email: "ada@lab.example", phone: "4155550100", address: "1 Research Way", city: "SF", state: "CA", zip: "94107", country: "USA" };
const CARD = { name: "Ada", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
const KPV1 = [{ sku: "kpv-10mg", name: "KPV", qty: 1, amount: "79.00" }];

// ---- A1: amount = coupon-quote total_due, with the coupon -------------------------------------------------------------
test("coupon: body.coupon wins, else 'coupon:CODE' in notes; junk is ignored", () => {
  assert.equal(couponFromInput({ coupon: " insider25 " }), "INSIDER25");
  assert.equal(couponFromInput({ notes: "gift wrap; coupon:insider25" }), "INSIDER25");
  assert.equal(couponFromInput({ notes: "coupon:INSIDER25 please" }), "INSIDER25");
  assert.equal(couponFromInput({ coupon: "A", notes: "coupon:B" }), "A");
  assert.equal(couponFromInput({ coupon: "x".repeat(41), notes: "coupon:B" }), "B");
  assert.equal(couponFromInput({ coupon: "bad code!", notes: "" }), "");
  assert.equal(couponFromInput({ notes: "nocoupon:X and xcoupon:Y" }), "");
  assert.equal(couponFromInput({}), "");
});

test("coupon from body.coupon: 25% off the catalog subtotal, shipping untouched, one whole-cart quote", async () => {
  const f = couponQuoteFake();
  const items = [{ sku: "kpv-10mg", qty: 1, amount: "79.00" }, { sku: "bpc-157-10mg", qty: 1, amount: "88.00" }, { sku: "research-solvent-10ml", qty: 1, amount: "0.00" }]; // 167
  const r = await priceCardCart({ amount: "150.24", shipMethod: "express", coupon: "insider25", items }, { fetchImpl: f });
  assert.equal(r.ok, true);
  assert.equal(r.subtotal, "167.00");
  assert.equal(r.amount, "144.24"); // 167 - 41.75 + 18.99
  assert.equal(r.shipping, "18.99");
  assert.equal(r.coupon, "INSIDER25");
  assert.deepEqual(r.discount, { pct: 25, source: "coupon:INSIDER25", amount: "41.75" });
  assert.equal(r.volumeDiscount, null);
  assert.equal(r.mismatch, true); // the browser said 150.24
  const total = f.calls.at(-1);
  assert.equal(total.items.length, 2, "the free solvent is not sent");
  assert.equal(total.coupon, "INSIDER25");
  assert.equal(total.shippingCost, "18.99");
  assert.equal(f.calls.filter((c) => c.items.length > 1).length, 1, "exactly one whole-cart request");
  const honest = await priceCardCart({ amount: "144.24", shipMethod: "express", coupon: "INSIDER25", items }, { fetchImpl: couponQuoteFake() });
  assert.equal(honest.mismatch, false);
});

test("coupon from notes (what the page sends today)", async () => {
  const r = await priceCardCart({ amount: "59.25", notes: "Order note; coupon:INSIDER25", items: KPV1 }, { fetchImpl: couponQuoteFake() });
  assert.equal(r.amount, "59.25");
  assert.equal(r.coupon, "INSIDER25");
  assert.equal(r.discount.source, "coupon:INSIDER25");
  assert.equal(r.mismatch, false);
});

test("coupon and ladder do not stack: larger percent wins, a tie goes to the coupon", async () => {
  const cart = [{ sku: "kpv-10mg", qty: 2, amount: "71.00" }, { sku: "bpc-157-10mg", qty: 1, amount: "88.00" }, { sku: "aod-9604-5mg", qty: 1, amount: "42.00" }]; // 272 -> ladder 10%
  const big = await priceCardCart({ amount: "272", coupon: "INSIDER25", items: cart }, { fetchImpl: couponQuoteFake() });
  assert.equal(big.amount, "204.00");
  assert.equal(big.discount.source, "coupon:INSIDER25");
  assert.equal(big.volumeDiscount, null);
  const small = await priceCardCart({ amount: "272", coupon: "TINY5", items: cart }, { fetchImpl: couponQuoteFake({ coupons: { TINY5: 5 } }) });
  assert.equal(small.amount, "244.80");
  assert.equal(small.discount.source, "tier:250");
  assert.deepEqual(small.volumeDiscount, { pct: 10, merch: "272.00", discount: "27.20", merchAfter: "244.80" });
  assert.equal(small.coupon, "TINY5", "the requested code is kept even when the ladder won");
  const tie = await priceCardCart({ amount: "272", coupon: "TEN10", items: cart }, { fetchImpl: couponQuoteFake({ coupons: { TEN10: 10 } }) });
  assert.equal(tie.discount.source, "coupon:TEN10");
  assert.equal(tie.volumeDiscount, null);
  assert.equal(tie.amount, "244.80");
});

test("free gift is $0 and never quoted; a gift-only cart is not chargeable", async () => {
  const f = couponQuoteFake();
  const r = await priceCardCart({ amount: "79", items: [...KPV1, { sku: "research-solvent-10ml", qty: 1, amount: "0.00" }] }, { fetchImpl: f });
  assert.equal(r.amount, "79.00");
  assert.equal(r.lines.find((l) => l.slug === "research-solvent").rule, "free_gift");
  assert.ok(f.calls.every((c) => c.items.every((i) => i.slug !== "research-solvent")));
  const gift = await priceCardCart({ amount: "0", items: [{ sku: "research-solvent-10ml", qty: 1, amount: "0" }] }, { fetchImpl: couponQuoteFake() });
  assert.equal(gift.status, 503);
});

test("whole-cart quote that disagrees with the line prices, with itself, or is not ok -> 503, never a charge", async () => {
  // one line -> call 1 is the per-line quote, call 2 the whole-cart quote: only the whole-cart reply is tampered with
  const bad = async (mutate) => priceCardCart({ amount: "79", items: KPV1 }, { fetchImpl: couponQuoteFake({ mutate: (q, b, n) => (n === 2 ? mutate(q) : q) }) });
  for (const [label, mutate] of [
    ["subtotal differs from the sum of lines", (q) => ({ ...q, subtotal: "80.00", total_due: "80.00" })],
    ["total_due breaks subtotal + shipping - discount", (q) => ({ ...q, total_due: "1.00" })],
    ["total_due missing", (q) => ({ ...q, total_due: undefined })],
    ["negative discount", (q) => ({ ...q, discount: "-5.00", total_due: "84.00" })],
  ]) {
    const r = await bad(mutate);
    assert.equal(r.ok, false, label);
    assert.equal(r.status, 503, label);
    assert.equal(r.error, "pricing_unavailable", label);
  }
  // the whole-cart call (2nd) answers not ok; per-line quotes are fine
  let n = 0;
  const flaky = couponQuoteFake();
  const r = await priceCardCart({ amount: "79", items: KPV1 }, { fetchImpl: async (u, i) => { n += 1; if (n === 2) return { ok: false, status: 503, json: async () => ({ error: "Catalog unavailable" }) }; return flaky(u, i); } });
  assert.equal(r.status, 503);
  const unk = await priceCardCart({ amount: "79", items: KPV1 }, { fetchImpl: couponQuoteFake({ mutate: (q, b, n) => (n === 2 ? { ...q, unknown_items: ["kpv"] } : q) }) });
  assert.equal(unk.error, "unknown_item");
  assert.equal(unk.status, 400);
});

test("crypto route: the coupon works there too and is stored on the order", async () => {
  const store = createStore({ memoryOnly: true });
  const server = await startCrmServer(0, { store, cryptoPricer: (body) => priceCryptoCart(body, { fetchImpl: couponQuoteFake() }) });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/checkout/crypto`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "CR-1", amount: "79.00", network: "trc20", coupon: "INSIDER25", customer: CUSTOMER, items: [{ sku: "kpv-10mg", name: "KPV", qty: 1, amount: "79.00" }] }),
    });
    const body = await res.json();
    assert.equal(body.amount, "59.25");
    const saved = store.getOrderByRef(body.orderRef);
    assert.equal(saved.priceCheck.coupon, "INSIDER25");
    assert.deepEqual(saved.priceCheck.discount, { pct: 25, source: "coupon:INSIDER25", amount: "19.75" });
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test("store-forward carries the coupon and a discount note; the email totals reconcile with the charge", async () => {
  const store = createStore({ memoryOnly: true });
  const pricing = await priceCardCart({ amount: "59.25", coupon: "INSIDER25", items: KPV1 }, { fetchImpl: couponQuoteFake() });
  const charged = await chargeCart({
    idempotencyKey: "SF-1", amount: "59.25", customer: CUSTOMER, items: KPV1, card: CARD, pricing,
  }, { store, adapters: { umg: { createPayment: async () => ({ ok: true, processor: "umg", processorTxnId: "U1", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }) } } });
  assert.equal(charged.order.status, "approved");
  const p = buildNotifyPayload(charged.order);
  assert.equal(p.orderData.coupon, "INSIDER25");
  assert.equal(p.orderData.total, "59.25");
  assert.equal(p.orderData.subtotal, "79.00");
  assert.match(p.orderData.notes, /coupon INSIDER25 25% \(−\$19\.75\) included in total/);
  const t = orderTotals(charged.order, {});
  assert.equal(t.reconciled, true);
  assert.deepEqual(t.discount, { pct: 25, cents: 1975, label: "Coupon INSIDER25 (25%)" });
  // ladder order keeps its own label and note; an order without any discount forwards an empty coupon
  const ladder = await priceCardCart({ amount: "1", items: [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }] }, { fetchImpl: couponQuoteFake() });
  const l = await chargeCart({ idempotencyKey: "SF-2", amount: "1", customer: CUSTOMER, items: [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }], card: CARD, pricing: ladder },
    { store, adapters: { umg: { createPayment: async () => ({ ok: true, processor: "umg", processorTxnId: "U2", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }) } } });
  const lp = buildNotifyPayload(l.order);
  assert.equal(lp.orderData.coupon, "");
  assert.match(lp.orderData.notes, /volume discount 5% \(−\$7\.90\)/);
  assert.equal(orderTotals(l.order, {}).discount.label, "Volume discount (5%)");
});

// ---- A2: unknown outcome of the create call ---------------------------------------------------------------------------
const FIND = "/find-by-ext-id/";
const okRow = (ext, extra = {}) => ({ id: 7001, status: "APPROVED", date: "Sep 29, 2026 10:00:00 AM", descriptor: "PEPTIDESS SHOP", gateway_id: 7, txid: "TX9", ext_order_id: ext, card: { number: "424242****4242" }, ...extra });
const reply = (status, body) => ({ status, async text() { return body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body); } });
/** create -> `create()`; find-by-ext-id -> `find(ext)`; records calls */
function umgFetch({ create, find }) {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, method: init.method || "GET", body: init.body });
    if (url.includes(FIND)) return find(decodeURIComponent(url.split(FIND)[1].split("?")[0]));
    return create();
  };
  fn.calls = calls;
  return fn;
}
const aborted = () => { const e = new Error("aborted"); e.name = "AbortError"; throw e; };
// connection never established: the request cannot have reached UMG (Node fetch reports the code on err.cause)
const refused = () => { const e = new Error("fetch failed"); e.cause = { code: "ECONNREFUSED" }; throw e; };
const reset = () => { const e = new Error("fetch failed"); e.cause = { code: "ECONNRESET" }; throw e; };
const INPUT = { customer: CUSTOMER, card: CARD, amount: "20.00", currency: "USD", extOrderId: "KEY-1" };
const deps = (fetchImpl) => ({ secret: "unit-test-secret", fetchImpl, findDelayMs: 0 });

test("create times out -> find-by-ext-id finds the approved charge -> that is the result", async () => {
  const f = umgFetch({ create: aborted, find: (ext) => reply(200, [okRow(ext)]) });
  const r = await umg.createPayment(INPUT, deps(f));
  assert.equal(r.ok, true);
  assert.equal(r.processorStatus, "APPROVED");
  assert.equal(r.processorTxnId, "7001");
  assert.equal(r.recoveredVia, "find-by-ext-id");
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[1].url, /^https:\/\/pay\.umg\.inc\/rest\/v1\/transactions\/find-by-ext-id\/KEY-1\?Authorization=/);
  assert.equal(f.calls[1].method, "GET");
  assert.equal(f.calls[1].url.includes("4242424242424242"), false, "no card data in the find request");
});

test("create refused before connecting -> find answers 200 [] -> not charged, old soft answer plus noChargeConfirmed", async () => {
  const r = await umg.createPayment(INPUT, deps(umgFetch({ create: refused, find: () => reply(200, []) })));
  assert.equal(r.processorStatus, "PROCESSOR_DOWN");
  assert.equal(r.cascadeAction, "next");
  assert.equal(r.declineClass, "soft");
  assert.equal(r.noChargeConfirmed, true);
});

test("create times out -> find cannot say -> UNKNOWN / wait (404, 5xx, network, not an array, foreign rows, no id)", async () => {
  const cases = {
    "http 500": () => reply(500, "boom"),
    "http 404": () => reply(404, { error: "none" }),
    "network": () => { throw new Error("ECONNRESET"); },
    "not an array": () => reply(200, { rows: [] }),
    "garbage": () => reply(200, "<html>"),
    "foreign rows": () => reply(200, [okRow("OTHER-KEY")]),
    "row without id": (ext) => reply(200, [{ status: "APPROVED", ext_order_id: ext }]),
  };
  for (const [label, find] of Object.entries(cases)) {
    const r = await umg.createPayment(INPUT, deps(umgFetch({ create: aborted, find })));
    assert.equal(r.processorStatus, "UNKNOWN", label);
    assert.equal(r.cascadeAction, "wait", label);
    assert.equal(r.reason, "unknown_outcome", label);
    assert.equal(r.declineClass, "soft", label);
    assert.equal(r.noChargeConfirmed, undefined, label);
  }
});

test("find with several rows: an approved one wins, otherwise the newest id", async () => {
  const rows = (ext) => [{ id: 10, status: "DECLINED", ext_order_id: ext }, okRow(ext, { id: 8 }), { id: 12, status: "DECLINED", ext_order_id: ext }];
  const a = await umg.findByExtId("K", { secret: "s", findDelayMs: 0, fetchImpl: async () => reply(200, rows("K")) });
  assert.equal(a.txn.id, 8);
  const d = await umg.findByExtId("K", { secret: "s", findDelayMs: 0, fetchImpl: async () => reply(200, [{ id: 10, status: "DECLINED", ext_order_id: "K" }, { id: 12, status: "DECLINED", ext_order_id: "K" }]) });
  assert.equal(d.txn.id, 12);
  assert.equal(d.mapped.processorStatus, "DECLINED");
});

test("5xx / 429 / no-status answers to create are also looked up; a 4xx refusal is not", async () => {
  for (const create of [() => reply(503, { error: "down" }), () => reply(429, { error: "slow" }), () => reply(201, { note: "no status" }), () => reply(200, "")]) {
    const f = umgFetch({ create, find: (ext) => reply(200, [okRow(ext)]) });
    const r = await umg.createPayment(INPUT, deps(f));
    assert.equal(r.processorStatus, "APPROVED");
    assert.equal(f.calls.length, 2);
  }
  const f = umgFetch({ create: () => reply(422, { error: "bad zip" }), find: () => reply(200, []) });
  const r = await umg.createPayment(INPUT, deps(f));
  assert.equal(f.calls.length, 1, "definite refusal: no find");
  assert.equal(r.noChargeConfirmed, undefined);
});

function umgOnlyStore() {
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: true, priority: 2, mode: "sandbox" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  return store;
}
const charge = (store, key, f, extra = {}) => {
  const calls = { tagada: 0 };
  const adapters = { ...ADAPTERS, tagada: { async createPayment() { calls.tagada += 1; return { ok: true, processor: "tagada", processorTxnId: "TG", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } } };
  const p = chargeCart({ idempotencyKey: key, amount: "20.00", customer: CUSTOMER, card: CARD, ...extra }, { store, adapters, processorDeps: { umg: deps(f) } });
  return p.then((result) => ({ result, calls }));
};

test("cascade: timeout + find approved -> order approved with the UMG txn id, no second processor", async () => {
  const store = umgOnlyStore();
  const { result, calls } = await charge(store, "C-A", umgFetch({ create: aborted, find: (ext) => reply(200, [okRow(ext)]) }));
  assert.equal(result.ok, true);
  assert.equal(result.order.status, "approved");
  assert.equal(result.order.winningTxnId, "7001");
  assert.equal(calls.tagada, 0);
});

test("cascade: connection refused + find [] behaves as before (soft -> next processor)", async () => {
  const store = umgOnlyStore();
  const { result, calls } = await charge(store, "C-B", umgFetch({ create: refused, find: () => reply(200, []) }));
  assert.equal(calls.tagada, 1);
  assert.equal(result.order.attempts[0].noChargeConfirmed, true);
  assert.equal(result.order.winningProcessor, "tagada");
});

test("cascade: timeout + find fails -> pending UNKNOWN, the next processor is NOT tried, retry class none", async () => {
  const store = umgOnlyStore();
  const { result, calls } = await charge(store, "C-C", umgFetch({ create: aborted, find: () => reply(500, "x") }));
  assert.equal(calls.tagada, 0);
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(result.order.status, "pending");
  assert.equal(result.order.attempts.length, 1);
  assert.equal(result.order.attempts[0].processorStatus, "UNKNOWN");
  assert.equal(result.order.attempts[0].reason, "unknown_outcome");
  assert.deepEqual(classifyForRetry(result.order.attempts[0]), { retryClass: "none", code: null, basis: "unknown_outcome" });
  // the same key again is answered from the stored order, no second charge attempt
  const again = await charge(store, "C-C", umgFetch({ create: () => { throw new Error("must not charge"); }, find: () => reply(200, []) }));
  assert.equal(again.result.reused, true);
});

// ---- A2.3: poller settles UNKNOWN attempts -----------------------------------------------------------------------------
async function unknownOrder(key = "P-1") {
  const store = umgOnlyStore();
  await charge(store, key, umgFetch({ create: aborted, find: () => reply(500, "x") }));
  return store;
}
const pollWith = (store, find, extra = {}) => pollPending(store, {
  adapters: { umg: { ...umg, getTransaction: async () => ({ processorStatus: "PENDING" }), findByExtId: (k, d) => umg.findByExtId(k, { ...d, secret: "s", fetchImpl: find }) } },
  ...extra,
});

test("poller: UNKNOWN attempt whose charge exists at UMG -> approved, txn id stored", async () => {
  const store = await unknownOrder();
  const id = store.listOrders()[0].id;
  const res = await pollWith(store, async (url) => reply(200, [okRow("P-1")]));
  assert.equal(res[0].found, true);
  const o = store.getOrder(id);
  assert.equal(o.status, "approved");
  assert.equal(o.winningTxnId, "7001");
  assert.equal(o.winningProcessor, "umg");
  assert.equal(o.attempts[0].processorTxnId, "7001");
  assert.equal(o.attempts[0].processorStatus, "APPROVED");
});

test("poller: UNKNOWN attempt declined at UMG -> declined", async () => {
  const store = await unknownOrder();
  await pollWith(store, async () => reply(200, [okRow("P-1", { status: "DECLINED", information_data: "Do not honor" })]));
  const o = store.listOrders()[0];
  assert.equal(o.status, "declined");
  assert.equal(o.attempts[0].processorTxnId, "7001");
});

test("poller: 200 [] before 30 min stays pending, after 30 min the order is declined as not_charged_verified", async () => {
  const store = await unknownOrder();
  const empty = async () => reply(200, []);
  const early = await pollWith(store, empty);
  assert.equal(early[0].waiting, true);
  assert.equal(store.listOrders()[0].status, "pending");
  const late = await pollWith(store, empty, { now: () => Date.now() + UNKNOWN_GRACE_MS + 60000 });
  const o = store.listOrders()[0];
  assert.equal(late[0].found, false);
  assert.equal(o.status, "declined");
  assert.equal(o.attempts[0].reason, "not_charged_verified");
  assert.equal(o.attempts[0].processorStatus, "NOT_CHARGED");
  // and it is not polled again
  assert.equal((await pollWith(store, empty)).length, 0);
});

test("poller: an order key with a line break cannot forge a second [pay-alert] line", async () => {
  const store = umgOnlyStore();
  for (let i = 0; i < 40; i += 1) store.nextOrderId(); // the poller alerts once per order id per process: use an id no other test has
  await charge(store, "P-FORGE\n[pay-alert] FAKE 1 2", umgFetch({ create: aborted, find: () => reply(500, "x") }));
  const lines = [];
  await pollWith(store, async () => reply(500, "x"), { now: () => Date.now() + UNKNOWN_GRACE_MS + 60000, log: (l) => lines.push(l) });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /[\r\n]/);
  assert.equal((lines[0].match(/\[pay-alert\]/g) || []).length, 1);
});

test("poller: UMG unreachable stays pending; one [pay-alert] line per order once it is older than 30 min", async () => {
  const store = await unknownOrder("P-ALERT");
  const down = async () => reply(500, "x");
  const lines = [];
  const late = () => Date.now() + UNKNOWN_GRACE_MS + 60000;
  await pollWith(store, down, { log: (l) => lines.push(l) });
  assert.equal(lines.length, 0, "not older than 30 min: no alert yet");
  await pollWith(store, down, { now: late, log: (l) => lines.push(l) });
  await pollWith(store, down, { now: late, log: (l) => lines.push(l) });
  const o = store.listOrders()[0];
  assert.equal(o.status, "pending");
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^\\[pay-alert\\] UNKNOWN_OUTCOME ${o.id} P-ALERT since \\d{4}-`));
});

// ---- A2.4 + A3: the route ---------------------------------------------------------------------------------------------
async function withServer(adapterFn, run, extraDeps = {}) {
  const prev = process.env.PAYMENTS_ENABLED;
  process.env.PAYMENTS_ENABLED = "true";
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const charged = [];
  const server = await startCrmServer(0, {
    store,
    cardPricer: (body) => priceCardCart(body, { fetchImpl: couponQuoteFake() }),
    adapters: { umg: { async createPayment(p) { charged.push(p.extOrderId); return adapterFn(p, charged.length); } }, tagada: {}, centrobill: {} },
    ...extraDeps,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (b) => fetch(`${base}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer: CUSTOMER, card: CARD, shipMethod: "ground", ...b }) });
  try {
    await run({ store, post, charged });
  } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = prev;
  }
}
const approved = (p, n) => ({ ok: true, processor: "umg", processorTxnId: `U-${n}`, processorStatus: "APPROVED", cascadeAction: "success", raw: {} });
const CART = [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }, { sku: "kpv-10mg", qty: 1, amount: "79.00" }]; // 158 + 79 = 237 -> 5%

test("route: unknown outcome answers pending + charged:'unknown' (no new attempt offered)", async () => {
  const unknown = () => ({ ok: false, processor: "umg", processorTxnId: null, processorStatus: "UNKNOWN", cascadeAction: "wait", declineClass: "soft", reason: "unknown_outcome", raw: {} });
  await withServer(unknown, async ({ post, store }) => {
    const res = await post({ idempotencyKey: "R-U1", amount: "225.15", items: CART });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.pending, true);
    assert.equal(body.charged, "unknown");
    assert.match(body.message, /do not pay again/i);
    assert.equal(store.getOrderByIdempotency("R-U1").status, "pending");
    const replay = await (await post({ idempotencyKey: "R-U1", amount: "225.15", items: CART })).json();
    assert.equal(replay.reused, true);
    assert.equal(replay.charged, "unknown", "a replay of the same key keeps saying so");
  });
});

test("route: same buyer + same amount + same lines under a NEW key within 15 min -> 409, not charged", async () => {
  await withServer(approved, async ({ post, charged, store }) => {
    const first = await (await post({ idempotencyKey: "D-1", amount: "225.15", items: CART })).json();
    assert.equal(first.chargedAmount, "225.15");
    assert.deepEqual(charged, ["D-1"]);
    const res = await post({ idempotencyKey: "D-2", amount: "225.15", items: [...CART].reverse(), customer: { ...CUSTOMER, email: "ADA@Lab.Example" } });
    const body = await res.json();
    assert.equal(res.status, 409);
    assert.equal(body.ok, false);
    assert.equal(body.error, "duplicate_recent_order");
    assert.equal(body.charged, false);
    assert.equal(body.existingOrder, first.order.id);
    assert.match(body.message, new RegExp(`order ${first.order.id}\\). You were not charged again`));
    assert.deepEqual(charged, ["D-1"], "the processor was not called again");
    assert.equal(store.getOrderByIdempotency("D-2"), null, "no order is created for the refused repeat");
    // the same key stays a normal replay
    const same = await post({ idempotencyKey: "D-1", amount: "225.15", items: CART });
    assert.equal(same.status, 200);
    assert.equal((await same.json()).reused, true);
    // the browser's amount is irrelevant: the comparison uses the server amount
    const lying = await post({ idempotencyKey: "D-3", amount: "1.00", items: CART });
    assert.equal(lying.status, 409);
    assert.deepEqual(charged, ["D-1"]);
  });
});

test("route: 16 minutes later, another set of lines, another buyer, or a declined first order -> charged", async () => {
  let clock = Date.now();
  await withServer(approved, async ({ post, charged }) => {
    await post({ idempotencyKey: "E-1", amount: "225.15", items: CART });
    // other lines
    const other = await post({ idempotencyKey: "E-2", amount: "79.00", items: [{ sku: "kpv-10mg", qty: 1, amount: "79.00" }] });
    assert.equal(other.status, 200);
    // other buyer
    const buyer = await post({ idempotencyKey: "E-3", amount: "225.15", items: CART, customer: { ...CUSTOMER, email: "bob@lab.example" } });
    assert.equal(buyer.status, 200);
    assert.equal((await post({ idempotencyKey: "E-4", amount: "225.15", items: CART })).status, 409);
    clock += 16 * 60 * 1000;
    const later = await post({ idempotencyKey: "E-5", amount: "225.15", items: CART });
    assert.equal(later.status, 200);
    assert.deepEqual(charged, ["E-1", "E-2", "E-3", "E-5"]);
  }, { now: () => new Date(clock) });

  const declined = () => ({ ok: false, processor: "umg", processorTxnId: "D", processorStatus: "DECLINED", declineClass: "hard", cascadeAction: "stop", reason: "hard_decline", raw: {} });
  await withServer(declined, async ({ post, charged }) => {
    await post({ idempotencyKey: "F-1", amount: "225.15", items: CART });
    const retry = await post({ idempotencyKey: "F-2", amount: "225.15", items: CART });
    assert.equal(retry.status, 402, "a declined order does not block a new attempt");
    assert.deepEqual(charged, ["F-1", "F-2"]);
  });
});

test("route: a pending first order also blocks the repeat under a new key", async () => {
  const pending = () => ({ ok: false, processor: "umg", processorTxnId: "PN", processorStatus: "PENDING", cascadeAction: "wait", declineClass: null, reason: "pending_or_3ds", raw: {} });
  await withServer(pending, async ({ post, charged }) => {
    assert.equal((await post({ idempotencyKey: "G-1", amount: "225.15", items: CART })).status, 200);
    assert.equal((await post({ idempotencyKey: "G-2", amount: "225.15", items: CART })).status, 409);
    assert.deepEqual(charged, ["G-1"]);
  });
});

test("route: coupon reaches the charged amount end to end", async () => {
  await withServer(approved, async ({ post, store }) => {
    const body = await (await post({ idempotencyKey: "K-1", amount: "1.00", coupon: "INSIDER25", items: KPV1 })).json();
    assert.equal(body.chargedAmount, "59.25");
    assert.equal(store.getOrderByIdempotency("K-1").priceCheck.coupon, "INSIDER25");
    const viaNotes = await (await post({ idempotencyKey: "K-2", amount: "1.00", notes: "coupon:INSIDER25", items: [{ sku: "bpc-157-10mg", qty: 1, amount: "88.00" }] })).json();
    assert.equal(viaNotes.chargedAmount, "66.00");
  });
});

// ---- review round 2 (2026-09-29) ---------------------------------------------------------------------------------------
test("HIGH-1: find [] proves 'not charged' only when the request cannot have reached UMG", async () => {
  const empty = () => reply(200, []);
  // definitely not sent / refused by UMG with a JSON body -> not charged
  for (const [label, create] of [["ECONNREFUSED", refused], ["429 JSON", () => reply(429, { error: "slow" })],
    ["ENOTFOUND", () => { const e = new Error("getaddrinfo ENOTFOUND pay.umg.inc"); throw e; }],
    ["EAI_AGAIN", () => { const e = new Error("fetch failed"); e.cause = { code: "EAI_AGAIN" }; throw e; }]]) {
    const r = await umg.createPayment(INPUT, deps(umgFetch({ create, find: empty })));
    assert.equal(r.noChargeConfirmed, true, label);
    assert.equal(r.cascadeAction, "next", label);
  }
  // the request may have arrived -> [] is not proof
  for (const [label, create] of [["timeout", aborted], ["reset", reset], ["502 JSON", () => reply(502, { error: "gw" })], ["504", () => reply(504, { error: "gw" })],
    ["500 JSON", () => reply(500, { error: "x" })], ["503 JSON", () => reply(503, { error: "busy" })], ["503 empty body", () => reply(503, "")], ["503 html", () => reply(503, "<html>")], ["200 empty", () => reply(200, "")], ["2xx no status", () => reply(201, { note: 1 })]]) {
    const r = await umg.createPayment(INPUT, deps(umgFetch({ create, find: empty })));
    assert.equal(r.processorStatus, "UNKNOWN", label);
    assert.equal(r.cascadeAction, "wait", label);
    assert.equal(r.noChargeConfirmed, undefined, label);
  }
  // cascade: a timed-out create with [] does not reach the next processor
  const store = umgOnlyStore();
  const { result, calls } = await charge(store, "H1-A", umgFetch({ create: aborted, find: empty }));
  assert.equal(calls.tagada, 0);
  assert.equal(result.order.status, "pending");
});

test("HIGH-2: a recovered transaction in an in-between status is waited on, never declined; PAID is approved", async () => {
  const create = aborted;
  for (const st of ["PROCESSING - PENDING VERIFICATION", "AWAITING FOR 3DS VERIFICATION", "PENDING", "SOMETHING NEW"]) {
    const store = umgOnlyStore();
    const { result, calls } = await charge(store, `H2-${st.length}`, umgFetch({ create, find: (ext) => reply(200, [okRow(ext, { id: 7002, status: st })]) }));
    assert.equal(calls.tagada, 0, st);
    assert.equal(result.ok, true, st);
    assert.equal(result.pending, true, st);
    assert.equal(result.order.status, "pending", st);
    assert.equal(result.order.winningTxnId, "7002", st);
    assert.equal(result.order.attempts[0].processorTxnId, "7002", st);
  }
  const paid = await charge(umgOnlyStore(), "H2-PAID", umgFetch({ create, find: (ext) => reply(200, [okRow(ext, { status: "PAID" })]) }));
  assert.equal(paid.result.order.status, "approved");
  for (const st of ["DECLINED", "CANCELED", "CANCELLED"]) {
    const store = umgOnlyStore();
    const r = await charge(store, `H2-${st}`, umgFetch({ create, find: (ext) => reply(200, [okRow(ext, { status: st, information_data: "Do not honor" })]) }));
    assert.notEqual(r.result.order.status, "pending", st);
    assert.notEqual(r.result.order.status, "approved", st);
  }
});

test("HIGH-2: poller and webhook keep an in-between status pending and settle PAID / DECLINED", async () => {
  const { handleProcessorWebhook } = await import("../lib/webhooks.js");
  const store = umgOnlyStore();
  await charge(store, "H2-POLL", umgFetch({ create: aborted, find: (ext) => reply(200, [okRow(ext, { id: 7010, status: "PROCESSING - PENDING VERIFICATION" })]) }));
  const id = store.listOrders()[0].id;
  assert.equal(store.pendingAttempts("umg").length, 1, "in-between status with a txn id is polled");
  const seen = [];
  const poll = (status) => pollPending(store, { adapters: { umg: { ...umg, getTransaction: async (t) => { seen.push(t); return umg.mapUmgResponse({ id: t, status, ext_order_id: "H2-POLL" }, 200); } } } });
  await poll("PROCESSING - PENDING VERIFICATION");
  assert.equal(store.getOrder(id).status, "pending");
  assert.deepEqual(seen, ["7010"]);
  assert.equal(handleProcessorWebhook(store, "umg", { ID: "7010", Status: "PROCESSING - PENDING VERIFICATION" }).ok, true);
  assert.equal(store.getOrder(id).status, "pending", "webhook with an in-between status does not decline");
  await poll("PAID");
  assert.equal(store.getOrder(id).status, "approved");
  assert.equal(store.getOrder(id).winningTxnId, "7010");
  // and DECLINED from the poll is final
  const s2 = umgOnlyStore();
  await charge(s2, "H2-POLL2", umgFetch({ create: aborted, find: (ext) => reply(200, [okRow(ext, { id: 7011, status: "PENDING" })]) }));
  await pollPending(s2, { adapters: { umg: { ...umg, getTransaction: async (t) => umg.mapUmgResponse({ id: t, status: "DECLINED", ext_order_id: "H2-POLL2" }, 200) } } });
  assert.equal(s2.listOrders()[0].status, "declined");
});

test("MEDIUM-3: find ignores txn ids already on the order; only known rows left = UNKNOWN, not 'not charged'", async () => {
  const rows = (ext) => [{ id: 100, status: "DECLINED", ext_order_id: ext }];
  const only = await umg.findByExtId("K", { secret: "s", findDelayMs: 0, knownTxnIds: ["100"], fetchImpl: async () => reply(200, rows("K")) });
  assert.equal(only.state, "unknown");
  const both = await umg.findByExtId("K", { secret: "s", findDelayMs: 0, knownTxnIds: ["100"], fetchImpl: async () => reply(200, [...rows("K"), okRow("K", { id: 101 })]) });
  assert.equal(both.state, "found");
  assert.equal(both.txn.id, 101);
  const fresh = await umg.findByExtId("K", { secret: "s", findDelayMs: 0, fetchImpl: async () => reply(200, rows("K")) });
  assert.equal(fresh.state, "found", "without known ids the row is ours as before");
  // through the adapter: the retry of a declined order under the same key passes its earlier txn ids
  const r = await umg.createPayment({ ...INPUT, knownTxnIds: ["100"] }, deps(umgFetch({ create: aborted, find: (ext) => reply(200, rows(ext)) })));
  assert.equal(r.processorStatus, "UNKNOWN");
  // poller: order whose earlier attempt (txn 100) was declined and whose new attempt is unknown
  const store = createStore({ memoryOnly: true });
  store.upsertOrder({ id: "BLR-1", idempotencyKey: "M3", status: "pending", inFlight: false, createdAt: new Date().toISOString(), customer: CUSTOMER, items: [], amount: "10.00",
    attempts: [
      { attemptId: "a1", processor: "umg", processorTxnId: "100", processorStatus: "DECLINED", startedAt: new Date().toISOString() },
      { attemptId: "a2", processor: "umg", processorTxnId: null, processorStatus: "UNKNOWN", reason: "unknown_outcome", startedAt: new Date(Date.now() - 2 * UNKNOWN_GRACE_MS).toISOString() },
    ] });
  const res = await pollWith(store, async () => reply(200, rows("M3")), { now: () => Date.now() - 2 * UNKNOWN_GRACE_MS + 60000 }); // attempt is 1 min old
  assert.equal(res[0].waiting, true);
  assert.equal(store.getOrder("BLR-1").status, "pending", "the old declined transaction must not decline the new attempt");
  // LOW-C: 30+ min later, still only the known row -> no new charge appeared: decided like [], announced
  const lines = [];
  const late = await pollWith(store, async () => reply(200, rows("M3")), { log: (l) => lines.push(l) });
  assert.equal(late[0].found, false);
  assert.equal(store.getOrder("BLR-1").status, "declined");
  assert.equal(store.getOrder("BLR-1").attempts[1].reason, "not_charged_verified");
  assert.equal(store.getOrder("BLR-1").attempts[0].processorStatus, "DECLINED");
  assert.deepEqual(lines, ["[pay-alert] NOT_CHARGED_VERIFIED BLR-1 M3"]);
});

test("MEDIUM-4: a replay of an unfinished order is pending; in flight also says charged:'unknown'", async () => {
  const pending = () => ({ ok: false, processor: "umg", processorTxnId: "PN", processorStatus: "PENDING", cascadeAction: "wait", declineClass: null, reason: "pending_or_3ds", raw: {} });
  await withServer(pending, async ({ post, store }) => {
    await post({ idempotencyKey: "M4-1", amount: "225.15", items: CART });
    const again = await (await post({ idempotencyKey: "M4-1", amount: "225.15", items: CART })).json();
    assert.equal(again.reused, true);
    assert.equal(again.pending, true);
    assert.equal(again.charged, undefined);
    // an order stuck in flight (e.g. the process died mid-charge)
    store.upsertOrder({ id: "BLR-9001", idempotencyKey: "M4-2", status: "new", inFlight: true, createdAt: new Date().toISOString(), customer: CUSTOMER, items: [], amount: "10.00", attempts: [] });
    const stuck = await (await post({ idempotencyKey: "M4-2", amount: "225.15", items: CART })).json();
    assert.equal(stuck.reused, true);
    assert.equal(stuck.pending, true);
    assert.equal(stuck.charged, "unknown");
    assert.match(stuck.message, /do not pay again/i);
  });
});

test("MEDIUM-5: after a restart an orphaned in-flight order becomes an unknown attempt and the poller settles it", async () => {
  const { recoverInFlight } = await import("../lib/poller.js");
  const store = createStore({ memoryOnly: true });
  const created = "2026-09-29T10:00:00.000Z";
  store.upsertOrder({ id: "BLR-1", idempotencyKey: "RI-1", status: "new", inFlight: true, createdAt: created, updatedAt: created, customer: CUSTOMER, items: [], amount: "10.00", attempts: [] });
  store.upsertOrder({ id: "BLR-2", idempotencyKey: "RI-2", status: "approved", inFlight: false, createdAt: created, customer: CUSTOMER, items: [], amount: "10.00", attempts: [] });
  store.upsertOrder({ id: "BLR-3", idempotencyKey: "RI-3", status: "awaiting_crypto", paymentMethod: "crypto", inFlight: false, createdAt: created, items: [], amount: "10.00" });
  const lines = [];
  const nowMs = Date.parse("2026-09-29T12:00:00.000Z");
  const n = recoverInFlight(store, { now: nowMs, log: (l) => lines.push(l) });
  assert.equal(n, 1);
  assert.deepEqual(lines, ["[pay-alert] RECOVERED_INFLIGHT BLR-1"]);
  const o = store.getOrder("BLR-1");
  assert.equal(o.inFlight, false);
  assert.equal(o.status, "pending");
  assert.equal(o.attempts.length, 1);
  assert.equal(o.attempts[0].processor, "umg");
  assert.equal(o.attempts[0].reason, "unknown_outcome");
  assert.equal(o.attempts[0].processorStatus, "UNKNOWN");
  assert.equal(o.attempts[0].startedAt, "2026-09-29T12:00:00.000Z", "the 30 min window counts from the recovery, not from createdAt");
  assert.equal(o.attempts[0].attemptId, "umg-recovered-2026-09-29T12:00:00.000Z");
  assert.equal(store.getOrder("BLR-2").status, "approved");
  assert.equal(store.getOrder("BLR-3").status, "awaiting_crypto");
  assert.equal(recoverInFlight(store, { log: () => {} }), 0, "idempotent");
  await pollWith(store, async () => reply(200, [okRow("RI-1")]));
  assert.equal(store.getOrder("BLR-1").status, "approved");
  assert.equal(store.getOrder("BLR-1").winningTxnId, "7001");
});

test("LOW-9: not_charged_verified is announced to staff", async () => {
  const store = await unknownOrder("NCV-1");
  const lines = [];
  await pollWith(store, async () => reply(200, []), { now: () => Date.now() + UNKNOWN_GRACE_MS + 60000, log: (l) => lines.push(l) });
  const o = store.listOrders()[0];
  assert.deepEqual(lines, [`[pay-alert] NOT_CHARGED_VERIFIED ${o.id} NCV-1`]);
});

test("LOW-10: the poller never starts a pass while the previous one is still running", async () => {
  const { startPoller } = await import("../lib/poller.js");
  const store = createStore({ memoryOnly: true });
  store.upsertOrder({ id: "BLR-1", idempotencyKey: "LP", status: "pending", createdAt: new Date().toISOString(), customer: CUSTOMER, items: [], amount: "1.00",
    attempts: [{ attemptId: "a", processor: "umg", processorTxnId: "5", processorStatus: "PENDING", startedAt: new Date().toISOString() }] });
  let active = 0, max = 0, calls = 0;
  const slow = { umg: { async getTransaction() { active += 1; calls += 1; max = Math.max(max, active); await new Promise((r) => setTimeout(r, 60)); active -= 1; return { processorStatus: "PENDING" }; } } };
  const stop = startPoller(store, { intervalMs: 5, adapters: slow });
  await new Promise((r) => setTimeout(r, 250));
  stop();
  assert.equal(max, 1);
  assert.ok(calls >= 2, "it keeps polling, just not concurrently");
});

test("MEDIUM-B: a direct 2xx answer to create with an unfamiliar status waits (pending, txn id), it is not a decline", async () => {
  const body = (status, extra = {}) => () => reply(201, { id: 8123, status, date: "Sep 29, 2026", ext_order_id: "K", ...extra });
  for (const st of ["PROCESSING - PENDING VERIFICATION", "REVIEW", "Processing"]) {
    const f = umgFetch({ create: body(st), find: () => { throw new Error("no find needed"); } });
    const r = await umg.createPayment(INPUT, deps(f));
    assert.equal(r.cascadeAction, "wait", st);
    assert.equal(r.processorTxnId, "8123", st);
    assert.equal(r.ok, false, st);
    assert.equal(f.calls.length, 1, `${st}: a direct answer needs no find`);
    const store = umgOnlyStore();
    const c = await charge(store, `MB-${st.length}`, umgFetch({ create: body(st), find: () => reply(200, []) }));
    assert.equal(c.calls.tagada, 0, st);
    assert.equal(c.result.pending, true, st);
    assert.equal(c.result.order.status, "pending", st);
    assert.equal(c.result.order.winningTxnId, "8123", st);
  }
  // unfamiliar status without an id cannot be polled: treated as an unclear outcome (find by key)
  const noId = await umg.createPayment(INPUT, deps(umgFetch({ create: () => reply(201, { status: "REVIEW" }), find: () => reply(500, "x") })));
  assert.equal(noId.processorStatus, "UNKNOWN");
  assert.equal(noId.cascadeAction, "wait");
  // as before: DECLINED / CANCELED decide, PAID and APPROVED approve, PENDING waits
  for (const [st, action] of [["DECLINED", "next"], ["CANCELED", "stop"], ["PAID", "success"], ["APPROVED", "success"], ["PENDING", "wait"]]) {
    const r = await umg.createPayment(INPUT, deps(umgFetch({ create: body(st, { information_data: st === "DECLINED" ? "Activity limit exceeded; Code:203" : "" }), find: () => reply(200, []) })));
    assert.equal(r.cascadeAction, action, st);
  }
});
