import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { priceCardCart, priceCryptoCart } from "../lib/pricing.js";
import { RUO_FOOTER, FOLLOWUP_QUESTION, orderTotals, renderEmail, h } from "../lib/email-templates.js";
import { createEmailLog, createOrderEmailer, emailConfig, registerEmailType, sampleOrder, maskEmail } from "../lib/order-emails.js";
import { startCrmServer } from "../index.js";
import { createMockChain, createMockScreener } from "./crypto-mock.js";
import { couponQuoteFake } from "./helpers/coupon-quote-fake.js";

const KEY = "test-marketing-digest-key";
const TRC = `T${"9".repeat(33)}`;
const TX_TRON = "ef".repeat(32);
const ON = { ORDER_EMAILS_ENABLED: "true", SUPPORT_SMTP_HOST: "smtp.example.test", SUPPORT_SMTP_PORT: "465", SUPPORT_SMTP_USER: "support@biolabsresearch.co", SUPPORT_SMTP_PASS: "x", NOREPLY_SMTP_HOST: "smtp.example.test", NOREPLY_SMTP_USER: "noreply@biolabsresearch.co", NOREPLY_SMTP_PASS: "y", ORDER_EMAILS_SINCE: "2020-01-01T00:00:00Z" };
const tmpLog = () => join(mkdtempSync(join(tmpdir(), "emails-")), "email-log.jsonl");

function mockTransport({ failTimes = 0, always = false } = {}) {
  const sent = [];
  const alerts = [];
  let fails = 0;
  const factory = (smtp) => ({
    async sendMail(m) {
      if (smtp.user.startsWith("noreply")) { alerts.push(m); return { messageId: `<a${alerts.length}@t>` }; }
      if (always || fails < failTimes) { fails += 1; const e = new Error("conn refused"); e.code = "ECONNREFUSED"; throw e; }
      sent.push(m);
      return { messageId: `<m${sent.length}@t>` };
    },
  });
  return { sent, alerts, factory };
}

function paidCard(over = {}) {
  const o = sampleOrder("confirmation");
  delete o.test;
  return { ...o, id: `BLR-${Math.floor(Math.random() * 1e6)}`, orderRef: undefined, ...over };
}

function emailer(env, mt, store = createStore({ memoryOnly: true }), logPath = tmpLog()) {
  const e = createOrderEmailer({ db: store, cfg: emailConfig(env), log: createEmailLog(logPath), transportFactory: mt.factory, sleep: async () => {}, logger: () => {} });
  return { e, store, logPath };
}

test("templates: RUO footer exact in html + text, gift hidden, Strength not Dose, catalog names, totals == amount incl. volume discount", () => {
  for (const type of ["confirmation", "shipping", "followup"]) {
    const r = renderEmail(type, sampleOrder(type));
    assert.deepEqual(r.guard, [], type);
    assert.ok(r.text.includes(RUO_FOOTER), type);
    assert.ok(r.html.includes(RUO_FOOTER.replace(/,/g, ",")), type);
    const all = `${r.subject}\n${r.text}`.toLowerCase();
    for (const bad of ["dose", "dosing", "bpc", "solvent", "gift", "free", "lot coa", "review", "coupon", "how was", "inject", "reconstitut", "mix"]) assert.ok(!all.includes(bad), `${type}: ${bad}`);
  }
  const c = renderEmail("confirmation", sampleOrder("confirmation"));
  assert.match(c.text, /RC-06 \(Strength: 10mg\) x 2/);
  assert.match(c.text, /G3-R \(Strength: 10mg\) x 1/);
  assert.match(c.text, /Volume discount \(5%\): −\$12\.15/);
  assert.match(c.text, /Total \(incl\. shipping\): \$249\.84/);
  assert.match(c.text, /We confirm your order manually within one business day\./);
  const t = orderTotals(sampleOrder("confirmation"));
  assert.equal(t.reconciled, true);
  assert.equal(t.lines.length, 2);
  assert.equal(t.subtotalCents - t.discount.cents + t.shippingCents, t.totalCents);
  const f = renderEmail("followup", sampleOrder("followup"));
  assert.equal(f.subject, FOLLOWUP_QUESTION);
  assert.ok(f.text.includes("mailto:support@biolabsresearch.co"));
  const s = renderEmail("shipping", sampleOrder("shipping"));
  assert.ok(s.text.includes("https://tools.usps.com/go/TrackConfirmAction?tLabels=9400111899223197428490"));
});

test("templates: unreconciled figures hide per-line prices but the total stays the checkout amount", () => {
  const o = sampleOrder("confirmation");
  o.amount = "250.00";
  const t = orderTotals(o);
  assert.equal(t.reconciled, false);
  const r = renderEmail("confirmation", o);
  assert.ok(!r.text.includes("$158.00"));
  assert.ok(r.text.includes("$250.00"));
});

test("descriptor: UMG shows PEPTIDESS SHOP, Cleffo unknown descriptor omitted, crypto has none", () => {
  const umg = renderEmail("confirmation", sampleOrder("confirmation")).text;
  assert.ok(umg.includes("PEPTIDESS SHOP"));
  const prev = process.env.CLEFFO_DESCRIPTOR;
  delete process.env.CLEFFO_DESCRIPTOR;
  const cl = renderEmail("confirmation", { ...sampleOrder("confirmation"), winningProcessor: "cleffo" }).text;
  if (prev !== undefined) process.env.CLEFFO_DESCRIPTOR = prev;
  assert.ok(!cl.includes("statement"));
  const cr = renderEmail("confirmation", { ...sampleOrder("confirmation"), paymentMethod: "crypto", status: "crypto_paid", paymentConfirmed: true }).text;
  assert.ok(!cr.includes("statement"));
  assert.match(cr, /Payment: Crypto|USDT/i);
});

test("guard: an unmapped INN / street name blocks the send, logs it and alerts; nothing is sent", async () => {
  const mt = mockTransport();
  const { e, store, logPath } = emailer(ON, mt);
  const o = paidCard({ items: [{ sku: "mystery-5mg", name: "Wolverine blend 5mg", qty: 1, amount: "50.00" }], priceCheck: undefined, amount: "59.99" });
  store.upsertOrder(o);
  const r = await e.send(o.id, "confirmation");
  assert.equal(r.status, "blocked_guard");
  assert.equal(mt.sent.length, 0);
  assert.equal(mt.alerts.length, 1);
  const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.at(-1).status, "blocked_guard");
  assert.ok(log.at(-1).blocked.length > 0);
  const o2 = paidCard({ items: [{ sku: "x-10mg", name: "Semaglutide 10mg", qty: 1, amount: "50.00" }], priceCheck: undefined, amount: "50.00" });
  store.upsertOrder(o2);
  assert.equal((await e.send(o2.id, "confirmation")).status, "blocked_guard");
  assert.equal(mt.sent.length, 0);
});

test("send: idempotent per (order, type), concurrent calls, and after a restart via stored state", async () => {
  const mt = mockTransport();
  const { e, store, logPath } = emailer(ON, mt);
  const o = paidCard();
  store.upsertOrder(o);
  const [a, b] = await Promise.all([e.send(o.id, "confirmation"), e.send(o.id, "confirmation")]);
  assert.equal(a.status, "sent");
  assert.equal(b.status, "duplicate");
  assert.equal((await e.send(o.id, "confirmation")).status, "duplicate");
  await e.processDue();
  const e2 = createOrderEmailer({ db: store, cfg: emailConfig(ON), log: createEmailLog(logPath), transportFactory: mt.factory, sleep: async () => {}, logger: () => {} });
  await e2.processDue();
  assert.equal(mt.sent.length, 1);
  assert.equal(mt.sent[0].from.address, "support@biolabsresearch.co");
  assert.equal(mt.sent[0].from.name, "BioLabs Research");
  assert.equal(mt.sent[0].replyTo, undefined);
  assert.equal(store.getOrder(o.id).emails.confirmation.status, "sent");
  assert.equal(store.getOrder(o.id).emails.confirmation.messageId, "<m1@t>");
  const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(log.length, 1);
  assert.deepEqual(Object.keys(log[0]).sort(), ["at", "attempt", "messageId", "orderId", "orderRef", "status", "to", "type", "via"].sort());
  assert.equal((statSync(logPath).mode & 0o777), 0o600);
  // force (staff resend) sends again and is logged
  assert.equal((await e.send(o.id, "confirmation", { force: true, via: "resend:staff" })).status, "sent");
  assert.equal(mt.sent.length, 2);
});

test("retry: 3 retries with backoff then failed + noreply alert; a transient failure recovers", async () => {
  const mt = mockTransport({ always: true });
  const sleeps = [];
  const store = createStore({ memoryOnly: true });
  const logPath = tmpLog();
  const e = createOrderEmailer({ db: store, cfg: emailConfig(ON), log: createEmailLog(logPath), transportFactory: mt.factory, sleep: async (ms) => { sleeps.push(ms); }, logger: () => {} });
  const o = paidCard();
  store.upsertOrder(o);
  const r = await e.send(o.id, "confirmation");
  assert.equal(r.status, "failed");
  assert.equal(r.attempt, 4);
  assert.deepEqual(sleeps, [2000, 10000, 30000]);
  assert.equal(mt.alerts.length, 1);
  assert.equal(mt.alerts[0].to, "admin@biolabsresearch.co");
  assert.equal(mt.alerts[0].from.address, "noreply@biolabsresearch.co");
  assert.ok(!mt.alerts[0].text.includes("qa-test+emails@"));
  assert.equal(store.getOrder(o.id).emails.confirmation.status, "failed");
  const log = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(log.map((l) => l.status), ["retrying", "retrying", "retrying", "failed"]);

  const mt2 = mockTransport({ failTimes: 2 });
  const { e: e2, store: s2 } = emailer(ON, mt2);
  const o2 = paidCard();
  s2.upsertOrder(o2);
  const r2 = await e2.send(o2.id, "confirmation");
  assert.equal(r2.status, "sent");
  assert.equal(r2.attempt, 3);
  assert.equal(mt2.alerts.length, 0);
});

test("disabled / no password: rendered, guarded and logged as skipped_disabled, never sent", async () => {
  for (const env of [{ ...ON, ORDER_EMAILS_ENABLED: "false" }, { ...ON, SUPPORT_SMTP_PASS: "" }]) {
    const mt = mockTransport();
    const { e, store, logPath } = emailer(env, mt);
    const o = paidCard();
    store.upsertOrder(o);
    const r = await e.send(o.id, "confirmation");
    assert.equal(r.status, "skipped_disabled");
    assert.equal(mt.sent.length + mt.alerts.length, 0);
    const log = JSON.parse(readFileSync(logPath, "utf8").trim());
    assert.equal(log.status, "skipped_disabled");
    assert.equal(log.attempt, 0);
    assert.equal(log.messageId, null);
  }
});

test("test / dry-run orders are skipped unless qa; no recipient is logged", async () => {
  const mt = mockTransport();
  const { e, store } = emailer(ON, mt);
  const t = { ...paidCard(), test: true };
  store.upsertOrder(t);
  assert.equal((await e.send(t.id, "confirmation")).status, "skipped_test_order");
  assert.equal((await e.processDue()).checked, 0);
  assert.equal((await e.send(t.id, "confirmation", { qa: true })).status, "sent");
  const n = paidCard({ customer: { ...paidCard().customer, email: "not-an-email" } });
  store.upsertOrder(n);
  assert.equal((await e.send(n.id, "confirmation")).status, "no_recipient");
});

test("sweeper: confirmation when paid, shipping when tracking, follow-up at +7 days; unpaid and pre-SINCE orders ignored", async () => {
  let clock = new Date("2026-10-01T12:00:00Z");
  const mt = mockTransport();
  const store = createStore({ memoryOnly: true });
  const e = createOrderEmailer({ db: store, cfg: emailConfig({ ...ON, ORDER_EMAILS_SINCE: "2026-09-30T00:00:00Z" }), log: createEmailLog(tmpLog()), transportFactory: mt.factory, sleep: async () => {}, now: () => clock, logger: () => {} });
  const old = paidCard({ createdAt: "2026-09-01T00:00:00Z" });
  const unpaid = paidCard({ status: "declined", createdAt: clock.toISOString() });
  const o = paidCard({ createdAt: clock.toISOString() });
  for (const x of [old, unpaid, o]) store.upsertOrder(x);
  await e.processDue();
  assert.deepEqual(mt.sent.map((m) => m.headers["X-BLR-Email-Type"]), ["confirmation"]);
  assert.equal(mt.sent[0].headers["X-BLR-Order"], o.id);
  const fresh = store.getOrder(o.id);
  fresh.fulfillment = { status: "shipped", shippedAt: clock.toISOString(), carrier: "UPS", trackingNumber: "1Z999AA10123456784" };
  store.upsertOrder(fresh);
  await e.processDue();
  assert.equal(mt.sent.length, 2);
  assert.match(mt.sent[1].text, /ups\.com\/track\?tracknum=1Z999AA10123456784/);
  clock = new Date(clock.getTime() + 6 * 86400000);
  await e.processDue();
  assert.equal(mt.sent.length, 2);
  clock = new Date(clock.getTime() + 1 * 86400000 + 1000);
  await e.processDue();
  assert.equal(mt.sent.length, 3);
  assert.equal(mt.sent[2].subject, FOLLOWUP_QUESTION);
  await e.processDue();
  assert.equal(mt.sent.length, 3);
});

test("registerEmailType: reusable helper for a new customer email (e.g. payment not received, order cancelled)", async () => {
  registerEmailType("qa_payment_cancelled", {
    subject: (o) => `Order ${o.id} cancelled – payment not received`,
    blocks: (o, ctx) => [h.heading("Your order was cancelled"), h.p(`We did not receive payment for order ${o.id} within ${ctx.data.hours} hours, so it was cancelled.`)],
  });
  assert.throws(() => registerEmailType("Bad Type", { subject: () => "", blocks: () => [] }));
  const mt = mockTransport();
  const { e, store } = emailer(ON, mt);
  const o = paidCard({ status: "crypto_pending", paymentMethod: "crypto" });
  store.upsertOrder(o);
  const r = await e.send(o.id, "qa_payment_cancelled", { data: { hours: 24 } });
  assert.equal(r.status, "sent");
  assert.match(mt.sent[0].text, /within 24 hours/);
  assert.ok(mt.sent[0].text.includes(RUO_FOOTER));
  assert.equal((await e.send(o.id, "qa_payment_cancelled")).status, "duplicate");
  const bad = await e.send(o.id, "nope");
  assert.equal(bad.status, "unknown_type");
});

test("routes: card checkout 200 even when SMTP throws; crypto mark-paid + tracking kick emails; staff endpoints need auth", async () => {
  const prev = { ...process.env };
  Object.assign(process.env, { PAYMENTS_ENABLED: "true", MARKETING_DIGEST_KEY: KEY, CRYPTO_USDT_TRC: TRC });
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [{ id: "umg", enabled: true, priority: 1, mode: "sandbox" }, { id: "tagada", enabled: false, priority: 2, mode: "off" }, { id: "centrobill", enabled: false, priority: 3, mode: "off" }] });
  // infra 2026-09-29 honest-charge: whole-cart coupon-quote fake (total_due), see helpers/coupon-quote-fake.js
  const quote = () => couponQuoteFake();
  let smtpCalls = 0;
  const logPath = tmpLog();
  // 2026-09-28: crypto mark-paid verifies the tx on-chain (mocked chain here)
  const TRC_W = "TXfrivx3QHrYDwPcaj3ojEDQFvAzX8EdKv";
  const trcChain = createMockChain("trc20", { latest: 5000 });
  const server = await startCrmServer(0, {
    store,
    cryptoEnv: { ...process.env, CRYPTO_USDT_TRC: TRC_W, CRYPTO_VERIFY_ENABLED: "true" },
    cryptoChains: { trc20: trcChain, erc20: createMockChain("erc20") },
    cryptoScreener: createMockScreener(),
    cryptoConfirmSecret: "c".repeat(40),
    emailEnv: ON,
    emailLogPath: logPath,
    emailSleep: async () => {},
    emailTransportFactory: (smtp) => ({ async sendMail(m) { smtpCalls += 1; if (smtp.user.startsWith("noreply")) return { messageId: "<a@t>" }; if (store.getOrder(m.headers["X-BLR-Order"])?.paymentMethod !== "crypto") throw Object.assign(new Error("boom"), { code: "EAUTH" }); return { messageId: `<ok${smtpCalls}@t>` }; } }),
    cardPricer: (b) => priceCardCart(b, { fetchImpl: quote(), volumeDiscount: true }),
    cryptoPricer: (b) => priceCryptoCart(b, { fetchImpl: quote(), volumeDiscount: true }),
    adapters: { umg: { async createPayment() { return { ok: true, processor: "umg", processorTxnId: "U-1", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } }, tagada: {}, centrobill: {} },
  });
  server.handler?.orderEmailer; // eslint-disable-line no-unused-expressions
  const base = `http://127.0.0.1:${server.address().port}`;
  const hdr = { "Content-Type": "application/json" };
  const staff = { "Content-Type": "application/json", "X-Marketing-Key": KEY };
  const customer = { first_name: "Ada", last_name: "N", email: "ada@lab.example", address: "1 Research Way", city: "SF", state: "CA", zip: "94107", country: "US" };
  const waitFor = async (fn) => { for (let i = 0; i < 100; i += 1) { if (fn()) return true; await new Promise((r) => setTimeout(r, 20)); } return false; };
  try {
    // card: SMTP always fails for the confirmation -> checkout still 200; failure recorded after retries (real backoff skipped: first attempt is enough to prove no-block)
    const t0 = Date.now();
    const c = await fetch(`${base}/api/checkout/charge`, { method: "POST", headers: hdr, body: JSON.stringify({ idempotencyKey: "E-C1", customer, card: { name: "Ada", number: "4242424242424242", month: "12", year: "28", cvv: "123" }, amount: "176.99", shipMethod: "express", items: [{ sku: "bpc-157-10mg", qty: 2, amount: "79.00" }] }) });
    assert.equal(c.status, 200);
    const cb = await c.json();
    assert.ok(Date.now() - t0 < 1500);
    assert.ok(await waitFor(() => store.getOrder(cb.order.id)?.emails?.confirmation?.status === "failed"), JSON.stringify(store.getOrder(cb.order.id)?.emails));

    // crypto: pending -> no email; mark-paid -> confirmation; tracking -> shipping
    const k = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: hdr, body: JSON.stringify({ idempotencyKey: "E-X1", network: "trc20", customer, amount: "158.00", items: [{ sku: "bpc-157-10mg", name: "BPC", qty: 2, amount: "158.00" }] }) });
    const kb = await k.json();
    assert.equal(k.status, 200);
    assert.equal(store.getOrder(kb.orderId).emails, undefined);
    const unauth = await fetch(`${base}/api/emails/status`);
    assert.equal(unauth.status, 401);
    for (const [m, p] of [["GET", "/api/emails/log"], ["POST", "/api/emails/preview/confirmation"], ["POST", `/api/emails/resend/${kb.orderId}/confirmation`], ["POST", "/api/emails/process"], ["POST", `/api/fulfillment/${kb.orderId}/tracking`]]) {
      assert.equal((await fetch(`${base}${p}`, { method: m, headers: hdr, body: m === "POST" ? "{}" : undefined })).status, 401, p);
    }
    const early = await fetch(`${base}/api/fulfillment/${kb.orderId}/tracking`, { method: "POST", headers: staff, body: JSON.stringify({ carrier: "USPS", trackingNumber: "9400111899223197428490" }) });
    assert.equal(early.status, 409);
    trcChain.addTx({ hash: TX_TRON, to: TRC_W, units: kb.payAmountUnits, blockNumber: 5000 - 25 });
    const paid = await fetch(`${base}/api/store-orders/${kb.orderId}/mark-paid`, { method: "POST", headers: staff, body: JSON.stringify({ txHash: TX_TRON, amountReceived: kb.amountDue }) });
    assert.equal(paid.status, 200);
    assert.ok(await waitFor(() => store.getOrder(kb.orderId)?.emails?.confirmation?.status === "sent"));
    const trk = await fetch(`${base}/api/fulfillment/${kb.orderRef}/tracking`, { method: "POST", headers: staff, body: JSON.stringify({ carrier: "USPS", trackingNumber: "9400111899223197428490" }) });
    assert.equal(trk.status, 200);
    assert.ok(await waitFor(() => store.getOrder(kb.orderId)?.emails?.shipping?.status === "sent"));
    const ko = store.getOrder(kb.orderId);
    assert.equal(ko.fulfillment.status, "shipped");

    const st = await fetch(`${base}/api/emails/status`, { headers: staff }).then((r) => r.json());
    assert.equal(st.enabled, true);
    assert.equal(st.supportPasswordSet, true);
    assert.ok(!JSON.stringify(st).includes('"x"'));
    assert.ok(st.types.includes("followup"));
    const lg = await fetch(`${base}/api/emails/log?orderId=${kb.orderId}`, { headers: staff }).then((r) => r.json());
    assert.deepEqual(lg.entries.map((x) => x.type), ["confirmation", "shipping"]);
    assert.equal(lg.entries[0].to, maskEmail("ada@lab.example"));
    const pv = await fetch(`${base}/api/emails/preview/followup`, { method: "POST", headers: staff, body: "{}" }).then((r) => r.json());
    assert.equal(pv.subject, FOLLOWUP_QUESTION);
    assert.deepEqual(pv.guard, []);
    const fu = await fetch(`${base}/api/emails/process`, { method: "POST", headers: staff, body: JSON.stringify({ orderId: kb.orderId, forceFollowup: true }) }).then((r) => r.json());
    assert.deepEqual(fu.results.map((x) => [x.type, x.status]), [["followup", "sent"]]);
    const rs = await fetch(`${base}/api/emails/resend/${kb.orderId}/shipping`, { method: "POST", headers: staff, body: "{}" }).then((r) => r.json());
    assert.equal(rs.status, "sent");
  } finally {
    await new Promise((r) => server.close(r));
    for (const k of Object.keys(process.env)) if (!(k in prev)) delete process.env[k];
    Object.assign(process.env, prev);
  }
});

test("header logo: all three templates show the hosted https logo (alt, ~200px), text part and RUO footer unchanged", async () => {
  const { EMAIL_LOGO_URL, logoSrc } = await import("../lib/email-templates.js");
  assert.equal(EMAIL_LOGO_URL, "https://biolabsresearch.co/media/email/biolabs-logo-email.png");
  for (const type of ["confirmation", "shipping", "followup"]) {
    const r = renderEmail(type, sampleOrder(type));
    const imgs = r.html.match(/<img [^>]*>/g) || [];
    assert.equal(imgs.length, 1, type);
    assert.ok(imgs[0].includes(`src="${EMAIL_LOGO_URL}"`), type);
    assert.ok(imgs[0].includes('alt="BioLabs Research"'), type);
    const w = Number(imgs[0].match(/width="(\d+)"/)[1]);
    assert.ok(w >= 180 && w <= 200, type);
    assert.ok(!r.html.includes(">BIO LABS</span>"), type); // old text header replaced
    assert.ok(!r.text.includes("biolabs-logo"), type);      // plain-text part has no header/logo
    assert.ok(r.text.includes(RUO_FOOTER) && r.html.includes(RUO_FOOTER), type);
    assert.deepEqual(r.guard, [], type);
  }
  // previews may inline the image; real emails only take https URLs
  const data = "data:image/png;base64,iVBORw0KGgo=";
  assert.ok(renderEmail("shipping", sampleOrder("shipping"), { logoUrl: data }).html.includes(`src="${data}"`));
  assert.equal(logoSrc("http://biolabsresearch.co/x.png", {}), EMAIL_LOGO_URL);
  assert.equal(logoSrc('https://x.test/a.png" onerror="x', {}), EMAIL_LOGO_URL);
  assert.equal(logoSrc(undefined, { ORDER_EMAIL_LOGO_URL: "https://cdn.biolabsresearch.co/l.png" }), "https://cdn.biolabsresearch.co/l.png");
  assert.equal(logoSrc(undefined, { ORDER_EMAIL_LOGO_URL: "javascript:alert(1)" }), EMAIL_LOGO_URL);
});

test("order number never wraps in HTML (nowrap span), plain text unchanged; also in the crypto cancel email", async () => {
  const { escNb } = await import("../lib/email-templates.js");
  assert.equal(escNb("order BLR-1099 (CR-R9N3N3MR)."), 'order <span style="white-space:nowrap;">BLR-1099</span> (<span style="white-space:nowrap;">CR-R9N3N3MR</span>).');
  for (const type of ["confirmation", "shipping", "followup"]) {
    const r = renderEmail(type, sampleOrder(type));
    const body = r.html.split("<body")[1].replace(/<div style="display:none;[^>]*>[^<]*<\/div>/, ""); // hidden preheader excluded
    const bare = body.replace(/<span style="white-space:nowrap;">BLR-1099<\/span>/g, "").replace(/mailto:[^"]+/g, "");
    assert.ok(body.includes('<span style="white-space:nowrap;">BLR-1099</span>'), type);
    assert.ok(!/BLR-1099/.test(bare), `${type}: unwrapped order number in HTML`);
    assert.ok(r.text.includes("BLR-1099") && !r.text.includes("white-space") && !r.text.includes("\u2011"), type);
  }
  const { CANCEL_EMAIL_TYPE } = await import("../lib/crypto-notify.js");
  const em = createOrderEmailer({ db: createStore({ memoryOnly: true }), cfg: emailConfig({}), log: createEmailLog(null), logger: () => {} });
  const order = { ...sampleOrder("confirmation"), id: "BLR-1100", orderRef: "CR-R9N3N3MR", paymentMethod: "crypto", status: "crypto_cancelled", amountDue: "150.10", crypto: { network: "trc20" } };
  const c = em.preview(CANCEL_EMAIL_TYPE, order, { minutes: 60 });
  assert.deepEqual(c.guard, []);
  assert.ok(c.html.includes('<span style="white-space:nowrap;">CR-R9N3N3MR</span>'));
  assert.ok(c.html.includes('<span style="white-space:nowrap;">BLR-1100</span>'));
  assert.ok(!/CR-R9N3N3MR/.test(c.html.split("<body")[1].replace(/<span style="white-space:nowrap;">CR-R9N3N3MR<\/span>/g, "")));
  assert.ok(c.text.includes("order BLR-1100 (CR-R9N3N3MR) within 60 minutes"));
  assert.equal(c.subject, "Payment not received, order cancelled (BLR-1100)");
  assert.ok(c.text.includes(RUO_FOOTER));
});

test("crypto confirmation: 'Paid with' shows the asset + network from the crypto payment record (3 combos + fallback)", async () => {
  const { cryptoPaidWith } = await import("../lib/email-templates.js");
  const base = { ...sampleOrder("confirmation"), paymentMethod: "crypto", status: "crypto_paid", paymentConfirmed: true };
  const mk = (token, network, transfers = [{ token, network, success: true }]) => ({ ...base, crypto: { network }, cryptoPayment: { token: "USDT", network, transfers } });
  const cases = [["USDT", "trc20", "USDT (TRC20)"], ["USDT", "erc20", "USDT (ERC20)"], ["USDC", "erc20", "USDC (ERC20)"]];
  for (const [tok, net, want] of cases) {
    assert.equal(cryptoPaidWith(mk(tok, net)), want);
    const r = renderEmail("confirmation", mk(tok, net));
    assert.ok(r.text.includes(`Paid with: ${want}`), want);
    assert.ok(!r.text.includes("TRC20/ERC20"));
    assert.deepEqual(r.guard, []);
  }
  // no transfer recorded yet -> the order's own token/network
  assert.equal(cryptoPaidWith({ ...base, crypto: { network: "erc20" }, cryptoPayment: { token: "USDC", network: "erc20", transfers: [] } }), "USDC (ERC20)");
  // card orders are unchanged
  assert.ok(renderEmail("confirmation", sampleOrder("confirmation")).text.includes("Payment: Card"));
});
