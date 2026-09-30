import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { priceCardCart, priceCryptoCart } from "../lib/pricing.js";
import { canonicalJson, createConsentLog, hashRecord, sanitizeConsent, MAX_CHECKS } from "../lib/consent.js";
import { startCrmServer } from "../index.js";
import { couponQuoteFake } from "./helpers/coupon-quote-fake.js";

const KEY = "test-marketing-digest-key";
const CUSTOMER = { first_name: "Ada", last_name: "N", email: "Ada@Lab.example" };
// infra 2026-09-29 honest-charge: the charged amount is the whole-cart coupon-quote total_due, so the fake answers like products-api
const quote = () => couponQuoteFake();
const CONSENT = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T09:40:00.123Z", pageVersion: "v3.00k8m4d" };
const tmpLog = () => join(mkdtempSync(join(tmpdir(), "consent-")), "consent-log.jsonl");

test("sanitizeConsent: booleans only, id/length caps, max checks, missing/invalid", () => {
  assert.deepEqual(sanitizeConsent(undefined), { consent: null, missing: true, invalid: false, dropped: 0 });
  assert.equal(sanitizeConsent("yes").invalid, true);
  assert.equal(sanitizeConsent([true]).invalid, true);
  assert.equal(sanitizeConsent({}).missing, true);
  const checks = { ok: true, no: false, str: "true", num: 1, "bad id!": true, [`x${"a".repeat(70)}`]: true };
  for (let i = 0; i < 30; i += 1) checks[`c${i}`] = true;
  const s = sanitizeConsent({ checks, acceptedAt: "not a date", pageVersion: `v\u0000${"9".repeat(200)}` });
  assert.equal(s.missing, false);
  assert.equal(Object.keys(s.consent.checks).length, MAX_CHECKS);
  assert.equal(s.consent.checks.ok, true);
  assert.equal(s.consent.checks.no, false);
  assert.equal("str" in s.consent.checks || "num" in s.consent.checks, false);
  assert.equal(s.consent.acceptedAt, null);
  assert.equal(s.consent.acceptedAtRaw, "not a date");
  assert.equal(s.consent.pageVersion.length, 64);
  assert.ok(!s.consent.pageVersion.includes("\u0000"));
  assert.ok(s.dropped >= 16);
  assert.equal(sanitizeConsent(CONSENT).consent.acceptedAt, "2026-09-28T09:40:00.123Z");
});

test("log: append-only JSONL, mode 600, sha256 over canonical record, hash chain survives restart", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  const file = tmpLog();
  const log = createConsentLog({ filePath: file });
  const a = log.append({ orderId: "BLR-1", n: 1 });
  const b = log.append({ orderId: "BLR-2", n: 2 });
  assert.equal(a.prevHash, null);
  assert.equal(b.prevHash, a.hash);
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const again = createConsentLog({ filePath: file }).append({ orderId: "BLR-3" });
  assert.equal(again.prevHash, b.hash);
  const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const l of lines) assert.equal(hashRecord(l), l.hash);
  // tampering is detectable
  const t = { ...lines[0], orderId: "BLR-9" };
  assert.notEqual(hashRecord(t), t.hash);
  writeFileSync(file, `${JSON.stringify(t)}\n`, { flag: "a" });
  assert.equal(log.find({ ref: "BLR-9" })[0].hashOk, false);
  assert.equal(log.find({ ref: "BLR-2" })[0].hashOk, true);
});

test("routes: card + crypto orders get a consent record + order summary; missing consent never blocks; amounts unchanged; staff read", async () => {
  const prev = { p: process.env.PAYMENTS_ENABLED, k: process.env.MARKETING_DIGEST_KEY };
  process.env.PAYMENTS_ENABLED = "true";
  process.env.MARKETING_DIGEST_KEY = KEY;
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const file = tmpLog();
  const charged = [];
  let decline = false;
  const server = await startCrmServer(0, {
    store,
    consentLog: createConsentLog({ filePath: file }),
    cardPricer: (b) => priceCardCart(b, { fetchImpl: quote(), volumeDiscount: true }),
    cryptoPricer: (b) => priceCryptoCart(b, { fetchImpl: quote(), volumeDiscount: true }),
    adapters: { umg: { async createPayment(p) {
      charged.push(p.amount);
      return decline
        ? { ok: false, processor: "umg", processorTxnId: `U-${charged.length}`, processorStatus: "DECLINED", cascadeAction: "hard_stop", declineClass: "hard", reason: "do_not_honor", raw: {} }
        : { ok: true, processor: "umg", processorTxnId: `U-${charged.length}`, processorStatus: "APPROVED", cascadeAction: "success", raw: {} };
    } }, tagada: {}, centrobill: {} },
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const hdr = { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 QA", "X-Forwarded-For": "203.0.113.7, 10.0.0.1", "X-Real-IP": "203.0.113.7" };
  const card = { name: "Ada", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
  const items = [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }];
  try {
    const c = await fetch(`${base}/api/checkout/charge`, { method: "POST", headers: hdr, body: JSON.stringify({ idempotencyKey: "K-C1", customer: CUSTOMER, card, amount: "176.99", shipMethod: "express", items, consent: CONSENT }) });
    const cb = await c.json();
    assert.equal(c.status, 200);
    assert.equal(cb.chargedAmount, "169.09"); // price path untouched (volume tier on in this test)
    assert.deepEqual(charged, ["169.09"]);
    const co = store.getOrder(cb.order.id);
    assert.equal(co.consent.recorded, true);
    assert.equal(co.consent.allChecked, true);
    assert.equal(co.consent.missing, false);
    assert.equal(co.consent.ip, "203.0.113.7");
    assert.equal(co.status, "approved");

    // crypto without consent: order still created, recorded as missing
    const k = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: hdr, body: JSON.stringify({ idempotencyKey: "K-X1", network: "trc20", customer: CUSTOMER, amount: "158.00", items: [{ sku: "bpc-157-10mg", name: "BPC", qty: 2, amount: "158.00" }], test: true }) });
    const kb = await k.json();
    assert.equal(k.status, 200);
    { const d = Math.round((Number(kb.amountDue) - 150.10) * 100); assert.ok(d >= 1 && d <= 99, "unique 0.01-0.99 offset on the pay amount"); assert.equal(kb.payAmount, kb.amountDue); }
    const ko = store.getOrderByRef(kb.orderRef);
    assert.equal(ko.consent.missing, true);
    assert.equal(ko.consent.allChecked, false);
    // replay: no second record
    await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: hdr, body: JSON.stringify({ idempotencyKey: "K-X1", network: "trc20", customer: CUSTOMER, amount: "158.00", items: [{ sku: "bpc-157-10mg", name: "BPC", qty: 2, amount: "158.00" }], test: true }) });

    // declined card still leaves proof; one unticked box -> allChecked false
    decline = true;
    const d = await fetch(`${base}/api/checkout/charge`, { method: "POST", headers: hdr, body: JSON.stringify({ idempotencyKey: "K-C2", customer: CUSTOMER, card, amount: "88.00", items: [{ sku: "bpc-157-10mg", qty: 1, amount: "88.00" }], consent: { ...CONSENT, checks: { "ck-terms": true, "ck-ruo": false } } }) });
    const db2 = await d.json();
    assert.equal(d.status, 402);
    assert.equal(store.getOrder(db2.order.id).consent.allChecked, false);

    const lines = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 3);
    const [r1, r2] = lines;
    assert.equal(r1.channel, "card");
    assert.equal(r1.orderId, cb.order.id);
    assert.equal(r1.email, "ada@lab.example");
    assert.equal(r1.amount, "169.09");
    assert.equal(r1.shipMethod, "express");
    assert.equal(r1.userAgent, "Mozilla/5.0 QA");
    assert.equal(r1.xRealIp, "203.0.113.7");
    assert.deepEqual(r1.consent.checks, CONSENT.checks);
    assert.equal(r1.consent.pageVersion, "v3.00k8m4d");
    assert.ok(Date.parse(r1.receivedAt));
    assert.equal(hashRecord(r1), r1.hash);
    assert.equal(r2.channel, "crypto");
    assert.equal(r2.orderRef, kb.orderRef);
    assert.equal(r2.amount, "150.10");
    assert.equal(r2.consent, null);
    assert.equal(r2.missing, true);
    assert.equal(r2.prevHash, r1.hash);
    assert.equal(JSON.stringify(lines).includes("4242"), false); // no card data in the log

    assert.equal((await fetch(`${base}/api/consent?ref=${kb.orderRef}`)).status, 401);
    const staff = { "X-Marketing-Key": KEY };
    const q = await (await fetch(`${base}/api/consent?ref=${kb.orderRef}`, { headers: staff })).json();
    assert.equal(q.count, 1);
    assert.equal(q.records[0].hashOk, true);
    assert.equal((await (await fetch(`${base}/api/consent?ref=${cb.order.id}`, { headers: staff })).json()).count, 1);
    assert.equal((await (await fetch(`${base}/api/consent?email=ADA@lab.example`, { headers: staff })).json()).count, 3);
    assert.equal((await fetch(`${base}/api/consent`, { headers: staff })).status, 400);
  } finally {
    await new Promise((r) => server.close(r));
    for (const [kk, v] of [["PAYMENTS_ENABLED", prev.p], ["MARKETING_DIGEST_KEY", prev.k]]) { if (v === undefined) delete process.env[kk]; else process.env[kk] = v; }
  }
});

test("a broken log never blocks the order", async () => {
  const store = createStore({ memoryOnly: true });
  const server = await startCrmServer(0, {
    store,
    consentLog: { now: () => new Date(), append() { throw new Error("disk full"); }, find: () => [] },
    cryptoPricer: (b) => priceCryptoCart(b, { fetchImpl: quote() }),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const k = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: "K-B", network: "trc20", customer: CUSTOMER, amount: "88.00", items: [{ sku: "bpc-157-10mg", name: "BPC", qty: 1, amount: "88.00" }], consent: CONSENT }) });
    const kb = await k.json();
    assert.equal(k.status, 200);
    { const d = Math.round((Number(kb.amountDue) - 88.00) * 100); assert.ok(d >= 1 && d <= 99, "unique 0.01-0.99 offset on the pay amount"); assert.equal(kb.payAmount, kb.amountDue); }
    assert.deepEqual(store.getOrderByRef(kb.orderRef).consent, { recorded: false, error: "disk full" });
  } finally {
    await new Promise((r) => server.close(r));
  }
});
