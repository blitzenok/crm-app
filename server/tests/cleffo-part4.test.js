// Part 4 (2026-09-29): Cleffo-only mode, one live link per order, sweep over all links, USD only, server price,
// [pay-alert] lines, log-line forging. Harness mirrors cleffo-routes.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { createConsentLog } from "../lib/consent.js";
import { bucketFor, chooseProcessor, routingConfig } from "../lib/routing.js";
import { sweepCleffo, startCleffoSweeper, resetCleffoAlertState } from "../lib/cleffo-checkout.js";
import { createServer } from "node:http";
import { createHandler } from "../index.js";

const CFG = { env: "sandbox", baseUrl: "https://apis-dev.cleffo.com", clientKey: "ck-test", signatureKey: "sig-test", apiKey: "api-test", baseUrlMismatch: false };
const CONSENT = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T15:40:00.000Z", pageVersion: "v-test" };
const CARD = { name: "Q A", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
const ON = { cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 50, maxAttempts: 3, retryWindowMin: 120 };
const ONLY = { ...ON, cleffoOnly: true };
const priceOf = (amount) => (b) => ({ ok: true, amount, clientAmount: b.amount, mismatch: false, source: "test", subtotal: amount, shipping: "0.00", shipMethod: "", lines: [] });

function emailIn(bucket, tag) {
  for (let i = 0; ; i += 1) { const e = `p4-${tag}-${i}@example.test`; if (bucketFor(e, 50) === bucket) return e; }
}

// Collects service log lines ("[...") while a test runs; everything else (test reporter) passes through.
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
  const state = { links: [], statusCalls: 0, status: {}, amount: {}, currency: {}, failCreate: false, statusFail: false, createDelayMs: 0, createThrow: null, failMessage: "An unexpected error occurred." };
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      if (state.createDelayMs) await new Promise((r) => setTimeout(r, state.createDelayMs));
      if (state.createThrow) throw state.createThrow;
      if (state.failCreate) return { status: 500, text: async () => JSON.stringify({ status: false, message: state.failMessage }) };
      const body = JSON.parse(init.body);
      const ref = `REF${state.links.length + 1}api`;
      state.links.push({ ref, body });
      state.status[ref] = "pending";
      state.amount[ref] = String(body.data.price.total.toFixed(2));
      state.currency[ref] = "usd";
      return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_link: `https://dev.cleffo.com/pay/api-checkout-session/${ref}`, transaction_reference_number: ref, merchant_order_id: body.data.merchant_order_id } }) };
    }
    state.statusCalls += 1;
    if (state.statusFail) return { status: 500, text: async () => JSON.stringify({ status: false, message: "down" }) };
    const ref = url.split("/").slice(-2)[0];
    const link = state.links.find((l) => l.ref === ref);
    return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_status: state.status[ref], total_amount: state.amount[ref], currency: state.currency[ref], merchant_order_id: link?.body.data.merchant_order_id, transaction_reference_number: ref } }) };
  };
  return { state, fetchImpl };
}

async function setup({ routing = ONLY, pricer = priceOf("20.00"), umg = "approve" } = {}) {
  process.env.PAYMENTS_ENABLED = "true";
  resetCleffoAlertState();
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const consentLog = createConsentLog({ filePath: join(mkdtempSync(join(tmpdir(), "p4-consent-")), "consent-log.jsonl") });
  const cl = cleffoMock();
  const umgCalls = [];
  const forwards = [];
  const cfg = { routing, pricer, umg };
  const cleffoDeps = { config: CFG, fetchImpl: cl.fetchImpl };
  const handler = createHandler({
    store, consentLog, publicUrl: "https://crm.test",
    routingConfig: () => cfg.routing,
    cardPricer: (b) => (cfg.pricer ? cfg.pricer(b) : { ok: false, status: 503, error: "pricing_unavailable" }),
    cleffoDeps,
    forwardFetch: async (url, init) => { forwards.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }; },
    adapters: {
      umg: { async createPayment(p) {
        umgCalls.push(p.amount);
        if (cfg.umg === "hard") return { ok: false, processor: "umg", processorTxnId: `U${umgCalls.length}`, processorStatus: "DECLINED", informationData: "Do not honor", informationCode: "05", cascadeAction: "stop", declineClass: "hard", reason: "hard_decline", raw: {} };
        return { ok: true, processor: "umg", processorTxnId: `U${umgCalls.length}`, processorStatus: "APPROVED", cascadeAction: "success", descriptor: "PEPTIDESS SHOP", raw: {} };
      } },
      tagada: {}, centrobill: {},
    },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const charge = (email, key, extra = {}, headers = {}) => post("/api/checkout/charge", {
    idempotencyKey: key, session_id: `S-${key}`, customer: { first_name: "QA", last_name: "Test", email, phone: "8881234567" },
    amount: "20.00", items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 1, amount: "20.00" }], consent: CONSENT, ...extra,
  }, headers);
  const sweep = () => sweepCleffo(store, { cleffoDeps, onPaid: handler.onCleffoPaid });
  const backdate = (orderId, minutes, { onlyN } = {}) => {
    const o = store.getOrder(orderId);
    const ts = new Date(Date.now() - minutes * 60000).toISOString();
    o.routing.attempts.forEach((a) => { if (onlyN == null || a.n === onlyN) a.at = ts; });
    o.attempts.forEach((a) => { if (onlyN == null || a.routingAttempt === onlyN) a.startedAt = ts; });
    store.upsertOrder(o);
  };
  return { store, server, base, cl, umgCalls, forwards, post, charge, sweep, backdate, cfg, cleffoDeps };
}

const alerts = (lines, kind) => lines.filter((l) => l.startsWith(`[pay-alert] ${kind}`));

// ---------- config / routing (A1) ----------

test("routingConfig: CLEFFO_ONLY off by default; link TTL 60 min and sweep 72 h by default, env overrides", () => {
  const d = routingConfig({});
  assert.equal(d.cleffoOnly, false);
  assert.equal(d.linkTtlMin, 60);
  assert.equal(d.sweepHours, 72);
  const c = routingConfig({ CLEFFO_ONLY: "true", CLEFFO_LINK_TTL_MIN: "30", CLEFFO_SWEEP_HOURS: "96" });
  assert.equal(c.cleffoOnly, true);
  assert.equal(c.linkTtlMin, 30);
  assert.equal(c.sweepHours, 96);
});

test("chooseProcessor: cleffo-only sends every attempt to Cleffo (no email, UMG history, any bucket); flag off unchanged", () => {
  const umgHist = [{ processor: "umg", outcome: "declined", retryClass: "hard", reason: "bucket", n: 1 }];
  for (const email of ["", emailIn("umg", "c1"), emailIn("cleffo", "c2")]) {
    assert.equal(chooseProcessor({ email, history: [], config: ONLY }).processor, "cleffo");
    assert.equal(chooseProcessor({ email, history: umgHist, config: ONLY }).processor, "cleffo");
  }
  assert.equal(chooseProcessor({ email: "", history: [], config: ON }).processor, "umg"); // as before
  assert.equal(chooseProcessor({ email: "x@y.z", history: [], config: { ...ONLY, cleffoEnabled: false } }).processor, "umg");
  assert.equal(chooseProcessor({ email: "x@y.z", history: [{}, {}, {}], config: ONLY }).blocked, true); // cap still applies
});

test("cleffo-only: umg-bucket buyer gets a Cleffo link, /route says cleffo without an email, no email on /charge = 400 email_required", async () => {
  const t = await setup();
  try {
    const route = await t.post("/api/checkout/route", { customer: { email: "" } });
    assert.equal(route.body.processor, "cleffo");
    const none = await t.charge("", "K-E0");
    assert.equal(none.status, 400);
    assert.equal(none.body.error, "email_required");
    assert.equal(none.body.charged, false);
    assert.equal(t.cl.state.links.length, 0);
    const r = await t.charge(emailIn("umg", "a"), "K-A1");
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "cleffo");
    assert.match(r.body.redirectUrl, /^https:\/\/dev\.cleffo\.com\/pay\//);
    assert.deepEqual(t.umgCalls, []);
  } finally { t.server.close(); }
});

test("cleffo-only: earlier UMG hard decline does not keep the buyer on UMG", async () => {
  const t = await setup({ routing: ON, umg: "hard" });
  try {
    const e = emailIn("umg", "h");
    const r1 = await t.charge(e, "K-H1", { card: CARD });
    assert.equal(r1.status, 402);
    t.cfg.routing = ONLY;
    const r2 = await t.charge(e, "K-H2");
    assert.equal(r2.body.processor, "cleffo");
    assert.equal(t.umgCalls.length, 1);
  } finally { t.server.close(); }
});

test("cleffo-only: link error = 503 processor_unavailable, never UMG even with a card; card ignored, never stored or logged; alert", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    t.cl.state.failCreate = true;
    const r = await t.charge(emailIn("umg", "l"), "K-L1", { card: CARD });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "processor_unavailable");
    assert.deepEqual(t.umgCalls, []);
    assert.equal(alerts(cap.lines, "CLEFFO_LINK_ERROR").length, 1);
    assert.ok(cap.lines.some((l) => l === "[routing] card_ignored"));
    const dump = JSON.stringify(t.store.snapshot()) + cap.lines.join("\n");
    assert.doesNotMatch(dump, /4242424242424242/);
    assert.doesNotMatch(dump, /"cvv"|cvv":"123/);
  } finally { cap.stop(); t.server.close(); }
});

test("flag CLEFFO_ONLY off: link error with a card still falls back to UMG (as before)", async () => {
  const t = await setup({ routing: ON });
  try {
    t.cl.state.failCreate = true;
    const r = await t.charge(emailIn("cleffo", "fb"), "K-FB1", { card: CARD });
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "umg");
  } finally { t.server.close(); }
});

// ---------- one live link per order (A2) ----------

test("same order inside the link TTL: same link, reused:true, one Cleffo link, even after the old 120 s window", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "r");
    const r = await t.charge(e, "K-R1");
    t.backdate(r.body.orderId, 10);
    const again = await t.charge(e, "K-R1");
    assert.equal(again.body.reused, true);
    assert.equal(again.body.redirectUrl, r.body.redirectUrl);
    assert.equal(t.cl.state.links.length, 1);
    assert.equal(t.store.getOrder(r.body.orderId).routing.attempts.length, 1);
  } finally { t.server.close(); }
});

test("after the TTL the old link is marked abandoned (still open at Cleffo) and a new link is issued", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "ttl");
    const r = await t.charge(e, "K-T1");
    t.backdate(r.body.orderId, 61);
    const next = await t.charge(e, "K-T1");
    assert.equal(next.body.reused, undefined);
    assert.notEqual(next.body.redirectUrl, r.body.redirectUrl);
    assert.equal(t.cl.state.links.length, 2);
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.routing.attempts[0].outcome, "abandoned");
    assert.equal(o.attempts[0].abandoned, true);
    assert.equal(o.attempts[0].processorStatus, "LINK_CREATED"); // no confirmed outcome: the sweep keeps watching it
    assert.notEqual(o.attempts[1].merchantOrderId, o.attempts[0].merchantOrderId);
  } finally { t.server.close(); }
});

test("Cleffo says the link expired: a new link right away (no TTL wait), the expired one is settled", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "exp");
    const r = await t.charge(e, "K-X1");
    t.cl.state.status.REF1api = "expired";
    const next = await t.charge(e, "K-X1");
    assert.equal(next.body.reused, undefined);
    assert.equal(t.cl.state.links.length, 2);
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.attempts[0].processorStatus, "EXPIRED");
  } finally { t.server.close(); }
});

test("approved order: no new link and no consent needed to see the answer; review / pending order: no new link either", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "ap");
    const r = await t.charge(e, "K-P1");
    t.cl.state.status.REF1api = "completed";
    await t.sweep();
    assert.equal(t.store.getOrder(r.body.orderId).status, "approved");
    const again = await t.charge(e, "K-P1", { consent: undefined });
    assert.equal(again.status, 200);
    assert.equal(again.body.reused, true);
    assert.equal(again.body.redirectUrl, undefined);
    assert.equal(again.body.orderId, r.body.orderId);
    assert.equal(t.cl.state.links.length, 1);
    // review
    const e2 = emailIn("cleffo", "rv");
    const r2 = await t.charge(e2, "K-P2");
    t.cl.state.status.REF2api = "completed";
    t.cl.state.amount.REF2api = "1.00";
    await t.sweep();
    assert.equal(t.store.getOrder(r2.body.orderId).status, "review");
    const held = await t.charge(e2, "K-P2");
    assert.equal(held.body.redirectUrl, undefined);
    assert.equal(held.body.pending, true);
    assert.equal(t.cl.state.links.length, 2);
  } finally { t.server.close(); }
});

test("double click: two parallel /charge for one key create ONE link and one attempt; both get the same link", async () => {
  const t = await setup();
  try {
    t.cl.state.createDelayMs = 40;
    const e = emailIn("cleffo", "dc");
    const [a, b] = await Promise.all([t.charge(e, "K-D1"), t.charge(e, "K-D1")]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.body.redirectUrl, b.body.redirectUrl);
    assert.equal(t.cl.state.links.length, 1);
    const o = t.store.getOrder(a.body.orderId);
    assert.equal(o.attempts.length, 1);
    assert.equal(o.routing.attempts.length, 1);
    assert.equal([a.body.reused, b.body.reused].filter(Boolean).length, 1);
  } finally { t.server.close(); }
});

test("link error then retry under the same key: new attempt number and merchant order id (Cleffo may have kept the first one)", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "le");
    t.cl.state.failCreate = true;
    const bad = await t.charge(e, "K-LE1");
    assert.equal(bad.status, 503);
    t.cl.state.failCreate = false;
    const ok = await t.charge(e, "K-LE1");
    assert.equal(ok.status, 200);
    const o = t.store.getOrder(ok.body.orderId);
    assert.equal(o.attempts.length, 2);
    assert.notEqual(o.attempts[0].merchantOrderId, o.attempts[1].merchantOrderId);
    assert.equal(ok.body.attempt, 2);
  } finally { t.server.close(); }
});

// ---------- sweep / late / double payments (A2, A5) ----------

test("sweep polls EVERY open link, not just the last one: a paid abandoned link approves the order and raises CLEFFO_LATE_PAID", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const e = emailIn("cleffo", "lp");
    const r = await t.charge(e, "K-LP1");
    t.backdate(r.body.orderId, 61);
    await t.charge(e, "K-LP1"); // link 2, link 1 abandoned
    t.cl.state.status.REF1api = "completed"; // the OLD link gets paid
    const out = await t.sweep();
    assert.ok(out.length >= 2);
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "approved");
    assert.equal(o.winningTxnId, "REF1api");
    assert.equal(o.attempts[0].processorStatus, "PAID");
    assert.equal(alerts(cap.lines, "CLEFFO_LATE_PAID").length, 1);
    assert.match(alerts(cap.lines, "CLEFFO_LATE_PAID")[0], new RegExp(`CLEFFO_LATE_PAID ${r.body.orderId} 1 20\\.00`));
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(t.forwards.length, 1);
  } finally { cap.stop(); t.server.close(); }
});

test("second payment of an approved order: winningTxnId untouched, order stays approved, CLEFFO_DOUBLE_PAID, no second onPaid", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const e = emailIn("cleffo", "dp");
    const r = await t.charge(e, "K-DP1");
    t.backdate(r.body.orderId, 61);
    await t.charge(e, "K-DP1");
    t.cl.state.status.REF1api = "completed";
    await t.sweep();
    await new Promise((res) => setTimeout(res, 30));
    t.cl.state.status.REF2api = "completed";
    await t.sweep();
    await t.sweep(); // idempotent
    await new Promise((res) => setTimeout(res, 30));
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "approved");
    assert.equal(o.winningTxnId, "REF1api");
    assert.equal(o.attempts[1].processorStatus, "PAID");
    assert.equal(o.attempts[1].doublePaid, true);
    const dp = alerts(cap.lines, "CLEFFO_DOUBLE_PAID");
    assert.equal(dp.length, 1);
    assert.match(dp[0], new RegExp(`CLEFFO_DOUBLE_PAID ${r.body.orderId} 2 20\\.00`));
    assert.equal(t.forwards.length, 1);
    assert.doesNotMatch(cap.lines.filter((l) => l.includes("[pay-alert]")).join("\n"), /@/); // no email in alerts
  } finally { cap.stop(); t.server.close(); }
});

test("a mismatching second payment does not move an approved order to review", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const e = emailIn("cleffo", "dm");
    const r = await t.charge(e, "K-DM1");
    t.backdate(r.body.orderId, 61);
    await t.charge(e, "K-DM1");
    t.cl.state.status.REF1api = "completed";
    await t.sweep();
    t.cl.state.status.REF2api = "completed";
    t.cl.state.amount.REF2api = "5.00";
    await t.sweep();
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "approved");
    assert.equal(o.winningTxnId, "REF1api");
    assert.equal(alerts(cap.lines, "CLEFFO_DOUBLE_PAID").length, 1);
  } finally { cap.stop(); t.server.close(); }
});

test("paid with wrong amount / currency / order number -> review + CLEFFO_REVIEW, once", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const r = await t.charge(emailIn("cleffo", "rw"), "K-RW1");
    t.cl.state.status.REF1api = "completed";
    t.cl.state.currency.REF1api = "eur"; // right amount, wrong currency
    await t.sweep();
    await t.sweep();
    assert.equal(t.store.getOrder(r.body.orderId).status, "review");
    assert.equal(alerts(cap.lines, "CLEFFO_REVIEW").length, 1);
    assert.match(alerts(cap.lines, "CLEFFO_REVIEW")[0], new RegExp(`CLEFFO_REVIEW ${r.body.orderId} 1`));
  } finally { cap.stop(); t.server.close(); }
});

test("old link paid for an amount that differs from the order's current amount -> review + CLEFFO_REVIEW, never approved; checked against the attempt's own amount", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const e = emailIn("cleffo", "ap4");
    const r = await t.charge(e, "K-AP1"); // $20
    t.cfg.pricer = priceOf("30.00");
    t.backdate(r.body.orderId, 61);
    await t.charge(e, "K-AP1"); // $30 link, order re-priced
    let o = t.store.getOrder(r.body.orderId);
    assert.equal(o.attempts[0].amount, "20.00");
    assert.equal(o.attempts[0].currency, "USD");
    assert.equal(o.attempts[1].amount, "30.00");
    t.cl.state.status.REF1api = "completed"; // the $20 link is paid, Cleffo says $20 (= its own attempt), order now says $30
    await t.sweep();
    o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "review");
    assert.equal(o.winningTxnId, null);
    assert.equal(o.amount, "30.00");
    const rv = alerts(cap.lines, "CLEFFO_REVIEW");
    assert.equal(rv.length, 1);
    assert.match(rv[0], /amount=20\.00 want=20\.00 order=30\.00/);
    // the $30 link paid correctly for the order amount would have been approved: check the same order shape on a fresh order
    const e2 = emailIn("cleffo", "ap5");
    const r2 = await t.charge(e2, "K-AP2");
    t.cl.state.status[`REF${t.cl.state.links.length}api`] = "completed";
    await t.sweep();
    assert.equal(t.store.getOrder(r2.body.orderId).status, "approved");
  } finally { cap.stop(); t.server.close(); }
});

test("open longer than 24 h: buyer never came back = a log line only; buyer came back and still pending = ONE summary alert a day; older than the sweep window: not polled", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const quiet = await t.charge(emailIn("cleffo", "st1"), "K-ST1"); // never opened again
    const back = await t.charge(emailIn("cleffo", "st2"), "K-ST2");
    const link2 = new URL(t.cl.state.links[1].body.metadata.redirect_url);
    await fetch(`${t.base}${link2.pathname}${link2.search}`, { redirect: "manual" }); // the buyer returns, Cleffo still says pending
    assert.ok(t.store.getOrder(back.body.orderId).attempts[0].returnedAt);
    assert.equal(t.store.getOrder(quiet.body.orderId).attempts[0].returnedAt, undefined);
    t.backdate(quiet.body.orderId, 25 * 60);
    t.backdate(back.body.orderId, 26 * 60);
    await t.sweep();
    await t.sweep();
    assert.deepEqual(alerts(cap.lines, "CLEFFO_STUCK "), []); // the per-link alert is gone
    const sum = alerts(cap.lines, "CLEFFO_STUCK_SUMMARY");
    assert.equal(sum.length, 1);
    assert.match(sum[0], new RegExp(`CLEFFO_STUCK_SUMMARY n=1 oldest=${back.body.orderId}$`));
    assert.equal(cap.lines.filter((l) => l.startsWith(`[cleffo] open_no_return ${quiet.body.orderId}`)).length, 1);
    t.backdate(back.body.orderId, 80 * 60);
    resetCleffoAlertState(); // forget the "asked recently" memory of old links
    const calls = t.cl.state.statusCalls;
    await t.sweep();
    assert.equal(t.cl.state.statusCalls, calls + 1); // only the quiet one is still inside the window
  } finally { cap.stop(); t.server.close(); }
});

test("no summary while nobody who came back is stuck (abandoned links alone are not an alert)", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const r = await t.charge(emailIn("cleffo", "st3"), "K-ST3");
    t.backdate(r.body.orderId, 30 * 60);
    await t.sweep();
    assert.deepEqual(alerts(cap.lines, "CLEFFO_STUCK"), []);
  } finally { cap.stop(); t.server.close(); }
});

test("pending link is not rewritten to store.json on every sweep", async () => {
  const t = await setup();
  try {
    const r = await t.charge(emailIn("cleffo", "nw"), "K-NW1");
    let writes = 0;
    const orig = t.store.upsertOrder;
    t.store.upsertOrder = (o) => { writes += 1; return orig(o); };
    await t.sweep();
    await t.sweep();
    assert.equal(writes, 0);
    assert.ok(r.body.orderId);
  } finally { t.server.close(); }
});

test("CLEFFO_LINK_ERROR: at most one line per 10 minutes per process", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    t.cl.state.failCreate = true;
    await t.charge(emailIn("cleffo", "e1"), "K-E1");
    await t.charge(emailIn("cleffo", "e2"), "K-E2");
    await t.charge(emailIn("cleffo", "e3"), "K-E3");
    assert.equal(alerts(cap.lines, "CLEFFO_LINK_ERROR").length, 1);
  } finally { cap.stop(); t.server.close(); }
});

// ---------- USD only, server price (A3, A4) ----------

test("currency other than USD: 400 currency_unsupported before any payment, on the Cleffo and the UMG path", async () => {
  for (const routing of [ONLY, { ...ON, cleffoEnabled: false }]) {
    const t = await setup({ routing });
    try {
      const bad = await t.charge(emailIn("cleffo", "cu"), "K-CU1", { currency: "EUR", card: CARD });
      assert.equal(bad.status, 400);
      assert.equal(bad.body.error, "currency_unsupported");
      assert.equal(bad.body.charged, false);
      assert.equal(t.cl.state.links.length, 0);
      assert.deepEqual(t.umgCalls, []);
    } finally { t.server.close(); }
  }
  const t = await setup();
  try {
    const ok = await t.charge(emailIn("cleffo", "cu2"), "K-CU2", { currency: "usd" });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.currency, "USD");
    assert.equal(t.cl.state.links[0].body.data.price.currency, "USD");
    assert.equal(t.store.getOrder(ok.body.orderId).currency, "USD");
  } finally { t.server.close(); }
});

test("no server price for a new Cleffo order: 503 pricing_unavailable, no order, no link (browser amount never used)", async () => {
  const t = await setup({ pricer: null });
  try {
    const r = await t.charge(emailIn("cleffo", "np"), "K-NP1");
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "pricing_unavailable");
    assert.equal(t.cl.state.links.length, 0);
    assert.equal(t.store.listOrders().length, 0);
  } finally { t.server.close(); }
});

test("server price: browser amount is ignored, link and attempt carry the server total", async () => {
  const t = await setup({ pricer: (b) => ({ ...priceOf("42.50")(b), mismatch: true }) });
  try {
    const r = await t.charge(emailIn("cleffo", "sp"), "K-SP1", { amount: "1.00" });
    assert.equal(r.body.amount, "42.50");
    assert.equal(t.cl.state.links[0].body.data.price.total, 42.5);
    assert.equal(t.store.getOrder(r.body.orderId).attempts[0].amount, "42.50");
  } finally { t.server.close(); }
});

// ---------- log line forging (A6) ----------

test("request data cannot forge a log line: %0A[pay-alert] in ?o= yields no [pay-alert] line", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const r = await fetch(`${t.base}/api/checkout/cleffo/return?o=BLR-1%0A[pay-alert]%20X%0D[pay-alert]%20Y&a=1&t=bad`, { redirect: "manual" });
    assert.equal(r.status, 400);
    assert.deepEqual(cap.lines.filter((l) => l.includes("[pay-alert]")), []); // not even mid-line: ops-watch takes it anywhere
    assert.ok(cap.lines.some((l) => l.startsWith("[cleffo] return with bad token")));
    assert.ok(cap.lines.every((l) => !/[\x00-\x1f]/.test(l)));
  } finally { cap.stop(); t.server.close(); }
});

test("text from a Cleffo error answer cannot forge a log line either", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    t.cl.state.failCreate = true;
    t.cl.state.failMessage = "boom\n[pay-alert] FAKE_ALERT 1 2 3";
    await t.charge(emailIn("cleffo", "fg"), "K-FG1");
    assert.deepEqual(cap.lines.filter((l) => l.includes("[pay-alert] FAKE")), []);
    assert.ok(cap.lines.every((l) => !/[\x00-\x1f]/.test(l)));
  } finally { cap.stop(); t.server.close(); }
});

// ---------- round 2: Cleffo primary, UMG spare ----------

test("R1: Cleffo on (split mode too): /charge without email = 400 email_required, nothing created; Cleffo off: as before", async () => {
  const t = await setup({ routing: ON });
  try {
    const r = await t.charge("", "K-R1A", { card: CARD });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, "email_required");
    assert.equal(r.body.charged, false);
    assert.deepEqual(t.umgCalls, []);
    assert.equal(t.store.listOrders().length, 0);
  } finally { t.server.close(); }
  const off = await setup({ routing: { ...ON, cleffoEnabled: false } });
  try {
    const r = await off.charge("", "K-R1B", { card: CARD });
    assert.notEqual(r.body.error, "email_required");
    assert.equal(off.umgCalls.length, 1);
  } finally { off.server.close(); }
});

test("R2 chain: link error without a card = 503 not charged -> /route says umg (retry_switch_link_error) -> /charge with card = UMG; other buyers stay on Cleffo", async () => {
  const t = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "ch");
    const who = { customer: { email: e }, session_id: "S-K-CH1", idempotencyKey: "K-CH1" };
    const before = await t.post("/api/checkout/route", who);
    assert.equal(before.body.processor, "cleffo");
    assert.equal(before.body.reason, "bucket");
    t.cl.state.failCreate = true;
    const bad = await t.charge(e, "K-CH1"); // the Cleffo step sends no card
    assert.equal(bad.status, 503);
    assert.equal(bad.body.error, "processor_unavailable");
    assert.equal(bad.body.charged, false);
    assert.deepEqual(t.umgCalls, []);
    // same buyer, by email / by key+session
    const viaEmail = await t.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(viaEmail.body.processor, "umg");
    assert.equal(viaEmail.body.reason, "retry_switch_link_error");
    assert.equal(viaEmail.body.statementDescriptor, "PEPTIDESS SHOP");
    const viaKey = await t.post("/api/checkout/route", { idempotencyKey: "K-CH1", session_id: "S-K-CH1", customer: { email: "" } });
    assert.equal(viaKey.body.processor, "umg");
    // another buyer is not affected
    const other = await t.post("/api/checkout/route", { customer: { email: emailIn("cleffo", "ch-other") } });
    assert.equal(other.body.processor, "cleffo");
    // a /charge without a card on the umg step is refused before any order
    const orders = t.store.listOrders().length;
    const nocard = await t.charge(e, "K-CH2");
    assert.equal(nocard.status, 400);
    assert.equal(nocard.body.error, "card_required");
    assert.equal(nocard.body.charged, false);
    assert.equal(t.store.listOrders().length, orders);
    // with the card: UMG
    const paid = await t.charge(e, "K-CH2", { card: CARD });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.processor, "umg");
    assert.equal(t.umgCalls.length, 1);
    assert.equal(t.cl.state.links.length, 0);
    const o = t.store.getOrder(paid.body.order.id);
    assert.equal(o.routing.attempts.at(-1).reason, "retry_switch_link_error");
    // after an approval a new checkout starts from the bucket again
    const again = await t.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(again.body.processor, "cleffo");
  } finally { t.server.close(); }
});

test("R2: a UMG decline after the switch follows the normal rules (hard stays on UMG); a failed Cleffo PAYMENT stays on Cleffo even if a later link fails", async () => {
  const t = await setup({ routing: ON, umg: "hard" });
  try {
    const e = emailIn("cleffo", "r2h");
    t.cl.state.failCreate = true;
    await t.charge(e, "K-H1");
    const d = await t.charge(e, "K-H2", { card: CARD });
    assert.equal(d.status, 402); // UMG hard decline
    const next = await t.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(next.body.processor, "umg");
    assert.equal(next.body.reason, "retry_same_hard");
  } finally { t.server.close(); }
  const c = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "r2c");
    const r = await c.charge(e, "K-C1");
    c.cl.state.status.REF1api = "failed";
    await c.sweep();
    assert.equal(c.store.getOrder(r.body.orderId).status, "declined");
    c.cl.state.failCreate = true;
    const bad = await c.charge(e, "K-C2"); // Cleffo cannot make a link now
    assert.equal(bad.status, 503);
    const route = await c.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(route.body.processor, "cleffo"); // hard decline: the card never moves to UMG
    assert.equal(route.body.reason, "retry_same_hard");
    assert.deepEqual(c.umgCalls, []);
  } finally { c.server.close(); }
});

test("R2: with a card in the same request the link-error fallback to UMG still works (split mode)", async () => {
  const t = await setup({ routing: ON });
  try {
    t.cl.state.failCreate = true;
    const r = await t.charge(emailIn("cleffo", "fbk"), "K-FBK", { card: CARD });
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "umg");
  } finally { t.server.close(); }
});

// ---------- R3 return address by Origin ----------

test("R3: return page = <Origin>/checkout for the four storefront origins, else CLEFFO_STOREFRONT_RETURN_URL; stored on the attempt; /return reads the attempt", async () => {
  const t = await setup();
  try {
    const cases = [
      ["https://blrcommerce.io", "https://blrcommerce.io/checkout"],
      ["https://www.blrcommerce.io", "https://www.blrcommerce.io/checkout"],
      ["https://www.biolabsresearch.co", "https://www.biolabsresearch.co/checkout"],
      ["https://biolabsresearch.co", "https://biolabsresearch.co/checkout"],
      ["https://evil.example", "https://biolabsresearch.co/checkout"],
      ["https://biolabsresearch.co.evil.example", "https://biolabsresearch.co/checkout"],
      ["http://blrcommerce.io", "https://biolabsresearch.co/checkout"],
      [undefined, "https://biolabsresearch.co/checkout"],
    ];
    let i = 0;
    for (const [origin, want] of cases) {
      i += 1;
      const r = await t.charge(emailIn("cleffo", `o${i}`), `K-O${i}`, {}, origin ? { Origin: origin } : {});
      assert.equal(r.status, 200);
      const o = t.store.getOrder(r.body.orderId);
      assert.equal(o.attempts[0].returnPage, want);
      t.cl.state.status[`REF${i}api`] = "completed";
      const back = new URL(t.cl.state.links[i - 1].body.metadata.redirect_url);
      // the return request carries its own (attacker-chosen) Origin / Host: ignored
      const go = await fetch(`${t.base}${back.pathname}${back.search}`, { redirect: "manual", headers: { Origin: "https://evil.example" } });
      assert.equal(go.status, 302);
      const loc = new URL(go.headers.get("location"));
      assert.equal(loc.origin + loc.pathname, want);
      assert.equal(loc.searchParams.get("status"), "paid");
    }
  } finally { t.server.close(); }
});

// ---------- round 3 ----------

test("B1: a live Cleffo link of the buyer (another key) blocks the UMG spare: K1 live, K2 different cart fails -> /route is not umg, card in the body does not reach UMG either", async () => {
  const t = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "b1");
    const l1 = await t.charge(e, "K-B1-1");
    assert.equal(l1.status, 200);
    t.cfg.pricer = priceOf("30.00"); // a different cart: no reuse, a new link is tried
    t.cl.state.failCreate = true;
    const bad = await t.charge(e, "K-B1-2");
    assert.equal(bad.status, 503);
    const route = await t.post("/api/checkout/route", { customer: { email: e }, idempotencyKey: "K-B1-2", session_id: "S-K-B1-2" });
    assert.notEqual(route.body.processor, "umg");
    assert.equal(route.body.processor, "cleffo");
    const withCard = await t.charge(e, "K-B1-3", { card: CARD });
    assert.equal(withCard.status, 503); // link error + card, but a Cleffo link is still open: no UMG
    assert.deepEqual(t.umgCalls, []);
    // L1's order keeps waiting for the payment
    assert.equal(t.store.getOrder(l1.body.orderId).status, "awaiting_payment");
  } finally { t.server.close(); }
});

test("B1: same buyer + same cart under a NEW key gets the same live link (reused:true), no second link, no new order", async () => {
  const t = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "b1b");
    const l1 = await t.charge(e, "K-B1B-1");
    const orders = t.store.listOrders().length;
    const again = await t.charge(e, "K-B1B-2");
    assert.equal(again.status, 200);
    assert.equal(again.body.reused, true);
    assert.equal(again.body.redirectUrl, l1.body.redirectUrl);
    assert.equal(again.body.orderId, l1.body.orderId);
    assert.equal(t.cl.state.links.length, 1);
    assert.equal(t.store.listOrders().length, orders);
    // a different buyer with the same cart is not served this link
    const other = await t.charge(emailIn("cleffo", "b1c"), "K-B1B-3");
    assert.notEqual(other.body.redirectUrl, l1.body.redirectUrl);
    // after the link's lifetime it is not handed out any more
    t.backdate(l1.body.orderId, 61);
    const late = await t.charge(e, "K-B1B-4");
    assert.notEqual(late.body.redirectUrl, l1.body.redirectUrl);
  } finally { t.server.close(); }
});

test("B1: with no open link the spare works as before; a link that was abandoned (hard) does not open it", async () => {
  const t = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "b1d");
    const l1 = await t.charge(e, "K-B1D-1");
    t.backdate(l1.body.orderId, 61);
    t.cfg.pricer = priceOf("30.00");
    t.cl.state.failCreate = true;
    const bad = await t.charge(e, "K-B1D-2", { card: CARD });
    assert.equal(bad.status, 503); // L1 was abandoned but may still be paid: no UMG
    assert.deepEqual(t.umgCalls, []);
    const route = await t.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(route.body.processor, "cleffo");
  } finally { t.server.close(); }
});

test("B3: a timeout creating the link is not 'no link': 503, attempt LINK_UNKNOWN, no UMG spare (route stays cleffo, card in the body ignored); a refused connection still allows the spare", async () => {
  const t = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "b3");
    t.cl.state.createThrow = Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_SOCKET" } });
    const r = await t.charge(e, "K-B3-1", { card: CARD });
    assert.equal(r.status, 503);
    assert.equal(r.body.error, "processor_unavailable");
    assert.deepEqual(t.umgCalls, []);
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.attempts[0].processorStatus, "LINK_UNKNOWN");
    assert.equal(o.routing.attempts[0].outcome, "link_unknown");
    const route = await t.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(route.body.processor, "cleffo");
    // explicit "never sent": the spare is fine
    const e2 = emailIn("cleffo", "b3b");
    t.cl.state.createThrow = Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const bad = await t.charge(e2, "K-B3-2");
    assert.equal(bad.status, 503);
    assert.equal(t.store.getOrder(bad.body.orderId).attempts[0].processorStatus, "LINK_ERROR");
    const route2 = await t.post("/api/checkout/route", { customer: { email: e2 } });
    assert.equal(route2.body.processor, "umg");
    assert.equal(route2.body.reason, "retry_switch_link_error");
  } finally { t.server.close(); }
});

test("B3: a callback that names the merchant_order_id of a LINK_UNKNOWN attempt finds it, learns the reference and settles the order from the status API", async () => {
  const t = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "b3c");
    t.cl.state.createThrow = new Error("timeout");
    const r = await t.charge(e, "K-B3C-1");
    const o = t.store.getOrder(r.body.orderId);
    const merchant = o.attempts[0].merchantOrderId;
    t.cl.state.createThrow = null;
    t.cl.state.status.REFX = "completed";
    t.cl.state.amount.REFX = "20.00";
    t.cl.state.currency.REFX = "usd";
    t.cl.state.links.push({ ref: "REFX", body: { data: { merchant_order_id: merchant } } });
    const cb = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFX", merchant_order_id: merchant, payment_status: "completed" });
    assert.equal(cb.body.status, "paid");
    const done = t.store.getOrder(r.body.orderId);
    assert.equal(done.status, "approved");
    assert.equal(done.winningTxnId, "REFX");
  } finally { t.server.close(); }
});

test("B4: sweep asks again about a failed link while it lives; a payment after 'failed' is booked (LATE_PAID); not after the link lifetime", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const e = emailIn("cleffo", "b4");
    const r = await t.charge(e, "K-B4-1");
    t.cl.state.status.REF1api = "failed";
    await t.sweep(); // settles it as declined
    assert.equal(t.store.getOrder(r.body.orderId).status, "declined");
    const calls = t.cl.state.statusCalls;
    await t.sweep(); // failed, still failed: one more question, nothing changes
    assert.equal(t.cl.state.statusCalls, calls + 1);
    assert.equal(t.store.getOrder(r.body.orderId).status, "declined");
    t.cl.state.status.REF1api = "completed"; // the buyer paid on the same link with another card
    await t.sweep();
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "approved");
    assert.equal(o.winningTxnId, "REF1api");
    assert.equal(o.attempts[0].processorStatus, "PAID");
    assert.equal(alerts(cap.lines, "CLEFFO_LATE_PAID").length, 1);
    await new Promise((res) => setTimeout(res, 30));
    assert.equal(t.forwards.length, 1);
    // another order: failed, then older than the link lifetime -> no longer asked
    const r2 = await t.charge(emailIn("cleffo", "b4b"), "K-B4-2");
    t.cl.state.status.REF2api = "failed";
    await t.sweep();
    t.backdate(r2.body.orderId, 61);
    const c2 = t.cl.state.statusCalls;
    await t.sweep();
    assert.equal(t.cl.state.statusCalls, c2);
  } finally { cap.stop(); t.server.close(); }
});

test("B6: the sweeper never overlaps itself", async () => {
  const t = await setup();
  try {
    await t.charge(emailIn("cleffo", "b6"), "K-B6-1");
    let inflight = 0, maxInflight = 0;
    const slow = {
      config: CFG,
      fetchImpl: async (url, init) => {
        if (init.method === "POST") return t.cleffoDeps.fetchImpl(url, init);
        inflight += 1; maxInflight = Math.max(maxInflight, inflight);
        await new Promise((r) => setTimeout(r, 80));
        inflight -= 1;
        return t.cleffoDeps.fetchImpl(url, init);
      },
    };
    const stop = startCleffoSweeper(t.store, { intervalMs: 10, cleffoDeps: slow });
    await new Promise((r) => setTimeout(r, 350));
    stop();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(maxInflight, 1);
  } finally { t.server.close(); }
});

test("B6: an e-mail address inside a Cleffo error text is masked in the log and the alert", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    t.cl.state.failCreate = true;
    t.cl.state.failMessage = "invalid email jane.doe@example.org for customer";
    await t.charge(emailIn("cleffo", "b6m"), "K-B6M-1");
    const dump = cap.lines.join("\n");
    assert.doesNotMatch(dump, /jane\.doe@example\.org/);
    assert.match(dump, /j\*\*\*@example\.org/);
  } finally { cap.stop(); t.server.close(); }
});

// ---------- round 4 ----------

test("C1: a live link goes to another key only when EVERYTHING matches (email, name, phone digits, address, cart, amount, ship method, coupon)", async () => {
  const t = await setup({ routing: { ...ON, maxAttempts: 30 } });
  try {
    const e = emailIn("cleffo", "c1");
    const cust = { first_name: "Ann", last_name: "Lee", email: e, phone: "+1 (888) 123-4567", country: "US", state: "CA", city: "Los Angeles", zip: "90001", address: "1 Main St" };
    const l1 = await t.charge(e, "K-C1-1", { customer: cust });
    const orders = t.store.listOrders().length;
    // same data written differently (case, spaces, phone punctuation): still the same link
    const same = await t.charge(e, "K-C1-2", { customer: { ...cust, first_name: " ann ", address: "1  MAIN st", phone: "18881234567", city: "los angeles" } });
    assert.equal(same.body.reused, true);
    assert.equal(same.body.redirectUrl, l1.body.redirectUrl);
    assert.equal(t.store.listOrders().length, orders);
    // any one difference -> a fresh link for the new data
    const changes = [{ zip: "90002" }, { address: "2 Main St" }, { first_name: "Anna" }, { last_name: "Leigh" }, { phone: "8885550000" }, { country: "CA" }, { state: "NV" }, { city: "Reno" }];
    let i = 2;
    for (const ch of changes) {
      i += 1;
      const r = await t.charge(e, `K-C1-${i}`, { customer: { ...cust, ...ch } });
      assert.equal(r.status, 200);
      assert.equal(r.body.reused, undefined, JSON.stringify(ch));
      assert.notEqual(r.body.redirectUrl, l1.body.redirectUrl, JSON.stringify(ch));
    }
    assert.equal(t.cl.state.links.length, 1 + changes.length);
    // the corrected data is on the new order's own link
    const zipLink = t.cl.state.links[1].body.data.customer_detail.billing_address;
    assert.equal(zipLink.postal_code, "90002");
  } finally { t.server.close(); }
});

test("C1: ship method and coupon must match too; a different-data request with a card in the body still never reaches UMG while L1 lives", async () => {
  const t = await setup({ routing: { ...ON, maxAttempts: 30 } });
  try {
    const e = emailIn("cleffo", "c1b");
    const cust = { first_name: "Ann", last_name: "Lee", email: e, phone: "8881234567", zip: "90001", address: "1 Main St", country: "US", state: "CA", city: "LA" };
    const priceWith = (extra) => (b) => ({ ...priceOf("20.00")(b), ...extra });
    t.cfg.pricer = priceWith({ shipMethod: "standard", coupon: "" });
    const l1 = await t.charge(e, "K-C1B-1", { customer: cust });
    t.cfg.pricer = priceWith({ shipMethod: "express", coupon: "" });
    const ex = await t.charge(e, "K-C1B-2", { customer: cust });
    assert.equal(ex.body.reused, undefined);
    assert.notEqual(ex.body.redirectUrl, l1.body.redirectUrl);
    t.cfg.pricer = priceWith({ shipMethod: "standard", coupon: "INSIDER25" });
    const cp = await t.charge(e, "K-C1B-3", { customer: cust });
    assert.equal(cp.body.reused, undefined);
    t.cfg.pricer = priceWith({ shipMethod: "standard", coupon: "" });
    const back = await t.charge(e, "K-C1B-4", { customer: cust });
    assert.equal(back.body.reused, true);
    t.cl.state.failCreate = true;
    const withCard = await t.charge(e, "K-C1B-5", { customer: { ...cust, zip: "10001" }, card: CARD });
    assert.equal(withCard.status, 503);
    assert.deepEqual(t.umgCalls, []);
  } finally { t.server.close(); }
});

test("C2: an unsigned callback names a LINK_UNKNOWN attempt by merchant_order_id: a made-up ref is NOT recorded; the real one is, and settles the payment", async () => {
  const t = await setup({ routing: ON });
  try {
    t.cl.state.createThrow = new Error("timeout");
    const r = await t.charge(emailIn("cleffo", "c2"), "K-C2-1");
    const merchant = t.store.getOrder(r.body.orderId).attempts[0].merchantOrderId;
    t.cl.state.createThrow = null;
    const fake = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "FAKE9", merchant_order_id: merchant, payment_status: "completed" });
    assert.equal(fake.body.error, "unknown_transaction");
    let o = t.store.getOrder(r.body.orderId);
    assert.equal(o.attempts[0].processorTxnId, null);
    assert.equal(o.attempts[0].processorStatus, "LINK_UNKNOWN");
    // Cleffo knows the ref but for ANOTHER merchant_order_id: refused as well
    t.cl.state.links.push({ ref: "REFOTHER", body: { data: { merchant_order_id: "SOMEONEELSE1" } } });
    t.cl.state.status.REFOTHER = "completed"; t.cl.state.amount.REFOTHER = "20.00"; t.cl.state.currency.REFOTHER = "usd";
    const other = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFOTHER", merchant_order_id: merchant });
    assert.equal(other.body.error, "unknown_transaction");
    assert.equal(t.store.getOrder(r.body.orderId).attempts[0].processorTxnId, null);
    // the real one
    t.cl.state.links.push({ ref: "REFREAL", body: { data: { merchant_order_id: merchant } } });
    t.cl.state.status.REFREAL = "completed"; t.cl.state.amount.REFREAL = "20.00"; t.cl.state.currency.REFREAL = "usd";
    const real = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFREAL", merchant_order_id: merchant });
    assert.equal(real.body.status, "paid");
    o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "approved");
    assert.equal(o.winningTxnId, "REFREAL");
  } finally { t.server.close(); }
});

test("C2: an attempt that already has a reference is never re-pointed by a callback that only knows the merchant_order_id", async () => {
  const cap = captureLogs();
  const t = await setup({ routing: ON });
  try {
    const r = await t.charge(emailIn("cleffo", "c2b"), "K-C2B-1");
    const o0 = t.store.getOrder(r.body.orderId);
    const merchant = o0.attempts[0].merchantOrderId;
    t.cl.state.links.push({ ref: "REFEVIL", body: { data: { merchant_order_id: merchant } } });
    t.cl.state.status.REFEVIL = "completed"; t.cl.state.amount.REFEVIL = "20.00"; t.cl.state.currency.REFEVIL = "usd";
    const cb = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFEVIL", merchant_order_id: merchant });
    assert.equal(cb.body.error, "unknown_transaction");
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.attempts[0].processorTxnId, "REF1api");
    assert.equal(o.status, "awaiting_payment");
    assert.ok(cap.lines.some((l) => l.startsWith("[cleffo] callback ref_conflict")));
  } finally { cap.stop(); t.server.close(); }
});

test("C3: a paid order whose buyer already has another approved order with the same cart and amount raises CLEFFO_SAME_BUYER_PAID (order stays approved)", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const e = emailIn("cleffo", "c3");
    const a = await t.charge(e, "K-C3-1");
    t.cl.state.status.REF1api = "completed";
    await t.sweep();
    assert.equal(t.store.getOrder(a.body.orderId).status, "approved");
    assert.deepEqual(alerts(cap.lines, "CLEFFO_SAME_BUYER_PAID"), []);
    const first = t.store.getOrder(a.body.orderId); // older than the 15-minute repeat-order guard, which would refuse an immediate twin
    first.createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    t.store.upsertOrder(first);
    const b = await t.charge(e, "K-C3-2"); // a second checkout of the same cart
    t.cl.state.status.REF2api = "completed";
    await t.sweep();
    assert.equal(t.store.getOrder(b.body.orderId).status, "approved");
    const al = alerts(cap.lines, "CLEFFO_SAME_BUYER_PAID");
    assert.equal(al.length, 1);
    assert.match(al[0], new RegExp(`CLEFFO_SAME_BUYER_PAID ${b.body.orderId} other=${a.body.orderId}$`));
    // another cart / another buyer: no alert
    t.cfg.pricer = priceOf("35.00");
    const c = await t.charge(e, "K-C3-3", { items: [{ sku: "kpv-10mg", name: "KPV", qty: 1, amount: "35.00" }] });
    t.cl.state.status.REF3api = "completed";
    await t.sweep();
    assert.equal(alerts(cap.lines, "CLEFFO_SAME_BUYER_PAID").length, 1);
    assert.equal(t.store.getOrder(c.body.orderId).status, "approved");
  } finally { cap.stop(); t.server.close(); }
});

test("C4: after a LINK_UNKNOWN the same key tries again: new attempt number, new merchant_order_id, new link", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "c4");
    t.cl.state.createThrow = new Error("timeout");
    const bad = await t.charge(e, "K-C4-1");
    assert.equal(bad.status, 503);
    t.cl.state.createThrow = null;
    const ok = await t.charge(e, "K-C4-1");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.attempt, 2);
    const o = t.store.getOrder(ok.body.orderId);
    assert.equal(o.attempts.length, 2);
    assert.equal(o.attempts[0].processorStatus, "LINK_UNKNOWN");
    assert.equal(o.attempts[1].processorStatus, "LINK_CREATED");
    assert.notEqual(o.attempts[0].merchantOrderId, o.attempts[1].merchantOrderId);
    assert.equal(t.cl.state.links.length, 1);
  } finally { t.server.close(); }
});

// ---------- round 5 ----------

test("D1: Cleffo's status API failing during a merchant_order_id callback = 503 + CLEFFO_CALLBACK_UNVERIFIED (once per ref), nothing written; a mismatch stays a 200 unknown_transaction; a missing ref is ref_missing", async () => {
  const cap = captureLogs();
  const t = await setup({ routing: ON });
  try {
    t.cl.state.createThrow = new Error("timeout");
    const r = await t.charge(emailIn("cleffo", "d1"), "K-D1-1");
    const merchant = t.store.getOrder(r.body.orderId).attempts[0].merchantOrderId;
    t.cl.state.createThrow = null;
    t.cl.state.statusFail = true;
    const down = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFD1", merchant_order_id: merchant });
    assert.equal(down.status, 503);
    const again = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFD1", merchant_order_id: merchant });
    assert.equal(again.status, 503);
    const al = alerts(cap.lines, "CLEFFO_CALLBACK_UNVERIFIED");
    assert.equal(al.length, 1);
    assert.match(al[0], new RegExp(`CLEFFO_CALLBACK_UNVERIFIED ${r.body.orderId} attempt=1 ref=REFD1$`));
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.attempts[0].processorTxnId, null);
    assert.equal(o.attempts[0].processorStatus, "LINK_UNKNOWN");
    assert.equal(o.status, "declined");
    // another ref is a separate alert
    await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFD2", merchant_order_id: merchant });
    assert.equal(alerts(cap.lines, "CLEFFO_CALLBACK_UNVERIFIED").length, 2);
    // the API answers, but for another merchant_order_id: as before, 200 unknown_transaction, ref_rejected, no alert
    t.cl.state.statusFail = false;
    t.cl.state.links.push({ ref: "REFD3", body: { data: { merchant_order_id: "OTHERONE1" } } });
    t.cl.state.status.REFD3 = "completed"; t.cl.state.amount.REFD3 = "20.00"; t.cl.state.currency.REFD3 = "usd";
    const mism = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REFD3", merchant_order_id: merchant });
    assert.equal(mism.status, 200);
    assert.equal(mism.body.error, "unknown_transaction");
    assert.ok(cap.lines.some((l) => l.startsWith("[cleffo] callback ref_rejected")));
    assert.equal(alerts(cap.lines, "CLEFFO_CALLBACK_UNVERIFIED").length, 2);
    // no ref at all
    const none = await t.post("/api/checkout/cleffo/callback", { merchant_order_id: merchant });
    assert.equal(none.status, 200);
    assert.equal(none.body.error, "unknown_transaction");
    assert.ok(cap.lines.some((l) => l.startsWith("[cleffo] callback ref_missing")));
    assert.ok(!cap.lines.some((l) => l.startsWith("[cleffo] callback ref_conflict")));
  } finally { cap.stop(); t.server.close(); }
});

test("D2: the same-buyer twin must be created within the link lifetime of the paid order (either side): 30 min -> alert, 48 h -> none", async () => {
  const cap = captureLogs();
  const t = await setup();
  try {
    const e = emailIn("cleffo", "d2");
    const a = await t.charge(e, "K-D2-1");
    t.cl.state.status.REF1api = "completed";
    await t.sweep();
    const old = t.store.getOrder(a.body.orderId);
    old.createdAt = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    t.store.upsertOrder(old);
    const b = await t.charge(e, "K-D2-2");
    t.cl.state.status.REF2api = "completed";
    await t.sweep();
    assert.equal(t.store.getOrder(b.body.orderId).status, "approved");
    assert.deepEqual(alerts(cap.lines, "CLEFFO_SAME_BUYER_PAID"), []); // 48 h apart: an ordinary reorder
    const second = t.store.getOrder(b.body.orderId); // keep b out of the 15-minute repeat guard and out of the 60-minute twin window
    second.createdAt = new Date(Date.now() - 47 * 3600 * 1000).toISOString();
    t.store.upsertOrder(second);
    old.createdAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    t.store.upsertOrder(old);
    const c = await t.charge(e, "K-D2-3");
    t.cl.state.status.REF3api = "completed";
    await t.sweep();
    const al = alerts(cap.lines, "CLEFFO_SAME_BUYER_PAID");
    assert.equal(al.length, 1);
    assert.match(al[0], new RegExp(`CLEFFO_SAME_BUYER_PAID ${c.body.orderId} other=`));
  } finally { cap.stop(); t.server.close(); }
});
