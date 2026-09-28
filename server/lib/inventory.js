import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Runtime ledger. Gitignored under server/data/*.json. Not the public catalog. */
export const INVENTORY_PATH = join(__dirname, "..", "data", "inventory.json");

export const MOVEMENT_TYPE_PO_INTAKE = "PO_INTAKE";

/**
 * Public SKU names must stay on the G3-R / catalog labels.
 * Retatrutide, Reta, and the other INNs are not display names.
 * Alias notes on a PO record are a different field and are not checked here.
 */
// INN names plus their short forms / supplier aliases; the short forms only as a standalone word (no letter on either side),
// so "Semax" or "retail" are not caught but "R3TA 10mg", "Reta", "tirz", "GLP-1" are. Same list as rapid-orders STANDALONE_TERMS.
const PUBLIC_NAME_BANNED = /retatrutide|tirzepatide|semaglutide|(^|[^a-z])(r3ta|reta|sema|tirz|glp|trutide)($|[^a-z])/i;

export function dollarsToCents(value) {
  const s = String(value ?? "").trim();
  if (!/^\d+(\.\d{1,2})?$/.test(s)) {
    throw new Error("invalid_money");
  }
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number((frac + "00").slice(0, 2));
}

export function centsToDollars(cents) {
  const n = Math.trunc(Number(cents) || 0);
  const neg = n < 0;
  const abs = Math.abs(n);
  const body = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
  return neg ? `-${body}` : body;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function emptyData() {
  return {
    skus: [],
    purchase_orders: [],
    purchase_order_lines: [],
    inventory_movements: [],
  };
}

export function movementIdempotencyKey(movement) {
  return `${movement.po_id}|${movement.sku_id}|${movement.type}`;
}

function publicNameAllowed(name) {
  return !PUBLIC_NAME_BANNED.test(String(name || ""));
}

function stripBankDetails(row) {
  if (!row || typeof row !== "object") return;
  for (const key of Object.keys(row)) {
    if (/(bank|routing|iban|swift|\baba\b|account_number|account_no|^account$)/i.test(key)) {
      delete row[key];
    }
  }
}

function normalizeLoaded(parsed) {
  const data = emptyData();
  data.skus = Array.isArray(parsed?.skus) ? parsed.skus : [];
  data.purchase_orders = Array.isArray(parsed?.purchase_orders) ? parsed.purchase_orders : [];
  data.purchase_order_lines = Array.isArray(parsed?.purchase_order_lines) ? parsed.purchase_order_lines : [];
  const movements = Array.isArray(parsed?.inventory_movements) ? parsed.inventory_movements : [];
  const seen = new Set();
  data.inventory_movements = [];
  for (const movement of movements) {
    if (!movement || !movement.po_id || !movement.sku_id || !movement.type) continue;
    const key = movement.idempotency_key || movementIdempotencyKey(movement);
    if (seen.has(key)) continue;
    seen.add(key);
    const copy = { ...movement, idempotency_key: key };
    data.inventory_movements.push(copy);
  }
  for (const sku of data.skus) {
    if (sku && Object.prototype.hasOwnProperty.call(sku, "on_hand")) delete sku.on_hand;
  }
  for (const po of data.purchase_orders) stripBankDetails(po);
  for (const line of data.purchase_order_lines) stripBankDetails(line);
  return data;
}

export function createInventoryStore(opts = {}) {
  const memoryOnly = opts.memoryOnly === true;
  const filePath = opts.filePath || null;
  let data = emptyData();

  if (!memoryOnly && filePath && existsSync(filePath)) {
    try {
      data = normalizeLoaded(JSON.parse(readFileSync(filePath, "utf8")));
    } catch {
      data = emptyData();
    }
  }

  function persist() {
    if (memoryOnly || !filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    const clean = normalizeLoaded(data);
    data.inventory_movements = clean.inventory_movements;
    writeFileSync(filePath, JSON.stringify(data, null, 2));
  }

  function findSkuIndex(sku) {
    const id = sku.id ? String(sku.id) : "";
    const code = sku.code ? String(sku.code) : "";
    return data.skus.findIndex((row) => (id && row.id === id) || (code && row.code === code));
  }

  return {
    snapshot() {
      return clone(data);
    },
    listSkus() {
      return clone(data.skus);
    },
    listPurchaseOrders() {
      return clone(data.purchase_orders);
    },
    listLines() {
      return clone(data.purchase_order_lines);
    },
    listMovements() {
      return clone(data.inventory_movements);
    },
    upsertSku(input) {
      const code = String(input?.code || "").trim();
      const name = String(input?.name || "").trim();
      if (!code || !name) return { ok: false, error: "sku_required" };
      if (!publicNameAllowed(code) || !publicNameAllowed(name)) {
        return { ok: false, error: "public_name_banned" };
      }
      const idx = findSkuIndex({ id: input.id, code });
      const existing = idx === -1 ? null : data.skus[idx];
      const next = {
        id: existing?.id || input.id || `sku:${code}`,
        code,
        name,
        created_at: existing?.created_at || input.created_at || new Date().toISOString(),
        updated_at: input.updated_at || existing?.updated_at || input.created_at || new Date().toISOString(),
      };
      if (existing && Object.prototype.hasOwnProperty.call(existing, "stock_qty")) {
        next.stock_qty = existing.stock_qty;
      }
      if (existing && existing.rapid_stock) next.rapid_stock = existing.rapid_stock;
      if (idx === -1) data.skus.push(next);
      else data.skus[idx] = next;
      persist();
      return { ok: true, sku: clone(next) };
    },
    /** Rapid 3PL stock snapshot, kept beside (never instead of) stock_qty. Matches the SKU by code (case-insensitive). */
    setRapidStock(code, snapshot) {
      const want = String(code || "").trim().toUpperCase();
      if (!want) return { ok: false, error: "code_required" };
      const row = data.skus.find((r) => String(r.code || "").toUpperCase() === want);
      if (!row) return { ok: false, error: "sku_not_found" };
      row.rapid_stock = { ...snapshot };
      persist();
      return { ok: true, sku: clone(row) };
    },
    upsertPurchaseOrder(input) {
      const poId = String(input?.po_id || input?.po_number || input?.id || "").trim();
      if (!poId) return { ok: false, error: "po_id_required" };
      const idx = data.purchase_orders.findIndex((row) => row.po_id === poId || row.id === poId || row.po_number === poId);
      const existing = idx === -1 ? null : data.purchase_orders[idx];
      const next = {
        ...(existing || {}),
        ...input,
        id: poId,
        po_id: poId,
        po_number: String(input.po_number || existing?.po_number || poId),
      };
      if (existing && Object.prototype.hasOwnProperty.call(existing, "stock_qty")) {
        next.stock_qty = existing.stock_qty;
      }
      delete next.on_hand;
      stripBankDetails(next);
      if (idx === -1) data.purchase_orders.push(next);
      else data.purchase_orders[idx] = next;
      persist();
      return { ok: true, purchase_order: clone(next) };
    },
    upsertLine(input) {
      const poId = String(input?.po_id || "").trim();
      if (!poId) return { ok: false, error: "po_id_required" };
      const skuId = input?.sku_id ? String(input.sku_id) : null;
      const lineNo = Number(input?.line_no) || null;
      const id = input.id || (skuId ? `ln:${poId}:${skuId}` : `ln:${poId}:${lineNo || "x"}`);
      const idx = data.purchase_order_lines.findIndex((row) => {
        if (row.id === id) return true;
        if (row.po_id !== poId) return false;
        if (skuId && row.sku_id === skuId) return true;
        if (!skuId && lineNo != null && Number(row.line_no) === lineNo) return true;
        return false;
      });
      const existing = idx === -1 ? null : data.purchase_order_lines[idx];
      const next = {
        ...(existing || {}),
        ...input,
        id: existing?.id || id,
        po_id: poId,
        sku_id: skuId,
        line_no: lineNo,
      };
      delete next.on_hand;
      delete next.stock_qty;
      stripBankDetails(next);
      if (idx === -1) data.purchase_order_lines.push(next);
      else data.purchase_order_lines[idx] = next;
      persist();
      return { ok: true, line: clone(next) };
    },
    insertMovement(input) {
      const poId = String(input?.po_id || "").trim();
      const skuId = String(input?.sku_id || "").trim();
      const type = String(input?.type || "").trim();
      const createdBy = String(input?.created_by || "").trim();
      const createdAt = String(input?.created_at || "").trim();
      const qty = Number(input?.qty);
      const unitCost = input?.unit_cost_cents;
      if (!poId) return { ok: false, created: false, error: "po_id_required" };
      if (!skuId) return { ok: false, created: false, error: "sku_id_required" };
      if (!type) return { ok: false, created: false, error: "type_required" };
      if (!createdBy) return { ok: false, created: false, error: "created_by_required" };
      if (!createdAt) return { ok: false, created: false, error: "created_at_required" };
      if (!Number.isInteger(qty) || qty === 0) return { ok: false, created: false, error: "qty_required" };
      if (!Number.isInteger(unitCost) || unitCost < 0) return { ok: false, created: false, error: "unit_cost_required" };
      const key = movementIdempotencyKey({ po_id: poId, sku_id: skuId, type });
      const existing = data.inventory_movements.find((row) => (row.idempotency_key || movementIdempotencyKey(row)) === key);
      if (existing) return { ok: true, created: false, movement: clone(existing) };
      const movement = {
        id: input.id || `mv:${key}`,
        sku_id: skuId,
        po_id: poId,
        type,
        qty,
        unit_cost_cents: unitCost,
        created_by: createdBy.slice(0, 160),
        created_at: createdAt,
        idempotency_key: key,
      };
      data.inventory_movements.push(movement);
      persist();
      return { ok: true, created: true, movement: clone(movement) };
    },
  };
}

export function onHandQty(movements, skuId) {
  return movements
    .filter((row) => row.sku_id === skuId)
    .reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
}

export function weightedAvgUnitCostCents(movements) {
  let qty = 0;
  let extended = 0;
  for (const row of movements) {
    const q = Number(row.qty) || 0;
    if (q <= 0 || !Number.isInteger(row.unit_cost_cents)) continue;
    qty += q;
    extended += q * row.unit_cost_cents;
  }
  if (qty === 0) return null;
  return Math.round(extended / qty);
}

function skuCode(skus, skuId) {
  return skus.find((row) => row.id === skuId)?.code || null;
}

export function buildInventoryView(store) {
  const skus = store.listSkus();
  const lines = store.listLines();
  const movements = store.listMovements();
  const purchaseOrders = store.listPurchaseOrders();

  const skuRows = skus.map((sku) => {
    const skuMovements = movements.filter((row) => row.sku_id === sku.id);
    const onHand = onHandQty(movements, sku.id);
    const avg = weightedAvgUnitCostCents(skuMovements);
    const linked = new Set();
    for (const line of lines) {
      if (line.sku_id === sku.id) linked.add(line.po_id);
    }
    for (const movement of skuMovements) linked.add(movement.po_id);
    const legacyPresent = Object.prototype.hasOwnProperty.call(sku, "stock_qty");
    return {
      id: sku.id,
      code: sku.code,
      name: sku.name,
      on_hand: onHand,
      on_hand_source: "sum(inventory_movements.qty)",
      weighted_avg_unit_cost: avg == null ? null : centsToDollars(avg),
      value_at_cost: avg == null || onHand <= 0 ? "0.00" : centsToDollars(onHand * avg),
      legacy_stock_qty: legacyPresent ? sku.stock_qty : null,
      legacy_stock_readonly: true,
      rapid_stock: sku.rapid_stock || null,
      linked_pos: [...linked],
    };
  });

  const orderRows = purchaseOrders
    .map((po) => {
      const poLines = lines.filter((line) => line.po_id === po.po_id);
      const poMovements = movements.filter((row) => row.po_id === po.po_id);
      const costs = Array.isArray(po.po_level_costs) ? po.po_level_costs : [];
      const goods = poLines.reduce((sum, line) => sum + (Number(line.line_total_cents) || 0), 0);
      const extra = costs.reduce((sum, cost) => sum + (Number(cost.amount_cents) || 0), 0);
      return {
        po_id: po.po_id,
        po_number: po.po_number,
        supplier: po.supplier,
        dated: po.dated,
        status: po.status,
        ship_to: po.ship_to ?? null,
        goods_total: centsToDollars(goods),
        po_level_costs: costs.map((cost) => ({
          label: cost.label,
          amount: centsToDollars(cost.amount_cents),
          note: cost.note || "PO-level cost, not per-unit",
        })),
        total: centsToDollars(goods + extra),
        invoice_goods_target: po.invoice_goods_target_cents == null ? null : centsToDollars(po.invoice_goods_target_cents),
        invoice_units_target: po.invoice_units_target ?? null,
        invoice_line_target: po.invoice_line_target ?? null,
        alias_map: po.alias_map || null,
        notes: po.notes || "",
        movement_count: poMovements.length,
        can_mark_received: po.status !== "RECEIVED",
        lines: poLines.map((line) => ({
          id: line.id,
          po_id: line.po_id,
          line_no: line.line_no,
          sku_id: line.sku_id,
          sku_code: line.sku_id ? skuCode(skus, line.sku_id) : null,
          supplier_name: line.supplier_name || null,
          suggested_internal_code_note: line.suggested_internal_code_note || "",
          qty: line.qty,
          unit_cost: centsToDollars(line.unit_cost_cents),
          line_total: centsToDollars(line.line_total_cents),
        })),
        movements: poMovements.map((row) => ({
          id: row.id,
          sku_id: row.sku_id,
          sku_code: skuCode(skus, row.sku_id),
          po_id: row.po_id,
          type: row.type,
          qty: row.qty,
          unit_cost: centsToDollars(row.unit_cost_cents),
          created_by: row.created_by,
          created_at: row.created_at,
          idempotency_key: row.idempotency_key,
        })),
      };
    })
    .sort((a, b) => String(a.dated).localeCompare(String(b.dated)));

  const onHandUnits = skuRows.reduce((sum, row) => sum + row.on_hand, 0);
  const valueCents = skuRows.reduce((sum, row) => sum + dollarsToCents(row.value_at_cost), 0);

  return {
    source: "sum(inventory_movements.qty)",
    legacy_stock_qty: "readonly",
    storefront_catalog_updated: false,
    public_quantity_exposed: false,
    on_hand_units: onHandUnits,
    value_at_cost: centsToDollars(valueCents),
    skus: skuRows,
    purchase_orders: orderRows,
  };
}

/**
 * Posts PO_INTAKE movements for a purchase order that already has sku_id on every line.
 * Refuses when lines are missing or still unmapped, and writes nothing in that case.
 * Seed/intake must not call this.
 */
export function markPurchaseOrderReceived(store, poId, actor, createdAt = new Date().toISOString()) {
  const want = String(poId || "").trim();
  const po = store.listPurchaseOrders().find((row) => row.po_id === want || row.po_number === want);
  if (!po) return { ok: false, status: 404, error: "not_found", movements_created: 0 };
  const lines = store.listLines().filter((line) => line.po_id === po.po_id);
  if (lines.length === 0) {
    return {
      ok: false,
      status: 409,
      error: "no_lines",
      movements_created: 0,
      message: "No movements were created. This PO has no lines to receive.",
    };
  }
  if (lines.some((line) => !line.sku_id)) {
    return {
      ok: false,
      status: 409,
      error: "sku_mapping_required",
      movements_created: 0,
      message: "No movements were created. Supplier invoice names stay on the PO lines until Yehuda approves an internal SKU mapping.",
    };
  }
  const createdBy = String(actor || "").trim();
  if (!createdBy) {
    return { ok: false, status: 400, error: "created_by_required", movements_created: 0 };
  }
  let movementsCreated = 0;
  let movementsExisting = 0;
  for (const line of lines) {
    const posted = store.insertMovement({
      id: `mv:${po.po_id}:${line.sku_id}:${MOVEMENT_TYPE_PO_INTAKE}`,
      sku_id: line.sku_id,
      po_id: po.po_id,
      type: MOVEMENT_TYPE_PO_INTAKE,
      qty: line.qty,
      unit_cost_cents: line.unit_cost_cents,
      created_by: createdBy,
      created_at: createdAt,
    });
    if (!posted.ok) {
      return { ok: false, status: 400, error: posted.error, movements_created: movementsCreated };
    }
    if (posted.created) movementsCreated += 1;
    else movementsExisting += 1;
  }
  store.upsertPurchaseOrder({
    po_id: po.po_id,
    status: "RECEIVED",
  });
  return {
    ok: true,
    status: 200,
    movements_created: movementsCreated,
    movements_existing: movementsExisting,
    reused: movementsCreated === 0,
    po_id: po.po_id,
    status_after: "RECEIVED",
  };
}
