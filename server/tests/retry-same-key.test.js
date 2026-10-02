// audit 2026-10-02: a retry under the SAME idempotency key after a failed / unfinished attempt must carry the data of the
// request that finally pays (items, address, buyer, amount), not the first attempt's. Card (cascade.js), Cleffo
// (cleffo-checkout.js) and crypto (crypto-checkout.js). Harness for Cleffo mirrors cleffo-part4.test.js.
import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createStore } from "../lib/store.js";
import { createConsentLog } from "../lib/consent.js";
import { chargeCart } from "../lib/cascade.js";
import { bucketFor } from "../lib/routing.js";
import { sweepCleffo, resetCleffoAlertState } from "../lib/cleffo-checkout.js";
import { createCryptoCheckout } from "../lib/crypto-checkout.js";
import { createHandler } from "../index.js";

// ---------- card (cascade.js chargeCart) ----------

const OLD_ADDR = { first_name: "Ann", last_name: "Buyer", email: "ann@example.test", phone: "8881234567", address: "1 Typo Rd", city: "Austin", state: "TX", zip: "73301", country: "US" };
const NEW_ADDR = { ...OLD_ADDR, address: "1 Fixed Rd", zip: "73344" };
const ITEMS_X = [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 5, amount: "20.00" }];
const ITEMS_Y = [{ sku: "tb-500-5mg", name: "TB-500 5mg", qty: 1, amount: "20.00" }];
const pricingOf = (amount, lines = []) => ({ ok: true, amount, clientAmount: amount, mismatch: false, source: "test", subtotal: amount, shipping: "0.00", shipMethod: "", lines });

function cardStore() {
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  return store;
}
// answers[i] is the i-th UMG answer: "decline" | "approve" | "wait"
function umgSeq(answers) {
  const calls = [];
  const umg = { async createPayment(p) {
    const a = answers[calls.length] || "approve";
    calls.push({ amount: p.amount, email: p.customer?.email });
    const id = `U${calls.length}`;
    if (a === "decline") return { ok: false, processor: "umg", processorTxnId: id, processorStatus: "DECLINED", informationData: "Do not honor", informationCode: "05", cascadeAction: "stop", declineClass: "hard", reason: "hard_decline", raw: {} };
    if (a === "wait") return { ok: true, processor: "umg", processorTxnId: id, processorStatus: "PENDING", cascadeAction: "wait", raw: {} };
    return { ok: true, processor: "umg", processorTxnId: id, processorStatus: "APPROVED", cascadeAction: "success", descriptor: "TEST", raw: {} };
  } };
  return { calls, adapters: { umg, tagada: {}, centrobill: {} } };
}
const body = (over = {}) => ({ idempotencyKey: "K-CARD", amount: "100.00", customer: OLD_ADDR, items: ITEMS_X, notes: "first", session_id: "S1", card: { name: "A B", number: "4242424242424242", month: "12", year: "28", cvv: "123" }, ...over });

test("card: declined, retry under the same key with a FIXED address -> approved order carries the new address (2 attempts)", async () => {
  const store = cardStore();
  const u = umgSeq(["decline", "approve"]);
  const first = await chargeCart(body(), { store, adapters: u.adapters });
  assert.equal(first.order.status, "declined");
  const second = await chargeCart(body({ customer: NEW_ADDR, notes: "fixed" }), { store, adapters: u.adapters });
  assert.equal(second.ok, true);
  assert.equal(second.order.status, "approved");
  assert.equal(second.order.id, first.order.id);
  assert.equal(second.order.createdAt, first.order.createdAt);
  assert.equal(second.order.customer.address, "1 Fixed Rd");
  assert.equal(second.order.customer.zip, "73344");
  assert.equal(second.order.notes, "fixed");
  assert.equal(second.order.attempts.length, 2);
  assert.equal(store.listOrders().length, 1);
});

test("card: declined cart X (server price 100), retry under the same key with cart Y (server price 20) -> charged and stored as Y", async () => {
  const store = cardStore();
  const u = umgSeq(["decline", "approve"]);
  await chargeCart({ ...body(), pricing: pricingOf("100.00", [{ sku: "bpc-157-10mg", qty: 5 }]) }, { store, adapters: u.adapters });
  const r = await chargeCart({ ...body({ items: ITEMS_Y, amount: "20.00" }), pricing: pricingOf("20.00", [{ sku: "tb-500-5mg", qty: 1 }]) }, { store, adapters: u.adapters });
  assert.equal(r.order.status, "approved");
  assert.deepEqual(r.order.items.map((i) => i.sku), ["tb-500-5mg"]);
  assert.equal(r.order.amount, "20.00");
  assert.equal(r.order.priceCheck.serverAmount, "20.00");
  assert.deepEqual(r.order.priceCheck.lines, [{ sku: "tb-500-5mg", qty: 1 }]);
  assert.equal(u.calls[1].amount, "20.00"); // the card was charged the price of the cart that is stored
});

test("card: no server price (old mode) -> the retry amount comes from the new request, as at creation", async () => {
  const store = cardStore();
  const u = umgSeq(["decline", "approve"]);
  await chargeCart(body(), { store, adapters: u.adapters });
  const r = await chargeCart(body({ amount: "30.00", items: ITEMS_Y }), { store, adapters: u.adapters });
  assert.equal(r.order.amount, "30.00");
  assert.equal(u.calls[1].amount, "30.00");
});

test("card: approved order + retry under the same key with another address -> reused, the paid order is NOT changed", async () => {
  const store = cardStore();
  const u = umgSeq(["approve"]);
  const first = await chargeCart(body(), { store, adapters: u.adapters });
  const again = await chargeCart(body({ customer: NEW_ADDR, items: ITEMS_Y, notes: "other" }), { store, adapters: u.adapters });
  assert.equal(again.reused, true);
  assert.equal(again.order.customer.address, "1 Typo Rd");
  assert.deepEqual(again.order.items, first.order.items);
  assert.equal(again.order.notes, "first");
  assert.equal(u.calls.length, 1);
});

test("card: pending order + retry under the same key -> reused, not changed, no second charge", async () => {
  const store = cardStore();
  const u = umgSeq(["wait"]);
  const first = await chargeCart(body(), { store, adapters: u.adapters });
  assert.equal(first.order.status, "pending");
  const again = await chargeCart(body({ customer: NEW_ADDR, items: ITEMS_Y }), { store, adapters: u.adapters });
  assert.equal(again.reused, true);
  assert.equal(again.order.customer.address, "1 Typo Rd");
  assert.deepEqual(again.order.items.map((i) => i.sku), ["bpc-157-10mg"]);
  assert.equal(u.calls.length, 1);
});

// ---------- Cleffo (startCleffoAttempt) ----------

const CFG = { env: "sandbox", baseUrl: "https://apis-dev.cleffo.com", clientKey: "ck-test", signatureKey: "sig-test", apiKey: "api-test", baseUrlMismatch: false };
const CONSENT = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T15:40:00.000Z", pageVersion: "v-test" };
const ONLY = { cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 50, maxAttempts: 5, retryWindowMin: 120, cleffoOnly: true };
const priceOf = (amount) => (b) => ({ ok: true, amount, clientAmount: b.amount, mismatch: false, source: "test", subtotal: amount, shipping: "0.00", shipMethod: "", lines: [] });
const EMAIL = (() => { for (let i = 0; ; i += 1) { const e = `rsk-${i}@example.test`; if (bucketFor(e, 50) === "cleffo") return e; } })();

function captureLogs() {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    const s = String(chunk);
    if (s.startsWith("[")) { lines.push(...s.split("\n").filter(Boolean)); return true; }
    return orig(chunk, ...rest);
  };
  return { lines, stop: () => { process.stdout.write = orig; } };
}

function cleffoMock() {
  const state = { links: [], status: {}, amount: {} };
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      const ref = `REF${state.links.length + 1}api`;
      state.links.push({ ref, body: b });
      if (state.onPost) state.onPost(b, state.links.length); // audit 2026-10-02: lets a test change the order while the link request is in flight
      state.status[ref] = "pending";
      state.amount[ref] = String(b.data.price.total.toFixed(2));
      return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_link: `https://dev.cleffo.com/pay/api-checkout-session/${ref}`, transaction_reference_number: ref, merchant_order_id: b.data.merchant_order_id } }) };
    }
    const ref = url.split("/").slice(-2)[0];
    const link = state.links.find((l) => l.ref === ref);
    return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_status: state.status[ref], total_amount: state.amount[ref], currency: "usd", merchant_order_id: link?.body.data.merchant_order_id, transaction_reference_number: ref } }) };
  };
  return { state, fetchImpl };
}

async function setupCleffo() {
  process.env.PAYMENTS_ENABLED = "true";
  resetCleffoAlertState();
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [{ id: "umg", enabled: true, priority: 1, mode: "sandbox" }, { id: "tagada", enabled: false, priority: 2, mode: "off" }, { id: "centrobill", enabled: false, priority: 3, mode: "off" }] });
  const consentLog = createConsentLog({ filePath: join(mkdtempSync(join(tmpdir(), "rsk-consent-")), "consent-log.jsonl") });
  const cl = cleffoMock();
  const cfg = { pricer: priceOf("20.00") };
  const cleffoDeps = { config: CFG, fetchImpl: cl.fetchImpl };
  const handler = createHandler({
    store, consentLog, publicUrl: "https://crm.test", routingConfig: () => ONLY, cleffoDeps,
    cardPricer: (b) => cfg.pricer(b),
    forwardFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }),
    adapters: { umg: { async createPayment() { throw new Error("UMG must not be called"); } }, tagada: {}, centrobill: {} },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  // the buyer of these tests always uses EMAIL; address overrides go through customerWith()
  const customerWith = (over) => ({ ...OLD_ADDR, email: EMAIL, ...over });
  const charge = async (key, extra = {}) => {
    const r = await fetch(`${base}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      idempotencyKey: key, session_id: `S-${key}`, customer: customerWith({}), amount: "20.00",
      items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 1, amount: "20.00" }], notes: "n1", consent: CONSENT, ...extra }) });
    return { status: r.status, body: await r.json() };
  };
  const sweep = () => sweepCleffo(store, { cleffoDeps, onPaid: handler.onCleffoPaid });
  const liveLinks = (orderId) => store.getOrder(orderId).attempts.filter((a) => a.processor === "cleffo" && a.processorStatus === "LINK_CREATED" && !a.abandoned);
  return { store, server, cl, cfg, charge, customerWith, sweep, liveLinks };
}

test("cleffo: the old link is paid while the new link request is in flight -> order stays approved, answer is the reused one, the new attempt is abandoned", async () => {
  const t = await setupCleffo();
  try {
    const r1 = await t.charge("K-C9");
    assert.equal(r1.status, 200);
    const id = r1.body.orderId;
    t.cl.state.onPost = (_b, n) => {
      if (n !== 2) return;
      const o = t.store.getOrder(id);
      o.status = "approved"; o.winningProcessor = "cleffo"; // callback / sweeper booked the payment of link 1 meanwhile
      t.store.upsertOrder(o);
    };
    const r2 = await t.charge("K-C9", { customer: t.customerWith({ address: "1 Fixed Rd", zip: "73344" }) });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.reused, true);
    assert.equal(r2.body.charged, false);
    assert.equal(r2.body.redirectUrl, undefined, "the new link is not offered");
    assert.equal(r2.body.orderId, id);
    const o = t.store.getOrder(id);
    assert.equal(o.status, "approved");
    assert.equal(o.attempts.length, 2);
    assert.equal(o.attempts[1].abandoned, true);
    const rr = o.routing.attempts.find((x) => x.n === o.attempts[1].routingAttempt);
    assert.equal(rr.outcome, "abandoned");
    assert.equal(rr.retryBasis, "order_settled_meanwhile");
  } finally { t.server.close(); }
});

test("cleffo: open link + same key + FIXED address -> order holds the new address, one live link (the new one carries it), the old one is marked abandoned", async () => {
  const t = await setupCleffo();
  const logs = captureLogs();
  try {
    const r1 = await t.charge("K-C1", { customer: t.customerWith({}) });
    assert.equal(r1.status, 200);
    const r2 = await t.charge("K-C1", { customer: t.customerWith({ address: "1 Fixed Rd", zip: "73344" }) });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.notEqual(r2.body.redirectUrl, r1.body.redirectUrl);
    assert.equal(r2.body.orderId, r1.body.orderId);
    const o = t.store.getOrder(r1.body.orderId);
    assert.equal(o.customer.address, "1 Fixed Rd");
    assert.equal(o.customer.zip, "73344");
    assert.equal(t.cl.state.links.length, 2);
    assert.equal(t.cl.state.links[1].body.data.customer_detail.shipping_address.address_line_1, "1 Fixed Rd");
    assert.equal(t.liveLinks(o.id).length, 1);
    assert.equal(t.liveLinks(o.id)[0].paymentLink, r2.body.redirectUrl);
    assert.equal(o.attempts[0].abandoned, true);
    // a payment that still arrives on the replaced link pays THIS order (new address) and is flagged as a late payment
    t.cl.state.status.REF1api = "completed";
    await t.sweep();
    const paid = t.store.getOrder(o.id);
    assert.equal(paid.status, "approved");
    assert.equal(paid.customer.address, "1 Fixed Rd");
    assert.ok(logs.lines.some((l) => l.startsWith("[pay-alert] CLEFFO_LATE_PAID")));
  } finally { logs.stop(); t.server.close(); }
});

test("cleffo: open link + same key + a DIFFERENT CART -> 409 cart_changed, order and link untouched", async () => {
  const t = await setupCleffo();
  try {
    const r1 = await t.charge("K-C2", { customer: t.customerWith({}) });
    const before = t.store.getOrder(r1.body.orderId);
    t.cfg.pricer = priceOf("20.00"); // same total on purpose: the paid-amount check cannot tell the carts apart
    const r2 = await t.charge("K-C2", { customer: t.customerWith({}), items: [{ sku: "tb-500-5mg", name: "TB-500 5mg", qty: 1, amount: "20.00" }] });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, "cart_changed");
    assert.equal(r2.body.charged, false);
    assert.equal(t.cl.state.links.length, 1);
    const after = t.store.getOrder(r1.body.orderId);
    assert.deepEqual(after.items, before.items);
    assert.equal(after.attempts.length, 1);
  } finally { t.server.close(); }
});

test("cleffo: open link + same key + same items but the server total changed -> new link at the new total, the old link can only go to review", async () => {
  const t = await setupCleffo();
  try {
    const r1 = await t.charge("K-C3", { customer: t.customerWith({}) });
    t.cfg.pricer = priceOf("35.00");
    const r2 = await t.charge("K-C3", { customer: t.customerWith({}) });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.notEqual(r2.body.redirectUrl, r1.body.redirectUrl);
    const o = t.store.getOrder(r1.body.orderId);
    assert.equal(o.amount, "35.00");
    assert.equal(t.cl.state.links[1].body.data.price.total, 35);
    t.cl.state.status.REF1api = "completed"; // the old 20.00 link is paid
    await t.sweep();
    assert.equal(t.store.getOrder(o.id).status, "review"); // never approved: 20.00 is not what the order holds now
  } finally { t.server.close(); }
});

test("cleffo: nothing changed -> the same link again (as before)", async () => {
  const t = await setupCleffo();
  try {
    const r1 = await t.charge("K-C4", { customer: t.customerWith({}) });
    const r2 = await t.charge("K-C4", { customer: t.customerWith({}) });
    assert.equal(r2.body.reused, true);
    assert.equal(r2.body.redirectUrl, r1.body.redirectUrl);
    assert.equal(t.cl.state.links.length, 1);
  } finally { t.server.close(); }
});

test("cleffo: only the order note changed -> the same link, the note on the order is the new one", async () => {
  const t = await setupCleffo();
  try {
    const r1 = await t.charge("K-C5", { customer: t.customerWith({}), notes: "leave at door" });
    const r2 = await t.charge("K-C5", { customer: t.customerWith({}), notes: "call me first" });
    assert.equal(r2.body.reused, true);
    assert.equal(r2.body.redirectUrl, r1.body.redirectUrl);
    assert.equal(t.store.getOrder(r1.body.orderId).notes, "call me first");
    assert.equal(t.cl.state.links.length, 1);
  } finally { t.server.close(); }
});

test("cleffo: the link died (expired) + same key + another cart -> the order is rewritten to the new cart and gets a new link", async () => {
  const t = await setupCleffo();
  try {
    const r1 = await t.charge("K-C6", { customer: t.customerWith({}) });
    t.cl.state.status.REF1api = "expired";
    t.cfg.pricer = priceOf("45.00");
    const r2 = await t.charge("K-C6", { customer: t.customerWith({ address: "9 New St" }), items: [{ sku: "tb-500-5mg", name: "TB-500 5mg", qty: 2, amount: "22.50" }] });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    const o = t.store.getOrder(r1.body.orderId);
    assert.deepEqual(o.items.map((i) => i.sku), ["tb-500-5mg"]);
    assert.equal(o.amount, "45.00");
    assert.equal(o.customer.address, "9 New St");
    assert.equal(t.cl.state.links.length, 2);
  } finally { t.server.close(); }
});

test("cleffo: a link Cleffo marked failed a minute ago could still be paid late -> another cart under the same key is 409", async () => {
  const t = await setupCleffo();
  try {
    await t.charge("K-C7", { customer: t.customerWith({}) });
    t.cl.state.status.REF1api = "failed";
    await t.sweep();
    const r2 = await t.charge("K-C7", { customer: t.customerWith({}), items: [{ sku: "tb-500-5mg", name: "TB-500 5mg", qty: 1, amount: "20.00" }] });
    assert.equal(r2.status, 409);
    assert.equal(r2.body.error, "cart_changed");
    // the same cart with a fixed address is fine: the late payment would still pay the right goods
    const r3 = await t.charge("K-C7", { customer: t.customerWith({ address: "2 Fixed Rd" }) });
    assert.equal(r3.status, 200, JSON.stringify(r3.body));
  } finally { t.server.close(); }
});

test("cleffo: approved order + same key + another address -> reused, the paid order is not changed", async () => {
  const t = await setupCleffo();
  try {
    const r1 = await t.charge("K-C8", { customer: t.customerWith({}) });
    t.cl.state.status.REF1api = "completed";
    await t.sweep();
    const r2 = await t.charge("K-C8", { customer: t.customerWith({ address: "7 Other St" }), consent: undefined });
    assert.equal(r2.body.reused, true);
    assert.equal(t.store.getOrder(r1.body.orderId).customer.address, "1 Typo Rd");
    assert.equal(t.cl.state.links.length, 1);
  } finally { t.server.close(); }
});

// ---------- crypto (createCryptoCheckout) ----------

const ERC = "0x55C758a84BCC999C5386E5047A064E0364915DE9";
const TRC = "TXfrivx3QHrYDwPcaj3ojEDQFvAzX8EdKv";
const CRYPTO_ENV = { CRYPTO_USDT_ERC: ERC, CRYPTO_USDT_TRC: TRC, CRYPTO_ACCEPTED_TOKENS: "USDT,USDC", CRM_PUBLIC_URL: "https://crm.biolabsresearch.co" };
const cryptoIn = (over = {}) => ({ idempotencyKey: "K-CRYPTO", amount: "158.00", network: "trc20", customer: OLD_ADDR, items: [{ sku: "qa-sku", name: "QA", qty: 1, amount: "158.00" }], notes: "first", ...over });
const SECRET = "s".repeat(48);

test("crypto: same key + fixed address -> the order keeps its amount / wallet / ref but holds the new address", () => {
  const store = createStore({ memoryOnly: true });
  const d = { store, env: CRYPTO_ENV, confirmSecret: SECRET };
  const a = createCryptoCheckout(cryptoIn(), d);
  assert.equal(a.ok, true, a.error);
  const b = createCryptoCheckout(cryptoIn({ customer: NEW_ADDR, notes: "fixed" }), d);
  assert.equal(b.reused, true);
  assert.equal(b.order.customer.address, "1 Fixed Rd");
  assert.equal(b.order.notes, "fixed");
  assert.equal(b.order.amountDue, a.order.amountDue);
  assert.equal(b.order.orderRef, a.order.orderRef);
  assert.equal(b.public.wallet, a.public.wallet);
  assert.equal(b.public.confirmToken, a.public.confirmToken);
  assert.equal(store.listOrders().length, 1);
});

test("crypto: same key + another cart or another e-mail -> nothing on the order changes (page rotates the key for those)", () => {
  const store = createStore({ memoryOnly: true });
  const d = { store, env: CRYPTO_ENV, confirmSecret: SECRET };
  const a = createCryptoCheckout(cryptoIn(), d);
  const b = createCryptoCheckout(cryptoIn({ items: [{ sku: "other", name: "O", qty: 1, amount: "158.00" }], customer: NEW_ADDR }), d);
  assert.equal(b.reused, true);
  assert.equal(b.order.customer.address, "1 Typo Rd");
  const c = createCryptoCheckout(cryptoIn({ customer: { ...NEW_ADDR, email: "someone@else.test" } }), d);
  assert.equal(c.order.customer.email, "ann@example.test");
  assert.equal(c.order.customer.address, "1 Typo Rd");
  assert.deepEqual(store.getOrder(a.order.id).items.map((i) => i.sku), ["qa-sku"]);
});

test("crypto: a paid / reviewed order is never rewritten by a replay", () => {
  const store = createStore({ memoryOnly: true });
  const d = { store, env: CRYPTO_ENV, confirmSecret: SECRET };
  const a = createCryptoCheckout(cryptoIn(), d);
  const o = store.getOrder(a.order.id);
  o.status = "crypto_paid";
  store.upsertOrder(o);
  const b = createCryptoCheckout(cryptoIn({ customer: NEW_ADDR }), d);
  assert.equal(b.order.customer.address, "1 Typo Rd");
});
