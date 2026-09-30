/**
 * Cleffo checkout glue: routing decision, consent gate, payment-link attempt, server-side confirmation, sweep,
 * staff settings view. See docs/CLEFFO.md. Off unless CLEFFO_ENABLED=true.
 */
import { formatAmount } from "./card.js";
import { orderAttribution } from "./order-attribution.js"; // infra 2026-09-30 order-attribution
import { logSafe, stripSecrets } from "./sanitize.js";
import * as cleffo from "./cleffo.js";
import { classifyForRetry } from "./retry-class.js";
import { sanitizeConsent } from "./consent.js";
import { CARD_STATEMENT_DESCRIPTOR } from "./store-forward.js";
import { itemsKey } from "./store.js";
import {
  bucketFor,
  cardKeyOf,
  chooseProcessor,
  cleffoLinkFailedLast,
  customerAttempts,
  logRouting,
  recordRoutingAttempt,
  routingConfig,
  capDecision,
  cleffoDailyUsage,
  setLastOutcome,
} from "./routing.js";

export const AWAITING = "awaiting_payment";
const DEFAULT_RETURN_PAGE = "https://biolabsresearch.co/checkout";
// Storefront origins the buyer may come from (main shop and its mirror): they get sent back to the SAME origin.
const RETURN_ORIGINS = new Set(["https://biolabsresearch.co", "https://www.biolabsresearch.co", "https://blrcommerce.io", "https://www.blrcommerce.io"]);

/** Where the buyer lands after paying: <origin>/checkout for a whitelisted Origin header, else CLEFFO_STOREFRONT_RETURN_URL. */
export function returnPageFor(origin, env = process.env) {
  const o = String(origin || "").trim();
  return RETURN_ORIGINS.has(o) ? `${o}/checkout` : (env.CLEFFO_STOREFRONT_RETURN_URL || DEFAULT_RETURN_PAGE);
}

function nowIso() {
  return new Date().toISOString();
}

// One line per call; request-derived text cannot start a second line or fake an alert tag.
function log(line) {
  process.stdout.write(`${logSafe(line, 400)}\n`);
}

/** Text from a Cleffo answer for the log: control characters out, e-mail addresses masked (x***@domain). */
function logText(v) {
  return logSafe(String(v ?? "").replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***@$2"), 200);
}

/** "[pay-alert] KIND part part ..." for ops-watch -> Telegram. Never card data or emails: only ids, numbers, amounts. */
function alert(kind, ...parts) {
  process.stdout.write(`[pay-alert] ${kind}${parts.length ? ` ${parts.map((x) => logSafe(x, 80)).join(" ")}` : ""}\n`);
}

// CLEFFO_LINK_ERROR is the only alert that can repeat at the pace of visitors: at most one line per 10 minutes.
const LINK_ERROR_ALERT_EVERY_MS = 10 * 60 * 1000;
let lastLinkErrorAlertAt = 0;
export function resetCleffoAlertState() {
  lastLinkErrorAlertAt = 0;
  lastStuckSummaryAt = 0;
  lastSweepPoll.clear();
}

// Requests for the same order key run one after another through the "route + create the link" step, so a double click
// cannot make two attempts with the same number. Returns release(); safe to call more than once.
const keyLocks = new Map();
export async function acquireKeyLock(key) {
  if (!key) return () => {};
  const prev = keyLocks.get(key) || Promise.resolve();
  let open;
  const mine = new Promise((r) => { open = r; });
  const tail = prev.then(() => mine);
  keyLocks.set(key, tail);
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    open();
    if (keyLocks.get(key) === tail) keyLocks.delete(key);
  };
}

const SETTLED = { PAID: "paid", DECLINED: "declined", REVIEW: "review", EXPIRED: "declined" };
const numOr = (v, d) => (Number(v) > 0 ? Number(v) : d);

/** Card-statement descriptor per processor. CLEFFO_DESCRIPTOR stays "UNKNOWN" until Cleffo confirms it in writing. */
export function descriptorFor(processor, env = process.env) {
  const raw = processor === "cleffo"
    ? String(env.CLEFFO_DESCRIPTOR || "UNKNOWN").trim()
    : String(env.UMG_DESCRIPTOR || CARD_STATEMENT_DESCRIPTOR).trim();
  const confirmed = Boolean(raw) && raw.toUpperCase() !== "UNKNOWN";
  return { processor, statementDescriptor: confirmed ? raw : null, statementDescriptorConfirmed: confirmed, configured: raw || "UNKNOWN" };
}

/**
 * Consent gate for Cleffo (legal rule): the redirect URL is only handed out after the consent record has been
 * appended AND read back with a valid hash. Requirements on the browser field: present, well-formed, at least one
 * check, every check true, acceptedAt set, plus any ids in CLEFFO_REQUIRED_CONSENT_CHECKS.
 */
export function validateConsentForCleffo(body, env = process.env) {
  const s = sanitizeConsent(body?.consent);
  if (s.missing || !s.consent) return { ok: false, error: s.invalid ? "consent_invalid" : "consent_missing" };
  const checks = s.consent.checks || {};
  const ids = Object.keys(checks);
  if (!ids.length) return { ok: false, error: "consent_invalid", detail: "no_checks" };
  if (!ids.every((k) => checks[k] === true)) return { ok: false, error: "consent_invalid", detail: "unchecked" };
  if (!s.consent.acceptedAt) return { ok: false, error: "consent_invalid", detail: "accepted_at" };
  const required = String(env.CLEFFO_REQUIRED_CONSENT_CHECKS || "").split(",").map((x) => x.trim()).filter(Boolean);
  const missing = required.filter((k) => checks[k] !== true);
  if (missing.length) return { ok: false, error: "consent_invalid", detail: `required:${missing.join("|")}` };
  return { ok: true, consent: s.consent };
}

export function confirmConsentRecorded(consentLog, orderId, hash) {
  if (!consentLog || !orderId || !hash) return false;
  try {
    return consentLog.find({ ref: orderId }).some((r) => r.hash === hash && r.hashOk === true && r.missing === false);
  } catch {
    return false;
  }
}

function findCleffoAttempt(order, attemptNo) {
  const list = (order?.attempts || []).filter((a) => a.processor === "cleffo");
  if (attemptNo != null && attemptNo !== "") return list.find((a) => String(a.routingAttempt) === String(attemptNo)) || null;
  return list[list.length - 1] || null;
}

/**
 * Settle a Cleffo attempt from the status API (never from the redirect alone). Idempotent: a settled attempt is
 * returned as-is. Amount / currency are checked against the attempt itself (what the link was created for), currency is
 * always USD. A payment that arrives when the order is already paid (or another link of it was) never touches the
 * order: it is recorded on the attempt and raised as CLEFFO_DOUBLE_PAID (refund by hand).
 * -> { ok, status: paid|declined|pending|review|unknown, order, reused, attempt }
 */
export async function confirmCleffoAttempt(db, orderId, attemptNo, deps = {}) {
  const order = db.getOrder(orderId) || db.getOrderByRef(orderId);
  if (!order) return { ok: false, status: "unknown", error: "not_found" };
  const att = findCleffoAttempt(order, attemptNo);
  if (!att) return { ok: false, status: "unknown", error: "attempt_not_found", order };
  // recheckDeclined (sweep only): a "failed" link is asked about again while the link lives; a later payment is booked.
  const recheck = deps.recheckDeclined === true && att.processorStatus === "DECLINED";
  const settled = recheck ? null : SETTLED[att.processorStatus];
  if (settled) return { ok: true, status: settled, reused: true, order, attempt: att };
  if (!att.processorTxnId) return { ok: false, status: "unknown", error: "no_link", order, attempt: att };

  const st = await cleffo.getPaymentStatus(att.processorTxnId, deps.cleffoDeps || {});
  if (!st.ok) return { ok: false, status: "pending", error: "status_unavailable", order, attempt: att };

  // Re-read: another request may have settled it while we waited.
  const fresh = db.getOrder(order.id);
  const idx = fresh.attempts.findIndex((a) => a.attemptId === att.attemptId);
  const cur = fresh.attempts[idx];
  const already = SETTLED[cur.processorStatus];
  if (already && !(recheck && cur.processorStatus === "DECLINED")) return { ok: true, status: already, reused: true, order: fresh, attempt: cur };
  if (recheck && st.status !== "PAID") return { ok: true, status: "declined", order: fresh, attempt: cur };

  const base = { ...cur, polledAt: nowIso(), cleffoStatus: st.paymentStatus, gatewayIntentId: st.gatewayIntentId || cur.gatewayIntentId || null, date: st.dateTime || cur.date || null };
  let status = "pending";
  const after = []; // alerts, written only after the order is saved
  if (st.status === "PAID") {
    const wantAmount = cur.amount ?? fresh.amount;
    const amountOk = formatAmount(st.totalAmount) === formatAmount(wantAmount);
    const currencyOk = String(st.currency || "").toUpperCase() === "USD";
    const refOk = !st.merchantOrderId || st.merchantOrderId === cur.merchantOrderId;
    const matched = amountOk && currencyOk && refOk;
    // A link paid for a different amount than the order holds now (re-priced after the link was made): staff decide.
    const orderAmountOk = cur.amount == null || formatAmount(cur.amount) === formatAmount(fresh.amount);
    const otherMoneyIn = fresh.attempts.some((a, i) => i !== idx && a.processor === "cleffo" && (a.processorStatus === "PAID" || a.processorStatus === "REVIEW"));
    const alreadyPaid = String(fresh.status).toLowerCase() === "approved" || otherMoneyIn;
    const wasAbandoned = recheck || Boolean(cur.abandoned) || (fresh.routing?.attempts || []).some((x) => x.n === cur.routingAttempt && x.processor === "cleffo" && x.outcome === "abandoned");
    if (alreadyPaid) {
      status = matched ? "paid" : "review";
      fresh.attempts[idx] = { ...base, processorStatus: matched ? "PAID" : "REVIEW", cascadeAction: "stop", reason: "cleffo_double_paid", doublePaid: true, paidAmount: st.totalAmount, finishedAt: nowIso() };
      setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "double_paid", retryClass: "none", countsAsAttempt: false });
      after.push(() => alert("CLEFFO_DOUBLE_PAID", fresh.id, cur.routingAttempt, formatAmount(st.totalAmount)));
    } else if (matched && orderAmountOk) {
      status = "paid";
      fresh.attempts[idx] = { ...base, processorStatus: "PAID", cascadeAction: "success", declineClass: null, reason: "approved", finishedAt: nowIso() };
      fresh.status = "approved";
      fresh.winningProcessor = "cleffo";
      fresh.winningTxnId = cur.processorTxnId;
      const d = descriptorFor("cleffo");
      fresh.descriptor = d.statementDescriptor;
      fresh.lastStatus = "PAID";
      setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "paid", retryClass: "none", retryBasis: null, retryCode: null });
      if (wasAbandoned) after.push(() => alert("CLEFFO_LATE_PAID", fresh.id, cur.routingAttempt, formatAmount(st.totalAmount)));
      // The same buyer already has a paid order for this very cart and amount (a UMG spare after a lost Cleffo link, or a second
      // checkout): the money is in, so the order stays approved, but staff decide about a refund.
      const twin = sameBuyerPaidOrder(db, fresh, deps);
      if (twin) after.push(() => alert("CLEFFO_SAME_BUYER_PAID", fresh.id, `other=${twin.id}`));
    } else {
      status = "review";
      fresh.attempts[idx] = { ...base, processorStatus: "REVIEW", reason: matched ? "cleffo_paid_order_amount_differs" : "cleffo_paid_mismatch", mismatch: { amount: st.totalAmount, currency: st.currency, merchantOrderId: st.merchantOrderId, orderAmount: fresh.amount } };
      fresh.status = "review";
      fresh.lastStatus = "REVIEW";
      setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "review", retryClass: "hard", retryBasis: "paid_mismatch" });
      after.push(() => alert("CLEFFO_REVIEW", fresh.id, cur.routingAttempt, `amount=${st.totalAmount} want=${formatAmount(wantAmount)} order=${formatAmount(fresh.amount)}`, `currency=${st.currency}`, `ref_ok=${refOk}`));
    }
  } else if (st.status === "EXPIRED") {
    // The link died without a payment: nothing was charged, so it is neither a decline nor an attempt used up.
    status = "declined";
    fresh.attempts[idx] = { ...base, processorStatus: "EXPIRED", cascadeAction: "next", declineClass: null, reason: "cleffo_link_expired", finishedAt: nowIso() };
    if (!["approved", "review"].includes(String(fresh.status).toLowerCase())) fresh.status = "declined";
    setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "expired", retryClass: "none", retryBasis: "link_expired", countsAsAttempt: false });
  } else if (st.status === "DECLINED") {
    status = "declined";
    const cls = classifyForRetry({ processor: "cleffo", processorStatus: "DECLINED", informationData: st.message || "" });
    fresh.attempts[idx] = { ...base, processorStatus: "DECLINED", cascadeAction: "stop", declineClass: cls.retryClass, reason: `cleffo_failed:${cls.basis}`, finishedAt: nowIso() };
    if (!["approved", "review"].includes(String(fresh.status).toLowerCase())) fresh.status = "declined";
    fresh.lastStatus = "DECLINED";
    setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "declined", retryClass: cls.retryClass, retryBasis: cls.basis, retryCode: cls.code });
  } else {
    // Still pending: nothing to save (the sweep asks every minute; rewriting store.json each time buys nothing), except
    // the first time the buyer comes back from the Cleffo page (return / status): "came back and still pending" is what
    // separates a real stuck payment from a link nobody opened.
    if ((deps.via === "return" || deps.via === "status") && !cur.returnedAt) {
      fresh.attempts[idx] = { ...cur, returnedAt: nowIso() };
      db.upsertOrder(fresh);
      return { ok: true, status: "pending", order: db.getOrder(fresh.id), attempt: fresh.attempts[idx] };
    }
    return { ok: true, status: "pending", order: fresh, attempt: cur };
  }
  fresh.updatedAt = nowIso();
  db.upsertOrder(fresh);
  if (status !== "pending") {
    const r = (fresh.routing?.attempts || []).find((x) => x.n === cur.routingAttempt) || {};
    log(`[routing] ${fresh.id} attempt=${cur.routingAttempt} processor=cleffo outcome=${status} retryClass=${r.retryClass || "-"} basis=${r.retryBasis || "-"} via=${deps.via || "confirm"}`);
  }
  for (const f of after) f();
  if (status === "paid" && !fresh.attempts[idx].doublePaid && typeof deps.onPaid === "function") {
    try { deps.onPaid(fresh); } catch { /* never fail the confirmation */ }
  }
  return { ok: true, status, order: db.getOrder(fresh.id), attempt: fresh.attempts[idx] };
}

function sameBuyerPaidOrder(db, order, deps = {}) {
  const em = String(order.customer?.email || "").trim().toLowerCase();
  if (!em) return null;
  // A twin is a second checkout of the same cart made within one link lifetime (either side) of this order; a reorder days later is normal.
  const ttlMs = numOr(deps.linkTtlMin, numOr(process.env.CLEFFO_LINK_TTL_MIN, 60)) * 60000;
  const born = Date.parse(order.createdAt) || 0;
  const want = itemsKey(order.items);
  const amount = formatAmount(order.amount);
  return db.listOrders().find((o) => o.id !== order.id
    && String(o.status || "").toLowerCase() === "approved"
    && String(o.customer?.email || "").trim().toLowerCase() === em
    && Math.abs((Date.parse(o.createdAt) || 0) - born) <= ttlMs
    && itemsKey(o.items) === want && formatAmount(o.amount) === amount) || null;
}

function setLastOutcomeFor(order, n, patch) {
  const list = order.routing?.attempts || [];
  const i = list.findIndex((r) => r.n === n && r.processor === "cleffo");
  if (i !== -1) list[i] = { ...list[i], ...patch, settledAt: nowIso() };
}

/**
 * Before routing a new attempt: settle this customer's open Cleffo links from the status API. A link that is still
 * pending stays THE link of its order for CLEFFO_LINK_TTL_MIN (reusable: same key gets the same URL); older than that it
 * becomes "abandoned" (outcome unknown -> hard, fail closed: no switch) but stays open at Cleffo, so the sweep keeps
 * watching it and a late payment is still booked.
 */
export async function refreshOpenCleffoLinks(db, history, deps = {}, config = {}, key = "") {
  const ttlMin = numOr(config.linkTtlMin, numOr(process.env.CLEFFO_LINK_TTL_MIN, 60));
  let reusable = null;
  for (const h of history) {
    if (h.processor !== "cleffo" || h.outcome) continue;
    const res = await confirmCleffoAttempt(db, h.orderId, h.n, { ...deps, via: "pre-route" });
    if (res.status !== "pending") continue;
    const ageMin = (Date.now() - (Date.parse(h.at) || 0)) / 60000;
    const o = db.getOrder(h.orderId);
    if (!o) continue;
    if (ageMin <= ttlMin) {
      if (key && o.idempotencyKey === key) reusable = { orderId: h.orderId, n: h.n };
      continue;
    }
    setLastOutcomeFor(o, h.n, { outcome: "abandoned", retryClass: "hard", retryBasis: "abandoned_unknown_fail_closed" });
    const ai = (o.attempts || []).findIndex((x) => x.processor === "cleffo" && x.routingAttempt === h.n);
    if (ai !== -1) o.attempts[ai] = { ...o.attempts[ai], abandoned: true, abandonedAt: nowIso() };
    db.upsertOrder(o);
    log(`[routing] ${o.id} attempt=${h.n} processor=cleffo outcome=abandoned retryClass=hard basis=abandoned_unknown_fail_closed`);
  }
  return { reusable };
}

/** Decide the processor for this charge request. Side effects only when Cleffo is on (history refresh). */
export async function routeCharge(db, body, deps = {}) {
  const config = deps.config || routingConfig();
  const email = body?.customer?.email || "";
  const key = String(body?.idempotencyKey || body?.extOrderId || "").trim();
  const sessionId = String(body?.session_id || body?.sessionId || "").trim();
  const q = { email, sessionId, idempotencyKey: key, windowMin: config.retryWindowMin };
  // Flag off: history is only used to number the attempt (UMG-only behaviour, no cap, no switch).
  let history = customerAttempts(db, q);
  let reusable = null;
  if (config.cleffoEnabled && history.some((h) => h.processor === "cleffo" && !h.outcome)) {
    ({ reusable } = await refreshOpenCleffoLinks(db, history, deps, config, key));
    history = customerAttempts(db, q);
  }
  const cardKey = cardKeyOf(body?.card);
  // The UMG spare only while no Cleffo link of this buyer (any order) is still open: that one may yet be paid.
  const linkFailed = config.cleffoEnabled && !config.cleffoOnly && cleffoLinkFailedLast(db, q)
    && !history.some((h) => h.processor === "cleffo" && !h.outcome);
  const route = chooseProcessor({ email, history, config, cardKey, linkFailed });
  return { route, history, config, cardKey, reusable };
}

/**
 * Create / reuse the order, gate on consent, create the payment link. Never charges anything itself.
 * -> { ok, status(http), body }
 */
export async function startCleffoAttempt(db, { req, body, pricing, route, config, consentLog, recordConsent, publicUrl, reusable, origin }, deps = {}) {
  const key = String(body?.idempotencyKey || body?.extOrderId || "").trim();
  if (!key) return { ok: false, status: 400, body: { ok: false, error: "idempotency_key_required", charged: false } };
  const desc = descriptorFor("cleffo");

  const existing = db.getOrderByIdempotency(key);
  const st = String(existing?.status || "").toLowerCase();
  // Already paid: answer before anything else (a replay after a lost answer needs no consent). Approved / in review /
  // waiting on UMG: never a new link for this order.
  if (existing && st === "approved") {
    return { ok: true, status: 200, body: { ok: true, reused: true, processor: existing.winningProcessor || "umg", order: existing, orderId: existing.id, charged: false } };
  }
  if (existing && (st === "review" || st === "pending" || existing.inFlight)) {
    return { ok: true, status: 200, body: { ok: true, reused: true, pending: true, processor: existing.winningProcessor || existing.lastProcessor || "cleffo", orderId: existing.id, charged: "unknown", message: "We are confirming your payment. Please do not pay again. If you do not receive an order confirmation within an hour, contact support." } };
  }

  // Same order, link still inside its lifetime: hand back the same open link.
  if (reusable) {
    const o = db.getOrder(reusable.orderId);
    const a = findCleffoAttempt(o, reusable.n);
    if (o && a && a.paymentLink && o.idempotencyKey === key) {
      return { ok: true, status: 200, body: { ok: true, reused: true, processor: "cleffo", redirectUrl: a.paymentLink, orderId: o.id, attempt: reusable.n, amount: a.amount ?? o.amount, currency: "USD", ...pick(desc), charged: false } };
    }
  }

  // Same buyer, same cart, a NEW key (page reload), and a link of theirs is still alive: that link again, never a second one
  // (and never the UMG spare while a Cleffo link of theirs may still be paid).
  if (!existing && pricing && pricing.ok) {
    const live = db.findLiveCleffoLink({ email: body?.customer?.email, customer: body?.customer, amount: pricing.amount, items: body?.items, shipMethod: pricing.shipMethod, coupon: pricing.coupon, excludeKey: key, ttlMin: numOr(config?.linkTtlMin, numOr(process.env.CLEFFO_LINK_TTL_MIN, 60)) });
    if (live) {
      log(`[routing] ${live.order.id} attempt=${live.attempt.routingAttempt} processor=cleffo outcome=live_link_reused_for_new_key`);
      return { ok: true, status: 200, body: { ok: true, reused: true, processor: "cleffo", redirectUrl: live.attempt.paymentLink, orderId: live.order.id, attempt: live.attempt.routingAttempt, amount: live.attempt.amount ?? live.order.amount, currency: "USD", ...pick(desc), charged: false } };
    }
  }

  const consent = validateConsentForCleffo(body);
  if (!consent.ok) {
    log(`[routing] cleffo refused before order: ${consent.error}${consent.detail ? ` (${consent.detail})` : ""}`);
    return { ok: false, status: 400, body: { ok: false, error: consent.error, processor: "cleffo", charged: false, message: "Please confirm the checkout acknowledgements before continuing to payment." } };
  }
  if (!consentLog) return { ok: false, status: 503, body: { ok: false, error: "consent_log_unavailable", charged: false, message: "Payment is temporarily unavailable. You were not charged. Please try again shortly." } };

  // A new order is priced by the server only: no catalog price, no order (the browser amount is never trusted).
  if (!existing && !(pricing && pricing.ok)) {
    log("[routing] cleffo refused before order: pricing_unavailable");
    return { ok: false, status: 503, body: { ok: false, error: "pricing_unavailable", processor: "cleffo", charged: false, message: "We could not confirm the price right now. Your card was not charged. Please try again in a minute." } };
  }
  const c = body.customer || {};
  const order = existing || {
    id: db.nextOrderId(),
    idempotencyKey: key,
    createdAt: nowIso(),
    status: "new",
    amount: formatAmount(body.amount),
    currency: "USD",
    customer: stripSecrets({
      first_name: c.first_name || c.firstName || "", last_name: c.last_name || c.lastName || "", email: c.email || "", phone: c.phone || "",
      country: c.country || "", state: c.state || "", city: c.city || "", zip: c.zip || "", address: c.address || "",
    }),
    items: Array.isArray(body.items) ? stripSecrets(body.items) : [],
    notes: body.notes || "",
    session_id: String(body.session_id || body.sessionId || "").trim(),
    ...orderAttribution(body), // infra 2026-09-30 order-attribution: same as cascade.js
    winningProcessor: null, winningTxnId: null, descriptor: null, lastProcessor: null, lastStatus: null,
    attempts: [],
  };
  if (pricing && pricing.ok) {
    Object.assign(order, {
      amount: formatAmount(pricing.amount),
      clientAmount: pricing.clientAmount,
      priceMismatch: Boolean(pricing.mismatch),
      priceCheck: { source: pricing.source, clientAmount: pricing.clientAmount, serverAmount: pricing.amount, subtotal: pricing.subtotal, shipping: pricing.shipping, shipMethod: pricing.shipMethod, mismatch: Boolean(pricing.mismatch), lines: pricing.lines, volumeDiscount: pricing.volumeDiscount || null, coupon: pricing.coupon || "", /* infra 2026-09-29 honest-charge: same fields as cascade.js */ discount: pricing.discount || null },
    });
  }
  order.inFlight = false;
  order.updatedAt = nowIso();
  // A number never used before on this order (a failed link creation does not count as an attempt, but Cleffo may still
  // have kept its merchant_order_id: the retry must not reuse it).
  const n = Math.max(route.attempt, ...(order.routing?.attempts || []).map((r) => Number(r.n) + 1 || 0));
  recordRoutingAttempt(order, { n, processor: "cleffo", reason: route.reason, bucket: route.bucket, splitPct: config.splitPct, env: config.cleffoEnv, previous: route.previous || null });
  db.upsertOrder(order);

  // Consent: append, then read back and verify the hash, BEFORE any link exists.
  const rec = recordConsent(order.id);
  const confirmed = rec && rec.ok && confirmConsentRecorded(consentLog, order.id, rec.hash);
  if (!confirmed) {
    const o = db.getOrder(order.id);
    setLastOutcome(o, "consent_not_confirmed", { countsAsAttempt: false, retryClass: "none" });
    o.status = "declined";
    o.lastStatus = "CONSENT_NOT_CONFIRMED";
    db.upsertOrder(o);
    log(`[routing] ${o.id} attempt=${n} processor=cleffo outcome=consent_not_confirmed (no redirect)`);
    return { ok: false, status: 503, body: { ok: false, error: "consent_not_confirmed", processor: "cleffo", orderId: o.id, charged: false, message: "We could not record your checkout acknowledgement. You were not charged. Please try again." } };
  }

  const fresh = db.getOrder(order.id);
  const cfg = deps.cleffoDeps?.config || cleffo.loadCleffoConfig();
  const token = cleffo.returnToken(fresh.id, n, cfg.signatureKey);
  const base = (publicUrl || "").replace(/\/$/, "");
  const redirectBack = `${base}/api/checkout/cleffo/return?o=${encodeURIComponent(fresh.id)}&a=${n}&t=${token}`;
  const merchantOrderId = `${fresh.id}A${n}`.replace(/[^A-Za-z0-9]/g, "");
  const startedAt = nowIso();
  const link = await cleffo.createPaymentLink({ order: fresh, merchantOrderId, redirectUrl: redirectBack }, deps.cleffoDeps || {});
  const o2 = db.getOrder(fresh.id);
  const unknown = !link.ok && link.unknown === true;
  const attempt = {
    attemptId: `cleffo-${startedAt}`,
    processor: "cleffo",
    mode: config.cleffoEnv,
    routingAttempt: n,
    startedAt,
    // What this link was created for: confirmation checks the payment against these, not against the (re-priced) order.
    amount: formatAmount(fresh.amount),
    currency: "USD",
    returnPage: returnPageFor(origin), // the /return redirect reads this, never the return request
    processorTxnId: link.ok ? link.ref : null,
    merchantOrderId,
    paymentLink: link.ok ? link.paymentLink : null,
    // LINK_UNKNOWN: no usable answer (timeout / dropped connection): the link may exist at Cleffo, so it is NOT "no link".
    processorStatus: link.ok ? "LINK_CREATED" : unknown ? "LINK_UNKNOWN" : "LINK_ERROR",
    httpStatus: link.httpStatus ?? null,
    cascadeAction: link.ok ? "redirect" : "next",
    declineClass: null,
    reason: link.ok ? "redirect" : unknown ? "cleffo_link_unknown" : "cleffo_link_error",
    errorMessage: link.ok ? "" : String(link.error || "").slice(0, 300),
    raw: {},
  };
  o2.attempts = [...(o2.attempts || []), attempt];
  o2.lastProcessor = "cleffo";
  o2.lastStatus = attempt.processorStatus;
  o2.updatedAt = nowIso();
  if (!link.ok) {
    // "link_error" (explicit answer / never sent) lets the next /route offer the UMG spare; "link_unknown" never does.
    setLastOutcome(o2, unknown ? "link_unknown" : "link_error", { countsAsAttempt: false, retryClass: "none", retryBasis: unknown ? "link_outcome_unknown" : "no_charge_attempted" });
    // Another link of this order still waits for the buyer: the order keeps waiting.
    const otherLive = (o2.attempts || []).some((x) => x !== attempt && x.processor === "cleffo" && x.processorStatus === "LINK_CREATED" && !x.abandoned);
    if (!(o2.status === AWAITING && otherLive)) o2.status = "declined";
    db.upsertOrder(o2);
    log(`[routing] ${o2.id} attempt=${n} processor=cleffo outcome=${unknown ? "link_unknown" : "link_error"} (${logText(attempt.errorMessage) || "error"})`);
    if (unknown) log(`[cleffo] link_unknown ${o2.id} attempt=${n} merchant_order_id=${merchantOrderId} (may exist at Cleffo; a callback with this merchant_order_id settles it)`);
    if (Date.now() - lastLinkErrorAlertAt >= LINK_ERROR_ALERT_EVERY_MS) {
      lastLinkErrorAlertAt = Date.now();
      alert("CLEFFO_LINK_ERROR", o2.id, n, `http=${link.httpStatus ?? "none"}`, ...(unknown ? ["unknown_outcome"] : []), logText(attempt.errorMessage).slice(0, 60) || "error");
    }
    return { ok: false, linkError: true, linkUnknown: unknown, orderId: o2.id, status: 503, body: { ok: false, error: "processor_unavailable", processor: "cleffo", orderId: o2.id, charged: false, message: "Payment is temporarily unavailable. You were not charged. Please try again in a minute." } };
  }
  o2.status = AWAITING;
  o2.cleffo = { ref: link.ref, merchantOrderId, attempt: n, linkCreatedAt: startedAt, env: config.cleffoEnv };
  db.upsertOrder(o2);
  logRouting(o2, { n, processor: "cleffo", reason: route.reason, outcome: "redirect" });
  return {
    ok: true,
    status: 200,
    orderId: o2.id,
    body: { ok: true, processor: "cleffo", redirectUrl: link.paymentLink, orderId: o2.id, attempt: n, amount: o2.amount, currency: o2.currency, chargedAmount: o2.amount, priceAdjusted: Boolean(o2.priceMismatch), ...pick(desc), charged: false },
  };
}

function pick(desc) {
  return { statementDescriptor: desc.statementDescriptor, statementDescriptorConfirmed: desc.statementDescriptorConfirmed };
}

/** After chargeCart on the UMG route: log processor + attempt + retry class on the order. */
export function recordUmgRouting(db, orderId, { route, config, cardKey, result }) {
  const order = db.getOrder(orderId);
  if (!order) return null;
  const last = [...(order.attempts || [])].reverse().find((a) => a.processor !== "cleffo") || {};
  let outcome = "declined";
  let cls = { retryClass: "none", basis: "approved", code: null };
  const st = String(order.status || "").toLowerCase();
  if (st === "approved") outcome = "approved";
  // infra 2026-09-29 honest-charge: an unknown UMG outcome keeps its own basis (still retryClass none)
  else if (st === "pending") { outcome = "pending"; cls = { retryClass: "none", basis: last.reason === "unknown_outcome" ? "unknown_outcome" : "pending", code: null }; }
  else cls = classifyForRetry(last);
  recordRoutingAttempt(order, {
    n: route.attempt, processor: "umg", reason: route.reason, bucket: route.bucket, splitPct: config.splitPct,
    env: config.cleffoEnabled ? config.cleffoEnv : null, previous: route.previous || null, outcome,
    retryClass: cls.retryClass, retryBasis: cls.basis, retryCode: cls.code, cardKey: cardKey || undefined,
    processorTxnId: last.processorTxnId || null, settledAt: nowIso(),
    ...(result?.error === "no_enabled_processor" ? { countsAsAttempt: false } : {}),
  });
  db.upsertOrder(order);
  log(`[routing] ${order.id} attempt=${route.attempt} processor=umg reason=${route.reason} outcome=${outcome} retryClass=${cls.retryClass} basis=${cls.basis}${cls.code ? ` code=${cls.code}` : ""}`);
  return db.getOrder(order.id);
}

/** What the storefront should do next after a decline (for the JSON answers). */
export function nextStepFor(db, order, config = routingConfig()) {
  if (!config.cleffoEnabled || !order) return null;
  const history = customerAttempts(db, { email: order.customer?.email, sessionId: order.session_id, idempotencyKey: order.idempotencyKey, windowMin: config.retryWindowMin });
  let next = chooseProcessor({ email: order.customer?.email, history, config });
  // Daily Cleffo cap: a soft-decline switch to Cleffo stays on UMG once the day's Cleffo total is used up.
  next = capDecision(next, { store: db, config, amount: order.amount, email: order.customer?.email, sessionId: order.session_id, idempotencyKey: order.idempotencyKey, remember: false, write: () => {} }).route;
  return { attemptsUsed: history.length, attemptsLeft: Math.max(0, config.maxAttempts - history.length), nextProcessor: next.blocked ? null : next.processor, nextReason: next.reason, ...(next.processor ? pick(descriptorFor(next.processor)) : {}) };
}

// Links older than this are asked about less often (a dead link costs a Cleffo call per minute otherwise).
const SLOW_AFTER_MS = 2 * 3600 * 1000;
const SLOW_EVERY_MS = 10 * 60 * 1000;
const STUCK_AFTER_MS = 24 * 3600 * 1000;
const STUCK_SUMMARY_EVERY_MS = 24 * 3600 * 1000;
const lastSweepPoll = new Map();
let lastStuckSummaryAt = 0;

/**
 * Background: settle EVERY open Cleffo link (LINK_CREATED with no confirmed outcome, abandoned ones included, on any
 * order status: a paid old link of an approved order is a double payment) for CLEFFO_SWEEP_HOURS after creation. Also
 * re-asks for a "failed" link for as long as the link itself lives (CLEFFO_LINK_TTL_MIN): if Cleffo lets the buyer pay
 * again on the same link, a late payment is still booked.
 * Links that stay open after 24 h: the buyer who never came back is only a log line; buyers who DID come back through
 * /cleffo/return and are still pending are one summary alert a day (CLEFFO_STUCK_SUMMARY).
 */
export async function sweepCleffo(db, deps = {}) {
  const out = [];
  const now = Date.now();
  const hours = numOr(deps.sweepHours, numOr(process.env.CLEFFO_SWEEP_HOURS, 72));
  const horizon = now - hours * 3600 * 1000;
  const ttlMs = numOr(deps.linkTtlMin, numOr(process.env.CLEFFO_LINK_TTL_MIN, 60)) * 60000;
  for (const [k, at] of lastSweepPoll) if (now - at > 24 * 3600 * 1000) lastSweepPoll.delete(k);
  const stuckReturned = []; // { orderId, born }
  for (const o of db.listOrders()) {
    for (const a of o.attempts || []) {
      if (a.processor !== "cleffo") continue;
      const born = Date.parse(a.startedAt) || 0;
      const open = a.processorStatus === "LINK_CREATED";
      const recheck = a.processorStatus === "DECLINED" && a.processorTxnId && now - born <= ttlMs;
      if (!open && !recheck) continue;
      if (born < horizon) continue;
      const pollKey = `${o.id}#${a.routingAttempt}`;
      if (now - born > SLOW_AFTER_MS && now - (lastSweepPoll.get(pollKey) || 0) < SLOW_EVERY_MS) {
        if (open && a.returnedAt && now - born > STUCK_AFTER_MS) stuckReturned.push({ orderId: o.id, born });
        continue;
      }
      lastSweepPoll.set(pollKey, now);
      const r = await confirmCleffoAttempt(db, o.id, a.routingAttempt, { ...deps, via: "sweep", recheckDeclined: recheck }).catch(() => ({ status: "error" }));
      out.push({ orderId: o.id, attempt: a.routingAttempt, status: r.status });
      if (!open || r.status !== "pending" || now - born <= STUCK_AFTER_MS) continue;
      if (a.returnedAt) { stuckReturned.push({ orderId: o.id, born }); continue; }
      const fresh = db.getOrder(o.id);
      const i = (fresh?.attempts || []).findIndex((x) => x.attemptId === a.attemptId);
      if (i !== -1 && !fresh.attempts[i].stuckLogged) {
        fresh.attempts[i] = { ...fresh.attempts[i], stuckLogged: true };
        db.upsertOrder(fresh);
        log(`[cleffo] open_no_return ${o.id} attempt=${a.routingAttempt} since=${a.startedAt}`); // buyer never came back: not an alert
      }
    }
  }
  if (stuckReturned.length && now - lastStuckSummaryAt >= STUCK_SUMMARY_EVERY_MS) {
    lastStuckSummaryAt = now;
    stuckReturned.sort((x, y) => x.born - y.born);
    alert("CLEFFO_STUCK_SUMMARY", `n=${stuckReturned.length}`, `oldest=${stuckReturned[0].orderId}`);
  }
  return out;
}

export function startCleffoSweeper(db, { intervalMs = 60000, ...deps } = {}) {
  let running = false; // a slow pass (15 s per Cleffo call) must not overlap the next tick
  const t = setInterval(() => {
    if (running) return;
    running = true;
    sweepCleffo(db, deps).catch(() => {}).finally(() => { running = false; });
  }, intervalMs);
  if (typeof t.unref === "function") t.unref();
  return () => clearInterval(t);
}

/** Staff read-only settings + counts. Booleans only for keys. */
export function cleffoSettingsView(db, env = process.env) {
  const config = routingConfig(env);
  const cfg = cleffo.loadCleffoConfig(env);
  const counts = { umg: 0, cleffo: 0, attempts: 0, byOutcome: {} };
  for (const o of db.listOrders()) {
    for (const a of o.routing?.attempts || []) {
      counts.attempts += 1;
      if (a.processor in counts) counts[a.processor] += 1;
      const k = a.outcome || "open";
      counts.byOutcome[k] = (counts.byOutcome[k] || 0) + 1;
    }
  }
  return {
    cleffoEnabled: config.cleffoEnabled,
    cleffoEnv: config.cleffoEnv,
    cleffoOnly: config.cleffoOnly,
    linkTtlMin: config.linkTtlMin,
    sweepHours: config.sweepHours,
    splitPct: config.splitPct,
    maxAttempts: config.maxAttempts,
    retryWindowMin: config.retryWindowMin,
    dailyCap: config.dailyCapUsd > 0
      ? { capUsd: config.dailyCapUsd, tz: config.capTz, pendingMin: config.capPendingMin, today: cleffoDailyUsage(db, { tz: config.capTz, pendingMin: config.capPendingMin }) }
      : { capUsd: 0 },
    rules: "first attempt: sticky sha256(email) bucket; soft decline -> other processor once; hard/unknown -> same processor (never switched)",
    keys: cleffo.cleffoKeyHealth(cfg),
    descriptors: { umg: descriptorFor("umg", env), cleffo: descriptorFor("cleffo", env) },
    returnPage: env.CLEFFO_STOREFRONT_RETURN_URL || DEFAULT_RETURN_PAGE,
    consentRequiredChecks: String(env.CLEFFO_REQUIRED_CONSENT_CHECKS || "").split(",").map((x) => x.trim()).filter(Boolean),
    counts,
  };
}

/** `page` = the return page stored on the attempt (from the Origin of the /charge request); env / default when absent (old attempts). */
export function storefrontReturnUrl(order, attemptNo, token, status, env = process.env, page = "") {
  const u = new URL(page || env.CLEFFO_STOREFRONT_RETURN_URL || DEFAULT_RETURN_PAGE);
  u.searchParams.set("cleffo", "1");
  u.searchParams.set("order", order?.id || "");
  u.searchParams.set("a", String(attemptNo || ""));
  u.searchParams.set("t", token || "");
  u.searchParams.set("status", status);
  return u.toString();
}

export { bucketFor };
