import { randomBytes } from "node:crypto";
import { formatAmount } from "./card.js";
import { stripSecrets } from "./sanitize.js";
import { findForbiddenCardField } from "./abandon.js";
import {
  PAY, allocatePayAmount, confirmSecret, cryptoVerifyConfig, isCryptoVerified, isTokenAccepted, normalizeHint, paymentDeadline, signConfirmToken,
} from "./crypto-payment.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ERC20_RE = /^0x[a-fA-F0-9]{40}$/;
const TRC20_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TX_HASH_RE = /^(0x[a-fA-F0-9]{64}|[a-fA-F0-9]{64})$/;
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const AWAITING_CRYPTO = "awaiting_crypto";
export const CRYPTO_PAID = "crypto_paid";

export const CRYPTO_REVIEW = "crypto_review";
export const CRYPTO_CANCELLED = "crypto_cancelled";

export const AWAITING_MESSAGE =
  "Send the exact amount within 60 minutes. Unpaid orders are cancelled automatically. This is not a completed payment until it is confirmed on the blockchain.";
export const CONFIRMED_BY_CUSTOMER_MESSAGE =
  "Thanks. We're checking the blockchain and will email you once your payment is confirmed.";
export const PAID_MESSAGE =
  "Payment confirmed on the blockchain. Your order is being prepared. Shipping is a separate step.";
export const REVIEW_MESSAGE =
  "We received a payment that needs a manual check (amount, token or network). Our team will contact you by email.";
export const CANCELLED_MESSAGE =
  "Payment was not received within the payment window, so this order was cancelled. If you already paid, reply to our email with the transaction hash.";

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
  if (currency !== "USD" && currency !== "USDT" && currency !== "USDC") {
    return { ok: false, error: "invalid_currency", status: 400 };
  }

  let network = String(input.network || input.chain || "").trim().toLowerCase();
  if (network === "erc" || network === "erc-20" || network === "eth") network = "erc20";
  if (network === "trc" || network === "trc-20" || network === "trx") network = "trc20";
  if (network && network !== "erc20" && network !== "trc20") {
    return { ok: false, error: "invalid_network", status: 400 };
  }

  // Asset the customer will send. Default USDT (unchanged behaviour). USDC exists on ERC20 only (owner decision
  // 2026-09-28): USDC needs network "erc20" explicitly; USDC on TRC20 is refused here, before any order is created.
  const token = String(input.token || input.asset || input.payAsset || "USDT").trim().toUpperCase();
  if (token !== "USDT" && token !== "USDC") return { ok: false, error: "invalid_asset", status: 400 };
  if (token === "USDC" && !network) return { ok: false, error: "network_required", status: 400 };
  if (token === "USDC" && network !== "erc20") return { ok: false, error: "token_not_accepted", status: 400 };

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
      token,
      customer,
      items,
      notes: String(input.notes || "").slice(0, 2000),
      session_id: String(input.session_id || input.sessionId || "").trim(),
      test: input.test === true,
      gaClientId: /^\d{1,12}\.\d{1,12}$/.test(String(input.gaClientId || "")) ? String(input.gaClientId) : null,
    },
  };
}

/** 2026-09-28: "paid" for a crypto order means on-chain verified (+ sanctions clear). A staff flag alone never counts. */
export function isCryptoPaid(order) {
  return isCryptoVerified(order);
}

export function isShippable(order) {
  if (!order || order.fulfillment?.status === "shipped") return false;
  if (order.paymentMethod === "crypto" || order.status === AWAITING_CRYPTO || order.status === CRYPTO_PAID || order.status === CRYPTO_REVIEW || order.status === CRYPTO_CANCELLED) {
    return isCryptoPaid(order) && order.fulfillment?.status !== "shipped";
  }
  return order.status === "approved";
}

export function blockedFulfillment(reason = "awaiting_payment") {
  return {
    status: "blocked",
    shippable: false,
    blockedReason: reason,
    shippedAt: null,
    shippedBy: null,
  };
}

export function readyFulfillment(prev) {
  return {
    status: "ready_to_ship",
    shippable: true,
    blockedReason: null,
    shippedAt: prev?.shippedAt || null,
    shippedBy: prev?.shippedBy || null,
  };
}

function messageFor(order) {
  const st = order.cryptoPayment?.status;
  if (isCryptoPaid(order)) return PAID_MESSAGE;
  if (st === PAY.CANCELLED) return CANCELLED_MESSAGE;
  if (st === PAY.REVIEW || st === PAY.SANCTIONS || st === PAY.HOLD) return REVIEW_MESSAGE;
  if (order.cryptoPayment?.customerConfirmedAt) return CONFIRMED_BY_CUSTOMER_MESSAGE;
  return AWAITING_MESSAGE;
}

/** Customer-facing status. Review / sanctions details are never exposed (only "payment_review"). */
function publicPaymentStatus(order) {
  const st = order.cryptoPayment?.status || PAY.AWAITING;
  if (st === PAY.SANCTIONS || st === PAY.HOLD) return PAY.REVIEW;
  if (st === PAY.PAID && !isCryptoPaid(order)) return PAY.REVIEW;
  return st;
}

export function toPublicCryptoView(order, env = process.env, opts = {}) {
  const paid = isCryptoPaid(order);
  const fulfillment = order.fulfillment?.status || (paid ? "ready_to_ship" : "blocked");
  const wallets = order.depositWallets || depositWallets(env);
  const cp = order.cryptoPayment || {};
  const cfg = cryptoVerifyConfig(env);
  const network = cp.network || order.crypto?.network || null;
  const deadline = cp.expiresAt ? new Date(paymentDeadline(cp, cfg)).toISOString() : null;
  const transfers = Array.isArray(cp.transfers) ? cp.transfers : [];
  return {
    ok: true,
    orderId: order.id,
    orderRef: order.orderRef,
    status: order.status,
    paymentStatus: publicPaymentStatus(order),
    amount: order.amount,
    currency: order.currency,
    amountDue: order.amountDue || order.amount,
    payAmount: cp.payAmount || order.amountDue || order.amount,
    payAmountUnits: cp.payUnits || null,
    payDecimals: cp.decimals || 6,
    amountOffset: cp.offset || null,
    priceAdjusted: Boolean(order.priceMismatch),
    payAsset: cp.token || "USDT",
    token: cp.token || "USDT",
    network,
    wallet: network === "trc20" ? wallets.usdtTrc20 : network === "erc20" ? wallets.usdtErc20 : null,
    paymentConfirmed: paid,
    analyticsEvent: null, // crypto purchase is sent server-side (GA4 Measurement Protocol) after on-chain verification
    fulfillment,
    shippable: paid && fulfillment === "ready_to_ship",
    wallets,
    walletsReady: walletsReady(wallets),
    statusUrl: statusUrlFor(order.orderRef, env),
    confirmUrl: `${statusUrlFor(order.orderRef, env)}/confirm`,
    ...(opts.confirmToken ? { confirmToken: opts.confirmToken } : {}),
    createdAt: order.createdAt,
    expiresAt: cp.expiresAt || null,
    cancelAt: deadline,
    customerConfirmed: Boolean(cp.customerConfirmedAt),
    customerConfirmedAt: cp.customerConfirmedAt || null,
    txSeen: transfers.length > 0,
    confirmations: transfers.length ? Math.min(...transfers.map((t) => Number(t.confirmations) || 0)) : 0,
    requiredConfirmations: cp.requiredConfirmations || null,
    paidAt: paid ? cp.verifiedAt || null : null,
    message: messageFor(order),
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
      public: toPublicCryptoView(existing, env, { confirmToken: signConfirmToken(existing, deps.confirmSecret || confirmSecret(env)) }),
    };
  }

  // Server-side price (route passes deps.pricing when CRYPTO_SERVER_PRICING is on): the browser's amount is kept for
  // the record only; the customer is told to send the server amount.
  const pricing = deps.pricing && deps.pricing.ok ? deps.pricing : null;
  const amount = pricing ? pricing.amount : parsed.value.amount;

  const orderRef = allocateOrderRef(store);
  if (!orderRef) return { ok: false, error: "order_ref_unavailable", status: 500 };

  const cfg = cryptoVerifyConfig(env);
  // The token must be enabled (CRYPTO_ACCEPTED_TOKENS) for the order's network; USDT with no network yet stays allowed.
  const token = parsed.value.token || "USDT";
  if (!cfg.acceptedTokens.includes(token) || (parsed.value.network && !isTokenAccepted(cfg, token, parsed.value.network))) {
    return { ok: false, error: "token_not_accepted", status: 400 };
  }
  const nowMs = deps.now ? deps.now().getTime() : Date.now();
  // Unique exact amount among open orders on this network, so a deposit can be matched to exactly one order.
  const alloc = allocatePayAmount(store.listOrders(), { baseAmount: amount, network: parsed.value.network, cfg, nowMs, rand: deps.rand });
  if (!alloc) return { ok: false, error: "pay_amount_unavailable", status: 503 };

  const createdAt = new Date(nowMs).toISOString();
  const wallets = depositWallets(env);
  const network = parsed.value.network;
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
    amountDue: alloc.payAmount,
    paymentStatus: PAY.AWAITING,
    ...(parsed.value.gaClientId ? { gaClientId: parsed.value.gaClientId } : {}),
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
            // infra 2026-09-29 honest-charge: coupon-quote coupon/discount, so the crypto order email reconciles too
            coupon: pricing.coupon || "",
            discount: pricing.discount || null,
            lines: pricing.lines,
          },
          priceMismatch: pricing.mismatch,
        }
      : {}),
    currency: parsed.value.currency,
    payAsset: token,
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
    cryptoPayment: {
      version: 1,
      status: PAY.AWAITING,
      network,
      token,
      wallet: network === "trc20" ? wallets.usdtTrc20 : network === "erc20" ? wallets.usdtErc20 : null,
      baseAmount: amount,
      offset: alloc.offset,
      payAmount: alloc.payAmount,
      payUnits: alloc.payUnits,
      decimals: 6,
      requiredConfirmations: network ? cfg.confirmations[network] : null,
      createdAt,
      expiresAt: new Date(nowMs + cfg.timeoutMin * 60000).toISOString(),
      customerConfirmedAt: null,
      txHints: [],
      transfers: [],
      receivedAmount: "0.00",
      reviewReasons: [],
      sanctions: null,
      verifiedOnChain: false,
      verifiedAt: null,
      verifiedVia: null,
      staffActions: [],
      refunds: [],
      alerts: [],
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
    public: toPublicCryptoView(saved, env, { confirmToken: signConfirmToken(saved, deps.confirmSecret || confirmSecret(env)) }),
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

/**
 * Staff "mark paid" (2026-09-28): no longer flips the order. It only validates the tx hash the operator found; the route then
 * verifies that tx on-chain (crypto-verify.js) and the order is released only if the chain says so.
 */
export function validateStaffTxHint(idOrRef, input, deps) {
  const store = deps.store;
  const order = findCryptoOrder(store, idOrRef);
  if (!order) return { ok: false, error: "not_found", status: 404 };
  if (order.paymentMethod !== "crypto") return { ok: false, error: "not_crypto_order", status: 409 };
  const tx = normalizeTxHash(input?.txHash ?? input?.tx_hash ?? input?.paymentHash);
  if (!tx.ok) return { ok: false, error: tx.error, status: 400 };
  if (isCryptoPaid(order)) return { ok: true, alreadyPaid: true, order };
  if (!tx.value) return { ok: false, error: "tx_hash_required", status: 400 };
  const network = readNetwork(input?.network) || order.cryptoPayment?.network || order.crypto?.network || null;
  if (!network) return { ok: false, error: "network_required", status: 400 };
  if (network === "trc20" && tx.value.startsWith("0x")) return { ok: false, error: "tx_hash_network_mismatch", status: 400 };
  if (network === "erc20" && !tx.value.startsWith("0x")) return { ok: false, error: "tx_hash_network_mismatch", status: 400 };
  return { ok: true, order, network, hint: normalizeHint(tx.value, network) };
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
