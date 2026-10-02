// 2026-09-30 crypto awaiting-payment launch: contract, TxID, admin-only mark paid, no-ship / no-email gates, GA4 once.
import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { createCryptoCheckout, isShippable } from "../lib/crypto-checkout.js";
import { createCryptoVerifier } from "../lib/crypto-verify.js";
import { isCryptoVerified } from "../lib/crypto-payment.js";
import { pushEligibility, isPaidOrder } from "../lib/rapid-orders.js";
import { createOrderEmailer, emailConfig, createEmailLog } from "../lib/order-emails.js";
import { launchFields, launchStatus, normalizeTxid, amountUsd2dp } from "../lib/crypto-launch.js";
import { startCrmServer } from "../index.js";
import { createMockChain, createMockScreener } from "./crypto-mock.js";

const ERC = "0x55C758a84BCC999C5386E5047A064E0364915DE9";
const TRC = "TXfrivx3QHrYDwPcaj3ojEDQFvAzX8EdKv";
const SECRET = "s".repeat(48);
const LAUNCH = {
  CRYPTO_USDT_ERC: ERC, CRYPTO_USDT_TRC: TRC, CRYPTO_VERIFY_ENABLED: "true", CRYPTO_ACCEPTED_TOKENS: "USDT,USDC",
  CRYPTO_ADMIN_MARK_PAID_REQUIRED: "true", CRYPTO_UNIQUE_ACROSS_NETWORKS: "true", CRYPTO_UNIQUE_CENTS_ONLY: "true",
  CRYPTO_PAYMENT_TIMEOUT_MIN: "1440", CRYPTO_CANCEL_EMAIL_ENABLED: "false",
  GA4_SERVER_PURCHASE_ENABLED: "true", GA4_API_SECRET: "test-secret", CRM_PUBLIC_URL: "https://crm.biolabsresearch.co",
};
const h64 = (n) => n.toString(16).padStart(64, "0");

function setup(env = {}) {
  let clock = Date.parse("2026-09-30T12:00:00Z");
  const now = () => new Date(clock);
  const store = createStore({ memoryOnly: true });
  const trc = createMockChain("trc20", { latest: 10000 });
  const erc = createMockChain("erc20", { latest: 20000 });
  const sent = [];
  const orderEmailer = createOrderEmailer({
    db: store, cfg: emailConfig({ ORDER_EMAILS_ENABLED: "true", SUPPORT_SMTP_HOST: "smtp.test", SUPPORT_SMTP_USER: "support@biolabsresearch.co", SUPPORT_SMTP_PASS: "x", ORDER_EMAILS_ALERT_TO: "" }),
    log: createEmailLog(join(mkdtempSync(join(tmpdir(), "elog-")), "email-log.jsonl")),
    transportFactory: () => ({ async sendMail(m) { sent.push(m); return { messageId: `m${sent.length}` }; } }), sleep: async () => {}, logger: () => {},
  });
  const fullEnv = { ...LAUNCH, ...env };
  const ga4Calls = [];
  const fetchImpl = async (url, init) => { ga4Calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 204 }; };
  const verifier = createCryptoVerifier({ store, env: fullEnv, chains: { trc20: trc, erc20: erc }, screener: createMockScreener(), orderEmailer, now, fetchImpl, log: () => {} });
  let n = 0;
  const create = (over = {}) => {
    n += 1;
    const r = createCryptoCheckout({
      idempotencyKey: `QA-LAUNCH-${n}-${Math.random()}`, amount: "158.00", gaClientId: "123456789.987654321",
      customer: { first_name: "QA", last_name: "Test", email: "qa-test+crypto@biolabsresearch.co", address: "1 Way", city: "SF", state: "CA", zip: "94107", country: "US" },
      items: [{ sku: "qa-sku", name: "QA", qty: 1, amount: "158.00" }], ...over,
    }, { store, env: fullEnv, now, confirmSecret: SECRET });
    assert.equal(r.ok, true, r.error);
    return r.order;
  };
  return { store, trc, erc, verifier, create, sent, ga4Calls, env: fullEnv, advance: (ms) => { clock += ms; }, get clock() { return clock; } };
}

test("launch: unique amount = total + 0.01..0.99, 2dp, unique across ERC-20 and TRC-20; 24h expiry; contract fields", () => {
  const t = setup();
  const seen = new Set();
  for (let i = 0; i < 60; i += 1) {
    const o = t.create({ network: i % 3 === 0 ? "erc20" : i % 3 === 1 ? "trc20" : undefined });
    const f = launchFields(o, t.env, "tok");
    assert.match(f.amount_usd, /^158\.\d{2}$/);
    assert.ok(Number(f.amount_usd) >= 158.01 && Number(f.amount_usd) <= 158.99);
    seen.add(f.amount_usd);
    assert.equal(Date.parse(f.expires_at) - Date.parse(o.createdAt), 24 * 3600e3);
    assert.deepEqual(f.networks, [
      { token: "USDT/USDC", network: "Ethereum (ERC-20)", address: ERC },
      { token: "USDT", network: "TRON (TRC-20)", address: TRC },
    ]);
  }
  assert.equal(seen.size, 60);
  assert.equal(amountUsd2dp("158370000"), "158.37");
});

test("launch: an exact on-chain amount match is HELD for the admin (no paid, no Rapid, no email)", async () => {
  const t = setup();
  const o = t.create({ network: "trc20" });
  t.advance(60000);
  t.trc.addTx({ hash: h64(1), to: TRC, units: o.cryptoPayment.payUnits, blockNumber: 10000 - 25, timestamp: t.clock });
  await t.verifier.tick();
  const a = t.store.getOrder(o.id);
  assert.equal(a.cryptoPayment.status, "payment_review");
  assert.ok(a.cryptoPayment.reviewReasons.includes("awaiting_admin_mark_paid"));
  assert.equal(isCryptoVerified(a), false);
  assert.equal(isPaidOrder(a), false);
  assert.equal(isShippable(a), false);
  assert.equal(pushEligibility(a, { allowRealOrders: true }).error, "not_paid");
  assert.equal(t.sent.length, 0);
  assert.equal(t.ga4Calls.length, 0);
  assert.equal(launchStatus(a, t.env).status, "awaiting");
});

test("launch: customer TxID format, duplicate across orders, PAYMENT_SUBMITTED, no auto-expiry after submission", async () => {
  const t = setup();
  const a = t.create({ network: "erc20" });
  const b = t.create({ network: "erc20" });
  const v = t.verifier;
  assert.equal(v.submitCustomerTx(a.id, { network: "erc20", txHash: h64(7) }).error, "invalid_tx_hash");
  assert.equal(v.submitCustomerTx(a.id, { network: "trc20", txHash: `0x${h64(7)}` }).error, "invalid_tx_hash");
  assert.equal(v.submitCustomerTx(a.id, { network: "erc20", txHash: "0x1234" }).error, "invalid_tx_hash");
  assert.equal(v.submitCustomerTx(a.id, { network: "bsc", txHash: `0x${h64(7)}` }).error, "invalid_network");
  const ok = v.submitCustomerTx(a.id, { network: "erc20", txHash: `0x${h64(7)}`, asset: "USDT" });
  assert.equal(ok.ok, true);
  const sa = t.store.getOrder(a.id);
  assert.equal(sa.status, "payment_submitted");
  assert.equal(sa.cryptoPayment.customerTx.hash, `0x${h64(7)}`);
  assert.equal(isCryptoVerified(sa), false);
  assert.equal(v.submitCustomerTx(b.id, { network: "erc20", txHash: `0x${h64(7)}` }).error, "tx_already_used");
  assert.equal(v.submitCustomerTx(a.id, { network: "trc20", txHash: h64(8), asset: "USDC" }).error, "token_not_accepted");
  t.advance(25 * 3600e3);
  // audit 2026-10-02 (LF1 #361/#625): 25 hours of blocks are read in chunks of 3000 per tick and the timeout cancel waits until a scan has
  // reached the head (was: one tick, which read only the last 3000 blocks and cancelled). Three ticks cover the 7500+ blocks here.
  for (let i = 0; i < 4; i += 1) await v.tick();
  assert.notEqual(t.store.getOrder(a.id).cryptoPayment.status, "cancelled", "a submitted TxID waits for the admin");
  assert.equal(t.store.getOrder(b.id).cryptoPayment.status, "cancelled", "no TxID + 24h -> expired");
  assert.equal(launchStatus(t.store.getOrder(b.id), t.env).status, "expired");
  assert.equal(t.sent.length, 0, "expired order: no customer email");
});

test("launch: admin mark paid needs admin + green 4-point check; wrong amount is refused; GA4 purchase once", async () => {
  const t = setup();
  const o = t.create({ network: "erc20" });
  t.advance(60000);
  const good = `0x${h64(21)}`, bad = `0x${h64(22)}`;
  t.erc.addTx({ hash: bad, to: ERC.toLowerCase(), units: String(BigInt(o.cryptoPayment.payUnits) - 10000n), blockNumber: 20000 - 30, timestamp: t.clock });
  t.erc.addTx({ hash: good, to: ERC.toLowerCase(), units: o.cryptoPayment.payUnits, blockNumber: 20000 - 30, timestamp: t.clock });
  const v = t.verifier;
  assert.equal((await v.staffAction(o.id, { action: "admin_mark_paid", txHash: good, network: "erc20" }, "staff@x")).status, 403);
  const r1 = await v.staffAction(o.id, { action: "admin_mark_paid", txHash: bad, network: "erc20" }, "admin@x", { admin: true });
  assert.equal(r1.error, "check_not_green");
  assert.equal(r1.check.checks.amount.ok, false);
  assert.equal(r1.check.checks.recipient.ok, true);
  assert.equal(isCryptoVerified(t.store.getOrder(o.id)), false);
  const r2 = await v.staffAction(o.id, { action: "admin_mark_paid", txHash: good, network: "erc20" }, "admin@x", { admin: true });
  assert.equal(r2.ok, true, r2.error);
  const p = t.store.getOrder(o.id);
  assert.equal(isCryptoVerified(p), true);
  assert.equal(p.status, "crypto_paid");
  assert.equal(p.crypto.txHash, good);
  assert.equal(p.crypto.network, "erc20");
  assert.equal(p.cryptoPayment.adminMarkPaid.actor, "admin@x");
  assert.equal(p.cryptoPayment.adminMarkPaid.checkGreen, true);
  assert.equal(t.ga4Calls.length, 1);
  assert.equal(t.ga4Calls[0].body.client_id, "123456789.987654321");
  assert.equal(t.ga4Calls[0].body.events[0].name, "purchase");
  assert.equal(t.ga4Calls[0].body.events[0].params.transaction_id, o.orderRef);
  const r3 = await v.staffAction(o.id, { action: "admin_mark_paid", txHash: good, network: "erc20" }, "admin@x", { admin: true });
  assert.equal(r3.reused, true);
  assert.equal(t.ga4Calls.length, 1, "GA4 purchase sent once only");
  const o2 = t.create({ network: "erc20" });
  assert.equal((await v.staffAction(o2.id, { action: "admin_mark_paid", txHash: good, network: "erc20" }, "admin@x", { admin: true })).error, "tx_already_used");
});

test("launch: admin override needs a note, is logged + alerted, and marks paid without a green check", async () => {
  const t = setup();
  const o = t.create({ network: "trc20" });
  const tx = h64(31);
  const v = t.verifier;
  assert.equal((await v.staffAction(o.id, { action: "admin_mark_paid", txHash: tx, network: "trc20", override: true }, "admin@x", { admin: true })).error, "note_required_for_override");
  const r = await v.staffAction(o.id, { action: "admin_mark_paid", txHash: tx, network: "trc20", override: true, note: "QA: verified on tronscan by hand" }, "admin@x", { admin: true });
  assert.equal(r.ok, true, r.error);
  const p = t.store.getOrder(o.id);
  assert.equal(isCryptoVerified(p), true);
  assert.equal(p.cryptoPayment.adminMarkPaid.override, true);
  assert.equal(p.cryptoPayment.verifiedOnChain, false);
  assert.ok(p.cryptoPayment.alerts.some((a) => a.type === "admin_override_mark_paid"));
  assert.ok(p.cryptoPayment.staffActions.some((a) => a.action === "admin_mark_paid" && a.result === "marked_paid_override"));
});

test("launch HTTP: contract, token-gated status, TxID route + rate limit, CORS storefront only, admin-only mark paid", async () => {
  const saved = {};
  for (const [k, v] of Object.entries(LAUNCH)) { saved[k] = process.env[k]; process.env[k] = v; }
  const store = createStore({ memoryOnly: true });
  const trc = createMockChain("trc20", { latest: 10000 });
  const erc = createMockChain("erc20", { latest: 20000 });
  const server = await startCrmServer(0, {
    store, cryptoChains: { trc20: trc, erc20: erc }, cryptoScreener: createMockScreener(), cryptoConfirmSecret: SECRET, cryptoEnv: { ...process.env },
    checkCrmSession: async (tok) => (tok === "admin" ? { ok: true, user: { email: "admin@biolabsresearch.co", role: "admin" } } : tok === "staff" ? { ok: true, user: { email: "yaniv@biolabsresearch.co", role: "staff" } } : false),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = { "Content-Type": "application/json", Origin: "https://biolabsresearch.co" };
  try {
    const body = { idempotencyKey: "QA-HTTP-LAUNCH-1", amount: "88.00", customer: { first_name: "QA", last_name: "Test", email: "qa-test+crypto@biolabsresearch.co" }, items: [{ sku: "qa", name: "QA", qty: 1, amount: "88.00" }], test: true };
    const res = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: J, body: JSON.stringify(body) });
    assert.equal(res.headers.get("access-control-allow-origin"), "https://biolabsresearch.co");
    const c = await res.json();
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.match(c.order_id, /^CR-[A-Z0-9]{8}$/);
    assert.match(c.amount_usd, /^88\.\d{2}$/);
    assert.equal(c.networks.length, 2);
    assert.ok(c.expires_at && c.status_token);
    const bad = await fetch(`${base}/api/checkout/crypto/${c.order_id}/status?token=nope`);
    assert.equal(bad.status, 403);
    const st = await fetch(`${base}/api/checkout/crypto/${c.order_id}/status?token=${encodeURIComponent(c.status_token)}`).then((r) => r.json());
    assert.deepEqual(Object.keys(st).sort(), ["expires_at", "ok", "order_id", "status", "tx_submitted"]);
    assert.equal(st.status, "awaiting");
    // the blrcommerce.io mirror gets no crypto CORS answer (contract of 2026-09-30; #53/#81/#143 wait for the owner), nor does any other origin
    const mirror = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: { ...J, Origin: "https://blrcommerce.io" }, body: JSON.stringify({ ...body, idempotencyKey: "QA-HTTP-LAUNCH-2" }) });
    assert.equal(mirror.headers.get("access-control-allow-origin"), null, "crypto CORS: the mirror is not allowed (held back 2026-10-02: enabling crypto on the mirror is the owner's decision)");
    const other = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: { ...J, Origin: "https://evil.example" }, body: JSON.stringify({ ...body, idempotencyKey: "QA-HTTP-LAUNCH-3" }) });
    assert.equal(other.headers.get("access-control-allow-origin"), null, "crypto CORS: storefront origins only");
    const tx = `0x${h64(41)}`;
    const t1 = await fetch(`${base}/api/checkout/crypto/${c.order_id}/txid`, { method: "POST", headers: J, body: JSON.stringify({ token: "nope", network: "erc20", tx_hash: tx }) });
    assert.equal(t1.status, 403);
    const t2 = await fetch(`${base}/api/checkout/crypto/${c.order_id}/txid`, { method: "POST", headers: J, body: JSON.stringify({ token: c.status_token, network: "erc20", tx_hash: h64(41) }) });
    assert.equal(t2.status, 400);
    const t3 = await fetch(`${base}/api/checkout/crypto/${c.order_id}/txid`, { method: "POST", headers: J, body: JSON.stringify({ token: c.status_token, network: "erc20", tx_hash: tx }) }).then((r) => r.json());
    assert.equal(t3.ok, true, JSON.stringify(t3));
    assert.equal(t3.order_status, "PAYMENT_SUBMITTED");
    assert.equal(t3.tx_submitted, true);
    let last = 0;
    for (let i = 0; i < 10; i += 1) last = (await fetch(`${base}/api/checkout/crypto/${c.order_id}/txid`, { method: "POST", headers: J, body: JSON.stringify({ token: c.status_token, network: "erc20", tx_hash: tx }) })).status;
    assert.equal(last, 429, "txid route is rate limited");
    const id = store.getOrderByRef(c.order_id).id;
    const staffTry = await fetch(`${base}/api/psp/crypto/orders/${id}/action`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer staff" }, body: JSON.stringify({ action: "admin_mark_paid", network: "erc20", txHash: tx }) });
    assert.equal(staffTry.status, 403);
    const staffTry2 = await fetch(`${base}/api/store-orders/${id}/mark-paid`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer staff" }, body: JSON.stringify({ network: "erc20", txHash: tx }) });
    assert.equal(staffTry2.status, 403);
    const view = await fetch(`${base}/api/psp/crypto/orders/${id}`, { headers: { Authorization: "Bearer staff" } }).then((r) => r.json());
    assert.equal(view.order.customerTx.explorerUrl, `https://etherscan.io/tx/${tx}`);
    const adm = await fetch(`${base}/api/psp/crypto/orders/${id}/action`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer admin" }, body: JSON.stringify({ action: "admin_mark_paid", network: "erc20", txHash: tx }) });
    assert.equal(adm.status, 409, "tx not on chain -> check not green");
    assert.equal(isCryptoVerified(store.getOrder(id)), false);
  } finally {
    server.close();
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test("launch: TxID normalisation", () => {
  assert.equal(normalizeTxid("erc20", `0x${"A".repeat(64)}`), `0x${"a".repeat(64)}`);
  assert.equal(normalizeTxid("trc20", "b".repeat(64)), "b".repeat(64));
  assert.equal(normalizeTxid("trc20", `0x${"b".repeat(64)}`), null);
  assert.equal(normalizeTxid("erc20", "b".repeat(64)), null);
});
