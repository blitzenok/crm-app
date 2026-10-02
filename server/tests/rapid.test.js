import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";
import { createInventoryStore } from "../lib/inventory.js";
import { buildEnvelope, createRapidClient, parseResponse, rapidConfig, RapidError, RAPID_ENDPOINTS } from "../lib/rapid.js";
import {
  COMPOUND_TERMS, findCompoundLeaks, loadSkuMap,
  applyRapidRecord, countryIso2, createRapidScheduler, isPaidOrder, mapOrderToRapid, pollShipped, pushEligibility,
  pushOrderToRapid, pushSyntheticTestOrder, rapidDate, syncPushedOrders, syncStock,
} from "../lib/rapid-orders.js";
import { startCrmServer } from "../index.js";

const KEY = "test-marketing-digest-key";
const ENV = { RAPID_ENABLED: "true", RAPID_ENV: "test", RAPID_TEST_API_USER: "u", RAPID_TEST_API_PASS: "p<&>", RAPID_TEST_TLS_INSECURE: "true", RAPID_RETRIES: "2" };
const cfgOf = (extra = {}) => rapidConfig({ ...ENV, ...extra });
const ENVELOPE = (inner) => `<?xml version="1.0" encoding="UTF-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:WF" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><SOAP-ENV:Body>${inner}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
const ok = (method, part, body) => ENVELOPE(`<ns1:${method}Response>${part ? `<${part}${body}` : ""}</ns1:${method}Response>`);
const fault = (code, msg) => ENVELOPE(`<SOAP-ENV:Fault><faultcode>${code}</faultcode><faultstring>${msg}</faultstring></SOAP-ENV:Fault>`);
const bool = (m, v = true) => ok(m, "result", ` xsi:type="xsd:boolean">${v}</result>`);
const COURIERS = ok("couriers_list", "methods", ` SOAP-ENC:arrayType="ns1:couriersListData[2]" xsi:type="ns1:couriersListDataArray"><item xsi:type="ns1:couriersListData"><code xsi:type="xsd:string">blank</code><courier xsi:type="xsd:string">Blank</courier><friendly_name xsi:nil="true"/></item><item xsi:type="ns1:couriersListData"><code xsi:type="xsd:string">usps_rrd_priority</code><courier xsi:type="xsd:string">USPS</courier><friendly_name xsi:type="xsd:string">USPS RRD Priority</friendly_name><url xsi:type="xsd:string">https://tools.usps.com/</url></item></methods>`);
const STOCK = ok("products_stock", "products", ` SOAP-ENC:arrayType="ns1:productsStockData[2]" xsi:type="ns1:productsStockDataArray"><item xsi:type="ns1:productsStockData"><product_id xsi:type="xsd:string">RC06-10</product_id><name xsi:type="xsd:string">RC-06 10mg vial</name><stock xsi:type="xsd:int">42</stock><allocated xsi:type="xsd:int">2</allocated></item><item xsi:type="ns1:productsStockData"><product_id xsi:type="xsd:string">tprod</product_id><name xsi:type="xsd:string">Test Product</name><stock xsi:type="xsd:int">0</stock></item></products>`);
const searchResp = (recs) => ok("orders_search", "orders", ` SOAP-ENC:arrayType="ns1:ordersSearchData[${recs.length}]" xsi:type="ns1:ordersSearchDataArray">${recs.map((r) => `<item xsi:type="ns1:ordersSearchData">${Object.entries(r).map(([k, v]) => `<${k} xsi:type="xsd:${k === "order_id" || k === "order_id_prefix" ? "int" : "string"}">${v}</${k}>`).join("")}</item>`).join("")}</orders>`);

/** Mock SOAP server: handlers[method](xml, n) -> response text | Error. Records every call. */
function mockTransport(handlers) {
  const calls = [];
  const fn = async (url, xml, opts) => {
    const method = xml.match(/<ns1:(\w+)>/)[1];
    calls.push({ url, method, xml, opts });
    const n = calls.filter((c) => c.method === method).length;
    const h = handlers[method];
    if (!h) return { status: 200, text: fault(2, "Invalid Path") };
    const out = await h(xml, n);
    if (out instanceof Error) throw out;
    return { status: 200, text: out };
  };
  fn.calls = calls;
  fn.count = (m) => calls.filter((c) => c.method === m).length;
  return fn;
}
const baseHandlers = (extra = {}) => ({ login: () => ok("login", "sessionId", ` xsi:type="xsd:string">S1</sessionId>`), couriers_list: () => COURIERS, products_stock: () => STOCK, ...extra });
const client = (t, extra) => createRapidClient({ config: cfgOf(extra), transport: t, sleep: async () => {} });

const SKU_MAP = { "bpc-157-10mg": { product_id: "RC06-10", name: "RC-06 10mg vial", internal_id: "RC-06", inventory_code: "RC06-10" }, "research-solvent-10ml": { gift: true, internal_id: "GIFT-01" } };
const paidCard = (over = {}) => ({
  id: "BLR-1042", createdAt: "2026-09-28T10:00:00.000Z", status: "approved", amount: "169.09", currency: "USD",
  customer: { first_name: "Ada", last_name: "Lovelace", email: "ada@lab.example", phone: "5551234567", address: "1 Main St", city: "Austin", state: "TX", zip: "78701", country: "USA" },
  items: [{ sku: "bpc-157-10mg", name: "BPC-157 10mg", qty: 2, amount: "79.00" }], // 2026-09-30: the BAC gift is stopped (no gift line)
  priceCheck: { subtotal: "158.00", shipping: "18.99", shipMethod: "express", volumeDiscount: { pct: 5, discount: "7.90" }, lines: [{ sku: "bpc-157-10mg", qty: 2, unit: "79.00", line: "158.00" }] },
  ...over,
});

test("envelope: rpc/encoded, typed parts, arrays with arrayType, escaping", () => {
  const x = buildEnvelope("orders_new", { sessionId: "S&1", ordersData: { order_id: 5, order_id_prefix: 100, source: "a<b", products: [{ product_id: "X", name: "N", qty: 2 }], custom_data: [{ key: "orig_order_id", value: "CR-1" }] } });
  assert.match(x, /<ns1:orders_new><sessionId xsi:type="xsd:string">S&amp;1<\/sessionId>/);
  assert.match(x, /<ordersData xsi:type="ns1:ordersNewData"><order_id_prefix xsi:type="xsd:int">100<\/order_id_prefix><order_id xsi:type="xsd:int">5<\/order_id><source xsi:type="xsd:string">a&lt;b<\/source>/);
  assert.match(x, /<products SOAP-ENC:arrayType="ns1:ordersProductsData\[1\]" xsi:type="ns1:ordersProductsDataArray"><item xsi:type="ns1:ordersProductsData"><product_id/);
  assert.match(x, /<custom_data SOAP-ENC:arrayType="ns1:associativeEntity\[1\]"/);
  assert.throws(() => buildEnvelope("orders_cancel", { sessionId: "s", order_id: "abc" }), RapidError);
});

test("response parsing: arrays, nil, ints, faults with numeric codes", () => {
  const cs = parseResponse(COURIERS, "couriers_list");
  assert.equal(cs.length, 2);
  assert.equal(cs[0].friendly_name, null);
  assert.equal(cs[1].code, "usps_rrd_priority");
  assert.equal(parseResponse(STOCK)[0].stock, 42);
  assert.deepEqual(parseResponse(ok("couriers_list", "methods", ` SOAP-ENC:arrayType="ns1:couriersListData[0]" xsi:type="ns1:couriersListDataArray"/>`)), []);
  assert.equal(parseResponse(bool("orders_new")), true);
  assert.throws(() => parseResponse(fault(3, "Session Expired")), (e) => e instanceof RapidError && e.code === 3 && e.kind === "session_expired");
  assert.throws(() => parseResponse(fault(100, "Order has already been processed")), (e) => e.code === 100 && /processed/.test(e.message));
});

test("client: login once, re-login on session expiry, retries network errors, code 7 = success, code 6 = []", async () => {
  let expired = true;
  const t = mockTransport(baseHandlers({
    couriers_list: () => { if (expired) { expired = false; return fault(3, "Session Expired"); } return COURIERS; },
    orders_new: () => fault(7, "Already Exists"),
    orders_search: (x, n) => (n === 1 ? Object.assign(new Error("reset"), { code: "ECONNRESET" }) : fault(6, "Not Found")),
    orders_cancel: () => bool("orders_cancel"),
  }));
  const c = client(t);
  assert.equal((await c.couriersList()).length, 2);
  assert.equal(t.count("login"), 2);
  assert.ok(t.calls[0].xml.includes("p&lt;&amp;&gt;"));
  assert.equal(t.calls[0].url, RAPID_ENDPOINTS.test);
  assert.equal(t.calls[0].opts.insecure, true);
  assert.deepEqual(await c.ordersNew({ order_id: 1, source: "x", order_date: "d", billing_address: {}, products: [] }), { ok: true, alreadyExists: true });
  assert.deepEqual(await c.ordersSearch({ order_id: 1 }), []);
  assert.equal(t.count("orders_search"), 2);
  assert.equal(await c.ordersCancel(1, 990, "QA"), true);
  // network errors exhaust retries -> RapidError network
  const dead = mockTransport(baseHandlers({ login: () => Object.assign(new Error("t"), { code: "ETIMEDOUT" }) }));
  await assert.rejects(client(dead).login(), (e) => e.code === "timeout" && e.retriable);
  assert.equal(dead.count("login"), 3);
  // access denied is not retried
  const denied = mockTransport({ login: () => fault(1, "Access Denied") });
  await assert.rejects(client(denied).login(), (e) => e.code === 1);
  assert.equal(denied.count("login"), 1);
});

test("config: live refused without explicit confirm; TLS bypass only on test; creds per env", async () => {
  const live = rapidConfig({ ...ENV, RAPID_ENV: "live", RAPID_LIVE_API_USER: "L", RAPID_LIVE_API_PASS: "L" });
  assert.equal(live.insecureTls, false);
  assert.equal(live.endpoint, RAPID_ENDPOINTS.live);
  const t = mockTransport(baseHandlers());
  await assert.rejects(createRapidClient({ config: live, transport: t }).login(), (e) => e.code === "live_disabled");
  assert.equal(t.calls.length, 0);
  assert.equal(rapidConfig({ ...ENV, RAPID_ENV: "live", RAPID_ENDPOINT_OVERRIDE: "https://x" }).endpoint, RAPID_ENDPOINTS.live);
  const none = rapidConfig({ RAPID_ENV: "test" });
  assert.equal(none.enabled, false);
  assert.equal(none.autoPush, false);
  assert.equal(none.allowRealOrders, false);
  await assert.rejects(createRapidClient({ config: none, transport: t }).login(), (e) => e.code === "not_configured");
});

test("mapping: ISO2 country, SKU map, prices, totals, ship method, custom_data orig_order_id", () => {
  assert.equal(countryIso2("United States"), "US");
  assert.equal(countryIso2("usa"), "US");
  assert.equal(countryIso2("ca"), "CA");
  assert.equal(countryIso2("Narnia"), null);
  const d = mapOrderToRapid(paidCard(), { cfg: cfgOf(), skuMap: SKU_MAP });
  assert.equal(d.order_id, 1042);
  assert.equal(d.order_id_prefix, 100);
  assert.equal(d.source, "biolabsresearch.co");
  assert.equal(d.order_date, "2026-09-28 03:00:00"); // Pacific
  assert.equal(d.billing_address.country, "US");
  assert.equal(d.billing_address.county, "TX");
  assert.equal(d.billing_address.customer_id, "BLR1042");
  assert.deepEqual(d.products[0], { product_id: "RC06-10", name: "RC-06 10mg vial", qty: 2, unit_price: "79.00", total_price: "158.00" });
  assert.equal(d.products.length, 1);
  assert.deepEqual(d.manualPack, []); // 2026-09-30: no gift line any more
  assert.equal(d.shipping_method, "usps_rrd_priority");
  assert.equal(d.total_cost, "169.09");
  assert.equal(d.discount, "7.90");
  assert.equal(d.currency, "USD");
  assert.deepEqual(d.custom_data, [{ key: "orig_order_id", value: "BLR-1042" }]);
  const crypto = mapOrderToRapid(paidCard({ id: "BLR-7", orderRef: "CR-AB12CD34", priceCheck: { shipMethod: "ground" } }), { cfg: cfgOf(), skuMap: SKU_MAP });
  assert.equal(crypto.custom_data[0].value, "CR-AB12CD34");
  assert.equal(crypto.shipping_method, "usps_evs_parcelgrnd");
  assert.throws(() => mapOrderToRapid(paidCard({ items: [{ sku: "nope-1mg", qty: 1 }] }), { cfg: cfgOf(), skuMap: SKU_MAP }), /sku:nope-1mg/);
  assert.throws(() => mapOrderToRapid(paidCard({ customer: { first_name: "A", country: "Narnia" } }), { cfg: cfgOf(), skuMap: SKU_MAP }), /customer.address.*customer.country/);
});

test("eligibility: only paid, never test/dry-run, real orders gated by RAPID_ALLOW_REAL_ORDERS", () => {
  const on = cfgOf({ RAPID_ALLOW_REAL_ORDERS: "true" });
  assert.equal(pushEligibility(paidCard(), cfgOf()).error, "real_orders_disabled");
  assert.equal(pushEligibility(paidCard(), on).ok, true);
  assert.equal(pushEligibility(paidCard({ status: "declined" }), on).error, "not_paid");
  assert.equal(pushEligibility(paidCard({ paymentMethod: "crypto", status: "awaiting_crypto" }), on).error, "not_paid");
  // 2026-09-28: a crypto order "marked paid" without on-chain verification is NOT paid for Rapid
  assert.equal(isPaidOrder(paidCard({ paymentMethod: "crypto", status: "crypto_paid", paymentConfirmed: true })), false);
  const verified = paidCard({
    paymentMethod: "crypto", status: "crypto_paid", paymentConfirmed: true, fulfillment: { status: "ready_to_ship" },
    cryptoPayment: { status: "paid", verifiedOnChain: true, sanctions: { status: "clear" } },
  });
  assert.equal(isPaidOrder(verified), true);
  assert.equal(pushEligibility(verified, on).ok, true);
  assert.equal(pushEligibility({ ...verified, cryptoPayment: { ...verified.cryptoPayment, verifiedOnChain: false } }, on).error, "not_paid");
  assert.equal(pushEligibility({ ...verified, cryptoPayment: { ...verified.cryptoPayment, status: "payment_review" } }, on).error, "not_paid");
  assert.equal(pushEligibility(paidCard({ test: true }), on).error, "test_order");
  assert.equal(pushEligibility(paidCard({ dryRun: true }), on).error, "test_order");
  assert.equal(pushEligibility(paidCard({ fulfillment: { status: "shipped" } }), on).error, "already_shipped");
});

test("push: idempotent (stored status, code 7 = exists), errors recorded, gate enforced", async () => {
  const db = createStore({ memoryOnly: true });
  db.upsertOrder(paidCard());
  db.upsertOrder(paidCard({ id: "BLR-1043" }));
  let seven = false;
  const t = mockTransport(baseHandlers({ orders_new: () => (seven ? fault(7, "Already Exists") : bool("orders_new")) }));
  const c = client(t);
  const on = cfgOf({ RAPID_ALLOW_REAL_ORDERS: "true" });
  assert.equal((await pushOrderToRapid(db, "BLR-1042", { client: c, cfg: cfgOf(), skuMap: SKU_MAP })).error, "real_orders_disabled");
  assert.equal(t.count("orders_new"), 0);
  const r1 = await pushOrderToRapid(db, "BLR-1042", { client: c, cfg: on, skuMap: SKU_MAP });
  assert.equal(r1.ok, true);
  assert.equal(db.getOrder("BLR-1042").rapid.status, "pushed");
  assert.equal(db.getOrder("BLR-1042").rapid.orderId, 1042);
  const again = await pushOrderToRapid(db, "BLR-1042", { client: c, cfg: on, skuMap: SKU_MAP });
  assert.equal(again.reused, true);
  assert.equal(t.count("orders_new"), 1);
  seven = true;
  const r2 = await pushOrderToRapid(db, "BLR-1043", { client: c, cfg: on, skuMap: SKU_MAP });
  assert.equal(r2.ok, true);
  assert.equal(r2.alreadyExists, true);
  assert.equal(db.getOrder("BLR-1043").rapid.status, "exists");
  db.upsertOrder(paidCard({ id: "BLR-1044", items: [{ sku: "zzz", qty: 1 }] }));
  const bad = await pushOrderToRapid(db, "BLR-1044", { client: c, cfg: on, skuMap: SKU_MAP });
  assert.equal(bad.error, "mapping_error");
  assert.equal(db.getOrder("BLR-1044").rapid.status, "error");
});

test("synthetic test order: QA identity, tprod, test prefix, refused on live", async () => {
  const t = mockTransport(baseHandlers({ orders_new: () => bool("orders_new") }));
  const r = await pushSyntheticTestOrder({ client: client(t), cfg: cfgOf(), now: () => new Date("2026-09-28T16:00:00Z") });
  assert.equal(r.ok, true);
  assert.equal(r.prefix, 990);
  assert.ok(r.orderId >= 100000000 && r.orderId < 1000000000);
  const x = t.calls.find((c) => c.method === "orders_new").xml;
  assert.match(x, /<firstname xsi:type="xsd:string">QA<\/firstname><surname xsi:type="xsd:string">Test<\/surname>/);
  assert.match(x, /qa-test\+rapid@biolabsresearch\.co/);
  assert.match(x, /<product_id xsi:type="xsd:string">tprod<\/product_id>/);
  assert.match(x, /QA-RAPID-/);
  assert.equal((await pushSyntheticTestOrder({ client: client(t), cfg: rapidConfig({ ...ENV, RAPID_ENV: "live" }) })).error, "refused_on_live");
});

test("status sync + daily shipped poll: tracking, ship date, shipped fulfillment; rejected/returned/addrcorrect alerts", async () => {
  const db = createStore({ memoryOnly: true });
  const pushed = (id, n) => paidCard({ id, rapid: { status: "pushed", orderId: n, prefix: 100, rapidStatus: null } });
  db.upsertOrder(pushed("BLR-1", 1));
  db.upsertOrder(pushed("BLR-2", 2));
  db.upsertOrder(pushed("BLR-3", 3));
  db.upsertOrder(pushed("BLR-4", 4));
  const t = mockTransport(baseHandlers({
    orders_search: (x) => {
      if (x.includes(">ship_date<")) return searchResp([{ order_id_prefix: 100, order_id: 1, status: "shipped", order_date: "2026-09-27", ship_date: "2026-09-28", ship_method: "usps_rrd_priority", trackingno: "9400111" }, { order_id_prefix: 100, order_id: 777, status: "shipped", order_date: "x", ship_method: "y" }]);
      const id = x.match(/order_id<\/key><value xsi:type="xsd:string">(\d+)/)[1];
      if (id === "2") return searchResp([{ order_id_prefix: 100, order_id: 2, status: "addrcorrect", order_date: "2026-09-27", ship_method: "usps_evs_parcelgrnd" }]);
      if (id === "4") return searchResp([{ order_id_prefix: 100, order_id: 4, status: "processing", order_date: "2026-09-27", ship_method: "usps_evs_parcelgrnd" }]);
      return fault(6, "Not Found");
    },
    orders_rejected: () => ok("orders_rejected", "rejected", ` SOAP-ENC:arrayType="ns1:ordersRejectedData[1]" xsi:type="ns1:ordersRejectedDataArray"><item xsi:type="ns1:ordersRejectedData"><order_id_prefix xsi:type="xsd:int">100</order_id_prefix><order_id xsi:type="xsd:int">3</order_id><order_date xsi:type="xsd:string">2026-09-27</order_date><reject_date xsi:type="xsd:string">2026-09-28</reject_date><reason xsi:type="xsd:string">Out of stock</reason></item></rejected>`),
    returns_list: () => fault(6, "Not Found"),
  }));
  const c = client(t);
  const cfg = cfgOf();
  const p = await pollShipped(db, { client: c, cfg, date: "2026-09-28" });
  assert.deepEqual({ ...p }, { date: "2026-09-28", shipped: 2, matched: 1, changed: 1, rejected: 1, returned: 0, unmatched: 1 });
  const o1 = db.getOrder("BLR-1");
  assert.equal(o1.fulfillment.status, "shipped");
  assert.equal(o1.fulfillment.trackingNumber, "9400111");
  assert.equal(o1.fulfillment.carrier, "USPS RRD Priority");
  assert.equal(o1.fulfillment.shippedBy, "rapid");
  assert.equal(o1.rapid.shipDate, "2026-09-28");
  assert.equal(db.getOrder("BLR-3").rapidAlert.type, "rejected");
  assert.equal(db.getOrder("BLR-3").rapidAlert.reason, "Out of stock");
  const s = await syncPushedOrders(db, { client: c });
  assert.equal(s.checked, 2); // BLR-1 shipped (final) and BLR-3 rejected (final) skipped
  assert.equal(db.getOrder("BLR-2").rapidAlert.type, "addrcorrect");
  assert.equal(db.getOrder("BLR-4").rapid.rapidStatus, "processing");
  assert.equal(db.getOrder("BLR-4").rapidAlert, undefined);
  // re-applying the same record changes nothing
  assert.deepEqual(applyRapidRecord(db, db.getOrder("BLR-1"), { status: "shipped", trackingno: "9400111", ship_method: "usps_rrd_priority" }), []);
});

test("stock sync writes rapid_stock beside stock_qty (never overwrites it)", async () => {
  const inv = createInventoryStore({ memoryOnly: true });
  inv.upsertSku({ code: "RC06-10", name: "RC-06 10mg" });
  const t = mockTransport(baseHandlers());
  const r = await syncStock(inv, { client: client(t), skuMap: SKU_MAP, now: () => new Date("2026-09-28T04:30:00Z") });
  assert.equal(r.products, 2);
  assert.equal(r.updated, 1);
  assert.deepEqual(r.unmatched, ["tprod"]);
  const row = inv.listSkus().find((x) => x.code === "RC06-10");
  assert.deepEqual(row.rapid_stock, { product_id: "RC06-10", stock: 42, allocated: 2, syncedAt: "2026-09-28T04:30:00.000Z" });
  assert.equal("stock_qty" in row, false);
  inv.upsertSku({ code: "RC06-10", name: "RC-06 10mg renamed" });
  assert.equal(inv.listSkus()[0].rapid_stock.stock, 42); // survives SKU edits
  // legacy stock_qty from the file stays exactly as it was
  const dir = mkdtempSync(join(tmpdir(), "inv-"));
  const file = join(dir, "inventory.json");
  writeFileSync(file, JSON.stringify({ skus: [{ id: "sku:RC06-10", code: "RC06-10", name: "RC-06 10mg", stock_qty: 17 }], purchase_orders: [], purchase_order_lines: [], inventory_movements: [] }));
  const fileInv = createInventoryStore({ filePath: file });
  await syncStock(fileInv, { client: client(mockTransport(baseHandlers())), skuMap: SKU_MAP });
  const saved = JSON.parse(readFileSync(file, "utf8")).skus[0];
  assert.equal(saved.stock_qty, 17);
  assert.equal(saved.rapid_stock.stock, 42);
});

test("scheduler: shipped poll at 07:15 Asia/Jerusalem for the Pacific date, 15-min retry, stock 07:30, hourly status", async () => {
  const db = createStore({ memoryOnly: true });
  let now = new Date("2026-09-29T04:14:00Z"); // 07:14 IDT
  let fail = true;
  const t = mockTransport(baseHandlers({
    orders_search: () => (fail ? Object.assign(new Error("x"), { code: "ECONNRESET" }) : fault(6, "Not Found")),
    orders_rejected: () => fault(6, "Not Found"),
    returns_list: () => fault(6, "Not Found"),
  }));
  const logs = [];
  const s = createRapidScheduler({ db, inventory: createInventoryStore({ memoryOnly: true }), client: client(t), cfg: cfgOf(), now: () => now, log: (m) => logs.push(m) });
  await s.tick();
  assert.equal(t.count("orders_search"), 0);
  now = new Date("2026-09-29T04:15:00Z"); // 07:15 IDT = 21:15 PDT Sep 28
  assert.equal(rapidDate(now), "2026-09-28");
  await s.tick();
  assert.equal(t.count("orders_search"), 3); // 1 try + 2 transport retries
  assert.ok(s.state().shipped.retryAt);
  now = new Date("2026-09-29T04:20:00Z");
  await s.tick();
  assert.equal(t.count("orders_search"), 3); // waits for the 15-min retry
  fail = false;
  now = new Date("2026-09-29T04:30:00Z"); // 07:30: retry due + stock due
  await s.tick();
  assert.equal(s.state().shipped.lastOkDate, "2026-09-29");
  assert.ok(t.calls.find((c) => c.method === "orders_search" && c.xml.includes("2026-09-28")));
  assert.equal(t.count("products_stock"), 1);
  now = new Date("2026-09-29T10:00:00Z");
  await s.tick();
  assert.equal(t.count("products_stock"), 1); // once a day
});

test("routes: staff auth, health, couriers, stock, synthetic test order + read/cancel, poll-now; auto-push stays off", async () => {
  const prev = { k: process.env.MARKETING_DIGEST_KEY, p: process.env.PAYMENTS_ENABLED };
  process.env.MARKETING_DIGEST_KEY = KEY;
  process.env.PAYMENTS_ENABLED = "true";
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [{ id: "umg", enabled: true, priority: 1, mode: "sandbox" }, { id: "tagada", enabled: false, priority: 2, mode: "off" }, { id: "centrobill", enabled: false, priority: 3, mode: "off" }] });
  const t = mockTransport(baseHandlers({
    orders_new: () => bool("orders_new"),
    orders_search: () => searchResp([{ order_id_prefix: 990, order_id: 123456789, status: "backlog", order_date: "2026-09-28", ship_method: "usps_evs_parcelgrnd" }]),
    orders_cancel: () => bool("orders_cancel"),
  }));
  const mk = async (env) => startCrmServer(0, {
    store, rapidEnv: env, rapidClient: env.RAPID_ENABLED === "true" ? createRapidClient({ config: rapidConfig(env), transport: t, sleep: async () => {} }) : undefined,
    rapidSkuMap: SKU_MAP, inventory: createInventoryStore({ memoryOnly: true }),
    adapters: { umg: { async createPayment() { return { ok: true, processor: "umg", processorTxnId: "U1", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } }, tagada: {}, centrobill: {} },
  });
  const staff = { "X-Marketing-Key": KEY, "Content-Type": "application/json" };
  const server = await mk({ ...ENV, RAPID_AUTO_PUSH: "true" }); // auto-push on, real orders still gated
  const off = await mk({ RAPID_ENV: "test" });
  const live = await mk({ ...ENV, RAPID_ENV: "live", RAPID_LIVE_API_USER: "L", RAPID_LIVE_API_PASS: "L", RAPID_LIVE_CONFIRM: "yes-live" });
  const b = (s) => `http://127.0.0.1:${s.address().port}`;
  try {
    assert.equal((await fetch(`${b(server)}/api/rapid/health`)).status, 401);
    const h = await (await fetch(`${b(server)}/api/rapid/health`, { headers: staff })).json();
    assert.equal(h.ok, true);
    assert.equal(h.env, "test");
    assert.equal(h.autoPush, true);
    assert.equal(h.allowRealOrders, false);
    assert.equal(JSON.stringify(h).includes("p<&>"), false);
    assert.equal((await (await fetch(`${b(off)}/api/rapid/health`, { headers: staff })).json()).error, "rapid_disabled");
    assert.equal((await fetch(`${b(off)}/api/rapid/couriers`, { headers: staff })).status, 503);
    assert.equal((await (await fetch(`${b(server)}/api/rapid/couriers`, { headers: staff })).json()).count, 2);
    assert.equal((await (await fetch(`${b(server)}/api/rapid/stock`, { headers: staff })).json()).products[0].stock, 42);
    const to = await (await fetch(`${b(server)}/api/rapid/test-order`, { method: "POST", headers: staff })).json();
    assert.equal(to.ok, true);
    assert.equal(to.prefix, 990);
    assert.equal((await (await fetch(`${b(server)}/api/rapid/test-order/123456789`, { headers: staff })).json()).orders[0].status, "backlog");
    assert.equal((await (await fetch(`${b(server)}/api/rapid/test-order/123456789`, { method: "DELETE", headers: staff })).json()).cancelled, true);
    assert.equal((await fetch(`${b(live)}/api/rapid/test-order`, { method: "POST", headers: staff })).status, 403);
    assert.equal((await fetch(`${b(live)}/api/rapid/test-order/1`, { method: "DELETE", headers: staff })).status, 403);
    const pn = await (await fetch(`${b(server)}/api/rapid/poll-now`, { method: "POST", headers: staff, body: JSON.stringify({ job: "stock" }) })).json();
    assert.equal(pn.stock.products, 2);
    // a real approved card order is NOT pushed (RAPID_ALLOW_REAL_ORDERS off) even with auto-push on
    const before = t.count("orders_new");
    const card = { name: "Ada", number: "4242424242424242", month: "12", year: "28", cvv: "123" };
    const cr = await fetch(`${b(server)}/api/checkout/charge`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idempotencyKey: "R-1", amount: "88.00", customer: paidCard().customer, card, items: [{ sku: "bpc-157-10mg", qty: 1, amount: "88.00" }] }) });
    assert.equal(cr.status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(t.count("orders_new"), before);
    assert.equal(store.getOrderByIdempotency("R-1").rapid, undefined);
  } finally {
    for (const s of [server, off, live]) await new Promise((r) => s.close(r));
    for (const [k, v] of [["MARKETING_DIGEST_KEY", prev.k], ["PAYMENTS_ENABLED", prev.p]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

// ---- legal: packing-slip compliance ----------------------------------------------------------------------
const DRAFT_MAP_PATH = new URL("../config/rapid-sku-map.draft.json", import.meta.url).pathname;
const INN = ["BPC-157", "BPC157", "TB-500", "Thymosin", "NAD+", "NAD", "Curcumin", "Meriva", "Tesamorelin", "Ipamorelin", "AOD-9604",
  "Epithalon", "GHK-Cu", "MOTS-c", "KPV", "Semax", "Kisspeptin", "Retatrutide", "Semaglutide", "Tirzepatide", "Bacteriostatic", "BAC water", "solvent", "glow"];
function printable(d) {
  return [...d.products.flatMap((p) => [p.product_id, p.name, p.extra]), d.message, ...(d.custom_data || []).flatMap((kv) => [kv.key, kv.value])]
    .filter((x) => x != null).join(" | ");
}

test("legal: every draft SKU maps to a neutral id/name; no INN or compound name anywhere printable; gift never printed", () => {
  const map = loadSkuMap(DRAFT_MAP_PATH);
  const skus = Object.keys(map).filter((s) => !s.startsWith("research-solvent")); // 2026-09-30: gift stopped (refused if present)
  assert.ok(skus.length >= 29);
  // one order holding every catalog SKU, with the storefront's real (compound) item names and the BAC gift
  const order = paidCard({
    items: skus.map((sku) => ({ sku, name: sku.startsWith("research-solvent") ? "Research solvent 10mL" : `${sku.replace(/-/g, " ")} BPC-157 NAD+`, qty: 1, amount: "1.00" })),
    notes: "customer wants BPC-157 and bacteriostatic water",
  });
  const d = mapOrderToRapid(order, { cfg: cfgOf(), skuMap: map });
  assert.equal(d.products.length, skus.length);
  const text = printable(d);
  for (const term of INN) assert.equal(new RegExp(`(^|[^a-z0-9])${term.replace(/[+]/g, "\\+")}($|[^a-z0-9])`, "i").test(text) || text.toLowerCase().replace(/[^a-z0-9]/g, "").includes(term.toLowerCase().replace(/[^a-z0-9]/g, "")) && term.length > 4, false, `INN leaked: ${term}`);
  for (const p of d.products) {
    assert.match(p.product_id, /^(RC\d{2}|G[123]-[STR])-\d+$/, p.product_id);
    assert.match(p.name, /^(RC-\d{2}|G[123]-[STR]) \d+mg vial$/, p.name);
    assert.ok(p.product_id.length <= 16);
  }
  assert.equal(findCompoundLeaks(d).length, 0);
  assert.equal(d.manualPack.length, 0);
  assert.equal(/research-solvent|GIFT/i.test(text), false);
  // stealth products keep the site's code names
  assert.ok(d.products.some((p) => p.name === "G3-R 10mg vial"));
  // the storefront item name and order notes are never sent
  assert.equal(d.message, undefined);
});

test("legal: a compound name in the SKU map, extra, message or custom_data is blocked before anything is sent", async () => {
  const bad = [
    { "bpc-157-10mg": { product_id: "RC06-10", name: "BPC-157 10mg" } },
    { "bpc-157-10mg": { product_id: "BPC157-10", name: "RC-06 10mg vial" } },
    { "bpc-157-10mg": { product_id: "RC06-10", name: "RC-06 NAD+ vial" } },
    { "bpc-157-10mg": { product_id: "RC06-10", name: "RC-06 (bpc 157) vial" } },
    { "bpc-157-10mg": { product_id: "RC06-10", name: "Kpv" } },
    { "bpc-157-10mg": { product_id: "RC06-10", name: "RC-06 tb500" } },
  ];
  for (const m of bad) assert.throws(() => mapOrderToRapid(paidCard(), { cfg: cfgOf(), skuMap: { ...SKU_MAP, ...m } }), (e) => e.code === "compound_name_blocked", JSON.stringify(m));
  // a new catalog slug is blocked automatically via the map keys (not only via the static list)
  assert.throws(() => mapOrderToRapid(paidCard({ items: [{ sku: "zenopeptide-5mg", qty: 1 }] }), { cfg: cfgOf(), skuMap: { "zenopeptide-5mg": { product_id: "RC99-5", name: "Zenopeptide 5mg" } } }), (e) => e.code === "compound_name_blocked");
  assert.equal(findCompoundLeaks({ products: [{ product_id: "RC06-10", name: "RC-06 10mg vial", extra: "contains semax" }] }).length > 0, true);
  assert.equal(findCompoundLeaks({ products: [], message: "Thymosin inside" }).length > 0, true);
  assert.equal(findCompoundLeaks({ products: [], custom_data: [{ key: "orig_order_id", value: "BPC157" }] }).length > 0, true);
  assert.equal(findCompoundLeaks({ products: [{ product_id: "G3-R-10", name: "G3-R 10mg vial" }], custom_data: [{ key: "orig_order_id", value: "CR-AB12CD34" }] }).length, 0);
  assert.ok(COMPOUND_TERMS.includes("tesamorelin"));
  // push path: nothing reaches Rapid, error recorded
  const db = createStore({ memoryOnly: true });
  db.upsertOrder(paidCard());
  const t = mockTransport(baseHandlers({ orders_new: () => bool("orders_new") }));
  const r = await pushOrderToRapid(db, "BLR-1042", { client: client(t), cfg: cfgOf({ RAPID_ALLOW_REAL_ORDERS: "true" }), skuMap: bad[0] });
  assert.equal(r.error, "compound_name_blocked");
  assert.equal(t.count("orders_new"), 0);
});

test("legal: the BAC / research-solvent gift is stopped (2026-09-30): an order carrying one is refused before anything is sent", async () => {
  const db = createStore({ memoryOnly: true });
  db.upsertOrder(paidCard({ items: [...paidCard().items, { sku: "research-solvent-10ml", name: "BAC", qty: 1, amount: "0.00" }] }));
  const t = mockTransport(baseHandlers({ orders_new: () => bool("orders_new") }));
  const r = await pushOrderToRapid(db, "BLR-1042", { client: client(t), cfg: cfgOf({ RAPID_ALLOW_REAL_ORDERS: "true" }), skuMap: SKU_MAP });
  assert.equal(r.ok, false);
  assert.equal(r.error, "gift_line_refused");
  assert.equal(t.count("orders_new"), 0);
  // detected by name too (no map entry), and neutral mode no longer sends an insert
  assert.throws(() => mapOrderToRapid(paidCard({ items: [{ sku: "bpc-157-10mg", qty: 1 }, { sku: "free-gift", name: "Research solvent 10mL", qty: 1 }] }), { cfg: cfgOf(), skuMap: SKU_MAP }), /gift_line_refused/);
  assert.throws(() => mapOrderToRapid(paidCard({ items: [{ sku: "bpc-157-10mg", qty: 1 }, { sku: "research-solvent-10ml", qty: 1 }] }), { cfg: cfgOf({ RAPID_GIFT_MODE: "neutral" }), skuMap: SKU_MAP }), /gift_line_refused/);
});

test("legal: street/slang blend name 'Wolverine' is blocked (any case, any printable field)", async () => {
  for (const name of ["Wolverine 10mg", "WOLVERINE", "wolverine blend", "RC-06 (Wolverine) vial"]) {
    assert.throws(
      () => mapOrderToRapid(paidCard(), { cfg: cfgOf(), skuMap: { ...SKU_MAP, "bpc-157-10mg": { product_id: "RC06-10", name } } }),
      (e) => e.code === "compound_name_blocked" && /wolverine/i.test(e.message),
      name,
    );
  }
  assert.throws(
    () => mapOrderToRapid(paidCard(), { cfg: cfgOf(), skuMap: { ...SKU_MAP, "bpc-157-10mg": { product_id: "WOLVERINE-10", name: "RC-06 10mg vial" } } }),
    (e) => e.code === "compound_name_blocked",
  );
  assert.ok(findCompoundLeaks({ products: [{ product_id: "RC06-10", name: "RC-06 10mg vial", extra: "WoLvErInE" }] }).includes("wolverine"));
  assert.ok(findCompoundLeaks({ products: [], message: "Wolverine stack" }).includes("wolverine"));
  assert.ok(findCompoundLeaks({ products: [], custom_data: [{ key: "orig_order_id", value: "wolverine" }] }).includes("wolverine"));
  // push path: nothing reaches Rapid
  const db = createStore({ memoryOnly: true });
  db.upsertOrder(paidCard());
  const t = mockTransport(baseHandlers({ orders_new: () => bool("orders_new") }));
  const r = await pushOrderToRapid(db, "BLR-1042", { client: client(t), cfg: cfgOf({ RAPID_ALLOW_REAL_ORDERS: "true" }), skuMap: { ...SKU_MAP, "bpc-157-10mg": { product_id: "RC06-10", name: "Wolverine 10mg" } } });
  assert.equal(r.error, "compound_name_blocked");
  assert.equal(t.count("orders_new"), 0);
});

test("Legal 2026-09-29: INN short forms blocked as standalone words only (r3ta, reta, sema, tirz, glp, trutide)", async () => {
  const { STANDALONE_TERMS } = await import("../lib/rapid-orders.js");
  const hits = (s) => findCompoundLeaks({ products: [{ product_id: "X-1", name: s }] });
  for (const s of ["R3TA", "r3ta 10mg", "Reta 10mg", "RETA", "tirz", "Tirz 20mg", "R3TA10", "GLP-1", "GLP2", "GLP2-TPT", "Reta-trutide", "sema 10mg"]) {
    assert.ok(hits(s).some((t) => STANDALONE_TERMS.has(t)), `${s} must be blocked`);
  }
  for (const s of ["retail", "Semax", "semantic", "Tirzah", "G3-R-10", "RC02-500", "G3-R 10mg vial", "RC-02 500mg vial"]) {
    assert.ok(!hits(s).some((t) => STANDALONE_TERMS.has(t)), `${s} must not trip the new terms`);
  }
  // "Semax" is still blocked on packing slips by the pre-existing compound term "semax" (not by "sema")
  assert.deepEqual(hits("Semax"), ["semax"]);
  // every stealth / catalog code and neutral name in use passes the whole filter
  const neutral = ["G3-R-10", "G3-R-20", "G3-R-30", "G3-R-50", "G3-R-60", "G2-T-10", "G2-T-20", "G1-S-5", "G1-S-10", "G1-S-20", "RC02-500", "RC02-1000",
    "G3-R 10mg", "G3-R 30mg", "G3-R 60mg", "G2-T 20mg", "G1-S 10mg", "G1-S 20mg", "RC-02 500mg", "G3-R 10mg vial", "G2-T 10mg vial", "G1-S 5mg vial"];
  for (const s of neutral) assert.deepEqual(hits(s), [], s);
  // the draft SKU map's product ids / names (what Rapid would print) never trip the new terms
  const map = JSON.parse(readFileSync(new URL("../config/rapid-sku-map.draft.json", import.meta.url), "utf8"));
  for (const m of Object.values(map)) {
    if (!m || !m.product_id) continue;
    assert.ok(!hits(`${m.product_id} ${m.name || ""}`).some((t) => STANDALONE_TERMS.has(t)), m.product_id);
  }
});
