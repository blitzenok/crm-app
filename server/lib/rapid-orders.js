// CRM order <-> Rapid Fulfillment mapping, push (idempotent), status sync, pollers, stock sync.
// Phase 1 (2026-09-28): test server only. Real (non-synthetic) orders are refused unless RAPID_ALLOW_REAL_ORDERS=true,
// on top of RAPID_AUTO_PUSH (default false). Only paid orders are ever eligible.
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { RapidError } from "./rapid.js";
import { humanUseBlocks } from "./human-use.js"; // 2026-09-30 human-use flag -> COMPLIANCE_HOLD
import { isCryptoVerified } from "./crypto-payment.js";
import { checkShipRegion } from "./ship-region.js"; // infra 2026-10-01 ship48

export const DEFAULT_SHIP_MAP = { express: "usps_rrd_priority", ground: "usps_evs_parcelgrnd", default: "usps_evs_parcelgrnd" };
export const ALERT_STATUSES = new Set(["rejected", "returned", "addrcorrect"]);
const FINAL = new Set(["shipped", "returned", "rejected", "cancelled"]);
export const QA_EMAIL = "qa-test+rapid@biolabsresearch.co";

const COUNTRY = {
  US: "US", USA: "US", "UNITED STATES": "US", "UNITED STATES OF AMERICA": "US", AMERICA: "US",
  CA: "CA", CANADA: "CA", GB: "GB", UK: "GB", "UNITED KINGDOM": "GB", "GREAT BRITAIN": "GB", ENGLAND: "GB",
  AU: "AU", AUSTRALIA: "AU", IL: "IL", ISRAEL: "IL", DE: "DE", GERMANY: "DE", FR: "FR", FRANCE: "FR",
  MX: "MX", MEXICO: "MX", NL: "NL", NETHERLANDS: "NL", IE: "IE", IRELAND: "IE", NZ: "NZ", "NEW ZEALAND": "NZ",
  PR: "PR", "PUERTO RICO": "PR",
};
export function countryIso2(v) {
  const k = String(v || "").trim().toUpperCase().replace(/\./g, "");
  if (!k) return null;
  if (COUNTRY[k]) return COUNTRY[k];
  return /^[A-Z]{2}$/.test(k) ? k : null;
}

const cut = (v, n) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** "YYYY-MM-DD" / "YYYY-MM-DD HH:MM:SS" in a time zone (Rapid is US Pacific). */
export function zonedParts(date, timeZone) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}`, hour: Number(p.hour), minute: Number(p.minute) };
}
export const rapidDateTime = (d) => { const z = zonedParts(d, "America/Los_Angeles"); return `${z.date} ${z.time}`; };
export const rapidDate = (d) => zonedParts(d, "America/Los_Angeles").date;

export function loadSkuMap(path) {
  if (!path || !existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const out = {};
    for (const [k, v] of Object.entries(raw || {})) if (v && (v.product_id || v.gift)) out[String(k).toLowerCase()] = v;
    return out;
  } catch {
    return {};
  }
}

export function isPaidOrder(order) {
  if (!order) return false;
  // 2026-09-28: crypto counts as paid only when verified on-chain (+ sanctions clear) and released to ready_to_ship.
  // A staff "marked paid" flag, a customer tx hash or a screenshot never qualifies.
  if (order.paymentMethod === "crypto") return isCryptoVerified(order) && (order.fulfillment?.status === "ready_to_ship" || order.fulfillment?.status === "shipped");
  return String(order.status || "").toLowerCase() === "approved";
}

export function rapidOrderNumber(order) {
  const m = String(order?.id || "").match(/(\d{1,10})$/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 9999999999 ? n : null;
}

/** Eligibility for pushing a CRM order. Synthetic QA orders bypass the real-order gate but are still built the same way. */
export function pushEligibility(order, cfg, { synthetic = false } = {}) {
  if (!order) return { ok: false, error: "not_found" };
  // 2026-09-30: a customer with a human-use flag (or an order on COMPLIANCE_HOLD / cancel & refuse) never reaches Rapid.
  if (humanUseBlocks(order)) return { ok: false, error: "compliance_hold" };
  // 2026-09-30 (Yehuda): the research-solvent / BAC gift is stopped; an order still carrying such a line is refused outright.
  if ((order.items || []).some((it) => isGiftLine(it, null))) return { ok: false, error: "gift_line_refused" };
  if (!synthetic) {
    if (!cfg.allowRealOrders) return { ok: false, error: "real_orders_disabled" };
    if (order.test === true || order.dryRun === true) return { ok: false, error: "test_order" };
    if (!isPaidOrder(order)) return { ok: false, error: "not_paid" };
  }
  if (order.fulfillment?.status === "shipped") return { ok: false, error: "already_shipped" };
  if (rapidOrderNumber(order) === null) return { ok: false, error: "no_numeric_order_id" };
  return { ok: true };
}

function address(c, customerId) {
  return {
    customer_id: cut(customerId, 10),
    firstname: cut(c.first_name || c.firstname, 48) || "-",
    surname: cut(c.last_name || c.surname, 48) || "-",
    company: cut(c.company, 64) || undefined,
    address: cut(c.address, 64),
    address2: cut(c.address2, 64) || undefined,
    town: cut(c.city, 32),
    county: cut(c.state, 32) || cut(c.city, 32),
    postcode: cut(c.zip, 12),
    country: countryIso2(c.country),
    phone: cut(c.phone, 16) || undefined,
    email: cut(c.email, 64) || undefined,
  };
}

// ---- packing-slip compliance ----------------------------------------------------------------------------
// Everything Rapid may print (product_id, product name, extra, message, custom_data) must carry only internal ids and
// neutral names (G1-S / G2-T / G3-R style). Compound / INN names are blocked here, whatever the SKU map says.
export const COMPOUND_TERMS = [
  "bpc-157", "bpc157", "bpc 157", "tb-500", "tb500", "thymosin", "thymalfasin", "nad+", "nicotinamide", "curcumin", "meriva",
  "tesamorelin", "ipamorelin", "aod-9604", "aod9604", "epithalon", "epitalon", "ghk-cu", "ghk", "copper peptide", "mots-c", "motsc",
  "kpv", "nad", "semax", "selank", "kisspeptin", "retatrutide", "tirzepatide", "semaglutide", "cagrilintide", "liraglutide", "sermorelin",
  "cjc-1295", "cjc1295", "ghrp", "hexarelin", "igf-1", "igf1", "melanotan", "pt-141", "bremelanotide", "dsip", "oxytocin",
  "5-amino-1mq", "adamax", "wolverine", "glow", "klow", "bacteriostatic", "bac water", "research solvent", "solvent", "peptide",
  // INN short forms / supplier aliases (Legal, approved 2026-09-29). Whole word only, see STANDALONE_TERMS.
  "r3ta", "reta", "sema", "tirz", "glp", "trutide",
];
/**
 * Matched as a standalone word only, case-insensitive: a letter on either side means no hit, so "Semax", "retail",
 * "Tirzah" or "semantic" pass, while "R3TA", "Reta 10mg", "R3TA10", "GLP-1" and "tirz" are blocked.
 */
export const STANDALONE_TERMS = new Set(["r3ta", "reta", "sema", "tirz", "glp", "trutide"]);
const escRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function standaloneHit(text, term) {
  return new RegExp(`(^|[^a-z])${escRe(term.toLowerCase())}($|[^a-z])`).test(String(text || "").toLowerCase());
}
const norm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9+]/g, "");
/** Terms from the SKU map keys (storefront slugs) of non-stealth products, e.g. "bpc-157-10mg" -> "bpc157". */
export function compoundTermsFor(skuMap = {}) {
  const extra = new Set();
  for (const [sku, m] of Object.entries(skuMap)) {
    if (m && (m.stealth || m.synthetic)) continue;
    const slug = sku.replace(/-\d+(\.\d+)?(mg|mcg|ml|iu|g)$/i, "");
    if (norm(slug).length >= 4) extra.add(slug);
  }
  return [...COMPOUND_TERMS, ...extra];
}
/** Returns the list of blocked terms found in any printable field of an ordersNewData payload. */
export function findCompoundLeaks(data, terms = COMPOUND_TERMS) {
  const fields = [];
  for (const p of data.products || []) fields.push(p.product_id, p.name, p.extra);
  fields.push(data.message);
  for (const kv of data.custom_data || []) fields.push(kv.key, kv.value);
  const hits = new Set();
  for (const f of fields) {
    if (f === undefined || f === null || f === "") continue;
    const lower = String(f).toLowerCase();
    const n = norm(f);
    for (const t of terms) {
      const nt = norm(t);
      if (!nt) continue;
      // short terms (kpv, ghk, nad+, glow...) must stand alone; longer ones match inside run-together text too
      const hit = STANDALONE_TERMS.has(t.toLowerCase()) ? standaloneHit(lower, t) : nt.length <= 4
        ? new RegExp(`(^|[^a-z0-9])${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^a-z0-9])`).test(lower)
        : n.includes(nt);
      if (hit) hits.add(t);
    }
  }
  return [...hits];
}
/** The free research-solvent (BAC) gift line: never on the packing slip. */
export function isGiftLine(it, m) {
  const sku = String(it?.sku || "").toLowerCase();
  return Boolean(m?.gift) || it?.gift === true || sku.startsWith("research-solvent") || /research solvent|bac water|bacteriostatic/i.test(String(it?.name || ""));
}

/** CRM order -> ordersNewData. Throws RapidError("mapping_error") listing what is missing. */
export function mapOrderToRapid(order, { cfg, skuMap = {}, prefix, source } = {}) {
  const num = rapidOrderNumber(order);
  const problems = [];
  if (num === null) problems.push("order_id");
  const c = order.customer || {};
  const addr = address(c, `BLR${num ?? ""}`);
  for (const k of ["address", "town", "postcode", "country"]) if (!addr[k]) problems.push(`customer.${k === "town" ? "city" : k === "postcode" ? "zip" : k}`);
  { const sr = checkShipRegion(c); if (!sr.ok) problems.push(`ship_region_unsupported:${sr.reason}`); }   // infra 2026-10-01 ship48: even a manual push refuses
  const priceLines = Array.isArray(order.priceCheck?.lines) ? order.priceCheck.lines : [];
  const products = [];
  const manualPack = [];
  const giftMode = cfg?.giftMode === "neutral" ? "neutral" : "omit";
  for (const it of order.items || []) {
    const sku = String(it.sku || "").trim().toLowerCase();
    const m = skuMap[sku];
    const qty = Number(it.qty) || 0;
    if (isGiftLine(it, m)) {
      // 2026-09-30 (Yehuda): the research-solvent / BAC gift is stopped. Hard refuse: never a product, insert or manual-pack line.
      problems.push(`gift_line_refused:${sku || "?"}`);
      continue;
    }
    if (!m) { problems.push(`sku:${sku || "?"}`); continue; }
    if (qty < 1) { problems.push(`qty:${sku}`); continue; }
    const pl = priceLines.find((l) => String(l.sku || "").toLowerCase() === sku);
    products.push({
      product_id: String(m.product_id).slice(0, 16),
      // only the SKU map's neutral name (or the internal id) ever reaches Rapid, never the storefront item name
      name: cut(m.name || m.product_id, 64),
      qty,
      unit_price: pl ? String(pl.unit) : undefined,
      total_price: pl ? String(pl.line) : undefined,
    });
  }
  if (!products.length) problems.push("items");
  if (problems.length) throw new RapidError("mapping_error", `order cannot be mapped: ${problems.join(", ")}`);
  const pc = order.priceCheck || {};
  const shipKey = String(pc.shipMethod || order.shipMethod || "").toLowerCase();
  const shipMap = { ...DEFAULT_SHIP_MAP, ...(cfg?.shipMap || {}) };
  const vd = pc.volumeDiscount;
  const created = new Date(order.createdAt || Date.now());
  const data = {
    order_id_prefix: prefix ?? cfg?.orderPrefix ?? 100,
    order_id: num,
    source: cut(source || cfg?.source || "biolabsresearch.co", 52),
    order_date: rapidDateTime(Number.isFinite(created.getTime()) ? created : new Date()),
    billing_address: addr,
    shipping_address: addr,
    products,
    subtotal: pc.subtotal != null ? String(pc.subtotal) : undefined,
    shipping_cost: pc.shipping != null ? String(pc.shipping) : undefined,
    // infra 2026-09-29 honest-charge: a coupon order is charged total_due; priceCheck.discount carries that discount
    // for any source (coupon or volume ladder), volumeDiscount only for the ladder, so it stays the fallback.
    discount: pc.discount && Number(pc.discount.amount) > 0 ? String(pc.discount.amount) : (vd && vd.discount ? String(vd.discount) : undefined),
    total_cost: order.amount != null ? String(order.amount) : undefined,
    paidtodate: order.amount != null ? String(order.amount) : undefined,
    currency: "USD",
    shipping_method: shipMap[shipKey] || shipMap.default,
    custom_data: [{ key: "orig_order_id", value: String(order.orderRef || order.id) }],
  };
  assertNoCompoundNames(data, skuMap);
  Object.defineProperty(data, "manualPack", { value: manualPack, enumerable: false });
  return data;
}

export function assertNoCompoundNames(data, skuMap = {}) {
  const leaks = findCompoundLeaks(data, compoundTermsFor(skuMap));
  if (leaks.length) throw new RapidError("compound_name_blocked", `packing-slip fields contain blocked names: ${leaks.join(", ")}`);
}

/** Push a CRM order (idempotent). Stores order.rapid; code 7 (already exists) counts as pushed. */
export async function pushOrderToRapid(db, orderId, { client, cfg, skuMap, synthetic = false, now = () => new Date() } = {}) {
  const order = db.getOrder(orderId) || db.getOrderByRef(orderId);
  if (!order) return { ok: false, error: "not_found" };
  // 2026-09-30 go-live: one log line per push attempt (order ref, Rapid order id or error, time). No address, name or email.
  const logPush = (result) => process.stdout.write(`[rapid] push ref=${cut(order.orderRef || order.id, 40)} env=${cfg.env} ${result} at=${now().toISOString()}\n`);
  // Test artifacts never reach the live warehouse: synthetic / test / dry-run / QA orders are refused on live.
  if (cfg.env === "live" && (synthetic || order.test === true || order.dryRun === true || order.synthetic === true || /^QA-/i.test(String(order.id || "")))) {
    logPush("refused=test_artifact_on_live");
    return { ok: false, error: "test_artifact_on_live" };
  }
  if (order.rapid && (order.rapid.status === "pushed" || order.rapid.status === "exists")) return { ok: true, reused: true, rapid: order.rapid };
  const elig = pushEligibility(order, cfg, { synthetic });
  if (!elig.ok) return { ok: false, error: elig.error };
  const at = now().toISOString();
  let data;
  try {
    data = mapOrderToRapid(order, { cfg, skuMap });
  } catch (err) {
    order.rapid = { ...(order.rapid || {}), status: "error", error: err.message, errorAt: at, env: cfg.env };
    db.upsertOrder(order);
    logPush(`error=${err.code === "compound_name_blocked" ? "compound_name_blocked" : "mapping_error"}`);
    return { ok: false, error: err.code === "compound_name_blocked" ? "compound_name_blocked" : "mapping_error", message: err.message };
  }
  try {
    const r = await client.ordersNew(data);
    if (!r.ok) throw new RapidError("rejected", "orders_new returned false");
    const fresh = db.getOrder(order.id) || order;
    fresh.rapid = {
      status: r.alreadyExists ? "exists" : "pushed", env: cfg.env, orderId: data.order_id, prefix: data.order_id_prefix,
      shippingMethod: data.shipping_method, pushedAt: at, rapidStatus: null, attempts: (order.rapid?.attempts || 0) + 1,
      manualPack: data.manualPack.length ? data.manualPack : null,
    };
    db.upsertOrder(fresh);
    logPush(`ok rapid_order=${data.order_id_prefix}-${data.order_id}${r.alreadyExists ? " (already_exists)" : ""}`);
    return { ok: true, alreadyExists: r.alreadyExists, rapid: fresh.rapid };
  } catch (err) {
    const fresh = db.getOrder(order.id) || order;
    fresh.rapid = { ...(order.rapid || {}), status: "error", error: `${err.code ?? ""} ${err.message}`.trim(), errorAt: at, env: cfg.env, attempts: (order.rapid?.attempts || 0) + 1 };
    db.upsertOrder(fresh);
    logPush(`error=${err.kind || "rapid_error"}${err.code !== undefined ? `/${err.code}` : ""}`);
    return { ok: false, error: err.kind || "rapid_error", code: err.code, message: err.message };
  }
}

/** Synthetic QA order for the test server (never a customer). */
export function syntheticTestOrder(now = new Date(), { productId = "tprod", qty = 1 } = {}) {
  const n = 100000000 + (Math.floor(now.getTime() / 1000) % 900000000); // 9 digits, unique per second
  return {
    id: `QA-${n}`,
    orderRef: `QA-RAPID-${n}`,
    test: true,
    synthetic: true,
    createdAt: now.toISOString(),
    amount: "10.00",
    currency: "USD",
    paymentMethod: "synthetic",
    status: "approved",
    priceCheck: { subtotal: "10.00", shipping: "0.00", shipMethod: "ground", lines: [{ sku: "qa-tprod", unit: "10.00", line: (10 * qty).toFixed(2) }] },
    customer: {
      first_name: "QA", last_name: "Test", email: QA_EMAIL, company: "BioLabs Research QA",
      address: "12924 Pierce Street", city: "Pacoima", state: "CA", zip: "91331", country: "US",
    },
    items: [{ sku: "qa-tprod", name: "Test Product", qty }],
    _skuMap: { "qa-tprod": { product_id: productId, name: "Test Product", synthetic: true } },
  };
}

/** Push a synthetic order straight to Rapid (not stored as a CRM order). Refused on live. */
export async function pushSyntheticTestOrder({ client, cfg, now = () => new Date(), productId, qty } = {}) {
  if (cfg.env !== "test") return { ok: false, error: "refused_on_live" };
  const o = syntheticTestOrder(now(), { productId, qty });
  const data = mapOrderToRapid(o, { cfg, skuMap: o._skuMap, prefix: cfg.testOrderPrefix });
  data.message = "QA synthetic test order - do not ship";
  data.custom_data = [{ key: "orig_order_id", value: o.orderRef }];
  assertNoCompoundNames(data, o._skuMap);
  const r = await client.ordersNew(data);
  return { ok: r.ok, alreadyExists: r.alreadyExists, orderId: data.order_id, prefix: data.order_id_prefix, origOrderId: o.orderRef, shippingMethod: data.shipping_method };
}

function shippedAtIso(shipDate, fallback) {
  // audit 2026-10-02 (r2-time-dates-timezones-20): Rapid sends a calendar date (US Pacific). 20:00-08:00 is 04:00 UTC of the NEXT day, and the
  // delivery window of the shipping email counts business days in UTC, so it started a day late. 12:00-08:00 is 20:00 UTC of the same date.
  const d = shipDate ? new Date(`${String(shipDate).slice(0, 10)}T12:00:00-08:00`) : null;
  return d && Number.isFinite(d.getTime()) ? d.toISOString() : fallback;
}

/** Apply an orders_search record (or a rejected / returns record) to the CRM order. Returns what changed. */
export function applyRapidRecord(db, order, rec, { now = () => new Date(), couriers = {}, source = "sync" } = {}) {
  const at = now().toISOString();
  const status = String(rec.status || "").toLowerCase();
  const prev = order.rapid || {};
  const next = {
    ...prev,
    rapidStatus: status || prev.rapidStatus || null,
    trackingNo: rec.trackingno || prev.trackingNo || null,
    shipDate: rec.ship_date || prev.shipDate || null,
    shipMethod: rec.ship_method || prev.shipMethod || null,
    lastSyncAt: at,
    lastSyncVia: source,
  };
  order.rapid = next;
  const changes = [];
  if (status && status !== prev.rapidStatus) changes.push(`status:${status}`);
  if (status === "shipped") {
    const carrier = couriers[next.shipMethod]?.friendly_name || couriers[next.shipMethod]?.courier || next.shipMethod || null;
    const url = couriers[next.shipMethod]?.url || null;
    if (order.fulfillment?.status !== "shipped") {
      order.fulfillment = {
        ...(order.fulfillment || {}), status: "shipped", shippable: false, blockedReason: null,
        shippedAt: shippedAtIso(next.shipDate, at), shippedBy: "rapid", carrier, trackingNumber: next.trackingNo, trackingUrl: url,
      };
      changes.push("fulfillment:shipped");
    } else if (next.trackingNo && order.fulfillment.trackingNumber !== next.trackingNo) {
      order.fulfillment = { ...order.fulfillment, trackingNumber: next.trackingNo, carrier: order.fulfillment.carrier || carrier, trackingUpdatedAt: at, trackingUpdatedBy: "rapid" };
      changes.push("tracking");
    }
  }
  if (ALERT_STATUSES.has(status) && order.rapidAlert?.type !== status) {
    order.rapidAlert = { type: status, reason: cut(rec.reason, 300) || null, at, acknowledged: false };
    changes.push(`alert:${status}`);
    process.stdout.write(`[rapid] ALERT ${status} for ${order.id}${rec.reason ? ` (${cut(rec.reason, 120)})` : ""}\n`);
  }
  order.updatedAt = at;
  db.upsertOrder(order);
  return changes;
}

// env: records pushed to the test warehouse are never matched against live results (and the other way round).
function findByRapid(db, orderId, prefix, env) {
  return db.listOrders().find((o) => o.rapid && (!env || (o.rapid.env || "test") === env) && Number(o.rapid.orderId) === Number(orderId) && Number(o.rapid.prefix ?? 0) === Number(prefix ?? 0)) || null;
}

async function courierIndex(client) {
  try { return Object.fromEntries((await client.couriersList()).map((c) => [c.code, c])); } catch { return {}; }
}

/** Status sync for every pushed CRM order that is not final. */
export async function syncPushedOrders(db, { client, now } = {}) {
  const env = client?.config?.env;
  const open = db.listOrders().filter((o) => o.rapid && (!env || (o.rapid.env || "test") === env) && (o.rapid.status === "pushed" || o.rapid.status === "exists") && !FINAL.has(o.rapid.rapidStatus));
  const out = { checked: 0, changed: 0, errors: 0 };
  if (!open.length) return out;
  const couriers = await courierIndex(client);
  for (const o of open) {
    out.checked += 1;
    try {
      const recs = await client.ordersSearch({ order_id: o.rapid.orderId, order_id_prefix: o.rapid.prefix });
      const rec = recs.find((r) => Number(r.order_id) === Number(o.rapid.orderId)) || recs[0];
      if (!rec) continue;
      if (applyRapidRecord(db, db.getOrder(o.id), rec, { now, couriers, source: "status-sync" }).length) out.changed += 1;
    } catch {
      out.errors += 1;
    }
  }
  return out;
}

/** Daily poll: orders shipped on `date` (Pacific), plus rejected / returned on that date -> flags. */
export async function pollShipped(db, { client, cfg, date, now } = {}) {
  const couriers = await courierIndex(client);
  const shipped = await client.ordersSearch({ ship_date: date, order_id_prefix: cfg.orderPrefix });
  const out = { date, shipped: shipped.length, matched: 0, changed: 0, rejected: 0, returned: 0, unmatched: 0 };
  for (const rec of shipped) {
    const o = findByRapid(db, rec.order_id, rec.order_id_prefix ?? cfg.orderPrefix, cfg.env);
    if (!o) { out.unmatched += 1; continue; }
    out.matched += 1;
    if (applyRapidRecord(db, o, rec, { now, couriers, source: "daily-shipped" }).length) out.changed += 1;
  }
  for (const rec of await client.ordersRejected(date)) {
    const o = findByRapid(db, rec.order_id, rec.order_id_prefix ?? cfg.orderPrefix, cfg.env);
    if (!o) continue;
    out.rejected += 1;
    applyRapidRecord(db, o, { status: "rejected", reason: rec.reason }, { now, couriers, source: "daily-rejected" });
  }
  for (const rec of await client.returnsList(date)) {
    const o = findByRapid(db, rec.order_id, rec.order_id_prefix ?? cfg.orderPrefix, cfg.env);
    if (!o) continue;
    out.returned += 1;
    applyRapidRecord(db, o, { status: "returned", reason: rec.reason }, { now, couriers, source: "daily-returns" });
  }
  return out;
}

/** Stock -> inventory.rapid_stock (stock_qty is never touched). */
export async function syncStock(inventory, { client, skuMap = {}, now = () => new Date() } = {}) {
  const products = await client.productsStock();
  const byProduct = {};
  for (const [sku, m] of Object.entries(skuMap)) byProduct[String(m.product_id).toUpperCase()] = { sku, ...m };
  const at = now().toISOString();
  const out = { products: products.length, updated: 0, unmatched: [] };
  for (const p of products) {
    const pid = String(p.product_id || "");
    const m = byProduct[pid.toUpperCase()];
    const code = m?.inventory_code || pid;
    const r = inventory && inventory.setRapidStock
      ? inventory.setRapidStock(code, { product_id: pid, stock: Number(p.stock) || 0, allocated: p.allocated == null ? null : Number(p.allocated), syncedAt: at })
      : { ok: false };
    if (r.ok) out.updated += 1; else out.unmatched.push(pid);
  }
  return out;
}

// ---- in-process scheduler ------------------------------------------------------------------------------
function readState(path) {
  if (!path || !existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, "utf8")) || {}; } catch { return {}; }
}
function writeState(path, state) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, JSON.stringify(state, null, 2));
  renameSync(`${path}.tmp`, path);
}

/**
 * Jobs (Asia/Jerusalem wall clock): shipped poll daily 07:15 (= after 9pm Pacific), retry every 15 min on failure
 * (max 4 retries); stock sync daily 07:30; status sync of pushed orders every 60 min. tick() is called each minute.
 */
export function createRapidScheduler({ db, inventory, client, cfg, skuMap = () => ({}), statePath = null, now = () => new Date(), tz = "Asia/Jerusalem", log = (m) => process.stdout.write(`${m}\n`) } = {}) {
  const state = { shipped: {}, stock: {}, status: {}, ...readState(statePath) };
  let running = false;
  const save = () => writeState(statePath, state);
  const due = (job, hh, mm, t) => {
    const z = zonedParts(t, tz);
    const s = state[job];
    if (s.retryAt && t.getTime() >= Date.parse(s.retryAt)) return true;
    if (s.lastOkDate === z.date || s.gaveUpDate === z.date) return false;
    if (s.retryAt) return false;
    return z.hour * 60 + z.minute >= hh * 60 + mm && s.lastAttemptDate !== z.date;
  };
  async function runJob(job, fn, t) {
    const z = zonedParts(t, tz);
    const s = state[job];
    s.lastAttemptDate = z.date;
    s.lastAttemptAt = t.toISOString();
    try {
      const result = await fn();
      Object.assign(s, { lastOkDate: z.date, lastOkAt: t.toISOString(), lastResult: result, retryAt: null, retries: 0, lastError: null });
      log(`[rapid] ${job} ok ${JSON.stringify(result)}`);
    } catch (err) {
      s.retries = (s.retries || 0) + 1;
      s.lastError = `${err?.code ?? ""} ${err?.message || err}`.trim();
      if (s.retries <= 4) s.retryAt = new Date(t.getTime() + 15 * 60 * 1000).toISOString();
      else { s.retryAt = null; s.gaveUpDate = z.date; s.retries = 0; }
      log(`[rapid] ${job} failed (${s.lastError}); ${s.retryAt ? `retry at ${s.retryAt}` : "giving up for today"}`);
    }
    save();
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      const t = now();
      if (due("shipped", 7, 15, t)) await runJob("shipped", () => pollShipped(db, { client, cfg, date: rapidDate(t), now }), t);
      if (due("stock", 7, 30, t)) await runJob("stock", () => syncStock(inventory, { client, skuMap: skuMap(), now }), t);
      const last = state.status.lastAttemptAt ? Date.parse(state.status.lastAttemptAt) : 0;
      if (t.getTime() - last >= 60 * 60 * 1000) {
        state.status.lastAttemptAt = t.toISOString();
        try { state.status.lastResult = await syncPushedOrders(db, { client, now }); state.status.lastError = null; }
        catch (err) { state.status.lastError = err?.message || String(err); }
        save();
      }
    } finally {
      running = false;
    }
  }
  return {
    tick,
    state: () => JSON.parse(JSON.stringify(state)),
    runShippedNow: (date) => pollShipped(db, { client, cfg, date: date || rapidDate(now()), now }),
    runStockNow: () => syncStock(inventory, { client, skuMap: skuMap(), now }),
    runStatusNow: () => syncPushedOrders(db, { client, now }),
    start(intervalMs = 60000) {
      const h = setInterval(() => { tick().catch(() => {}); }, intervalMs);
      h.unref?.();
      return h;
    },
  };
}
