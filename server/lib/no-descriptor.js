// 2026-10-01 (Yehuda: no statement descriptor anywhere): the order object in a /api/checkout/charge answer goes to the
// browser, so every descriptor field the processor echoed (order.descriptor, attempts[].descriptor, ...) is removed from a
// copy. The stored order is not touched. The top-level statementDescriptor stays (it follows UMG_DESCRIPTOR, now UNKNOWN = null).
const DESC_KEYS = new Set(["descriptor", "statementdescriptor", "statement_descriptor", "descriptortext"]);

function scrub(v) {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, x] of Object.entries(v)) if (!DESC_KEYS.has(k.toLowerCase())) out[k] = scrub(x);
    return out;
  }
  return v;
}

export function publicChargeBody(body) {
  if (!body || typeof body !== "object" || !body.order || typeof body.order !== "object") return body;
  return { ...body, order: scrub(JSON.parse(JSON.stringify(body.order))) };
}
