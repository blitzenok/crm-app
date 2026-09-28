// Checkout consent proof (Terms / RUO acceptance). Every card or crypto order created by the checkout routes gets one
// append-only JSONL record: what the page said the customer ticked, plus what the server itself saw (time, IP, UA,
// order, amount), sealed with a sha256 over the canonical record and chained to the previous record's hash.
// Retention: keep 7+ years. The file is never rewritten by this code; only appended (O_APPEND + fsync, mode 600).
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeSync, chmodSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { clientIp } from "./abandon.js";

export const CONSENT_SCHEMA = "blr-consent/1";
export const MAX_CHECKS = 20;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const UA_MAX = 400;

export function defaultConsentLogPath(env = process.env) {
  if (env.CONSENT_LOG_PATH) return env.CONSENT_LOG_PATH;
  if (env.STORE_PATH) return join(dirname(env.STORE_PATH), "consent-log.jsonl");
  return join(dirname(new URL(import.meta.url).pathname), "..", "data", "consent-log.jsonl");
}

function cleanStr(v, max) {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
  return s || null;
}

/** Sanitise the browser's `consent` field. Never throws; returns { consent, missing, invalid, dropped }. */
export function sanitizeConsent(raw) {
  if (raw === undefined || raw === null) return { consent: null, missing: true, invalid: false, dropped: 0 };
  if (typeof raw !== "object" || Array.isArray(raw)) return { consent: null, missing: true, invalid: true, dropped: 0 };
  const checks = {};
  let dropped = 0;
  const src = raw.checks && typeof raw.checks === "object" && !Array.isArray(raw.checks) ? raw.checks : {};
  for (const [k, v] of Object.entries(src)) {
    if (Object.keys(checks).length >= MAX_CHECKS || !ID_RE.test(k) || typeof v !== "boolean" || k === "__proto__") {
      dropped += 1;
      continue;
    }
    checks[k] = v;
  }
  let acceptedAt = null;
  const at = cleanStr(raw.acceptedAt, 40);
  if (at && Number.isFinite(Date.parse(at))) acceptedAt = new Date(Date.parse(at)).toISOString();
  const pageVersion = cleanStr(raw.pageVersion, 64);
  const ids = Object.keys(checks);
  if (!ids.length && !acceptedAt && !pageVersion) return { consent: null, missing: true, invalid: true, dropped };
  return {
    consent: { checks, acceptedAt, acceptedAtRaw: at && !acceptedAt ? at : undefined, pageVersion },
    missing: false,
    invalid: false,
    dropped,
  };
}

/** Deterministic JSON: object keys sorted, undefined dropped. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
}

export function hashRecord(rec) {
  const { hash, ...rest } = rec;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

function lastHashOf(filePath) {
  if (!existsSync(filePath)) return null;
  const size = statSync(filePath).size;
  if (!size) return null;
  const len = Math.min(size, 65536);
  const buf = Buffer.alloc(len);
  const fd = openSync(filePath, "r");
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  const lines = buf.toString("utf8").split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { const r = JSON.parse(lines[i]); if (r && r.hash) return r.hash; } catch { /* partial first line */ }
  }
  return null;
}

export function createConsentLog(opts = {}) {
  const filePath = opts.filePath || defaultConsentLogPath();
  const now = opts.now || (() => new Date());
  let prevHash;
  function append(rec) {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
    if (prevHash === undefined) prevHash = lastHashOf(filePath);
    const full = { ...rec, prevHash: prevHash || null };
    full.hash = hashRecord(full);
    const fd = openSync(filePath, "a", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(full)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try { chmodSync(filePath, 0o600); } catch { /* best effort */ }
    prevHash = full.hash;
    return full;
  }
  function readAll() {
    if (!existsSync(filePath)) return [];
    const out = [];
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch { out.push({ corrupt: true }); }
    }
    return out;
  }
  return {
    filePath,
    now,
    append,
    readAll,
    /** Records whose orderId / orderRef / idempotencyKey equals ref (or email equals email), with hashOk. */
    find({ ref, email } = {}) {
      const r = String(ref || "").trim();
      const e = String(email || "").trim().toLowerCase();
      if (!r && !e) return [];
      return readAll()
        .filter((x) => !x.corrupt && ((r && (x.orderId === r || x.orderRef === r || x.idempotencyKey === r)) || (e && x.email === e)))
        .map((x) => ({ ...x, hashOk: hashRecord(x) === x.hash }));
    },
  };
}

function firstHeader(v) {
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * Build + append the consent record for a freshly created order, and return the summary to store on the order.
 * Never throws (a logging failure must not cost the customer the order); returns { ok:false, error } instead.
 */
export function recordCheckoutConsent({ log, req, body, order, channel }) {
  try {
    const s = sanitizeConsent(body?.consent);
    const realIp = cleanStr(firstHeader(req?.headers?.["x-real-ip"]), 64);
    const rec = {
      schema: CONSENT_SCHEMA,
      channel, // "card" | "crypto"
      receivedAt: log.now().toISOString(),
      orderId: order.id,
      orderRef: order.orderRef || null,
      idempotencyKey: cleanStr(order.idempotencyKey, 128),
      email: String(order.customer?.email || body?.customer?.email || "").trim().toLowerCase().slice(0, 254) || null,
      amount: order.amount != null ? String(order.amount) : null,
      currency: order.currency || "USD",
      shipMethod: order.priceCheck?.shipMethod || cleanStr(body?.shipMethod, 32),
      orderStatus: order.status || null,
      ip: cleanStr(clientIp(req), 64),
      ...(realIp ? { xRealIp: realIp } : {}),
      userAgent: cleanStr(firstHeader(req?.headers?.["user-agent"]), UA_MAX),
      consent: s.consent,
      missing: s.missing,
      ...(s.invalid ? { invalid: true } : {}),
      ...(s.dropped ? { droppedChecks: s.dropped } : {}),
    };
    const saved = log.append(rec);
    const checks = s.consent?.checks || {};
    const ids = Object.keys(checks);
    return {
      ok: true,
      record: saved,
      summary: {
        recorded: true,
        missing: s.missing,
        allChecked: ids.length > 0 && ids.every((k) => checks[k] === true),
        checks,
        pageVersion: s.consent?.pageVersion || null,
        acceptedAt: s.consent?.acceptedAt || null,
        receivedAt: saved.receivedAt,
        ip: saved.ip,
        hash: saved.hash,
      },
    };
  } catch (err) {
    return { ok: false, error: err?.message || "consent_log_failed" };
  }
}

/**
 * Crypto "I've sent the payment" (2026-09-28): one record in the same hash-chained log, same writer and same IP / UA
 * fields as the checkout consent records. Never throws.
 */
export function recordCryptoPaymentConfirmed({ log, req, body, order, txHint }) {
  try {
    const realIp = cleanStr(firstHeader(req?.headers?.["x-real-ip"]), 64);
    const rec = {
      schema: CONSENT_SCHEMA,
      type: "crypto_payment_confirmed",
      channel: "crypto",
      receivedAt: log.now().toISOString(),
      orderId: order.id,
      orderRef: order.orderRef || null,
      idempotencyKey: cleanStr(order.idempotencyKey, 128),
      email: String(order.customer?.email || "").trim().toLowerCase().slice(0, 254) || null,
      amount: order.cryptoPayment?.payAmount || order.amountDue || null,
      currency: order.cryptoPayment?.token || "USDT",
      network: order.cryptoPayment?.network || null,
      orderStatus: order.status || null,
      paymentStatus: order.cryptoPayment?.status || null,
      txHint: txHint || null,
      pageVersion: cleanStr(body?.pageVersion ?? body?.consent?.pageVersion, 64),
      ip: cleanStr(clientIp(req), 64),
      ...(realIp ? { xRealIp: realIp } : {}),
      userAgent: cleanStr(firstHeader(req?.headers?.["user-agent"]), UA_MAX),
    };
    const saved = log.append(rec);
    return { ok: true, record: saved };
  } catch (err) {
    return { ok: false, error: err?.message || "consent_log_failed" };
  }
}
