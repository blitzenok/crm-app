// Crypto payment model shared by checkout + the on-chain verifier (2026-09-28).
// A crypto order is released (fulfillment "ready_to_ship") ONLY after an on-chain verified transfer of the right token,
// on the right network, to our wallet, with enough confirmations, amount >= due, and a clear sanctions screen.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCEPTABLE_TOKENS, amountToUnits, unitsToAmount } from "./crypto-chains.js";

export const PAY = Object.freeze({
  AWAITING: "awaiting_payment",
  CONFIRMING: "confirming",
  PAID: "paid",
  REVIEW: "payment_review",
  SANCTIONS: "sanctions_review",
  HOLD: "screening_hold",
  CANCELLED: "cancelled",
});
export const OPEN_STATUSES = new Set([PAY.AWAITING, PAY.CONFIRMING]);
export const DECIMALS = 6;

function num(v, d) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : d; }

export function cryptoVerifyConfig(env = process.env) {
  const tokens = String(env.CRYPTO_ACCEPTED_TOKENS || "USDT").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
  return {
    // Read-only chain lookups; on by default. Shipping stays blocked whatever this is set to.
    enabled: env.CRYPTO_VERIFY_ENABLED !== "false",
    pollMs: Math.max(30000, num(env.CRYPTO_VERIFY_POLL_MS, 90000)),
    timeoutMin: num(env.CRYPTO_PAYMENT_TIMEOUT_MIN, 60),
    graceMin: num(env.CRYPTO_CONFIRM_GRACE_MIN, 60),
    lateWatchHours: num(env.CRYPTO_LATE_WATCH_HOURS, 72),
    confirmations: {
      trc20: num(env.CRYPTO_CONFIRMATIONS_TRC20, 20),
      erc20: num(env.CRYPTO_CONFIRMATIONS_ERC20, 12),
    },
    // Rounding only (1 micro-USDT by default). Anything short of that is a partial payment -> review.
    toleranceUnits: amountToUnits(String(env.CRYPTO_AMOUNT_TOLERANCE || "0.000001"), DECIMALS),
    overpayToleranceUnits: amountToUnits(String(env.CRYPTO_OVERPAY_TOLERANCE || "0.000001"), DECIMALS),
    acceptedTokens: tokens.length ? tokens : ["USDT"],
    // per network: env list ∩ ACCEPTABLE_TOKENS (USDC never on TRC20)
    acceptedByNetwork: Object.fromEntries(Object.entries(ACCEPTABLE_TOKENS).map(([n, list]) => [n, (tokens.length ? tokens : ["USDT"]).filter((t) => list.includes(t))])),
    clockSkewMs: 5 * 60 * 1000,
    maxHints: 5,
    // 2026-09-30 launch (Yehuda): only an admin "Mark crypto paid" makes an order paid; on-chain auto-match holds for the admin.
    adminMarkPaidRequired: env.CRYPTO_ADMIN_MARK_PAID_REQUIRED === "true",
    // unique amount = total + 0.01..0.99 across ALL networks (no memo on ERC-20/TRC-20), never a 0.001 fallback
    uniqueAcrossNetworks: env.CRYPTO_UNIQUE_ACROSS_NETWORKS === "true",
    centsOnly: env.CRYPTO_UNIQUE_CENTS_ONLY === "true",
    backoffMaxMs: 15 * 60 * 1000,
  };
}

/**
 * Is a transfer of `token` on `network` acceptable payment for this order? Per-network rules (USDT on TRC20/ERC20,
 * USDC on ERC20 only), narrowed by CRYPTO_ACCEPTED_TOKENS. An order that was itself created for that exact
 * token+network (e.g. a USDC-TRC20 order opened before this rule) stays verifiable as long as the token is enabled.
 */
export function isTokenAccepted(cfg, token, network, cp = null) {
  if (!token || !network) return false;
  if ((cfg.acceptedByNetwork?.[network] || []).includes(token)) return true;
  return Boolean(cp && cp.token === token && cp.network === network && cfg.acceptedTokens.includes(token));
}

export function isCryptoVerified(order) {
  const cp = order?.cryptoPayment;
  return Boolean(
    order && order.paymentMethod === "crypto" && cp && cp.status === PAY.PAID &&
    // on-chain verified, or an admin "Mark crypto paid" override (logged, with a note) — 2026-09-30 launch
    (cp.verifiedOnChain === true || (cp.adminMarkPaid && cp.adminMarkPaid.override === true && Boolean(cp.adminMarkPaid.note))) &&
    cp.sanctions && (cp.sanctions.status === "clear" || cp.sanctions.status === "skipped_fail_open" || cp.sanctions.status === "skipped_admin_override") && order.status === "crypto_paid" && order.paymentConfirmed === true,
  );
}

/** Cancel deadline: created + timeout, plus the grace window once the customer said "I've sent the payment". */
export function paymentDeadline(cp, cfg) {
  const base = Date.parse(cp?.expiresAt || "") || 0;
  return cp?.customerConfirmedAt ? base + cfg.graceMin * 60000 : base;
}

/** Orders whose exact amount is still "taken" on a network: open ones, and cancelled ones inside the late-payment watch. */
export function amountIsWatched(order, cfg, nowMs) {
  const cp = order?.cryptoPayment;
  if (!cp || order.paymentMethod !== "crypto") return false;
  if (OPEN_STATUSES.has(cp.status)) return true;
  if (cp.status === PAY.CANCELLED && cp.cancelledAt) return nowMs - Date.parse(cp.cancelledAt) < cfg.lateWatchHours * 3600e3;
  return false;
}

/**
 * Unique pay amount: server price + 0.01..0.99 USDT, not equal to the pay amount of any watched order on the same network
 * (network null = unique across all networks). Falls back to 0.001 steps if every cent is taken.
 */
export function allocatePayAmount(orders, { baseAmount, network, cfg, nowMs = Date.now(), rand = Math.random }) {
  const base = amountToUnits(String(baseAmount), DECIMALS);
  const taken = new Set();
  for (const o of orders) {
    if (!amountIsWatched(o, cfg, nowMs)) continue;
    const n = o.cryptoPayment.network;
    if (network && n && n !== network) continue;
    if (o.cryptoPayment.payUnits) taken.add(String(o.cryptoPayment.payUnits));
  }
  const tryOffsets = (step, count) => {
    const offs = Array.from({ length: count }, (_, i) => BigInt(i + 1) * step);
    for (let i = offs.length - 1; i > 0; i -= 1) { const j = Math.floor(rand() * (i + 1)); [offs[i], offs[j]] = [offs[j], offs[i]]; }
    for (const off of offs) { const u = base + off; if (!taken.has(u.toString())) return { off, u }; }
    return null;
  };
  const hit = tryOffsets(10000n, 99) || (cfg.centsOnly ? null : tryOffsets(1000n, 999));
  if (!hit) return null;
  return { payUnits: hit.u.toString(), payAmount: fixed(hit.u), offsetUnits: hit.off.toString(), offset: fixed(hit.off) };
}

/** Units -> decimal string with at least 2 decimals ("158.37", "158.371"). */
export function fixed(units) {
  const s = unitsToAmount(BigInt(units), DECIMALS);
  const [i, f = ""] = s.split(".");
  return `${i}.${f.padEnd(2, "0")}`;
}

// ---- customer confirm token (HMAC over order id + ref) ---------------------------------------------------------
let cachedSecret = null;
export function confirmSecret(env = process.env) {
  if (env.CRYPTO_CONFIRM_SECRET && String(env.CRYPTO_CONFIRM_SECRET).length >= 32) return String(env.CRYPTO_CONFIRM_SECRET);
  if (cachedSecret) return cachedSecret;
  const dir = env.STORE_PATH ? dirname(env.STORE_PATH) : join(dirname(new URL(import.meta.url).pathname), "..", "data");
  const file = join(dir, "crypto-confirm.key");
  try {
    if (existsSync(file)) cachedSecret = readFileSync(file, "utf8").trim();
    if (!cachedSecret || cachedSecret.length < 32) {
      mkdirSync(dir, { recursive: true });
      cachedSecret = randomBytes(32).toString("hex");
      writeFileSync(file, `${cachedSecret}\n`, { mode: 0o600 });
      try { chmodSync(file, 0o600); } catch { /* best effort */ }
    }
  } catch {
    cachedSecret = randomBytes(32).toString("hex"); // process-local; tokens then stop working after a restart
  }
  return cachedSecret;
}

export function signConfirmToken(order, secret) {
  return createHmac("sha256", secret).update(`crypto-confirm:${order.id}:${order.orderRef}`).digest("base64url").slice(0, 43);
}

export function verifyConfirmToken(order, token, secret) {
  const want = Buffer.from(signConfirmToken(order, secret));
  const got = Buffer.from(String(token || ""));
  return got.length === want.length && timingSafeEqual(got, want);
}

export const TX_RE = { erc20: /^0x[0-9a-fA-F]{64}$/, trc20: /^(0x)?[0-9a-fA-F]{64}$/ };

/** Normalise a tx hash hint for a network: erc20 keeps 0x, trc20 drops it. null if not a hash. */
export function normalizeHint(raw, network) {
  const s = String(raw ?? "").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(s)) return null;
  const hex = s.replace(/^0x/, "").toLowerCase();
  if (network === "erc20") return `0x${hex}`;
  if (network === "trc20") return hex;
  return s.startsWith("0x") ? `0x${hex}` : hex;
}
