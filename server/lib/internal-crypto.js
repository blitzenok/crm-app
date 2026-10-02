// 2026-10-01 (Yehuda, post-deploy CRM work): internal lookup of a buyer's open crypto orders for the account backend
// (Marketing PR #108 / biofirst-hosting PR 42). GET /api/internal/crypto/pending?email=
//   - localhost only (socket address 127.0.0.1 / ::1, no proxy headers); nginx does not route /api/internal/ to :8787
//   - X-Internal-Key must equal CRM_INTERNAL_KEY (timing-safe); env unset -> 503
//   - only unexpired "awaiting" crypto orders of that email: {items:[{ref, amount_usd, expires_at, status_token}]}
//   - never logs the email or the token
import { createHash, timingSafeEqual } from "node:crypto";
import { launchFields, launchStatus } from "./crypto-launch.js";
import { cryptoVerifyConfig, paymentDeadline, signConfirmToken } from "./crypto-payment.js";

const LOCAL = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

export function isLocalRequest(req) {
  const addr = String(req?.socket?.remoteAddress || "");
  if (!LOCAL.has(addr)) return false;
  // A request nginx passed on carries these; the internal caller talks to :8787 directly.
  const h = req.headers || {};
  return !h["x-forwarded-for"] && !h["x-real-ip"] && !h["forwarded"];
}

/** -> { ok:true } | { ok:false, status, error } */
export function internalKeyCheck(req, env = process.env) {
  const want = String(env.CRM_INTERNAL_KEY || "");
  if (want.length < 32) return { ok: false, status: 503, error: "internal_api_not_configured" };
  const got = req.headers["x-internal-key"];
  if (typeof got !== "string" || !got) return { ok: false, status: 401, error: "unauthorized" };
  const a = createHash("sha256").update(got).digest();
  const b = createHash("sha256").update(want).digest();
  return timingSafeEqual(a, b) ? { ok: true } : { ok: false, status: 401, error: "unauthorized" };
}

export function normalizeEmail(raw) {
  const e = String(raw ?? "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export function pendingCryptoForEmail(orders, email, { env = process.env, secret, nowMs = Date.now() } = {}) {
  const cfg = cryptoVerifyConfig(env);
  const items = [];
  for (const o of orders || []) {
    if (!o || o.paymentMethod !== "crypto" || !o.cryptoPayment || !o.orderRef) continue;
    if (String(o.customer?.email || "").trim().toLowerCase() !== email) continue;
    const cp = o.cryptoPayment;
    if (!cp.expiresAt || nowMs >= paymentDeadline(cp, cfg)) continue;
    if (launchStatus(o, env, nowMs).status !== "awaiting") continue;
    const f = launchFields(o, env);
    items.push({ ref: o.orderRef, amount_usd: f.amount_usd, expires_at: f.expires_at, status_token: signConfirmToken(o, secret) });
  }
  items.sort((x, y) => String(y.expires_at).localeCompare(String(x.expires_at)));
  return { items };
}
