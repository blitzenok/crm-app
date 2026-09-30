// Round 6: the daily cap (agents' capDecision) never moves a buyer to UMG while a Cleffo link of theirs is still open
// (LINK_CREATED / LINK_UNKNOWN, any age inside the sweep window, abandoned or not, counted attempt or not).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { capDecision, resetCapMemo, routingConfig } from "../lib/routing.js";

const CAP = { cleffoEnabled: true, cleffoEnv: "sandbox", splitPct: 100, maxAttempts: 3, retryWindowMin: 120, cleffoOnly: false, linkTtlMin: 60, sweepHours: 72, dailyCapUsd: 2000, capPendingMin: 60, capTz: "Asia/Jerusalem" };
const NOW = Date.parse("2026-09-29T15:00:00.000Z");
const iso = (ms) => new Date(ms).toISOString();
const ROUTE = { processor: "cleffo", attempt: 1, reason: "bucket" };
beforeEach(() => resetCapMemo());

let seq = 0;
function seed(store, { email = "", session = "", status, at, amount = "50.00", abandoned = false, counts = true }) {
  seq += 1;
  const id = `BLR-8${String(seq).padStart(3, "0")}`;
  const open = status === "LINK_CREATED" || status === "LINK_UNKNOWN";
  store.upsertOrder({
    id, idempotencyKey: `cap-open-${seq}`, createdAt: at, updatedAt: at, status: status === "PAID" ? "approved" : open ? "awaiting_payment" : "declined", amount, currency: "USD",
    customer: { email }, items: [], session_id: session,
    attempts: [{ attemptId: `cleffo-${at}-${seq}`, processor: "cleffo", routingAttempt: 1, startedAt: at, amount, currency: "USD", processorStatus: status, ...(abandoned ? { abandoned: true } : {}), ...(status === "PAID" ? { finishedAt: at } : {}) }],
    routing: { attempts: [{ n: 1, processor: "cleffo", reason: "bucket", at, ...(counts ? {} : { countsAsAttempt: false }), ...(abandoned ? { outcome: "abandoned", retryClass: "hard" } : {}) }] },
  });
  return id;
}
// A day that is used up: $2,000 already paid today by someone else.
function fullDay(store) {
  seed(store, { email: "rich@other.test", status: "PAID", at: iso(NOW - 3600000), amount: "2000.00" });
}
const decide = (store, who, lines = []) => capDecision(ROUTE, { store, config: CAP, amount: "100.00", now: NOW, write: (s) => lines.push(s), ...who });

test("routingConfig: CLEFFO_CAP_PENDING_MIN defaults to the link lifetime (60), follows CLEFFO_LINK_TTL_MIN, explicit value wins", () => {
  assert.equal(routingConfig({}).capPendingMin, 60);
  assert.equal(routingConfig({ CLEFFO_LINK_TTL_MIN: "45" }).capPendingMin, 45);
  assert.equal(routingConfig({ CLEFFO_LINK_TTL_MIN: "45", CLEFFO_CAP_PENDING_MIN: "30" }).capPendingMin, 30);
  assert.equal(routingConfig({ CLEFFO_CAP_PENDING_MIN: "0" }).capPendingMin, 0);
});

test("day used up + an open Cleffo link of this buyer (older than the pending window, abandoned): stays cleffo, logged, buyer not marked capped", () => {
  const store = createStore({ memoryOnly: true });
  fullDay(store);
  const id = seed(store, { email: "buyer@x.test", status: "LINK_CREATED", at: iso(NOW - 5 * 3600000), abandoned: true });
  const lines = [];
  const d = decide(store, { email: "Buyer@X.test", sessionId: "s-new" }, lines);
  assert.equal(d.route.processor, "cleffo");
  assert.equal(d.capped, false);
  assert.match(lines.join(""), new RegExp(`\\[routing\\] cap: skipped open_cleffo_link ${id} `));
  assert.doesNotMatch(lines.join(""), /buyer@x\.test/i);
  // the same buyer, once the link is gone, is not "sticky-capped" by this decision
  const store2 = createStore({ memoryOnly: true });
  fullDay(store2);
  assert.equal(decide(store2, { email: "buyer@x.test", sessionId: "s-new" }).route.processor, "umg");
});

test("day used up + LINK_UNKNOWN (a timeout, not a counted attempt): stays cleffo", () => {
  const store = createStore({ memoryOnly: true });
  fullDay(store);
  seed(store, { email: "buyer@x.test", status: "LINK_UNKNOWN", at: iso(NOW - 20 * 60000), counts: false });
  const d = decide(store, { email: "buyer@x.test" });
  assert.equal(d.route.processor, "cleffo");
});

test("matched by e-mail OR by cart session; another buyer's open link does not help; PAID / DECLINED / EXPIRED are not open; older than the sweep window is not open", () => {
  const store = createStore({ memoryOnly: true });
  fullDay(store);
  seed(store, { email: "someone@else.test", session: "s-else", status: "LINK_CREATED", at: iso(NOW - 3600000) });
  seed(store, { email: "buyer@x.test", status: "DECLINED", at: iso(NOW - 3600000) });
  seed(store, { email: "buyer@x.test", status: "EXPIRED", at: iso(NOW - 3600000) });
  seed(store, { email: "buyer@x.test", status: "LINK_CREATED", at: iso(NOW - 80 * 3600000) }); // outside 72 h
  assert.equal(decide(store, { email: "buyer@x.test", sessionId: "s-mine" }).route.processor, "umg");
  seed(store, { email: "", session: "s-mine", status: "LINK_CREATED", at: iso(NOW - 2 * 3600000) });
  assert.equal(decide(store, { email: "buyer@x.test", sessionId: "s-mine" }).route.processor, "cleffo"); // by session only
  seed(store, { email: "buyer@x.test", status: "LINK_UNKNOWN", at: iso(NOW - 3600000) });
  assert.equal(decide(store, { email: "buyer@x.test", sessionId: "s-other" }).route.processor, "cleffo"); // by e-mail only
});

test("day not used up: nothing changes (the check only matters when the cap would apply)", () => {
  const store = createStore({ memoryOnly: true });
  seed(store, { email: "buyer@x.test", status: "LINK_CREATED", at: iso(NOW - 3600000) });
  const lines = [];
  assert.equal(decide(store, { email: "buyer@x.test" }, lines).route.processor, "cleffo");
  assert.equal(lines.length, 0);
});
