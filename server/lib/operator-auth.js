import { timingSafeEqual } from "node:crypto";

/**
 * Operator gate for UMG read/admin routes.
 *
 * Accept either:
 *   - X-Marketing-Key equal to MARKETING_DIGEST_KEY (timing-safe), or
 *   - Authorization: Bearer <CRM session> checked against blitz-api
 *     (GET ${CRM_AUTH_URL||http://127.0.0.1:3001}${CRM_SESSION_PATH||/api/session}).
 *
 * Leads-digest uses the marketing key only — see marketingDigestKeyOk.
 * X-CRM-Role is not a secret and is never accepted.
 * Missing key, wrong key, or an unreachable session authority → not authorized.
 */

export function headerValue(req, name) {
  const want = String(name || "").toLowerCase();
  const headers = req?.headers || {};
  const raw = headers[want];
  if (Array.isArray(raw)) return String(raw[0] || "");
  return raw == null ? "" : String(raw);
}

export function bearerToken(req) {
  const h = headerValue(req, "authorization").trim();
  const m = /^Bearer\s+(\S+)/i.exec(h);
  return m ? m[1] : "";
}

export function secretsEqual(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length === 0 || right.length === 0) return false;
  const max = Math.max(left.length, right.length);
  const padL = Buffer.alloc(max);
  const padR = Buffer.alloc(max);
  left.copy(padL);
  right.copy(padR);
  return timingSafeEqual(padL, padR) && left.length === right.length;
}

export function marketingDigestKeyOk(req, env = process.env) {
  const expected = String(env.MARKETING_DIGEST_KEY || "");
  if (!expected) return false;
  return secretsEqual(headerValue(req, "x-marketing-key").trim(), expected);
}

export function sessionBodyOk(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  if (data.user && typeof data.user === "object") {
    const user = data.user;
    return Boolean(user.email || user.role || user.id || user.name);
  }
  if (typeof data.email === "string" && data.email.includes("@")) return true;
  if (data.role === "admin" || data.role === "staff") return true;
  return false;
}

export function actorFromSession(data) {
  if (!data || typeof data !== "object") return "";
  const user = data.user && typeof data.user === "object" ? data.user : null;
  const email = (user && user.email) || data.email;
  if (typeof email === "string" && email.includes("@")) return email.trim().slice(0, 160);
  const name = (user && user.name) || data.name;
  if (typeof name === "string" && name.trim()) return name.trim().slice(0, 80);
  return "";
}

export async function fetchCrmSession(token, opts = {}) {
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const base = String(env.CRM_AUTH_URL || "http://127.0.0.1:3001").replace(/\/$/, "");
  const path = String(env.CRM_SESSION_PATH || "/api/session");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  // audit 2026-10-02 (r2-crash-restart-recovery-3): 0.8 s was shorter than a busy blitz-api needs, and a timeout is answered 401, which
  // throws the staff member back to the login page. 3 s default (CRM_AUTH_TIMEOUT_MS still overrides).
  const timeoutMs = Number(env.CRM_AUTH_TIMEOUT_MS || 3000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 3000);
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    if (!res || !res.ok) return { ok: false, data: null };
    let data = null;
    try {
      data = await res.json();
    } catch {
      data = null;
    }
    return { ok: sessionBodyOk(data), data };
  } catch {
    return { ok: false, data: null };
  } finally {
    clearTimeout(timer);
  }
}

export async function defaultCrmSessionCheck(token, opts = {}) {
  const session = await fetchCrmSession(token, opts);
  return session.ok;
}

/**
 * Same gate as operatorAuthorized, plus the staff identity to store on mark-paid / ship.
 * Marketing-key callers are recorded as "marketing-key". A CRM session records the email when the session body has one.
 */
export async function resolveOperator(req, opts = {}) {
  const env = opts.env || process.env;
  if (marketingDigestKeyOk(req, env)) {
    return { ok: true, actor: "marketing-key", via: "marketing-key" };
  }
  const token = bearerToken(req);
  if (!token) return { ok: false, actor: null, via: null };
  if (typeof opts.checkCrmSession === "function") {
    try {
      const result = await opts.checkCrmSession(token);
      if (!result) return { ok: false, actor: null, via: null };
      const actor = result && typeof result === "object"
        ? (actorFromSession(result) || "crm-session")
        : "crm-session";
      return { ok: true, actor, via: "crm-session" };
    } catch {
      return { ok: false, actor: null, via: null };
    }
  }
  const session = await fetchCrmSession(token, opts);
  if (!session.ok) return { ok: false, actor: null, via: null };
  return { ok: true, actor: actorFromSession(session.data) || "crm-session", via: "crm-session" };
}

export async function operatorAuthorized(req, opts = {}) {
  const env = opts.env || process.env;
  if (marketingDigestKeyOk(req, env)) return true;
  const token = bearerToken(req);
  if (!token) return false;
  if (typeof opts.checkCrmSession === "function") {
    try {
      return Boolean(await opts.checkCrmSession(token));
    } catch {
      return false;
    }
  }
  return defaultCrmSessionCheck(token, opts);
}
