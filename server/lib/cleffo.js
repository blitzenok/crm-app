/**
 * Cleffo hosted payment-link adapter (https://apis.cleffo.com/integration-guide, v1.0).
 *
 *  POST {base}/api/payment-link                     headers x-api-key + x-signature (HMAC-SHA256 hex of the exact body)
 *  GET  {base}/api/payment-link/{ref}/status        header  x-api-key       -> payment_status completed | pending | failed
 *
 * Cleffo documents no signed callback: the customer comes back on metadata.redirect_url. So the redirect is never
 * trusted: it carries our own HMAC token (order id + link ref) and the order is only settled after the status API
 * says so, with amount / currency / merchant_order_id matching the order.
 *
 * Keys: process.env first, then the env file (CLEFFO_ENV_PATH, default /etc/crm-umg/cleffo.env, mode 600). The file
 * may hold both sets as CLEFFO_SANDBOX_* and CLEFFO_LIVE_*; CLEFFO_ENV (sandbox | live, default sandbox) picks one.
 * Key values are never logged, returned or stored on orders.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

export const id = "cleffo";
export const label = "Cleffo";
export const DEFAULT_ENV_PATH = "/etc/crm-umg/cleffo.env";
export const BASE_URLS = Object.freeze({ sandbox: "https://apis-dev.cleffo.com", live: "https://apis.cleffo.com" });
const DEFAULT_TIMEOUT_MS = 15000;
const KEY_NAMES = ["CLEFFO_BASE_URL", "CLEFFO_CLIENT_KEY", "CLEFFO_SIGNATURE_KEY", "CLEFFO_API_KEY"];

function parseEnvFile(raw) {
  const out = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith("\"") && v.endsWith("\"")) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[t.slice(0, eq).trim()] = v;
  }
  return out;
}

export function cleffoEnvName(env = process.env) {
  return String(env.CLEFFO_ENV || "sandbox").trim().toLowerCase() === "live" ? "live" : "sandbox";
}

/** Resolve { env, baseUrl, clientKey, signatureKey, apiKey, source } for the active CLEFFO_ENV. */
export function loadCleffoConfig(env = process.env, opts = {}) {
  const name = opts.envName || cleffoEnvName(env);
  const prefix = name === "live" ? "CLEFFO_LIVE_" : "CLEFFO_SANDBOX_";
  const path = opts.envPath !== undefined ? opts.envPath : (env.CLEFFO_ENV_PATH || DEFAULT_ENV_PATH);
  let file = {};
  if (opts.fileValues) file = opts.fileValues;
  else if (path && existsSync(path)) {
    try { file = parseEnvFile(readFileSync(path, "utf8")); } catch { file = {}; }
  }
  const pick = (k) => {
    const short = k.replace(/^CLEFFO_/, "");
    return env[`${prefix}${short}`] || file[`${prefix}${short}`] || env[k] || file[k] || "";
  };
  const cfg = {
    env: name,
    baseUrl: String(pick("CLEFFO_BASE_URL") || BASE_URLS[name]).replace(/\/+$/, ""),
    clientKey: pick("CLEFFO_CLIENT_KEY"),
    signatureKey: pick("CLEFFO_SIGNATURE_KEY"),
    apiKey: pick("CLEFFO_API_KEY"),
    envPath: path || null,
  };
  // A sandbox config must never point at production (and the reverse), whatever the file says.
  cfg.baseUrlMismatch = name === "sandbox" ? /\/\/apis\.cleffo\.com/i.test(cfg.baseUrl) : /apis-dev\./i.test(cfg.baseUrl);
  return cfg;
}

/** Booleans only — safe for health / settings responses. */
export function cleffoKeyHealth(cfg) {
  return {
    env: cfg.env,
    baseUrl: cfg.baseUrl,
    clientKeyConfigured: Boolean(cfg.clientKey),
    signatureKeyConfigured: Boolean(cfg.signatureKey),
    apiKeyConfigured: Boolean(cfg.apiKey),
    baseUrlMismatch: Boolean(cfg.baseUrlMismatch),
    ready: Boolean(cfg.clientKey && cfg.signatureKey && cfg.apiKey && !cfg.baseUrlMismatch),
  };
}

export function signBody(rawBody, signatureKey) {
  return createHmac("sha256", String(signatureKey)).update(String(rawBody), "utf8").digest("hex");
}

/** Constant-time check of a hex HMAC-SHA256 over the exact raw body (x-signature style). */
export function verifySignature(rawBody, signature, signatureKey) {
  if (!signatureKey || !signature) return false;
  const want = Buffer.from(signBody(rawBody, signatureKey), "hex");
  let got;
  try { got = Buffer.from(String(signature).trim().toLowerCase(), "hex"); } catch { return false; }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Our own token on redirect_url: binds the order id + attempt number to the signature key. */
export function returnToken(orderId, attemptNo, signatureKey) {
  const k = createHmac("sha256", String(signatureKey || "")).update("crm-cleffo-return-v1").digest();
  return createHmac("sha256", k).update(`${orderId}|${attemptNo}`).digest("hex").slice(0, 32);
}

export function verifyReturnToken(orderId, attemptNo, token, signatureKey) {
  if (!signatureKey || !token || !orderId) return false;
  const want = Buffer.from(returnToken(orderId, attemptNo, signatureKey), "utf8");
  const got = Buffer.from(String(token), "utf8");
  return got.length === want.length && timingSafeEqual(got, want);
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

export function phoneForCleffo(phone) {
  let d = String(phone || "").replace(/\D/g, "");
  if (d.length > 15) d = d.slice(-15);
  if (d.length < 8) d = d.padStart(8, "0");
  return d;
}

export function country2(country) {
  const raw = String(country || "").trim().toUpperCase();
  const map = { USA: "US", GBR: "GB", CAN: "CA", AUS: "AU", DEU: "DE", FRA: "FR", ISR: "IL", NLD: "NL", ESP: "ES", ITA: "IT" };
  if (raw.length === 2) return raw;
  // infra 2026-10-01 ship48 (Legal): never invent a country. Blank or unmappable -> "".
  if (raw === "UNITED STATES" || raw === "UNITED STATES OF AMERICA") return "US";
  return map[raw] || "";
}

/**
 * Neutral, single-line order descriptor. Like the UMG path (which sends the vendor name + amount + order id and no
 * product names), Cleffo gets one line "BioLabs Research order BLR-1234" for the server-side total — no compound or
 * product names. qty 1 x total keeps sub_total == sum(products) exact after volume discount / shipping.
 */
export function neutralLine(order, opts = {}) {
  const vendor = opts.vendor || process.env.CLEFFO_VENDOR_NAME || "BioLabs Research";
  return {
    name: `${vendor} order ${order.id}`.slice(0, 120),
    product_id: String(order.id),
    quantity: 1,
    price: money(order.amount),
    image: opts.imageUrl || process.env.CLEFFO_PRODUCT_IMAGE_URL || "https://biolabsresearch.co/apple-touch-b.png",
  };
}

/** Request body for POST /api/payment-link. Amount is the order's server-side amount; tax 0. */
export function buildPaymentLinkBody({ order, merchantOrderId, redirectUrl, clientKey, imageUrl, vendor }) {
  const c = order.customer || {};
  const name = `${c.first_name || ""} ${c.last_name || ""}`.trim() || "Customer";
  const line = neutralLine(order, { imageUrl, vendor });
  const total = money(order.amount);
  const customer = {
    name: name.slice(0, 100),
    email: String(c.email || "").replace(/\s+/g, ""),
    phone_no: phoneForCleffo(c.phone),
  };
  if (c.address || c.city || c.zip) {
    const addr = {
      address_line_1: String(c.address || "").slice(0, 150),
      city: String(c.city || "").slice(0, 80),
      state: String(c.state || "").slice(0, 10),
      postal_code: String(c.zip || "").slice(0, 12),
      country: country2(c.country),
    };
    customer.shipping_address = addr;
    customer.billing_address = { ...addr };
  }
  return {
    data: {
      merchant_order_id: String(merchantOrderId).replace(/[^A-Za-z0-9]/g, "").slice(0, 64),
      customer_detail: customer,
      products: [line],
      price: { sub_total: total, tax: 0, total, currency: "USD" /* infra 2026-09-29 cleffo: USD only, never from the order / browser */ },
    },
    metadata: { source: "api", cleffo_client_key: clientKey, redirect_url: redirectUrl },
  };
}

async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { method, headers, body, signal: ac.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { rawText: String(text).slice(0, 300) }; }
    return { httpStatus: res.status, body: json };
  } catch (err) {
    return { httpStatus: null, body: null, errorMessage: err?.name === "AbortError" ? "timeout" : (err?.message || "network_error"), networkCode: String(err?.cause?.code || err?.code || "") };
  } finally {
    clearTimeout(timer);
  }
}

function errorSummary(body) {
  if (!body || typeof body !== "object") return "";
  const errs = body.errors && typeof body.errors === "object" ? Object.entries(body.errors).map(([k, v]) => `${k}: ${v}`).join("; ") : "";
  return `${body.message || ""}${errs ? ` (${errs})` : ""}`.slice(0, 500);
}

// The request never left this host / never found a server: Cleffo cannot have made a link.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);

/**
 * -> { ok, paymentLink, ref, merchantOrderId, httpStatus, error, unknown? }
 * unknown: true = no usable answer (timeout, dropped connection, a 2xx we cannot read): the link MAY exist at Cleffo, so the
 * caller must not treat it as "no link" (no spare processor). A refused connection or an error answer with a body is explicit.
 */
export async function createPaymentLink(input, deps = {}) {
  const cfg = deps.config || loadCleffoConfig();
  const health = cleffoKeyHealth(cfg);
  if (!health.ready) return { ok: false, error: health.baseUrlMismatch ? "cleffo_base_url_mismatch" : "cleffo_keys_missing", httpStatus: null };
  const body = buildPaymentLinkBody({ ...input, clientKey: cfg.clientKey });
  const rawBody = JSON.stringify(body);
  const r = await requestJson(`${cfg.baseUrl}/api/payment-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", "x-api-key": cfg.apiKey, "x-signature": signBody(rawBody, cfg.signatureKey) },
    body: rawBody,
    timeoutMs: deps.timeoutMs || Number(process.env.CLEFFO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
  });
  if (r.errorMessage) return { ok: false, error: r.errorMessage, httpStatus: null, unknown: !NOT_SENT_CODES.has(r.networkCode) };
  const d = r.body?.data || {};
  if (r.httpStatus >= 200 && r.httpStatus < 300 && r.body?.status === true && d.payment_link && d.transaction_reference_number) {
    return { ok: true, paymentLink: String(d.payment_link), ref: String(d.transaction_reference_number), merchantOrderId: String(d.merchant_order_id || body.data.merchant_order_id), httpStatus: r.httpStatus };
  }
  return { ok: false, error: errorSummary(r.body) || `http_${r.httpStatus}`, httpStatus: r.httpStatus, unknown: r.httpStatus >= 200 && r.httpStatus < 300 };
}

/**
 * audit 2026-10-02 (#595): the page only follows a payment link that is https on cleffo.com / *.cleffo.com (no credentials, no port;
 * checkout-charge.js isCleffoUrl). Same rule here, so the server can say when Cleffo hands out a link the page will refuse.
 */
export function isTrustedPaymentLink(url) {
  try {
    const u = new URL(String(url || ""));
    if (u.protocol !== "https:" || u.username || u.password || u.port) return false;
    const h = u.hostname.toLowerCase();
    return h === "cleffo.com" || h.endsWith(".cleffo.com");
  } catch {
    return false;
  }
}

export function mapPaymentStatus(s) {
  const v = String(s || "").trim().toLowerCase();
  if (v === "completed") return "PAID";
  if (v === "failed") return "DECLINED";
  if (v === "pending") return "PENDING";
  if (v === "expired" || v === "cancelled" || v === "canceled") return "EXPIRED"; // the link is dead, no payment happened
  return "UNKNOWN";
}

/** -> { ok, paymentStatus, status (PAID|DECLINED|PENDING|EXPIRED|UNKNOWN), totalAmount, currency, merchantOrderId, gatewayIntentId, dateTime } */
export async function getPaymentStatus(ref, deps = {}) {
  const cfg = deps.config || loadCleffoConfig();
  if (!cfg.apiKey || cfg.baseUrlMismatch) return { ok: false, error: "cleffo_keys_missing" };
  const safeRef = String(ref || "").replace(/[^A-Za-z0-9_-]/g, "");
  if (!safeRef) return { ok: false, error: "ref_required" };
  const r = await requestJson(`${cfg.baseUrl}/api/payment-link/${encodeURIComponent(safeRef)}/status`, {
    headers: { Accept: "application/json", "x-api-key": cfg.apiKey },
    timeoutMs: deps.timeoutMs || Number(process.env.CLEFFO_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS,
    fetchImpl: deps.fetchImpl,
  });
  if (r.errorMessage) return { ok: false, error: r.errorMessage, httpStatus: null };
  if (r.httpStatus === 200 && r.body?.status === true && r.body.data) {
    const d = r.body.data;
    return {
      ok: true,
      httpStatus: 200,
      paymentStatus: String(d.payment_status || ""),
      status: mapPaymentStatus(d.payment_status),
      totalAmount: d.total_amount != null ? String(d.total_amount) : null,
      currency: d.currency ? String(d.currency).toUpperCase() : null,
      merchantOrderId: d.merchant_order_id != null ? String(d.merchant_order_id) : null,
      ref: d.transaction_reference_number != null ? String(d.transaction_reference_number) : safeRef,
      gateway: d.payment_gateway || null,
      gatewayIntentId: d.payment_gateway_intent_id || null,
      dateTime: d.date_time || null,
    };
  }
  return { ok: false, error: errorSummary(r.body) || `http_${r.httpStatus}`, httpStatus: r.httpStatus };
}

export { KEY_NAMES };
