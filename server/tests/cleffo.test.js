import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPaymentLinkBody, cleffoKeyHealth, createPaymentLink, getPaymentStatus, loadCleffoConfig, mapPaymentStatus,
  returnToken, signBody, verifyReturnToken, verifySignature,
} from "../lib/cleffo.js";
import { bucketFor, bucketValue, chooseProcessor, normalizeEmail, routingConfig, splitStats } from "../lib/routing.js";
import { classifyForRetry } from "../lib/retry-class.js";
import { descriptorFor, validateConsentForCleffo } from "../lib/cleffo-checkout.js";
import { buildNotifyPayload } from "../lib/store-forward.js";

const CFG = { env: "sandbox", baseUrl: "https://apis-dev.cleffo.com", clientKey: "ck-test", signatureKey: "sig-test", apiKey: "api-test", baseUrlMismatch: false };

test("signature: HMAC-SHA256 hex of the exact raw body reproduces the Cleffo guide's worked example", () => {
  const raw = '{"data":{"merchant_order_id":"test123","customer_detail":{"name":"test","email":"test@gmail.com","phone_no":"67823234234"},"products":[{"name":"product","product_id":"p3932","image":"ima_212.png","price":200,"quantity":2}],"price":{"sub_total":400,"tax":1.5,"total":401.5,"currency":"USD"}},"metadata":{"source":"api","cleffo_client_key":"sunnysides","redirect_url":"https://xyz.com/return/page"}}';
  assert.equal(signBody(raw, "my_signature_key_dev_12345"), "b9d299025597b3bfd3a2834b4d3c756c0ea89e113c76fb8939d126fdac41ed3a");
  const sig = signBody(raw, "k1");
  assert.equal(verifySignature(raw, sig, "k1"), true);
  assert.equal(verifySignature(raw, sig.toUpperCase(), "k1"), true);
  assert.equal(verifySignature(`${raw} `, sig, "k1"), false); // exact bytes
  assert.equal(verifySignature(raw, sig, "k2"), false);
  assert.equal(verifySignature(raw, "", "k1"), false);
  assert.equal(verifySignature(raw, "zz", "k1"), false);
  assert.equal(verifySignature(raw, sig, ""), false);
});

test("return token binds order + attempt to the signature key", () => {
  const t = returnToken("BLR-1100", 2, "sig");
  assert.match(t, /^[0-9a-f]{32}$/);
  assert.equal(verifyReturnToken("BLR-1100", "2", t, "sig"), true);
  assert.equal(verifyReturnToken("BLR-1101", "2", t, "sig"), false);
  assert.equal(verifyReturnToken("BLR-1100", "1", t, "sig"), false);
  assert.equal(verifyReturnToken("BLR-1100", "2", t, "other"), false);
  assert.equal(verifyReturnToken("BLR-1100", "2", t, ""), false);
});

test("payment-link body: neutral single line (no product / compound names), server total, alnum id, digits phone", () => {
  const order = { id: "BLR-1200", amount: "169.09", currency: "usd", customer: { first_name: "Ada", last_name: "N", email: " ada@lab.example ", phone: "+1 (888) 123-4567", address: "1 Main", city: "Austin", state: "TX", zip: "73301", country: "USA" },
    items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 2, amount: "79.00" }] };
  const b = buildPaymentLinkBody({ order, merchantOrderId: "BLR-1200A1", redirectUrl: "https://crm.example/r", clientKey: "ck" });
  assert.equal(b.data.merchant_order_id, "BLR1200A1");
  assert.equal(b.data.customer_detail.email, "ada@lab.example");
  assert.equal(b.data.customer_detail.phone_no, "18881234567");
  assert.equal(b.data.customer_detail.shipping_address.country, "US");
  assert.equal(b.data.products.length, 1);
  assert.equal(b.data.products[0].name, "BioLabs Research order BLR-1200");
  assert.equal(b.data.products[0].quantity, 1);
  assert.equal(b.data.products[0].price, 169.09);
  assert.deepEqual(b.data.price, { sub_total: 169.09, tax: 0, total: 169.09, currency: "USD" });
  assert.deepEqual(b.metadata, { source: "api", cleffo_client_key: "ck", redirect_url: "https://crm.example/r" });
  assert.doesNotMatch(JSON.stringify(b), /bpc|peptide|157/i);
  const short = buildPaymentLinkBody({ order: { ...order, customer: { email: "a@b.c", phone: "123" } }, merchantOrderId: "X", redirectUrl: "u", clientKey: "c" });
  assert.equal(short.data.customer_detail.phone_no.length, 8);
});

test("config: CLEFFO_ENV picks the prefixed key set; sandbox never points at production; health is booleans only", () => {
  const fileValues = { CLEFFO_SANDBOX_API_KEY: "sa", CLEFFO_SANDBOX_CLIENT_KEY: "sc", CLEFFO_SANDBOX_SIGNATURE_KEY: "ss", CLEFFO_LIVE_API_KEY: "la", CLEFFO_LIVE_CLIENT_KEY: "lc", CLEFFO_LIVE_SIGNATURE_KEY: "ls", CLEFFO_LIVE_BASE_URL: "https://apis.cleffo.com" };
  const sb = loadCleffoConfig({}, { fileValues, envPath: "" });
  assert.equal(sb.env, "sandbox");
  assert.equal(sb.apiKey, "sa");
  assert.equal(sb.baseUrl, "https://apis-dev.cleffo.com");
  const live = loadCleffoConfig({ CLEFFO_ENV: "live" }, { fileValues, envPath: "" });
  assert.equal(live.apiKey, "la");
  assert.equal(live.baseUrl, "https://apis.cleffo.com");
  assert.equal(live.baseUrlMismatch, false);
  const bad = loadCleffoConfig({ CLEFFO_ENV: "sandbox", CLEFFO_BASE_URL: "https://apis.cleffo.com" }, { fileValues, envPath: "" });
  assert.equal(bad.baseUrlMismatch, true);
  const h = cleffoKeyHealth(bad);
  assert.equal(h.ready, false);
  assert.doesNotMatch(JSON.stringify(cleffoKeyHealth(live)), /"la"|"lc"|"ls"/);
});

test("createPaymentLink / getPaymentStatus: headers, signed exact body, mapping, keys never in results", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (init.method === "POST") return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_link: "https://dev.cleffo.com/pay/x/abc", transaction_reference_number: "abc123api", merchant_order_id: "BLR1A1" } }) };
    return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_status: "completed", total_amount: "20.00", currency: "usd", merchant_order_id: "BLR1A1", transaction_reference_number: "abc123api", payment_gateway: "g", payment_gateway_intent_id: "pi_1", date_time: "2026-09-28 20:00:00" } }) };
  };
  const order = { id: "BLR-1", amount: "20.00", currency: "USD", customer: { first_name: "Q", last_name: "A", email: "q@a.co", phone: "88812345678" } };
  const r = await createPaymentLink({ order, merchantOrderId: "BLR1A1", redirectUrl: "https://x/r" }, { config: CFG, fetchImpl });
  assert.equal(r.ok, true);
  assert.equal(r.ref, "abc123api");
  assert.equal(calls[0].url, "https://apis-dev.cleffo.com/api/payment-link");
  assert.equal(calls[0].init.headers["x-api-key"], "api-test");
  assert.equal(calls[0].init.headers["x-signature"], signBody(calls[0].init.body, "sig-test"));
  assert.equal(JSON.parse(calls[0].init.body).metadata.cleffo_client_key, "ck-test");
  const s = await getPaymentStatus("abc123api", { config: CFG, fetchImpl });
  assert.equal(calls[1].url, "https://apis-dev.cleffo.com/api/payment-link/abc123api/status");
  assert.equal(calls[1].init.headers["x-signature"], undefined);
  assert.equal(s.status, "PAID");
  assert.equal(s.currency, "USD");
  for (const out of [r, s]) assert.doesNotMatch(JSON.stringify(out), /api-test|sig-test|ck-test/);
  assert.equal(mapPaymentStatus("failed"), "DECLINED");
  assert.equal(mapPaymentStatus("pending"), "PENDING");
  assert.equal(mapPaymentStatus("weird"), "UNKNOWN");
  const bad = await createPaymentLink({ order, merchantOrderId: "x", redirectUrl: "u" }, { config: CFG, fetchImpl: async () => ({ status: 401, text: async () => JSON.stringify({ status: false, message: "Authorization error", errors: { authorization: "invalid signature" } }) }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /invalid signature/);
  const down = await createPaymentLink({ order, merchantOrderId: "x", redirectUrl: "u" }, { config: CFG, fetchImpl: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(down.ok, false);
  const nokeys = await createPaymentLink({ order, merchantOrderId: "x", redirectUrl: "u" }, { config: { ...CFG, apiKey: "" } });
  assert.equal(nokeys.error, "cleffo_keys_missing");
});

test("bucket: deterministic, normalised, ~50/50 over 20k synthetic emails, split configurable", () => {
  assert.equal(normalizeEmail("  QA-Test+Cleffo@BioLabsResearch.co "), "qa-test+cleffo@biolabsresearch.co");
  assert.equal(bucketFor("Ada@Lab.example"), bucketFor(" ada@lab.example"));
  assert.equal(bucketValue("x@y.z"), bucketValue("X@Y.Z"));
  const emails = Array.from({ length: 20000 }, (_, i) => `customer${i}.${(i * 7919) % 1000}@example${i % 37}.com`);
  const a = splitStats(emails, 50);
  assert.ok(a.cleffoPct > 48.5 && a.cleffoPct < 51.5, `cleffo ${a.cleffoPct}%`);
  const b = splitStats(emails, 50);
  assert.deepEqual(a, b);
  assert.equal(splitStats(emails, 0).cleffo, 0);
  assert.equal(splitStats(emails, 100).umg, 0);
  const t = splitStats(emails, 30).cleffoPct;
  assert.ok(t > 28.5 && t < 31.5, `30% split gave ${t}`);
  assert.equal(routingConfig({}).splitPct, 50);
  assert.equal(routingConfig({ CLEFFO_SPLIT_PCT: "150" }).splitPct, 100);
  assert.equal(routingConfig({ CLEFFO_SPLIT_PCT: "abc" }).splitPct, 50);
  assert.equal(routingConfig({}).cleffoEnabled, false);
  assert.equal(routingConfig({}).maxAttempts, 3);
});

test("retry classification: hard codes / MAC 03 / MAC 21 / do-not-retry are hard, unknown fails closed, soft only when recognised", () => {
  const c = (a) => classifyForRetry(a).retryClass;
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Activity limit exceeded; Code:203" }), "soft");
  assert.equal(c({ processorStatus: "DECLINED", informationCode: "51" }), "soft");
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Insufficient funds" }), "soft");
  assert.equal(c({ processorStatus: "PROCESSOR_DOWN", reason: "timeout_or_network" }), "soft");
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Do not honor", informationCode: "05" }), "hard");
  assert.equal(c({ processorStatus: "DECLINED", informationCode: "43" }), "hard"); // stolen
  assert.equal(c({ processorStatus: "DECLINED", informationCode: "41" }), "hard"); // lost
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Suspected fraud" }), "hard");
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Insufficient funds", mac: "03" }), "hard");
  assert.equal(c({ processorStatus: "DECLINED", informationData: "declined MAC:21" }), "hard");
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Merchant Advice Code 03" }), "hard");
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Do not try again" }), "hard");
  assert.equal(c({ processorStatus: "DECLINED", informationData: "insufficient funds - do not retry" }), "hard");
  assert.equal(c({ processorStatus: "DECLINED" }), "hard"); // unknown -> fail closed
  assert.equal(c({ processorStatus: "DECLINED", informationData: "Generic decline" }), "hard");
  assert.equal(classifyForRetry({ processor: "cleffo", processorStatus: "DECLINED" }).basis, "unknown_fail_closed");
  assert.equal(c({ processorStatus: "LINK_ERROR" }), "none");
  assert.equal(c({ processorStatus: "APPROVED" }), "none");
});

test("chooseProcessor: bucket first, switch only after a soft decline and only once, hard stays, cap 3, flag off = UMG", () => {
  const on = { cleffoEnabled: true, splitPct: 50, maxAttempts: 3 };
  let e = "a0@x.co"; for (let i = 0; bucketFor(e) !== "cleffo"; i += 1) e = `a${i}@x.co`;
  assert.equal(chooseProcessor({ email: e, history: [], config: on }).processor, "cleffo");
  const soft = { processor: "cleffo", outcome: "declined", retryClass: "soft", reason: "bucket" };
  const r2 = chooseProcessor({ email: e, history: [soft], config: on });
  assert.equal(r2.processor, "umg");
  assert.equal(r2.reason, "retry_switch_soft");
  const r3 = chooseProcessor({ email: e, history: [soft, { processor: "umg", outcome: "declined", retryClass: "soft", reason: "retry_switch_soft" }], config: on });
  assert.equal(r3.processor, "umg"); // already switched once
  assert.equal(r3.reason, "retry_same_switch_used");
  const hard = chooseProcessor({ email: e, history: [{ processor: "cleffo", outcome: "declined", retryClass: "hard", reason: "bucket" }], config: on });
  assert.equal(hard.processor, "cleffo");
  assert.equal(hard.reason, "retry_same_hard");
  const same = chooseProcessor({ email: e, history: [{ processor: "umg", outcome: "declined", retryClass: "hard", cardKey: "K1" }], config: on, cardKey: "K1" });
  assert.equal(same.blocked, true);
  assert.equal(same.reason, "hard_decline_same_card");
  const other = chooseProcessor({ email: e, history: [{ processor: "umg", outcome: "declined", retryClass: "hard", cardKey: "K1" }], config: on, cardKey: "K2" });
  assert.equal(other.processor, "umg");
  const cap = chooseProcessor({ email: e, history: [soft, soft, soft], config: on });
  assert.equal(cap.blocked, true);
  assert.equal(cap.reason, "attempts_exhausted");
  const off = chooseProcessor({ email: e, history: [soft, soft, soft, soft], config: { ...on, cleffoEnabled: false } });
  assert.equal(off.processor, "umg");
  assert.equal(off.blocked, undefined);
  assert.equal(off.attempt, 5);
});

test("descriptor per processor: Cleffo stays UNKNOWN (not shown) until configured; UMG default unchanged", () => {
  assert.deepEqual(descriptorFor("cleffo", {}), { processor: "cleffo", statementDescriptor: null, statementDescriptorConfirmed: false, configured: "UNKNOWN" });
  assert.equal(descriptorFor("cleffo", { CLEFFO_DESCRIPTOR: "CLF*BIOLABS" }).statementDescriptor, "CLF*BIOLABS");
  assert.equal(descriptorFor("umg", {}).statementDescriptor, "PEPTIDESS SHOP");
});

test("consent gate for Cleffo: missing / malformed / unticked / no acceptedAt / required id -> refused", () => {
  const good = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T15:00:00Z", pageVersion: "v1" };
  assert.equal(validateConsentForCleffo({ consent: good }, {}).ok, true);
  assert.equal(validateConsentForCleffo({}, {}).error, "consent_missing");
  assert.equal(validateConsentForCleffo({ consent: "yes" }, {}).error, "consent_invalid");
  assert.equal(validateConsentForCleffo({ consent: { ...good, checks: { "ck-terms": true, "ck-ruo": false } } }, {}).ok, false);
  assert.equal(validateConsentForCleffo({ consent: { ...good, acceptedAt: null } }, {}).ok, false);
  assert.equal(validateConsentForCleffo({ consent: { checks: {}, acceptedAt: good.acceptedAt } }, {}).ok, false);
  assert.equal(validateConsentForCleffo({ consent: good }, { CLEFFO_REQUIRED_CONSENT_CHECKS: "ck-terms,ck-age" }).ok, false);
});

test("store forward: Cleffo orders are labelled card-cleffo and never claim the UMG descriptor", () => {
  const base = { id: "BLR-5", status: "approved", amount: "20.00", currency: "USD", customer: { email: "a@b.co" }, items: [] };
  const c = buildNotifyPayload({ ...base, winningProcessor: "cleffo", descriptor: null });
  assert.equal(c.paymentMethod, "card-cleffo");
  assert.equal(c.orderData.paymentMethod, "card-cleffo");
  assert.doesNotMatch(c.body, /PEPTIDESS/);
  assert.doesNotMatch(c.body, /statement will show/);
  const u = buildNotifyPayload({ ...base, winningProcessor: "umg", descriptor: null });
  assert.equal(u.paymentMethod, "card-umg");
  assert.doesNotMatch(u.body, /PEPTIDESS|statement will show/); // 2026-10-01 no descriptor in the store note
});
