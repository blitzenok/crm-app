// 2026-09-30 human-use flag + COMPLIANCE_HOLD, and the research-solvent gift stop.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { createHumanUse, setActiveHumanUse, scanText, compileTerms, humanUseBlocks, defaultSources, classifyHits } from "../lib/human-use.js";
import { pushEligibility, mapOrderToRapid } from "../lib/rapid-orders.js";
import { forwardOrder } from "../lib/store-forward.js";
import { isShippable } from "../lib/crypto-checkout.js";
import { stripGiftLines } from "../lib/pricing.js";
import { createOrderEmailer, emailConfig, createEmailLog } from "../lib/order-emails.js";
import { startCrmServer } from "../index.js";

const TERMS = new URL("../../etc/human-use-terms.json", import.meta.url).pathname;
// audit 2026-10-02 (tests-run-3): the Legal-approved list is server data (not in git). Order: HUMAN_USE_TERMS_PATH, repo etc/, the server path,
// then a sample file with just enough terms for these tests (tests/fixtures/human-use-terms.sample.json, NOT the approved list).
const SAMPLE_TERMS = new URL("./fixtures/human-use-terms.sample.json", import.meta.url).pathname;
const termsSource = () => process.env.HUMAN_USE_TERMS_PATH || [TERMS, "/etc/crm-umg/human-use-terms.json"].find((p) => existsSync(p)) || SAMPLE_TERMS;
function termsFile() {
  const d = mkdtempSync(join(tmpdir(), "hu-"));
  const p = join(d, "terms.json");
  copyFileSync(termsSource(), p);
  return { dir: d, path: p };
}
const cust = (email) => ({ first_name: "QA", last_name: "Test", email, address: "1 QA Way", city: "Austin", state: "TX", zip: "78701", country: "US" });

function setup(extraSources = []) {
  const store = createStore({ memoryOnly: true });
  const t = termsFile();
  const src = { chats: [], leads: [] };
  const sources = [
    { id: "order_note", list: () => store.listOrders().map((o) => ({ ref: o.id, email: o.customer?.email, parts: [{ text: o.notes }] })) },
    { id: "quote_note", list: () => store.listQuotes().map((q) => ({ ref: q.id, email: q.customer?.email, parts: [{ text: q.notes }] })) },
    { id: "lead_note", list: () => src.leads.map((l) => ({ ref: `lead:${l.id}`, email: l.email, parts: [{ text: l.notes }] })) },
    { id: "shop_chat", list: () => src.chats.map((c) => ({ ref: `chat:${c.cid}`, email: c.email, chatFlag: Boolean(c.flags?.humanUse), parts: c.messages.filter((m) => m.role === "user").map((m) => ({ text: m.text, at: m.at })) })) },
    ...extraSources,
  ];
  const hu = createHumanUse({ db: store, sources, termsPath: t.path, statePath: join(t.dir, "state.json"), auditPath: join(t.dir, "audit.jsonl"), log: () => {} });
  hu.install(); setActiveHumanUse(hu);
  return { store, hu, src, dir: t.dir };
}

test("terms: each approved term matches; ordinary research text does not", () => {
  const c = compileTerms(JSON.parse(readFileSync(termsSource(), "utf8")));
  const hit = (s) => scanText(s, c).map((h) => h.termId);
  assert.ok(hit("How do I INJECT this?").includes("inject"));
  assert.ok(hit("going subq daily").includes("subq"));
  assert.ok(hit("subcutaneous or intramuscular").includes("intramuscular"));
  assert.ok(hit("need insulin syringes").includes("insulin_syringe"));
  assert.ok(hit("pinning twice a week").includes("pin"));
  assert.ok(hit("what dosage should I use").includes("self_dose"));
  assert.ok(hit("2.5 mg per week").includes("mg_per_week"));
  assert.ok(hit("is it safe for my body").includes("self_ref"));
  assert.ok(hit("can I self-administer").includes("self_administer"));
  assert.ok(hit("reconstitute it and then inject").includes("reconstitute_inject"));
  assert.ok(hit("weight loss for me").includes("weight_loss_self"));
  assert.deepEqual(hit("Please ship to our lab, invoice to purchasing. COA for lot 12?"), []);
});

test("backfill: flag + hold every open order/quote of the customer; sources are never modified; audit is appended", () => {
  const { store, hu, src, dir } = setup();
  const e = "qa-test+hu1@biolabsresearch.co";
  store.upsertOrder({ id: "BLR-9001", status: "declined", test: true, customer: cust(e), items: [], notes: "" });
  store.upsertOrder({ id: "BLR-9002", status: "approved", test: true, paymentMethod: "card", customer: cust(e), items: [], notes: "" });
  store.upsertOrder({ id: "BLR-9003", status: "awaiting_crypto", test: true, paymentMethod: "crypto", customer: cust(e), items: [], notes: "" });
  store.upsertQuote({ id: "Q-9004", status: "quote_requested", test: true, customer: cust(e), items: [], notes: "" });
  src.leads.push({ id: 7, email: e.toUpperCase(), notes: "Source: chat. Chat 2026-09-30: how much should I inject for my body?" });
  const before = JSON.stringify(src.leads);
  assert.equal(humanUseBlocks(store.getOrder("BLR-9002")), false);
  const r = hu.scan({ backfill: true });
  assert.equal(r.ok, true);
  assert.deepEqual(r.newlyFlagged, [e]);
  assert.equal(JSON.stringify(src.leads), before, "correspondence untouched");
  assert.equal(hu.isFlagged(e), true);
  assert.equal(store.getOrder("BLR-9001").complianceHold, undefined, "closed order not held");
  for (const id of ["BLR-9002", "BLR-9003"]) {
    const o = store.getOrder(id);
    assert.equal(o.complianceHold.status, "COMPLIANCE_HOLD");
    assert.equal(o.complianceHold.active, true);
    assert.equal(o.notes, "", "only the hold field is added");
  }
  assert.equal(store.getQuote("Q-9004").complianceHold.status, "COMPLIANCE_HOLD");
  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(audit.some((a) => a.event === "flagged" && a.source === "lead_note" && a.snippet.includes("inject") && a.backfill === true));
  assert.ok(audit.some((a) => a.event === "hold_applied" && a.refs.includes("BLR-9002")));
  assert.ok(hu.view().alerts.some((a) => a.type === "human_use_flag"));
  // second pass: nothing new
  const r2 = hu.scan();
  assert.equal(r2.scanned, 0);
});

test("gates: held order -> Rapid refuses, no customer email, no store-forward, not shippable", async () => {
  const { store, hu } = setup();
  const e = "qa-test+hu2@biolabsresearch.co";
  store.upsertOrder({ id: "BLR-9011", createdAt: new Date().toISOString(), status: "approved", test: false, paymentMethod: "card", customer: cust(e), items: [{ sku: "qa-10mg", name: "QA", qty: 1, amount: "10.00" }], notes: "I will pin it subq" });
  const o = store.getOrder("BLR-9011");
  assert.equal(o.complianceHold.status, "COMPLIANCE_HOLD", "held at write time (notes scanned on creation)");
  assert.equal(pushEligibility(o, { allowRealOrders: true }).error, "compliance_hold");
  assert.equal(isShippable(o), false);
  const f = await forwardOrder(store, o.id, { force: true, fetchImpl: async () => { throw new Error("must not be called"); } });
  assert.equal(f.reason, "compliance_hold");
  const sent = [];
  const em = createOrderEmailer({
    db: store, cfg: emailConfig({ ORDER_EMAILS_ENABLED: "true", SUPPORT_SMTP_HOST: "smtp.test", SUPPORT_SMTP_USER: "s@x", SUPPORT_SMTP_PASS: "x", ORDER_EMAILS_ALERT_TO: "" }),
    log: createEmailLog(join(mkdtempSync(join(tmpdir(), "el-")), "l.jsonl")), transportFactory: () => ({ async sendMail(m) { sent.push(m); return { messageId: "x" }; } }), sleep: async () => {}, logger: () => {},
  });
  await em.processDue({ orderId: o.id });
  assert.equal((await em.send(o.id, "confirmation")).status, "skipped_compliance_hold");
  assert.equal(sent.length, 0, "no email to a held customer");
  assert.equal(hu.isFlagged(e), true);
});

test("new order from a flagged customer is held at creation; clear needs a note and releases; refused stays refused", () => {
  const { store, hu } = setup();
  const e = "qa-test+hu3@biolabsresearch.co";
  store.upsertOrder({ id: "BLR-9021", status: "approved", test: true, customer: cust(e), items: [], notes: "dosing for me please" });
  assert.equal(hu.isFlagged(e), true);
  store.upsertOrder({ id: "BLR-9022", status: "approved", test: true, customer: cust(e.toUpperCase()), items: [], notes: "" });
  assert.equal(store.getOrder("BLR-9022").complianceHold.reason, "human_use_flag_at_creation");
  assert.equal(hu.cancelRefuse("BLR-9021", { actor: "admin@x", note: "QA refuse" }).ok, true);
  assert.equal(store.getOrder("BLR-9021").complianceRefusal.refundNeeded, true);
  assert.equal(hu.clearFlag(e, { actor: "admin@x", note: "" }).error, "note_required");
  const c = hu.clearFlag(e, { actor: "admin@x", note: "QA false positive" });
  assert.equal(c.ok, true);
  assert.deepEqual(c.released, ["BLR-9022"]);
  assert.equal(humanUseBlocks(store.getOrder("BLR-9022")), false);
  assert.equal(humanUseBlocks(store.getOrder("BLR-9021")), true, "a refused order stays refused");
  assert.equal(hu.isFlagged(e), false);
});

test("shop chat: guard humanUse flag / user text flags by email; no email -> unlinked alert; chat data untouched", () => {
  const { store, hu, src } = setup();
  src.chats.push({ cid: "c1", email: "qa-test+chat@biolabsresearch.co", flags: { humanUse: true }, messages: [{ role: "user", text: "hello", at: "2026-09-30T10:00:00Z" }] });
  src.chats.push({ cid: "c2", email: null, flags: {}, messages: [{ role: "user", text: "can I inject it myself?" }, { role: "assistant", text: "inject" }] });
  src.chats.push({ cid: "c3", email: "qa-test+ok@biolabsresearch.co", flags: {}, messages: [{ role: "assistant", text: "we never discuss how to inject" }] });
  const before = JSON.stringify(src.chats);
  store.upsertOrder({ id: "BLR-9031", status: "awaiting_crypto", test: true, customer: cust("qa-test+chat@biolabsresearch.co"), items: [], notes: "" });
  const r = hu.scan({ backfill: true });
  assert.ok(r.newlyFlagged.includes("qa-test+chat@biolabsresearch.co"));
  assert.equal(r.newlyFlagged.includes("qa-test+ok@biolabsresearch.co"), false, "assistant text is not the customer");
  assert.equal(r.unlinked, 1);
  assert.equal(store.getOrder("BLR-9031").complianceHold.status, "COMPLIANCE_HOLD");
  assert.equal(JSON.stringify(src.chats), before);
  // the unlinked chat re-links when the visitor later gives an email (store.cjs sets conv.email)
  src.chats[1].email = "qa-test+late@biolabsresearch.co";
  const r2 = hu.scan();
  assert.ok(r2.newlyFlagged.includes("qa-test+late@biolabsresearch.co"));
});

test("shop chat default source reads the live store.cjs schema (visitor role, flags.humanUse) read-only", () => {
  const d = mkdtempSync(join(tmpdir(), "chat-"));
  const conv = { cid: "k1", tokenHash: "x", createdAt: "2026-09-30T10:00:00Z", lastAt: "2026-09-30T10:05:00Z", state: "ai", email: "QA-Test+live@biolabsresearch.co", flags: { offTopic: false, injection: true, priceCheck: false, humanUse: false },
    messages: [{ role: "visitor", text: "do you ship to Texas?" }, { role: "ai", text: "never inject" }, { role: "operator", text: "subq is not discussed" }] };
  writeFileSync(join(d, "k1.json"), JSON.stringify(conv));
  const conv2 = { ...conv, cid: "k2", email: "", flags: { ...conv.flags, humanUse: true }, messages: [{ role: "visitor", text: "hi" }] };
  writeFileSync(join(d, "k2.json"), JSON.stringify(conv2));
  const before = readFileSync(join(d, "k1.json"), "utf8") + readFileSync(join(d, "k2.json"), "utf8");
  const chat = defaultSources({ HUMAN_USE_CHAT_DIR: d, HUMAN_USE_LEADS_PATH: "/nonexistent", HUMAN_USE_MESSAGES_PATH: "/nonexistent", HUMAN_USE_SHOP_ORDERS_PATH: "/nonexistent" }, null).find((s) => s.id === "shop_chat");
  const store = createStore({ memoryOnly: true });
  const t = termsFile();
  const hu = createHumanUse({ db: store, sources: [chat], termsPath: t.path, statePath: join(t.dir, "s.json"), auditPath: join(t.dir, "a.jsonl"), log: () => {} });
  const r = hu.scan({ backfill: true });
  assert.equal(r.newlyFlagged.length, 0, "flags.injection and ai/operator text are not customer human-use");
  assert.equal(r.unlinked, 1, "guard humanUse without an email -> unlinked alert");
  conv.messages.push({ role: "visitor", text: "how much do I inject?" });
  writeFileSync(join(d, "k1.json"), JSON.stringify(conv));
  assert.deepEqual(hu.scan().newlyFlagged, ["qa-test+live@biolabsresearch.co"]);
  assert.equal(readFileSync(join(d, "k2.json"), "utf8"), JSON.stringify(conv2), "chat files untouched");
  assert.ok(before.length > 0);
});

test("gift stop: lines stripped; Rapid refuses any order still carrying one", () => {
  const r = stripGiftLines([{ sku: "bpc-157-10mg", name: "x", qty: 1 }, { sku: "research-solvent-10ml", name: "Research solvent 10mL", qty: 1, amount: "0.00" }, { sku: "x", name: "BAC water", qty: 1 }, { sku: "y", gift: true }]);
  assert.equal(r.stripped, 3);
  assert.deepEqual(r.items.map((i) => i.sku), ["bpc-157-10mg"]);
  setActiveHumanUse(null);
  const o = { id: "BLR-9041", status: "approved", customer: cust("qa@x.co"), items: [{ sku: "research-solvent-10ml", name: "Research solvent", qty: 1 }] };
  assert.equal(pushEligibility(o, { allowRealOrders: true }).error, "gift_line_refused");
  assert.throws(() => mapOrderToRapid({ ...o, customer: { ...o.customer } }, { cfg: {}, skuMap: { "research-solvent-10ml": { gift: true, internal_id: "GIFT-01" } } }), /gift_line_refused/);
});

test("HTTP: gift stripped at quote/crypto create; compliance endpoints staff-read, admin-write", async () => {
  const store = createStore({ memoryOnly: true });
  const t = termsFile();
  const hu = createHumanUse({ db: store, sources: [], termsPath: t.path, statePath: join(t.dir, "s.json"), auditPath: join(t.dir, "a.jsonl"), log: () => {} });
  const server = await startCrmServer(0, {
    store, humanUse: hu, sendQuoteEmail: async () => {}, cryptoConfirmSecret: "s".repeat(48),
    checkCrmSession: async (tok) => (tok === "admin" ? { user: { email: "admin@biolabsresearch.co", role: "admin" } } : tok === "staff" ? { user: { email: "yaniv@biolabsresearch.co", role: "staff" } } : false),
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const J = { "Content-Type": "application/json" };
  try {
    const items = [{ sku: "qa-10mg", name: "QA", qty: 1, amount: "50.00" }, { sku: "research-solvent-10ml", name: "Research solvent 10mL", qty: 1, amount: "0.00" }];
    const q = await fetch(`${base}/api/checkout/quote`, { method: "POST", headers: J, body: JSON.stringify({ idempotencyKey: "QA-HU-Q1", amount: "50.00", customer: cust("qa-test+gq@biolabsresearch.co"), items, notes: "QA", test: true }) }).then((r) => r.json());
    assert.equal(q.ok, true, JSON.stringify(q));
    const stored = store.listQuotes()[0];
    assert.deepEqual(stored.items.map((i) => i.sku), ["qa-10mg"], "gift never persisted");
    const c = await fetch(`${base}/api/checkout/crypto`, { method: "POST", headers: J, body: JSON.stringify({ idempotencyKey: "QA-HU-C1", amount: "50.00", network: "trc20", customer: cust("qa-test+gc@biolabsresearch.co"), items, test: true }) }).then((r) => r.json());
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.deepEqual(store.getOrderByRef(c.orderRef).items.map((i) => i.sku), ["qa-10mg"]);
    store.upsertOrder({ id: "BLR-9051", status: "approved", test: true, customer: cust("qa-test+hu5@biolabsresearch.co"), items: [], notes: "how do I inject" });
    const v = await fetch(`${base}/api/psp/compliance/human-use`, { headers: { Authorization: "Bearer staff" } }).then((r) => r.json());
    assert.equal(v.flags.length, 1);
    const ix = await fetch(`${base}/api/psp/compliance/human-use/index`, { headers: { Authorization: "Bearer staff" } }).then((r) => r.json());
    assert.ok(ix.orders["BLR-9051"]);
    assert.equal((await fetch(`${base}/api/psp/compliance/human-use`)).status, 401);
    const s1 = await fetch(`${base}/api/psp/compliance/human-use/clear`, { method: "POST", headers: { ...J, Authorization: "Bearer staff" }, body: JSON.stringify({ email: "qa-test+hu5@biolabsresearch.co", note: "x" }) });
    assert.equal(s1.status, 403);
    const s2 = await fetch(`${base}/api/psp/compliance/human-use/cancel-refuse`, { method: "POST", headers: { ...J, Authorization: "Bearer admin" }, body: JSON.stringify({ id: "BLR-9051", note: "QA" }) }).then((r) => r.json());
    assert.equal(s2.ok, true);
    const s3 = await fetch(`${base}/api/psp/compliance/human-use/clear`, { method: "POST", headers: { ...J, Authorization: "Bearer admin" }, body: JSON.stringify({ email: "qa-test+hu5@biolabsresearch.co", note: "QA false positive" }) }).then((r) => r.json());
    assert.equal(s3.ok, true);
    store.upsertOrder({ id: "BLR-9052", status: "approved", test: true, customer: cust("qa-test+hu6@biolabsresearch.co"), items: [], notes: "10 units for me" });
    const rv = (await fetch(`${base}/api/psp/compliance/human-use`, { headers: { Authorization: "Bearer staff" } }).then((r) => r.json())).reviews;
    assert.equal(rv.length, 1);
    assert.equal((await fetch(`${base}/api/psp/compliance/human-use/review/dismiss`, { method: "POST", headers: { ...J, Authorization: "Bearer staff" }, body: JSON.stringify({ id: rv[0].id, note: "x" }) })).status, 403);
    assert.equal((await fetch(`${base}/api/psp/compliance/human-use/review/escalate`, { method: "POST", headers: J, body: JSON.stringify({ id: rv[0].id, note: "x" }) })).status, 401);
    assert.equal((await fetch(`${base}/api/psp/compliance/human-use/review/escalate`, { method: "POST", headers: { ...J, Authorization: "Bearer admin" }, body: JSON.stringify({ id: rv[0].id }) })).status, 400);
    const es = await fetch(`${base}/api/psp/compliance/human-use/review/escalate`, { method: "POST", headers: { ...J, Authorization: "Bearer admin" }, body: JSON.stringify({ id: rv[0].id, note: "QA escalate" }) }).then((r) => r.json());
    assert.equal(es.ok, true); assert.deepEqual(es.held, ["BLR-9052"]);
  } finally { server.close(); setActiveHumanUse(null); }
});

// ---- 2026-10-01 two tiers + email lookback ------------------------------------------------------------------------------
test("tiers: new slang / Hebrew terms match with the right tier; IM is case-sensitive and standalone", () => {
  const c = compileTerms(JSON.parse(readFileSync(termsSource(), "utf8")));
  const hit = (s) => scanText(s, c).map((h) => `${h.termId}:${h.tier}`);
  for (const [txt, want] of [
    ["going sub-q", "subq:strong"], ["sub q please", "subq:strong"], ["my dose is 2mg", "my_dose:strong"], ["how much should I take?", "how_much_take:strong"],
    ["אני רוצה להזריק", "he_inject:strong"], ["כמה זמן ההזרקה", "he_inject:strong"], ["מה המינון", "he_dose:strong"], ["צריך מזרק", "he_inject:strong"],
    ["pinning Monday", "pin:weak"], ["10 units", "units_iu:weak"], ["5000 IU", "units_iu:weak"], ["I run it IM", "im:weak"], ["I'm cycling it", "cycle_self:weak"],
    ["is it ok for me", "for_me:weak"], ["אני לוקחת שתיים", "he_i_take:weak"],
  ]) assert.ok(hit(txt).includes(want), `${txt} -> ${want} (got ${hit(txt)})`);
  assert.equal(hit("im not sure, SIM card, Iman, IMG").some((h) => h.startsWith("im:")), false, "IM only uppercase standalone");
  assert.deepEqual(hit("Please ship to our lab, invoice to purchasing. COA for lot 12? Bicycle courier ok."), []);
  assert.deepEqual(classifyHits(scanText("pinning it subq", c)).tier, "strong");
  assert.ok(classifyHits(scanText("pinning it subq", c)).hits.some((h) => h.termId === "pin" && h.escalatedBy === "co_occurrence"));
  assert.equal(classifyHits(scanText("10 units for me", c)).tier, "weak");
});

test("weak only -> review item + alert, no flag, no hold; weak + strong -> flag + hold; escalate / dismiss need a note", () => {
  const { store, hu, src, dir } = setup();
  const w = "qa-test+weak@biolabsresearch.co", s = "qa-test+both@biolabsresearch.co";
  store.upsertOrder({ id: "BLR-9101", status: "approved", test: true, customer: cust(w), items: [], notes: "" });
  store.upsertOrder({ id: "BLR-9102", status: "approved", test: true, customer: cust(s), items: [], notes: "" });
  src.leads.push({ id: 71, email: w, notes: "how many units do you ship for me?" });
  src.leads.push({ id: 72, email: s, notes: "pinning it IM with a syringe" });
  const r = hu.scan({ backfill: true });
  assert.equal(r.tiers.weakOnlyItems, 1); assert.equal(r.tiers.strongItems, 1); assert.equal(r.tiers.reviewsOpened, 1);
  assert.ok(r.tiers.weakEscalatedByCooccurrence >= 2);
  assert.equal(hu.isFlagged(w), false, "weak alone never flags");
  assert.equal(store.getOrder("BLR-9101").complianceHold, undefined, "weak alone never holds");
  assert.equal(humanUseBlocks(store.getOrder("BLR-9101")), false);
  assert.equal(store.getOrder("BLR-9102").complianceHold.status, "COMPLIANCE_HOLD");
  const v = hu.view();
  assert.equal(v.reviews.length, 1); assert.equal(v.reviews[0].email, w); assert.equal(v.reviews[0].status, "open");
  assert.ok(v.alerts.some((a) => a.type === "human_use_review"));
  // weak note on a new order at creation: review only
  store.upsertOrder({ id: "BLR-9103", status: "approved", test: true, customer: cust("qa-test+weak2@biolabsresearch.co"), items: [], notes: "cycling for me" });
  assert.equal(store.getOrder("BLR-9103").complianceHold, undefined);
  assert.equal(hu.view().reviews.length, 2);
  // re-scan with same content: no duplicate
  assert.equal(hu.scan().tiers.reviewsOpened, 0);
  const id = hu.view().reviews.find((x) => x.email === w).id;
  assert.equal(hu.escalateReview(id, { actor: "admin@x", note: " " }).error, "note_required");
  const e = hu.escalateReview(id, { actor: "admin@x", note: "customer asked about units for self" });
  assert.equal(e.ok, true); assert.deepEqual(e.held, ["BLR-9101"]);
  assert.equal(hu.isFlagged(w), true);
  assert.equal(hu.escalateReview(id, { actor: "admin@x", note: "again" }).status, 409);
  const id2 = hu.view().reviews.find((x) => x.ref === "BLR-9103").id;
  assert.equal(hu.dismissReview(id2, { actor: "admin@x", note: "" }).error, "note_required");
  assert.equal(hu.dismissReview(id2, { actor: "admin@x", note: "bicycle courier question" }).ok, true);
  assert.equal(hu.isFlagged("qa-test+weak2@biolabsresearch.co"), false);
  const audit = readFileSync(join(dir, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const ev of ["review_opened", "review_escalated", "review_dismissed"]) assert.ok(audit.some((a) => a.event === ev), ev);
  assert.ok(audit.some((a) => a.event === "review_escalated" && a.note === "customer asked about units for self"));
});

test("email lookback: customer strong -> flag + hold by sender; weak -> review; partner / newsletter never flag; partner listed for Legal", () => {
  const d = mkdtempSync(join(tmpdir(), "mail-"));
  const p = join(d, "mail.json");
  const lb = { version: 1, readOnly: true, generatedAt: "2026-10-01T00:00:00Z", mailboxes: [{ mailbox: "info@biofirst.co", covered: true }, { mailbox: "support@biolabsresearch.co", covered: false, reason: "no connector" }],
    messages: [
      { mailbox: "info@biofirst.co", messageId: "m1", date: "2026-09-01T10:00:00Z", sender: "QA-Test+mail1@biolabsresearch.co", category: "customer", subject: "question", text: "can I inject it subq?" },
      { mailbox: "info@biofirst.co", messageId: "m2", date: "2026-09-02T10:00:00Z", sender: "qa-test+mail2@biolabsresearch.co", category: "customer", subject: "order", text: "how many units per vial?" },
      { mailbox: "info@biofirst.co", messageId: "m3", date: "2026-09-03T10:00:00Z", sender: "rep@partner.example", org: "Partner", category: "partner", subject: "pricing", text: "Semaglutide monthly injection, Vitamin D3 50,000 IU" },
      { mailbox: "info@biofirst.co", messageId: "m4", date: "2026-09-04T10:00:00Z", sender: "news@vendor.example", category: "newsletter", subject: "Injectables", text: "inject inject" },
    ] };
  writeFileSync(p, JSON.stringify(lb));
  const before = readFileSync(p, "utf8");
  const env = { HUMAN_USE_EMAIL_PATH: p, HUMAN_USE_CHAT_DIR: "/nonexistent", HUMAN_USE_LEADS_PATH: "/nonexistent", HUMAN_USE_MESSAGES_PATH: "/nonexistent", HUMAN_USE_SHOP_ORDERS_PATH: "/nonexistent" };
  const store = createStore({ memoryOnly: true });
  const t = termsFile();
  const hu = createHumanUse({ db: store, env, sources: defaultSources(env, null).filter((s) => s.id === "email"), termsPath: t.path, statePath: join(t.dir, "s.json"), auditPath: join(t.dir, "a.jsonl"), log: () => {} });
  store.upsertOrder({ id: "BLR-9201", status: "awaiting_crypto", test: true, customer: cust("qa-test+mail1@biolabsresearch.co"), items: [], notes: "" });
  const r = hu.scan({ backfill: true });
  assert.deepEqual(r.newlyFlagged, ["qa-test+mail1@biolabsresearch.co"]);
  assert.equal(r.tiers.reviewsOpened, 1);
  assert.equal(store.getOrder("BLR-9201").complianceHold.status, "COMPLIANCE_HOLD");
  const f = hu.state().flags["qa-test+mail1@biolabsresearch.co"];
  assert.equal(f.hits[0].source, "email"); assert.equal(f.hits[0].meta.messageId, "m1"); assert.equal(f.hits[0].meta.mailbox, "info@biofirst.co");
  const v = hu.view();
  assert.equal(v.reviews[0].meta.messageId, "m2");
  assert.equal(Object.keys(hu.state().flags).length, 1, "partner / newsletter senders never flagged");
  assert.equal(v.emailLookback.partnerHits.length, 1);
  assert.deepEqual(v.emailLookback.partnerHits[0].terms.sort(), ["inject", "units_iu"]);
  assert.equal(v.emailLookback.mailboxes[1].covered, false);
  assert.equal(readFileSync(p, "utf8"), before, "export untouched");
});

test("start(): a new terms version re-runs the backfill once; unchanged weak hits are not duplicated", () => {
  const { store, hu, src } = setup();
  src.leads.push({ id: 81, email: "qa-test+v@biolabsresearch.co", notes: "pinning" });
  const h1 = hu.start(1e9); clearInterval(h1);
  const v1 = hu.state().backfill.termsVersion;
  assert.equal(hu.view().reviews.length, 1);
  const h2 = hu.start(1e9); clearInterval(h2);
  assert.equal(hu.state().backfills.length, 1, "same version: no second backfill");
  assert.ok(v1);
  assert.equal(hu.view().reviews.length, 1);
  assert.equal(store.listOrders().length, 0);
});
