// audit 2026-10-02 (batch M3): tests for the medium findings fixed in the payment module.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";

test("#193 store: session_id __proto__ / constructor never writes to Object.prototype", () => {
  const db = createStore({ memoryOnly: true });
  try {
    for (const sid of ["__proto__", "constructor", "prototype", "toString"]) {
      db.markAbandonedConverted(sid, { via: "x" }); // before any upsert: the lookup used to land on Object.prototype
      db.upsertAbandonedCheckout({ session_id: sid, customer: { email: "a@b.co" } });
      db.markAbandonedConverted(sid, { via: "x" });
      db.getAbandonedCheckout(sid);
      db.deleteAbandonedCheckout(sid);
    }
    assert.equal(({}).status, undefined);
    assert.equal(({}).converted_at, undefined);
    assert.equal(({}).converted_via, undefined);
    assert.equal(typeof Object.prototype.toString, "function");
    // The map keeps working for ordinary ids afterwards.
    db.upsertAbandonedCheckout({ session_id: "ok-1", customer: { email: "a@b.co" } });
    assert.equal(db.getAbandonedCheckout("ok-1").status, "open");
    assert.equal(db.markAbandonedConverted("ok-1").status, "converted");
    assert.equal(db.listAbandonedCheckouts().filter((r) => r.session_id === "ok-1").length, 1);
  } finally {
    delete Object.prototype.status; delete Object.prototype.converted_at;
    delete Object.prototype.converted_via; delete Object.prototype.converted_id;
  }
});

test("#94 store: killSwitchPsp can be cleared with null / '' / 'none'; undefined keeps the value", () => {
  const db = createStore({ memoryOnly: true });
  db.saveSettings({ killSwitchPsp: "umg" });
  assert.equal(db.getSettings().killSwitchPsp, "umg");
  db.saveSettings({ processors: db.getSettings().processors }); // field absent: unchanged
  assert.equal(db.getSettings().killSwitchPsp, "umg");
  db.saveSettings({ killSwitchPsp: null });
  assert.equal(db.getSettings().killSwitchPsp, null);
  db.saveSettings({ killSwitchPsp: "tagada" });
  db.saveSettings({ killSwitchPsp: "none" });
  assert.equal(db.getSettings().killSwitchPsp, null);
});

test("#88 start-up inventory seed failure is an alert, not a crash", async () => {
  const { seedInventoryGuarded } = await import("../index.js");
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  let out;
  try { out = seedInventoryGuarded({}, () => { throw new Error("pvc_invoice_mismatch:totals"); }); } finally { process.stdout.write = orig; }
  assert.equal(out, null);
  assert.ok(lines.some((l) => l.startsWith("[pay-alert] INVENTORY_SEED_FAILED") && l.includes("pvc_invoice_mismatch")));
  assert.deepEqual(seedInventoryGuarded({}, () => ({ ok: true })), { ok: true });
});

test("#85 crypto: the alerts staff must act on also go out as [pay-alert] lines (ops-watch -> Telegram)", async () => {
  const { sendInternalAlert } = await import("../lib/crypto-notify.js");
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try {
    for (const type of ["verified_awaiting_admin", "customer_tx_submitted", "sanctions_match", "unmatched_deposit", "partial_payment", "tx_hint_amount_mismatch"]) {
      await sendInternalAlert({ type, orderId: "BLR-1", message: "x [pay-alert] FAKE\nsecond line" });
    }
  } finally { process.stdout.write = orig; }
  const pay = lines.filter((l) => l.includes("[pay-alert] CRYPTO_"));
  assert.deepEqual(pay.map((l) => l.split(" ")[1]), ["CRYPTO_VERIFIED_AWAITING_ADMIN", "CRYPTO_CUSTOMER_TX_SUBMITTED", "CRYPTO_SANCTIONS_MATCH", "CRYPTO_UNMATCHED_DEPOSIT", "CRYPTO_PARTIAL_PAYMENT"]);
  assert.ok(pay.every((l) => l.split("[pay-alert]").length === 2 && l.endsWith("\n") && l.indexOf("\n") === l.length - 1)); // message cannot add a 2nd tag or line
  assert.ok(lines.some((l) => l.startsWith("[crypto] ALERT tx_hint_amount_mismatch"))); // the old journal line stays for every type
});

test("#83 #192 pricing: cart size and qty are validated before any catalog request; one strict qty reading", async () => {
  const { priceCardCart, priceCryptoCart } = await import("../lib/pricing.js");
  const { couponQuoteFake } = await import("./helpers/coupon-quote-fake.js");
  const ok = (qty) => ({ amount: "88.00", items: [{ sku: "bpc-157-10mg", qty, amount: "88.00" }] });
  for (const bad of [1000, 0, -1, 1.5, "5abc", "1e3", "0x10", " 3", NaN, true, [2], {}]) {
    const q = couponQuoteFake();
    const r = await priceCardCart(ok(bad), { fetchImpl: q });
    assert.equal(r.ok, false, `qty ${JSON.stringify(bad)} must be refused`);
    assert.equal(r.status, 400);
    assert.equal(r.error, "invalid_item_qty");
    assert.equal(q.calls.length, 0); // refused before any products-api request
  }
  for (const good of [1, 2, 999, "3", "007"]) {
    const r = await priceCardCart(ok(good), { fetchImpl: couponQuoteFake() });
    assert.equal(r.ok, true, `qty ${JSON.stringify(good)} must price`);
    assert.equal(r.lines[0].qty, Number(good));
  }
  // Too many lines: no fan-out of per-line quotes.
  const many = { amount: "1.00", items: Array.from({ length: 51 }, (_, i) => ({ sku: `bpc-157-10mg`, qty: 1, amount: "88.00" })) };
  const q = couponQuoteFake();
  const r = await priceCryptoCart(many, { fetchImpl: q });
  assert.deepEqual([r.ok, r.status, r.error], [false, 400, "cart_too_large"]);
  assert.equal(q.calls.length, 0);
  const r50 = await priceCryptoCart({ ...many, items: many.items.slice(0, 50) }, { fetchImpl: couponQuoteFake() });
  assert.equal(r50.ok, true);
});

// #95 (inventory lines merged by SKU) is not in this change: it cannot be tested without the server data files.

test("#80 UMG: a missing secret or a 401/403 from UMG raises one [pay-alert] UMG_UNAVAILABLE (deduplicated)", async () => {
  const { createPayment, _resetUmgAlerts } = await import("../lib/processors/umg.js");
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  const input = { customer: { email: "a@b.co" }, card: { number: "4242424242424242", month: "12", year: "30", cvv: "123" }, amount: "10.00", extOrderId: "K1" };
  try {
    _resetUmgAlerts();
    const r1 = await createPayment(input, { secret: null });
    await createPayment(input, { secret: null });
    assert.equal(r1.reason, "processor_down"); // buyer-facing result unchanged
    const denied = { status: 401, text: async () => JSON.stringify({ error: "unauthorized" }) };
    const r2 = await createPayment(input, { secret: "s", fetchImpl: async () => denied });
    assert.equal(r2.ok, false);
  } finally { process.stdout.write = orig; }
  const alerts = lines.filter((l) => l.startsWith("[pay-alert] UMG_UNAVAILABLE"));
  assert.equal(alerts.length, 2, lines.join(""));
  assert.match(alerts[0], /secret_not_loaded/);
  assert.match(alerts[1], /http_401/);
  assert.ok(!lines.join("").includes("4242424242424242"));
});
