import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { createConsentLog } from "../lib/consent.js";
import { bucketFor } from "../lib/routing.js";
import { returnToken } from "../lib/cleffo.js";
import { startCrmServer } from "../index.js";

// audit 2026-10-02: the order object in the answers of the open checkout routes is a white list (id, status, amount, currency).
// Everything else on the stored order (processor txn ids, raw processor answers, retry key, buyer data, consent, hold reasons)
// stays on the server; staff routes still return the full order.

const CFG = { env: "sandbox", baseUrl: "https://apis-dev.cleffo.com", clientKey: "ck-test", signatureKey: "sig-test", apiKey: "api-test", baseUrlMismatch: false };
const CONSENT = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T15:40:00.000Z", pageVersion: "v-test" };
const CARD = { name: "Q A", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
const cardPricer = (b) => ({ ok: true, amount: "20.00", clientAmount: b.amount, mismatch: false, source: "test", subtotal: "20.00", shipping: "0.00", shipMethod: "", lines: [] });
const ON = { cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 50, maxAttempts: 3, retryWindowMin: 120 };
const OFF = { ...ON, cleffoEnabled: false };
const SECRET_TXN = "TXN-SECRET-424242";
const FORBIDDEN = new Set(["attempts", "processortxnid", "winningtxnid", "idempotencykey", "cardkey", "raw", "compliancehold", "customer", "pricecheck", "attribution", "notes", "session_id", "sessionid", "routing"]);

function emailIn(bucket, tag) {
  for (let i = 0; ; i += 1) { const e = `qa-${tag}-${i}@example.test`; if (bucketFor(e, 50) === bucket) return e; }
}

function forbiddenPaths(v, path = "$", out = []) {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenPaths(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.has(k.toLowerCase()) || k.toLowerCase().startsWith("consent")) out.push(`${path}.${k}`);
      forbiddenPaths(x, `${path}.${k}`, out);
    }
  }
  return out;
}

function assertClean(body) {
  assert.deepEqual(forbiddenPaths(body), [], "internal fields in a public answer");
  assert.doesNotMatch(JSON.stringify(body), new RegExp(`${SECRET_TXN}|ada@lab\\.example|qa-.*@example\\.test|processor-raw-secret`));
}

function assertOrderView(order, { id, status }) {
  assert.deepEqual(Object.keys(order).sort(), ["amount", "currency", "id", "status"]);
  if (id) assert.equal(order.id, id);
  if (status) assert.equal(String(order.status).toLowerCase(), status);
  assert.ok(order.amount != null);
  assert.equal(order.currency, "USD");
}

function cleffoMock() {
  const state = { links: [], status: {}, amount: {} };
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      const ref = `REF${state.links.length + 1}api`;
      state.links.push({ ref, body });
      state.status[ref] = "pending";
      state.amount[ref] = String(body.data.price.total.toFixed(2));
      return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_link: `https://dev.cleffo.com/pay/api-checkout-session/${ref}`, transaction_reference_number: ref, merchant_order_id: body.data.merchant_order_id } }) };
    }
    const ref = url.split("/").slice(-2)[0];
    const link = state.links.find((l) => l.ref === ref);
    return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_status: state.status[ref], total_amount: state.amount[ref], currency: "usd", merchant_order_id: link?.body.data.merchant_order_id } }) };
  };
  return { state, fetchImpl };
}

async function setup({ routing = OFF, umg = "approve" } = {}) {
  process.env.PAYMENTS_ENABLED = "true";
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: true, priority: 2, mode: "sandbox" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const consentLog = createConsentLog({ filePath: join(mkdtempSync(join(tmpdir(), "pcb-consent-")), "consent-log.jsonl") });
  const cl = cleffoMock();
  const server = await startCrmServer(0, {
    store, consentLog, publicUrl: "https://crm.test", routingConfig: () => routing, cardPricer,
    cleffoDeps: { config: CFG, fetchImpl: cl.fetchImpl },
    forwardFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }),
    checkCrmSession: async (token) => (token === "good-session" ? { email: "staff@biolabsresearch.co", role: "staff" } : false),
    adapters: {
      umg: { async createPayment() {
        const raw = { id: SECRET_TXN, note: "processor-raw-secret" };
        if (umg === "soft") return { ok: false, processor: "umg", processorTxnId: SECRET_TXN, processorStatus: "DECLINED", informationData: "Activity limit exceeded; Code:203", cascadeAction: "next", declineClass: "soft", raw };
        if (umg === "hard") return { ok: false, processor: "umg", processorTxnId: SECRET_TXN, processorStatus: "DECLINED", informationData: "Do not honor", informationCode: "05", cascadeAction: "stop", declineClass: "hard", raw };
        if (umg === "unknown") return { ok: false, processor: "umg", processorTxnId: null, processorStatus: "UNKNOWN", cascadeAction: "wait", declineClass: "soft", reason: "unknown_outcome", raw };
        return { ok: true, processor: "umg", processorTxnId: SECRET_TXN, processorStatus: "APPROVED", cascadeAction: "success", descriptor: "PEPTIDESS SHOP", raw };
      } },
      tagada: { async createPayment() { return { ok: false, processor: "tagada", processorStatus: "DECLINED", cascadeAction: "stop", raw: {} }; } },
      centrobill: {},
    },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const r = await fetch(`${base}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const charge = (email, key, extra = {}) => post("/api/checkout/charge", {
    idempotencyKey: key, session_id: `S-${email}`, customer: { first_name: "Ada", last_name: "Lab", email, phone: "8881234567" },
    notes: "private buyer note", card: CARD, amount: "20.00", items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 1, amount: "20.00" }], consent: CONSENT, ...extra,
  });
  return { store, server, base, cl, post, charge };
}

test("UMG approved + replay under the same key: public order is id/status/amount/currency only", async () => {
  const t = await setup();
  try {
    const r = await t.charge("ada@lab.example", "PCB-OK");
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assertClean(r.body);
    assertOrderView(r.body.order, { status: "approved" });
    assert.equal(r.body.chargedAmount, r.body.order.amount);
    assert.equal(r.body.priceAdjusted, false);
    assert.equal(r.body.processor, "umg");
    assert.equal(r.body.attempt, 1);
    // the stored order still holds the internals
    const stored = t.store.getOrderByIdempotency("PCB-OK");
    assert.equal(stored.winningTxnId, SECRET_TXN);
    assert.ok(stored.attempts.length >= 1);
    const again = await t.charge("ada@lab.example", "PCB-OK");
    assert.equal(again.body.reused, true);
    assertClean(again.body);
    assertOrderView(again.body.order, { id: r.body.order.id, status: "approved" });
  } finally { t.server.close(); }
});

test("UMG declined (soft with Cleffo on, hard) and unknown outcome: no internals in the answer", async () => {
  for (const mode of ["soft", "hard", "unknown"]) {
    const t = await setup({ routing: mode === "soft" ? ON : OFF, umg: mode });
    try {
      const email = mode === "soft" ? emailIn("umg", "pcb") : `ada-${mode}@lab.example`;
      const r = await t.charge(email, `PCB-${mode}`);
      assertClean(r.body);
      assert.ok(r.body.order, `${mode}: the page reads order.status`);
      assertOrderView(r.body.order, { status: mode === "unknown" ? "pending" : "declined" });
      if (mode === "unknown") { assert.equal(r.body.pending, true); assert.equal(r.body.charged, "unknown"); }
      else { assert.equal(r.status, 402); assert.equal(r.body.ok, false); }
      if (mode === "soft") assert.ok(r.body.next, "next step is kept");
      const again = await t.charge(email, `PCB-${mode}`);
      assertClean(again.body);
    } finally { t.server.close(); }
  }
});

test("Cleffo: redirect, reused link, paid replay and cleffo/status carry no internals", async () => {
  const t = await setup({ routing: ON });
  try {
    const e = emailIn("cleffo", "pcb");
    const r = await t.charge(e, "PCB-CL1");
    assert.equal(r.status, 200);
    assert.match(r.body.redirectUrl, /^https:\/\/dev\.cleffo\.com\/pay\//);
    assertClean(r.body);
    const id = r.body.orderId;
    const reused = await t.charge(e, "PCB-CL1");
    assert.equal(reused.body.reused, true);
    assertClean(reused.body);
    // settle through the return URL, then the same key again = approvedAnswer (carries order: o)
    t.cl.state.status.REF1api = "completed";
    const back = new URL(t.cl.state.links[0].body.metadata.redirect_url);
    await fetch(`${t.base}${back.pathname}${back.search}`, { redirect: "manual" });
    const paid = await t.charge(e, "PCB-CL1");
    assert.equal(paid.body.reused, true);
    assertClean(paid.body);
    assertOrderView(paid.body.order, { id, status: "approved" });
    const st = await (await fetch(`${t.base}/api/checkout/cleffo/status?o=${id}&a=1&t=${returnToken(id, 1, "sig-test")}`)).json();
    assert.equal(st.status, "paid");
    assertClean(st);
    assert.equal(st.orderId, id);
    assert.ok(st.amount != null);
    assert.equal(st.currency, "USD");
    const route = await t.post("/api/checkout/route", { customer: { email: e } });
    assertClean(route.body);
  } finally { t.server.close(); }
});

test("staff route /api/store-orders keeps the full order; anonymous gets 401", async () => {
  const t = await setup();
  try {
    const r = await t.charge("ada@lab.example", "PCB-STAFF");
    const id = r.body.order.id;
    assert.equal((await fetch(`${t.base}/api/store-orders/${id}`)).status, 401);
    const one = await (await fetch(`${t.base}/api/store-orders/${id}`, { headers: { Authorization: "Bearer good-session" } })).json();
    assert.equal(one.order.winningTxnId, SECRET_TXN);
    assert.equal(one.order.customer.email, "ada@lab.example");
    assert.ok(Array.isArray(one.order.attempts) && one.order.attempts.length >= 1);
    assert.equal(one.order.idempotencyKey, "PCB-STAFF");
    const list = await (await fetch(`${t.base}/api/store-orders`, { headers: { Authorization: "Bearer good-session" } })).json();
    assert.equal(list.orders.find((o) => o.id === id).winningTxnId, SECRET_TXN);
  } finally { t.server.close(); }
});
