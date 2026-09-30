/**
 * Approved card orders -> legacy shop order service (products-api notify-order).
 *
 * Why: the CRM "Store Orders" tab and the Customer.io transactional order emails (manager + customer)
 * live behind POST /msolpeptides-api/notify-order on 127.0.0.1:4000. The storefront calls it for
 * crypto/quote orders but not after a card charge, so card orders never reached the CRM or the customer.
 *
 * Rules:
 *  - Only real approved orders (status "approved"), never dry-run / test orders unless forced by staff.
 *  - Once per order: order.storeForward.sentAt is the guard; notify-order is also idempotent by ref.
 *  - Never blocks or fails the charge response: callers fire-and-forget; failures are logged and retried
 *    by the sweep with backoff.
 *  - Totals are recomputed by notify-order from the catalog (subtotal_server / price_mismatch).
 *  - No card data leaves here (the order never holds any; stripSecrets already ran at charge time).
 */

import { orderAttribution } from "./order-attribution.js"; // infra 2026-09-30 order-attribution
export const DEFAULT_FORWARD_URL = "http://127.0.0.1:4000/msolpeptides-api/notify-order";
export const CARD_PAYMENT_METHOD = "card-umg";
export const CARD_STATEMENT_DESCRIPTOR = "PEPTIDESS SHOP";
export const CLEFFO_PAYMENT_METHOD = "card-cleffo";
const MAX_ATTEMPTS = 20;

function nowIso() {
  return new Date().toISOString();
}

function money(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

/** "bpc-157-10mg" -> { slug: "bpc-157", mg: "10mg" } (storefront builds sku = slug + "-" + mg). */
export function splitSku(sku) {
  const s = String(sku || "").trim();
  const m = s.match(/^(.+?)-(\d+(?:\.\d+)?(?:mg|mcg|g|iu|ml))$/i);
  if (m) return { slug: m[1].toLowerCase(), mg: m[2].toLowerCase() };
  return { slug: /^[a-z0-9-]{1,64}$/i.test(s) ? s.toLowerCase() : "", mg: "" };
}

export function isDryRunOrder(order) {
  if (!order) return true;
  if (order.dryRun === true || order.test === true) return true;
  const key = String(order.idempotencyKey || "");
  if (/^DRY-/i.test(key)) return true;
  if (String(order.descriptor || "").toUpperCase().includes("STUB")) return true;
  return false;
}

export function isForwardable(order) {
  return Boolean(order) && String(order.status || "").toLowerCase() === "approved";
}

// infra 2026-09-29 honest-charge: one note line for whatever discount the charged amount includes (coupon or ladder).
function discountNote(pc) {
  const d = pc && pc.discount;
  if (d && Number(d.amount) > 0) {
    const code = String(d.source || "").startsWith("coupon:") ? String(d.source).slice(7) : "";
    return code
      ? `coupon ${code} ${d.pct}% (−$${d.amount}) included in total`
      : `volume discount ${d.pct}% (−$${d.amount}) included in total`;
  }
  return pc && pc.volumeDiscount ? `volume discount ${pc.volumeDiscount.pct}% (−$${pc.volumeDiscount.discount}) included in total` : "";
}

export function buildNotifyPayload(order, opts = {}) {
  const c = order.customer || {};
  const items = (Array.isArray(order.items) ? order.items : []).slice(0, 50).map((it) => {
    const { slug, mg } = splitSku(it.sku);
    const qty = Math.min(999, Math.max(1, parseInt(it.qty ?? it.quantity, 10) || 1));
    const price = Number(it.amount ?? it.price);
    return {
      slug,
      name: String(it.name || it.sku || "item").slice(0, 120),
      mg: mg || String(it.mg || "").slice(0, 20),
      qty,
      price: Number.isFinite(price) && price >= 0 ? Number(price.toFixed(2)) : 0,
    };
  });
  // Server-priced orders: forward the catalog line prices and the charged amount, never the browser's figures.
  const pc = order.priceCheck && Array.isArray(order.priceCheck.lines) ? order.priceCheck : null;
  if (pc && pc.lines.length === items.length) {
    pc.lines.forEach((l, i) => {
      const unit = Number(l.unit);
      if (Number.isFinite(unit)) items[i].price = Number(unit.toFixed(2));
      if (!items[i].slug && l.slug) items[i].slug = l.slug;
      if (!items[i].mg && l.mg) items[i].mg = l.mg;
    });
  }
  const total = Number(order.amount) || 0;
  const subtotal = pc && Number.isFinite(Number(pc.subtotal)) ? Number(pc.subtotal) : items.reduce((a, i) => a + i.price * i.qty, 0);
  const shippingCost = pc && Number.isFinite(Number(pc.shipping))
    ? Number(pc.shipping)
    : Math.max(0, Math.round((total - subtotal) * 100) / 100);
  const ref = String(order.id || "").slice(0, 64);
  const name = [c.first_name, c.last_name].filter(Boolean).join(" ");
  const addr = [c.address, c.city, c.state, c.zip, c.country].filter(Boolean).join(", ");
  const tag = opts.test ? "[TEST] " : opts.backfill ? "[BACKFILL] " : "";
  // Cleffo (hosted page) orders: own payment method label; the statement descriptor line only when it is known
  // (CLEFFO_DESCRIPTOR confirmed) — never the UMG descriptor.
  const isCleffo = order.winningProcessor === "cleffo";
  const payMethod = isCleffo ? CLEFFO_PAYMENT_METHOD : CARD_PAYMENT_METHOD;
  const descriptor = isCleffo ? (order.descriptor || null) : (order.descriptor || CARD_STATEMENT_DESCRIPTOR);
  const noteParts = [
    `${tag}Card payment APPROVED via ${order.winningProcessor || "umg"}`,
    order.winningTxnId ? `processor txn ${order.winningTxnId}` : "",
    descriptor ? `card statement shows: ${descriptor}` : "card statement descriptor: not confirmed yet",
    discountNote(order.priceCheck),
    order.notes ? `customer notes: ${String(order.notes).slice(0, 800)}` : "",
  ].filter(Boolean);
  const lines = items.map((i) => `${i.qty}x ${i.name}${i.mg ? ` ${i.mg}` : ""} @ $${money(i.price)}`);
  const body = [
    `Order ${ref} — card (approved)`,
    `Customer: ${name} <${c.email || ""}> ${c.phone || ""}`,
    `Ship to: ${addr}`,
    ...lines,
    `Total charged: $${money(total)} ${order.currency || "USD"}`,
    descriptor ? `Your card statement will show: ${descriptor}` : "",
  ].filter(Boolean).join("\n");
  return {
    subject: `${tag}Order ${ref} [${payMethod}] — $${money(total)}`,
    body,
    paymentMethod: payMethod,
    orderData: {
      ref,
      type: "order",
      customer: {
        firstName: c.first_name || "",
        lastName: c.last_name || "",
        email: c.email || "",
        phone: c.phone || "",
      },
      shipping: {
        address1: c.address || "",
        city: c.city || "",
        state: c.state || "",
        zip: c.zip || "",
        country: c.country || "",
        cost: money(shippingCost),
      },
      items,
      // infra 2026-09-29 honest-charge: products-api applies the coupon itself (total_due_server), so CRM matches the charge
      coupon: pc && pc.coupon ? String(pc.coupon).slice(0, 40) : "",
      subtotal: money(subtotal),
      shippingCost: money(shippingCost),
      total: money(total),
      paymentMethod: payMethod,
      notes: noteParts.join(" · "),
      timestamp: order.createdAt || nowIso(),
      ...orderAttribution(order), // infra 2026-09-30 order-attribution: the stored trail goes to the CRM order
      tc_accepted: true,
    },
  };
}

function backoffMs(attempts) {
  return Math.min(60 * 60 * 1000, 60 * 1000 * 2 ** Math.max(0, attempts - 1));
}

/**
 * Forward one order. Returns { ok, skipped?, reason? }. Never throws.
 * opts.force: staff override (allows test / dry-run orders; still once per order).
 */
export async function forwardOrder(store, orderId, opts = {}) {
  const order = store.getOrder(orderId);
  if (!order) return { ok: false, reason: "not_found" };
  if (!isForwardable(order)) return { ok: false, skipped: true, reason: "not_approved" };
  if (order.storeForward?.sentAt) return { ok: true, skipped: true, reason: "already_sent", ref: order.storeForward.ref };
  if (!opts.force && isDryRunOrder(order)) return { ok: false, skipped: true, reason: "dry_run_or_test" };
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const url = opts.url || process.env.STORE_FORWARD_URL || DEFAULT_FORWARD_URL;
  const payload = buildNotifyPayload(order, { test: order.test === true || order.dryRun === true });
  const prev = order.storeForward || {};
  const attempts = (prev.attempts || 0) + 1;
  let result;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { data = null; }
    if (res.ok && data && data.ok) {
      result = { ok: true, ref: data.ref || payload.orderData.ref, duplicate: Boolean(data.duplicate) };
    } else {
      result = { ok: false, reason: `http_${res.status}` };
    }
  } catch (err) {
    result = { ok: false, reason: err?.name === "TimeoutError" ? "timeout" : "network_error" };
  }
  const fresh = store.getOrder(orderId) || order;
  const at = nowIso();
  fresh.storeForward = result.ok
    ? { sentAt: at, ref: result.ref, duplicate: result.duplicate, attempts, via: opts.via || "auto" }
    : {
        sentAt: null,
        attempts,
        lastError: result.reason,
        lastTriedAt: at,
        nextAttemptAt: attempts >= MAX_ATTEMPTS ? null : new Date(Date.now() + backoffMs(attempts)).toISOString(),
        gaveUp: attempts >= MAX_ATTEMPTS,
      };
  store.upsertOrder(fresh);
  const log = opts.logger || console;
  if (result.ok) log.log?.(`[store-forward] ${fresh.id} -> notify-order ok${result.duplicate ? " (duplicate)" : ""}`);
  else log.error?.(`[store-forward] ${fresh.id} failed (${result.reason}), attempt ${attempts}`);
  return result;
}

/** Retry sweep: approved, real, not yet sent, created on/after `since`, backoff respected. */
export async function sweepForward(store, opts = {}) {
  const since = opts.since || process.env.STORE_FORWARD_SINCE || "";
  const now = Date.now();
  const out = [];
  for (const o of store.listOrders()) {
    if (!isForwardable(o) || isDryRunOrder(o) || o.storeForward?.sentAt || o.storeForward?.gaveUp) continue;
    if (!since || String(o.createdAt || "") < since) continue;
    const next = o.storeForward?.nextAttemptAt ? Date.parse(o.storeForward.nextAttemptAt) : 0;
    if (next && next > now) continue;
    out.push({ id: o.id, ...(await forwardOrder(store, o.id, { ...opts, via: "sweep" })) });
  }
  return out;
}

export function startForwardSweeper(store, { intervalMs = 60000, ...opts } = {}) {
  const timer = setInterval(() => {
    sweepForward(store, opts).catch(() => {});
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
