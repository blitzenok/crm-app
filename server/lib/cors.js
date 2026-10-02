/**
 * Storefront CORS allowlist for public checkout APIs.
 *
 * Never emit Access-Control-Allow-Origin: *. Reflect the request Origin only
 * when it is an exact match in the allowlist. Staff/admin paths get no browser CORS.
 *
 * Override via CORS_STOREFRONT_ORIGINS (comma-separated). Empty/unset → defaults.
 */

export const DEFAULT_STOREFRONT_ORIGINS = Object.freeze([
  "https://biolabsresearch.co",
  "https://www.biolabsresearch.co",
  "https://blrcommerce.io",
  "https://www.blrcommerce.io",
]);

/** Checkout paths that are operator reads, not storefront beacons. */
const STAFF_CHECKOUT_PATHS = new Set([
  "/api/checkout/leads-digest",
]);

// 2026-09-30 crypto launch: /api/checkout/crypto* answers the biolabsresearch.co storefront only (CRYPTO_CORS_ORIGINS overrides).
export const DEFAULT_CRYPTO_ORIGINS = Object.freeze(["https://biolabsresearch.co", "https://www.biolabsresearch.co"]);

export function cryptoOrigins(env = process.env) {
  const raw = env.CRYPTO_CORS_ORIGINS;
  if (raw == null || String(raw).trim() === "") return [...DEFAULT_CRYPTO_ORIGINS];
  return String(raw).split(",").map((s) => s.trim()).filter(Boolean);
}

export function storefrontOrigins(env = process.env) {
  const raw = env.CORS_STOREFRONT_ORIGINS;
  if (raw == null || String(raw).trim() === "") {
    return [...DEFAULT_STOREFRONT_ORIGINS];
  }
  return String(raw)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Public storefront-facing checkout routes only (charge, quote, abandon, …). */
export function isStorefrontApiPath(path) {
  if (STAFF_CHECKOUT_PATHS.has(path)) return false;
  return path === "/api/checkout" || path.startsWith("/api/checkout/");
}

/**
 * CORS response headers for a request. Empty object when:
 * - path is not a storefront checkout API, or
 * - Origin is missing / not on the allowlist.
 * Never returns "*".
 */
export function corsHeadersForRequest(req, path, env = process.env) {
  if (!isStorefrontApiPath(path)) return {};

  const origin = req?.headers?.origin;
  if (!origin || typeof origin !== "string") return {};

  const crypto = path === "/api/checkout/crypto" || path.startsWith("/api/checkout/crypto/");
  const allowed = crypto ? cryptoOrigins(env) : storefrontOrigins(env);
  if (!allowed.includes(origin)) return {};

  return {
    "Access-Control-Allow-Origin": origin,
    Vary: "Origin",
    // 2026-10-01: Cleffo status takes its token in X-Order-Token too.
    "Access-Control-Allow-Headers": (crypto || path === "/api/checkout/cleffo/status") ? "Content-Type, X-Order-Token" : "Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}
