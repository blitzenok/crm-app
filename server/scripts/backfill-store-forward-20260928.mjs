// audit 2026-10-02 (pay-rest-22): ONE-OFF from 2026-09-28. It rewrites the live orders.json and store.json from a snapshot read a moment before, so a rerun
// would erase whatever the services wrote in between. It refuses to run unless this exact variable is set on purpose.
if (process.env.CONFIRM_BACKFILL_STORE_FORWARD_20260928 !== "yes-rewrite-live-files") {
  console.error("refusing to run: one-off backfill of 2026-09-28 that rewrites the live orders.json and store.json (see docs/CRYPTO_CHECKOUT.md)");
  process.exit(1);
}
import { readFileSync, writeFileSync, renameSync } from "node:fs";
const { buildNotifyPayload, isDryRunOrder } = await import("/opt/crm-umg/server/lib/store-forward.js");
const SP = "/var/lib/crm-umg/store.json", OP = "/var/www/mastersol/html/MSOLPEPTIDES/orders.json";
const store = JSON.parse(readFileSync(SP, "utf8"));
const list = Array.isArray(store.orders) ? store.orders : Object.values(store.orders);
const orders = JSON.parse(readFileSync(OP, "utf8"));
const now = new Date().toISOString();
let added = 0;
for (const o of list) {
  if (String(o.status).toLowerCase() !== "approved" || o.storeForward?.sentAt) continue;
  const p = buildNotifyPayload(o, { backfill: true }).orderData;
  const qa = isDryRunOrder(o) || /^(qa|dry-run|probe)/i.test(o.customer?.email || "") || /not a real order|soft-qa|dry-run/i.test(o.notes || "") || o.descriptor === "SND";
  if (!orders.some((x) => x && x.ref === p.ref)) {
    orders.unshift({
      ref: p.ref, type: "order",
      customer: { ...p.customer, company: "" },
      shipping: { address1: p.shipping.address1, address2: "", city: p.shipping.city, state: p.shipping.state, zip: p.shipping.zip, country: p.shipping.country, method: "", cost: p.shipping.cost, label: "" },
      items: p.items.map((i) => ({ name: i.name, slug: i.slug, qty: i.qty, price: i.price, mg: i.mg })),
      subtotal: p.subtotal, shippingCost: p.shippingCost, total: p.total,
      paymentMethod: "card-umg",
      notes: (qa ? "[TEST/QA order — not a customer, do not ship] " : "") + p.notes,
      coupon: "", timestamp: p.timestamp, savedAt: now,
      status: qa ? "cancelled" : undefined,
      backfill: true, source: "umg-sidecar", test: qa || undefined,
    });
    added++;
  }
  o.storeForward = { sentAt: now, ref: p.ref, via: "backfill", emailsSuppressed: true, attempts: 0 };
}
writeFileSync(OP + ".tmp", JSON.stringify(orders, null, 2)); renameSync(OP + ".tmp", OP);
writeFileSync(SP + ".tmp", JSON.stringify(store, null, 2)); renameSync(SP + ".tmp", SP);
console.log("backfilled", added);
