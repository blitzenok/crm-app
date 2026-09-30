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

function capUsd(v) {
  const n = Number(String(v ?? "").trim());
  return String(v ?? "").trim() !== "" && Number.isFinite(n) && n > 0 ? n : 0;
}

// Default = the link lifetime (CLEFFO_LINK_TTL_MIN): a link stays payable that long, so it must count that long.
function capPendingMinutes(v, dflt = 30) {
  const n = Number(String(v ?? "").trim());
  return String(v ?? "").trim() !== "" && Number.isFinite(n) && n >= 0 ? n : dflt;
}

function capTimeZone(v) {
  const tz = String(v || "").trim() || "Asia/Jerusalem";
  try { new Intl.DateTimeFormat("en-CA", { timeZone: tz }); return tz; } catch { return "Asia/Jerusalem"; }
}

export function routingConfig(env = process.env) {
  let pct = Number(env.CLEFFO_SPLIT_PCT);
  if (env.CLEFFO_SPLIT_PCT == null || String(env.CLEFFO_SPLIT_PCT).trim() === "" || !Number.isFinite(pct)) pct = 50;
  pct = Math.min(100, Math.max(0, pct));
  let max = parseInt(env.CLEFFO_MAX_ATTEMPTS, 10);
  if (!Number.isFinite(max) || max < 1) max = 3;
  let windowMin = Number(env.CLEFFO_RETRY_WINDOW_MIN);
  if (!Number.isFinite(windowMin) || windowMin <= 0) windowMin = 120;
  // infra 2026-09-29 cleffo part 4: link lifetime for reuse (one live link per order) and how far back the sweep looks.
  let ttl = Number(env.CLEFFO_LINK_TTL_MIN);
  if (!Number.isFinite(ttl) || ttl <= 0) ttl = 60;
  let sweepHours = Number(env.CLEFFO_SWEEP_HOURS);
  if (!Number.isFinite(sweepHours) || sweepHours <= 0) sweepHours = 72;
  return {
    cleffoEnabled: flag(env.CLEFFO_ENABLED),
    // Cleffo only: every attempt goes to Cleffo, the card never reaches UMG (default off = split / fallback as before).
    cleffoOnly: flag(env.CLEFFO_ONLY),
    // Daily Cleffo cap (USD, Asia/Jerusalem calendar day). 0 / empty / invalid = no cap. See capDecision() below.
    dailyCapUsd: capUsd(env.CLEFFO_DAILY_CAP_USD),
    capPendingMin: capPendingMinutes(env.CLEFFO_CAP_PENDING_MIN, ttl),
    capTz: capTimeZone(env.CLEFFO_CAP_TZ),
    linkTtlMin: ttl,
    sweepHours,
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
function customerRows(store, { email, sessionId, idempotencyKey, now = Date.now(), windowMin = 120 } = {}, { uncounted = false } = {}) {
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
      if (a.countsAsAttempt === false && !uncounted) continue;
      rows.push({ ...a, orderId: o.id, t });
    }
  }
  rows.sort((a, b) => a.t - b.t || (a.n || 0) - (b.n || 0));
  return rows;
}

export function customerAttempts(store, q = {}) {
  const rows = customerRows(store, q);
  let lastWin = -1;
  rows.forEach((r, i) => { if (SUCCESS.has(String(r.outcome || ""))) lastWin = i; });
  return rows.slice(lastWin + 1);
}

/**
 * The customer's latest routing attempt (counted or not) is a Cleffo link that could not be created: nothing was charged
 * and Cleffo is down for them right now. Lets the next /route send the buyer to the UMG card form (Cleffo primary, UMG spare).
 */
export function cleffoLinkFailedLast(store, q = {}) {
  const rows = customerRows(store, q, { uncounted: true });
  const last = rows[rows.length - 1];
  return Boolean(last && last.processor === "cleffo" && last.outcome === "link_error");
}

/**
 * -> { processor, attempt, bucket, reason, blocked?, previous? }
 *    reason: cleffo_disabled | bucket | retry_switch_soft | retry_same_hard | retry_same_switch_used |
 *            retry_same_pending | retry_switch_link_error | cleffo_only | attempts_exhausted | hard_decline_same_card
 * Rules: switch to the other processor ONLY after a soft decline and only once per episode; after a hard / unknown
 * decline stay on the same processor (and refuse the same card again on UMG); cap at maxAttempts.
 */
export function chooseProcessor({ email, history = [], config = routingConfig(), cardKey = "", linkFailed = false }) {
  const bucket = bucketFor(email, config.splitPct);
  if (!config.cleffoEnabled) {
    return { processor: "umg", attempt: history.length + 1, bucket, reason: "cleffo_disabled" };
  }
  const n = history.length;
  if (n >= config.maxAttempts) {
    return { processor: null, attempt: n + 1, bucket, reason: "attempts_exhausted", blocked: true };
  }
  if (config.cleffoOnly) {
    // No email, UMG history or split share moves anyone to UMG; the cap above still applies.
    const prev = history[n - 1];
    return { processor: "cleffo", attempt: n + 1, bucket, reason: "cleffo_only", ...(prev ? { previous: { processor: prev.processor, outcome: prev.outcome || null, retryClass: prev.retryClass || null } } : {}) };
  }
  // Cleffo could not make a link for this buyer a moment ago and no payment of theirs was ever refused as "hard": the spare
  // processor takes the next attempt. (A hard Cleffo decline / abandoned link never moves the card to UMG.)
  if (linkFailed && !history.some((h) => h.retryClass === "hard")) {
    return { processor: "umg", attempt: n + 1, bucket, reason: "retry_switch_link_error" };
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

/* ------------------------------------------------------------------------------------------------------------------
 * Daily Cleffo cap (CLEFFO_DAILY_CAP_USD, e.g. 2000). docs/CLEFFO_DAILY_CAP.md.
 *
 *  used today = sum of Cleffo attempts with processorStatus PAID whose paid time (finishedAt) falls on the current
 *               calendar day in CLEFFO_CAP_TZ (default Asia/Jerusalem)
 *             + open Cleffo links (LINK_CREATED / LINK_UNKNOWN, no outcome yet) created in the last CLEFFO_CAP_PENDING_MIN
 *               minutes (default = CLEFFO_LINK_TTL_MIN, 60), so a burst of checkouts cannot overshoot the cap while the buyers are still paying.
 *               The buyer's own order (same idempotency key) is not counted twice.
 *  If used + this order's total > cap (or used >= cap), the attempt that would open a NEW Cleffo payment (first attempt "bucket", or the
 *  one-time soft-decline switch "retry_switch_soft") goes to UMG instead, reason "cap". Retries of an existing Cleffo
 *  payment (hard / pending) are not moved (a Cleffo link that may still be paid must never be paid again on UMG).
 *  A capped buyer stays on UMG for CLEFFO_CAP_PENDING_MIN minutes (min 30), so /route and /charge agree even though
 *  /route does not know the cart total.
 *  Never to UMG while a Cleffo link of this buyer (e-mail or cart session, CLEFFO_SWEEP_HOURS back, counted attempt or not)
 *  is still open (LINK_CREATED / LINK_UNKNOWN): that payment may still arrive, a UMG charge on top would be a double payment.
 * ---------------------------------------------------------------------------------------------------------------- */
const CAP_ROUTE_REASONS = new Set(["bucket", "retry_switch_soft"]);
const capMemo = new Map(); // "e:<email>" | "s:<session>" -> expiry ms

export function resetCapMemo() {
  capMemo.clear();
}

function cents(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
}

/** Calendar day (YYYY-MM-DD) of ms in tz. */
export function capDayKey(ms, tz = "Asia/Jerusalem") {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** -> { day, paidUsd, pendingUsd, usedUsd, paidCount, pendingCount } (numbers in USD, 2 dp). */
export function cleffoDailyUsage(store, { now = Date.now(), tz = "Asia/Jerusalem", pendingMin = 30, excludeKey = "" } = {}) {
  const day = capDayKey(now, tz);
  const since = now - pendingMin * 60 * 1000;
  let paid = 0;
  let pending = 0;
  let paidCount = 0;
  let pendingCount = 0;
  for (const o of store.listOrders()) {
    const list = (o.attempts || []).filter((a) => a && a.processor === "cleffo");
    if (!list.length) continue;
    const settled = new Set((o.routing?.attempts || []).filter((r) => r.processor === "cleffo" && r.outcome).map((r) => r.n));
    for (const a of list) {
      const amount = cents(a.paidAmount ?? a.amount ?? o.amount);
      if (a.processorStatus === "PAID") {
        const t = Date.parse(a.finishedAt || a.polledAt || a.date || a.startedAt || "") || 0;
        if (t && capDayKey(t, tz) === day) { paid += amount; paidCount += 1; }
        continue;
      }
      if (a.processorStatus !== "LINK_CREATED" && a.processorStatus !== "LINK_UNKNOWN") continue;
      if (a.abandoned || settled.has(a.routingAttempt)) continue;
      if (excludeKey && o.idempotencyKey === excludeKey) continue;
      const t = Date.parse(a.startedAt || "") || 0;
      if (t >= since && t <= now + 60000) { pending += amount; pendingCount += 1; }
    }
  }
  return { day, paidUsd: paid / 100, pendingUsd: pending / 100, usedUsd: (paid + pending) / 100, paidCount, pendingCount };
}

/** An open Cleffo link (LINK_CREATED / LINK_UNKNOWN, abandoned or not) of this buyer inside the sweep window -> { orderId, attempt } | null. */
function openCleffoLinkOf(store, { email, sessionId, now, hours }) {
  const em = normalizeEmail(email);
  const sid = String(sessionId || "").trim();
  if (!em && !sid) return null;
  const since = now - hours * 3600 * 1000;
  for (const o of store.listOrders()) {
    const mine = (em && normalizeEmail(o.customer?.email) === em) || (sid && String(o.session_id || "") === sid);
    if (!mine) continue;
    for (const a of o.attempts || []) {
      if (a?.processor !== "cleffo" || (a.processorStatus !== "LINK_CREATED" && a.processorStatus !== "LINK_UNKNOWN")) continue;
      if ((Date.parse(a.startedAt || "") || 0) < since) continue;
      return { orderId: o.id, attempt: a.routingAttempt, status: a.processorStatus };
    }
  }
  return null;
}

function memoKeys(email, sessionId) {
  const out = [];
  const em = normalizeEmail(email);
  if (em) out.push(`e:${em}`);
  const sid = String(sessionId || "").trim();
  if (sid) out.push(`s:${sid}`);
  return out;
}

/**
 * Apply the daily cap to a routing decision. Pure except for the capped-buyer memo (remember=false skips writing it).
 * -> { route, capped, usage? , sticky? }
 */
export function capDecision(route, { store, config, amount = 0, email = "", sessionId = "", idempotencyKey = "", now = Date.now(), remember = true, write = (s) => process.stdout.write(s) } = {}) {
  const capUsdV = Number(config?.dailyCapUsd) || 0;
  if (!route || route.processor !== "cleffo" || !config?.cleffoEnabled || config.cleffoOnly || capUsdV <= 0) return { route, capped: false };
  if (!CAP_ROUTE_REASONS.has(route.reason)) return { route, capped: false };
  const keys = memoKeys(email, sessionId);
  for (const [k, exp] of capMemo) if (exp <= now) capMemo.delete(k);
  const sticky = keys.some((k) => (capMemo.get(k) || 0) > now);
  const usage = cleffoDailyUsage(store, { now, tz: config.capTz || "Asia/Jerusalem", pendingMin: config.capPendingMin ?? 30, excludeKey: idempotencyKey });
  const orderCents = cents(amount);
  const usedCents = Math.round(usage.usedUsd * 100);
  const capCents = Math.round(capUsdV * 100);
  // Over when this order would take the day past the cap, or nothing is left at all (/route knows no total).
  const over = usedCents + orderCents > capCents || usedCents >= capCents;
  if (!over && !sticky) return { route, capped: false, usage };
  const open = openCleffoLinkOf(store, { email, sessionId, now, hours: Number(config.sweepHours) > 0 ? Number(config.sweepHours) : 72 });
  if (open) {
    write(`[routing] cap: skipped open_cleffo_link ${open.orderId} attempt=${open.attempt} status=${open.status} day=${usage.day} paid=${usage.paidUsd.toFixed(2)} was=${route.reason} -> stays cleffo\n`);
    return { route, capped: false, usage, openLink: open };
  }
  if (remember) {
    const exp = now + Math.max(30, Number(config.capPendingMin) || 0) * 60 * 1000;
    for (const k of keys) capMemo.set(k, exp);
  }
  write(`[routing] cap: cleffo day=${usage.day} paid=${usage.paidUsd.toFixed(2)} pending=${usage.pendingUsd.toFixed(2)} order=${(orderCents / 100).toFixed(2)} cap=${capUsdV.toFixed(2)}${sticky && !over ? " sticky" : ""} was=${route.reason} -> umg reason=cap\n`);
  return { route: { ...route, processor: "umg", reason: "cap", cappedFrom: route.reason }, capped: true, usage, sticky: sticky && !over };
}
