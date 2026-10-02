// 2026-10-01 (Yehuda: no statement descriptor anywhere): the order object in a /api/checkout/charge answer goes to the
// browser, so no descriptor field may reach it. The top-level statementDescriptor stays (it follows UMG_DESCRIPTOR, now UNKNOWN = null).
// audit 2026-10-02: the descriptor black list let everything else through (attempts[] with processor txn ids and raw processor answers,
// idempotencyKey, cardKey, buyer data, consent, hold reasons). The order in the answer is now a WHITE list: only what the storefront
// reads (checkout-charge.js: order.status for approved / declined, order.id for the BLR number and orderId). The stored order is not touched.
// order.winningTxnId (processor txn id, the old first choice of the page's orderPublicId) is deliberately NOT public: the page falls back to order.id.
const PUBLIC_ORDER_KEYS = ["id", "status", "amount", "currency"];

export function publicChargeBody(body) {
  if (!body || typeof body !== "object" || !body.order || typeof body.order !== "object") return body;
  const order = {};
  for (const k of PUBLIC_ORDER_KEYS) if (body.order[k] !== undefined) order[k] = body.order[k];
  return { ...body, order };
}
