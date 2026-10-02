// audit 2026-10-02 (batch LF1, payment module low findings): tests for the fixes in lib/. Harness pieces mirror
// crypto-verify.test.js / retry-same-key.test.js. No network, no data files.
import { test } from "node:test";
import "./helpers/ship48-default-address.js";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createStore } from "../lib/store.js";
import { createConsentLog } from "../lib/consent.js";
import { chargeCart } from "../lib/cascade.js";
import { cardFormatProblem, luhnValid } from "../lib/card.js";
import { corsHeadersForRequest, DEFAULT_CRYPTO_ORIGINS } from "../lib/cors.js";
import { stripSecrets, maskCardNumbers, cleanText } from "../lib/sanitize.js";
import { createCryptoCheckout, validateCryptoCheckout } from "../lib/crypto-checkout.js";
import { validateQuoteRequest } from "../lib/quote.js";
import { createCryptoVerifier } from "../lib/crypto-verify.js";
import { createSanctionsScreener } from "../lib/crypto-sanctions.js";
import { createTronAdapter } from "../lib/crypto-chains.js";
import { createOrderEmailer, emailConfig, createEmailLog } from "../lib/order-emails.js";
import { buildCreatePayload } from "../lib/processors/umg.js";
import { resetCleffoAlertState } from "../lib/cleffo-checkout.js";
import { bucketFor } from "../lib/routing.js";
import { createHandler } from "../index.js";
import { createMockChain, createMockScreener } from "./crypto-mock.js";

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

// ---------------------------------------------------------------- CORS (#53 / #81 / #143 / #821)

test("#53/#81/#143/#821 crypto CORS: the blrcommerce.io mirror (and www) may call /api/checkout/crypto; foreign origins and CRYPTO_CORS_ORIGINS still rule", { skip: "held back 2026-10-02: crypto on the mirror is the owner's decision; lib/cors.js keeps the storefront-only default" }, () => {
  const req = (origin) => ({ headers: { origin } });
  for (const origin of ["https://biolabsresearch.co", "https://www.biolabsresearch.co", "https://blrcommerce.io", "https://www.blrcommerce.io"]) {
    for (const path of ["/api/checkout/crypto", "/api/checkout/crypto/CR-ABCDEFGH/status", "/api/checkout/crypto/CR-ABCDEFGH/txid"]) {
      const h = corsHeadersForRequest(req(origin), path, {});
      assert.equal(h["Access-Control-Allow-Origin"], origin, `${origin} ${path}`);
      assert.match(h["Access-Control-Allow-Headers"], /X-Order-Token/);
    }
  }
  assert.deepEqual(corsHeadersForRequest(req("https://evil.example"), "/api/checkout/crypto", {}), {});
  assert.deepEqual(corsHeadersForRequest(req("https://blrcommerce.io.evil.example"), "/api/checkout/crypto", {}), {});
  assert.equal(DEFAULT_CRYPTO_ORIGINS.length, 4);
  // an explicit env value still replaces the default list
  assert.deepEqual(corsHeadersForRequest(req("https://blrcommerce.io"), "/api/checkout/crypto", { CRYPTO_CORS_ORIGINS: "https://biolabsresearch.co" }), {});
});

// ---------------------------------------------------------------- card format (#79)

test("#79 card.js: luhnValid / cardFormatProblem (format only: number, expiry not in the past, CVV 3-4 digits)", () => {
  assert.equal(luhnValid("4242424242424242"), true);
  assert.equal(luhnValid("4242 4242 4242 4242"), true);
  assert.equal(luhnValid("4242424242424241"), false);
  assert.equal(luhnValid("4111111111110003"), false);
  const now = new Date("2026-10-15T12:00:00Z");
  const ok = { number: "4242 4242 4242 4242", month: "10", year: "26", cvv: "123" };
  assert.equal(cardFormatProblem(ok, now), null, "current month is still valid");
  assert.equal(cardFormatProblem({ ...ok, year: "2026" }, now), null, "4-digit year");
  assert.equal(cardFormatProblem({ ...ok, month: "09" }, now), "expiry", "last month");
  assert.equal(cardFormatProblem({ ...ok, year: "25" }, now), "expiry");
  assert.equal(cardFormatProblem({ ...ok, month: "13" }, now), "expiry");
  assert.equal(cardFormatProblem({ ...ok, month: "" }, now), "expiry");
  assert.equal(cardFormatProblem({ ...ok, year: "2" }, now), "expiry");
  assert.equal(cardFormatProblem({ ...ok, cvv: "12" }, now), "cvv");
  assert.equal(cardFormatProblem({ ...ok, cvv: "12345" }, now), "cvv");
  assert.equal(cardFormatProblem({ ...ok, cvv: "12a" }, now), "cvv");
  assert.equal(cardFormatProblem({ ...ok, cvv: "1234" }, now), null, "4 digits (Amex)");
  assert.equal(cardFormatProblem({ ...ok, cvc: "123", cvv: undefined }, now), null, "cvc alias");
  assert.equal(cardFormatProblem({ ...ok, number: "4242424242424241" }, now), "number");
  assert.equal(cardFormatProblem({ ...ok, number: "424242" }, now), "number");
  assert.equal(cardFormatProblem({ ...ok, number: "" }, now), "number");
  assert.equal(cardFormatProblem(undefined, now), "number");
});

const CUST = { first_name: "Ann", last_name: "Buyer", email: "ann@example.test", phone: "8881234567", address: "1 Way", city: "Austin", state: "TX", zip: "73301", country: "US" };
const GOOD_CARD = { name: "A B", number: "4242424242424242", month: "12", year: "2099", cvv: "123" };
function cardStore() {
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  return store;
}
const cardBody = (over = {}) => ({ idempotencyKey: "K-LF1", amount: "20.00", customer: CUST, items: [{ sku: "bpc-157-10mg", name: "BPC-157", qty: 1, amount: "20.00" }], notes: "", session_id: "S1", card: GOOD_CARD, ...over });

test("#79 chargeCart with the REAL processors: a malformed card is refused before any order, attempt or request to UMG; mock adapters are not gated", async () => {
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = async () => { fetched += 1; throw new Error("network must not be touched"); };
  try {
    for (const card of [{ ...GOOD_CARD, number: "4242424242424241" }, { ...GOOD_CARD, year: "2020" }, { ...GOOD_CARD, cvv: "1" }]) {
      const store = cardStore();
      const r = await chargeCart(cardBody({ card }), { store });
      assert.equal(r.ok, false);
      assert.equal(r.error, "card_invalid");
      assert.equal(r.charged, false);
      assert.equal(r.message, "Please enter your card details to pay. You were not charged.", "an existing sentence, no new buyer text");
      assert.equal(r.order, undefined);
      assert.equal(store.listOrders().length, 0, "no order, so no attempt is counted against the buyer");
    }
    assert.equal(fetched, 0);
  } finally { globalThis.fetch = realFetch; }
  // mock adapters (CRM dry-run route, tests) carry scenario card numbers that are not Luhn-valid by design
  const store = cardStore();
  const calls = [];
  const adapters = { umg: { async createPayment(p) { calls.push(p); return { ok: true, processor: "umg", processorTxnId: "U1", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } }, tagada: {}, centrobill: {} };
  const r = await chargeCart(cardBody({ card: { ...GOOD_CARD, number: "4242424242420002", year: "20" } }), { store, adapters });
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
});

// ---------------------------------------------------------------- private data in free text (#388)

test("#388 sanitize: card-like numbers (13-19 digits, Luhn-valid) are masked in free text; phones, tracking numbers and short numbers stay", () => {
  assert.equal(maskCardNumbers("my card 4242 4242 4242 4242 exp 12/28"), "my card [card number removed] exp 12/28");
  assert.equal(maskCardNumbers("4242-4242-4242-4242"), "[card number removed]");
  assert.equal(maskCardNumbers("pan4242424242424242end"), "pan[card number removed]end");
  assert.equal(maskCardNumbers("call +1 888 123 4567 about 123456789012"), "call +1 888 123 4567 about 123456789012");
  assert.equal(maskCardNumbers("tracking 1234567890123456"), "tracking 1234567890123456", "16 digits that fail Luhn are not a card");
  assert.equal(maskCardNumbers(42), 42);
  // deeper than 8 levels the old code returned the raw value (secrets included); now a mask
  let deep = { number: "4242424242424242", secret: "s3" };
  for (let i = 0; i < 10; i += 1) deep = { l: deep };
  const out = JSON.stringify(stripSecrets(deep));
  assert.doesNotMatch(out, /4242|s3/);
  const shallow = stripSecrets({ a: { number: "4242424242424242", cvv: "123", keep: "x" } });
  assert.equal(shallow.a.keep, "x");
  assert.equal(shallow.a.cvv, "[redacted]");
});

test("#388 chargeCart: a card number pasted into notes / item names is not stored on the order", async () => {
  const store = cardStore();
  const adapters = { umg: { async createPayment() { return { ok: true, processor: "umg", processorTxnId: "U1", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } }, tagada: {}, centrobill: {} };
  const r = await chargeCart(cardBody({
    notes: "please use card 4242 4242 4242 4242 12/28 cvv 123",
    items: [{ sku: "bpc-157-10mg", name: "BPC 4242424242424242", qty: 1, amount: "20.00" }],
  }), { store, adapters });
  assert.equal(r.ok, true);
  const o = store.getOrder(r.order.id);
  assert.doesNotMatch(JSON.stringify({ n: o.notes, i: o.items }), /4242\s*4242\s*4242\s*4242/);
  assert.match(o.notes, /\[card number removed\]/);
  assert.equal(o.items[0].sku, "bpc-157-10mg");
  assert.equal(o.items[0].qty, 1);
});

test("#388 quote request (sibling path): a card number pasted into notes / item name is masked", () => {
  const q = validateQuoteRequest({ idempotencyKey: "Q-1", amount: "20.00", customer: { first_name: "A", email: "a@example.test" },
    items: [{ sku: "a", name: "A 4242424242424242", qty: 1, amount: "20.00" }], notes: "card 4242 4242 4242 4242" });
  assert.equal(q.ok, true, q.error);
  assert.doesNotMatch(JSON.stringify(q.value), /4242\s*4242/);
  assert.match(q.value.notes, /\[card number removed\]/);
});

// ---------------------------------------------------------------- customer fields (#758)

test("#758 cleanText: strings only, control characters become spaces, trimmed, capped; numbers are read as text", () => {
  assert.equal(cleanText("  Ann\u0000\r\nB\u202e ", 80), "Ann B");
  assert.equal(cleanText("x".repeat(500), 80).length, 80);
  assert.equal(cleanText({ a: 1 }, 80), "");
  assert.equal(cleanText(["a"], 80), "");
  assert.equal(cleanText(null, 80), "");
  assert.equal(cleanText(8881234567, 40), "8881234567");
});

test("#758 crypto checkout: customer fields are typed, cleaned and capped before they reach the order", () => {
  const base = { idempotencyKey: "K-1", amount: "20.00", network: "trc20", items: [{ sku: "a", name: "A", qty: 1, amount: "20.00" }] };
  const ok = validateCryptoCheckout({ ...base, customer: { first_name: "Ann\u0000\nX", last_name: "B", email: "ann@example.test", phone: 8881234567, address: "a".repeat(400), city: "c".repeat(300), state: "TX", zip: 73301, country: "US" } });
  assert.equal(ok.ok, true);
  const c = ok.value.customer;
  assert.equal(c.first_name, "Ann X");
  assert.equal(c.phone, "8881234567");
  assert.equal(c.address.length, 200);
  assert.equal(c.city.length, 80);
  assert.equal(c.zip, "73301");
  // objects / arrays are not names: with no usable name the existing 400 applies
  const obj = validateCryptoCheckout({ ...base, customer: { first_name: { x: 1 }, last_name: ["y"], email: "ann@example.test" } });
  assert.deepEqual([obj.ok, obj.error, obj.status], [false, "name_required", 400]);
  const em = validateCryptoCheckout({ ...base, customer: { first_name: "A", email: { a: 1 } } });
  assert.deepEqual([em.ok, em.error], [false, "email_required"]);
  const long = validateCryptoCheckout({ ...base, customer: { first_name: "A", email: `${"a".repeat(250)}@example.test` } });
  assert.deepEqual([long.ok, long.error], [false, "invalid_email"]);
  // notes: card-like numbers masked
  const n = validateCryptoCheckout({ ...base, customer: { first_name: "A", email: "a@example.test" }, notes: "pay with 4242424242424242" });
  assert.match(n.value.notes, /\[card number removed\]/);
});

test("#758 card paths: stored order customer is typed and capped (cascade); the UMG payload is cleaned too", async () => {
  const store = cardStore();
  const adapters = { umg: { async createPayment() { return { ok: false, processor: "umg", processorTxnId: "U1", processorStatus: "DECLINED", cascadeAction: "stop", declineClass: "hard", raw: {} }; } }, tagada: {}, centrobill: {} };
  const r = await chargeCart(cardBody({ customer: { ...CUST, first_name: { evil: true }, last_name: "L\u0007\nM", address: "a".repeat(900), phone: 8881234567 } }), { store, adapters });
  const o = store.getOrder(r.order.id);
  assert.equal(o.customer.first_name, "");
  assert.equal(o.customer.last_name, "L M");
  assert.equal(o.customer.address.length, 200);
  assert.equal(o.customer.phone, "8881234567");
  const p = buildCreatePayload({ customer: { ...CUST, first_name: "A\r\nB", address: "z".repeat(900) }, card: GOOD_CARD, amount: "20.00", currency: "USD", extOrderId: "K" });
  assert.equal(p.userData.first_name, "A B");
  assert.equal(p.userData.address.length, 200);
  assert.equal(p.userData.last_name, "Buyer");
});

// ---------------------------------------------------------------- OFAC list download (#352)

test("#352 sanctions: a hanging list download is cut after the timeout, screen() still returns (no stuck tick)", async () => {
  const hang = (url, init = {}) => new Promise((_, reject) => { init.signal?.addEventListener("abort", () => reject(new Error("aborted"))); });
  const dir = mkdtempSync(join(tmpdir(), "ofac-"));
  const logs = [];
  const sc = createSanctionsScreener({ env: { CRYPTO_OFAC_LIST_PATH: join(dir, "list.txt"), CHAINALYSIS_API_KEY: "" }, fetchImpl: hang, log: (m) => logs.push(m), fetchTimeoutMs: 40 });
  const guard = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r("STUCK"), 3000))]);
  const sc2 = createSanctionsScreener({ env: { CRYPTO_OFAC_LIST_PATH: join(dir, "other.txt"), CHAINALYSIS_API_KEY: "" }, fetchImpl: hang, log: () => {}, fetchTimeoutMs: 40 });
  assert.notEqual(await guard(sc2.refreshList().catch((e) => e.message)), "STUCK", "refreshList must end");
  const r = await guard(sc.screen(["0x" + "ab".repeat(20)]));
  assert.notEqual(r, "STUCK", "screen() must end");
  assert.equal(r.status, "unavailable");
  assert.ok(logs.some((l) => /refresh failed/.test(l)));
});

// ---------------------------------------------------------------- crypto verify harness

const ERC = `0x${"ab".repeat(20)}`;
const TRC = "TXfrivx3QHrYDwPcaj3ojEDQFvAzX8EdKv";
const ENV = { CRYPTO_USDT_ERC: ERC, CRYPTO_USDT_TRC: TRC, CRYPTO_VERIFY_ENABLED: "true" };
const SECRET = "s".repeat(48);
const hash = (n) => n.toString(16).padStart(64, "0");

function setup({ screener = createMockScreener(), env = {} } = {}) {
  let clock = Date.parse("2026-09-28T12:00:00Z");
  const now = () => new Date(clock);
  const store = createStore({ memoryOnly: true });
  const trc = createMockChain("trc20", { latest: 10000 });
  const erc = createMockChain("erc20", { latest: 20000 });
  const sent = [];
  const emailEnv = { ORDER_EMAILS_ENABLED: "true", SUPPORT_SMTP_HOST: "smtp.test", SUPPORT_SMTP_USER: "support@biolabsresearch.co", SUPPORT_SMTP_PASS: "x", ORDER_EMAILS_ALERT_TO: "" };
  const orderEmailer = createOrderEmailer({
    db: store, cfg: emailConfig(emailEnv), log: createEmailLog(join(mkdtempSync(join(tmpdir(), "elog-")), "email-log.jsonl")),
    transportFactory: () => ({ async sendMail(m) { sent.push(m); return { messageId: `m${sent.length}` }; } }), sleep: async () => {}, logger: () => {},
  });
  const fullEnv = { ...ENV, ...env };
  const fetchImpl = async () => ({ ok: true, status: 204 });
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
  return { store, trc, erc, verifier, create, sent, screener, advance: (ms) => { clock += ms; }, now, get clock() { return clock; } };
}

// A mock ERC-20 chain that honours [fromBlock, toBlock] like the real adapter and records every request.
function rangeAwareErc(chain) {
  const orig = chain.listIncoming.bind(chain);
  const calls = [];
  chain.listIncoming = async (address, { fromBlock, toBlock } = {}) => {
    calls.push({ fromBlock, toBlock });
    const r = await orig(address, {});
    return { transfers: r.transfers.filter((x) => x.blockNumber >= fromBlock && x.blockNumber <= toBlock), toBlock };
  };
  return calls;
}

test("#361/#707/#590/#625 ERC-20 scan after a long pause catches up in 3000-block chunks; nothing is skipped and no order is cancelled meanwhile", async () => {
  const t = setup();
  const calls = rangeAwareErc(t.erc);
  const o = t.create({ network: "erc20" });
  const idle = t.create({ network: "erc20" }); // never paid
  await t.verifier.tick(); // first scan, caught up: cursor = 20000
  assert.equal(t.store.getCryptoState().scan.erc20.cursorBlock, 20000);
  const s0 = t.store.getCryptoState().scan.erc20;
  const created = t.clock;
  // the service was down 12 hours: 3600 new blocks; the payer paid at block 20300 (30 minutes after the order), outside the last 3000 blocks
  t.advance(12 * 3600e3);
  t.erc.latest = 23600;
  t.erc.addTx({ hash: `0x${hash(7)}`, to: ERC, units: o.cryptoPayment.payUnits, blockNumber: 20300, timestamp: created + 30 * 60000 });
  calls.length = 0;
  await t.verifier.tick();
  const mid = t.store.getOrder(o.id);
  assert.ok(mid.cryptoPayment.transfers.some((x) => x.txHash === `0x${hash(7)}`), "the deposit in the previously skipped range is attached");
  assert.ok(calls.every((c) => c.toBlock - c.fromBlock <= 3000), JSON.stringify(calls));
  assert.equal(calls[0].fromBlock, 19995, "continues from the cursor, not from head - 3000");
  const s1 = t.store.getCryptoState().scan.erc20;
  assert.equal(s1.cursorBlock, 22995, "cursor = end of the range actually read");
  assert.equal(s1.lastOkAt, s0.lastOkAt, "a scan that has not reached the head is not 'scanned after the deadline'");
  assert.equal(t.store.getOrder(idle.id).cryptoPayment.status, "awaiting_payment", "no timeout cancel while the scan is still catching up");
  await t.verifier.tick();
  const s2 = t.store.getCryptoState().scan.erc20;
  assert.equal(s2.cursorBlock, 23600, "second chunk reaches the head");
  assert.equal(Date.parse(s2.lastOkAt), t.clock, "lastOkAt is set once the scan is complete");
  assert.equal(t.store.getOrder(idle.id).cryptoPayment.status, "cancelled", "after a complete scan the unpaid order times out as before");
});

test("#361 ERC-20 first scan of an old order reads the oldest part first, one chunk per tick", async () => {
  const t = setup();
  const calls = rangeAwareErc(t.erc);
  const o = t.create({ network: "erc20" });
  t.advance(30 * 3600e3); // 9000 blocks later, no scan yet
  t.erc.latest = 29000;
  await t.verifier.tick();
  const blocksBack = Math.ceil((t.clock - (Date.parse(o.createdAt) - 5 * 60000)) / 12000) + 20;
  assert.equal(calls[0].fromBlock, 29000 - blocksBack);
  assert.equal(calls[0].toBlock, calls[0].fromBlock + 3000);
  assert.equal(t.store.getCryptoState().scan.erc20.lastOkAt, undefined, "not complete yet");
  assert.equal(t.store.getOrder(o.id).cryptoPayment.status, "awaiting_payment", "no cancel from a partial scan");
});

function tronPages(pages) {
  // pages: array of arrays of raw TronGrid rows; fingerprint chains them
  let i = 0;
  return async (url) => {
    const rows = pages[Math.min(i, pages.length - 1)];
    const more = i < pages.length - 1;
    i += 1;
    return { ok: true, status: 200, json: async () => ({ success: true, data: rows, meta: more ? { fingerprint: `fp${i}` } : {} }) };
  };
}
const USDT_TRC20 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const row = (n, ts) => ({ transaction_id: hash(n), type: "Transfer", to: TRC, from: "TSenderAddr1111111111111111111111", value: "1000000", block_timestamp: ts, token_info: { address: USDT_TRC20 } });

test("#392 TRC-20 listIncoming reports a scan cut by maxPages (truncated + last timestamp)", async () => {
  const fetchImpl = tronPages([[row(1, 1000), row(2, 2000)], [row(3, 3000)], [row(4, 4000)]]);
  const a = createTronAdapter({ env: {}, fetchImpl, minGapMs: 0 });
  const cut = await a.listIncoming(TRC, { sinceMs: 0, maxPages: 2 });
  assert.equal(cut.length, 3);
  assert.equal(cut.truncated, true);
  assert.equal(cut.lastTimestamp, 3000);
  const fetch2 = tronPages([[row(1, 1000)], [row(2, 2000)]]);
  const full = await createTronAdapter({ env: {}, fetchImpl: fetch2, minGapMs: 0 }).listIncoming(TRC, { sinceMs: 0, maxPages: 5 });
  assert.equal(full.length, 2);
  assert.notEqual(full.truncated, true);
});

test("#392 TRC-20 scan that was cut does not move the cursor to 'now' and does not count as a complete scan", async () => {
  const t = setup();
  const o = t.create();
  const created = t.clock;
  t.advance(10 * 60000);
  const list = [];
  list.truncated = true;
  list.lastTimestamp = created + 120000;
  t.trc.listIncoming = async () => list;
  await t.verifier.tick();
  const s = t.store.getCryptoState().scan.trc20;
  assert.equal(s.cursorMs, created + 120000, "cursor stops where the page limit stopped it");
  assert.equal(s.lastOkAt, undefined, "an incomplete scan is not 'scanned after the deadline'");
  assert.equal(t.store.getOrder(o.id).cryptoPayment.status, "awaiting_payment");
  // a complete scan afterwards sets both
  t.trc.listIncoming = async () => [];
  await t.verifier.tick();
  const s2 = t.store.getCryptoState().scan.trc20;
  assert.equal(s2.cursorMs, t.clock);
  assert.equal(Date.parse(s2.lastOkAt), t.clock);
});

// ---------------------------------------------------------------- one bad order must not stop the loop (#708)

test("#708 crypto tick: an exception on one order is logged + alerted and the other orders and the timeouts still run", async () => {
  const bad = { ...createMockScreener(), calls: 0, config: { failClosed: true } };
  let n = 0;
  bad.screen = async (addrs) => { n += 1; if (n === 1) throw new Error("screen exploded"); return { status: "clear", sources: ["mock"], matches: [], errors: [], screenedAt: new Date().toISOString(), addresses: addrs }; };
  const t = setup({ screener: bad, env: { CRYPTO_ADMIN_MARK_PAID_REQUIRED: "false" } });
  const a = t.create();
  const b = t.create();
  const dead = t.create(); // never paid: cancelled by the timeout pass
  t.advance(5 * 60000);
  t.trc.addTx({ hash: hash(1), to: TRC, units: a.cryptoPayment.payUnits, blockNumber: 10000 - 21, timestamp: t.clock });
  t.trc.addTx({ hash: hash(2), to: TRC, units: b.cryptoPayment.payUnits, blockNumber: 10000 - 21, timestamp: t.clock, from: "TSenderAddr2222222222222222222222" });
  const cap = captureLogs();
  let res;
  try {
    await t.verifier.tick(); // first tick: both payments claimed; the first order's evaluation throws
    t.advance(2 * 3600e3);
    res = await t.verifier.tick(); // deadline of `dead` passed after a successful scan
  } finally { cap.stop(); }
  assert.ok(res, "tick finished");
  const states = [a, b].map((o) => t.store.getOrder(o.id).cryptoPayment.status);
  assert.ok(states.includes("paid") || states.some((s) => s !== "awaiting_payment"), `one of the paid orders moved on: ${states}`);
  assert.ok(cap.lines.some((l) => /^\[pay-alert\] CRYPTO_EVALUATE_FAILED /.test(l)), cap.lines.join("\n"));
  assert.equal(t.store.getOrder(dead.id).cryptoPayment.status, "cancelled", "timeouts still processed");
});

// ---------------------------------------------------------------- Cleffo link host alert (#595)

const CFG = { env: "sandbox", baseUrl: "https://apis-dev.cleffo.com", clientKey: "ck-test", signatureKey: "sig-test", apiKey: "api-test", baseUrlMismatch: false };
const CONSENT = { checks: { "ck-terms": true, "ck-ruo": true }, acceptedAt: "2026-09-28T15:40:00.000Z", pageVersion: "v-test" };
const ONLY = { cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 50, maxAttempts: 5, retryWindowMin: 120, cleffoOnly: true };
const EMAIL = (() => { for (let i = 0; ; i += 1) { const e = `lf1-${i}@example.test`; if (bucketFor(e, 50) === "cleffo") return e; } })();

async function setupCleffo(linkFor) {
  process.env.PAYMENTS_ENABLED = "true";
  resetCleffoAlertState();
  const store = cardStore();
  const consentLog = createConsentLog({ filePath: join(mkdtempSync(join(tmpdir(), "lf1-consent-")), "consent-log.jsonl") });
  let links = 0;
  const fetchImpl = async (url, init) => {
    if (init.method === "POST") {
      const b = JSON.parse(init.body);
      links += 1;
      const ref = `REF${links}api`;
      return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_link: linkFor(ref), transaction_reference_number: ref, merchant_order_id: b.data.merchant_order_id } }) };
    }
    return { status: 200, text: async () => JSON.stringify({ status: true, data: { payment_status: "pending" } }) };
  };
  const handler = createHandler({
    store, consentLog, publicUrl: "https://crm.test", routingConfig: () => ONLY, cleffoDeps: { config: CFG, fetchImpl },
    cardPricer: (b) => ({ ok: true, amount: "20.00", clientAmount: b.amount, mismatch: false, source: "test", subtotal: "20.00", shipping: "0.00", shipMethod: "", lines: [] }),
    forwardFetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }), text: async () => "{}" }),
    adapters: { umg: { async createPayment() { throw new Error("UMG must not be called"); } }, tagada: {}, centrobill: {} },
  });
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const charge = async (key, extra = {}) => {
    const r = await fetch(`${base}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      idempotencyKey: key, session_id: `S-${key}`, customer: { ...CUST, email: EMAIL }, amount: "20.00",
      items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 1, amount: "20.00" }], notes: "n1", consent: CONSENT, ...extra }) });
    return { status: r.status, body: await r.json() };
  };
  return { store, server, charge };
}

test("#595 Cleffo: a payment_link outside cleffo.com raises [pay-alert] CLEFFO_LINK_HOST (the answer to the page is unchanged); a cleffo.com link raises nothing", async () => {
  const cap = captureLogs();
  let bad, good;
  try {
    const t = await setupCleffo((ref) => `https://pay.not-cleffo.example/pay/${ref}?secret=x`);
    try { bad = await t.charge("K-HOST-1"); } finally { t.server.close(); }
    const t2 = await setupCleffo((ref) => `https://dev.cleffo.com/pay/api-checkout-session/${ref}`);
    try { good = await t2.charge("K-HOST-2"); } finally { t2.server.close(); }
  } finally { cap.stop(); }
  assert.equal(bad.status, 200);
  assert.equal(bad.body.processor, "cleffo");
  assert.match(bad.body.redirectUrl, /^https:\/\/pay\.not-cleffo\.example\//, "behaviour unchanged: the page's own check refuses the link");
  const alerts = cap.lines.filter((l) => l.startsWith("[pay-alert] CLEFFO_LINK_HOST"));
  assert.equal(alerts.length, 1, cap.lines.join("\n"));
  assert.match(alerts[0], /pay\.not-cleffo\.example/);
  assert.doesNotMatch(alerts[0], /secret=x|\?/, "host only, never the query");
  assert.equal(good.status, 200);
});

test("#388 Cleffo path: a card number pasted into notes is masked on the stored order", async () => {
  const t = await setupCleffo((ref) => `https://dev.cleffo.com/pay/api-checkout-session/${ref}`);
  try {
    const r = await t.charge("K-NOTE-1", { notes: "card 4242 4242 4242 4242" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const o = t.store.getOrderByIdempotency("K-NOTE-1");
    assert.doesNotMatch(o.notes, /4242\s*4242/);
    assert.match(o.notes, /\[card number removed\]/);
  } finally { t.server.close(); }
});
