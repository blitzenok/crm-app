import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { corsHeadersForRequest, isStorefrontApiPath } from "../lib/cors.js";
import {
  buildInventoryView,
  createInventoryStore,
  markPurchaseOrderReceived,
} from "../lib/inventory.js";
import { applyPvcPurchaseOrder, loadPvcLinesFile, seedInventory, summarizePvcLines } from "../lib/inventory-seed.js";
import { startCrmServer } from "../index.js";

const PUBLIC_NAME_BANNED = /retatrutide|\breta\b|tirzepatide|semaglutide/i;

function seedStore() {
  const store = createInventoryStore({ memoryOnly: true });
  const report = seedInventory(store);
  return { store, report };
}

async function withServer(deps, fn) {
  const server = await startCrmServer(0, deps);
  const { port } = server.address();
  try {
    return await fn(port);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("PO #071326 intake is idempotent and on_hand totals 400", () => {
  const { store, report } = seedStore();
  const again = seedInventory(store);

  assert.equal(report.mark_received_invoked, false);
  assert.equal(again.mark_received_invoked, false);
  assert.equal(report.movements_created, 5);
  assert.equal(again.movements_created, 0);
  assert.equal(again.movements_existing, 5);
  assert.equal(report.on_hand_units, 400);
  assert.deepEqual(report.on_hand_by_sku, {
    "G3-R-10": 100,
    "G3-R-20": 50,
    "TES-10": 100,
    "WOL-10": 100,
    GLOW: 50,
  });

  const movements = store.listMovements();
  assert.equal(movements.length, 5);
  const keys = movements.map((row) => row.idempotency_key);
  assert.equal(new Set(keys).size, 5);
  for (const row of movements) {
    assert.equal(row.po_id, "071326");
    assert.equal(row.type, "PO_INTAKE");
    assert.equal(row.created_by, "inventory-seed");
    assert.equal(row.created_at, "2026-07-13T00:00:00.000Z");
    assert.ok(row.sku_id);
  }

  const view = buildInventoryView(store);
  assert.equal(view.on_hand_units, 400);
  assert.equal(view.value_at_cost, "19000.00");
  assert.equal(view.storefront_catalog_updated, false);
  assert.equal(view.public_quantity_exposed, false);
  const byCode = Object.fromEntries(view.skus.map((sku) => [sku.code, sku]));
  assert.equal(byCode["G3-R-10"].weighted_avg_unit_cost, "40.00");
  assert.equal(byCode["G3-R-10"].value_at_cost, "4000.00");
  assert.equal(byCode["G3-R-20"].weighted_avg_unit_cost, "70.00");
  assert.equal(byCode["TES-10"].weighted_avg_unit_cost, "35.00");
  assert.equal(byCode["WOL-10"].weighted_avg_unit_cost, "39.00");
  assert.equal(byCode.GLOW.name, "GLOW");
  assert.equal(byCode.GLOW.weighted_avg_unit_cost, "82.00");
  assert.deepEqual(byCode["G3-R-10"].linked_pos, ["071326"]);
  for (const sku of view.skus) {
    assert.equal(PUBLIC_NAME_BANNED.test(sku.name), false);
    assert.equal(PUBLIC_NAME_BANNED.test(sku.code), false);
    assert.equal(Object.hasOwn(sku, "stock_qty"), false);
    assert.equal(sku.on_hand_source, "sum(inventory_movements.qty)");
  }

  const cosmo = view.purchase_orders.find((row) => row.po_id === "071326");
  assert.equal(cosmo.status, "RECEIVED");
  assert.equal(cosmo.supplier, "COSMO VISIONS INC.");
  assert.equal(cosmo.dated, "2026-07-13");
  assert.equal(cosmo.goods_total, "19000.00");
  assert.equal(cosmo.total, "19500.00");
  assert.equal(cosmo.po_level_costs[0].label, "COA");
  assert.equal(cosmo.po_level_costs[0].amount, "500.00");
  assert.equal(cosmo.movement_count, 5);
  assert.equal(cosmo.can_mark_received, false);
});

test("PO #PVC-092326 books the 28 invoice lines and no movements", () => {
  const { store } = seedStore();
  const loaded = loadPvcLinesFile();
  const summary = summarizePvcLines(loaded.lines);
  assert.equal(summary.ok, true);
  assert.equal(summary.count, 28);
  assert.equal(summary.units, 460);
  assert.equal(summary.goods_cents, 664050);

  const codes = store.listSkus().map((sku) => sku.code).sort();
  assert.deepEqual(codes, ["G3-R-10", "G3-R-20", "GLOW", "TES-10", "WOL-10"]);

  const pvc = store.listPurchaseOrders().find((row) => row.po_id === "PVC-092326");
  assert.equal(pvc.status, "PAID_IN_TRANSIT");
  assert.equal(pvc.ship_to, "PENDING");
  assert.equal(pvc.supplier, "Pure Vision Consulting");
  assert.equal(pvc.dated, "2026-09-23");
  assert.deepEqual(pvc.alias_map, {
    R3TA: "G3-R",
    Tirzepatide: "G2-T",
    Semaglutide: "G1-S",
  });

  const lines = store.listLines().filter((line) => line.po_id === "PVC-092326");
  assert.equal(lines.length, 28);
  assert.equal(lines.reduce((sum, line) => sum + line.qty, 0), 460);
  assert.equal(lines.reduce((sum, line) => sum + line.line_total_cents, 0), 664050);
  for (const line of lines) assert.equal(line.sku_id, null);
  assert.equal(store.listMovements().filter((row) => row.po_id === "PVC-092326").length, 0);

  const r3ta = lines.find((line) => line.supplier_name === "R3TA 10mg");
  assert.equal(r3ta.qty, 30);
  assert.equal(r3ta.line_total_cents, 39000);
  assert.match(r3ta.suggested_internal_code_note, /suggested G3-R-10/);
  const glowLine = lines.find((line) => line.supplier_name === "GLOW 70 70mg");
  assert.match(glowLine.suggested_internal_code_note, /suggested GLOW/);
  assert.equal(lines.find((line) => line.supplier_name === "BAC Water 10mg").qty, 100);
  assert.equal(store.listSkus().some((sku) => ["G3-R-30", "G3-R-60", "G2-T-20", "G1-S-10", "G1-S-20", "BAC-WATER", "G2-T", "G1-S"].includes(sku.code)), false);

  const view = buildInventoryView(store);
  assert.equal(view.on_hand_units, 400);
  assert.equal(view.skus.find((sku) => sku.code === "GLOW").on_hand, 50);
  assert.deepEqual(view.skus.find((sku) => sku.code === "GLOW").linked_pos, ["071326"]);
  assert.equal(view.purchase_orders.find((row) => row.po_id === "PVC-092326").goods_total, "6640.50");
  assert.equal(view.purchase_orders.find((row) => row.po_id === "PVC-092326").movement_count, 0);

  const again = seedInventory(store);
  assert.equal(again.pvc.lines_booked, 28);
  assert.equal(again.pvc.movements, 0);
  assert.equal(again.mark_received_invoked, false);
  assert.equal(store.listLines().filter((line) => line.po_id === "PVC-092326").length, 28);
  assert.equal(store.listMovements().length, 5);

  const blocked = markPurchaseOrderReceived(store, "PVC-092326", "y0505300530@gmail.com", "2026-09-24T12:00:00.000Z");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "sku_mapping_required");
  assert.equal(blocked.movements_created, 0);
  assert.equal(store.listPurchaseOrders().find((row) => row.po_id === "PVC-092326").status, "PAID_IN_TRANSIT");
  assert.equal(store.listMovements().length, 5);

  const isolated = createInventoryStore({ memoryOnly: true });
  applyPvcPurchaseOrder(isolated, [{
    line_no: 1,
    supplier_name: "Tirzepatide 20mg",
    qty: 30,
    unit_cost: "17.00",
    line_total: "510.00",
    sku_id: "sku:SHOULD-NOT-STICK",
    suggested_internal_code_note: "alias Tirzepatide→G2-T; suggested G2-T-20",
  }]);
  assert.equal(isolated.listSkus().length, 0);
  assert.equal(isolated.listLines()[0].sku_id, null);
  assert.equal(isolated.listMovements().length, 0);
});

test("Mark Received posts movements only when invoked, then refuses a duplicate", () => {
  const { store } = seedStore();
  assert.equal(store.listMovements().length, 5);
  store.upsertPurchaseOrder({
    po_id: "TEST-RECV",
    po_number: "TEST-RECV",
    supplier: "Test Supplier",
    dated: "2026-09-24",
    status: "PAID_IN_TRANSIT",
    ship_to: "PENDING",
    po_level_costs: [],
    alias_map: null,
    created_by: "test",
    created_at: "2026-09-24T00:00:00.000Z",
  });
  store.upsertLine({
    id: "ln:TEST-RECV:sku:GLOW",
    po_id: "TEST-RECV",
    line_no: 1,
    sku_id: "sku:GLOW",
    supplier_name: null,
    qty: 2,
    unit_cost_cents: 8200,
    line_total_cents: 16400,
  });
  assert.equal(store.listMovements().length, 5);

  const posted = markPurchaseOrderReceived(store, "TEST-RECV", "y0505300530@gmail.com", "2026-09-24T15:00:00.000Z");
  assert.equal(posted.movements_created, 1);
  assert.equal(store.listMovements().length, 6);
  const movement = store.listMovements().find((row) => row.po_id === "TEST-RECV");
  assert.equal(movement.created_by, "y0505300530@gmail.com");
  assert.equal(movement.created_at, "2026-09-24T15:00:00.000Z");
  assert.equal(movement.type, "PO_INTAKE");
  assert.equal(movement.idempotency_key, "TEST-RECV|sku:GLOW|PO_INTAKE");
  assert.equal(store.listPurchaseOrders().find((row) => row.po_id === "TEST-RECV").status, "RECEIVED");

  const again = markPurchaseOrderReceived(store, "TEST-RECV", "other@biolabsresearch.co", "2026-09-24T16:00:00.000Z");
  assert.equal(again.movements_created, 0);
  assert.equal(again.reused, true);
  assert.equal(store.listMovements().length, 6);
  assert.equal(store.listMovements().find((row) => row.po_id === "TEST-RECV").created_by, "y0505300530@gmail.com");
  assert.equal(buildInventoryView(store).skus.find((sku) => sku.code === "GLOW").on_hand, 52);
});

test("legacy stock_qty is preserved and ignored by on_hand", () => {
  const dir = mkdtempSync(join(tmpdir(), "crm-inv-"));
  const file = join(dir, "inventory.json");
  writeFileSync(file, JSON.stringify({
    skus: [{ id: "sku:G3-R-10", code: "G3-R-10", name: "G3-R 10mg", stock_qty: 7, on_hand: 999 }],
    purchase_orders: [],
    purchase_order_lines: [],
    inventory_movements: [],
  }));
  const store = createInventoryStore({ filePath: file });
  seedInventory(store);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const sku = raw.skus.find((row) => row.code === "G3-R-10");
  assert.equal(sku.stock_qty, 7);
  assert.equal(sku.on_hand, undefined);
  const view = buildInventoryView(store);
  const row = view.skus.find((item) => item.code === "G3-R-10");
  assert.equal(row.on_hand, 100);
  assert.equal(row.legacy_stock_qty, 7);
  assert.equal(row.legacy_stock_readonly, true);
  const rejected = store.upsertSku({ code: "G3-R-10", name: "G3-R 10mg", stock_qty: 999 });
  assert.equal(rejected.ok, true);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).skus.find((item) => item.code === "G3-R-10").stock_qty, 7);
  const banned = store.upsertSku({ code: "RETA-1", name: "Retatrutide 10mg" });
  assert.equal(banned.ok, false);
  assert.equal(banned.error, "public_name_banned");
});

test("PO #081226 is an unmapped in-transit line and posts one movement only after mapping", () => {
  const { store, report } = seedStore();
  assert.equal(report.mark_received_invoked, false);
  assert.equal(report.on_hand_units, 400);
  assert.equal(report.po_081226.status, "PAID_IN_TRANSIT");
  assert.equal(report.po_081226.movements, 0);
  assert.equal(report.po_081226.lines, 1);
  assert.equal(report.po_081226.goods_total, "1140.00");
  assert.equal(report.po_081226.sku_id, null);
  assert.equal(store.listSkus().some((sku) => /nad/i.test(sku.code) || /nad/i.test(sku.name)), false);

  const po = store.listPurchaseOrders().find((row) => row.po_id === "081226");
  assert.equal(po.supplier, "COSMO VISIONS INC.");
  assert.equal(po.dated, "2026-08-12");
  assert.equal(po.routing_number, undefined);
  assert.equal(po.account_number, undefined);
  const line = store.listLines().find((row) => row.po_id === "081226");
  assert.equal(line.supplier_name, "NAD+ 500mg");
  assert.equal(line.qty, 30);
  assert.equal(line.unit_cost_cents, 3800);
  assert.equal(line.line_total_cents, 114000);
  assert.equal(line.sku_id, null);

  store.upsertPurchaseOrder({
    po_id: "081226",
    routing_number: "DO-NOT-STORE",
    account_number: "DO-NOT-STORE",
  });
  const saved = store.listPurchaseOrders().find((row) => row.po_id === "081226");
  assert.equal(saved.status, "PAID_IN_TRANSIT");
  assert.equal(JSON.stringify(saved).includes("DO-NOT-STORE"), false);

  const blocked = markPurchaseOrderReceived(store, "081226", "y0505300530@gmail.com", "2026-08-20T00:00:00.000Z");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error, "sku_mapping_required");
  assert.equal(blocked.movements_created, 0);
  assert.equal(store.listMovements().filter((row) => row.po_id === "081226").length, 0);
  assert.equal(buildInventoryView(store).on_hand_units, 400);

  store.upsertSku({
    id: "sku:NAD-500",
    code: "NAD-500",
    name: "NAD+ 500mg",
    created_at: "2026-08-12T00:00:00.000Z",
  });
  store.upsertLine({
    id: "ln:081226:1",
    po_id: "081226",
    line_no: 1,
    sku_id: "sku:NAD-500",
    supplier_name: "NAD+ 500mg",
    qty: 30,
    unit_cost_cents: 3800,
    line_total_cents: 114000,
  });
  const posted = markPurchaseOrderReceived(store, "081226", "y0505300530@gmail.com", "2026-08-20T00:00:00.000Z");
  assert.equal(posted.ok, true);
  assert.equal(posted.movements_created, 1);
  const movement = store.listMovements().find((row) => row.po_id === "081226");
  assert.equal(movement.type, "PO_INTAKE");
  assert.equal(movement.qty, 30);
  assert.equal(movement.created_by, "y0505300530@gmail.com");
  assert.equal(movement.created_at, "2026-08-20T00:00:00.000Z");
  assert.equal(movement.idempotency_key, "081226|sku:NAD-500|PO_INTAKE");
  assert.equal(store.listPurchaseOrders().find((row) => row.po_id === "081226").status, "RECEIVED");

  const repeat = markPurchaseOrderReceived(store, "081226", "other@biolabsresearch.co", "2026-08-21T00:00:00.000Z");
  assert.equal(repeat.movements_created, 0);
  assert.equal(repeat.reused, true);
  assert.equal(store.listMovements().filter((row) => row.po_id === "081226").length, 1);
  assert.equal(store.listMovements().find((row) => row.po_id === "081226").created_by, "y0505300530@gmail.com");

  const reseed = seedInventory(store);
  assert.equal(reseed.mark_received_invoked, false);
  assert.equal(reseed.po_081226.movements, 1);
  assert.equal(reseed.po_081226.status, "RECEIVED");
  assert.equal(store.listLines().find((row) => row.po_id === "081226").sku_id, "sku:NAD-500");
  assert.equal(store.listMovements().filter((row) => row.po_id === "081226").length, 1);
});

test("inventory HTTP is operator-only, idempotent, and does not expose catalog quantities", async () => {
  const inventory = createInventoryStore({ memoryOnly: true });
  await withServer({
    inventory,
    checkCrmSession: async (token) => (
      token === "good-session" ? { user: { email: "y0505300530@gmail.com", name: "Y Admin" } } : false
    ),
  }, async (port) => {
    const base = `http://127.0.0.1:${port}`;
    const open = await fetch(`${base}/api/inventory`);
    assert.equal(open.status, 401);

    const headers = { Authorization: "Bearer good-session", "Content-Type": "application/json" };
    const first = await fetch(`${base}/api/inventory/intake`, { method: "POST", headers });
    const firstBody = await first.json();
    assert.equal(first.status, 200);
    assert.equal(firstBody.report.movements_created, 5);
    assert.equal(firstBody.report.on_hand_units, 400);
    assert.equal(firstBody.report.po_081226.status, "PAID_IN_TRANSIT");
    assert.equal(firstBody.report.po_081226.movements, 0);
    assert.equal(firstBody.report.po_081226.goods_total, "1140.00");
    assert.equal(firstBody.report.po_081226.sku_id, null);
    assert.equal(firstBody.report.pvc.movements, 0);
    assert.equal(firstBody.report.pvc.lines_booked, 28);
    assert.equal(firstBody.report.pvc.status, "PAID_IN_TRANSIT");
    assert.equal(firstBody.report.mark_received_invoked, false);

    const second = await fetch(`${base}/api/inventory/intake`, { method: "POST", headers });
    const secondBody = await second.json();
    assert.equal(secondBody.report.movements_created, 0);
    assert.equal(secondBody.report.movements_existing, 5);
    assert.equal(secondBody.inventory.on_hand_units, 400);
    const ids = secondBody.inventory.purchase_orders.map((row) => row.po_id);
    assert.deepEqual(ids, ["071326", "081226", "PVC-092326"]);
    const aug = secondBody.inventory.purchase_orders.find((row) => row.po_id === "081226");
    assert.equal(aug.lines[0].supplier_name, "NAD+ 500mg");
    assert.equal(aug.lines[0].sku_id, null);
    assert.equal(aug.movement_count, 0);

    const received = await fetch(`${base}/api/inventory/purchase-orders/PVC-092326/mark-received`, {
      method: "POST",
      headers,
    });
    const receivedBody = await received.json();
    assert.equal(received.status, 409);
    assert.equal(receivedBody.movements_created, 0);
    assert.equal(receivedBody.error, "sku_mapping_required");
    assert.equal(receivedBody.inventory.on_hand_units, 400);
    const pvcPo = receivedBody.inventory.purchase_orders.find((row) => row.po_id === "PVC-092326");
    assert.equal(pvcPo.status, "PAID_IN_TRANSIT");
    assert.equal(pvcPo.lines.length, 28);
    assert.equal(pvcPo.goods_total, "6640.50");
    assert.equal(pvcPo.movement_count, 0);
    assert.equal(pvcPo.lines.every((line) => line.sku_id == null), true);

    const stock = await fetch(`${base}/api/inventory/skus/sku:G3-R-10/stock`, {
      method: "POST",
      headers,
      body: JSON.stringify({ stock_qty: 1 }),
    });
    const stockBody = await stock.json();
    assert.equal(stock.status, 409);
    assert.equal(stockBody.error, "legacy_stock_qty_readonly");
    const afterStock = await fetch(`${base}/api/inventory`, { headers });
    const afterBody = await afterStock.json();
    assert.equal(afterBody.skus.find((sku) => sku.code === "G3-R-10").on_hand, 100);
    assert.equal(Object.hasOwn(afterBody.skus[0], "stock_qty"), false);

    const products = await fetch(`${base}/api/products`);
    assert.equal(products.status, 404);
    const productsBody = await products.json();
    assert.equal(productsBody.on_hand, undefined);
    assert.equal(JSON.stringify(productsBody).includes("on_hand"), false);

    const onHand = await fetch(`${base}/api/inventory/on-hand`, { headers });
    const onHandBody = await onHand.json();
    assert.equal(onHandBody.on_hand_units, 400);
    assert.equal(onHandBody.public_quantity_exposed, false);
    assert.equal(onHandBody.storefront_catalog_updated, false);
  });

  assert.equal(isStorefrontApiPath("/api/inventory"), false);
  assert.equal(isStorefrontApiPath("/api/inventory/on-hand"), false);
  assert.deepEqual(
    corsHeadersForRequest({ headers: { origin: "https://biolabsresearch.co" } }, "/api/inventory", {}),
    {},
  );
});

test("PVC: an approved sku_id applied to a stored line survives re-seed; unmapped lines stay null; no movements", () => {
  const { store } = seedStore();
  store.upsertSku({ id: "sku:G1-S-10", code: "G1-S-10", name: "G1-S 10mg" });
  const before = store.listLines().find((row) => row.id === "ln:PVC-092326:25");
  assert.equal(before.sku_id, null);
  store.upsertLine({ ...before, sku_id: "sku:G1-S-10" });
  store.upsertLine({ ...store.listLines().find((row) => row.id === "ln:PVC-092326:18"), sku_id: "sku:G3-R-10" });
  seedInventory(store);
  seedInventory(store);
  const lines = store.listLines().filter((row) => row.po_id === "PVC-092326");
  assert.equal(lines.length, 28);
  assert.equal(lines.find((row) => row.id === "ln:PVC-092326:25").sku_id, "sku:G1-S-10");
  assert.equal(lines.find((row) => row.id === "ln:PVC-092326:18").sku_id, "sku:G3-R-10");
  assert.equal(lines.find((row) => row.id === "ln:PVC-092326:25").supplier_name, "Semaglutide 10mg");
  assert.equal(lines.filter((row) => row.sku_id).length, 2);
  assert.equal(store.listMovements().length, 5);
  assert.equal(buildInventoryView(store).on_hand_units, 400);
  assert.equal(store.listPurchaseOrders().find((row) => row.po_id === "PVC-092326").status, "PAID_IN_TRANSIT");
});

test("Legal 2026-09-29: SKU names reject INN short forms as whole words, accept the stealth codes", () => {
  const store = createInventoryStore({ memoryOnly: true });
  for (const name of ["R3TA 10mg", "Reta 10mg", "tirz", "GLP-1 20mg", "GLP2", "GLP2-TPT", "Sema 10mg", "Retatrutide 10mg", "Tirzepatide", "Semaglutide 10mg"]) {
    assert.equal(store.upsertSku({ code: "X-1", name }).error, "public_name_banned", name);
  }
  for (const [code, name] of [["G3-R-10", "G3-R 10mg"], ["G3-R-30", "G3-R 30mg"], ["G3-R-60", "G3-R 60mg"], ["G2-T-20", "G2-T 20mg"],
    ["G1-S-10", "G1-S 10mg"], ["G1-S-20", "G1-S 20mg"], ["RC02-500", "RC-02 500mg"], ["SEMAX-10", "Semax 10mg"], ["RET-1", "retail kit"]]) {
    assert.equal(store.upsertSku({ code, name }).ok, true, name);
  }
});
