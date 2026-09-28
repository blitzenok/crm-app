import { randomBytes } from "node:crypto";
import { formatAmount } from "./card.js";
import { stripSecrets } from "./sanitize.js";
import { findForbiddenCardField } from "./abandon.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ERC20_RE = /^0x[a-fA-F0-9]{40}$/;
const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TX_HASH_RE = /^(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64})$/;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const AWAITING_CRYPTO = "awaiting_crypto";
export const CRYPTO_PAID = "crypto_paid";

export const AWAITING_MESSAGE =
  "Awaiting crypto confirmation. Send the exact USDT amount and put the order reference in the transfer memo. This is not a completed payment. Do not record a purchase.";

export const PAID_MESSAGE =
  "Crypto payment confirmed by staff. Fulfillment may proceed only after this confirmation. Shipping is a separate staff action.";

function nowIso() {
  return new Date().toISOString();
}

function readCustomer(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  return stripSecrets({
    first_name: c.first_name || c.firstName || "",
    last_name: c.last_name || c.lastName || "",
    email: String(c.email || "").trim(),
    phone: c.phone || "",
    address: c.address || "",
    city: c.city || "",
    state: c.state || "",
    zip: c.zip || c.postal_code || c.postalCode || "",
    country: c.country || "",
  });
}

function readItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => {
    const row = it && typeof it === "object" ? it : {};
    const qty = Number(row.qty ?? row.quantity);
    return {
      sku: String(row.sku || "").trim(),
      name: String(row.name || "").trim(),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      amount: formatAmount(row.amount),
    };
  });
}

/**
 * Deposit addresses come only from the process environment.
 * Values that are not a USDT ERC-20 or TRC-20 address are dropped
 * so a private key pasted into the env is never returned to the storefront.
 */
export function depositWallets(env = process.env) {
  const erc = String(env.CRYPTO_USDT_ERC || "").trim();
  const trc = String(env.CRYPTO_USDT_TRC || "").trim();
  return {
    usdtErc20: ERC20_RE.test(erc) ? erc : null,
    usdtTrc20: TRC20_RE.test(trc) ? trc : null,
  };
}

export function walletFlags(env = process.env) {
  const wallets = depositWallets(env);
  return {
    erc20: Boolean(wallets.usdtErc20),
    trc20: Boolean(wallets.usdtTrc20),
  };
}

export function walletsReady(wallets) {
  return Boolean(wallets && (wallets.usdtErc20 || wallets.usdtTrc20));
}

export function newOrderRef() {
  const bytes = randomBytes(8);
  let ref = "CR-";
  for (let i = 0; i < 8; i += 1) ref += REF_ALPHABET[bytes[i] % REF_ALPHABET.length];
  return ref;
}

function allocateOrderRef(store) {
  for (let i = 0; i < 6; i += 1) {
    const ref = newOrderRef();
    if (!store.getOrderByRef(ref)) return ref;
  }
  return null;
}

export function statusUrlFor(orderRef, env = process.env) {
  const path = `/api/checkout/crypto/${encodeURIComponent(orderRef)}`;
  const base = String(env.CRM_PUBLIC_URL || "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export function validateCryptoCheckout(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "invalid_body", status: 400 };
  }
  if (findForbiddenCardField(input)) {
    return { ok: false, error: "card_not_accepted", status: 400 };
  }

  const idempotencyKey = String(input.idempotencyKey || input.extOrderId || "").trim();
  if (!idempotencyKey) {
    return { ok: false, error: "idempotency_key_required", status: 400 };
  }

  const amountNum = Number(input.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0 || amountNum > 1_000_000) {
    return { ok: false, error: "invalid_amount", status: 400 };
  }

  const currency = String(input.currency || "USD").trim().toUpperCase() || "USD";
  if (currency !== "USD" && currency !== "USDT") {
    return { ok: false, error: "invalid_currency", status: 400 };
  }

  let network = String(input.network || input.chain || "").trim().toLowerCase();
  if (network === "erc" || network === "erc-20" || network === "eth") network = "erc20";
  if (network === "trc" || network === "trc-20" || network === "trx") network = "trc20";
  if (network && network !== "erc20" && network !== "trc20") {
    return { ok: false, error: "invalid_network", status: 400 };
  }

  const customer = readCustomer(input.customer);
  if (!customer.email) return { ok: false, error: "email_required", status: 400 };
  if (!EMAIL_RE.test(customer.email)) return { ok: false, error: "invalid_email", status: 400 };
  if (!customer.first_name && !customer.last_name) {
    return { ok: false, error: "name_required", status: 400 };
  }

  const items = readItems(input.items);
  if (!items.length) return { ok: false, error: "items_required", status: 400 };
  for (const it of items) {
    if (!it.sku && !it.name) return { ok: false, error: "invalid_item", status: 400 };
    if (it.qty < 1) return { ok: false, error: "invalid_item_qty", status: 400 };
  }

  return {
    ok: true,
    value: {
      idempotencyKey,
      amount: formatAmount(input.amount),
      currency,
      network: network || null,
      customer,
      items,
      notes: String(input.notes || "").slice(0, 2000),
      session_id: String(input.session_id || input.sessionId || "").trim(),
      test: input.test === true,
    },
  };
}

export function isCryptoPaid(order) {
  return Boolean(order && order.paymentMethod === "crypto" && order.status === CRYPTO_PAID && order.paymentConfirmed === true);
}

export function isShippable(order) {
  if (!order || order.fulfillment?.status === "shipped") return false;
  if (order.paymentMethod === "crypto" || order.status === AWAITING_CRYPTO || order.status === CRYPTO_PAID) {
    return isCryptoPaid(order) && order.fulfillment?.status !== "shipped";
  }
  return order.status === "approved";
}

function blockedFulfillment() {
  return {
    status: "blocked",
    shippable: false,
    blockedReason: "awaiting_crypto",
    shippedAt: null,
    shippedBy: null,
  };
}

function readyFulfillment(prev) {
  return {
    status: "ready",
    shippable: true,
    blockedReason: null,
    shippedAt: prev?.shippedAt || null,
    shippedBy: prev?.shippedBy || null,
  };
}

export function toPublicCryptoView(order, env = process.env) {
  const paid = isCryptoPaid(order);
  const fulfillment = order.fulfillment?.status || (paid ? "ready" : "blocked");
  const wallets = order.depositWallets || depositWallets(env);
  return {
    ok: true,
    orderId: order.id,
    orderRef: order.orderRef,
    status: order.status,
    amount: order.amount,
    currency: order.currency,
    amountDue: order.amountDue || order.amount,
    priceAdjusted: Boolean(order.priceMismatch),
    payAsset: "USDT",
    network: order.crypto?.network || null,
    paymentConfirmed: paid,
    analyticsEvent: paid ? "purchase" : null,
    fulfillment,
    shippable: paid && fulfillment === "ready",
    wallets,
    walletsReady: walletsReady(wallets),
    statusUrl: statusUrlFor(order.orderRef, env),
    createdAt: order.createdAt,
    paidAt: order.crypto?.markedPaidAt || null,
    message: paid ? PAID_MESSAGE : AWAITING_MESSAGE,
  };
}

export function createCryptoCheckout(input, deps) {
  const store = deps.store;
  const env = deps.env || process.env;
  const parsed = validateCryptoCheckout(input);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: parsed.status };

  const existing = store.getOrderByIdempotency(parsed.value.idempotencyKey);
  if (existing) {
    if (existing.paymentMethod !== "crypto") {
      return { ok: false, error: "idempotency_conflict", status: 409 };
    }
    return {
      ok: true,
      reused: true,
      status: 200,
      order: existing,
      public: toPublicCryptoView(existing, env),
    };
  }

  // Server-side price (route passes deps.pricing when CRYPTO_SERVER_PRICING is on): the browser's amount is kept for
  // the record only; the customer is told to send the server amount.
  const pricing = deps.pricing && deps.pricing.ok ? deps.pricing : null;
  const amount = pricing ? pricing.amount : parsed.value.amount;

  const orderRef = allocateOrderRef(store);
  if (!orderRef) return { ok: false, error: "order_ref_unavailable", status: 500 };

  const createdAt = nowIso();
  const wallets = depositWallets(env);
  const order = {
    id: store.nextOrderId(),
    orderRef,
    idempotencyKey: parsed.value.idempotencyKey,
    paymentMethod: "crypto",
    createdAt,
    updatedAt: createdAt,
    status: AWAITING_CRYPTO,
    paymentConfirmed: false,
    analyticsEvent: null,
    inFlight: false,
    amount,
    amountDue: amount,
    ...(pricing
      ? {
          priceCheck: {
            source: pricing.source,
            clientAmount: pricing.clientAmount,
            serverAmount: pricing.amount,
            subtotal: pricing.subtotal,
            shipping: pricing.shipping,
            shipMethod: pricing.shipMethod,
            mismatch: pricing.mismatch,
            discountInfo: pricing.discountInfo,
            volumeDiscount: pricing.volumeDiscount || null,
            lines: pricing.lines,
          },
          priceMismatch: pricing.mismatch,
        }
      : {}),
    currency: parsed.value.currency,
    payAsset: "USDT",
    customer: parsed.value.customer,
    items: parsed.value.items,
    notes: parsed.value.notes,
    session_id: parsed.value.session_id,
    ...(parsed.value.test ? { test: true } : {}),
    depositWallets: wallets,
    crypto: {
      network: parsed.value.network,
      txHash: null,
      markedPaidAt: null,
      markedPaidBy: null,
      markedPaidVia: null,
    },
    fulfillment: blockedFulfillment(),
    winningProcessor: null,
    winningTxnId: null,
    descriptor: null,
    lastProcessor: null,
    lastStatus: null,
    attempts: [],
  };

  store.upsertOrder(order);
  const saved = store.getOrder(order.id);
  return {
    ok: true,
    reused: false,
    status: 200,
    order: saved,
    public: toPublicCryptoView(saved, env),
  };
}

export function publicCryptoStatus(store, orderRef, env = process.env) {
  const ref = String(orderRef || "").trim();
  if (!ref || ref.includes("/") || ref.includes("\\")) return null;
  const order = store.getOrderByRef(ref);
  if (!order || order.paymentMethod !== "crypto") return null;
  return toPublicCryptoView(order, env);
}

export function normalizeTxHash(raw) {
  if (raw == null || String(raw).trim() === "") return { ok: true, value: null };
  const value = String(raw).trim();
  if (!TX_HASH_RE.test(value)) return { ok: false, error: "invalid_tx_hash" };
  return { ok: true, value };
}

function readNetwork(raw) {
  let n = String(raw || "").trim().toLowerCase();
  if (n === "erc" || n === "erc-20" || n === "eth") n = "erc20";
  if (n === "trc" || n === "trc-20" || n === "trx") n = "trc20";
  return n === "erc20" || n === "trc20" ? n : null;
}

function readReceivedAmount(input) {
  const raw = input?.amountReceived ?? input?.amount_received;
  if (raw == null || String(raw).trim() === "") return { ok: false, error: "amount_received_required" };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return { ok: false, error: "invalid_amount_received" };
  return { ok: true, value: formatAmount(n) };
}

export function readTracking(input) {
  const src = input && typeof input === "object" ? input : {};
  const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, max);
  const carrier = clean(src.carrier, 60);
  const trackingNumber = clean(src.trackingNumber ?? src.tracking_number ?? src.tracking, 80);
  let trackingUrl = clean(src.trackingUrl ?? src.tracking_url, 500);
  if (trackingUrl && !/^https:\/\//i.test(trackingUrl)) trackingUrl = "";
  return { carrier: carrier || null, trackingNumber: trackingNumber || null, trackingUrl: trackingUrl || null };
}

function findCryptoOrder(store, idOrRef) {
  const key = String(idOrRef || "").trim();
  if (!key) return null;
  return store.getOrder(key) || store.getOrderByRef(key);
}

export function markCryptoPaid(idOrRef, input, deps) {
  const store = deps.store;
  const order = findCryptoOrder(store, idOrRef);
  if (!order) return { ok: false, error: "not_found", status: 404 };
  if (order.paymentMethod !== "crypto") {
    return { ok: false, error: "not_crypto_order", status: 409 };
  }

  const tx = normalizeTxHash(input?.txHash ?? input?.tx_hash ?? input?.paymentHash);
  if (!tx.ok) return { ok: false, error: tx.error, status: 400 };

  if (order.status === CRYPTO_PAID && order.paymentConfirmed === true) {
    if (tx.value && !order.crypto?.txHash) {
      order.crypto = { ...(order.crypto || {}), txHash: tx.value };
      order.updatedAt = nowIso();
      store.upsertOrder(order);
    }
    const saved = store.getOrder(order.id);
    return { ok: true, reused: true, status: 200, order: saved, public: toPublicCryptoView(saved, deps.env) };
  }

  if (order.status !== AWAITING_CRYPTO) {
    return { ok: false, error: "not_awaiting_crypto", status: 409, order };
  }

  // Legal: confirm only after an on-chain check, with the TXID and the amount received on record.
  if (!tx.value) return { ok: false, error: "tx_hash_required", status: 400 };
  const received = readReceivedAmount(input);
  if (!received.ok) return { ok: false, error: received.error, status: 400 };
  const due = Number(order.amountDue || order.amount);
  if (Number.isFinite(due) && Number(received.value) + 0.005 < due) {
    return { ok: false, error: "amount_short", status: 409, amountDue: formatAmount(due), amountReceived: received.value };
  }
  const network = readNetwork(input?.network) || order.crypto?.network || null;
  if (!network) return { ok: false, error: "network_required", status: 400 };
  if (network === "trc20" && tx.value.startsWith("0x")) return { ok: false, error: "tx_hash_network_mismatch", status: 400 };

  const at = nowIso();
  order.status = CRYPTO_PAID;
  order.paymentConfirmed = true;
  order.analyticsEvent = "purchase";
  order.updatedAt = at;
  order.crypto = {
    ...(order.crypto || {}),
    network,
    txHash: tx.value,
    amountReceived: received.value,
    markedPaidAt: at,
    markedPaidBy: String(deps.actor || "operator").slice(0, 160),
    markedPaidVia: String(deps.via || "operator").slice(0, 40),
  };
  order.fulfillment = readyFulfillment(order.fulfillment);
  store.upsertOrder(order);
  const saved = store.getOrder(order.id);
  return { ok: true, reused: false, status: 200, order: saved, public: toPublicCryptoView(saved, deps.env) };
}

export function shipOrder(idOrRef, deps, input) {
  const store = deps.store;
  const order = findCryptoOrder(store, idOrRef);
  if (!order) return { ok: false, error: "not_found", status: 404 };

  if (order.fulfillment?.status === "shipped") {
    return { ok: false, error: "already_shipped", status: 409, order };
  }

  if (!isShippable(order)) {
    return {
      ok: false,
      error: "ship_blocked",
      status: 409,
      orderStatus: order.status,
      fulfillment: order.fulfillment?.status || "blocked",
      paymentConfirmed: Boolean(order.paymentConfirmed),
      order,
    };
  }

  const at = nowIso();
  order.fulfillment = {
    status: "shipped",
    shippable: false,
    blockedReason: null,
    shippedAt: at,
    shippedBy: String(deps.actor || "operator").slice(0, 160),
    ...readTracking(input),
  };
  order.updatedAt = at;
  store.upsertOrder(order);
  return { ok: true, status: 200, order: store.getOrder(order.id) };
}

/** Set or correct carrier / tracking number on an order that is already shipped. */
export function updateTracking(idOrRef, input, deps) {
  const store = deps.store;
  const order = findCryptoOrder(store, idOrRef);
  if (!order) return { ok: false, error: "not_found", status: 404 };
  if (order.fulfillment?.status !== "shipped") return { ok: false, error: "not_shipped", status: 409, order };
  const t = readTracking(input);
  if (!t.trackingNumber) return { ok: false, error: "tracking_number_required", status: 400 };
  const at = nowIso();
  order.fulfillment = {
    ...order.fulfillment,
    ...t,
    trackingUpdatedAt: at,
    trackingUpdatedBy: String(deps.actor || "operator").slice(0, 160),
  };
  order.updatedAt = at;
  store.upsertOrder(order);
  return { ok: true, status: 200, order: store.getOrder(order.id) };
}
