import { classifyDecline, classifyHttpFailure } from "../decline.js";
import { countryCode, detectCardType, expiryMonth, expiryYear2, formatAmount, phoneDigits } from "../card.js";
import { cardFingerprint, cleanText, last4, stripSecrets } from "../sanitize.js";
import { loadUmgSecret, umgAuthorizationValue, umgBasicHeader } from "../secrets.js";

export const id = "umg";
export const label = "UMG";
export const CREATE_URL = "https://pay.umg.inc/rest/v1/transactions";

const DEFAULT_TIMEOUT_MS = 15000;

export function buildCreatePayload({ customer = {}, card = {}, amount, currency, extOrderId, vendor, subscriptionStatus, secret }) {
  const type = card.type || detectCardType(card.number);
  return {
    Authorization: secret ? umgAuthorizationValue(secret) : "[dry-run]",
    vendor: vendor || "BioLabs Research",
    // audit 2026-10-02 (#758): buyer text is cleaned (text only, control characters out, capped) before it goes to the processor
    userData: {
      first_name: cleanText(customer.first_name || customer.firstName, 80),
      last_name: cleanText(customer.last_name || customer.lastName, 80),
      email: cleanText(customer.email, 255),
      address: cleanText(customer.address || customer.address1, 200),
      country: countryCode(customer.country),
      state: cleanText(customer.state, 40),
      city: cleanText(customer.city, 80),
      zip: cleanText(customer.zip || customer.postal, 20),
      phone: phoneDigits(customer.phone),
      ip: customer.ip || "127.0.0.1",
      birthday: customer.birthday || customer.birtdday || "1983-01-01",
    },
    cardData: {
      name: card.name || `${customer.first_name || ""} ${customer.last_name || ""}`.trim(),
      type: String(type),
      number: String(card.number || "").replace(/\s+/g, ""),
      month: expiryMonth(card.month),
      year: expiryYear2(card.year),
      cvv: String(card.cvv || card.cvc || ""),
    },
    subscription_status: subscriptionStatus == null ? 0 : Number(subscriptionStatus),
    amount: formatAmount(amount),
    currency: currency || "USD",
    ext_order_id: String(extOrderId || "").slice(0, 100),
  };
}

function normalizeStatus(status) {
  const raw = String(status || "").trim();
  if (/app?roved/i.test(raw)) return "APPROVED";
  return raw.toUpperCase();
}

export function mapUmgResponse(body, httpStatus) {
  const status = normalizeStatus(body?.status);
  const informationData = body?.information_data || body?.informationData || "";
  const informationCode = body?.information_code || body?.informationCode || "";
  const classified = classifyDecline({
    status,
    informationData,
    informationCode,
    httpStatus,
  });
  return {
    ok: ["APPROVED", "CAPTURED"].includes(status),
    processor: id,
    processorTxnId: body?.id != null ? String(body.id) : null,
    processorStatus: status || "UNKNOWN",
    date: body?.date || null,
    extOrderId: body?.ext_order_id || body?.extOrderId || null,
    informationData,
    informationCode,
    descriptor: body?.descriptor || null,
    gatewayId: body?.gateway_id ?? body?.gatewayId ?? null,
    txid: body?.txid ?? null,
    httpStatus,
    cardLast4: last4(body?.card?.number) || "",
    declineClass: classified.declineClass,
    cascadeAction: classified.cascadeAction,
    reason: classified.reason,
    raw: stripSecrets(body || {}),
  };
}

async function requestJson(url, { method = "GET", headers = {}, body, timeoutMs, fetchImpl } = {}) {
  const fetchFn = fetchImpl || globalThis.fetch;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, {
      method,
      headers,
      body,
      signal: ac.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { rawText: text.slice(0, 500) }; }
    return { httpStatus: res.status, body: json };
  } catch (err) {
    // infra 2026-09-29 honest-charge: Node fetch hides the reason on err.cause.code (ECONNREFUSED, ECONNRESET, ...); keep it
    const message = err?.name === "AbortError" ? "timeout" : (err?.cause?.code || err?.message || "network_error");
    return { httpStatus: null, body: null, errorMessage: message };
  } finally {
    clearTimeout(timer);
  }
}

// audit 2026-10-02 (pay-core-8): a lost / rejected UMG credential looks to the buyer like "card not accepted" and nobody noticed.
// One [pay-alert] per kind per 10 minutes (ops-watch -> Telegram); the answer to the buyer is unchanged.
const alertedAt = new Map();
export function _resetUmgAlerts() { alertedAt.clear(); }
function umgUnavailableAlert(kind) {
  const now = Date.now();
  if (now - (alertedAt.get(kind) || 0) < 10 * 60 * 1000) return;
  alertedAt.set(kind, now);
  process.stdout.write(`[pay-alert] UMG_UNAVAILABLE ${kind}\n`);
}

export async function createPayment(input, deps = {}) {
  const secret = deps.secret !== undefined ? deps.secret : loadUmgSecret();
  if (!secret) {
    umgUnavailableAlert("secret_not_loaded");
    return {
      ok: false,
      processor: id,
      processorTxnId: null,
      processorStatus: "PROCESSOR_DOWN",
      httpStatus: null,
      informationData: "UMG_API_SECRET not loaded",
      informationCode: "",
      declineClass: "soft",
      cascadeAction: "next",
      reason: "processor_down",
      raw: {},
      cardLast4: last4(input?.card?.number),
    };
  }

  const payload = buildCreatePayload({ ...input, secret });
  const result = await requestJson(CREATE_URL, {
    method: "POST",
    headers: {
      Authorization: umgBasicHeader(secret),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
    timeoutMs: deps.timeoutMs,
    fetchImpl: deps.fetchImpl,
  });

  if (result.httpStatus === 401 || result.httpStatus === 403) umgUnavailableAlert(`http_${result.httpStatus}`);
  let previous;
  if (result.errorMessage || result.body == null) {
    const classified = classifyHttpFailure(result.httpStatus, result.errorMessage);
    previous = {
      ok: false,
      processor: id,
      processorTxnId: null,
      processorStatus: "PROCESSOR_DOWN",
      httpStatus: result.httpStatus,
      informationData: result.errorMessage || "empty_response",
      informationCode: "",
      declineClass: classified.declineClass,
      cascadeAction: "next",
      reason: classified.reason,
      raw: {},
      cardLast4: cardFingerprint(input.card).last4,
    };
  } else {
    previous = mapUmgResponse(result.body, result.httpStatus);
  }
  if (!createOutcomeUnknown(result)) {
    // infra 2026-09-29 honest-charge: a direct 2xx answer goes through the same decision table as a recovered transaction:
    // approved / DECLINED / CANCELED decide, any other status ("PROCESSING - PENDING VERIFICATION", ...) waits with its txn id.
    return result.httpStatus >= 200 && result.httpStatus < 300 && normalizeStatus(result.body?.status) ? recoveryResult(previous) : previous;
  }

  // infra 2026-09-29 honest-charge: the create call may have reached UMG and charged the card even though we got no
  // clear answer. Ask UMG by our order key before anyone treats this as "declined" (that made the customer pay twice).
  const key = String(input.extOrderId || "").slice(0, 100);
  const looked = await findByExtId(key, { ...deps, secret, knownTxnIds: input.knownTxnIds });
  if (looked.state === "found") return { ...looked.mapped, recoveredVia: "find-by-ext-id" };
  // [] proves "not charged" only when the request cannot have reached UMG; after a timeout / reset / 502 / 504 UMG may
  // still be writing the transaction, so the poller decides after 30 min.
  if (looked.state === "none" && requestNeverSent(result)) return { ...previous, noChargeConfirmed: true };
  return {
    ok: false,
    processor: id,
    processorTxnId: null,
    processorStatus: "UNKNOWN",
    httpStatus: result.httpStatus,
    informationData: result.errorMessage || previous.informationData || "unknown_outcome",
    informationCode: "",
    declineClass: "soft",
    cascadeAction: "wait",
    reason: "unknown_outcome",
    raw: {},
    cardLast4: cardFingerprint(input.card).last4,
  };
}

// infra 2026-09-29 honest-charge: no clear answer from the create call = timeout / network / 5xx / 408 / 429 / empty body /
// a 2xx without a status. A 4xx with a body is a definite refusal and keeps the old behaviour.
function createOutcomeUnknown(result) {
  if (result.errorMessage || result.body == null) return true;
  const st = result.httpStatus;
  if (st >= 500 || st === 429 || st === 408) return true;
  if (!(st >= 200 && st < 300)) return false;
  const status = normalizeStatus(result.body?.status);
  if (!status) return true;
  // an unfamiliar status without a txn id cannot be polled later: ask UMG by our key instead
  return result.body?.id == null && !KNOWN_ST.has(status);
}

// infra 2026-09-29 honest-charge: connection never established (refused / DNS), or UMG itself answered 429 with a JSON body
// (a JSON 503 can also come from a gateway in front of a request that did arrive: UNKNOWN, the poller decides).
function requestNeverSent(result) {
  if (result.errorMessage) return /ECONNREFUSED|ENOTFOUND|EAI_AGAIN/i.test(result.errorMessage);
  const b = result.body;
  return result.httpStatus === 429 && b && typeof b === "object" && !Array.isArray(b) && !("rawText" in b);
}

const APPROVED_ST = new Set(["APPROVED", "CAPTURED", "PAID"]);
const FINAL_DECLINED_ST = new Set(["DECLINED", "CANCELED", "CANCELLED"]);
const KNOWN_ST = new Set([...APPROVED_ST, ...FINAL_DECLINED_ST, "PENDING", "AWAITING FOR 3DS VERIFICATION"]);
/**
 * infra 2026-09-29 honest-charge: a transaction found by find-by-ext-id. Only approved (incl. PAID) and DECLINED / CANCELED
 * are decisions; any other status (PENDING, 3DS, "PROCESSING - PENDING VERIFICATION", new ones) keeps waiting with its txn id.
 */
export function recoveryResult(mapped) {
  const st = String(mapped.processorStatus || "").toUpperCase();
  if (APPROVED_ST.has(st)) return { ...mapped, ok: true, declineClass: null, cascadeAction: "success", reason: "approved" };
  if (FINAL_DECLINED_ST.has(st)) return mapped;
  return { ...mapped, ok: false, declineClass: null, cascadeAction: "wait", reason: "pending_or_3ds" };
}

export function findByExtIdUrl(extOrderId, secret) {
  return `${CREATE_URL}/find-by-ext-id/${encodeURIComponent(String(extOrderId))}?Authorization=${encodeURIComponent(umgAuthorizationValue(secret))}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * UMG find-by-ext-id (not in their docs; verified live 2026-09-29): always HTTP 200 with a JSON array, [] when there is
 * no such transaction. Returns { state: "found", txn, mapped (mapUmgResponse) } | { state: "none" } | { state: "unknown", reason }.
 * "none" ONLY for HTTP 200 + an empty array; anything else (error, 404, 5xx, non-array, rows that are not ours or have no id) is
 * "unknown" - never "not charged". Several rows: an approved one wins, else the highest id.
 * deps.findDelayMs (default 2000): pause first, UMG may still be writing the transaction the timed-out call created.
 */
export async function findByExtId(extOrderId, deps = {}) {
  const secret = deps.secret !== undefined ? deps.secret : loadUmgSecret();
  const key = String(extOrderId || "").slice(0, 100);
  if (!secret || !key) return { state: "unknown", reason: "missing_secret_or_key" };
  const delay = deps.findDelayMs !== undefined ? deps.findDelayMs : 2000;
  if (delay > 0) await sleep(delay);
  const r = await requestJson(findByExtIdUrl(key, secret), { method: "GET", timeoutMs: deps.findTimeoutMs || 10000, fetchImpl: deps.fetchImpl });
  if (r.errorMessage) return { state: "unknown", reason: r.errorMessage };
  if (r.httpStatus !== 200) return { state: "unknown", reason: `http_${r.httpStatus}` };
  const rows = Array.isArray(r.body) ? r.body : r.body && typeof r.body === "object" && r.body.ext_order_id != null ? [r.body] : null;
  if (!rows) return { state: "unknown", reason: "unexpected_body" };
  if (rows.length === 0) return { state: "none" };
  const mine = rows.filter((x) => x && typeof x === "object" && x.id != null && String(x.ext_order_id ?? "") === key);
  // infra 2026-09-29 honest-charge: transactions already recorded on the order (an earlier declined try under the same
  // key) are not the answer to this attempt. Only known ones left = we cannot tell -> unknown.
  const known = new Set((deps.knownTxnIds || []).map(String));
  const ours = mine.filter((x) => !known.has(String(x.id)));
  if (ours.length === 0) return { state: "unknown", reason: mine.length ? "only_known_rows" : "no_matching_row" };
  const paid = ours.find((x) => ["APPROVED", "CAPTURED", "PAID"].includes(normalizeStatus(x.status)));
  const newest = [...ours].sort((a, b) => (Number(b.id) || 0) - (Number(a.id) || 0))[0];
  const txn = paid || newest;
  return { state: "found", txn, mapped: recoveryResult(mapUmgResponse(txn, 200)) };
}

export function transactionUrl(txnId, secret) {
  const auth = umgAuthorizationValue(secret);
  return `${CREATE_URL}/${encodeURIComponent(String(txnId))}?Authorization=${encodeURIComponent(auth)}`;
}

export async function getTransaction(txnId, deps = {}) {
  const secret = deps.secret !== undefined ? deps.secret : loadUmgSecret();
  if (!secret || txnId == null) {
    return { ok: false, processor: id, processorStatus: "PROCESSOR_DOWN", reason: "missing_secret_or_id" };
  }
  const result = await requestJson(transactionUrl(txnId, secret), {
    method: "GET",
    timeoutMs: deps.timeoutMs,
    fetchImpl: deps.fetchImpl,
  });
  if (result.errorMessage || result.body == null) {
    const classified = classifyHttpFailure(result.httpStatus, result.errorMessage);
    return {
      ok: false,
      processor: id,
      processorTxnId: String(txnId),
      processorStatus: "PROCESSOR_DOWN",
      httpStatus: result.httpStatus,
      informationData: result.errorMessage || "empty_response",
      declineClass: classified.declineClass,
      cascadeAction: "wait",
      reason: classified.reason,
      raw: {},
    };
  }
  return mapUmgResponse(result.body, result.httpStatus);
}

export function createMockUmg({ scenario = "approved" } = {}) {
  return {
    id,
    label,
    async createPayment(input) {
      const last = last4(input?.card?.number);
      let chosen = scenario;
      if (last === "0002") chosen = "soft";
      if (last === "0003") chosen = "hard";
      if (last === "0005") chosen = "timeout";
      if (last === "0006") chosen = "pending";
      if (last === "4242" && scenario === "approved") chosen = "approved";

      if (chosen === "timeout") {
        return {
          ok: false,
          processor: id,
          processorTxnId: null,
          processorStatus: "PROCESSOR_DOWN",
          httpStatus: null,
          informationData: "timeout",
          informationCode: "",
          declineClass: "soft",
          cascadeAction: "next",
          reason: "timeout_or_network",
          raw: {},
          cardLast4: last,
        };
      }
      const bodies = {
        approved: { id: 9001, status: "APPROVED", date: "Sep 17, 2026 10:00:00 AM", information_data: "", descriptor: "PEPTIDESS SHOP", gateway_id: 7, txid: "TX-MOCK-OK", ext_order_id: input.extOrderId, card: { number: `424242****${last || "4242"}` } },
        soft: { id: 5136, status: "DECLINED", date: "Sep 17, 2026 10:48:13 AM", information_data: "Activity limit exceeded; Code:203", descriptor: "PEPTIDESS SHOP", gateway_id: 7, txid: null, ext_order_id: input.extOrderId, card: { number: `424242****${last || "4242"}` } },
        hard: { id: 5137, status: "DECLINED", date: "Sep 17, 2026 10:48:13 AM", information_data: "Do not honor / fraud", information_code: "05", descriptor: "PEPTIDESS SHOP", gateway_id: 7, txid: null, ext_order_id: input.extOrderId, card: { number: `411111****${last || "0003"}` } },
        pending: { id: 5138, status: "PENDING", date: "Sep 17, 2026 10:48:13 AM", information_data: "", descriptor: "PEPTIDESS SHOP", gateway_id: 7, txid: null, ext_order_id: input.extOrderId, card: { number: `424242****${last || "0006"}` } },
      };
      const http = chosen === "soft" || chosen === "hard" || chosen === "pending" || chosen === "approved" ? 201 : 201;
      return mapUmgResponse(bodies[chosen] || bodies.soft, http);
    },
    async getTransaction(txnId) {
      return mapUmgResponse({
        id: txnId,
        status: "APPROVED",
        date: "Sep 17, 2026 11:00:00 AM",
        information_data: "",
        descriptor: "PEPTIDESS SHOP",
        gateway_id: 7,
        txid: "TX-MOCK-POLL",
        ext_order_id: "poll",
      }, 200);
    },
  };
}
