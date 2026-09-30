/**
 * Cleffo checkout glue: routing decision, consent gate, payment-link attempt, server-side confirmation, sweep,
 * staff settings view. See docs/CLEFFO.md. Off unless CLEFFO_ENABLED=true.
 */
import { formatAmount } from "./card.js";
import { stripSecrets } from "./sanitize.js";
import * as cleffo from "./cleffo.js";
import { classifyForRetry } from "./retry-class.js";
import { sanitizeConsent } from "./consent.js";
import { CARD_STATEMENT_DESCRIPTOR } from "./store-forward.js";
import {
  bucketFor,
  cardKeyOf,
  chooseProcessor,
  customerAttempts,
  logRouting,
  recordRoutingAttempt,
  routingConfig,
  setLastOutcome,
} from "./routing.js";

export const AWAITING = "awaiting_payment";
const DEFAULT_RETURN_PAGE = "https://biolabsresearch.co/checkout";

function nowIso() {
  return new Date().toISOString();
}

function log(line) {
  process.stdout.write(`${line}\n`);
}

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
 * returned as-is. -> { ok, status: paid|declined|pending|review|unknown, order, reused, attempt }
 */
export async function confirmCleffoAttempt(db, orderId, attemptNo, deps = {}) {
  const order = db.getOrder(orderId) || db.getOrderByRef(orderId);
  if (!order) return { ok: false, status: "unknown", error: "not_found" };
  const att = findCleffoAttempt(order, attemptNo);
  if (!att) return { ok: false, status: "unknown", error: "attempt_not_found", order };
  const settled = { PAID: "paid", DECLINED: "declined", REVIEW: "review" }[att.processorStatus];
  if (settled) return { ok: true, status: settled, reused: true, order, attempt: att };
  if (!att.processorTxnId) return { ok: false, status: "unknown", error: "no_link", order };

  const st = await cleffo.getPaymentStatus(att.processorTxnId, deps.cleffoDeps || {});
  if (!st.ok) return { ok: false, status: "pending", error: "status_unavailable", order, attempt: att };

  // Re-read: another request may have settled it while we waited.
  const fresh = db.getOrder(order.id);
  const idx = fresh.attempts.findIndex((a) => a.attemptId === att.attemptId);
  const cur = fresh.attempts[idx];
  const already = { PAID: "paid", DECLINED: "declined", REVIEW: "review" }[cur.processorStatus];
  if (already) return { ok: true, status: already, reused: true, order: fresh, attempt: cur };

  const base = { ...cur, polledAt: nowIso(), cleffoStatus: st.paymentStatus, gatewayIntentId: st.gatewayIntentId || cur.gatewayIntentId || null, date: st.dateTime || cur.date || null };
  let status = "pending";
  if (st.status === "PAID") {
    const amountOk = formatAmount(st.totalAmount) === formatAmount(fresh.amount);
    const currencyOk = String(st.currency || "").toUpperCase() === String(fresh.currency || "USD").toUpperCase();
    const refOk = !st.merchantOrderId || st.merchantOrderId === cur.merchantOrderId;
    if (amountOk && currencyOk && refOk) {
      status = "paid";
      fresh.attempts[idx] = { ...base, processorStatus: "PAID", cascadeAction: "success", declineClass: null, reason: "approved", finishedAt: nowIso() };
      fresh.status = "approved";
      fresh.winningProcessor = "cleffo";
      fresh.winningTxnId = cur.processorTxnId;
      const d = descriptorFor("cleffo");
      fresh.descriptor = d.statementDescriptor;
      fresh.lastStatus = "PAID";
      setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "paid", retryClass: "none" });
    } else {
      status = "review";
      fresh.attempts[idx] = { ...base, processorStatus: "REVIEW", reason: "cleffo_paid_mismatch", mismatch: { amount: st.totalAmount, currency: st.currency, merchantOrderId: st.merchantOrderId } };
      fresh.status = "review";
      fresh.lastStatus = "REVIEW";
      setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "review", retryClass: "hard", retryBasis: "paid_mismatch" });
    }
  } else if (st.status === "DECLINED") {
    status = "declined";
    const cls = classifyForRetry({ processor: "cleffo", processorStatus: "DECLINED", informationData: st.message || "" });
    fresh.attempts[idx] = { ...base, processorStatus: "DECLINED", cascadeAction: "stop", declineClass: cls.retryClass, reason: `cleffo_failed:${cls.basis}`, finishedAt: nowIso() };
    if (fresh.status !== "approved") fresh.status = "declined";
    fresh.lastStatus = "DECLINED";
    setLastOutcomeFor(fresh, cur.routingAttempt, { outcome: "declined", retryClass: cls.retryClass, retryBasis: cls.basis, retryCode: cls.code });
  } else {
    fresh.attempts[idx] = { ...base, processorStatus: cur.processorStatus };
  }
  fresh.updatedAt = nowIso();
  db.upsertOrder(fresh);
  if (status !== "pending") {
    const r = (fresh.routing?.attempts || []).find((x) => x.n === cur.routingAttempt) || {};
    log(`[routing] ${fresh.id} attempt=${cur.routingAttempt} processor=cleffo outcome=${status} retryClass=${r.retryClass || "-"} basis=${r.retryBasis || "-"} via=${deps.via || "confirm"}`);
  }
  if (status === "paid" && typeof deps.onPaid === "function") {
    try { deps.onPaid(fresh); } catch { /* never fail the confirmation */ }
  }
  return { ok: true, status, order: db.getOrder(fresh.id), attempt: fresh.attempts[idx] };
}

function setLastOutcomeFor(order, n, patch) {
  const list = order.routing?.attempts || [];
  const i = list.findIndex((r) => r.n === n && r.processor === "cleffo");
  if (i !== -1) list[i] = { ...list[i], ...patch, settledAt: nowIso() };
}

/**
 * Before routing a new attempt: settle this customer's open Cleffo links from the status API; an open link older than
 * CLEFFO_LINK_REUSE_SEC that is still pending becomes "abandoned" (outcome unknown -> hard, fail closed: no switch).
 */
export async function refreshOpenCleffoLinks(db, history, deps = {}, env = process.env) {
  const reuseSec = Number(env.CLEFFO_LINK_REUSE_SEC) > 0 ? Number(env.CLEFFO_LINK_REUSE_SEC) : 120;
  let reusable = null;
  for (const h of history) {
    if (h.processor !== "cleffo" || h.outcome) continue;
    const res = await confirmCleffoAttempt(db, h.orderId, h.n, { ...deps, via: "pre-route" });
    if (res.status !== "pending") continue;
    const age = (Date.now() - (Date.parse(h.at) || 0)) / 1000;
    if (age <= reuseSec) {
      reusable = { orderId: h.orderId, n: h.n };
      continue;
    }
    const o = db.getOrder(h.orderId);
    if (!o) continue;
    setLastOutcomeFor(o, h.n, { outcome: "abandoned", retryClass: "hard", retryBasis: "abandoned_unknown_fail_closed" });
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
    ({ reusable } = await refreshOpenCleffoLinks(db, history, deps));
    history = customerAttempts(db, q);
  }
  const cardKey = cardKeyOf(body?.card);
  const route = chooseProcessor({ email, history, config, cardKey });
  return { route, history, config, cardKey, reusable };
}

/**
 * Create / reuse the order, gate on consent, create the payment link. Never charges anything itself.
 * -> { ok, status(http), body }
 */
export async function startCleffoAttempt(db, { req, body, pricing, route, config, consentLog, recordConsent, publicUrl, reusable }, deps = {}) {
  const key = String(body?.idempotencyKey || body?.extOrderId || "").trim();
  if (!key) return { ok: false, status: 400, body: { ok: false, error: "idempotency_key_required", charged: false } };
  const desc = descriptorFor("cleffo");

  // Double-submit inside the reuse window: hand back the same open link.
  if (reusable) {
    const o = db.getOrder(reusable.orderId);
    const a = findCleffoAttempt(o, reusable.n);
    if (o && a && a.paymentLink && o.idempotencyKey === key) {
      return { ok: true, status: 200, body: { ok: true, reused: true, processor: "cleffo", redirectUrl: a.paymentLink, orderId: o.id, attempt: reusable.n, amount: o.amount, currency: o.currency, ...pick(desc), charged: false } };
    }
  }

  const consent = validateConsentForCleffo(body);
  if (!consent.ok) {
    log(`[routing] cleffo refused before order: ${consent.error}${consent.detail ? ` (${consent.detail})` : ""}`);
    return { ok: false, status: 400, body: { ok: false, error: consent.error, processor: "cleffo", charged: false, message: "Please confirm the checkout acknowledgements before continuing to payment." } };
  }
  if (!consentLog) return { ok: false, status: 503, body: { ok: false, error: "consent_log_unavailable", charged: false, message: "Payment is temporarily unavailable. You were not charged. Please try again shortly." } };

  const existing = db.getOrderByIdempotency(key);
  if (existing && String(existing.status).toLowerCase() === "approved") {
    return { ok: true, status: 200, body: { ok: true, reused: true, processor: existing.winningProcessor || "umg", order: existing, orderId: existing.id, charged: false } };
  }
  const c = body.customer || {};
  const order = existing || {
    id: db.nextOrderId(),
    idempotencyKey: key,
    createdAt: nowIso(),
    status: "new",
    amount: formatAmount(body.amount),
    currency: body.currency || "USD",
    customer: stripSecrets({
      first_name: c.first_name || c.firstName || "", last_name: c.last_name || c.lastName || "", email: c.email || "", phone: c.phone || "",
      country: c.country || "", state: c.state || "", city: c.city || "", zip: c.zip || "", address: c.address || "",
    }),
    items: Array.isArray(body.items) ? stripSecrets(body.items) : [],
    notes: body.notes || "",
    session_id: String(body.session_id || body.sessionId || "").trim(),
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
  const n = route.attempt;
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
  const attempt = {
    attemptId: `cleffo-${startedAt}`,
    processor: "cleffo",
    mode: config.cleffoEnv,
    routingAttempt: n,
    startedAt,
    processorTxnId: link.ok ? link.ref : null,
    merchantOrderId,
    paymentLink: link.ok ? link.paymentLink : null,
    processorStatus: link.ok ? "LINK_CREATED" : "LINK_ERROR",
    httpStatus: link.httpStatus ?? null,
    cascadeAction: link.ok ? "redirect" : "next",
    declineClass: null,
    reason: link.ok ? "redirect" : "cleffo_link_error",
    errorMessage: link.ok ? "" : String(link.error || "").slice(0, 300),
    raw: {},
  };
  o2.attempts = [...(o2.attempts || []), attempt];
  o2.lastProcessor = "cleffo";
  o2.lastStatus = attempt.processorStatus;
  o2.updatedAt = nowIso();
  if (!link.ok) {
    setLastOutcome(o2, "link_error", { countsAsAttempt: false, retryClass: "none", retryBasis: "no_charge_attempted" });
    o2.status = "declined";
    db.upsertOrder(o2);
    log(`[routing] ${o2.id} attempt=${n} processor=cleffo outcome=link_error (${attempt.errorMessage || "error"})`);
    return { ok: false, linkError: true, orderId: o2.id, status: 503, body: { ok: false, error: "processor_unavailable", processor: "cleffo", orderId: o2.id, charged: false, message: "Payment is temporarily unavailable. You were not charged. Please try again in a minute." } };
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
  const next = chooseProcessor({ email: order.customer?.email, history, config });
  return { attemptsUsed: history.length, attemptsLeft: Math.max(0, config.maxAttempts - history.length), nextProcessor: next.blocked ? null : next.processor, nextReason: next.reason, ...(next.processor ? pick(descriptorFor(next.processor)) : {}) };
}

/** Background: settle open Cleffo links (status API) for 24 h after creation. */
export async function sweepCleffo(db, deps = {}) {
  const out = [];
  const horizon = Date.now() - 24 * 3600 * 1000;
  for (const o of db.listOrders()) {
    if (o.status !== AWAITING) continue;
    const a = findCleffoAttempt(o);
    if (!a || a.processorStatus !== "LINK_CREATED" || (Date.parse(a.startedAt) || 0) < horizon) continue;
    const r = await confirmCleffoAttempt(db, o.id, a.routingAttempt, { ...deps, via: "sweep" }).catch(() => ({ status: "error" }));
    out.push({ orderId: o.id, status: r.status });
  }
  return out;
}

export function startCleffoSweeper(db, { intervalMs = 60000, ...deps } = {}) {
  const t = setInterval(() => { sweepCleffo(db, deps).catch(() => {}); }, intervalMs);
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
    splitPct: config.splitPct,
    maxAttempts: config.maxAttempts,
    retryWindowMin: config.retryWindowMin,
    rules: "first attempt: sticky sha256(email) bucket; soft decline -> other processor once; hard/unknown -> same processor (never switched)",
    keys: cleffo.cleffoKeyHealth(cfg),
    descriptors: { umg: descriptorFor("umg", env), cleffo: descriptorFor("cleffo", env) },
    returnPage: env.CLEFFO_STOREFRONT_RETURN_URL || DEFAULT_RETURN_PAGE,
    consentRequiredChecks: String(env.CLEFFO_REQUIRED_CONSENT_CHECKS || "").split(",").map((x) => x.trim()).filter(Boolean),
    counts,
  };
}

export function storefrontReturnUrl(order, attemptNo, token, status, env = process.env) {
  const u = new URL(env.CLEFFO_STOREFRONT_RETURN_URL || DEFAULT_RETURN_PAGE);
  u.searchParams.set("cleffo", "1");
  u.searchParams.set("order", order?.id || "");
  u.searchParams.set("a", String(attemptNo || ""));
  u.searchParams.set("t", token || "");
  u.searchParams.set("status", status);
  return u.toString();
}

export { bucketFor };
