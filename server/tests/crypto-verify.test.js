import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { createCryptoCheckout, isShippable, shipOrder } from "../lib/crypto-checkout.js";
import { createCryptoVerifier, evaluatePayment } from "../lib/crypto-verify.js";
import { cryptoVerifyConfig, isCryptoVerified } from "../lib/crypto-payment.js";
import { createSanctionsScreener } from "../lib/crypto-sanctions.js";
import { ga4PurchasePayload, sendGa4Purchase } from "../lib/crypto-notify.js";
import { pushOrderToRapid, isPaidOrder } from "../lib/rapid-orders.js";
import { rapidConfig } from "../lib/rapid.js";
import { createConsentLog, hashRecord } from "../lib/consent.js";
import { startCrmServer } from "../index.js";
import { createOrderEmailer, emailConfig, createEmailLog } from "../lib/order-emails.js";
import { createMockChain, createMockScreener, USDC_TRC } from "./crypto-mock.js";

const ERC = `0x${"ab".repeat(20)}`;
const TRC = "TXfrivx3QHrYDwPcaj3ojEDQFvAzX8EdKv";
const ENV = { CRYPTO_USDT_ERC: ERC, CRYPTO_USDT_TRC: TRC, CRYPTO_VERIFY_ENABLED: "true" };
const SECRET = "s".repeat(48);
const hash = (n) => n.toString(16).padStart(64, "0");

function setup({ screener = createMockScreener(), env = {}, mailer } = {}) {
  let clock = Date.parse("2026-09-28T12:00:00Z");
  const now = () => new Date(clock);
  const store = createStore({ memoryOnly: true });
  const trc = createMockChain("trc20", { latest: 10000 });
  const erc = createMockChain("erc20", { latest: 20000 });
  // Real order emailer (docs/ORDER_EMAILS.md) with a mock SMTP transport.
  const sent = [];
  const emailEnv = { ORDER_EMAILS_ENABLED: "true", SUPPORT_SMTP_HOST: "smtp.test", SUPPORT_SMTP_USER: "support@biolabsresearch.co", SUPPORT_SMTP_PASS: "x", ORDER_EMAILS_ALERT_TO: "" };
  const orderEmailer = mailer === undefined
    ? createOrderEmailer({
        db: store, cfg: emailConfig(emailEnv), log: createEmailLog(join(mkdtempSync(join(tmpdir(), "elog-")), "email-log.jsonl")),
        transportFactory: () => ({ async sendMail(m) { sent.push(m); return { messageId: `m${sent.length}` }; } }), sleep: async () => {}, logger: () => {},
      })
    : mailer;
  const fullEnv = { ...ENV, ...env };
  const ga4Calls = [];
  const fetchImpl = async (url, init) => { ga4Calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; };
  const verifier = createCryptoVerifier({
    store, env: fullEnv, chains: { trc20: trc, erc20: erc }, screener, orderEmailer, now, fetchImpl, log: () => {},
    skuMap: () => ({ "bpc-157-10mg": { product_id: "RC05-10", name: "RC-05 10mg vial" } }),
  });
  let n = 0;
  const create = (over = {}) => {
    n += 1;
    const r = createCryptoCheckout({
      idempotencyKey: `K-${n}-${Math.random()}`, amount: "158.00", network: "trc20",
      customer: { first_name: "Ada", last_name: "N", email: "qa-test+crypto@biolabsresearch.co", address: "1 Way", city: "SF", state: "CA", zip: "94107", country: "US" },
      items: [{ sku: "bpc-157-10mg", name: "Some product", qty: 1, amount: "158.00" }],
      ...over,
    }, { store, env: fullEnv, now, confirmSecret: SECRET });
    assert.equal(r.ok, true, r.error);
    return r.order;
  };
  return {
    store, trc, erc, verifier, create, sent, ga4Calls, screener,
    advance: (ms) => { clock += ms; }, now, get clock() { return clock; },
  };
}

test("two orders with the identical total get distinct exact pay amounts (unique among open orders per network)", () => {
  const t = setup();
  const a = t.create();
  const b = t.create();
  assert.equal(a.amount, "158.00");
  assert.equal(b.amount, "158.00");
  assert.notEqual(a.cryptoPayment.payAmount, b.cryptoPayment.payAmount);
  const seen = new Set([a.cryptoPayment.payUnits, b.cryptoPayment.payUnits]);
  for (let i = 0; i < 60; i += 1) seen.add(t.create().cryptoPayment.payUnits);
  assert.equal(seen.size, 62, "every open order on trc20 has its own exact amount");
  for (const u of seen) {
    const off = Number(BigInt(u) - 158000000n);
    assert.ok(off >= 10000 && off <= 990000 && off % 10000 === 0, "offset is 0.01..0.99");
  }
});

test("unpaid order is never released; fulfillment never processing/ready_to_ship", async () => {
  const t = setup();
  const o = t.create();
  assert.equal(o.paymentStatus, "awaiting_payment");
  assert.equal(o.fulfillment.status, "blocked");
  await t.verifier.tick();
  const after = t.store.getOrder(o.id);
  assert.equal(after.cryptoPayment.status, "awaiting_payment");
  assert.equal(after.fulfillment.status, "blocked");
  assert.equal(isShippable(after), false);
  assert.equal(shipOrder(o.id, { store: t.store, actor: "x" }).error, "ship_blocked");
});

test("exact on-chain payment with enough confirmations is released (unique amount match, no hint); GA4 flag off by default", async () => {
  const t = setup();
  const o = t.create();
  t.advance(5 * 60000);
  t.trc.addTx({ hash: hash(1), to: TRC, units: o.cryptoPayment.payUnits, blockNumber: 10000 - 21, timestamp: t.clock });
  await t.verifier.tick();
  const paid = t.store.getOrder(o.id);
  assert.equal(paid.cryptoPayment.status, "paid");
  assert.equal(paid.paymentStatus, "paid");
  assert.equal(paid.fulfillment.status, "ready_to_ship");
  assert.equal(paid.cryptoPayment.transfers[0].matchedBy, "unique_amount");
  assert.equal(paid.cryptoPayment.sanctions.status, "clear");
  assert.deepEqual(t.screener.screened, ["TSenderAddr1111111111111111111111"]);
  assert.equal(isCryptoVerified(paid), true);
  assert.equal(isShippable(paid), true);
  assert.equal(paid.cryptoPayment.ga4.status, "skipped_disabled");
  assert.equal(t.ga4Calls.length, 0);
});

test("insufficient confirmations -> confirming (not released), then released once the chain has 20", async () => {
  const t = setup();
  const o = t.create();
  t.trc.addTx({ hash: hash(2), to: TRC, units: o.cryptoPayment.payUnits, blockNumber: 10000 - 5, timestamp: t.clock });
  await t.verifier.tick();
  let x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "confirming");
  assert.equal(x.fulfillment.status, "blocked");
  assert.equal(x.paymentConfirmed, false);
  t.advance(3 * 3600e3); // confirming orders never time out
  await t.verifier.tick();
  x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "confirming");
  t.trc.latest = 10000 + 20;
  await t.verifier.tick();
  x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "paid");
  assert.equal(x.fulfillment.status, "ready_to_ship");
});

test("partial payment -> payment_review + alert, never released", async () => {
  const t = setup();
  const o = t.create();
  t.verifier.customerConfirm(o.id, { txHash: hash(3) });
  t.trc.addTx({ hash: hash(3), to: TRC, units: String(BigInt(o.cryptoPayment.payUnits) - 50_000_000n), blockNumber: 9000, timestamp: t.clock });
  await t.verifier.tick();
  const x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "payment_review");
  assert.ok(x.cryptoPayment.reviewReasons.includes("partial_payment"));
  assert.equal(x.fulfillment.status, "blocked");
  assert.equal(x.cryptoPayment.alerts.at(-1).type, "partial_payment");
  assert.ok(t.store.getCryptoState().alerts.some((a) => a.type === "partial_payment" && a.orderId === o.id));
  assert.equal(isPaidOrder(x), false);
});

test("overpayment, wrong token and wrong network all go to review", async () => {
  const t = setup();
  const over = t.create();
  t.verifier.addHint(over.id, hash(4), "customer");
  t.trc.addTx({ hash: hash(4), to: TRC, units: String(BigInt(over.cryptoPayment.payUnits) + 5_000_000n), blockNumber: 9000, timestamp: t.clock });
  const usdc = t.create();
  t.trc.addTx({ hash: hash(5), to: TRC, units: usdc.cryptoPayment.payUnits, contract: USDC_TRC, blockNumber: 9000, timestamp: t.clock });
  const wrongNet = t.create();
  t.verifier.customerConfirm(wrongNet.id, { txHash: hash(6) });
  t.erc.addTx({ hash: `0x${hash(6)}`, to: ERC, units: wrongNet.cryptoPayment.payUnits, blockNumber: 19000, timestamp: t.clock });
  await t.verifier.tick();
  const a = t.store.getOrder(over.id);
  const b = t.store.getOrder(usdc.id);
  const c = t.store.getOrder(wrongNet.id);
  assert.equal(a.cryptoPayment.status, "payment_review");
  assert.ok(a.cryptoPayment.reviewReasons.includes("overpaid"));
  assert.equal(b.cryptoPayment.status, "payment_review");
  assert.ok(b.cryptoPayment.reviewReasons.includes("wrong_token"));
  assert.equal(c.cryptoPayment.status, "payment_review");
  assert.ok(c.cryptoPayment.reviewReasons.includes("wrong_network"));
  for (const x of [a, b, c]) assert.equal(x.fulfillment.status, "blocked");
});

test("60-minute timeout cancels an unpaid order and sends the cancel email From support@", async () => {
  const t = setup();
  const o = t.create();
  t.advance(59 * 60000);
  await t.verifier.tick();
  assert.equal(t.store.getOrder(o.id).cryptoPayment.status, "awaiting_payment");
  t.advance(2 * 60000);
  await t.verifier.tick();
  const x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "cancelled");
  assert.equal(x.status, "crypto_cancelled");
  assert.equal(x.fulfillment.status, "blocked");
  assert.equal(x.cryptoPayment.cancelReason, "payment_timeout");
  const mail = t.sent.find((m) => m.headers["X-BLR-Email-Type"] === "payment_cancelled");
  assert.ok(mail, "cancel email sent through the order emailer");
  assert.equal(mail.from.address, "support@biolabsresearch.co");
  assert.equal(mail.to, "qa-test+crypto@biolabsresearch.co");
  assert.equal(mail.subject, `Payment not received, order cancelled (${x.id})`); // CRM BLR number is the source of truth
  assert.ok(mail.text.includes(`for order ${x.id} (${x.orderRef}) within`));
  assert.match(mail.text, /For research use only/);
  assert.equal(/bpc|some product/i.test(mail.text), false);
  assert.equal(x.cryptoPayment.cancelEmail.status, "sent");
  assert.equal(x.emails.payment_cancelled.status, "sent");
});

test("timeout: no email helper -> skipped_disabled; chain API down -> no cancel (never cancels a payer blind)", async () => {
  const t = setup({ mailer: null });
  const o = t.create();
  t.trc.failWith = "http_503";
  t.advance(61 * 60000);
  await t.verifier.tick();
  assert.equal(t.store.getOrder(o.id).cryptoPayment.status, "awaiting_payment");
  assert.match(t.store.getCryptoState().scan.trc20.lastError, /http_503/);
  t.trc.failWith = null;
  t.advance(20 * 60000); // past the backoff
  await t.verifier.tick();
  const x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "cancelled");
  assert.equal(x.cryptoPayment.cancelEmail.status, "skipped_disabled");
});

test("customer confirmation without an on-chain tx does not release; it extends the cancel deadline by the grace window", async () => {
  const t = setup();
  const o = t.create();
  t.advance(50 * 60000);
  const r = t.verifier.customerConfirm(o.id, {});
  assert.equal(r.ok, true);
  let x = t.store.getOrder(o.id);
  assert.ok(x.cryptoPayment.customerConfirmedAt);
  assert.equal(x.cryptoPayment.status, "awaiting_payment");
  assert.equal(x.fulfillment.status, "blocked");
  t.advance(15 * 60000); // 65 min after create: would be cancelled without the grace window
  await t.verifier.tick();
  x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "awaiting_payment");
  assert.equal(isShippable(x), false);
  t.advance(60 * 60000); // 125 min: past 60 + 60 grace
  await t.verifier.tick();
  assert.equal(t.store.getOrder(o.id).cryptoPayment.status, "cancelled");
});

test("customer-entered hash that is not on chain is only a hint: nothing released", async () => {
  const t = setup();
  const o = t.create();
  t.verifier.customerConfirm(o.id, { txHash: hash(77) });
  await t.verifier.tick();
  const x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.txHints[0].result, "not_found");
  assert.equal(x.cryptoPayment.status, "awaiting_payment");
  assert.equal(x.fulfillment.status, "blocked");
});

test("tx reuse is blocked: a tx that paid order A can never pay order B", async () => {
  const t = setup();
  const a = t.create();
  t.trc.addTx({ hash: hash(8), to: TRC, units: a.cryptoPayment.payUnits, blockNumber: 9000, timestamp: t.clock });
  await t.verifier.tick();
  assert.equal(t.store.getOrder(a.id).cryptoPayment.status, "paid");
  const b = t.create({ amount: (Number(a.cryptoPayment.payAmount) - 0.5).toFixed(2) });
  t.verifier.customerConfirm(b.id, { txHash: hash(8) });
  await t.verifier.tick();
  const xb = t.store.getOrder(b.id);
  assert.equal(xb.cryptoPayment.transfers.length, 0);
  assert.equal(xb.cryptoPayment.txHints[0].result, "tx_already_used");
  assert.ok(xb.cryptoPayment.alerts.some((al) => al.type === "tx_reuse_attempt"));
  assert.equal(xb.cryptoPayment.status, "awaiting_payment");
  assert.equal(t.store.cryptoTxOwner(`trc20:${hash(8)}`), a.id);
});

test("late payment after cancel -> payment_review (late_payment), never auto-ships", async () => {
  const t = setup();
  const o = t.create();
  t.advance(61 * 60000);
  await t.verifier.tick();
  assert.equal(t.store.getOrder(o.id).cryptoPayment.status, "cancelled");
  t.advance(30 * 60000);
  t.trc.addTx({ hash: hash(9), to: TRC, units: o.cryptoPayment.payUnits, blockNumber: 9000, timestamp: t.clock });
  await t.verifier.tick();
  const x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "payment_review");
  assert.equal(x.cryptoPayment.latePayment, true);
  assert.ok(x.cryptoPayment.reviewReasons.includes("late_payment"));
  assert.equal(x.fulfillment.status, "blocked");
});

test("sanctions: match -> sanctions_review + alert, no ship, release refused; unavailable -> screening_hold (fail closed) then paid when clear", async () => {
  const bad = setup({ screener: createMockScreener({ status: "match" }) });
  const o = bad.create();
  bad.trc.addTx({ hash: hash(10), to: TRC, units: o.cryptoPayment.payUnits, blockNumber: 9000, timestamp: bad.clock });
  await bad.verifier.tick();
  const x = bad.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "sanctions_review");
  assert.equal(x.fulfillment.status, "blocked");
  assert.ok(x.cryptoPayment.alerts.some((a) => a.type === "sanctions_match"));
  const rel = await bad.verifier.staffAction(o.id, { action: "release", note: "try" }, "staff@x");
  assert.equal(rel.error, "sanctions_match");
  assert.equal(x.cryptoPayment.refunds.length, 0);

  const screener = createMockScreener({ status: "unavailable" });
  const t = setup({ screener });
  const h = t.create();
  t.trc.addTx({ hash: hash(11), to: TRC, units: h.cryptoPayment.payUnits, blockNumber: 9000, timestamp: t.clock });
  await t.verifier.tick();
  assert.equal(t.store.getOrder(h.id).cryptoPayment.status, "screening_hold");
  assert.equal(t.store.getOrder(h.id).fulfillment.status, "blocked");
  screener.status = "clear";
  await t.verifier.tick();
  assert.equal(t.store.getOrder(h.id).cryptoPayment.status, "paid");
});

test("staff: release from review needs a note + confirmed on-chain transfer, logs the actor; refunds are recorded only", async () => {
  const t = setup();
  const o = t.create();
  t.verifier.addHint(o.id, hash(12), "customer");
  t.trc.addTx({ hash: hash(12), to: TRC, units: String(BigInt(o.cryptoPayment.payUnits) + 2_000_000n), blockNumber: 9000, timestamp: t.clock });
  await t.verifier.tick();
  assert.equal(t.store.getOrder(o.id).cryptoPayment.status, "payment_review");
  assert.equal((await t.verifier.staffAction(o.id, { action: "release" }, "staff@x")).error, "note_required");
  const refund = await t.verifier.staffAction(o.id, { action: "record_refund", refundTxHash: hash(13), amount: "2.00", note: "overpay returned" }, "staff@x");
  assert.equal(refund.ok, true);
  assert.equal(t.store.getOrder(o.id).cryptoPayment.refunds[0].amount, "2.00");
  const rel = await t.verifier.staffAction(o.id, { action: "release", note: "overpayment refunded manually" }, "staff@x");
  assert.equal(rel.ok, true);
  const x = t.store.getOrder(o.id);
  assert.equal(x.cryptoPayment.status, "paid");
  assert.equal(x.fulfillment.status, "ready_to_ship");
  assert.equal(x.cryptoPayment.verifiedVia, "staff_release_after_review:staff@x");
  assert.deepEqual(x.cryptoPayment.staffActions.map((a) => a.action), ["record_refund", "release"]);
  assert.ok(x.cryptoPayment.staffActions.every((a) => a.actor === "staff@x"));

  const noTx = t.create();
  const st = t.store.getOrder(noTx.id);
  st.cryptoPayment.status = "payment_review";
  t.store.upsertOrder(st);
  assert.equal((await t.verifier.staffAction(noTx.id, { action: "release", note: "customer says paid" }, "staff@x")).error, "no_confirmed_onchain_transfer");
  const c = await t.verifier.staffAction(noTx.id, { action: "cancel", note: "dup" }, "staff@x");
  assert.equal(c.ok, true);
  assert.equal(t.store.getOrder(noTx.id).cryptoPayment.status, "cancelled");
});

test("Rapid refuses crypto orders that are not on-chain verified (awaiting, legacy staff mark-paid)", async () => {
  const t = setup();
  const cfg = rapidConfig({ RAPID_ENABLED: "true", RAPID_ALLOW_REAL_ORDERS: "true", RAPID_AUTO_PUSH: "true", RAPID_ENV: "test" });
  let pushed = 0;
  const client = { async ordersNew() { pushed += 1; return { ok: true }; } };
  const o = t.create();
  assert.equal((await pushOrderToRapid(t.store, o.id, { client, cfg, skuMap: {} })).error, "not_paid");
  const legacy = t.store.getOrder(o.id);
  Object.assign(legacy, { status: "crypto_paid", paymentConfirmed: true, fulfillment: { status: "ready" } });
  t.store.upsertOrder(legacy);
  assert.equal((await pushOrderToRapid(t.store, o.id, { client, cfg, skuMap: {} })).error, "not_paid");
  assert.equal(pushed, 0);
});

test("evaluatePayment rules (tolerance is rounding only)", () => {
  const cfg = cryptoVerifyConfig({});
  const base = { paymentMethod: "crypto", cryptoPayment: { status: "awaiting_payment", network: "trc20", payUnits: "158370000" } };
  const tx = (units, extra = {}) => ({ network: "trc20", token: "USDT", units, success: true, confirmations: 25, finalChecked: true, ...extra });
  const ev = (transfers) => evaluatePayment({ ...base, cryptoPayment: { ...base.cryptoPayment, transfers } }, cfg).next;
  assert.equal(ev([]), null);
  assert.equal(ev([tx("158370000")]), "screen");
  assert.equal(ev([tx("158369999")]), "screen"); // 1 micro-unit rounding
  assert.equal(ev([tx("158369000")]), "payment_review");
  assert.equal(ev([tx("158370000", { confirmations: 3, finalChecked: false })]), "confirming");
  assert.equal(ev([tx("100000000"), tx("58370000")]), "screen"); // two transfers summed
  assert.equal(ev([tx("158370000", { success: false })]), null);
});

test("sanctions screener: Chainalysis identifications, local OFAC list match / clear / stale, missing key reported", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ofac-"));
  const listPath = join(dir, "ofac.txt");
  writeFileSync(listPath, `# test\n0x${"99".repeat(20)}\n`);
  const env = { CRYPTO_OFAC_LIST_PATH: listPath, CRYPTO_OFAC_AUTO_REFRESH: "false" };
  const s = createSanctionsScreener({ env, fetchImpl: async () => { throw new Error("no network"); }, log: () => {} });
  assert.equal((await s.screen([`0x${"99".repeat(20)}`])).status, "match");
  const ok = await s.screen(["TSenderAddr1111111111111111111111"]);
  assert.equal(ok.status, "clear");
  assert.ok(ok.errors.includes("chainalysis_api_key_missing"));
  const old = new Date(Date.now() - 30 * 86400e3);
  utimesSync(listPath, old, old);
  assert.equal((await createSanctionsScreener({ env, log: () => {} }).screen(["TSenderAddr1111111111111111111111"])).status, "unavailable");

  const calls = [];
  const ca = createSanctionsScreener({
    env: { CHAINALYSIS_API_KEY: "k", CRYPTO_OFAC_LIST_PATH: join(dir, "none.txt"), CRYPTO_OFAC_AUTO_REFRESH: "false" }, log: () => {},
    fetchImpl: async (url, init) => { calls.push({ url, key: init.headers["X-API-Key"] }); return { ok: true, json: async () => ({ identifications: url.endsWith("TBad") ? [{ category: "sanctions", name: "SANCTIONS: OFAC SDN" }] : [] }) }; },
  });
  assert.equal((await ca.screen(["TBad"])).status, "match");
  assert.equal((await ca.screen(["TGood"])).status, "clear");
  assert.equal(calls[0].key, "k");
});

test("GA4 server purchase: behind flag, needs API secret, catalog codes only (no item_name)", async () => {
  const order = {
    id: "BLR-1", orderRef: "CR-AAAA2222", amount: "158.00", items: [{ sku: "bpc-157-10mg", name: "Some product", qty: 2 }, { sku: "unknown", name: "X", qty: 1 }],
    priceCheck: { lines: [{ sku: "bpc-157-10mg", unit: "79.00", line: "158.00" }] }, cryptoPayment: { token: "USDT", network: "trc20" },
  };
  const skuMap = { "bpc-157-10mg": { product_id: "RC05-10", name: "RC-05 10mg vial" } };
  const p = ga4PurchasePayload(order, { skuMap });
  assert.deepEqual(p.events[0].params.items, [{ item_id: "RC05-10", quantity: 2, price: 79 }]);
  assert.equal(JSON.stringify(p).includes("item_name"), false);
  assert.equal(JSON.stringify(p).includes("Some product"), false);
  assert.equal(p.events[0].params.transaction_id, "CR-AAAA2222");
  assert.equal((await sendGa4Purchase(order, { env: {} })).status, "skipped_disabled");
  assert.equal((await sendGa4Purchase(order, { env: { GA4_SERVER_PURCHASE_ENABLED: "true" } })).status, "skipped_missing_api_secret");
  const calls = [];
  const r = await sendGa4Purchase(order, { env: { GA4_SERVER_PURCHASE_ENABLED: "true", GA4_API_SECRET: "sec" }, skuMap, fetchImpl: async (url) => { calls.push(url); return { ok: true, status: 204 }; } });
  assert.equal(r.status, "sent");
  assert.match(calls[0], /measurement_id=G-KCMPHP783M&api_secret=sec/);
  assert.equal((await sendGa4Purchase({ ...order, test: true }, { env: { GA4_SERVER_PURCHASE_ENABLED: "true", GA4_API_SECRET: "sec" } })).status, "skipped_test_order");
});

test("HTTP: create returns exact amount + token; confirm endpoint needs the signed token, logs to the consent chain, never releases; staff API fields", async () => {
  const dir = mkdtempSync(join(tmpdir(), "consent-"));
  const consentLog = createConsentLog({ filePath: join(dir, "consent-log.jsonl") });
  const store = createStore({ memoryOnly: true });
  const trc = createMockChain("trc20", { latest: 10000 });
  const erc = createMockChain("erc20", { latest: 20000 });
  const prev = { ...process.env };
  Object.assign(process.env, ENV, { MARKETING_DIGEST_KEY: "mk" });
  delete process.env.PAYMENTS_ENABLED;
  const server = await startCrmServer(0, {
    store, consentLog, cryptoChains: { trc20: trc, erc20: erc }, cryptoScreener: createMockScreener(), cryptoConfirmSecret: SECRET,
    checkCrmSession: async (tok) => (tok === "good" ? { email: "staff@biolabsresearch.co" } : false),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = { "Content-Type": "application/json", "User-Agent": "qa-agent" };
  try {
    const body = {
      idempotencyKey: "HTTP-1", amount: "88.00", network: "trc20",
      customer: { first_name: "Q", last_name: "A", email: "qa-test+crypto@biolabsresearch.co" },
      items: [{ sku: "x", name: "y", qty: 1, amount: "88.00" }], consent: { checks: { agreeTerms: true }, pageVersion: "v3" },
    };
    const c = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: J, body: JSON.stringify(body) }).then((r) => r.json());
    assert.match(c.payAmount, /^88\.\d{2}$/);
    assert.equal(c.token, "USDT");
    assert.equal(c.network, "trc20");
    assert.equal(c.wallet, TRC);
    assert.ok(c.expiresAt && c.confirmToken && c.confirmUrl.endsWith(`/api/checkout/crypto/${c.orderRef}/confirm`));
    const c2 = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: J, body: JSON.stringify({ ...body, idempotencyKey: "HTTP-2" }) }).then((r) => r.json());
    assert.notEqual(c2.payAmount, c.payAmount);

    const bad = await fetch(`${base}/api/checkout/crypto/${c.orderRef}/confirm`, { method: "POST", headers: J, body: JSON.stringify({ token: c2.confirmToken }) });
    assert.equal(bad.status, 403);
    const badTx = await fetch(`${base}/api/checkout/crypto/${c.orderRef}/confirm`, { method: "POST", headers: J, body: JSON.stringify({ token: c.confirmToken, txHash: "nope" }) });
    assert.equal(badTx.status, 400);
    const ok = await fetch(`${base}/api/checkout/crypto/${c.orderRef}/confirm`, { method: "POST", headers: J, body: JSON.stringify({ token: c.confirmToken, txHash: hash(500), pageVersion: "v3.01" }) });
    assert.equal(ok.status, 200);
    const okBody = await ok.json();
    assert.equal(okBody.customerConfirmed, true);
    assert.equal(okBody.paymentConfirmed, false);
    assert.equal(okBody.paymentStatus, "awaiting_payment");
    assert.equal(okBody.txHintReceived, true);
    assert.equal(okBody.message, "Thanks. We're checking the blockchain and will email you once your payment is confirmed.");
    assert.equal(Date.parse(okBody.cancelAt) - Date.parse(okBody.expiresAt), 60 * 60000);

    const recs = readFileSync(join(dir, "consent-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const i = recs.findIndex((r) => r.type === "crypto_payment_confirmed");
    assert.ok(i > 0);
    const conf = recs[i];
    assert.equal(conf.orderId, c.orderId);
    assert.equal(conf.txHint, hash(500));
    assert.equal(conf.pageVersion, "v3.01");
    assert.equal(conf.userAgent, "qa-agent");
    assert.equal(conf.prevHash, recs[i - 1].hash);
    assert.equal(hashRecord(conf), conf.hash);

    assert.equal((await fetch(`${base}/api/psp/crypto/orders`)).status, 401);
    const staff = { Authorization: "Bearer good", "Content-Type": "application/json" };
    const list = await fetch(`${base}/api/psp/crypto/orders`, { headers: staff }).then((r) => r.json());
    const row = list.orders.find((o) => o.orderRef === c.orderRef);
    for (const k of ["paymentStatus", "payAmount", "receivedAmount", "confirmations", "requiredConfirmations", "network", "transfers", "txHints", "customerConfirmed", "sanctions", "staffActions", "refunds", "cancelAt"]) assert.ok(k in row, k);
    assert.equal(row.customerConfirmed, true);
    assert.equal(row.requiredConfirmations, 20);
    assert.match(row.txHints[0].explorerUrl, /^https:\/\/tronscan\.org\/#\/transaction\//);
    assert.equal(list.verifier.shippingGate, "onchain_verified_only");

    trc.addTx({ hash: hash(500), to: TRC, units: c.payAmountUnits, blockNumber: 9000 });
    const v = await fetch(`${base}/api/psp/crypto/verify-now`, { method: "POST", headers: staff }).then((r) => r.json());
    assert.equal(v.ok, true);
    const one = await fetch(`${base}/api/psp/crypto/orders/${c.orderRef}`, { headers: staff }).then((r) => r.json());
    assert.equal(one.order.paymentStatus, "paid");
    assert.equal(one.order.transfers[0].explorerUrl, `https://tronscan.org/#/transaction/${hash(500)}`);
    assert.equal(one.order.receivedAmount, c.payAmount);
    const poll = await fetch(`${base}/api/checkout/crypto/${c.orderRef}`).then((r) => r.json());
    assert.equal(poll.paymentConfirmed, true);
    assert.equal(poll.fulfillment, "ready_to_ship");
    const act = await fetch(`${base}/api/psp/crypto/orders/${c2.orderRef}/action`, { method: "POST", headers: staff, body: JSON.stringify({ action: "cancel", note: "qa" }) }).then((r) => r.json());
    assert.equal(act.ok, true);
    assert.equal(act.order.staffActions[0].actor, "staff@biolabsresearch.co");
  } finally {
    await new Promise((r) => server.close(r));
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test("USDC only on ERC20 (2026-09-28): USDT TRC20/ERC20 + USDC ERC20 are released, USDC TRC20 goes to review; confirmation email shows what was paid", async () => {
  const { USDC_ERC } = await import("./crypto-mock.js");
  const t = setup({ env: { CRYPTO_ACCEPTED_TOKENS: "USDT,USDC" } });
  const usdtTrc = t.create();
  const usdtErc = t.create({ network: "erc20" });
  const usdcErc = t.create({ network: "erc20" });
  const usdcTrc = t.create();
  t.trc.addTx({ hash: hash(71), to: TRC, units: usdtTrc.cryptoPayment.payUnits, blockNumber: 10000 - 21, timestamp: t.clock });
  t.erc.addTx({ hash: `0x${hash(72)}`, to: ERC, units: usdtErc.cryptoPayment.payUnits, blockNumber: 20000 - 13, timestamp: t.clock });
  t.erc.addTx({ hash: `0x${hash(73)}`, to: ERC, units: usdcErc.cryptoPayment.payUnits, contract: USDC_ERC, blockNumber: 20000 - 13, timestamp: t.clock });
  t.trc.addTx({ hash: hash(74), to: TRC, units: usdcTrc.cryptoPayment.payUnits, contract: USDC_TRC, blockNumber: 10000 - 21, timestamp: t.clock });
  await t.verifier.tick();
  const get = (o) => t.store.getOrder(o.id);
  for (const o of [usdtTrc, usdtErc, usdcErc]) {
    assert.equal(get(o).cryptoPayment.status, "paid", `${o.cryptoPayment.network} ${o.id}`);
    assert.equal(isCryptoVerified(get(o)), true);
  }
  assert.equal(get(usdcErc).cryptoPayment.transfers[0].token, "USDC");
  const rejected = get(usdcTrc);
  assert.equal(rejected.cryptoPayment.status, "payment_review");
  assert.ok(rejected.cryptoPayment.reviewReasons.includes("wrong_token"));
  assert.equal(rejected.fulfillment.status, "blocked");
  assert.equal(isCryptoVerified(rejected), false);
  // confirmation email renders the asset + network actually paid (emails stay OFF in production; this is a render)
  const em = createOrderEmailer({ db: t.store, cfg: emailConfig({}), log: createEmailLog(null), logger: () => {} });
  const paidWith = (o) => em.preview("confirmation", get(o)).text.match(/Paid with: (.+)/)[1];
  assert.equal(paidWith(usdtTrc), "USDT (TRC20)");
  assert.equal(paidWith(usdtErc), "USDT (ERC20)");
  assert.equal(paidWith(usdcErc), "USDC (ERC20)");
});

test("an order already opened as USDC-TRC20 (before the rule) stays verifiable; env can narrow but never widen", async () => {
  const { isTokenAccepted } = await import("../lib/crypto-payment.js");
  const t = setup({ env: { CRYPTO_ACCEPTED_TOKENS: "USDT,USDC" } });
  const legacy = t.create();
  const lo = t.store.getOrder(legacy.id);
  lo.cryptoPayment.token = "USDC"; // simulates a USDC-TRC20 order created before 2026-09-28
  lo.payAsset = "USDC";
  t.store.upsertOrder(lo);
  t.trc.addTx({ hash: hash(81), to: TRC, units: lo.cryptoPayment.payUnits, contract: USDC_TRC, blockNumber: 10000 - 21, timestamp: t.clock });
  await t.verifier.tick();
  assert.equal(t.store.getOrder(legacy.id).cryptoPayment.status, "paid");

  const def = cryptoVerifyConfig({});
  const both = cryptoVerifyConfig({ CRYPTO_ACCEPTED_TOKENS: "USDT,USDC" });
  const usdcOnly = cryptoVerifyConfig({ CRYPTO_ACCEPTED_TOKENS: "USDC" });
  assert.deepEqual(both.acceptedByNetwork, { trc20: ["USDT"], erc20: ["USDT", "USDC"] });
  assert.equal(isTokenAccepted(def, "USDC", "erc20"), false); // default env: USDT only
  assert.equal(isTokenAccepted(def, "USDT", "trc20"), true);
  assert.equal(isTokenAccepted(both, "USDC", "erc20"), true);
  assert.equal(isTokenAccepted(both, "USDC", "trc20"), false);
  assert.equal(isTokenAccepted(both, "USDC", "trc20", { token: "USDC", network: "trc20" }), true); // grandfathered order
  assert.equal(isTokenAccepted(def, "USDC", "trc20", { token: "USDC", network: "trc20" }), false); // token disabled -> no
  assert.equal(isTokenAccepted(usdcOnly, "USDT", "trc20"), false);
  assert.equal(isTokenAccepted(usdcOnly, "USDC", "erc20"), true);
  assert.equal(isTokenAccepted(both, "DAI", "erc20"), false);
  const { ACCEPTABLE_TOKENS, TOKENS } = await import("../lib/crypto-chains.js");
  assert.deepEqual(ACCEPTABLE_TOKENS.trc20, ["USDT"]);
  assert.equal(TOKENS.trc20[USDC_TRC].token, "USDC"); // still recognised so a stray deposit reaches review
});
