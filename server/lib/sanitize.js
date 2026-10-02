import { luhnValid } from "./card.js";

const CARD_KEYS = new Set([
  "number", "cardnumber", "card_number", "pan", "cvv", "cvc", "cvv2",
  "security_code", "authorization", "api_key", "key", "secret",
]);

export function last4(number) {
  const digits = String(number || "").replace(/\D/g, "");
  return digits ? digits.slice(-4) : "";
}

export function maskPan(number) {
  const digits = String(number || "").replace(/\D/g, "");
  if (digits.length < 8) return digits ? "****" : "";
  return `${digits.slice(0, 6)}${"*".repeat(Math.max(4, digits.length - 10))}${digits.slice(-4)}`;
}

export function stripSecrets(value, depth = 0) {
  if (value == null) return value;
  // audit 2026-10-02 (#388): below 8 levels the old code handed the value back untouched, secrets included; an object there is now a mask.
  if (depth > 8) return typeof value === "object" ? "[truncated]" : value;
  if (Array.isArray(value)) return value.map((v) => stripSecrets(v, depth + 1));
  if (typeof value !== "object") return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = k.toLowerCase();
    if (CARD_KEYS.has(key) || key.includes("secret") || key.includes("api_key")) {
      if (key === "number" || key === "cardnumber" || key === "card_number" || key === "pan") {
        out[k] = maskPan(v);
      } else {
        out[k] = "[redacted]";
      }
      continue;
    }
    out[k] = stripSecrets(v, depth + 1);
  }
  return out;
}

// audit 2026-10-02: length ceiling for fields of the open quote / abandon endpoints (non-strings pass through untouched).
export function capStr(value, max) {
  return typeof value === "string" ? value.slice(0, max) : value;
}

export function cardFingerprint(card = {}) {
  return {
    name: card.name || "",
    last4: last4(card.number),
    brand: card.brand || "",
    type: card.type || "",
    month: card.month ? String(card.month) : "",
    year: card.year ? String(card.year).slice(-2) : "",
  };
}

/**
 * Request-derived text for ONE log line: control characters (CR / LF / ESC ...) become a space, length capped, and the
 * literal alert tag is defused (ops-watch takes a [pay-alert] anywhere in a line, not only at its start).
 */
export function logSafe(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
    .replace(/\[\s*pay-alert\s*\]/gi, "(pay-alert)")
    .slice(0, max);
}

const CARD_MASK = "[card number removed]";
// Control characters (incl. CR / LF / ESC), line / paragraph separators and bidi overrides.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g;

/**
 * audit 2026-10-02 (#758): one buyer-supplied text field. Strings (and finite numbers) only - an object / array / null becomes "";
 * control characters become one space, trimmed, cut to `max`. The caller decides what an empty value means (the existing 400s).
 */
export function cleanText(value, max = 200) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string") return "";
  return value.replace(CONTROL_CHARS, " ").trim().slice(0, max);
}

function maskDigitRun(run) {
  const groups = [];
  for (const m of run.matchAll(/\d+/g)) groups.push({ start: m.index, end: m.index + m[0].length, text: m[0] });
  let out = "";
  let last = 0;
  let a = 0;
  while (a < groups.length) {
    let total = 0;
    let hit = -1;
    for (let b = a; b < groups.length; b += 1) {
      total += groups[b].text.length;
      if (total > 19) break;
      if (total >= 13 && luhnValid(groups.slice(a, b + 1).map((g) => g.text).join(""))) hit = b;
    }
    if (hit >= 0) { out += run.slice(last, groups[a].start) + CARD_MASK; last = groups[hit].end; a = hit + 1; } else a += 1;
  }
  return out + run.slice(last);
}

/**
 * audit 2026-10-02 (#388): free text (order notes, item names) may carry a card number the buyer pasted by mistake; it must not be
 * stored in the order, the backups or the CRM. Masks groups of digits (single space / dash between groups) that make 13-19 digits and
 * pass Luhn: phones, tracking numbers and other digit strings that are not a card number stay. Non-strings pass through.
 */
export function maskCardNumbers(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\d+(?:[ -]\d+)*/g, maskDigitRun);
}

/** maskCardNumbers over every string of a plain JSON value (objects / arrays copied; deeper than 8 levels -> "[truncated]"). */
export function maskCardNumbersDeep(value, depth = 0) {
  if (typeof value === "string") return maskCardNumbers(value);
  if (value == null || typeof value !== "object") return value;
  if (depth > 8) return "[truncated]";
  if (Array.isArray(value)) return value.map((v) => maskCardNumbersDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = maskCardNumbersDeep(v, depth + 1);
  return out;
}
