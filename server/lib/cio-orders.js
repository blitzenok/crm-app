// 2026-10-01: order emails through Customer.io transactional messages (replaces the dead noreply@ SMTP route).
// Flags: CIO_ORDER_EMAILS_INTERNAL=on  -> order-manager (ID 2) to CIO_ORDER_MANAGER_TO, allowlisted recipients only.
//        CIO_ORDER_EMAILS_CUSTOMER=on  -> order-customer (3), order-paid (4, crypto), order-shipped (5) to the buyer.
// Customer stays OFF until Legal approves the templates. While it is off, customer messages are recorded as
// "skipped_customer_off" so that switching it on later never mails a backlog. Only orders created after
// CIO_ORDER_EMAILS_SINCE (default: process start) are looked at. Never logs the API key, the email or the address.
import { orderTotals, loadNameMap, emailGuard } from "./email-templates.js";
import { isPaidOrder } from "./rapid-orders.js";
import { isDryRunOrder } from "./store-forward.js";
import { humanUseBlocks } from "./human-use.js";

export const CIO_IDS = { manager: 2, customer: 3, paid: 4, shipped: 5, in_transit: 6, delivered: 7 };
const EMAIL_RE = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;
const EXTRA_ALLOWED = new Set(["laquica1980@gmail.com", "y0505300530@gmail.com"]);
export function internalAllowed(addr) {
  const a = String(addr || "").trim().toLowerCase();
  return EMAIL_RE.test(a) && (a.endsWith("@biolabsresearch.co") || EXTRA_ALLOWED.has(a));
}
const mask = (e) => { const s = String(e || ""); const at = s.indexOf("@"); return at > 0 ? `${s[0]}***${s.slice(at)}` : "***"; };

export function cioConfig(env = process.env) {
  const since = Date.parse(env.CIO_ORDER_EMAILS_SINCE || "");
  return {
    key: String(env.CUSTOMERIO_APP_API_KEY || "").trim(),
    url: env.CIO_SEND_URL || "https://api.customer.io/v1/send/email",
    internal: String(env.CIO_ORDER_EMAILS_INTERNAL || "").toLowerCase() === "on",
    customer: String(env.CIO_ORDER_EMAILS_CUSTOMER || "").toLowerCase() === "on",
    managerTo: String(env.CIO_ORDER_MANAGER_TO || "admin@biolabsresearch.co").split(",").map((s) => s.trim()).filter(Boolean),
    from: env.CIO_FROM || "BioLabs Research <admin@biolabsresearch.co>",
    since: Number.isFinite(since) ? since : null,
  };
}

const d2 = (c) => (c == null ? "" : (c / 100).toFixed(2));
const SHIP_LABEL = { express: "Express", ground: "Ground", standard: "Standard", fedex_2d: "FedEx 2Day", fedex_2d_env: "FedEx 2Day" };
function addressLine(c = {}) {
  return [c.address, c.address2, c.city, [c.state, c.zip].filter(Boolean).join(" "), c.country].map((x) => String(x || "").trim()).filter(Boolean).join(", ");
}

/** message_data (template variables are trigger.*) for one order. */
export function buildTrigger(order, nameMap = loadNameMap()) {
  const t = orderTotals(order, nameMap);
  const c = order.customer || {};
  const pc = order.priceCheck || {};
  const unknown = (order.items || []).filter((it) => !nameMap[String(it.sku || "").toLowerCase()]).map((it) => String(it.sku || it.name || "item"));
  const vd = pc.volumeDiscount;
  const cd = !vd && pc.discount && String(pc.discount.source || "").startsWith("coupon:") ? pc.discount : null;
  const paid = isPaidOrder(order);
  const f = order.fulfillment || {};
  return {
    ref: order.orderRef || order.id,
    first_name: String(c.first_name || c.firstName || "").trim(),
    customer_name: [c.first_name || c.firstName, c.last_name || c.lastName].filter(Boolean).join(" "),
    customer_email: String(c.email || ""),
    placed_at: order.createdAt || new Date().toISOString(),
    payment_state: paid ? "paid" : order.paymentMethod === "crypto" ? "crypto_pending" : "review",
    paid_via: order.paymentMethod === "crypto" ? "crypto" : "card",
    items: t.lines.map((l) => ({ name: l.name, mg: l.strength, qty: l.qty, price: d2(l.lineCents) })),
    totals_available: Boolean(t.reconciled),
    subtotal_server: d2(t.subtotalCents),
    shipping_server: d2(t.shippingCents),
    discount_server: t.discount ? d2(t.discount.cents) : "0.00",
    discount_pct_server: t.discount ? t.discount.pct : 0,
    discount_source: pc.discount?.source && pc.discount.source !== "none" ? String(pc.discount.source) : vd ? `tier:${({ 5: 100, 10: 250, 15: 500 })[vd.pct] || ""}` : "",
    total_due_server: d2(t.totalCents),
    coupon: String(order.coupon || pc.coupon || ""),
    shipping_address: addressLine(c),
    shipping_method: SHIP_LABEL[t.shipMethod] || (t.shipMethod ? t.shipMethod : ""),
    unknown_items: unknown.join(", "),
    needs_review: !t.reconciled || unknown.length > 0,
    carrier: f.carrier || "",
    tracking_number: f.trackingNumber || "",
    tracking_url: f.trackingUrl || "",
  };
}

/** One transactional send. Returns { ok, status, deliveryId?, httpStatus?, error? }. */
export async function cioSend(cfg, { messageId, to, data, fetchImpl = fetch, timeoutMs = 15000 }) {
  if (!cfg.key) return { ok: false, status: "no_api_key" };
  if (!EMAIL_RE.test(String(to || ""))) return { ok: false, status: "no_recipient" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(cfg.url, {
      method: "POST", signal: ctl.signal,
      headers: { Authorization: `Bearer ${cfg.key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ transactional_message_id: messageId, to, from: cfg.from, identifiers: { email: to }, message_data: data }),
    });
    const body = await r.json().catch(() => ({}));
    if (r.ok) return { ok: true, status: "sent", httpStatus: r.status, deliveryId: body.delivery_id || null, queuedAt: body.queued_at || null };
    const err = String(body?.meta?.error || body?.error || body?.errors?.[0]?.message || r.statusText || "error").slice(0, 160);
    return { ok: false, status: "failed", httpStatus: r.status, error: err };
  } catch (e) {
    return { ok: false, status: "failed", error: String(e?.name === "AbortError" ? "timeout" : e?.message || e).slice(0, 120) };
  } finally { clearTimeout(timer); }
}

/** createCioOrderNotifier({ db, cfg, fetchImpl, now, logger }) -> { cfg, kick(orderId), processDue(), start(ms) } */
export function createCioOrderNotifier(opts = {}) {
  const db = opts.db;
  const cfg = opts.cfg || cioConfig();
  const now = opts.now || (() => new Date());
  const say = opts.logger || ((m) => process.stdout.write(`${m}\n`));
  const sinceMs = cfg.since ?? now().getTime();
  const busy = new Set();

  function record(order, kind, state) {
    const fresh = db.getOrder(order.id) || order;
    fresh.cio = { ...(fresh.cio || {}), [kind]: { ...state, at: now().toISOString() } };
    db.upsertOrder(fresh);
  }
  const hasTracking = (o) => o.fulfillment?.status === "shipped" && Boolean(o.fulfillment?.trackingNumber);

  async function sendKind(o, kind, data) {
    if (kind === "manager") {
      if (!cfg.internal) return; // not recorded: switching internal on later only mails orders after CIO_ORDER_EMAILS_SINCE
      const to = cfg.managerTo.filter(internalAllowed);
      const results = [];
      for (const addr of to) results.push({ to: mask(addr), ...(await cioSend(cfg, { messageId: CIO_IDS.manager, to: addr, data, fetchImpl: opts.fetchImpl })) });
      const ok = results.some((r) => r.ok);
      record(o, kind, { status: ok ? "sent" : results.length ? "failed" : "no_allowed_recipient", results });
      say(`[cio] manager ${o.id}: ${results.map((r) => `${r.to} ${r.status}${r.httpStatus ? ` ${r.httpStatus}` : ""}`).join(", ") || "no allowed recipient"}`);
      return;
    }
    if (!cfg.customer) { record(o, kind, { status: "skipped_customer_off" }); return; }
    if (humanUseBlocks(o)) { record(o, kind, { status: "skipped_compliance_hold" }); return; }
    const guard = emailGuard({ subject: "", text: data.items.map((i) => i.name).join("\n") });
    if (guard.length) { record(o, kind, { status: "blocked_guard", blocked: guard }); say(`[cio] ${kind} ${o.id}: blocked by guard`); return; }
    const r = await cioSend(cfg, { messageId: CIO_IDS[kind], to: data.customer_email, data, fetchImpl: opts.fetchImpl });
    record(o, kind, r);
    say(`[cio] ${kind} ${o.id} -> ${mask(data.customer_email)}: ${r.status}${r.httpStatus ? ` ${r.httpStatus}` : ""}`);
  }

  async function processOrder(o) {
    if (!o || busy.has(o.id)) return;
    if (Date.parse(o.createdAt || 0) < sinceMs || isDryRunOrder(o)) return;
    busy.add(o.id);
    try {
      const data = buildTrigger(o);
      const due = ["manager", "customer"];
      if (isPaidOrder(o) && o.paymentMethod === "crypto") due.push("paid");
      if (isPaidOrder(o) && hasTracking(o)) due.push("shipped");
      for (const kind of due) {
        const cur = db.getOrder(o.id) || o;
        if (cur.cio?.[kind]) continue;
        if (kind === "manager" && !cfg.internal) continue;
        await sendKind(cur, kind, data);
      }
    } catch (e) {
      say(`[cio] ${o.id} error: ${String(e?.message || e).slice(0, 120)}`);
    } finally { busy.delete(o.id); }
  }

  async function processDue() { for (const o of db.listOrders()) await processOrder(o); }
  return {
    cfg: { internal: cfg.internal, customer: cfg.customer, keySet: Boolean(cfg.key), managerTo: cfg.managerTo.filter(internalAllowed).map(mask), since: new Date(sinceMs).toISOString() },
    kick(orderId) { if (orderId) processOrder(db.getOrder(orderId)).catch(() => {}); },
    processDue,
    start(intervalMs = 60000) { const h = setInterval(() => { processDue().catch(() => {}); }, intervalMs); h.unref?.(); return h; },
  };
}
