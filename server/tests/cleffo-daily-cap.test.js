// Daily Cleffo cap (CLEFFO_DAILY_CAP_USD): PAID Cleffo total of the Asia/Jerusalem day + open links of the last 30 min
// + this order's total over the cap -> UMG, reason "cap". docs/CLEFFO_DAILY_CAP.md. Harness mirrors cleffo-part4.test.js.
import { test, beforeEach } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createStore } from "../lib/store.js";
import { createConsentLog } from "../lib/consent.js";
import { capDayKey, capDecision, cleffoDailyUsage, resetCapMemo, routingConfig } from "../lib/routing.js";
import { nextStepFor, resetCleffoAlertState } from "../lib/cleffo-checkout.js";
import { createHandler } from "../index.js";

const CFG = { env: "sandbox", baseUrl: "https://apis-dev.cleffo.com", clientKey: "ck-test", signatureKey: "sig-test", apiKey: "api-test", baseUrlMismatch: false };
const CONSENT = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T15:40:00.000Z", pageVersion: "v-test" };
const CARD = { name: "Q A", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
// Production shape: Cleffo first for everyone (split 100), cap $2,000.
const CAP = { cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 100, maxAttempts: 3, retryWindowMin: 120, cleffoOnly: false, linkTtlMin: 60, sweepHours: 72, dailyCapUsd: 2000, capPendingMin: 30, capTz: "Asia/Jerusalem" };
const priceOf = (amount) => (b) => ({ ok: true, amount, clientAmount: b.amount, mismatch: false, source: "test", subtotal: amount, shipping: "0.00", shipMethod: "", lines: [] });

beforeEach(() => resetCapMemo());

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

let seq = 0;
/** A Cleffo order of another buyer: status PAID (paid at `at`) or an open link created at `at`. */
function seedCleffo(store, { amount, at, status = "PAID", key } = {}) {
  seq += 1;
  const id = `BLR-9${String(seq).padStart(3, "0")}`;
  const paid = status === "PAID";
  store.upsertOrder({
    id, idempotencyKey: key || `seed-${seq}`, createdAt: at, updatedAt: at, status: paid ? "approved" : "awaiting_payment", amount, currency: "USD",
    customer: { email: `seed-${seq}@example.test` }, items: [], session_id: `seed-s-${seq}`,
    attempts: [{ attemptId: `cleffo-${at}`, processor: "cleffo", routingAttempt: 1, startedAt: at, amount, currency: "USD", processorStatus: paid ? "PAID" : status, ...(paid ? { finishedAt: at } : {}) }],
    routing: { attempts: [{ n: 1, processor: "cleffo", reason: "bucket", at, ...(paid ? { outcome: "paid", retryClass: "none" } : {}) }] },
  });
  return id;
}

function memStore() {
  return createStore({ memoryOnly: true });
}

const NOW = Date.parse("2026-09-29T15:00:00.000Z"); // 18:00 IDT
const iso = (ms) => new Date(ms).toISOString();

// ---------- config ----------

test("routingConfig: CLEFFO_DAILY_CAP_USD parsed (empty/0/garbage = no cap), pending window = link lifetime (60), tz Asia/Jerusalem", () => {
  assert.equal(routingConfig({}).dailyCapUsd, 0);
  assert.equal(routingConfig({ CLEFFO_DAILY_CAP_USD: "" }).dailyCapUsd, 0);
  assert.equal(routingConfig({ CLEFFO_DAILY_CAP_USD: "abc" }).dailyCapUsd, 0);
  assert.equal(routingConfig({ CLEFFO_DAILY_CAP_USD: "-5" }).dailyCapUsd, 0);
  const c = routingConfig({ CLEFFO_DAILY_CAP_USD: "2000" });
  assert.equal(c.dailyCapUsd, 2000);
  assert.equal(c.capPendingMin, 60); // round 6: defaults to CLEFFO_LINK_TTL_MIN
  assert.equal(c.capTz, "Asia/Jerusalem");
  assert.equal(routingConfig({ CLEFFO_CAP_PENDING_MIN: "0", CLEFFO_CAP_TZ: "Not/AZone" }).capPendingMin, 0);
  assert.equal(routingConfig({ CLEFFO_CAP_TZ: "Not/AZone" }).capTz, "Asia/Jerusalem");
});

// ---------- usage ----------

test("usage: PAID today (Jerusalem day) counted; PAID yesterday not; day boundary is Jerusalem midnight, not UTC", () => {
  const store = memStore();
  // 2026-09-29 00:30 IDT = 2026-09-28T21:30Z (UTC still the 28th) -> today in Jerusalem
  seedCleffo(store, { amount: "300.00", at: "2026-09-28T21:30:00.000Z" });
  // 2026-09-28 23:50 IDT = 2026-09-28T20:50Z -> yesterday in Jerusalem
  seedCleffo(store, { amount: "999.00", at: "2026-09-28T20:50:00.000Z" });
  seedCleffo(store, { amount: "150.50", at: iso(NOW - 3600000) });
  const u = cleffoDailyUsage(store, { now: NOW, tz: "Asia/Jerusalem", pendingMin: 30 });
  assert.equal(u.day, "2026-09-29");
  assert.equal(u.paidUsd, 450.5);
  assert.equal(u.paidCount, 2);
  assert.equal(u.pendingUsd, 0);
  assert.equal(capDayKey(Date.parse("2026-09-28T21:30:00.000Z")), "2026-09-29");
  assert.equal(capDayKey(Date.parse("2026-09-28T20:50:00.000Z")), "2026-09-28");
});

test("usage: open links created in the last 30 min count, older / abandoned / declined / own-key ones do not", () => {
  const store = memStore();
  seedCleffo(store, { amount: "100.00", at: iso(NOW - 10 * 60000), status: "LINK_CREATED" });
  seedCleffo(store, { amount: "40.00", at: iso(NOW - 5 * 60000), status: "LINK_UNKNOWN" });
  seedCleffo(store, { amount: "500.00", at: iso(NOW - 45 * 60000), status: "LINK_CREATED" });
  seedCleffo(store, { amount: "700.00", at: iso(NOW - 5 * 60000), status: "DECLINED" });
  seedCleffo(store, { amount: "800.00", at: iso(NOW - 5 * 60000), status: "LINK_CREATED", key: "mine" });
  const u = cleffoDailyUsage(store, { now: NOW, pendingMin: 30, excludeKey: "mine" });
  assert.equal(u.pendingUsd, 140);
  assert.equal(u.pendingCount, 2);
  assert.equal(u.paidUsd, 0);
  assert.equal(cleffoDailyUsage(store, { now: NOW, pendingMin: 30 }).pendingUsd, 940); // own key counted when not excluded
});

// ---------- decision ----------

test("capDecision: under the cap stays Cleffo; sum + order > cap -> umg reason cap (logged); exactly at the cap still Cleffo", () => {
  const store = memStore();
  seedCleffo(store, { amount: "1900.00", at: iso(NOW - 3600000) });
  const r = { processor: "cleffo", attempt: 1, reason: "bucket", bucket: "cleffo" };
  const lines = [];
  const w = (s) => lines.push(s);
  assert.equal(capDecision(r, { store, config: CAP, amount: "100.00", email: "a@x.test", now: NOW, write: w }).route.processor, "cleffo"); // 2000 = cap
  const d = capDecision(r, { store, config: CAP, amount: "100.01", email: "b@x.test", now: NOW, write: w });
  assert.equal(d.capped, true);
  assert.equal(d.route.processor, "umg");
  assert.equal(d.route.reason, "cap");
  assert.equal(d.route.cappedFrom, "bucket");
  assert.match(lines.join(""), /\[routing\] cap: cleffo day=2026-09-29 paid=1900\.00 pending=0\.00 order=100\.01 cap=2000\.00 was=bucket -> umg reason=cap/);
  assert.doesNotMatch(lines.join(""), /@/); // no email in the log
});

test("capDecision: simulated day total >= $2,000 -> every new Cleffo attempt goes to UMG", () => {
  const store = memStore();
  seedCleffo(store, { amount: "1500.00", at: iso(NOW - 2 * 3600000) });
  seedCleffo(store, { amount: "500.00", at: iso(NOW - 3600000) });
  for (const [reason, amount] of [["bucket", "0.01"], ["bucket", "0"], ["retry_switch_soft", "25.00"]]) {
    const d = capDecision({ processor: "cleffo", attempt: 1, reason }, { store, config: CAP, amount, email: `z-${reason}-${amount}@x.test`, now: NOW, write: () => {} });
    assert.equal(d.route.processor, "umg", `${reason} ${amount}`);
    assert.equal(d.route.reason, "cap");
  }
});

test("capDecision: pending links of the last 30 min push over the cap (no overshoot)", () => {
  const store = memStore();
  seedCleffo(store, { amount: "1200.00", at: iso(NOW - 3600000) });
  seedCleffo(store, { amount: "700.00", at: iso(NOW - 5 * 60000), status: "LINK_CREATED" });
  const d = capDecision({ processor: "cleffo", attempt: 1, reason: "bucket" }, { store, config: CAP, amount: "150.00", email: "p@x.test", now: NOW, write: () => {} });
  assert.equal(d.route.reason, "cap");
  assert.equal(d.usage.pendingUsd, 700);
});

test("capDecision: never touches UMG routes, retries of an existing Cleffo payment, cap off, Cleffo off or Cleffo-only", () => {
  const store = memStore();
  seedCleffo(store, { amount: "5000.00", at: iso(NOW - 3600000) });
  const w = () => {};
  const opts = { store, amount: "10.00", email: "q@x.test", now: NOW, write: w };
  assert.equal(capDecision({ processor: "umg", reason: "bucket" }, { ...opts, config: CAP }).route.processor, "umg");
  assert.equal(capDecision({ processor: "cleffo", reason: "retry_same_hard" }, { ...opts, config: CAP }).route.processor, "cleffo");
  assert.equal(capDecision({ processor: "cleffo", reason: "retry_same_pending" }, { ...opts, config: CAP }).route.processor, "cleffo");
  assert.equal(capDecision({ processor: "cleffo", reason: "bucket" }, { ...opts, config: { ...CAP, dailyCapUsd: 0 } }).route.processor, "cleffo");
  assert.equal(capDecision({ processor: "cleffo", reason: "bucket" }, { ...opts, config: { ...CAP, cleffoEnabled: false } }).route.processor, "cleffo");
  assert.equal(capDecision({ processor: "cleffo", reason: "cleffo_only" }, { ...opts, config: { ...CAP, cleffoOnly: true } }).route.processor, "cleffo");
});

test("capDecision: a capped buyer stays on UMG for 30 min (sticky), others under the cap still get Cleffo", () => {
  const store = memStore();
  seedCleffo(store, { amount: "1950.00", at: iso(NOW - 3600000) });
  const w = () => {};
  const r = { processor: "cleffo", attempt: 1, reason: "bucket" };
  assert.equal(capDecision(r, { store, config: CAP, amount: "100.00", email: "big@x.test", now: NOW, write: w }).route.reason, "cap");
  // /route has no amount: without the memo it would say cleffo (1950 + 0 <= 2000)
  assert.equal(capDecision(r, { store, config: CAP, amount: 0, email: "big@x.test", now: NOW + 60000, write: w }).route.reason, "cap");
  assert.equal(capDecision(r, { store, config: CAP, amount: 0, email: "small@x.test", now: NOW + 60000, write: w }).route.processor, "cleffo");
  assert.equal(capDecision(r, { store, config: CAP, amount: 0, email: "big@x.test", now: NOW + 31 * 60000, write: w }).route.processor, "cleffo");
});

// ---------- HTTP (the storefront path) ----------

async function setup({ routing = CAP, pricer = priceOf("169.09") } = {}) {
  process.env.PAYMENTS_ENABLED = "true";
  resetCleffoAlertState();
  const store = memStore();
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const consentLog = createConsentLog({ filePath: join(mkdtempSync(join(tmpdir(), "cap-consent-")), "consent-log.jsonl") });
  const links = [];
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const ref = `CAP${links.length + 1}api`;
      links.push({ ref, body });
      return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_link: `https://app.cleffo.com/pay/api-checkout-session/${ref}`, transaction_reference_number: ref, merchant_order_id: body.data.merchant_order_id } }) };
    }
    const ref = url.split("/").slice(-2)[0];
    const link = links.find((l) => l.ref === ref);
    return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_status: "pending", total_amount: String(link?.body.data.price.total.toFixed(2)), currency: "usd", merchant_order_id: link?.body.data.merchant_order_id, transaction_reference_number: ref } }) };
  };
  const umgCalls = [];
  const cfg = { routing, pricer };
  const handler = createHandler({
    store, consentLog, publicUrl: "https://crm.test",
    routingConfig: () => cfg.routing,
    cardPricer: (b) => cfg.pricer(b),
    cleffoDeps: { config: CFG, fetchImpl },
    forwardFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }),
    adapters: {
      umg: { async createPayment(p) { umgCalls.push(p.amount); return { ok: true, processor: "umg", processorTxnId: `U${umgCalls.length}`, processorStatus: "APPROVED", cascadeAction: "success", descriptor: "PEPTIDESS SHOP", raw: {} }; } },
      tagada: {}, centrobill: {},
    },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://biolabsresearch.co" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const charge = (email, key, extra = {}) => post("/api/checkout/charge", {
    idempotencyKey: key, session_id: `S-${key}`, customer: { first_name: "QA", last_name: "Test", email, phone: "8881234567" },
    amount: "169.09", items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 1, amount: "169.09" }], consent: CONSENT, ...extra,
  });
  return { store, server, links, umgCalls, post, charge, cfg };
}

test("HTTP: under the cap the first attempt gets a hosted Cleffo link (no UMG charge); /route says cleffo", async () => {
  const t = await setup();
  try {
    const r0 = await t.post("/api/checkout/route", { customer: { email: "fresh@example.test" } });
    assert.equal(r0.body.processor, "cleffo");
    const r = await t.charge("fresh@example.test", "K-under");
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "cleffo");
    assert.match(r.body.redirectUrl, /^https:\/\/app\.cleffo\.com\/pay\//);
    assert.equal(r.body.charged, false);
    assert.equal(t.umgCalls.length, 0);
  } finally { t.server.close(); }
});

test("HTTP: day total $1,900 PAID + $169.09 order -> UMG charges it (reason cap, logged); no Cleffo link", async () => {
  const t = await setup();
  const cap = captureLogs();
  try {
    seedCleffo(t.store, { amount: "1900.00", at: new Date(Date.now() - 60000).toISOString() });
    const r = await t.charge("capped@example.test", "K-cap", { card: CARD });
    cap.stop();
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "umg");
    assert.equal(t.umgCalls.length, 1);
    assert.equal(t.links.length, 0);
    const o = t.store.getOrderByIdempotency("K-cap");
    assert.equal(o.routing.attempts.at(-1).reason, "cap");
    assert.ok(cap.lines.some((l) => /\[routing\] cap: .* -> umg reason=cap/.test(l)), cap.lines.join("\n"));
    assert.ok(cap.lines.some((l) => /processor=umg reason=cap outcome=approved/.test(l)), cap.lines.join("\n"));
  } finally { cap.stop(); t.server.close(); }
});

test("HTTP: capped and the page sent no card (Cleffo step) -> 400 card_required, not charged; /route then says umg (cap)", async () => {
  const t = await setup();
  try {
    seedCleffo(t.store, { amount: "1950.00", at: new Date(Date.now() - 60000).toISOString() });
    const r = await t.charge("nocard@example.test", "K-nocard");
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "card_required");
    assert.equal(r.body.charged, false);
    assert.equal(t.umgCalls.length, 0);
    assert.equal(t.links.length, 0);
    const rt = await t.post("/api/checkout/route", { customer: { email: "nocard@example.test" }, session_id: "S-K-nocard" });
    assert.equal(rt.body.processor, "umg");
    assert.equal(rt.body.reason, "cap");
    // another buyer without an amount on /route: 1950 < 2000 -> still Cleffo there (the charge decides with the real total)
    const other = await t.post("/api/checkout/route", { customer: { email: "other@example.test" } });
    assert.equal(other.body.processor, "cleffo");
  } finally { t.server.close(); }
});

test("HTTP: $2,000 already PAID today -> /route umg (cap) for everyone", async () => {
  const t = await setup();
  try {
    seedCleffo(t.store, { amount: "2000.00", at: new Date(Date.now() - 60000).toISOString() });
    const rt = await t.post("/api/checkout/route", { customer: { email: "anyone@example.test" } });
    assert.equal(rt.body.processor, "umg");
    assert.equal(rt.body.reason, "cap");
  } finally { t.server.close(); }
});

test("HTTP: cap off (CLEFFO_DAILY_CAP_USD unset) -> Cleffo whatever the day total", async () => {
  const t = await setup({ routing: { ...CAP, dailyCapUsd: 0 } });
  try {
    seedCleffo(t.store, { amount: "9000.00", at: new Date(Date.now() - 60000).toISOString() });
    const r = await t.charge("nocap@example.test", "K-nocap");
    assert.equal(r.body.processor, "cleffo");
    assert.ok(r.body.redirectUrl);
  } finally { t.server.close(); }
});

test("nextStepFor: soft-decline switch to Cleffo reports umg (cap) when the day is used up", () => {
  const store = memStore();
  seedCleffo(store, { amount: "2000.00", at: new Date(Date.now() - 60000).toISOString() });
  const at = new Date().toISOString();
  const order = { id: "BLR-8001", idempotencyKey: "K-soft", amount: "50.00", customer: { email: "soft@example.test" }, session_id: "S-soft", status: "declined", attempts: [],
    routing: { attempts: [{ n: 1, processor: "umg", reason: "bucket", at, outcome: "declined", retryClass: "soft" }] } };
  store.upsertOrder(order);
  const cfg = { ...CAP, splitPct: 0 };
  assert.equal(nextStepFor(store, store.getOrder("BLR-8001"), { ...cfg, dailyCapUsd: 0 }).nextProcessor, "cleffo");
  const n = nextStepFor(store, store.getOrder("BLR-8001"), cfg);
  assert.equal(n.nextProcessor, "umg");
  assert.equal(n.nextReason, "cap");
});
