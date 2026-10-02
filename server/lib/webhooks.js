import { applyProcessorUpdate, ADAPTERS } from "./cascade.js";

export function readWebhookIds(body = {}) {
  const id = body.ID ?? body.id ?? body.Id ?? body.transaction_id ?? body.transactionId;
  const status = body.Status ?? body.status ?? body.STATUS;
  return {
    processorTxnId: id != null ? String(id) : null,
    status: status != null ? String(status) : null,
  };
}

// audit 2026-10-02: the webhook is not signed, so anyone who knows a transaction number could send "APPROVED" / "REFUNDED"
// and move the order. Treat it only as a "go and check" signal: take the transaction number from the body, ask the
// processor itself (getTransaction, our secret) and apply that answer, exactly like the poller does. Status and every
// other body field are never used. HTTP code stays 200 for all outcomes (the caller sees only ok/error).
export async function handleProcessorWebhook(store, processor, body, deps = {}) {
  const { processorTxnId } = readWebhookIds(body);
  if (!processorTxnId) {
    return { ok: false, error: "missing_transaction_id" };
  }
  // unknown number: no call to the processor, and the sent value is not echoed back
  if (!store.findAttempt(processor, processorTxnId)) {
    return { ok: false, error: "unknown_transaction" };
  }
  const adapter = (deps.adapters || ADAPTERS)[processor];
  if (!adapter || typeof adapter.getTransaction !== "function") {
    return { ok: false, error: "verification_unavailable" };
  }
  let fresh;
  try {
    fresh = await adapter.getTransaction(processorTxnId, deps.processorDeps?.[processor] || {});
  } catch {
    return { ok: false, error: "verification_unavailable" };
  }
  // Not `ok === false`: umg maps ok:true only for APPROVED/CAPTURED, so DECLINED/REFUNDED answers carry ok:false too.
  // A failed lookup is the PROCESSOR_DOWN shape (or no status at all); the poller picks those orders up later.
  if (!fresh || !fresh.processorStatus || fresh.processorStatus === "PROCESSOR_DOWN") {
    return { ok: false, error: "verification_unavailable" };
  }
  const order = applyProcessorUpdate(store, {
    processor, processorTxnId, status: fresh.processorStatus, body: fresh.raw || fresh,
  });
  if (!order) {
    return { ok: false, error: "unknown_transaction" };
  }
  return { ok: true, orderId: order.id, status: order.status, processorStatus: fresh.processorStatus };
}
