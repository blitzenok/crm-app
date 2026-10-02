/**
 * Retry classification for cross-processor routing (legal rule, 2026-09-28):
 *  - Only a SOFT decline may move the customer's next attempt to the other processor, and only once per episode.
 *  - HARD declines (lost / stolen / pick-up, fraud / security, do-not-honor, "do not retry", Mastercard Merchant Advice
 *    Code 03 / 21, closed / invalid account, revoked authorisation, …) never go to the other processor.
 *  - Anything not positively recognised as soft is HARD (fail closed). Cleffo's status API returns only
 *    completed | pending | failed with no reason code, so a Cleffo "failed" is HARD unless a recognised soft reason is
 *    present in the response.
 *
 * Returns { retryClass: "soft" | "hard" | "none", code, basis } — "none" = no charge was attempted (link / network
 * error before the customer could pay); it neither counts as a decline nor unlocks a switch.
 */

// Hard first: a message that matches both lists is hard.
export const HARD_PATTERNS = [
  /stolen/i, /lost\s*card/i, /pick\s*-?\s*up/i, /fraud/i, /suspect/i, /security\s*violation/i,
  /do\s*not\s*honou?r/i, /do\s*not\s*(try|retry|re-?attempt)/i, /no\s*retry/i, /don'?t\s*retry/i,
  /revocation|revoked|stop\s*(payment|recurring)|cancel+ed\s*recurring/i,
  /closed\s*account|account\s*closed|invalid\s*account|no\s*such\s*(card|account)|invalid\s*card(\s*number)?/i,
  /restricted\s*card|card\s*not\s*supported|transaction\s*not\s*permitted|not\s*allowed/i,
  /expired\s*card/i, /invalid\s*(cvv|cvc)/i, /blocked|blacklist|high\s*risk|risk\s*rule/i,
  /\bmac[\s:_-]*0?(3|21)\b/i, /merchant\s*advice\s*code[\s:_-]*0?(3|21)\b/i,
];

export const SOFT_PATTERNS = [
  /timeout|timed?\s*out/i, /activity\s*limit|code:\s*203/i, /mid\s*limits?/i, /lowest\s*ticket/i,
  /insufficient\s*funds?/i, /exceeds?\s*(withdrawal|amount|credit)?\s*limit|over\s*limit/i,
  /issuer\s*(unavailable|inoperative|not\s*available)/i, /system\s*(error|malfunction)/i,
  /try\s*again\s*later/i, /processor[\s-]*down|temporarily\s*unavailable|service\s*unavailable/i,
  /network\s*error|econnreset|econnrefused|enotfound/i, /rate\s*limit/i,
];

// ISO 8583 response codes. Hard = issuer says do not retry this card. Soft = transient / limit.
export const HARD_CODES = new Set(["03", "04", "05", "07", "12", "14", "15", "41", "43", "46", "54", "57", "59", "62", "63", "78", "83", "93", "R0", "R1", "R3", "N7"]);
export const SOFT_CODES = new Set(["19", "51", "61", "65", "91", "96", "203"]);
export const HARD_MAC = new Set(["03", "21"]);

function norm2(code) {
  const c = String(code ?? "").trim().toUpperCase();
  if (/^\d$/.test(c)) return `0${c}`;
  return c;
}

/** attempt: { processor, processorStatus, informationData, informationCode, reason, httpStatus, mac, errorMessage } */
export function classifyForRetry(attempt = {}) {
  const status = String(attempt.processorStatus || "").toUpperCase();
  const reason = String(attempt.reason || "");
  const blob = [attempt.informationData, attempt.errorMessage, attempt.declineMessage].filter(Boolean).join(" ");
  const code = norm2(attempt.informationCode);
  const mac = attempt.mac != null ? norm2(attempt.mac) : "";

  if (["APPROVED", "CAPTURED", "PAID"].includes(status)) return { retryClass: "none", code: code || null, basis: "approved" };
  // infra 2026-09-29 honest-charge: the create call got no answer and find-by-ext-id could not say whether the card was
  // charged. Not a decline (never "hard", never unlocks a switch): the order waits pending until the poller settles it.
  if (reason === "unknown_outcome") return { retryClass: "none", code: null, basis: "unknown_outcome" };
  if (attempt.noChargeAttempted === true || status === "LINK_ERROR") return { retryClass: "none", code: null, basis: "no_charge_attempted" };
  if (mac && HARD_MAC.has(mac)) return { retryClass: "hard", code: `MAC${mac}`, basis: "mastercard_mac" };
  if (HARD_PATTERNS.some((re) => re.test(blob))) return { retryClass: "hard", code: code || null, basis: "hard_pattern" };
  if (code && HARD_CODES.has(code)) return { retryClass: "hard", code, basis: "hard_code" };
  if (["CANCELED", "CANCELLED", "REFUNDED", "CHARGEBACK"].includes(status)) return { retryClass: "hard", code: code || null, basis: "terminal_status" };
  if (code && SOFT_CODES.has(code)) return { retryClass: "soft", code, basis: "soft_code" };
  if (SOFT_PATTERNS.some((re) => re.test(blob))) return { retryClass: "soft", code: code || null, basis: "soft_pattern" };
  // UMG adapter-level outage (no answer / 5xx / 429 / timeout): the card was never decided on.
  if (status === "PROCESSOR_DOWN" || ["timeout_or_network", "processor_down", "http_5xx_or_429", "http_timeout", "http_5xx_or_timeout"].includes(reason)) {
    return { retryClass: "soft", code: code || null, basis: "processor_unavailable" };
  }
  return { retryClass: "hard", code: code || null, basis: "unknown_fail_closed" };
}
