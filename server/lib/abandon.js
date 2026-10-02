import { formatAmount } from "./card.js";
import { capStr, stripSecrets } from "./sanitize.js";

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const ABANDON_MAX = 500;
export const ABANDON_RATE_MAX = 30;
export const ABANDON_RATE_WINDOW_MS = 60_000;
export const ABANDON_MAX_ITEMS = 50; // audit 2026-10-02: best-effort beacon, extra lines are dropped
export const ABANDON_DIGEST_TO = "admin@biolabsresearch.co";

const CARD_KEYS = new Set([
  "card",
  "pan",
  "cvv",
  "cvc",
  "cvv2",
  "cvc2",
  "expiry",
  "exp",
  "exp_month",
  "expmonth",
  "exp_year",
  "expyear",
  "expiration",
  "expiration_date",
  "expirationdate",
  "last4",
  "last_4",
  "card_number",
  "cardnumber",
  "card_num",
  "cardnum",
  "security_code",
  "securitycode",
]);

function looksLikePan(value) {
  return String(value || "").replace(/\D/g, "").length >= 13;
}

function paymentMethodHasCard(value) {
  if (!value || typeof value !== "object") return false;
  if (value.card || value.pan || value.last4 || value.last_4) return true;
  if (looksLikePan(value.number)) return true;
  const type = String(value.type || value.method || "").toLowerCase();
  return type === "card" || type === "credit_card" || type === "creditcard";
}

/**
 * Walk the payload. Any card / PAN / CVV / last4 / paymentMethod-with-card
 * field is forbidden on the abandon beacon — never persist.
 */
export function findForbiddenCardField(value, depth = 0) {
  if (value == null || depth > 8) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findForbiddenCardField(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (typeof value !== "object") return null;

  for (const [key, child] of Object.entries(value)) {
    const k = key.toLowerCase().replace(/[\s-]/g, "_");
    if (CARD_KEYS.has(k)) return key;
    if ((k === "number" || k === "account_number") && looksLikePan(child)) return key;
    if (k === "paymentmethod" || k === "payment_method") {
      if (paymentMethodHasCard(child)) return key;
    }
    if (child && typeof child === "object") {
      const hit = findForbiddenCardField(child, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

export function createRateLimiter(opts = {}) {
  const max = Number(opts.max) > 0 ? Number(opts.max) : ABANDON_RATE_MAX;
  const windowMs = Number(opts.windowMs) > 0 ? Number(opts.windowMs) : ABANDON_RATE_WINDOW_MS;
  const maxKeys = Number(opts.maxKeys) > 0 ? Number(opts.maxKeys) : 5000;
  const hits = new Map();

  return {
    max,
    windowMs,
    allow(ip) {
      const now = Date.now();
      // audit 2026-10-02: key length is capped and idle keys are swept, so a stream of forged addresses cannot grow the map forever.
      const key = String(ip || "unknown").slice(0, 64);
      if (hits.size > maxKeys) {
        for (const [k, ts] of hits) {
          if (!ts.length || now - ts[ts.length - 1] >= windowMs) hits.delete(k);
        }
      }
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (recent.length >= max) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
    reset() {
      hits.clear();
    },
    size() {
      return hits.size;
    },
  };
}

export function clientIp(req) {
  // audit 2026-10-02: X-Forwarded-For is client-controlled (nginx appends to what the client sent), so it is never read.
  // The module listens on 127.0.0.1 behind nginx, which overwrites X-Real-IP with $remote_addr, so that header is trustworthy.
  const h = req?.headers?.["x-real-ip"];
  const real = String((Array.isArray(h) ? h[0] : h) || "").trim().slice(0, 64);
  if (real) return real;
  return req?.socket?.remoteAddress || req?.connection?.remoteAddress || "unknown";
}

function readAddress(addr) {
  if (!addr) return "";
  if (typeof addr === "string") return addr;
  if (typeof addr !== "object") return "";
  return [addr.line1, addr.line2, addr.street, addr.address1, addr.address, addr.city]
    .filter(Boolean)
    .join(", ");
}

function readCustomer(raw, fallbackEmail) {
  const c = raw && typeof raw === "object" ? raw : {};
  const email = String(c.email || fallbackEmail || "").trim();
  return stripSecrets({
    first_name: capStr(c.first_name || c.firstName || "", 200),
    last_name: capStr(c.last_name || c.lastName || "", 200),
    email,
    phone: capStr(c.phone || c.phone_number || c.phoneNumber || "", 40),
    address: capStr(readAddress(c.address) || c.street || "", 300),
    city: capStr(c.city || c.address?.city || "", 200),
    state: capStr(c.state || c.address?.state || "", 200),
    zip: capStr(c.zip || c.postal_code || c.postalCode || c.address?.zip || "", 200),
    country: capStr(c.country || c.address?.country || "", 200),
  });
}

function itemAmount(row) {
  if (row.amount != null && row.amount !== "") return formatAmount(row.amount);
  if (row.price != null && row.price !== "") return formatAmount(row.price);
  if (row.unit_price != null && row.unit_price !== "") return formatAmount(row.unit_price);
  if (row.unitPrice != null && row.unitPrice !== "") return formatAmount(row.unitPrice);
  if (row.money && typeof row.money === "object" && row.money.amount != null) {
    return formatAmount(row.money.amount);
  }
  return formatAmount(0);
}

export function readItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, ABANDON_MAX_ITEMS).map((it) => {
    const row = it && typeof it === "object" ? it : {};
    const qty = Number(row.qty ?? row.quantity);
    return {
      sku: String(row.sku || row.id || row.product_id || "").trim().slice(0, 200),
      name: String(row.name || row.title || row.product_name || "").trim().slice(0, 200),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 1,
      amount: itemAmount(row),
    };
  });
}

function readSubtotal(input, items) {
  if (input.subtotal != null && input.subtotal !== "") return formatAmount(input.subtotal);
  if (input.amount != null && input.amount !== "") return formatAmount(input.amount);
  const sum = items.reduce((acc, it) => acc + (Number(it.amount) || 0) * (Number(it.qty) || 1), 0);
  return formatAmount(sum);
}

function readCoupon(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string" || typeof raw === "number") return String(raw);
  if (typeof raw === "object") {
    return {
      code: String(raw.code || raw.coupon || "").trim(),
      amount: raw.amount != null ? formatAmount(raw.amount) : null,
    };
  }
  return null;
}

/**
 * Beacon contract: missing/invalid session_id or email → silent drop (caller returns 204).
 * Card fields are a hard reject (caller returns 400).
 */
export function normalizeAbandonPayload(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, silent: true, reason: "invalid_body" };
  }

  const cardField = findForbiddenCardField(input);
  if (cardField) {
    return {
      ok: false,
      silent: false,
      error: "card_fields_not_accepted",
      status: 400,
      field: cardField,
      message: "Abandoned checkout capture never accepts card, PAN, CVV, CVC, expiry, last4, or paymentMethod card data.",
    };
  }

  const sessionId = String(input.session_id || input.sessionId || "").trim();
  if (!sessionId) {
    return { ok: false, silent: true, reason: "session_id_required" };
  }

  const email = String(input.customer?.email || input.email || "").trim();
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) {
    return { ok: false, silent: true, reason: "invalid_email" };
  }

  const items = readItems(input.items);
  const customer = readCustomer(input.customer, email);
  customer.email = email;

  return {
    ok: true,
    record: {
      session_id: sessionId,
      stage: String(input.stage || "").trim(),
      customer,
      items,
      subtotal: readSubtotal(input, items),
      coupon: readCoupon(input.coupon),
      client_timestamp: input.timestamp || input.client_timestamp || null,
    },
  };
}

export function upsertAbandonedLead(store, record, nowIso = new Date().toISOString()) {
  return store.upsertAbandonedCheckout({ ...record, last_seen: nowIso, seen_at: nowIso });
}

export function markConvertedBySession(store, sessionId, meta = {}) {
  const sid = String(sessionId || "").trim();
  if (!sid || typeof store.markAbandonedConverted !== "function") return null;
  return store.markAbandonedConverted(sid, meta);
}

export function itemsSummary(items) {
  if (!Array.isArray(items) || items.length === 0) return "—";
  return items
    .map((it) => {
      const qty = it.qty ?? it.quantity ?? 1;
      const name = it.name || it.title || it.sku || "item";
      return `${qty}× ${name}`;
    })
    .join(", ");
}

export function formatAbandonedDigest(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && r.status !== "converted") : [];
  const lines = list.slice(0, 50).map((r) => {
    const c = r.customer || {};
    const name = [c.first_name, c.last_name].filter(Boolean).join(" ") || "—";
    return `  - ${name} <${c.email || ""}> · ${r.subtotal || "0.00"} · ${r.stage || "—"} · ${itemsSummary(r.items)}`;
  });
  const text = [
    "Daily abandoned-checkout digest (first-party RUO / Quote leads — not payments).",
    "",
    `Open leads: ${list.length}`,
    "",
    ...(lines.length ? lines : ["  (none)"]),
    "",
    "Card data is never stored. Reply from CRM; do not request PAN/CVV.",
  ].join("\n");
  return {
    to: ABANDON_DIGEST_TO,
    subject: `Abandoned checkout digest — ${list.length} open lead${list.length === 1 ? "" : "s"}`,
    text,
  };
}

export function isAbandonDigestEnabled(env = process.env) {
  const v = String(env.ABANDON_DIGEST_ENABLED ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

async function defaultDigestTransport(message) {
  const url = process.env.MAIL_WEBHOOK_URL || process.env.CIO_TRANSACTIONAL_URL || "";
  const token = process.env.MAIL_WEBHOOK_TOKEN || process.env.CIO_API_KEY || "";
  if (!url) {
    return { ok: true, queued: true, transport: "none" };
  }
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      to: message.to,
      subject: message.subject,
      text: message.text,
      transactional: true,
    }),
  });
  if (!res.ok) {
    const err = new Error("mail_webhook_failed");
    err.status = res.status;
    throw err;
  }
  return { ok: true, queued: false, transport: "webhook" };
}

export async function sendAbandonedDigest(store, transport = defaultDigestTransport) {
  if (!isAbandonDigestEnabled()) {
    return { skipped: true, reason: "digest_disabled" };
  }
  const rows = typeof store.listAbandonedCheckouts === "function" ? store.listAbandonedCheckouts() : [];
  const openCount = rows.filter((r) => r.status !== "converted").length;
  const message = formatAbandonedDigest(rows);
  try {
    const sent = await transport(message);
    if (typeof store.touchAbandonedDigest === "function") store.touchAbandonedDigest();
    return { ok: true, queued: Boolean(sent?.queued), transport: sent?.transport || "custom", count: openCount };
  } catch {
    return { ok: false, error: "digest_failed", count: openCount };
  }
}
