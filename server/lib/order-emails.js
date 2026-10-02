// Transactional customer order emails: sending, idempotency, send log, retries, alerts, due-order sweeper, and a
// reusable helper for any customer email type (registerEmailType + sendOrderEmail).
//
// From: "BioLabs Research" <support@biolabsresearch.co> (no Reply-To: replies land at support@). Internal alerts go
// from noreply@ to ORDER_EMAILS_ALERT_TO (admin@). Off unless ORDER_EMAILS_ENABLED=true AND the support SMTP password
// is set; otherwise every email is still rendered, guard-checked and logged as "skipped_disabled", never sent.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import nodemailer from "nodemailer";
import { TEMPLATES, renderEmail, loadNameMap, SUPPORT_EMAIL } from "./email-templates.js";
import { isPaidOrder } from "./rapid-orders.js";
import { isDryRunOrder } from "./store-forward.js";
import { humanUseBlocks } from "./human-use.js"; // 2026-09-30: no customer email for a COMPLIANCE_HOLD order

export const FINAL_STATUSES = new Set(["sent", "skipped_disabled", "blocked_guard", "failed", "failed_unknown", "no_recipient"]);
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const registry = { ...TEMPLATES };

export function emailConfig(env = process.env) {
  const smtp = (P, fallback) => ({
    host: env[`${P}_SMTP_HOST`] || (fallback ? env.SMTP_HOST : "") || "",
    port: Number(env[`${P}_SMTP_PORT`] || (fallback ? env.SMTP_PORT : "") || 465),
    user: env[`${P}_SMTP_USER`] || (fallback ? env.SMTP_USER : "") || "",
    pass: env[`${P}_SMTP_PASS`] || (fallback ? env.SMTP_PASS : "") || "",
  });
  const support = smtp("SUPPORT", true);
  const noreply = smtp("NOREPLY", false);
  const since = Date.parse(env.ORDER_EMAILS_SINCE || "");
  return {
    enabled: env.ORDER_EMAILS_ENABLED === "true",
    support,
    noreply,
    from: { name: "BioLabs Research", address: env.SUPPORT_FROM || SUPPORT_EMAIL },
    alertFrom: { name: "BioLabs Research Alerts", address: env.NOREPLY_FROM || "noreply@biolabsresearch.co" },
    alertTo: env.ORDER_EMAILS_ALERT_TO === undefined ? "admin@biolabsresearch.co" : env.ORDER_EMAILS_ALERT_TO,
    since: Number.isFinite(since) ? since : null,
    followupDays: Number(env.ORDER_EMAILS_FOLLOWUP_DAYS) > 0 ? Number(env.ORDER_EMAILS_FOLLOWUP_DAYS) : 7,
    logPath: env.ORDER_EMAIL_LOG_PATH || (env.STORE_PATH ? join(dirname(env.STORE_PATH), "email-log.jsonl") : null),
    retries: 3,
    backoffMs: [2000, 10000, 30000],
  };
}
export const canSend = (cfg) => cfg.enabled && Boolean(cfg.support.host && cfg.support.user && cfg.support.pass);

export function maskEmail(e) {
  const [u, d] = String(e || "").split("@");
  if (!d) return e ? "***" : "";
  return `${u.slice(0, 2)}***@${d}`;
}

/** Register (or override) a customer email type. tpl = { subject(order, ctx), blocks(order, ctx) -> h-blocks[], preheader? }. */
export function registerEmailType(type, tpl) {
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(type)) throw new Error("invalid email type");
  if (!tpl || typeof tpl.subject !== "function" || typeof tpl.blocks !== "function") throw new Error("template needs subject() and blocks()");
  registry[type] = tpl;
}
export const emailTypes = () => Object.keys(registry);

export function createEmailLog(path) {
  return {
    path,
    append(entry) {
      if (!path) return;
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      try { chmodSync(path, 0o600); } catch { /* best effort */ }
    },
    read({ orderId, type, limit = 200 } = {}) {
      if (!path || !existsSync(path)) return [];
      const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      return rows.filter((r) => (!orderId || r.orderId === orderId) && (!type || r.type === type)).slice(-limit);
    },
  };
}

function defaultTransportFactory(smtp) {
  return nodemailer.createTransport({
    host: smtp.host, port: smtp.port, secure: smtp.port === 465, requireTLS: smtp.port !== 465,
    auth: { user: smtp.user, pass: smtp.pass }, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}

/**
 * createOrderEmailer({ db, cfg, log, transportFactory, sleep, now, logger }) -> {
 *   send(orderOrId, type, { force, qa, data, via }) -> Promise<result>   // idempotent per (order, type)
 *   processDue({ orderId, qa, forceFollowup }) -> summary                 // sweeper step (and QA hook)
 *   preview(type, order, data) -> { subject, html, text, guard }
 *   start(intervalMs)
 * }
 * Never throws into the caller; checkout / order flows call it fire-and-forget.
 */
export function createOrderEmailer(opts = {}) {
  const db = opts.db;
  const cfg = opts.cfg || emailConfig();
  const log = opts.log || createEmailLog(cfg.logPath);
  const transportFactory = opts.transportFactory || defaultTransportFactory;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now || (() => new Date());
  const say = opts.logger || ((m) => process.stdout.write(`${m}\n`));
  const inflight = new Map();
  let transport = null;
  let alertTransport = null;

  const orderOf = (x) => (typeof x === "string" ? db.getOrder(x) || db.getOrderByRef(x) : x && x.id ? db.getOrder(x.id) || x : null);
  function record(order, type, state) {
    const fresh = db.getOrder(order.id) || order;
    fresh.emails = { ...(fresh.emails || {}), [type]: { ...(fresh.emails?.[type] || {}), ...state } };
    db.upsertOrder(fresh);
    return fresh.emails[type];
  }
  function logEntry(order, type, fields) {
    const entry = { at: now().toISOString(), type, orderId: order.id, orderRef: order.orderRef || null, to: order.customer?.email || null, ...fields };
    try { log.append(entry); } catch (err) { say(`[emails] log write failed: ${err.message}`); }
    say(`[emails] ${type} ${order.id} -> ${maskEmail(entry.to)}: ${fields.status}${fields.attempt ? ` (attempt ${fields.attempt})` : ""}`);
    return entry;
  }
  async function alert(subject, text) {
    say(`[emails] ALERT ${subject}`);
    if (!cfg.alertTo || !cfg.noreply.host || !cfg.noreply.user || !cfg.noreply.pass || !cfg.enabled) return false;
    try {
      alertTransport = alertTransport || transportFactory(cfg.noreply);
      await alertTransport.sendMail({ from: cfg.alertFrom, to: cfg.alertTo, subject: `[order-emails] ${subject}`, text });
      return true;
    } catch (err) {
      say(`[emails] alert send failed: ${err?.code || err?.message || "error"}`);
      return false;
    }
  }

  async function deliver(order, type, rendered, via) {
    const to = order.customer.email;
    const total = cfg.retries + 1;
    let lastErr = null;
    for (let attempt = 1; attempt <= total; attempt += 1) {
      record(order, type, { status: "sending", attempt, updatedAt: now().toISOString() });
      try {
        transport = transport || transportFactory(cfg.support);
        const info = await transport.sendMail({
          from: cfg.from, to, subject: rendered.subject, text: rendered.text, html: rendered.html,
          headers: { "X-BLR-Order": order.id, "X-BLR-Email-Type": type, "Auto-Submitted": "auto-generated" },
        });
        const messageId = info?.messageId || null;
        record(order, type, { status: "sent", attempt, messageId, sentAt: now().toISOString(), via });
        logEntry(order, type, { status: "sent", attempt, messageId, via });
        return { ok: true, status: "sent", attempt, messageId };
      } catch (err) {
        lastErr = err;
        transport = null; // fresh connection next time
        const reason = String(err?.code || err?.responseCode || err?.message || "smtp_error").slice(0, 120);
        logEntry(order, type, { status: attempt < total ? "retrying" : "failed", attempt, error: reason, via });
        if (attempt < total) await sleep(cfg.backoffMs[attempt - 1] ?? cfg.backoffMs[cfg.backoffMs.length - 1]);
      }
    }
    const reason = String(lastErr?.code || lastErr?.responseCode || lastErr?.message || "smtp_error").slice(0, 120);
    record(order, type, { status: "failed", attempt: total, error: reason, failedAt: now().toISOString(), via });
    await alert(`${type} email failed for ${order.id}`, `Order ${order.id}: ${type} email to ${maskEmail(to)} failed after ${total} attempts (${reason}). Resend: POST /api/emails/resend/${order.id}/${type}`);
    return { ok: false, status: "failed", attempt: total, error: reason };
  }

  async function sendInner(orderOrId, type, o = {}) {
    const order = orderOf(orderOrId);
    if (!order) return { ok: false, status: "not_found" };
    if (!registry[type]) return { ok: false, status: "unknown_type" };
    if (humanUseBlocks(order)) return { ok: false, status: "skipped_compliance_hold" }; // not recorded: nothing is sent while held
    const prev = order.emails?.[type];
    if (prev && !o.force && (FINAL_STATUSES.has(prev.status) || prev.status === "sending" || prev.status === "pending")) {
      return { ok: true, status: "duplicate", previous: prev.status };
    }
    if (isDryRunOrder(order) && !o.qa) return { ok: false, status: "skipped_test_order" };
    const via = o.via || "auto";
    const to = String(order.customer?.email || "").trim();
    if (!EMAIL_RE.test(to)) {
      record(order, type, { status: "no_recipient", at: now().toISOString(), via });
      logEntry(order, type, { status: "no_recipient", via });
      return { ok: false, status: "no_recipient" };
    }
    record(order, type, { status: "pending", at: now().toISOString(), via });
    let rendered;
    try {
      rendered = renderEmail(type, order, { templates: registry, nameMap: loadNameMap(), data: o.data || {} });
    } catch (err) {
      record(order, type, { status: "failed", error: `render: ${err.message}`.slice(0, 160), via });
      logEntry(order, type, { status: "failed", error: `render: ${err.message}`.slice(0, 160), via });
      await alert(`${type} email render failed for ${order.id}`, err.message);
      return { ok: false, status: "failed", error: "render" };
    }
    if (rendered.guard.length) {
      record(order, type, { status: "blocked_guard", blocked: rendered.guard, at: now().toISOString(), via });
      logEntry(order, type, { status: "blocked_guard", blocked: rendered.guard, subject: rendered.subject, via });
      await alert(`${type} email blocked by the compliance guard for ${order.id}`, `Blocked terms: ${rendered.guard.join(", ")}. Nothing was sent.`);
      return { ok: false, status: "blocked_guard", blocked: rendered.guard };
    }
    if (!canSend(cfg)) {
      record(order, type, { status: "skipped_disabled", at: now().toISOString(), subject: rendered.subject, via });
      logEntry(order, type, { status: "skipped_disabled", attempt: 0, messageId: null, subject: rendered.subject, reason: cfg.enabled ? "smtp_password_missing" : "ORDER_EMAILS_ENABLED=false", via });
      return { ok: true, status: "skipped_disabled", subject: rendered.subject };
    }
    return deliver(order, type, rendered, via);
  }

  function send(orderOrId, type, o = {}) {
    const order = orderOf(orderOrId);
    const key = `${order?.id || orderOrId}:${type}`;
    if (inflight.has(key)) return inflight.get(key).then(() => ({ ok: true, status: "duplicate", previous: "inflight" }));
    const p = sendInner(order || orderOrId, type, o).catch((err) => {
      say(`[emails] ${type} ${order?.id || orderOrId} unexpected error: ${err?.message || err}`);
      return { ok: false, status: "error" };
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  // Without ORDER_EMAILS_SINCE the sweeper only looks at orders created after this process started (never a backlog).
  const sinceMs = cfg.since ?? now().getTime();
  const afterSince = (o) => Date.parse(o.createdAt || 0) >= sinceMs;
  const hasTracking = (o) => o.fulfillment?.status === "shipped" && Boolean(o.fulfillment?.trackingNumber);

  /** One sweep: confirmation (paid), shipping (tracking added), follow-up (shipped + N days). */
  async function processDue({ orderId, qa = false, forceFollowup = false } = {}) {
    const t = now().getTime();
    const orders = orderId ? [orderOf(orderId)].filter(Boolean) : db.listOrders();
    const out = { checked: 0, started: [], results: [] };
    for (const o of orders) {
      if (!qa && !afterSince(o)) continue; // orders from before go-live never get a late email
      if (isDryRunOrder(o) && !qa) continue;
      if (humanUseBlocks(o)) continue; // COMPLIANCE_HOLD: never emails the customer
      out.checked += 1;
      // a "sending"/"pending" state left by a restart is not retried automatically (it may have gone out): flag it
      for (const [type, st] of Object.entries(o.emails || {})) {
        if ((st.status === "sending" || st.status === "pending") && !inflight.has(`${o.id}:${type}`) && t - Date.parse(st.updatedAt || st.at || 0) > 15 * 60 * 1000) {
          record(o, type, { status: "failed_unknown", note: "interrupted (restart?) — check before resending" });
          logEntry(o, type, { status: "failed_unknown", via: "sweeper" });
          await alert(`${type} email state unknown for ${o.id}`, "Interrupted while sending (service restart?). Check the mailbox before resending.");
        }
      }
      const due = [];
      if (isPaidOrder(o)) due.push("confirmation");
      if (isPaidOrder(o) && hasTracking(o)) due.push("shipping");
      if (isPaidOrder(o) && hasTracking(o)) {
        // audit 2026-10-02 (pay-rest-23): Date.parse(0) is the year 2000, so a shipped order without shippedAt got its follow-up at once.
        const shippedAt = Date.parse(o.fulfillment.shippedAt || "");
        if (forceFollowup || (Number.isFinite(shippedAt) && t - shippedAt >= cfg.followupDays * 86400000)) due.push("followup");
      }
      for (const type of due) { // in order: confirmation before shipping before follow-up
        if (o.emails?.[type]) continue;
        out.started.push(`${o.id}:${type}`);
        const r = await send(o.id, type, { qa, via: orderId ? (qa ? "qa-hook" : "event") : "sweeper" });
        out.results.push({ orderId: o.id, type, ...r });
      }
    }
    return out;
  }

  return {
    cfg,
    log,
    send,
    processDue,
    /** Kick processing for one order right after an event (paid / tracking); fire-and-forget. */
    kick(orderId) { if (orderId) processDue({ orderId }).catch(() => {}); },
    preview: (type, order, data) => renderEmail(type, order, { templates: registry, nameMap: loadNameMap(), data: data || {} }),
    start(intervalMs = 30000) {
      const hnd = setInterval(() => { processDue().catch(() => {}); }, intervalMs);
      hnd.unref?.();
      return hnd;
    },
  };
}

/** QA sample order for previews / screenshots (never stored). */
export function sampleOrder(type = "confirmation", now = new Date()) {
  const shippedAt = new Date(now.getTime() - (type === "followup" ? 7 : 0) * 86400000).toISOString();
  return {
    id: "BLR-1099", createdAt: now.toISOString(), status: "approved", paymentMethod: "card", winningProcessor: "umg", amount: "249.84", currency: "USD", test: true,
    customer: { first_name: "QA", last_name: "Test", email: "qa-test+emails@biolabsresearch.co", address: "12924 Pierce Street", city: "Pacoima", state: "CA", zip: "91331", country: "US" },
    items: [
      { sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 2, amount: "79.00" },
      { sku: "g3-r-10mg", name: "G3-R", qty: 1, amount: "85.00" },
      { sku: "research-solvent-10ml", name: "Research solvent 10mL", qty: 1, amount: "0.00" },
    ],
    priceCheck: { subtotal: "243.00", shipping: "18.99", shipMethod: "express", volumeDiscount: { pct: 5, merch: "243.00", discount: "12.15", merchAfter: "230.85" },
      lines: [{ sku: "bpc-157-10mg", qty: 2, unit: "79.00", line: "158.00" }, { sku: "g3-r-10mg", qty: 1, unit: "85.00", line: "85.00" }] },
    fulfillment: type === "confirmation" ? undefined : { status: "shipped", shippedAt, shippedBy: "rapid", carrier: "USPS RRD Priority", trackingNumber: "9400111899223197428490" },
    rapid: type === "confirmation" ? undefined : { shipMethod: "usps_rrd_priority" },
  };
}
