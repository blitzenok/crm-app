// Side effects of the crypto verifier that leave the box: customer email (cancel), internal alerts, GA4 server purchase.
// All of them are best-effort: a failure is recorded on the order and logged, never changes the payment state.
import { createHash } from "node:crypto";

import { registerEmailType } from "./order-emails.js";
import { h } from "./email-templates.js";
import { logSafe } from "./sanitize.js";

export const SUPPORT_FROM = "support@biolabsresearch.co"; // the order emailer sends every customer email From support@
export const CANCEL_SUBJECT = "Payment not received, order cancelled";
export const CANCEL_EMAIL_TYPE = "payment_cancelled";

const PAY_ALERT_TYPES = new Set(["verified_awaiting_admin", "customer_tx_submitted", "sanctions_match", "unmatched_deposit", "partial_payment"]);

const netLabel = (n) => (n === "trc20" ? "Tron (TRC-20)" : n === "erc20" ? "Ethereum (ERC-20)" : "crypto");

// Customer email through the order-email helper (docs/ORDER_EMAILS.md): layout, RUO footer, compliance guard,
// SMTP gate, retries, log and per-order idempotency come with it. No product names in this email.
registerEmailType(CANCEL_EMAIL_TYPE, {
  subject: (order) => `${CANCEL_SUBJECT} (${order.id})`,
  preheader: () => "We did not receive the crypto payment in time, so the order was cancelled.",
  blocks: (order, ctx) => {
    const cp = order.cryptoPayment || {};
    return [
      h.heading(CANCEL_SUBJECT),
      h.p(`We did not receive the ${cp.payAmount || order.amountDue || order.amount} ${cp.token || "USDT"} payment on ${netLabel(cp.network)} for order ${order.orderRef ? `${order.id} (${order.orderRef})` : order.id} within ${ctx.data?.minutes || 60} minutes, so the order was cancelled automatically.`),
      h.p("If you already sent the payment, please do not send it again. Reply to this email with the transaction hash and our team will review it manually."),
      h.p("You are welcome to place a new order at any time."),
    ];
  },
});

/**
 * Cancel email. `orderEmailer` is the handler's emailer (createOrderEmailer): send(orderId, type, {data, via}).
 * Without one (unit tests / emailer not wired) the send is recorded as skipped_disabled.
 */
export async function sendCancelEmail(order, deps = {}) {
  const at = new Date().toISOString();
  // 2026-09-30 launch: CRYPTO_CANCEL_EMAIL_ENABLED=false (live) -> an expired / unpaid crypto order never emails the customer.
  if ((deps.env || process.env).CRYPTO_CANCEL_EMAIL_ENABLED === "false") {
    process.stdout.write(`[crypto] cancel email for ${order.id}: skipped (CRYPTO_CANCEL_EMAIL_ENABLED=false)\n`);
    return { status: "skipped_no_customer_email_for_unpaid", at };
  }
  const emailer = deps.orderEmailer;
  if (!emailer || typeof emailer.send !== "function") {
    process.stdout.write(`[crypto] cancel email for ${order.id}: skipped_disabled (no order emailer)\n`);
    return { status: "skipped_disabled", at };
  }
  try {
    const r = await emailer.send(order.id, CANCEL_EMAIL_TYPE, { data: { minutes: deps.minutes || 60 }, via: "crypto-timeout" });
    return { status: r?.status || (r?.ok ? "sent" : "failed"), at, ...(r?.messageId ? { messageId: r.messageId } : {}) };
  } catch (err) {
    return { status: "failed", at, error: String(err?.message || err).slice(0, 200) };
  }
}

/** Internal alert: [crypto] ALERT log line (journal) + the CRM alert list (GET /api/crypto/alerts). */
export async function sendInternalAlert(alert) {
  process.stdout.write(`[crypto] ALERT ${alert.type} ${alert.orderId || "-"} ${alert.message || ""}\n`);
  // audit 2026-10-02 (pay-cleffo-crypto-2): ops-watch only reads [pay-alert] lines, so these never reached Telegram and a paid crypto
  // order waited for a staff member to open Crypto Orders by chance. Only the cases that need an operator now.
  if (PAY_ALERT_TYPES.has(alert.type)) {
    process.stdout.write(`[pay-alert] CRYPTO_${String(alert.type).toUpperCase()} ${logSafe(alert.orderId || "-", 40)} ${logSafe(alert.message, 160)}\n`);
  }
  return { status: "logged" };
}

// ---- GA4 Measurement Protocol (server-side purchase for on-chain verified crypto orders) ----------------------
export function ga4Config(env = process.env) {
  return {
    enabled: env.GA4_SERVER_PURCHASE_ENABLED === "true",
    measurementId: String(env.GA4_MEASUREMENT_ID || "G-KCMPHP783M").trim(), // storefront gtag stream (GA4 property 552249403)
    apiSecret: String(env.GA4_API_SECRET || "").trim(),
    endpoint: String(env.GA4_MP_URL || "https://www.google-analytics.com/mp/collect"),
  };
}

function pseudoClientId(order) {
  const h = createHash("sha256").update(`blr-crypto:${order.orderRef || order.id}`).digest();
  return `${h.readUInt32BE(0)}.${h.readUInt32BE(4)}`;
}

/** Payload with catalog codes only (Legal: no item_name / product names). Unmapped lines are left out. */
export function ga4PurchasePayload(order, { skuMap = {} } = {}) {
  const lines = Array.isArray(order.priceCheck?.lines) ? order.priceCheck.lines : [];
  const items = [];
  for (const it of order.items || []) {
    const sku = String(it.sku || "").toLowerCase();
    const m = skuMap[sku];
    if (!m || !m.product_id || m.gift) continue;
    const pl = lines.find((l) => String(l.sku || "").toLowerCase() === sku);
    const qty = Number(it.qty) || 1;
    const unit = pl && pl.unit != null ? Number(pl.unit) : undefined;
    items.push({ item_id: String(m.product_id), quantity: qty, ...(Number.isFinite(unit) ? { price: unit } : {}) });
  }
  const clientId = /^\d+\.\d+$/.test(String(order.gaClientId || "")) ? order.gaClientId : pseudoClientId(order);
  return {
    client_id: clientId,
    non_personalized_ads: true,
    events: [{
      name: "purchase",
      params: {
        transaction_id: order.orderRef || order.id,
        value: Number(order.amount) || 0,
        currency: "USD",
        payment_type: `crypto_${String(order.cryptoPayment?.token || "usdt").toLowerCase()}_${order.cryptoPayment?.network || "unknown"}`,
        ...(items.length ? { items } : {}),
      },
    }],
  };
}

export async function sendGa4Purchase(order, { env = process.env, fetchImpl = globalThis.fetch, skuMap = {} } = {}) {
  const cfg = ga4Config(env);
  const at = new Date().toISOString();
  if (!cfg.enabled) return { status: "skipped_disabled", at };
  if (order.test === true) return { status: "skipped_test_order", at };
  if (order.cryptoPayment?.ga4?.status === "sent") return { status: "skipped_already_sent", at: order.cryptoPayment.ga4.at || at }; // once per order
  if (!cfg.apiSecret || !cfg.measurementId) return { status: "skipped_missing_api_secret", at };
  const url = `${cfg.endpoint}?measurement_id=${encodeURIComponent(cfg.measurementId)}&api_secret=${encodeURIComponent(cfg.apiSecret)}`;
  try {
    const res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(ga4PurchasePayload(order, { skuMap })) });
    return { status: res.ok || res.status === 204 ? "sent" : `failed_http_${res.status}`, at };
  } catch (err) {
    return { status: "failed", at, error: String(err.message).slice(0, 120) };
  }
}
