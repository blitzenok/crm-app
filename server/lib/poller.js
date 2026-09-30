import { applyProcessorUpdate, applyProcessorUpdateByOrder } from "./cascade.js";
import { ADAPTERS } from "./cascade.js";
import { logSafe } from "./sanitize.js";

// infra 2026-09-29 honest-charge: how long UMG gets to show a transaction before "not found" is believed.
export const UNKNOWN_GRACE_MS = 30 * 60 * 1000;
// One alert line per order per process (the poller runs every 30 s).
const alerted = new Set();

/**
 * Attempts the create call never got an answer for (reason unknown_outcome, no txn id): ask UMG by our order key.
 *  found            -> apply its status (approved / declined / ...) and store the txn id
 *  HTTP 200 + []    -> "not charged", but only once the attempt is >= 30 min old; before that the order stays pending
 *  anything else    -> stays pending; older than 30 min it is logged once as [pay-alert] UNKNOWN_OUTCOME
 */
async function pollUnknown(store, processor, adapter, deps, results) {
  if (typeof adapter.findByExtId !== "function" || typeof store.unknownAttempts !== "function") return;
  const now = deps.now ? deps.now() : Date.now();
  const log = deps.log || ((line) => process.stdout.write(`${line}\n`));
  for (const { orderId, idempotencyKey, attempt, knownTxnIds } of store.unknownAttempts(processor)) {
    const ageMs = now - (Date.parse(attempt.startedAt) || now);
    try {
      // no pause here (the 2 s wait is for the call that just timed out); the 30 min rule below covers UMG lag
      const looked = await adapter.findByExtId(idempotencyKey, { findDelayMs: 0, knownTxnIds, ...(deps.processorDeps?.[processor] || {}) });
      if (looked.state === "found") {
        const m = looked.mapped;
        const order = applyProcessorUpdateByOrder(store, {
          orderId, attemptId: attempt.attemptId, processor,
          processorTxnId: m.processorTxnId, status: m.processorStatus, body: m.raw, reason: "recovered_by_find",
        });
        results.push({ processor, orderId, found: true, status: order?.lastStatus || null });
      } else if (ageMs >= UNKNOWN_GRACE_MS && (looked.state === "none" || (looked.state === "unknown" && looked.reason === "only_known_rows"))) {
        // [] , or only transactions this order already had (an earlier declined try): no new charge exists
        const order = applyProcessorUpdateByOrder(store, {
          orderId, attemptId: attempt.attemptId, processor,
          status: "NOT_CHARGED", body: {}, reason: "not_charged_verified",
        });
        // the customer was told "do not pay again": staff must know the order was verified as never charged
        log(`[pay-alert] NOT_CHARGED_VERIFIED ${logSafe(orderId, 40)} ${logSafe(idempotencyKey, 80)}`);
        results.push({ processor, orderId, found: false, status: order?.lastStatus || null });
      } else {
        if (ageMs >= UNKNOWN_GRACE_MS && !alerted.has(orderId)) {
          alerted.add(orderId);
          log(`[pay-alert] UNKNOWN_OUTCOME ${logSafe(orderId, 40)} ${logSafe(idempotencyKey, 80)} since ${logSafe(attempt.startedAt, 40)}`);
        }
        results.push({ processor, orderId, waiting: true });
      }
    } catch (err) {
      results.push({ processor, orderId, error: err?.message || "find_failed" });
    }
  }
}

export async function pollPending(store, deps = {}) {
  const adapters = deps.adapters || ADAPTERS;
  const processors = deps.processors || ["umg"];
  const results = [];
  for (const processor of processors) {
    const adapter = adapters[processor];
    if (!adapter || typeof adapter.getTransaction !== "function") continue;
    await pollUnknown(store, processor, adapter, deps, results);
    const pending = store.pendingAttempts(processor);
    for (const { attempt } of pending) {
      if (!attempt.processorTxnId) continue;
      try {
        const fresh = await adapter.getTransaction(attempt.processorTxnId, deps.processorDeps?.[processor] || {});
        const order = applyProcessorUpdate(store, {
          processor,
          processorTxnId: attempt.processorTxnId,
          status: fresh.processorStatus,
          body: fresh.raw || fresh,
        });
        results.push({
          processor,
          processorTxnId: attempt.processorTxnId,
          status: fresh.processorStatus,
          orderId: order?.id || null,
        });
      } catch (err) {
        results.push({
          processor,
          processorTxnId: attempt.processorTxnId,
          error: err?.message || "poll_failed",
        });
      }
    }
  }
  return results;
}

/**
 * infra 2026-09-29 honest-charge: at process start nothing can still be charging, so an order left inFlight was cut off by a
 * restart mid-charge (UMG may or may not have charged). Turn it into a pending order with an unknown UMG attempt, and the
 * poller settles it through find-by-ext-id. minAgeMs (default 0) only exists for callers that run this while serving.
 */
export function recoverInFlight(store, { now = Date.now(), minAgeMs = 0, log = (l) => process.stdout.write(`${l}\n`) } = {}) {
  let n = 0;
  for (const o of store.listOrders()) {
    if (!o.inFlight || o.paymentMethod === "crypto") continue;
    if (now - (Date.parse(o.updatedAt || o.createdAt) || 0) < minAgeMs) continue;
    const fresh = store.getOrder(o.id);
    const startedAt = new Date(now).toISOString();
    fresh.attempts = [...(fresh.attempts || []), {
      // own id and startedAt = now: the 30 min window counts from the recovery and the id cannot clash with the first attempt
      attemptId: `umg-recovered-${startedAt}`, processor: "umg", startedAt, finishedAt: new Date(now).toISOString(),
      processorTxnId: null, processorStatus: "UNKNOWN", declineClass: "soft", cascadeAction: "wait", reason: "unknown_outcome",
      informationData: "process_restarted_mid_charge", raw: {},
    }];
    fresh.inFlight = false;
    fresh.status = "pending";
    fresh.updatedAt = new Date(now).toISOString();
    store.upsertOrder(fresh);
    log(`[pay-alert] RECOVERED_INFLIGHT ${fresh.id}`);
    n += 1;
  }
  return n;
}

export function startPoller(store, { intervalMs = 30000, adapters } = {}) {
  let running = false; // infra 2026-09-29 honest-charge: a slow pass (10 s find timeouts) must not overlap the next tick
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    pollPending(store, { adapters }).catch(() => {}).finally(() => { running = false; });
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}
