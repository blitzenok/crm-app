import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { priceCryptoCart, splitCartSku } from "../lib/pricing.js";
import { startCrmServer } from "../index.js";

const KEY = "test-marketing-digest-key";
const CUSTOMER = { first_name: "Ada", last_name: "N", email: "ada@lab.example" };

function quoteStub(subtotal, extra = {}) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, subtotal, shipping: "0.00", discount_pct: 0, discount_source: "none", ...extra }) };
  };
  fn.calls = calls;
  return fn;
}

test("sku split", () => {
  assert.deepEqual(splitCartSku("bpc-157-10mg"), { slug: "bpc-157", mg: "10mg" });
});

test("server amount wins over a tampered browser amount; express shipping inferred", async () => {
  const f = quoteStub("176.00");
  const tampered = await priceCryptoCart({ amount: "1.00", items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 2, amount: "1.00" }] }, { fetchImpl: f });
  assert.equal(tampered.ok, true);
  assert.equal(tampered.amount, "176.00");
  assert.equal(tampered.mismatch, true);
  assert.equal(tampered.clientAmount, "1.00");
  assert.deepEqual(f.calls[0].items[0], { slug: "bpc-157", name: "BPC-157", mg: "10mg", qty: 2, price: 0.5 });

  const honestExpress = await priceCryptoCart({ amount: "194.99", items: [{ sku: "bpc-157-10mg", name: "BPC-157", qty: 2, amount: "176.00" }] }, { fetchImpl: quoteStub("176.00") });
  assert.equal(honestExpress.amount, "194.99");
  assert.equal(honestExpress.shipping, "18.99");
  assert.equal(honestExpress.mismatch, false);
});

test("unknown items and a dead catalog fail closed", async () => {
  const unk = await priceCryptoCart({ amount: "10", items: [{ sku: "fake-1mg", qty: 1, amount: "10" }] }, { fetchImpl: quoteStub("0.00", { unknown_items: ["fake"] }) });
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
    cryptoPricer: (body) => priceCryptoCart(body, { fetchImpl: quoteStub("88.00") }),
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
    assert.equal(t.amountDue, "88.00");
    assert.equal(t.priceAdjusted, true);
    const saved = store.getOrderByRef(t.orderRef);
    assert.equal(saved.priceCheck.clientAmount, "5.00");
    assert.equal(saved.priceMismatch, true);
    const again = await mk("K-TEST", true);
    assert.equal(again.orderRef, t.orderRef);
    assert.equal(again.amountDue, "88.00");

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
