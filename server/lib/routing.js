/**
 * Card processor routing: UMG + Cleffo split by customer, retry on the other processor.
 *
 *  - CLEFFO_ENABLED !== "true"  -> UMG only, exactly the pre-Cleffo behaviour (no cap, no redirect).
 *  - First attempt: sticky bucket = sha256(normalised email) -> 0..9999; < CLEFFO_SPLIT_PCT*100 -> cleffo, else umg.
 *  - After a declined / failed / abandoned attempt by the same customer (same idempotency key, same cart session,
 *    or same email inside CLEFFO_RETRY_WINDOW_MIN), the next attempt goes to the OTHER processor.
 *  - At most CLEFFO_MAX_ATTEMPTS (default 3) attempts per checkout episode (an approval starts a new episode).
 */
import { createHash } from "node:crypto";

export const PROCESSORS = Object.freeze(["umg", "cleffo"]);

export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function flag(v) {
  const s = String(v ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes";
}

export function routingConfig(env = process.env) {
  let pct = Number(env.CLEFFO_SPLIT_PCT);
  if (env.CLEFFO_SPLIT_PCT == null || String(env.CLEFFO_SPLIT_PCT).trim() === "" || !Number.isFinite(pct)) pct = 50;
  pct = Math.min(100, Math.max(0, pct));
  let max = parseInt(env.CLEFFO_MAX_ATTEMPTS, 10);
  if (!Number.isFinite(max) || max < 1) max = 3;
  let windowMin = Number(env.CLEFFO_RETRY_WINDOW_MIN);
  if (!Number.isFinite(windowMin) || windowMin <= 0) windowMin = 120;
  return {
    cleffoEnabled: flag(env.CLEFFO_ENABLED),
    cleffoEnv: String(env.CLEFFO_ENV || "sandbox").trim().toLowerCase() === "live" ? "live" : "sandbox",
    splitPct: pct,
    maxAttempts: Math.min(max, 10),
    retryWindowMin: windowMin,
  };
}

/** 0..9999, deterministic per normalised email. */
export function bucketValue(email) {
  const h = createHash("sha256").update(normalizeEmail(email), "utf8").digest();
  return h.readUInt32BE(0) % 10000;
}

export function bucketFor(email, splitPct = 50) {
  if (!normalizeEmail(email)) return "umg";
  return bucketValue(email) < Math.round(Number(splitPct) * 100) ? "cleffo" : "umg";
}

export function otherProcessor(p) {
  return p === "cleffo" ? "umg" : "cleffo";
}

const SUCCESS = new Set(["approved", "paid"]);

/**
 * Routing attempts by this customer in the current episode, oldest first.
 * Each order may carry order.routing.attempts[] = { n, processor, outcome, at, ... }.
 */
export function customerAttempts(store, { email, sessionId, idempotencyKey, now = Date.now(), windowMin = 120 } = {}) {
  const em = normalizeEmail(email);
  const sid = String(sessionId || "").trim();
  const key = String(idempotencyKey || "").trim();
  const since = now - windowMin * 60 * 1000;
  const rows = [];
  for (const o of store.listOrders()) {
    const sameKey = key && o.idempotencyKey === key;
    const sameSession = sid && String(o.session_id || "") === sid;
    const sameEmail = em && normalizeEmail(o.customer?.email) === em;
    if (!sameKey && !sameSession && !sameEmail) continue;
    for (const a of o.routing?.attempts || []) {
      const t = Date.parse(a.at || "") || 0;
      if (!sameKey && !sameSession && t < since) continue;
      if (a.countsAsAttempt === false) continue;
      rows.push({ ...a, orderId: o.id, t });
    }
  }
  rows.sort((a, b) => a.t - b.t || (a.n || 0) - (b.n || 0));
  let lastWin = -1;
  rows.forEach((r, i) => { if (SUCCESS.has(String(r.outcome || ""))) lastWin = i; });
  return rows.slice(lastWin + 1);
}

/**
 * -> { processor, attempt, bucket, reason, blocked?, previous? }
 *    reason: cleffo_disabled | bucket | retry_switch_soft | retry_same_hard | retry_same_switch_used |
 *            retry_same_pending | attempts_exhausted | hard_decline_same_card
 * Rules: switch to the other processor ONLY after a soft decline and only once per episode; after a hard / unknown
 * decline stay on the same processor (and refuse the same card again on UMG); cap at maxAttempts.
 */
export function chooseProcessor({ email, history = [], config = routingConfig(), cardKey = "" }) {
  const bucket = bucketFor(email, config.splitPct);
  if (!config.cleffoEnabled) {
    return { processor: "umg", attempt: history.length + 1, bucket, reason: "cleffo_disabled" };
  }
  const n = history.length;
  if (n >= config.maxAttempts) {
    return { processor: null, attempt: n + 1, bucket, reason: "attempts_exhausted", blocked: true };
  }
  if (n === 0) return { processor: bucket, attempt: 1, bucket, reason: "bucket" };
  const last = history[n - 1];
  const previous = { processor: last.processor, outcome: last.outcome || null, retryClass: last.retryClass || null };
  const switches = history.filter((h) => h.reason === "retry_switch_soft").length;
  if (last.retryClass === "hard" && cardKey && history.some((h) => h.retryClass === "hard" && h.cardKey && h.cardKey === cardKey)) {
    return { processor: null, attempt: n + 1, bucket, reason: "hard_decline_same_card", blocked: true, previous };
  }
  if (last.retryClass === "soft" && switches === 0) {
    return { processor: otherProcessor(last.processor), attempt: n + 1, bucket, reason: "retry_switch_soft", previous };
  }
  const reason = last.retryClass === "soft" ? "retry_same_switch_used" : last.retryClass === "hard" ? "retry_same_hard" : "retry_same_pending";
  return { processor: last.processor, attempt: n + 1, bucket, reason, previous };
}

/** Append a routing attempt to an order object (mutates + returns it). */
export function recordRoutingAttempt(order, entry) {
  const routing = order.routing || { attempts: [] };
  routing.attempts = [...(routing.attempts || []), { at: new Date().toISOString(), ...entry }];
  routing.bucket = entry.bucket ?? routing.bucket ?? null;
  routing.splitPct = entry.splitPct ?? routing.splitPct ?? null;
  routing.firstProcessor = routing.firstProcessor || entry.processor;
  order.routing = routing;
  order.paymentProcessor = entry.processor;
  order.attemptNumber = entry.n;
  return order;
}

/** Update the last routing attempt on an order with its outcome. */
export function setLastOutcome(order, outcome, extra = {}) {
  const list = order.routing?.attempts || [];
  if (!list.length) return order;
  list[list.length - 1] = { ...list[list.length - 1], outcome, settledAt: new Date().toISOString(), ...extra };
  return order;
}

export function logRouting(order, entry, write = (s) => process.stdout.write(s)) {
  write(`[routing] ${order.id} attempt=${entry.n} processor=${entry.processor} reason=${entry.reason} outcome=${entry.outcome || "started"}\n`);
}

/** Non-reversible key for "same card again" checks (last4 + expiry only; never the PAN). */
export function cardKeyOf(card) {
  const d = String(card?.number || "").replace(/\D/g, "");
  if (d.length < 12) return "";
  const m = String(card?.month || "").replace(/\D/g, "").replace(/^0+/, "");
  const y = String(card?.year || "").replace(/\D/g, "").slice(-2);
  return createHash("sha256").update(`card|${d.slice(-4)}|${m}|${y}|${d.slice(0, 6)}`).digest("hex").slice(0, 16);
}

/** Synthetic split check: share of emails landing in the cleffo bucket. */
export function splitStats(emails, splitPct = 50) {
  let cleffo = 0;
  for (const e of emails) if (bucketFor(e, splitPct) === "cleffo") cleffo += 1;
  return { total: emails.length, cleffo, umg: emails.length - cleffo, cleffoPct: emails.length ? (100 * cleffo) / emails.length : 0 };
}
