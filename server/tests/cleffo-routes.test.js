import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { createConsentLog } from "../lib/consent.js";
import { bucketFor } from "../lib/routing.js";
import { returnToken } from "../lib/cleffo.js";
import { startCrmServer } from "../index.js";

const CFG = { env: "sandbox", baseUrl: "https://apis-dev.cleffo.com", clientKey: "ck-test", signatureKey: "sig-test", apiKey: "api-test", baseUrlMismatch: false };
const CONSENT = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T15:40:00.000Z", pageVersion: "v-test" };
const CARD = { name: "Q A", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
const HARD_CARD = { name: "Q A", number: "4111111111110003", month: "11", year: "29", cvv: "123" };
// A new Cleffo order needs a server-side price (cleffo part 4): tests price every cart at 20.00.
const cardPricer = (b) => ({ ok: true, amount: "20.00", clientAmount: b.amount, mismatch: false, source: "test", subtotal: "20.00", shipping: "0.00", shipMethod: "", lines: [] });
const ON = { cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 50, maxAttempts: 3, retryWindowMin: 120 };

function emailIn(bucket, tag) {
  for (let i = 0; ; i += 1) { const e = `qa-${tag}-${i}@example.test`; if (bucketFor(e, 50) === bucket) return e; }
}

function cleffoMock() {
  const state = { links: [], statusCalls: 0, status: {}, amount: {}, failCreate: false };
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      if (state.failCreate) return { status: 500, text: async () => JSON.stringify({ status: false, message: "An unexpected error occurred." }) };
      const body = JSON.parse(init.body);
      const ref = `REF${state.links.length + 1}api`;
      state.links.push({ ref, body, sig: init.headers["x-signature"] });
      state.status[ref] = "pending";
      state.amount[ref] = String(body.data.price.total.toFixed(2));
      return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_link: `https://dev.cleffo.com/pay/api-checkout-session/${ref}`, transaction_reference_number: ref, merchant_order_id: body.data.merchant_order_id } }) };
    }
    state.statusCalls += 1;
    const ref = url.split("/").slice(-2)[0];
    const link = state.links.find((l) => l.ref === ref);
    return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_status: state.status[ref], total_amount: state.amount[ref], currency: "usd", merchant_order_id: link?.body.data.merchant_order_id, transaction_reference_number: ref } }) };
  };
  return { state, fetchImpl };
}

async function setup({ routing = ON, umg } = {}) {
  process.env.PAYMENTS_ENABLED = "true";
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: true, priority: 2, mode: "sandbox" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const logFile = join(mkdtempSync(join(tmpdir(), "cleffo-consent-")), "consent-log.jsonl");
  const consentLog = createConsentLog({ filePath: logFile });
  const cl = cleffoMock();
  const umgCalls = [];
  const tagadaCalls = [];
  const forwards = [];
  let umgMode = umg || "approve";
  const server = await startCrmServer(0, {
    store,
    consentLog,
    publicUrl: "https://crm.test",
    routingConfig: () => routing,
    cardPricer,
    cleffoDeps: { config: CFG, fetchImpl: cl.fetchImpl },
    forwardFetch: async (url, init) => { forwards.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }; },
    adapters: {
      umg: { async createPayment(p) {
        umgCalls.push(p.amount);
        if (umgMode === "soft") return { ok: false, processor: "umg", processorTxnId: `U${umgCalls.length}`, processorStatus: "DECLINED", informationData: "Activity limit exceeded; Code:203", cascadeAction: "next", declineClass: "soft", reason: "soft_decline", raw: {} };
        if (umgMode === "hard") return { ok: false, processor: "umg", processorTxnId: `U${umgCalls.length}`, processorStatus: "DECLINED", informationData: "Do not honor", informationCode: "05", cascadeAction: "stop", declineClass: "hard", reason: "hard_decline", raw: {} };
        return { ok: true, processor: "umg", processorTxnId: `U${umgCalls.length}`, processorStatus: "APPROVED", cascadeAction: "success", descriptor: "PEPTIDESS SHOP", raw: {} };
      } },
      tagada: { async createPayment() { tagadaCalls.push(1); return { ok: true, processor: "tagada", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } },
      centrobill: {},
    },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body, headers = {}) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const charge = (email, key, extra = {}) => post("/api/checkout/charge", {
    idempotencyKey: key, session_id: `S-${email}`, customer: { first_name: "QA", last_name: "Test", email, phone: "8881234567" },
    card: CARD, amount: "20.00", items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 1, amount: "20.00" }], consent: CONSENT, ...extra,
  });
  return { store, server, base, cl, umgCalls, tagadaCalls, forwards, logFile, post, charge, setUmg: (m) => { umgMode = m; } };
}

function qs(u) { return new URL(u).searchParams; }

test("flag off: UMG only (cascade unchanged), processor + attempt logged, Cleffo never called", async () => {
  const t = await setup({ routing: { ...ON, cleffoEnabled: false } });
  try {
    const e = emailIn("cleffo", "off");
    const r = await t.charge(e, "K-OFF-1");
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "umg");
    assert.equal(r.body.attempt, 1);
    assert.equal(r.body.statementDescriptor, "PEPTIDESS SHOP");
    assert.equal(t.cl.state.links.length, 0);
    const o = t.store.getOrder(r.body.order.id);
    assert.equal(o.paymentProcessor, "umg");
    assert.equal(o.routing.attempts[0].reason, "cleffo_disabled");
    const route = await t.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(route.body.processor, "umg");
    assert.equal(route.body.cleffoEnabled, false);
  } finally { t.server.close(); }
});

test("cleffo bucket: consent recorded + confirmed before the link; redirectUrl returned; nothing charged", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "a");
    const pre = await t.post("/api/checkout/route", { customer: { email: e } });
    assert.equal(pre.body.processor, "cleffo");
    assert.equal(pre.body.statementDescriptor, null);
    assert.equal(pre.body.statementDescriptorConfirmed, false);
    const r = await t.charge(e, "K-A1");
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "cleffo");
    assert.match(r.body.redirectUrl, /^https:\/\/dev\.cleffo\.com\/pay\//);
    assert.equal(r.body.charged, false);
    assert.equal(r.body.statementDescriptorConfirmed, false);
    assert.deepEqual(t.umgCalls, []);
    const link = t.cl.state.links[0];
    assert.equal(link.body.data.products[0].name, `BioLabs Research order ${r.body.orderId}`);
    assert.doesNotMatch(JSON.stringify(link.body), /BPC|bpc/);
    const back = new URL(link.body.metadata.redirect_url);
    assert.equal(back.origin + back.pathname, "https://crm.test/api/checkout/cleffo/return");
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "awaiting_payment");
    assert.equal(o.consent.recorded, true);
    assert.equal(o.consent.confirmedBeforeRedirect, true);
    const rec = readFileSync(t.logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(rec.length, 1);
    assert.equal(rec[0].channel, "card-cleffo");
    assert.equal(rec[0].orderId, r.body.orderId);
    // double submit inside the reuse window -> same link, no new link / consent record
    const again = await t.charge(e, "K-A1");
    assert.equal(again.body.reused, true);
    assert.equal(again.body.redirectUrl, r.body.redirectUrl);
    assert.equal(t.cl.state.links.length, 1);
  } finally { t.server.close(); }
});

test("consent missing / invalid / unconfirmable -> no redirect and no payment link", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "c");
    const missing = await t.charge(e, "K-C1", { consent: undefined });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error, "consent_missing");
    assert.equal(missing.body.redirectUrl, undefined);
    const unticked = await t.charge(e, "K-C2", { consent: { ...CONSENT, checks: { "ck-terms": true, "ck-ruo": false } } });
    assert.equal(unticked.status, 400);
    assert.equal(unticked.body.error, "consent_invalid");
    assert.equal(t.cl.state.links.length, 0);
    assert.deepEqual(t.umgCalls, []);
  } finally { t.server.close(); }
  // Log that cannot be written / read back -> still no redirect
  const t2 = await setup();
  try {
    const e = emailIn("cleffo", "c2");
    const brokenLog = { append() { throw new Error("disk full"); }, find() { return []; }, now: () => new Date() };
    t2.server.close();
    const store = createStore({ memoryOnly: true });
    const cl = cleffoMock();
    const s = await startCrmServer(0, { store, consentLog: brokenLog, publicUrl: "https://crm.test", routingConfig: () => ON, cardPricer, cleffoDeps: { config: CFG, fetchImpl: cl.fetchImpl }, adapters: { umg: {}, tagada: {}, centrobill: {} } });
    const r = await fetch(`http://127.0.0.1:${s.address().port}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: "K-C3", customer: { email: e, first_name: "Q" }, amount: "20.00", items: [], consent: CONSENT }) });
    const b = await r.json();
    s.close();
    assert.equal(r.status, 503);
    assert.equal(b.error, "consent_not_confirmed");
    assert.equal(b.redirectUrl, undefined);
    assert.equal(cl.state.links.length, 0);
  } finally { t2.server.close(); }
});

test("return: bad token rejected; good token settles from the status API only; idempotent (one forward)", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "r");
    const r = await t.charge(e, "K-R1");
    const id = r.body.orderId;
    const back = new URL(t.cl.state.links[0].body.metadata.redirect_url);
    const bad = await fetch(`${t.base}/api/checkout/cleffo/return?o=${id}&a=1&t=deadbeef`, { redirect: "manual" });
    assert.equal(bad.status, 400);
    // redirect while Cleffo still says pending -> not paid
    const p = await fetch(`${t.base}${back.pathname}${back.search}`, { redirect: "manual" });
    assert.equal(p.status, 302);
    assert.equal(qs(p.headers.get("location")).get("status"), "pending");
    assert.equal(t.store.getOrder(id).status, "awaiting_payment");
    t.cl.state.status.REF1api = "completed";
    const ok = await fetch(`${t.base}${back.pathname}${back.search}`, { redirect: "manual" });
    const loc = qs(ok.headers.get("location"));
    assert.equal(loc.get("status"), "paid");
    assert.equal(loc.get("order"), id);
    const o = t.store.getOrder(id);
    assert.equal(o.status, "approved");
    assert.equal(o.winningProcessor, "cleffo");
    assert.equal(o.routing.attempts.at(-1).outcome, "paid");
    const calls = t.cl.state.statusCalls;
    await fetch(`${t.base}${back.pathname}${back.search}`, { redirect: "manual" });
    const st = await (await fetch(`${t.base}/api/checkout/cleffo/status?o=${id}&a=1&t=${returnToken(id, 1, "sig-test")}`)).json();
    assert.equal(st.status, "paid");
    const cb = await t.post("/api/checkout/cleffo/callback", { transaction_reference_number: "REF1api", payment_status: "completed" });
    assert.equal(cb.body.status, "paid");
    assert.equal(cb.body.signature, "absent");
    assert.equal(t.cl.state.statusCalls, calls); // settled: no more status calls
    await new Promise((res) => setTimeout(res, 50));
    assert.equal(t.forwards.length, 1);
    assert.equal(t.forwards[0].paymentMethod, "card-cleffo");
    // Cleffo marked paid but for a different amount -> review, never approved
    const e2 = emailIn("cleffo", "r2");
    const r2 = await t.charge(e2, "K-R2");
    t.cl.state.status.REF2api = "completed";
    t.cl.state.amount.REF2api = "1.00";
    const back2 = new URL(t.cl.state.links[1].body.metadata.redirect_url);
    const m = await fetch(`${t.base}${back2.pathname}${back2.search}`, { redirect: "manual" });
    assert.equal(qs(m.headers.get("location")).get("status"), "review");
    assert.equal(t.store.getOrder(r2.body.orderId).status, "review");
  } finally { t.server.close(); }
});

test("Cleffo failed (no reason code) = hard, fail closed: next attempt stays on Cleffo, never UMG", async () => {
  const t = await setup();
  try {
    const e = emailIn("cleffo", "f");
    const r = await t.charge(e, "K-F1");
    t.cl.state.status.REF1api = "failed";
    const back = new URL(t.cl.state.links[0].body.metadata.redirect_url);
    const d = await fetch(`${t.base}${back.pathname}${back.search}`, { redirect: "manual" });
    assert.equal(qs(d.headers.get("location")).get("status"), "declined");
    const o = t.store.getOrder(r.body.orderId);
    assert.equal(o.status, "declined");
    assert.equal(o.routing.attempts[0].retryClass, "hard");
    assert.equal(o.routing.attempts[0].retryBasis, "unknown_fail_closed");
    const st = await (await fetch(`${t.base}/api/checkout/cleffo/status?o=${o.id}&a=1&t=${returnToken(o.id, 1, "sig-test")}`)).json();
    assert.equal(st.next.nextProcessor, "cleffo");
    const r2 = await t.charge(e, "K-F2");
    assert.equal(r2.body.processor, "cleffo");
    assert.deepEqual(t.umgCalls, []);
    assert.equal(t.store.getOrder(r2.body.orderId).routing.attempts[0].reason, "retry_same_hard");
  } finally { t.server.close(); }
});

test("UMG soft decline -> next attempt switches to Cleffo once; after that it stays; cap at 3", async () => {
  const t = await setup({ umg: "soft" });
  try {
    const e = emailIn("umg", "s");
    const r1 = await t.charge(e, "K-S1");
    assert.equal(r1.status, 402);
    assert.equal(r1.body.processor, "umg");
    assert.deepEqual(t.tagadaCalls, []); // Cleffo on: UMG route charges UMG only
    assert.equal(r1.body.next.nextProcessor, "cleffo");
    const o1 = t.store.getOrder(r1.body.order.id);
    assert.equal(o1.routing.attempts[0].retryClass, "soft");
    const r2 = await t.charge(e, "K-S2");
    assert.equal(r2.body.processor, "cleffo");
    t.cl.state.status.REF1api = "failed";
    const back = new URL(t.cl.state.links[0].body.metadata.redirect_url);
    await fetch(`${t.base}${back.pathname}${back.search}`, { redirect: "manual" });
    const r3 = await t.charge(e, "K-S3"); // Cleffo failed = hard -> stays Cleffo (and the one switch is used)
    assert.equal(r3.body.processor, "cleffo");
    assert.equal(r3.body.attempt, 3);
    t.cl.state.status.REF2api = "failed";
    const back2 = new URL(t.cl.state.links[1].body.metadata.redirect_url);
    await fetch(`${t.base}${back2.pathname}${back2.search}`, { redirect: "manual" });
    const r4 = await t.charge(e, "K-S4");
    assert.equal(r4.status, 429);
    assert.equal(r4.body.error, "attempts_exhausted");
    assert.equal(r4.body.charged, false);
    assert.equal(t.umgCalls.length, 1);
  } finally { t.server.close(); }
});

test("UMG hard decline -> never switched to Cleffo; the same card is refused; a different card stays on UMG", async () => {
  const t = await setup({ umg: "hard" });
  try {
    const e = emailIn("umg", "h");
    const r1 = await t.charge(e, "K-H1", { card: HARD_CARD });
    assert.equal(r1.status, 402);
    assert.equal(t.store.getOrder(r1.body.order.id).routing.attempts[0].retryClass, "hard");
    assert.equal(r1.body.next.nextProcessor, "umg");
    const same = await t.charge(e, "K-H2", { card: HARD_CARD });
    assert.equal(same.status, 429);
    assert.equal(same.body.error, "hard_decline_same_card");
    t.setUmg("approve");
    const other = await t.charge(e, "K-H3");
    assert.equal(other.status, 200);
    assert.equal(other.body.processor, "umg");
    assert.equal(t.cl.state.links.length, 0);
  } finally { t.server.close(); }
});

test("Cleffo link error (no charge attempted) falls back to UMG for that attempt; staff settings view has no key values", async () => {
  const t = await setup();
  try {
    t.cl.state.failCreate = true;
    const e = emailIn("cleffo", "l");
    const r = await t.charge(e, "K-L1");
    assert.equal(r.status, 200);
    assert.equal(r.body.processor, "umg");
    const o = t.store.getOrder(r.body.order.id);
    assert.equal(o.routing.attempts.find((a) => a.processor === "cleffo").countsAsAttempt, false);
    assert.equal(o.routing.attempts.at(-1).reason, "cleffo_unavailable_fallback");
    const noAuth = await fetch(`${t.base}/api/psp/cleffo`);
    assert.equal(noAuth.status, 401);
  } finally { t.server.close(); }
});
