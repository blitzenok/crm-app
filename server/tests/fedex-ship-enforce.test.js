// 2026-09-29 FedEx 2-Day only (storefront 3.00k8m5e/f): shipping priced server-side from merchandise after the volume
// ladder; $18.99 at or under $100.00, free strictly over $100.00. SHIP_ENFORCE_FEDEX=true on the host (opts.enforceFedex here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { priceCardCart, priceCryptoCart, fedexShipRow, fedexEnforced } from "../lib/pricing.js";
import { startCrmServer } from "../index.js";
import { couponQuoteFake } from "./helpers/coupon-quote-fake.js";

const CATALOG = {
  "nad-plus": { "500mg": 99, "1000mg": 130 },
  "t-hundred": { "1mg": 100 },
  "t-hundred-one": { "1mg": 101 },
  "t-edge-lo": { "1mg": 105.26 }, // 5% -> 100.00 (not over)
  "t-edge-hi": { "1mg": 105.27 }, // 5% -> 100.01 (over)
  "t-base-10001": { "1mg": 100.01 },
};
const q = () => couponQuoteFake({ catalog: CATALOG });
const ON = { enforceFedex: true };
const card = (sku, unit, shipMethod, amount) => priceCardCart({ amount, items: [{ sku, qty: 1, amount: unit }], ...(shipMethod ? { shipMethod } : {}) }, { fetchImpl: q(), ...ON });

test("fedexShipRow: base after the volume ladder, free strictly over $100.00", () => {
  assert.deepEqual(fedexShipRow(9900), { baseCents: 9900, shippingCents: 1899, shipMethod: "express" });
  assert.deepEqual(fedexShipRow(10000), { baseCents: 9500, shippingCents: 1899, shipMethod: "express" }); // 100.00 -> 5% -> 95.00
  assert.deepEqual(fedexShipRow(10001), { baseCents: 9501, shippingCents: 1899, shipMethod: "express" });
  assert.deepEqual(fedexShipRow(10100), { baseCents: 9595, shippingCents: 1899, shipMethod: "express" }); // 101 -> 95.95
  assert.deepEqual(fedexShipRow(10526), { baseCents: 10000, shippingCents: 1899, shipMethod: "express" }); // exactly 100.00 pays
  assert.deepEqual(fedexShipRow(10527), { baseCents: 10001, shippingCents: 0, shipMethod: "ground" }); // 100.01 free
  assert.deepEqual(fedexShipRow(13000), { baseCents: 12350, shippingCents: 0, shipMethod: "ground" }); // 130 -> 123.50 free
});

test("flag: SHIP_ENFORCE_FEDEX=true only; opts override", () => {
  const prev = process.env.SHIP_ENFORCE_FEDEX;
  try {
    delete process.env.SHIP_ENFORCE_FEDEX; assert.equal(fedexEnforced(), false);
    process.env.SHIP_ENFORCE_FEDEX = "true"; assert.equal(fedexEnforced(), true);
    assert.equal(fedexEnforced({ enforceFedex: false }), false);
  } finally { if (prev === undefined) delete process.env.SHIP_ENFORCE_FEDEX; else process.env.SHIP_ENFORCE_FEDEX = prev; }
});

test("card: $99 cart -> $18.99, total $117.99 (what checkout shows)", async () => {
  const r = await card("nad-plus-500mg", "99.00", "express", "117.99");
  assert.equal(r.ok, true);
  assert.equal(r.shipping, "18.99");
  assert.equal(r.shipMethod, "express");
  assert.equal(r.shipService, "fedex_2day");
  assert.equal(r.amount, "117.99");
  assert.equal(r.mismatch, false);
});

test("card: $100.00 pre-discount (95.00 after 5%) and exactly $100.00 after discount pay $18.99", async () => {
  const a = await card("t-hundred-1mg", "100.00", "express", "113.99");
  assert.equal(a.shipping, "18.99"); assert.equal(a.amount, "113.99"); assert.equal(a.mismatch, false);
  const b = await card("t-edge-lo-1mg", "105.26", "express", "118.99");
  assert.equal(b.shipRule.base, "100.00"); assert.equal(b.shipping, "18.99"); assert.equal(b.amount, "118.99");
});

test("card: $100.01 pre-discount -> 95.01 pays; $100.01 after discount is free", async () => {
  const a = await card("t-base-10001-1mg", "100.01", "express", "114.00");
  assert.equal(a.shipping, "18.99"); assert.equal(a.amount, "114.00");
  const b = await card("t-edge-hi-1mg", "105.27", "ground", "100.01");
  assert.equal(b.ok, true); assert.equal(b.shipping, "0.00"); assert.equal(b.shipMethod, "ground"); assert.equal(b.amount, "100.01"); assert.equal(b.mismatch, false);
});

test("card: $101 with 5% = 95.95 -> $18.99 (total 114.94)", async () => {
  const r = await card("t-hundred-one-1mg", "101.00", "express", "114.94");
  assert.equal(r.shipRule.base, "95.95"); assert.equal(r.shipping, "18.99"); assert.equal(r.amount, "114.94"); assert.equal(r.mismatch, false);
});

test("card: $130 -> 123.50 -> free (ground row); express sent anyway is priced free, never more", async () => {
  const r = await card("nad-plus-1000mg", "130.00", "ground", "123.50");
  assert.equal(r.shipping, "0.00"); assert.equal(r.amount, "123.50"); assert.equal(r.mismatch, false);
  const e = await card("nad-plus-1000mg", "130.00", "express", "142.49");
  assert.equal(e.ok, true); assert.equal(e.shipping, "0.00"); assert.equal(e.shipMethod, "ground"); assert.equal(e.amount, "123.50"); assert.equal(e.shipRule.overridden, true);
});

test("tamper: ground / free on a $99 cart is refused 400 shipping_mismatch, charged:false; no shipMethod -> 18.99", async () => {
  for (const sm of ["ground", "free", "standard"]) {
    const r = await card("nad-plus-500mg", "99.00", sm, "99.00");
    assert.equal(r.ok, false, sm); assert.equal(r.error, "shipping_mismatch"); assert.equal(r.status, 400); assert.equal(r.charged, false); assert.equal(r.shipping, "18.99");
    assert.match(r.message, /You were not charged/);
  }
  const none = await priceCardCart({ amount: "99.00", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] }, { fetchImpl: q(), ...ON });
  assert.equal(none.ok, true); assert.equal(none.shipping, "18.99"); assert.equal(none.amount, "117.99"); assert.equal(none.mismatch, true);
});

test("crypto: same rule (line totals); ground on $99 refused, $130 free", async () => {
  const bad = await priceCryptoCart({ amount: "99.00", shipMethod: "ground", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] }, { fetchImpl: q(), ...ON });
  assert.equal(bad.error, "shipping_mismatch");
  const ok = await priceCryptoCart({ amount: "117.99", shipMethod: "express", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] }, { fetchImpl: q(), ...ON });
  assert.equal(ok.amount, "117.99");
  const free = await priceCryptoCart({ amount: "123.50", shipMethod: "ground", items: [{ sku: "nad-plus-1000mg", qty: 1, amount: "130.00" }] }, { fetchImpl: q(), ...ON });
  assert.equal(free.amount, "123.50"); assert.equal(free.shipping, "0.00");
});

test("gift line (research-solvent) is not in the base; a winning coupon is in the base (after discounts)", async () => {
  const r = await priceCardCart({ amount: "117.99", shipMethod: "express", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }, { sku: "research-solvent", qty: 1, amount: "0" }] }, { fetchImpl: q(), ...ON });
  assert.equal(r.shipping, "18.99"); assert.equal(r.amount, "117.99");
  // 105.27 with INSIDER25 (25% beats the 5% ladder) -> 78.95 after discounts -> $18.99; ground is refused
  const c = await priceCardCart({ amount: "97.94", shipMethod: "express", coupon: "INSIDER25", items: [{ sku: "t-edge-hi-1mg", qty: 1, amount: "105.27" }] }, { fetchImpl: q(), ...ON });
  assert.equal(c.ok, true); assert.equal(c.shipping, "18.99"); assert.equal(c.shipRule.base, "78.95"); assert.equal(c.amount, "97.94"); assert.equal(c.mismatch, false);
  const cg = await priceCardCart({ amount: "78.95", shipMethod: "ground", coupon: "INSIDER25", items: [{ sku: "t-edge-hi-1mg", qty: 1, amount: "105.27" }] }, { fetchImpl: q(), ...ON });
  assert.equal(cg.error, "shipping_mismatch");
  // 231.00 with INSIDER25 (25%) -> 173.25 -> free
  const big = await priceCardCart({ amount: "105.00", shipMethod: "ground", coupon: "INSIDER25", items: [{ sku: "nad-plus-1000mg", qty: 1, amount: "130.00" }, { sku: "t-hundred-one-1mg", qty: 1, amount: "101.00" }] }, { fetchImpl: q(), ...ON });
  assert.equal(big.ok, true); assert.equal(big.shipping, "0.00");
});

test("flag off: previous behaviour (browser picks ground/express)", async () => {
  const r = await priceCardCart({ amount: "99.00", shipMethod: "ground", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] }, { fetchImpl: q(), enforceFedex: false });
  assert.equal(r.ok, true); assert.equal(r.shipping, "0.00"); assert.equal(r.shipService, undefined);
});

async function withServer(run) {
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
    cardPricer: (b) => priceCardCart(b, { fetchImpl: q(), ...ON }),
    cryptoPricer: (b) => priceCryptoCart(b, { fetchImpl: q(), ...ON }),
    adapters: { umg: { async createPayment(p) { charged.push({ id: p.extOrderId, amount: p.amount }); return { ok: true, processor: "umg", processorTxnId: `U-${charged.length}`, processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } }, tagada: {}, centrobill: {} },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (p, b) => fetch(`${base}${p}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
  try { await run({ post, charged, store }); } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = prev;
  }
}
const CUSTOMER = { first_name: "Ada", last_name: "N", email: "ada@lab.example", address: "1 Main", city: "X", state: "CA", zip: "90001", country: "US", phone: "5555555555" };
const CARD = { name: "Ada N", number: "4242424242424242", month: "12", year: "30", cvv: "123" };

test("route /api/checkout/charge: tampered ground on $99 -> 400 charged:false, no processor call; $99 express charges 117.99; $130 charges 123.50", async () => {
  await withServer(async ({ post, charged, store }) => {
    const bad = await post("/api/checkout/charge", { idempotencyKey: "F-1", customer: CUSTOMER, card: CARD, shipMethod: "ground", amount: "99.00", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] });
    const bb = await bad.json();
    assert.equal(bad.status, 400); assert.equal(bb.error, "shipping_mismatch"); assert.equal(bb.charged, false); assert.equal(bb.shipping, "18.99");
    assert.equal(charged.length, 0); assert.equal(store.getOrderByIdempotency("F-1"), null);
    const ok = await (await post("/api/checkout/charge", { idempotencyKey: "F-2", customer: CUSTOMER, card: CARD, shipMethod: "express", amount: "117.99", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] })).json();
    assert.equal(ok.chargedAmount, "117.99");
    const free = await (await post("/api/checkout/charge", { idempotencyKey: "F-3", customer: { ...CUSTOMER, email: "b@lab.example" }, card: CARD, shipMethod: "ground", amount: "123.50", items: [{ sku: "nad-plus-1000mg", qty: 1, amount: "130.00" }] })).json();
    assert.equal(free.chargedAmount, "123.50");
    assert.equal(store.getOrderByIdempotency("F-3").priceCheck.shipping, "0.00");
  });
});

test("route /api/checkout/crypto: tampered ground on $99 -> 400 shipping_mismatch", async () => {
  await withServer(async ({ post }) => {
    const r = await post("/api/checkout/crypto", { idempotencyKey: "FC-1", network: "trc20", customer: CUSTOMER, shipMethod: "ground", amount: "99.00", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] });
    const b = await r.json();
    assert.equal(r.status, 400); assert.equal(b.error, "shipping_mismatch"); assert.equal(b.charged, false);
    const ok = await (await post("/api/checkout/crypto", { idempotencyKey: "FC-2", network: "trc20", customer: CUSTOMER, shipMethod: "express", amount: "117.99", items: [{ sku: "nad-plus-500mg", qty: 1, amount: "99.00" }] })).json();
    assert.equal(ok.amount, "117.99");
  });
});
