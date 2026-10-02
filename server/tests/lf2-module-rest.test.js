// audit 2026-10-02, batch LF2-module-rest (low findings in the payment module libs). Invented data only; nothing leaves the process.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInventoryStore, buildInventoryView, markPurchaseOrderReceived } from "../lib/inventory.js";
import { createStore } from "../lib/store.js";
import { secretHealth } from "../lib/secrets.js";
import { sendQuoteNotification } from "../lib/mail.js";
import { createQuote } from "../lib/quote.js";
import { fetchCrmSession } from "../lib/operator-auth.js";
import { createOrderEmailer, emailConfig, createEmailLog } from "../lib/order-emails.js";
import { applyRapidRecord } from "../lib/rapid-orders.js";
import { deliveryWindow } from "../lib/email-templates.js";
import { createHumanUse, defaultSources } from "../lib/human-use.js";

function capture(fn) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => { lines.push(String(chunk).trimEnd()); return true; };
  try { return { result: fn(), lines }; } finally { process.stdout.write = orig; }
}
const SAMPLE_TERMS = new URL("./fixtures/human-use-terms.sample.json", import.meta.url).pathname;

// ---- #95 (medium) inventory lines / movements -------------------------------------------------------------------------
function poWithTwoLinesOfOneSku(store) {
  store.upsertSku({ id: "sku:T-1", code: "T-1", name: "T-1 5mg" });
  store.upsertPurchaseOrder({ po_id: "PO-X", po_number: "PO-X", supplier: "Test Supplier", dated: "2026-10-01", status: "PAID_IN_TRANSIT" });
  store.upsertLine({ id: "ln:PO-X:a", po_id: "PO-X", line_no: 1, sku_id: "sku:T-1", qty: 10, unit_cost_cents: 1000, line_total_cents: 10000 });
  store.upsertLine({ id: "ln:PO-X:b", po_id: "PO-X", line_no: 2, sku_id: "sku:T-1", qty: 5, unit_cost_cents: 1200, line_total_cents: 6000 });
}

test("#95 inventory: two lines of one PO with the same SKU stay two lines, and Mark Received books both quantities", { skip: "held back 2026-10-02: lib/inventory.js is not deployed (PVC-092326 is RECEIVED on prod with 28 lines / 21 movements; needs a plan for the live ledger)" }, () => {
  const store = createInventoryStore({ memoryOnly: true });
  poWithTwoLinesOfOneSku(store);
  assert.equal(store.listLines().length, 2, "the second line must not overwrite the first");
  const r = markPurchaseOrderReceived(store, "PO-X", "tester@example.test", "2026-10-02T00:00:00.000Z");
  assert.equal(r.ok, true);
  assert.equal(r.movements_created, 2);
  const mv = store.listMovements();
  assert.deepEqual(mv.map((m) => m.idempotency_key), ["PO-X|sku:T-1|PO_INTAKE", "PO-X|sku:T-1|PO_INTAKE|ln:PO-X:b"], "first line keeps the old key shape");
  assert.equal(new Set(mv.map((m) => m.id)).size, 2);
  const view = buildInventoryView(store);
  assert.equal(view.skus[0].on_hand, 15);
  assert.equal(view.skus[0].weighted_avg_unit_cost, "10.67"); // (10*10.00 + 5*12.00) / 15
  const again = markPurchaseOrderReceived(store, "PO-X", "tester@example.test", "2026-10-02T01:00:00.000Z");
  assert.equal(again.movements_created, 0);
  assert.equal(again.movements_existing, 2);
  assert.equal(store.listMovements().length, 2);
});

test("#95 inventory: a file written before this change (one movement, old key) still loads; a repeat Mark Received adds only the missing line", { skip: "held back 2026-10-02: lib/inventory.js is not deployed (PVC-092326 is RECEIVED on prod with 28 lines / 21 movements; needs a plan for the live ledger)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const file = join(dir, "inventory.json");
  const seed = createInventoryStore({ filePath: file });
  poWithTwoLinesOfOneSku(seed);
  // what the old code left behind: only the first line's movement, with the old key, and the PO already RECEIVED
  writeFileSync(file, JSON.stringify({
    ...JSON.parse(readFileSync(file, "utf8")),
    inventory_movements: [{ id: "mv:PO-X:sku:T-1:PO_INTAKE", sku_id: "sku:T-1", po_id: "PO-X", type: "PO_INTAKE", qty: 10, unit_cost_cents: 1000, created_by: "old", created_at: "2026-10-01T00:00:00.000Z", idempotency_key: "PO-X|sku:T-1|PO_INTAKE" }],
  }));
  const store = createInventoryStore({ filePath: file });
  assert.equal(store.listMovements().length, 1);
  const r = markPurchaseOrderReceived(store, "PO-X", "tester@example.test", "2026-10-02T00:00:00.000Z");
  assert.equal(r.movements_created, 1, "only the line the old code dropped");
  assert.equal(r.movements_existing, 1);
  assert.equal(buildInventoryView(store).skus[0].on_hand, 15);
});

// ---- #347 / #587 / #814 inventory.json write and unreadable file --------------------------------------------------------
test("#347 inventory.json: written through a temp file, the previous version kept as .prev, no temp file left", { skip: "held back 2026-10-02: lib/inventory.js is not deployed (PVC-092326 is RECEIVED on prod with 28 lines / 21 movements; needs a plan for the live ledger)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const file = join(dir, "inventory.json");
  const store = createInventoryStore({ filePath: file });
  store.upsertSku({ code: "T-1", name: "T-1 5mg" });
  store.upsertSku({ code: "T-2", name: "T-2 5mg" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).skus.length, 2);
  assert.equal(JSON.parse(readFileSync(`${file}.prev`, "utf8")).skus.length, 1);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
});

test("#347 inventory.json unreadable: loads .prev, keeps the broken file aside and says so", { skip: "held back 2026-10-02: lib/inventory.js is not deployed (PVC-092326 is RECEIVED on prod with 28 lines / 21 movements; needs a plan for the live ledger)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const file = join(dir, "inventory.json");
  const s = createInventoryStore({ filePath: file });
  s.upsertSku({ code: "T-1", name: "T-1 5mg" });
  s.upsertSku({ code: "T-2", name: "T-2 5mg" });
  writeFileSync(file, '{"skus": [{"id"'); // torn write
  const { result, lines } = capture(() => createInventoryStore({ filePath: file }));
  assert.equal(result.listSkus().length, 1, "the previous good version, not an empty ledger");
  assert.ok(lines.some((l) => l.startsWith("[pay-alert] INVENTORY_FROM_PREV")));
  assert.ok(readdirSync(dir).some((n) => n.startsWith("inventory.json.corrupt-")));
});

test("#347 inventory.json and .prev both unreadable: alert, writes refused, the file is left exactly as it is", { skip: "held back 2026-10-02: lib/inventory.js is not deployed (PVC-092326 is RECEIVED on prod with 28 lines / 21 movements; needs a plan for the live ledger)" }, () => {
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const file = join(dir, "inventory.json");
  writeFileSync(file, "not json at all");
  const { result: store, lines } = capture(() => createInventoryStore({ filePath: file }));
  assert.ok(lines.some((l) => l.startsWith("[pay-alert] INVENTORY_UNREADABLE")));
  assert.equal(store.listSkus().length, 0);
  assert.throws(() => store.upsertSku({ code: "T-1", name: "T-1 5mg" }), /inventory_file_unreadable/);
  assert.equal(readFileSync(file, "utf8"), "not json at all");
});

// ---- #345 store.json compact + no pointless rewrite, #815 permissions -----------------------------------------------------
test("#345 store.json: written compact, a write that changes nothing is skipped, an old indented file still loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const file = join(dir, "store.json");
  writeFileSync(file, JSON.stringify({ seq: 1234, orders: [], quotes: [] }, null, 2)); // the old format
  const s = createStore({ filePath: file });
  assert.equal(s.nextOrderId(), "BLR-1235");
  assert.ok(!readFileSync(file, "utf8").includes("\n"), "compact JSON");
  const old = new Date(Date.now() - 3600_000);
  utimesSync(file, old, old);
  s.saveCryptoState({}); // changes nothing
  assert.ok(Math.abs(statSync(file).mtimeMs - old.getTime()) < 1000, "identical content must not rewrite the file");
  s.nextOrderId();
  assert.ok(statSync(file).mtimeMs > old.getTime() + 1000, "a real change is written");
  assert.equal(JSON.parse(readFileSync(file, "utf8")).seq, 1236);
});

test("#815 store.json: a new file is created 0600 (buyer addresses, phones, e-mails)", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-"));
  const file = join(dir, "store.json");
  createStore({ filePath: file }).nextOrderId();
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

// ---- #363 public health answer -------------------------------------------------------------------------------------------
test("#363 secretHealth (public /api/psp/health): reports whether the secret is set, never where the file is", () => {
  const h = secretHealth();
  assert.equal(typeof h.umgSecretConfigured, "boolean");
  assert.ok(!("umgEnvPath" in h));
  assert.ok(!JSON.stringify(h).includes("/"), JSON.stringify(h));
});

// ---- #669 / #760 / #364 / #631 quote notification mail ---------------------------------------------------------------------
const QUOTE = { id: "QT-1", idempotencyKey: "K1", amount: "10.00", currency: "USD", customer: { first_name: "Ada", email: "ada@example.test" }, items: [], notes: "" };
function withEnv(env, fn) {
  const keys = ["MAIL_WEBHOOK_URL", "MAIL_WEBHOOK_TOKEN", "CIO_TRANSACTIONAL_URL", "CIO_API_KEY", "MAIL_WEBHOOK_TIMEOUT_MS"];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  const restore = () => { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } };
  return Promise.resolve().then(fn).finally(restore);
}

test("#760 #364 quote mail without a transport is a failure, not a sent mail (emailSent:false)", async () => {
  await withEnv({}, async () => {
    await assert.rejects(sendQuoteNotification(QUOTE), /no_transport/);
    const store = createStore({ memoryOnly: true });
    const r = await createQuote({ idempotencyKey: "K-NOTRANSPORT-1", amount: "10.00", customer: { first_name: "Ada", last_name: "T", email: "ada@example.test" }, items: [{ sku: "qa-10mg", name: "QA", qty: 1, amount: "10.00" }] }, { store, sendQuoteEmail: sendQuoteNotification });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(store.getQuote(r.quoteId).emailSent, false);
  });
});

test("#669 #631 quote mail webhook that never answers is cut after MAIL_WEBHOOK_TIMEOUT_MS", { timeout: 5000 }, async () => {
  const sockets = new Set();
  const server = createServer(() => { /* never answers */ });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await withEnv({ MAIL_WEBHOOK_URL: `http://127.0.0.1:${server.address().port}/`, MAIL_WEBHOOK_TIMEOUT_MS: "150" }, async () => {
      const t0 = Date.now();
      await assert.rejects(sendQuoteNotification(QUOTE), (e) => e?.name === "TimeoutError" || e?.name === "AbortError");
      assert.ok(Date.now() - t0 < 3000);
    });
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  }
});

// ---- #705 CRM session check timeout ------------------------------------------------------------------------------------------
function slowSession(ms) {
  return (url, init) => new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ ok: true, json: async () => ({ user: { email: "staff@example.test" } }) }), ms);
    init.signal.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  });
}
test("#705 CRM session check waits long enough for a busy blitz-api (default 3 s), CRM_AUTH_TIMEOUT_MS still overrides", async () => {
  const ok = await fetchCrmSession("tok", { fetchImpl: slowSession(1200), env: {} });
  assert.equal(ok.ok, true, "a 1.2 s answer used to be cut at 0.8 s and read as 'not logged in'");
  const cut = await fetchCrmSession("tok", { fetchImpl: slowSession(1200), env: { CRM_AUTH_TIMEOUT_MS: "100" } });
  assert.equal(cut.ok, false);
});

// ---- #368 follow-up e-mail needs shippedAt ----------------------------------------------------------------------------------------
function emailerFor(order) {
  const store = createStore({ memoryOnly: true });
  store.upsertOrder(order);
  const sent = [];
  const em = createOrderEmailer({
    db: store, cfg: emailConfig({ ORDER_EMAILS_ENABLED: "true", SUPPORT_SMTP_HOST: "smtp.test", SUPPORT_SMTP_USER: "s@x", SUPPORT_SMTP_PASS: "x", ORDER_EMAILS_ALERT_TO: "" }),
    log: createEmailLog(join(mkdtempSync(join(tmpdir(), "el-")), "l.jsonl")), transportFactory: () => ({ async sendMail(m) { sent.push(m); return { messageId: "x" }; } }), sleep: async () => {}, logger: () => {},
  });
  return { em, sent };
}
const shippedOrder = (shippedAt) => ({
  id: "BLR-5001", createdAt: new Date(Date.now() + 2000).toISOString(), status: "approved", paymentMethod: "card", amount: "10.00",
  customer: { first_name: "Ada", email: "ada@example.test" }, items: [{ sku: "qa-10mg", name: "QA", qty: 1, amount: "10.00" }],
  emails: { confirmation: { status: "sent" }, shipping: { status: "sent" } },
  fulfillment: { status: "shipped", trackingNumber: "9400111899223197428490", ...(shippedAt ? { shippedAt } : {}) },
});
test("#368 follow-up: shipped order without shippedAt does not get the follow-up at once; a week-old shippedAt does", async () => {
  const a = emailerFor(shippedOrder(null));
  const ra = await a.em.processDue({ orderId: "BLR-5001" });
  assert.deepEqual(ra.started, [], "no shippedAt = no follow-up");
  const b = emailerFor(shippedOrder(new Date(Date.now() - 30 * 86400000).toISOString()));
  const rb = await b.em.processDue({ orderId: "BLR-5001" });
  assert.deepEqual(rb.started, ["BLR-5001:followup"]);
});

// ---- #737 Rapid ship date ------------------------------------------------------------------------------------------------------
test("#737 Rapid ship_date (a Pacific calendar date) keeps its date in UTC, so the e-mail delivery window starts on the right day", () => {
  const store = createStore({ memoryOnly: true });
  const order = { id: "BLR-6001", status: "approved", paymentMethod: "card", customer: { email: "ada@example.test" }, items: [], rapid: { status: "pushed" } };
  store.upsertOrder(order);
  applyRapidRecord(store, store.getOrder("BLR-6001"), { status: "shipped", trackingno: "9400111899223197428490", ship_date: "2026-10-05", ship_method: "usps_rrd_priority" });
  const shippedAt = store.getOrder("BLR-6001").fulfillment.shippedAt;
  assert.ok(shippedAt.startsWith("2026-10-05T"), shippedAt); // Monday
  assert.equal(deliveryWindow(shippedAt, { shipMethod: "express" }).text, "Tue, Oct 6 – Thu, Oct 8"); // 1-3 business days from Monday
});

// ---- #350 human-use: no more silent failures --------------------------------------------------------------------------------------
test("#350 human-use: empty / unreadable term list raises [pay-alert] HUMAN_USE_NO_TERMS, once per 30 minutes", () => {
  const dir = mkdtempSync(join(tmpdir(), "hu-"));
  const lines = [];
  let t = Date.parse("2026-10-02T10:00:00Z");
  const hu = createHumanUse({ db: createStore({ memoryOnly: true }), sources: [], termsPath: join(dir, "missing.json"), statePath: join(dir, "s.json"), auditPath: join(dir, "a.jsonl"), log: (m) => lines.push(m), now: () => new Date(t) });
  assert.equal(hu.scan().ok, false);
  assert.equal(hu.scan().ok, false);
  assert.equal(lines.filter((l) => l.startsWith("[pay-alert] HUMAN_USE_NO_TERMS")).length, 1);
  t += 31 * 60 * 1000;
  hu.scan();
  assert.equal(lines.filter((l) => l.startsWith("[pay-alert] HUMAN_USE_NO_TERMS")).length, 2);
});

test("#350 human-use: no state / audit path at start raises [pay-alert] HUMAN_USE_PATHS_UNSET", () => {
  const lines = [];
  createHumanUse({ db: createStore({ memoryOnly: true }), sources: [], termsPath: SAMPLE_TERMS, log: (m) => lines.push(m) });
  assert.ok(lines.some((l) => l.startsWith("[pay-alert] HUMAN_USE_PATHS_UNSET")), lines.join("\n"));
});

test("#350 human-use: a source file that is missing or cannot be parsed raises [pay-alert], a good one does not; other sources keep running", () => {
  const dir = mkdtempSync(join(tmpdir(), "hu-"));
  const good = join(dir, "leads.json");
  writeFileSync(good, JSON.stringify([{ id: 1, email: "ada@example.test", notes: "hello" }]));
  const run = (leadsPath) => {
    const lines = [];
    const env = { HUMAN_USE_LEADS_PATH: leadsPath };
    const sources = defaultSources(env, null).filter((s) => s.id === "lead_note");
    const hu = createHumanUse({ db: createStore({ memoryOnly: true }), sources, termsPath: SAMPLE_TERMS, statePath: join(mkdtempSync(join(tmpdir(), "hu-")), "s.json"), auditPath: join(dir, "a.jsonl"), log: (m) => lines.push(m) });
    const r = hu.scan();
    return { r, lines };
  };
  const ok = run(good);
  assert.equal(ok.r.bySource.lead_note.items, 1);
  assert.ok(!ok.lines.some((l) => l.includes("HUMAN_USE_SOURCE_")));
  const bad = join(dir, "broken.json");
  writeFileSync(bad, '[{"id": 1, "email"');
  const broken = run(bad);
  assert.ok(broken.r.bySource.lead_note.error);
  assert.ok(broken.lines.some((l) => l.startsWith("[pay-alert] HUMAN_USE_SOURCE_LEAD_NOTE")), broken.lines.join("\n"));
  const missing = run(join(dir, "nowhere.json"));
  assert.ok(missing.lines.some((l) => l.startsWith("[pay-alert] HUMAN_USE_SOURCE_LEAD_NOTE")));
});

test("#350 human-use: the chat source does not re-read a conversation file whose mtime and size did not change", () => {
  const dir = mkdtempSync(join(tmpdir(), "chat-"));
  const conv = (cid, text) => JSON.stringify({ cid, email: `${cid}@example.test`, lastAt: "2026-10-01T10:00:00Z", messages: [{ role: "visitor", text }] });
  const a = join(dir, "a.json");
  writeFileSync(a, conv("a", "hello one"));
  writeFileSync(join(dir, "b.json"), conv("b", "hello two"));
  const src = defaultSources({ HUMAN_USE_CHAT_DIR: dir }, null).find((s) => s.id === "shop_chat");
  assert.deepEqual(src.list().map((i) => i.ref).sort(), ["chat:a", "chat:b"]);
  // file unreadable now but mtime and size unchanged (chmod does not touch mtime): only the cache can still answer (as root chmod 000 does not
  // block reading, so there the check passes trivially)
  chmodSync(a, 0o000);
  try {
    assert.deepEqual(src.list().map((i) => i.ref).sort(), ["chat:a", "chat:b"], "unchanged file taken from the cache");
  } finally { chmodSync(a, 0o644); }
  // a real change is picked up
  writeFileSync(a, conv("a", "can I inject it?"));
  const refreshed = src.list().find((i) => i.ref === "chat:a");
  assert.equal(refreshed.parts[0].text, "can I inject it?");
});

// ---- #367 one-off backfill script ---------------------------------------------------------------------------------------------------
test("#367 backfill-store-forward-20260928.mjs refuses to run unless confirmed on purpose", () => {
  const script = new URL("../scripts/backfill-store-forward-20260928.mjs", import.meta.url).pathname;
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /refusing to run/);
  assert.ok(!existsSync("/var/lib/crm-umg/store.json.tmp"));
});
