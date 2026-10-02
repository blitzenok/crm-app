/**
 * infra 2026-09-30 P0 3.01: checkout refuses hidden catalog items before anything is routed, priced, created or charged.
 * Same rule as products-api storefrontSellable(): a product with is_active:false, or a strength listed in its
 * hidden_strengths, is not sold. Source: products-api catalog file (CATALOG_PATH), re-read when its mtime changes.
 * Lines that do not match a catalog product (free gift, typos) are left to server pricing (unknown_item), not judged here.
 * Catalog unreadable -> the guard does not block (server pricing via coupon-quote refuses hidden lines as well) and logs.
 */
import { readFileSync, statSync } from "node:fs";
import { splitCartSku } from "./pricing.js";

export const DEFAULT_CATALOG_PATH = "/var/www/mastersol/html/MSOLPEPTIDES/products-data.json";
let cache = { path: "", mtimeMs: -1, products: null };

function normMg(mg) {
  return String(mg == null ? "" : mg).replace(/\s+/g, "").toLowerCase();
}

function loadCatalog(path) {
  try {
    const st = statSync(path);
    if (cache.path === path && cache.mtimeMs === st.mtimeMs && cache.products) return cache.products;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("catalog is not an array");
    cache = { path, mtimeMs: st.mtimeMs, products: parsed };
    return parsed;
  } catch (err) {
    process.stdout.write(`[catalog-guard] catalog unreadable (${err?.message || err}); guard skipped, server pricing still applies\n`);
    return null;
  }
}

/** items: checkout lines [{sku|slug, name, mg?}]. -> { ok:true } | { ok:false, items:[{sku, slug, mg, name, reason}] } */
export function findUnavailableItems(items, opts = {}) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) return { ok: true, items: [] };
  const catalog = loadCatalog(opts.catalogPath || process.env.CATALOG_PATH || DEFAULT_CATALOG_PATH);
  if (!catalog) return { ok: true, items: [], skipped: true };
  const bySlug = new Map();
  const byName = new Map();
  for (const p of catalog) {
    if (!p || typeof p !== "object") continue;
    if (p.slug) bySlug.set(String(p.slug).toLowerCase(), p);
    if (p.name) byName.set(String(p.name).trim().toLowerCase(), p);
  }
  const out = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const rawName = String(it.name || "").trim();
    const nameMg = (rawName.match(/\s(\d+(?:\.\d+)?\s*(?:mg|mcg|g|iu|ml))$/i) || [])[1] || "";
    const baseName = rawName.replace(/\s+\d+(?:\.\d+)?\s*(mg|mcg|g|iu|ml)$/i, "").toLowerCase();
    const split = splitCartSku(it.sku || it.slug || "");
    const product = (split.slug && bySlug.get(split.slug)) || (baseName && byName.get(baseName)) || null;
    if (!product) continue;
    const mg = normMg(split.mg || it.mg || nameMg);
    const hidden = new Set((Array.isArray(product.hidden_strengths) ? product.hidden_strengths : []).map(normMg).filter(Boolean));
    let reason = null;
    if (product.is_active === false) reason = "product_inactive";
    else if (mg && hidden.has(mg)) reason = "strength_hidden";
    if (reason) out.push({ sku: String(it.sku || "").slice(0, 80), slug: product.slug, mg: mg || null, name: String(product.name || rawName).slice(0, 120), reason });
  }
  return out.length ? { ok: false, items: out } : { ok: true, items: [] };
}

export const ITEM_UNAVAILABLE_MESSAGE =
  "Some items in your cart are no longer available. Please remove them and try again. You were not charged.";

/** 409 body for a refused cart. */
export function itemUnavailableBody(items) {
  return { ok: false, error: "item_unavailable", items, charged: false, message: ITEM_UNAVAILABLE_MESSAGE };
}
