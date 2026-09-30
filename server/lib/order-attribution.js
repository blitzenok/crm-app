// infra 2026-09-30 order-attribution: what the payment module keeps of the storefront's trail (attribution.js, sent by the page
// as body.attribution) when it creates an order. products-api folds it again (attributionOf) before it reaches the CRM; this
// is the first, strict cut so an order record never holds more than the fields below.
// Read only, never throws: a bad trail is dropped, the order (and the charge) goes on without it.

const STRING_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "click", "click_id", "referrer", "landing"];
const NUMBER_KEYS = ["v", "at"];
const MAX_LEN = 200;
// C0, DEL, C1 and the two Unicode line separators.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

function cleanString(value) {
  if (typeof value !== "string") return "";
  return value.replace(CONTROL, "").trim().slice(0, MAX_LEN);
}

/** Plain object of the known keys, or null when raw is not a plain object or nothing usable is left. */
export function cleanAttribution(raw) {
  try {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const out = {};
    let strings = 0;
    for (const key of STRING_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) continue;
      const value = cleanString(raw[key]);
      if (value) { out[key] = value; strings += 1; }
    }
    if (!strings) return null;
    for (const key of NUMBER_KEYS) {
      if (Object.prototype.hasOwnProperty.call(raw, key) && typeof raw[key] === "number" && Number.isFinite(raw[key])) out[key] = raw[key];
    }
    return out;
  } catch {
    return null;
  }
}

/** For an order literal: `...orderAttribution(body)` adds `attribution` only when the body carried a usable trail. */
export function orderAttribution(source) {
  try {
    const attribution = cleanAttribution(source && typeof source === "object" ? source.attribution : undefined);
    return attribution ? { attribution } : {};
  } catch {
    return {};
  }
}
