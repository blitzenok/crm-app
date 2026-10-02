// audit 2026-10-02, batch LF2-module-rest: tests for modules that had none (catalog-guard, cio-orders, no-descriptor, internal-crypto)
// and for behaviour the audit called broken that already is fixed (consent IP). Invented data; the Customer.io calls are fakes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findUnavailableItems, itemUnavailableBody, ITEM_UNAVAILABLE_MESSAGE } from "../lib/catalog-guard.js";
import { CIO_IDS, buildTrigger, cioConfig, cioSend, createCioOrderNotifier, internalAllowed } from "../lib/cio-orders.js";
import { publicChargeBody } from "../lib/no-descriptor.js";
import { internalKeyCheck, isLocalRequest, normalizeEmail, pendingCryptoForEmail } from "../lib/internal-crypto.js";
import { recordCheckoutConsent } from "../lib/consent.js";
import { createStore } from "../lib/store.js";

// ---- catalog-guard ------------------------------------------------------------------------------------------------------------
function catalogFile(products, name = "catalog.json") {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(products));
  return p;
}
const CATALOG = [
  { slug: "alpha-test", name: "Alpha Test", is_active: true, hidden_strengths: ["10 MG"] },
  { slug: "beta-test", name: "Beta Test", is_active: false },
  { slug: "gamma-test", name: "Gamma Test" },
];

test("catalog-guard: hidden strength is refused by sku, by name, and regardless of case and spaces", () => {
  const catalogPath = catalogFile(CATALOG);
  const bySku = findUnavailableItems([{ sku: "alpha-test-10mg", name: "x" }], { catalogPath });
  assert.equal(bySku.ok, false);
  assert.deepEqual(bySku.items.map((i) => [i.slug, i.mg, i.reason]), [["alpha-test", "10mg", "strength_hidden"]]);
  const byName = findUnavailableItems([{ name: "Alpha Test 10mg" }], { catalogPath });
  assert.equal(byName.ok, false);
  assert.equal(byName.items[0].reason, "strength_hidden");
  const upper = findUnavailableItems([{ sku: "ALPHA-TEST-10MG" }], { catalogPath });
  assert.equal(upper.ok, false);
  assert.equal(findUnavailableItems([{ sku: "alpha-test-5mg" }], { catalogPath }).ok, true, "another strength of the same product stays sellable");
});

test("catalog-guard: inactive product refused; unknown lines and active products pass; empty cart passes", () => {
  const catalogPath = catalogFile(CATALOG);
  assert.equal(findUnavailableItems([{ sku: "beta-test-5mg" }], { catalogPath }).items[0].reason, "product_inactive");
  assert.deepEqual(findUnavailableItems([{ sku: "gamma-test-5mg" }, { sku: "free-gift" }, null, "junk"], { catalogPath }), { ok: true, items: [] });
  assert.deepEqual(findUnavailableItems([], { catalogPath }), { ok: true, items: [] });
});

test("catalog-guard: missing or broken catalog does not block (server pricing refuses hidden lines too) and logs; a changed file is re-read", () => {
  const dir = mkdtempSync(join(tmpdir(), "cat-"));
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => { lines.push(String(c)); return true; };
  try {
    assert.equal(findUnavailableItems([{ sku: "alpha-test-10mg" }], { catalogPath: join(dir, "nope.json") }).skipped, true);
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    assert.equal(findUnavailableItems([{ sku: "alpha-test-10mg" }], { catalogPath: broken }).skipped, true);
    const notArray = join(dir, "obj.json");
    writeFileSync(notArray, "{}");
    assert.equal(findUnavailableItems([{ sku: "alpha-test-10mg" }], { catalogPath: notArray }).skipped, true);
  } finally { process.stdout.write = orig; }
  assert.equal(lines.filter((l) => l.startsWith("[catalog-guard] catalog unreadable")).length, 3);
  const p = join(dir, "live.json");
  writeFileSync(p, JSON.stringify([{ slug: "alpha-test", name: "Alpha Test" }]));
  assert.equal(findUnavailableItems([{ sku: "alpha-test-10mg" }], { catalogPath: p }).ok, true);
  writeFileSync(p, JSON.stringify([{ slug: "alpha-test", name: "Alpha Test", hidden_strengths: ["10mg"] }]));
  const later = new Date(Date.now() + 5000);
  utimesSync(p, later, later);
  assert.equal(findUnavailableItems([{ sku: "alpha-test-10mg" }], { catalogPath: p }).ok, false, "mtime changed -> catalog re-read");
});

test("catalog-guard: 409 body says nothing was charged", () => {
  const body = itemUnavailableBody([{ sku: "x" }]);
  assert.deepEqual([body.ok, body.error, body.charged, body.message], [false, "item_unavailable", false, ITEM_UNAVAILABLE_MESSAGE]);
});

// ---- no-descriptor (white list of the order in the charge answer) --------------------------------------------------------------------
test("no-descriptor: only id, status, amount, currency of the order reach the browser; other body fields stay", () => {
  const body = publicChargeBody({ ok: true, chargedAmount: "10.00", order: { id: "BLR-1", status: "approved", amount: "10.00", currency: "USD", descriptor: "SHOP", idempotencyKey: "k", attempts: [{ processorTxnId: "t" }], customer: { email: "a@b.test" } } });
  assert.deepEqual(body.order, { id: "BLR-1", status: "approved", amount: "10.00", currency: "USD" });
  assert.equal(body.chargedAmount, "10.00");
  assert.deepEqual(publicChargeBody({ ok: false }), { ok: false });
  assert.equal(publicChargeBody(null), null);
});

// ---- internal-crypto ------------------------------------------------------------------------------------------------------------------
test("internal-crypto: local-only check, key check (timing-safe, 503 when unset or short), e-mail normalisation", () => {
  const local = (headers = {}, addr = "127.0.0.1") => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(isLocalRequest(local()), true);
  assert.equal(isLocalRequest(local({}, "::1")), true);
  assert.equal(isLocalRequest(local({}, "203.0.113.5")), false);
  assert.equal(isLocalRequest(local({ "x-forwarded-for": "203.0.113.5" })), false, "a request nginx passed on is not internal");
  assert.equal(isLocalRequest(local({ "x-real-ip": "203.0.113.5" })), false);
  const key = "k".repeat(40);
  assert.deepEqual(internalKeyCheck({ headers: { "x-internal-key": key } }, { CRM_INTERNAL_KEY: "short" }), { ok: false, status: 503, error: "internal_api_not_configured" });
  assert.deepEqual(internalKeyCheck({ headers: {} }, { CRM_INTERNAL_KEY: key }), { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(internalKeyCheck({ headers: { "x-internal-key": "w".repeat(40) } }, { CRM_INTERNAL_KEY: key }), { ok: false, status: 401, error: "unauthorized" });
  assert.deepEqual(internalKeyCheck({ headers: { "x-internal-key": key } }, { CRM_INTERNAL_KEY: key }), { ok: true });
  assert.equal(normalizeEmail("  Ada@Example.TEST "), "ada@example.test");
  assert.equal(normalizeEmail("not an email"), null);
  assert.equal(normalizeEmail(`${"a".repeat(255)}@example.test`), null);
  assert.deepEqual(pendingCryptoForEmail([], "a@b.test", { env: {}, secret: "s" }), { items: [] });
  assert.deepEqual(pendingCryptoForEmail([{ paymentMethod: "card" }, { paymentMethod: "crypto" }, null], "a@b.test", { env: {}, secret: "s" }), { items: [] }, "no crypto payment block / no ref = not listed");
});

// ---- cio-orders ------------------------------------------------------------------------------------------------------------------------
const order = (over = {}) => ({
  id: "BLR-7001", orderRef: "BLR-7001", createdAt: new Date(Date.now() + 5000).toISOString(), status: "approved", paymentMethod: "card", amount: "20.00",
  customer: { first_name: "Ada", last_name: "Test", email: "ada@example.test", address: "1 Test St", city: "Austin", state: "TX", zip: "78701", country: "US" },
  items: [{ sku: "qa-10mg", name: "QA 10mg", qty: 1, amount: "20.00" }], ...over,
});

test("cio-orders: config flags default off, internal recipients are limited to the company domain", () => {
  const c = cioConfig({});
  assert.deepEqual([c.internal, c.customer, c.since], [false, false, null]);
  assert.equal(cioConfig({ CIO_ORDER_EMAILS_SINCE: "2026-10-01T00:00:00Z", CIO_ORDER_EMAILS_CUSTOMER: "ON" }).customer, true);
  assert.equal(internalAllowed("admin@biolabsresearch.co"), true);
  assert.equal(internalAllowed("someone@example.test"), false);
  assert.equal(internalAllowed("not-an-address"), false);
});

test("cio-orders: cioSend refuses without key / recipient, sends the transactional body, reports failures and timeouts", async () => {
  assert.equal((await cioSend({ key: "" }, { messageId: 2, to: "a@b.test", data: {} })).status, "no_api_key");
  assert.equal((await cioSend({ key: "k" }, { messageId: 2, to: "nope", data: {} })).status, "no_recipient");
  let seen = null;
  const okFetch = async (url, init) => { seen = { url, init }; return { ok: true, status: 200, json: async () => ({ delivery_id: "d1", queued_at: 1 }) }; };
  const r = await cioSend({ key: "secret-test-key", url: "https://cio.test/send", from: "Shop <s@example.test>" }, { messageId: 2, to: "a@b.test", data: { ref: "BLR-1" }, fetchImpl: okFetch });
  assert.deepEqual([r.ok, r.status, r.deliveryId], [true, "sent", "d1"]);
  const sent = JSON.parse(seen.init.body);
  assert.deepEqual([sent.transactional_message_id, sent.to, sent.identifiers, sent.message_data], [2, "a@b.test", { email: "a@b.test" }, { ref: "BLR-1" }]);
  assert.equal(seen.init.headers.Authorization, "Bearer secret-test-key");
  const failFetch = async () => ({ ok: false, status: 400, statusText: "Bad", json: async () => ({ meta: { error: "bad template" } }) });
  const f = await cioSend({ key: "k", url: "u" }, { messageId: 2, to: "a@b.test", data: {}, fetchImpl: failFetch });
  assert.deepEqual([f.ok, f.status, f.httpStatus, f.error], [false, "failed", 400, "bad template"]);
  const hang = (url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("x"), { name: "AbortError" }))));
  const t = await cioSend({ key: "k", url: "u" }, { messageId: 2, to: "a@b.test", data: {}, fetchImpl: hang, timeoutMs: 30 });
  assert.deepEqual([t.ok, t.error], [false, "timeout"]);
});

test("cio-orders: buildTrigger carries what the template needs; paid card order says paid", () => {
  const t = buildTrigger(order(), {});
  assert.equal(t.ref, "BLR-7001");
  assert.equal(t.payment_state, "paid");
  assert.equal(t.paid_via, "card");
  assert.equal(t.customer_email, "ada@example.test");
  assert.equal(t.items.length, 1);
  assert.match(t.shipping_address, /1 Test St, Austin, TX 78701, US/);
});

test("cio-orders: notifier sends the manager message once per order, records the customer message as skipped while the customer flag is off", async () => {
  const store = createStore({ memoryOnly: true });
  store.upsertOrder(order());
  store.upsertOrder(order({ id: "BLR-7002", orderRef: "BLR-7002", test: true })); // test order: never
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ delivery_id: "d" }) }; };
  const logs = [];
  const n = createCioOrderNotifier({ db: store, cfg: { key: "k", url: "u", from: "f", internal: true, customer: false, managerTo: ["admin@biolabsresearch.co", "outsider@example.test"], since: Date.now() - 1000 }, fetchImpl, logger: (m) => logs.push(m) });
  await n.processDue();
  assert.equal(calls.length, 1, "one allowed manager recipient, test order skipped");
  assert.deepEqual([calls[0].transactional_message_id, calls[0].to], [CIO_IDS.manager, "admin@biolabsresearch.co"]);
  const o = store.getOrder("BLR-7001");
  assert.equal(o.cio.manager.status, "sent");
  assert.equal(o.cio.customer.status, "skipped_customer_off");
  assert.equal(store.getOrder("BLR-7002").cio, undefined);
  await n.processDue();
  assert.equal(calls.length, 1, "a repeat pass sends nothing again");
  assert.ok(!logs.join("\n").includes("ada@example.test"), "the customer address is masked in the log");
});

// ---- consent: client-controlled X-Forwarded-For never becomes the recorded ip (#674 #819, already fixed) -----------------------------------
test("consent: the recorded ip is X-Real-IP (set by nginx); a client-sent X-Forwarded-For is not stored as ip", () => {
  const log = { now: () => new Date("2026-10-02T10:00:00Z"), append: (rec) => ({ ...rec, hash: "h" }) };
  const req = { headers: { "x-forwarded-for": "198.51.100.9, 10.0.0.1", "x-real-ip": "203.0.113.7", "user-agent": "UA" }, socket: { remoteAddress: "127.0.0.1" } };
  const r = recordCheckoutConsent({ log, req, body: {}, order: { id: "BLR-1", customer: { email: "a@b.test" }, amount: "1.00" }, channel: "card" });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.record.ip, "203.0.113.7");
  assert.ok(!JSON.stringify(r.record).includes("198.51.100.9"));
});
