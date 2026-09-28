import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { priceCryptoCart, priceCardCart, splitCartSku } from "../lib/pricing.js";
import { buildNotifyPayload } from "../lib/store-forward.js";
import { startCrmServer } from "../index.js";

const KEY = "test-marketing-digest-key";
const CUSTOMER = { first_name: "Ada", last_name: "N", email: "ada@lab.example" };

// Mimics products-api coupon-quote: catalog unit U per strength, 2+ = round(U*89/99), 3+ = round(U*79/99).
const CATALOG = { "bpc-157": { "10mg": 88, "20mg": 105 }, kpv: { "10mg": 79 }, semax: { "10mg": 99, "30mg": 119 } };
function catalogQuote() {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    let sum = 0; const unknown = [];
    for (const it of body.items) {
      const p = CATALOG[it.slug];
      const u = p ? (p[it.mg] ?? Object.values(p)[0]) : undefined;
      if (u === undefined) { unknown.push(it.slug); continue; }
      const unit = it.qty >= 3 ? Math.round(u * 79 / 99) : it.qty >= 2 ? Math.round(u * 89 / 99) : u;
      sum += unit * it.qty;
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, subtotal: sum.toFixed(2), ...(unknown.length ? { unknown_items: unknown } : {}) }) };
  };
  fn.calls = calls;
  return fn;
}
const quoteStub = () => catalogQuote();

test("sku split", () => {
  assert.deepEqual(splitCartSku("bpc-157-10mg"), { slug: "bpc-157", mg: "10mg" });
});

test("server amount wins over a tampered browser amount; express shipping inferred", async () => {
  const f = catalogQuote();
  const tampered = await priceCryptoCart({ amount: "1.00", items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 2, amount: "1.00" }] }, { fetchImpl: f });
  assert.equal(tampered.ok, true);
  assert.equal(tampered.amount, "158.00");
  assert.equal(tampered.mismatch, true);
  assert.equal(tampered.clientAmount, "1.00");
  assert.equal(tampered.lines[0].rule, "repriced");
  assert.equal(f.calls[0].items[0].slug, "bpc-157");
  assert.equal(f.calls[0].items[0].mg, "10mg");

  const honestExpress = await priceCryptoCart({ amount: "194.99", items: [{ sku: "bpc-157-10mg", name: "BPC-157", qty: 2, amount: "176.00" }] }, { fetchImpl: catalogQuote() });
  assert.equal(honestExpress.amount, "194.99");
  assert.equal(honestExpress.lines[0].rule, "single_bottle");
  assert.equal(honestExpress.shipping, "18.99");
  assert.equal(honestExpress.mismatch, false);
});

test("unknown items and a dead catalog fail closed", async () => {
  const unk = await priceCryptoCart({ amount: "10", items: [{ sku: "fake-1mg", qty: 1, amount: "10" }] }, { fetchImpl: catalogQuote() });
  assert.equal(unk.ok, false);
  assert.equal(unk.error, "unknown_item");
  const down = await priceCryptoCart({ amount: "10", items: [{ sku: "kpv-10mg", qty: 1, amount: "10" }] }, { fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.status, 503);
});

test("crypto route stores + returns the server amount, flags mismatch; staff deletes test orders only", async () => {
  const prev = process.env.MARKETING_DIGEST_KEY;
  process.env.MARKETING_DIGEST_KEY = KEY;
  const store = createStore({ memoryOnly: true });
  const server = await startCrmServer(0, {
    store,
    cryptoPricer: (body) => priceCryptoCart(body, { fetchImpl: catalogQuote() }),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const staff = { "X-Marketing-Key": KEY, "Content-Type": "application/json" };
  try {
    const mk = (key, test) => fetch(`${base}/api/checkout/crypto`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: key, amount: "5.00", network: "trc20", customer: CUSTOMER, items: [{ sku: "bpc-157-10mg", name: "BPC-157", qty: 1, amount: "5.00" }], ...(test ? { test: true } : {}) }),
    }).then((r) => r.json());
    const t = await mk("K-TEST", true);
    assert.equal(t.amount, "88.00");
    { const d = Math.round((Number(t.amountDue) - 88.00) * 100); assert.ok(d >= 1 && d <= 99, "unique 0.01-0.99 offset on the pay amount"); assert.equal(t.payAmount, t.amountDue); }
    assert.equal(t.priceAdjusted, true);
    const saved = store.getOrderByRef(t.orderRef);
    assert.equal(saved.priceCheck.clientAmount, "5.00");
    assert.equal(saved.priceMismatch, true);
    const again = await mk("K-TEST", true);
    assert.equal(again.orderRef, t.orderRef);
    assert.equal(again.amountDue, t.amountDue);

    const real = await mk("K-REAL", false);
    assert.equal((await fetch(`${base}/api/store-orders/${t.orderRef}`, { method: "DELETE" })).status, 401);
    const nope = await fetch(`${base}/api/store-orders/${real.orderRef}`, { method: "DELETE", headers: staff });
    assert.equal(nope.status, 409);
    const del = await fetch(`${base}/api/store-orders/${t.orderRef}`, { method: "DELETE", headers: staff });
    assert.equal(del.status, 200);
    assert.equal(store.getOrderByRef(t.orderRef), null);
    assert.ok(store.getOrderByRef(real.orderRef));

    store.upsertAbandonedCheckout({ session_id: "s-qa", customer: { email: "qa-test+k8m4c@biolabsresearch.co" }, stage: "contact", items: [] });
    store.upsertAbandonedCheckout({ session_id: "s-real", customer: { email: "buyer@lab.example" }, stage: "contact", items: [] });
    assert.equal((await fetch(`${base}/api/checkout/abandon/s-real`, { method: "DELETE", headers: staff })).status, 409);
    assert.equal((await fetch(`${base}/api/checkout/abandon/s-qa`, { method: "DELETE" })).status, 401);
    assert.equal((await fetch(`${base}/api/checkout/abandon/s-qa`, { method: "DELETE", headers: staff })).status, 200);
    assert.equal(store.getAbandonedCheckout("s-qa"), null);
    assert.ok(store.getAbandonedCheckout("s-real"));
  } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.MARKETING_DIGEST_KEY; else process.env.MARKETING_DIGEST_KEY = prev;
  }
});

test("card pricing: honest carts charge exactly the storefront total (packs, single-bottle, gift, both shipping)", async () => {
  const cases = [
    // [items (unit prices as the storefront sends), storefront total]
    [[{ sku: "bpc-157-10mg", qty: 1, amount: "88.00" }], "88.00"],
    [[{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }], "158.00"],
    [[{ sku: "bpc-157-10mg", qty: 3, amount: "70.00" }], "210.00"],
    [[{ sku: "bpc-157-10mg", qty: 2, amount: "88.00" }], "176.00"],
    [[{ sku: "semax-30mg", qty: 1, amount: "119.00" }, { sku: "kpv-10mg", qty: 3, amount: "63.00" }, { sku: "research-solvent-10ml", qty: 1, amount: "0.00" }], "308.00"],
    [[{ sku: "kpv-10mg", qty: 1, amount: "79.00" }], "97.99"],
  ];
  for (const [items, total] of cases) {
    const r = await priceCardCart({ amount: total, items }, { fetchImpl: catalogQuote() });
    assert.equal(r.ok, true, JSON.stringify(items));
    assert.equal(r.amount, total, JSON.stringify(items));
    assert.equal(r.mismatch, false);
  }
  const cheat = await priceCardCart({ amount: "18.99", items: [{ sku: "kpv-10mg", qty: 3, amount: "0.00" }] }, { fetchImpl: catalogQuote() });
  // item prices zeroed: lines repriced to the catalog; the leftover 18.99 reads as express shipping and is charged
  assert.equal(cheat.amount, "207.99");
  assert.equal(cheat.shipping, "18.99");
  assert.equal(cheat.mismatch, true);
});

test("card charge route: UMG gets the server amount, response returns it, pricing failures never charge", async () => {
  const prev = { p: process.env.PAYMENTS_ENABLED, k: process.env.MARKETING_DIGEST_KEY };
  process.env.PAYMENTS_ENABLED = "true";
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const charged = [];
  let pricingDown = false;
  const server = await startCrmServer(0, {
    store,
    cardPricer: (body) => priceCardCart(body, { fetchImpl: pricingDown ? async () => { throw new Error("down"); } : catalogQuote() }),
    adapters: { umg: { async createPayment(p) { charged.push(p.amount); return { ok: true, processor: "umg", processorTxnId: `U-${charged.length}`, processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } }, tagada: {}, centrobill: {} },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const card = { name: "Ada", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
  const post = (b) => fetch(`${base}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ customer: CUSTOMER, card, ...b }) });
  try {
    const honest = await post({ idempotencyKey: "C-1", amount: "176.99", items: [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }] });
    const hb = await honest.json();
    assert.equal(honest.status, 200);
    assert.equal(hb.chargedAmount, "176.99");
    assert.equal(hb.priceAdjusted, false);
    assert.deepEqual(charged, ["176.99"]);

    const cheat = await post({ idempotencyKey: "C-2", amount: "1.00", items: [{ sku: "bpc-157-10mg", qty: 2, amount: "0.50" }] });
    const cb = await cheat.json();
    assert.equal(cb.chargedAmount, "158.00");
    assert.equal(cb.priceAdjusted, true);
    assert.equal(charged[1], "158.00");
    const saved = store.getOrder(cb.order.id);
    assert.equal(saved.clientAmount, "1.00");
    assert.equal(saved.priceCheck.serverAmount, "158.00");
    const fwd = buildNotifyPayload(saved);
    assert.equal(fwd.orderData.total, "158.00");
    assert.equal(fwd.orderData.subtotal, "158.00");
    assert.equal(fwd.orderData.items[0].price, 79);

    const unk = await post({ idempotencyKey: "C-3", amount: "10", items: [{ sku: "fake-1mg", qty: 1, amount: "10" }] });
    assert.equal(unk.status, 400);
    assert.equal((await unk.json()).charged, false);
    pricingDown = true;
    const down = await post({ idempotencyKey: "C-4", amount: "88.00", items: [{ sku: "bpc-157-10mg", qty: 1, amount: "88.00" }] });
    assert.equal(down.status, 503);
    assert.equal(charged.length, 2);
    assert.equal(store.getOrderByIdempotency("C-3"), null);
    assert.equal(store.getOrderByIdempotency("C-4"), null);

    // replay of an approved order: no re-pricing, no second charge
    const replay = await post({ idempotencyKey: "C-1", amount: "176.99", items: [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }] });
    assert.equal((await replay.json()).chargedAmount, "176.99");
    assert.equal(charged.length, 2);
  } finally {
    await new Promise((r) => server.close(r));
    for (const [k, v] of [["PAYMENTS_ENABLED", prev.p], ["MARKETING_DIGEST_KEY", prev.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
