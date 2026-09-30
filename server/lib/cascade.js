import { cardFingerprint, stripSecrets } from "./sanitize.js";
import { formatAmount } from "./card.js";
import * as umg from "./processors/umg.js";
import * as tagada from "./processors/tagada.js";
import * as centrobill from "./processors/centrobill.js";

export const ADAPTERS = {
  umg,
  tagada,
  centrobill,
};

const APPROVED = new Set(["APPROVED", "CAPTURED", "PAID"]);
const WAIT = new Set(["PENDING", "AWAITING FOR 3DS VERIFICATION"]);

function nowIso() {
  return new Date().toISOString();
}

function enabledQueue(settings) {
  const kill = settings.killSwitchPsp;
  let list = (settings.processors || []).filter((p) => p && p.enabled && p.mode !== "off");
  if (kill) list = list.filter((p) => p.id === kill);
  return list.sort((a, b) => (a.priority || 99) - (b.priority || 99));
}

function attemptFromResult({ processor, mode, priority, startedAt, result, card }) {
  const finishedAt = nowIso();
  const fp = cardFingerprint(card);
  return {
    attemptId: `${processor}-${startedAt}`,
    processor,
    priority,
    mode,
    startedAt,
    finishedAt,
    latencyMs: Date.parse(finishedAt) - Date.parse(startedAt),
    httpStatus: result.httpStatus ?? null,
    processorTxnId: result.processorTxnId ?? null,
    processorStatus: result.processorStatus || "UNKNOWN",
    date: result.date || null,
    extOrderId: result.extOrderId || null,
    informationData: result.informationData || "",
    informationCode: result.informationCode || "",
    descriptor: result.descriptor || null,
    gatewayId: result.gatewayId ?? null,
    txid: result.txid ?? null,
    cardLast4: result.cardLast4 || fp.last4,
    cardBrand: fp.brand || fp.type || "",
    declineClass: result.declineClass,
    cascadeAction: result.cascadeAction,
    reason: result.reason || "",
    errorMessage: result.errorMessage || "",
    // infra 2026-09-29 honest-charge: set by the UMG adapter when find-by-ext-id proved the card was not charged
    ...(result.noChargeConfirmed ? { noChargeConfirmed: true } : {}),
    raw: stripSecrets(result.raw || {}),
  };
}

function applyAttemptToOrder(order, attempt) {
  order.attempts = [...(order.attempts || []), attempt];
  order.updatedAt = nowIso();
  order.lastProcessor = attempt.processor;
  order.lastStatus = attempt.processorStatus;
  if (APPROVED.has(String(attempt.processorStatus).toUpperCase())) {
    order.status = "approved";
    order.winningProcessor = attempt.processor;
    order.winningTxnId = attempt.processorTxnId;
    order.descriptor = attempt.descriptor;
  } else if (WAIT.has(String(attempt.processorStatus).toUpperCase()) || attempt.cascadeAction === "wait") {
    order.status = "pending";
    order.winningProcessor = attempt.processor;
    order.winningTxnId = attempt.processorTxnId;
  } else if (attempt.cascadeAction === "stop") {
    order.status = "declined";
  } else {
    order.status = "cascading";
  }
  return order;
}

export function resolveQueue(settings) {
  return enabledQueue(settings);
}

export async function chargeCart(input, deps) {
  const store = deps.store;
  const adapters = deps.adapters || ADAPTERS;
  const settings = deps.settings || store.getSettings();
  const key = String(input.idempotencyKey || input.extOrderId || "").trim();
  if (!key) {
    return { ok: false, error: "idempotency_key_required" };
  }

  const existing = store.getOrderByIdempotency(key);
  if (existing && APPROVED.has(String(existing.status).toUpperCase())) {
    return { ok: true, reused: true, order: existing };
  }
  if (existing && existing.status === "pending") {
    return { ok: true, reused: true, order: existing };
  }
  if (existing && existing.inFlight) {
    return { ok: true, reused: true, order: existing };
  }

  const queue = enabledQueue(settings);
  // Server-side price (index.js passes input.pricing when card pricing is on): charge the catalog amount, keep the
  // browser's figure for the record.
  const pricing = input.pricing && input.pricing.ok ? input.pricing : null;
  const priceFields = pricing
    ? {
        amount: formatAmount(pricing.amount),
        clientAmount: pricing.clientAmount,
        priceMismatch: Boolean(pricing.mismatch),
        priceCheck: {
          source: pricing.source,
          clientAmount: pricing.clientAmount,
          serverAmount: pricing.amount,
          subtotal: pricing.subtotal,
          shipping: pricing.shipping,
          shipMethod: pricing.shipMethod,
          mismatch: Boolean(pricing.mismatch),
          lines: pricing.lines,
          volumeDiscount: pricing.volumeDiscount || null,
          // infra 2026-09-29 honest-charge: coupon / discount come from products-api coupon-quote; emails and store-forward read them
          coupon: pricing.coupon || "",
          discount: pricing.discount || null,
        },
      }
    : {};
  const order = existing || {
    id: store.nextOrderId(),
    idempotencyKey: key,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    status: "new",
    inFlight: true,
    amount: formatAmount(input.amount),
    currency: "USD", // infra 2026-09-29 cleffo: USD only (the charge route refuses any other currency before this point)
    customer: stripSecrets({
      first_name: input.customer?.first_name || input.customer?.firstName || "",
      last_name: input.customer?.last_name || input.customer?.lastName || "",
      email: input.customer?.email || "",
      phone: input.customer?.phone || "",
      country: input.customer?.country || "",
      state: input.customer?.state || "",
      city: input.customer?.city || "",
      zip: input.customer?.zip || "",
      address: input.customer?.address || "",
    }),
    items: Array.isArray(input.items) ? input.items : [],
    notes: input.notes || "",
    session_id: String(input.session_id || input.sessionId || "").trim(),
    winningProcessor: null,
    winningTxnId: null,
    descriptor: null,
    lastProcessor: null,
    lastStatus: null,
    attempts: [],
  };
  if (pricing) Object.assign(order, priceFields);

  order.inFlight = true;
  store.upsertOrder(order);

  if (queue.length === 0) {
    order.inFlight = false;
    order.status = "declined";
    order.lastStatus = "NO_PROCESSOR";
    store.upsertOrder(order);
    return { ok: false, order: store.getOrder(order.id), error: "no_enabled_processor" };
  }

  for (const psp of queue) {
    const adapter = adapters[psp.id];
    const startedAt = nowIso();
    let result;
    try {
      if (!adapter || typeof adapter.createPayment !== "function") {
        result = {
          ok: false,
          processor: psp.id,
          processorStatus: "PROCESSOR_DOWN",
          informationData: "adapter_missing",
          declineClass: "soft",
          cascadeAction: "next",
          reason: "processor_down",
          raw: {},
        };
      } else {
        result = await adapter.createPayment({
          customer: input.customer,
          card: input.card,
          amount: order.amount,
          currency: order.currency,
          extOrderId: key,
          // infra 2026-09-29 honest-charge: txn ids this order already has, so find-by-ext-id can tell a new charge from an old one
          knownTxnIds: (order.attempts || []).map((a) => a.processorTxnId).filter(Boolean).map(String),
          subscriptionStatus: input.subscriptionStatus,
        }, deps.processorDeps?.[psp.id] || {});
      }
    } catch (err) {
      result = {
        ok: false,
        processor: psp.id,
        processorStatus: "PROCESSOR_DOWN",
        informationData: err?.message || "adapter_throw",
        declineClass: "soft",
        cascadeAction: "next",
        reason: "processor_down",
        raw: {},
      };
    }

    const attempt = attemptFromResult({
      processor: psp.id,
      mode: psp.mode,
      priority: psp.priority,
      startedAt,
      result,
      card: input.card,
    });
    applyAttemptToOrder(order, attempt);
    store.upsertOrder(order);

    if (attempt.cascadeAction === "success" || APPROVED.has(String(attempt.processorStatus).toUpperCase())) {
      order.inFlight = false;
      order.status = "approved";
      store.upsertOrder(order);
      return { ok: true, order: store.getOrder(order.id) };
    }
    if (attempt.cascadeAction === "wait") {
      order.inFlight = false;
      order.status = "pending";
      store.upsertOrder(order);
      return { ok: true, pending: true, order: store.getOrder(order.id) };
    }
    if (attempt.cascadeAction === "stop" || attempt.declineClass === "hard") {
      order.inFlight = false;
      order.status = "declined";
      store.upsertOrder(order);
      return { ok: false, hardDecline: true, order: store.getOrder(order.id) };
    }
  }

  order.inFlight = false;
  order.status = "declined";
  store.upsertOrder(order);
  return { ok: false, exhausted: true, order: store.getOrder(order.id) };
}

export function applyProcessorUpdate(store, { processor, processorTxnId, status, body }) {
  const found = store.findAttempt(processor, processorTxnId);
  if (!found) return null;
  const order = found.order;
  const idx = order.attempts.findIndex((a) => a.attemptId === found.attempt.attemptId);
  if (idx === -1) return null;
  return settleAttempt(store, order, idx, { processor, processorTxnId, status, body });
}

/**
 * infra 2026-09-29 honest-charge: same update, but for an attempt that has no txn id yet (create timed out, then
 * find-by-ext-id found or ruled out the charge). Located by order id + attempt id; the txn id, when known, is stored.
 */
export function applyProcessorUpdateByOrder(store, { orderId, attemptId, processor, processorTxnId, status, body, reason }) {
  const order = store.getOrder(orderId);
  if (!order) return null;
  const idx = (order.attempts || []).findIndex((a) => a.attemptId === attemptId);
  if (idx === -1) return null;
  return settleAttempt(store, order, idx, { processor, processorTxnId, status, body, reason });
}

function settleAttempt(store, order, idx, { processor, processorTxnId, status, body, reason }) {
  const nextStatus = String(status || body?.status || order.attempts[idx].processorStatus).toUpperCase();
  const attempt = {
    ...order.attempts[idx],
    processorStatus: nextStatus === "APPORVED" ? "APPROVED" : nextStatus,
    date: body?.date || order.attempts[idx].date,
    informationData: body?.information_data || body?.informationData || order.attempts[idx].informationData,
    informationCode: body?.information_code || body?.informationCode || order.attempts[idx].informationCode,
    descriptor: body?.descriptor || order.attempts[idx].descriptor,
    gatewayId: body?.gateway_id ?? body?.gatewayId ?? order.attempts[idx].gatewayId,
    txid: body?.txid ?? order.attempts[idx].txid,
    raw: stripSecrets({ ...(order.attempts[idx].raw || {}), ...(body || {}) }),
    polledAt: nowIso(),
    ...(processorTxnId != null ? { processorTxnId: String(processorTxnId) } : {}),
    ...(reason ? { reason } : {}),
  };
  if (["APPROVED", "CAPTURED", "PAID"].includes(attempt.processorStatus)) { // infra 2026-09-29 honest-charge: PAID too
    attempt.cascadeAction = "success";
    attempt.declineClass = null;
    order.status = "approved";
    order.winningProcessor = processor;
    order.winningTxnId = String(processorTxnId);
    order.descriptor = attempt.descriptor;
  } else if (["DECLINED", "CANCELED", "CANCELLED", "NOT_CHARGED"].includes(attempt.processorStatus)) {
    order.status = order.status === "approved" ? order.status : "declined";
  } else if (["REFUNDED", "CHARGEBACK"].includes(attempt.processorStatus)) {
    order.status = attempt.processorStatus.toLowerCase();
  }
  // infra 2026-09-29 honest-charge: a txn id found later by find-by-ext-id also becomes the order's winning txn id
  if (processorTxnId != null && !order.winningTxnId && order.status === "pending") order.winningTxnId = String(processorTxnId);
  order.attempts[idx] = attempt;
  order.updatedAt = nowIso();
  order.lastStatus = attempt.processorStatus;
  store.upsertOrder(order);
  return store.getOrder(order.id);
}
