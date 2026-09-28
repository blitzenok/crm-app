#!/usr/bin/env node
/**
 * Cleffo SANDBOX end-to-end check (never live). Runs the real CRM handler in-process with an in-memory store and a
 * temp consent log, routing forced to Cleffo, and the real sandbox API:
 *   charge (qa-test+cleffo@biolabsresearch.co) -> payment link -> status API -> return (token) -> callback -> bad token.
 * Optional: --completed-ref <ref> reads a previously completed sandbox payment to check the "completed" mapping.
 * Usage: CLEFFO_ENV_PATH=/path/to/sandbox.env node server/scripts/cleffo-sandbox-e2e.mjs [--completed-ref REF]
 * Prints no key values.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CLEFFO_ENV = "sandbox";
process.env.PAYMENTS_ENABLED = "true";
const { loadCleffoConfig, cleffoKeyHealth, getPaymentStatus, returnToken } = await import("../lib/cleffo.js");
const { createStore } = await import("../lib/store.js");
const { createConsentLog } = await import("../lib/consent.js");
const { startCrmServer } = await import("../index.js");

const cfg = loadCleffoConfig({ ...process.env, CLEFFO_ENV: "sandbox" }, { envName: "sandbox" });
const health = cleffoKeyHealth(cfg);
if (!health.ready || /\/\/apis\.cleffo\.com/i.test(cfg.baseUrl)) {
  console.error("refusing: sandbox config not ready or points at production", health);
  process.exit(2);
}
const out = { baseUrl: cfg.baseUrl, steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); console.log(`- ${name}: ${JSON.stringify(data)}`); };

const store = createStore({ memoryOnly: true });
const consentLog = createConsentLog({ filePath: join(mkdtempSync(join(tmpdir(), "cleffo-e2e-")), "consent.jsonl") });
let umgCalled = 0;
const server = await startCrmServer(0, {
  store, consentLog, publicUrl: "https://crm.biolabsresearch.co",
  routingConfig: () => ({ cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 100, maxAttempts: 3, retryWindowMin: 120 }),
  cleffoDeps: { config: cfg },
  forwardFetch: null,
  adapters: { umg: { async createPayment() { umgCalled += 1; return { ok: false, processorStatus: "DECLINED", raw: {} }; } }, tagada: {}, centrobill: {} },
});
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const key = `QA-CLEFFO-${Date.now()}`;
  const body = {
    idempotencyKey: key, session_id: key,
    customer: { first_name: "QA", last_name: "Cleffo", email: "qa-test+cleffo@biolabsresearch.co", phone: "+1 888 123 4567", address: "1 Test St", city: "Austin", state: "TX", zip: "73301", country: "US" },
    amount: "20.00", items: [{ sku: "qa-test-item", name: "QA test item", qty: 1, amount: "20.00" }],
    consent: { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: new Date().toISOString(), pageVersion: "qa-e2e" },
  };
  const noConsent = await fetch(`${base}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idempotencyKey: `${key}-NC`, consent: undefined }) });
  const nc = await noConsent.json();
  step("charge without consent", { http: noConsent.status, error: nc.error, redirect: Boolean(nc.redirectUrl) });

  const r = await fetch(`${base}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const cb = await r.json();
  step("charge", { http: r.status, processor: cb.processor, orderId: cb.orderId, attempt: cb.attempt, redirectHost: cb.redirectUrl ? new URL(cb.redirectUrl).host : null, redirectUrl: cb.redirectUrl, charged: cb.charged, statementDescriptorConfirmed: cb.statementDescriptorConfirmed });
  if (!cb.redirectUrl) throw new Error(`no redirect: ${JSON.stringify(cb)}`);
  const order = store.getOrder(cb.orderId);
  const att = order.attempts.find((a) => a.processor === "cleffo");
  step("order after link", { status: order.status, ref: att.processorTxnId, merchantOrderId: att.merchantOrderId, consentConfirmedBeforeRedirect: order.consent?.confirmedBeforeRedirect === true, routing: order.routing.attempts.map((a) => `${a.n}:${a.processor}:${a.reason}`) });

  const st = await getPaymentStatus(att.processorTxnId, { config: cfg });
  step("status API (direct)", { ok: st.ok, payment_status: st.paymentStatus, total: st.totalAmount, currency: st.currency, merchant_order_id: st.merchantOrderId });

  const t = returnToken(order.id, att.routingAttempt, cfg.signatureKey);
  const ret = await fetch(`${base}/api/checkout/cleffo/return?o=${order.id}&a=${att.routingAttempt}&t=${t}`, { redirect: "manual" });
  const loc = ret.headers.get("location") || "";
  step("return handler (valid token)", { http: ret.status, storefrontStatus: new URL(loc).searchParams.get("status"), orderStatusAfter: store.getOrder(order.id).status });

  const bad = await fetch(`${base}/api/checkout/cleffo/return?o=${order.id}&a=${att.routingAttempt}&t=${"0".repeat(32)}`, { redirect: "manual" });
  step("return handler (forged token)", { http: bad.status, orderStatusAfter: store.getOrder(order.id).status });

  const cbk = await fetch(`${base}/api/checkout/cleffo/callback`, { method: "POST", headers: { "Content-Type": "application/json", "x-signature": "forged" }, body: JSON.stringify({ transaction_reference_number: att.processorTxnId, payment_status: "completed" }) });
  const cbj = await cbk.json();
  step("callback claiming completed (forged signature)", { http: cbk.status, signature: cbj.signature, settledAs: cbj.status, orderStatusAfter: store.getOrder(order.id).status });

  const s2 = await (await fetch(`${base}/api/checkout/cleffo/status?o=${order.id}&a=${att.routingAttempt}&t=${t}`)).json();
  step("storefront status JSON", { status: s2.status, processor: s2.processor, amount: s2.amount });

  const ci = process.argv.indexOf("--completed-ref");
  if (ci !== -1 && process.argv[ci + 1]) {
    const c = await getPaymentStatus(process.argv[ci + 1], { config: cfg });
    step("previously completed sandbox payment", { ref: process.argv[ci + 1], ok: c.ok, payment_status: c.paymentStatus, mapped: c.status, total: c.totalAmount, currency: c.currency });
  }
  step("umg adapter calls", { count: umgCalled });
} finally {
  server.close();
}
