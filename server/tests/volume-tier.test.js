import { test } from "node:test";
import assert from "node:assert/strict";
import { priceCardCart, priceCryptoCart, volumePct, volumeDiscountedCents } from "../lib/pricing.js";
import { couponQuoteFake } from "./helpers/coupon-quote-fake.js";

// infra 2026-09-29 honest-charge: the ladder now comes from the coupon-quote reply (helpers/coupon-quote-fake.js mirrors
// products-api); the local volumePct / volumeDiscountedCents no longer decide the charged amount.
const catalogQuote = () => couponQuoteFake();
// storefront drawer (cart-vial.js updateTotals) — reference implementation, copied logic
function storefrontDrawer(merch) {
  const vol = merch >= 500 ? 15 : merch >= 250 ? 10 : merch >= 100 ? 5 : 0;
  return vol > 0 ? Math.round(merch * (1 - vol / 100) * 100) / 100 : merch;
}

test("tier thresholds are inclusive and on undiscounted merch", () => {
  assert.equal(volumePct(99.99), 0);
  assert.equal(volumePct(100), 5);
  assert.equal(volumePct(249.99), 5);
  assert.equal(volumePct(250), 10);
  assert.equal(volumePct(499.99), 10);
  assert.equal(volumePct(500), 15);
  assert.deepEqual(volumeDiscountedCents(15800), { pct: 5, cents: 15010 });
  assert.deepEqual(volumeDiscountedCents(9900), { pct: 0, cents: 9900 });
});

const cases = [
  // label, card items (unit prices), merch
  ["under $100", [{ sku: "bpc-157-10mg", qty: 1, amount: "88.00" }], 88],
  ["just above $100 (102)", [{ sku: "g1-s-5mg", qty: 1, amount: "60.00" }, { sku: "aod-9604-5mg", qty: 1, amount: "42.00" }], 102],
  ["just above $250 (253)", [{ sku: "bpc-157-10mg", qty: 1, amount: "88.00" }, { sku: "g1-s-5mg", qty: 1, amount: "60.00" }, { sku: "bpc-157-20mg", qty: 1, amount: "105.00" }], 253],
  ["just above $500 (501)", [{ sku: "g3-r-50mg", qty: 1, amount: "300.00" }, { sku: "bpc-157-10mg", qty: 2, amount: "79.00" }, { sku: "g1-s-5mg", qty: 1, amount: "60.00" }], 518],
];

test("card + crypto: server amount = storefront drawer total + shipping (ground and express)", async () => {
  const c250 = [{ sku: "kpv-10mg", qty: 2, amount: "71.00" }, { sku: "g1-s-5mg", qty: 1, amount: "60.00" }, { sku: "aod-9604-5mg", qty: 1, amount: "42.00" }, { sku: "research-solvent-10ml", qty: 1, amount: "0.00" }]; // 142+60+42 = 244
  const c253 = [{ sku: "kpv-10mg", qty: 2, amount: "71.00" }, { sku: "bpc-157-10mg", qty: 1, amount: "88.00" }, { sku: "aod-9604-5mg", qty: 1, amount: "42.00" }]; // 142+88+42 = 272
  const all = [cases[0], cases[1], cases[2], ["$272 (10%)", c253, 272], ["$244 + BAC gift stays 5%", c250, 244], cases[3]];
  for (const [label, items, merch] of all) {
    for (const ship of [0, 18.99]) {
      const display = storefrontDrawer(merch) + ship;          // what the drawer tier promises, plus the checkout shipping
      const checkoutTotal = (merch + ship).toFixed(2);          // what checkout.html sends today (undiscounted)
      const card = await priceCardCart({ amount: checkoutTotal, items, shipMethod: ship ? "express" : "ground" }, { fetchImpl: catalogQuote() });
      assert.equal(card.ok, true, label);
      assert.equal(card.amount, display.toFixed(2), `${label} ship=${ship}`);
      // the page's total no longer counts: only a total equal to the server amount is "honest" (undiscounted one is flagged)
      assert.equal(card.mismatch, merch >= 100, `${label} undiscounted browser total is flagged exactly when a ladder tier applies`);
      assert.equal(card.shipping, ship.toFixed(2));
      const crypto = await priceCryptoCart({ amount: checkoutTotal, shipMethod: ship ? "express" : "ground", items: items.map((i) => ({ ...i, amount: (Number(i.amount) * i.qty).toFixed(2) })) }, { fetchImpl: catalogQuote() });
      assert.equal(crypto.amount, display.toFixed(2), `${label} crypto ship=${ship}`);
      // a client that already sends the discounted total is honest too
      const disc = await priceCardCart({ amount: display.toFixed(2), items, shipMethod: ship ? "express" : "ground" }, { fetchImpl: catalogQuote() });
      assert.equal(disc.mismatch, false);
    }
  }
  const t = await priceCardCart({ amount: "158.00", items: [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }] }, { fetchImpl: catalogQuote() });
  assert.equal(t.amount, "150.10");
  assert.deepEqual(t.volumeDiscount, { pct: 5, merch: "158.00", discount: "7.90", merchAfter: "150.10" });
});

test("tampered cart is repriced upward to the catalog tier and flagged", async () => {
  const r = await priceCardCart({ amount: "5.00", shipMethod: "express", items: [{ sku: "g3-r-50mg", qty: 2, amount: "1.00" }] }, { fetchImpl: catalogQuote() });
  // 2x G3-R 50mg: pack tier round(300*89/99)=270 -> 540 merch, 15% -> 459.00, + 18.99
  assert.equal(r.amount, "477.99");
  assert.equal(r.mismatch, true);
  assert.equal(r.clientAmount, "5.00");
});

test("VOLUME_DISCOUNT_ENABLED / opts.volumeDiscount no longer switch the ladder: products-api decides", async () => {
  // infra 2026-09-29 honest-charge: was "flag off: behaviour unchanged"; the flag is ignored, the reply always carries the ladder.
  const r = await priceCardCart({ amount: "158.00", items: [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }] }, { fetchImpl: catalogQuote(), volumeDiscount: false });
  assert.equal(r.amount, "150.10");
  assert.deepEqual(r.volumeDiscount, { pct: 5, merch: "158.00", discount: "7.90", merchAfter: "150.10" });
  assert.deepEqual(r.discount, { pct: 5, source: "tier:100", amount: "7.90" });
});
