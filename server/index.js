import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStore } from "./lib/store.js";
import { secretHealth } from "./lib/secrets.js";
import { chargeCart, ADAPTERS } from "./lib/cascade.js";
import { handleProcessorWebhook } from "./lib/webhooks.js";
import { pollPending, startPoller, recoverInFlight } from "./lib/poller.js";
import { forwardOrder, startForwardSweeper } from "./lib/store-forward.js";
import { priceCryptoCart, priceCardCart } from "./lib/pricing.js";
import { findUnavailableItems, itemUnavailableBody } from "./lib/catalog-guard.js"; // infra 2026-09-30 P0 3.01
import { checkShipRegion, shipRegionErrorBody } from "./lib/ship-region.js"; // infra 2026-10-01 ship48
import { launchFields, launchStatus, orderTokenFrom, tokenOk, resolveAdmin } from "./lib/crypto-launch.js"; // 2026-09-30 crypto awaiting-payment launch
import { createHumanUse, setActiveHumanUse, humanUseBlocks } from "./lib/human-use.js"; // 2026-09-30 human-use flag + COMPLIANCE_HOLD
import { stripGiftLines } from "./lib/pricing.js"; // 2026-09-30 research-solvent gift stopped
import { createMockUmg } from "./lib/processors/umg.js";
import * as tagada from "./lib/processors/tagada.js";
import * as centrobill from "./lib/processors/centrobill.js";
import { isPaymentsEnabled, paymentsDisabledBody, paymentsMode } from "./lib/payments.js";
import { createQuote } from "./lib/quote.js";
import { sendQuoteNotification } from "./lib/mail.js";
import {
  clientIp,
  createRateLimiter,
  isAbandonDigestEnabled,
  markConvertedBySession,
  normalizeAbandonPayload,
  sendAbandonedDigest,
  upsertAbandonedLead,
} from "./lib/abandon.js";
import { corsHeadersForRequest } from "./lib/cors.js";
import { buildLeadsDigest } from "./lib/leads-digest.js";
import { marketingDigestKeyOk, operatorAuthorized, resolveOperator } from "./lib/operator-auth.js";
import {
  createCryptoCheckout,
  publicCryptoStatus,
  shipOrder,
  toPublicCryptoView,
  updateTracking,
  validateStaffTxHint,
  walletFlags,
} from "./lib/crypto-checkout.js";
import { createCryptoVerifier, staffCryptoView } from "./lib/crypto-verify.js";
import { confirmSecret, verifyConfirmToken, isCryptoVerified } from "./lib/crypto-payment.js";
import { isLocalRequest, internalKeyCheck, normalizeEmail, pendingCryptoForEmail } from "./lib/internal-crypto.js"; // 2026-10-01 internal pending-crypto lookup
import { ga4Config } from "./lib/crypto-notify.js";
import { recordCryptoPaymentConfirmed } from "./lib/consent.js";
import { createInventoryStore, INVENTORY_PATH } from "./lib/inventory.js";
import { createConsentLog, recordCheckoutConsent } from "./lib/consent.js";
import { createEmailLog, createOrderEmailer, emailConfig, emailTypes, maskEmail, canSend, sampleOrder } from "./lib/order-emails.js";
import { createCioOrderNotifier } from "./lib/cio-orders.js"; // 2026-10-01 order emails via Customer.io
import { createRapidClient, rapidConfig, RapidError } from "./lib/rapid.js";
import { createRapidScheduler, isPaidOrder, loadSkuMap, pushOrderToRapid, pushSyntheticTestOrder } from "./lib/rapid-orders.js";
import { seedInventory } from "./lib/inventory-seed.js";
import { handleInventoryHttp } from "./lib/inventory-http.js";
import {
  cleffoSettingsView,
  confirmCleffoAttempt,
  descriptorFor,
  nextStepFor,
  recordUmgRouting,
  routeCharge,
  acquireKeyLock,
  startCleffoAttempt,
  startCleffoSweeper,
  storefrontReturnUrl,
} from "./lib/cleffo-checkout.js";
import { routingConfig, capDecision } from "./lib/routing.js";
import { publicChargeBody } from "./lib/no-descriptor.js"; // 2026-10-01 no descriptor in the charge answer
import { logSafe } from "./lib/sanitize.js";
import { getPaymentStatus, loadCleffoConfig, verifyReturnToken, verifySignature } from "./lib/cleffo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const STORE_PATH = process.env.STORE_PATH || join(__dirname, "data", "store.json");
const DRY_RUN = process.env.UMG_DRY_RUN === "1" || process.env.UMG_DRY_RUN === "true";
const PUBLIC_URL = (process.env.CRM_PUBLIC_URL || "").replace(/\/$/, "");

const store = createStore({ filePath: STORE_PATH });
let defaultConsentLog = null;
function sharedConsentLog() {
  if (!defaultConsentLog) defaultConsentLog = createConsentLog();
  return defaultConsentLog;
}
let defaultInventoryStore = null;

function sharedInventoryStore() {
  if (!defaultInventoryStore) {
    defaultInventoryStore = createInventoryStore({ filePath: INVENTORY_PATH });
    seedInventoryGuarded(defaultInventoryStore);
  }
  return defaultInventoryStore;
}

// audit 2026-10-02 (pay-rest-4): the intake seed ends in hard checks (invoice totals, PO totals). A failed check used to throw out of
// sharedInventoryStore() at start-up and the whole payment service (card + crypto) stayed down. Inventory is not on the payment path:
// log a [pay-alert] and keep starting. The checks themselves stay strict inside seedInventory (and the Re-run intake action).
export function seedInventoryGuarded(store, seed = seedInventory) {
  try {
    return seed(store);
  } catch (err) {
    process.stdout.write(`[pay-alert] INVENTORY_SEED_FAILED ${String(err?.message || err).slice(0, 200)} (payments keep running, inventory not seeded)\n`);
    return null;
  }
}

function isUnknownOutcome(order) {
  const last = [...(order.attempts || [])].reverse()[0];
  return order.status === "pending" && last?.reason === "unknown_outcome" && !last.processorTxnId;
}

function liveAdapters() {
  if (DRY_RUN) {
    return { umg: createMockUmg({ scenario: "soft" }), tagada, centrobill };
  }
  return ADAPTERS;
}

// audit 2026-10-02: JSON bodies are capped at 64 KB. Over the cap the rest is read and thrown away (the socket stays
// open so nginx gets a normal answer, not a reset) and the request is treated like an invalid body.
const MAX_BODY_BYTES = 64 * 1024;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return reject(new Error("payload_too_large"));
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function readRaw(req, max = 65536) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => resolve(""));
  });
}

function hasCard(body) {
  return String(body?.card?.number || "").replace(/\D/g, "").length >= 12;
}

function pickDesc(d) {
  return { statementDescriptor: d.statementDescriptor, statementDescriptorConfirmed: d.statementDescriptorConfirmed };
}

function callbackUrl() {
  const path = "/api/webhooks/umg";
  return PUBLIC_URL ? `${PUBLIC_URL}${path}` : path;
}

function readBodySilent(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); }); // audit 2026-10-02: 64 KB cap
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return resolve({ ok: false, tooLarge: true });
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({ ok: true, body: {} });
      try {
        resolve({ ok: true, body: JSON.parse(raw) });
      } catch {
        resolve({ ok: false, invalidJson: true });
      }
    });
    req.on("error", () => resolve({ ok: false }));
  });
}

export function createHandler(deps = {}) {
  const db = deps.store || store;
  // 2026-09-30 human-use rule: every order / quote write is screened; flagged customers' open orders go on COMPLIANCE_HOLD.
  const humanUse = deps.humanUse || (process.env.HUMAN_USE_ENABLED === "true" ? createHumanUse({ db }) : null);
  if (humanUse) { humanUse.install(); setActiveHumanUse(humanUse); }
  // 2026-09-30 (Yehuda): research-solvent / BAC gift lines are silently stripped from every incoming cart (never charged/persisted).
  function stripGift(body) {
    if (!body || !Array.isArray(body.items)) return 0;
    const r = stripGiftLines(body.items);
    if (r.stripped) { body.items = r.items; process.stdout.write(`[gift-strip] removed ${r.stripped} research-solvent/gift line(s)\n`); }
    return r.stripped;
  }
  function resolveInventory() {
    if (deps.inventory) return deps.inventory;
    return sharedInventoryStore();
  }
  const sendQuoteEmail = deps.sendQuoteEmail || sendQuoteNotification;
  const resolveAdapters = () => deps.adapters || liveAdapters();
  const abandonLimiter = deps.abandonLimiter || createRateLimiter();
  const cryptoLimiter = deps.cryptoLimiter || createRateLimiter();
  const quoteLimiter = deps.quoteLimiter || createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 }); // audit 2026-10-02: open endpoint had no counter
  const sendAbandonDigest = deps.sendAbandonDigest || sendAbandonedDigest;
  // Card orders -> legacy shop orders (CRM Store Orders + Customer.io order emails). Off unless enabled on the host
  // or injected by a test, so `npm test` on the server can never post into the live order service.
  const forwardFetch = deps.forwardFetch || (process.env.STORE_FORWARD_ENABLED === "true" ? globalThis.fetch : null);
  const forwardUrl = deps.forwardUrl || process.env.STORE_FORWARD_URL || undefined;
  // Crypto amount from the catalog (products-api coupon-quote), never from the browser. Injected in tests.
  const cryptoPricer = deps.cryptoPricer || (process.env.CRYPTO_SERVER_PRICING === "true" ? (input) => priceCryptoCart(input) : null);
  // Card amount from the catalog too (CARD_SERVER_PRICING=true on the host). Injected in tests.
  const cardPricer = deps.cardPricer || (process.env.CARD_SERVER_PRICING === "true" ? (input) => priceCardCart(input) : null);
  // infra 2026-09-30 P0 3.01: hidden catalog items (is_active:false / hidden_strengths, same rule as products-api) are refused
  // before routing, pricing, order creation or any processor call. A replay of an approved / pending / in-flight order
  // under its own key is still answered from the stored order (nothing new is created or charged there).
  function unavailableLines(body) {
    stripGift(body); // charge, route, crypto and quote all pass here first
    const items = Array.isArray(body?.items) ? body.items : [];
    if (!items.length) return null;
    const key = String(body?.idempotencyKey || body?.extOrderId || "").trim();
    const existing = key ? db.getOrderByIdempotency(key) : null;
    const st = String(existing?.status || "").toLowerCase();
    if (existing && (st === "approved" || st === "pending" || existing.inFlight)) return null;
    const r = findUnavailableItems(items);
    if (r.ok) return null;
    process.stdout.write(`[catalog-guard] refused ${r.items.map((i) => `${i.slug}${i.mg ? "-" + i.mg : ""}:${i.reason}`).join(",")}\n`);
    return r.items;
  }
  // infra 2026-10-01 ship48 (Yehuda): contiguous US (lower 48) + DC only. Checked right after the hidden-item guard, before
  // routing, pricing, record creation or any processor call. Same replay exemption as the hidden-item guard.
  function shipRegionRefusal(body) {
    const key = String(body?.idempotencyKey || body?.extOrderId || "").trim();
    const existing = key ? db.getOrderByIdempotency(key) : null;
    const st = String(existing?.status || "").toLowerCase();
    if (existing && (st === "approved" || st === "pending" || existing.inFlight)) return null;
    const r = checkShipRegion(body?.customer && typeof body.customer === "object" ? body.customer : {});
    if (r.ok) return null;
    process.stdout.write(`[ship48] refused reason=${r.reason}\n`);
    return shipRegionErrorBody();
  }
  async function priceCardBody(body) {
    if (!cardPricer) return { ok: true, pricing: null };
    const key = String(body?.idempotencyKey || body?.extOrderId || "").trim();
    const existing = key ? db.getOrderByIdempotency(key) : null;
    const st = String(existing?.status || "").toLowerCase();
    // Replays of an approved / pending / in-flight order are answered from the stored order; no new price, no charge.
    if (existing && (st === "approved" || st === "pending" || existing.inFlight)) return { ok: true, pricing: null };
    const pricing = await cardPricer(body || {});
    if (!pricing.ok) return { ok: false, status: pricing.status || 503, error: pricing.error, unknownItems: pricing.unknownItems, ...(pricing.error === "shipping_mismatch" ? { message: pricing.message, shipping: pricing.shipping, shipMethod: pricing.shipMethod } : {}) };
    return { ok: true, pricing };
  }
  // Consent proof log. A test that injects its own store gets no log unless it injects one too (never the live file).
  const consentLog = deps.consentLog !== undefined ? deps.consentLog : (deps.store ? null : sharedConsentLog());
  // Append the consent record for a newly created order and attach the summary to the stored order. Never throws and
  // never changes the charge / amount; a failure is noted on the order and in the service log.
  function attachConsent(req, orderId, body, channel) {
    if (!consentLog || !orderId) return;
    const order = db.getOrder(orderId);
    if (!order) return;
    const out = recordCheckoutConsent({ log: consentLog, req, body, order, channel });
    const fresh = db.getOrder(orderId) || order;
    fresh.consent = out.ok ? out.summary : { recorded: false, error: out.error };
    db.upsertOrder(fresh);
    if (!out.ok) process.stdout.write(`[consent] log failed for ${orderId}: ${out.error}\n`);
  }
  // Rapid Fulfillment (3PL). Off unless RAPID_ENABLED=true; auto-push additionally needs RAPID_AUTO_PUSH=true and, for
  // any real order, RAPID_ALLOW_REAL_ORDERS=true (phase 1: both off). Tests inject rapidClient / rapidEnv.
  const rapidCfg = rapidConfig(deps.rapidEnv || process.env);
  const rapidClient = rapidCfg.enabled ? (deps.rapidClient || createRapidClient({ config: rapidCfg })) : null;
  const rapidSkuMap = deps.rapidSkuMap ? () => deps.rapidSkuMap : () => loadSkuMap(rapidCfg.skuMapPath);
  const rapidScheduler = rapidClient
    ? (deps.rapidScheduler || createRapidScheduler({
        db, inventory: resolveInventory(), client: rapidClient, cfg: rapidCfg, skuMap: rapidSkuMap,
        statePath: deps.store ? null : join(dirname(STORE_PATH), "rapid-state.json"),
      }))
    : null;
  function maybeAutoPush(orderId) {
    if (!rapidClient || !rapidCfg.autoPush || !orderId) return;
    pushOrderToRapid(db, orderId, { client: rapidClient, cfg: rapidCfg, skuMap: rapidSkuMap() })
      .then((r) => { if (!r.ok && r.error !== "real_orders_disabled") process.stdout.write(`[rapid] auto-push ${orderId}: ${r.error}\n`); })
      .catch(() => {});
  }
  // On-chain crypto verification (read-only chain APIs). Tests inject chains / screener / mailer / clock.
  const cryptoEnv = deps.cryptoEnv || process.env;
  const cryptoSecret = () => deps.cryptoConfirmSecret || confirmSecret(cryptoEnv);
  const cryptoConfirmLimiter = deps.cryptoConfirmLimiter || createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
  const cryptoTxidLimiter = deps.cryptoTxidLimiter || createRateLimiter({ max: 10, windowMs: 10 * 60 * 1000 });
  const cryptoStatusLimiter = deps.cryptoStatusLimiter || createRateLimiter({ max: 120, windowMs: 10 * 60 * 1000 });
  const internalLimiter = deps.internalLimiter || createRateLimiter({ max: 60, windowMs: 60 * 1000 }); // 2026-10-01 per key
  const cryptoVerifier = deps.cryptoVerifier || createCryptoVerifier({
    store: db, env: cryptoEnv, chains: deps.cryptoChains, screener: deps.cryptoScreener, fetchImpl: deps.cryptoFetch || globalThis.fetch,
    skuMap: () => rapidSkuMap(), now: deps.now, onPaid: (id) => onCryptoPaid(id),
    orderEmailer: { send: (...a) => orderEmailer.send(...a) },
  });
  // Cleffo: config / fetch injectable for tests; the routing config is read per request (env flags).
  const cleffoDeps = deps.cleffoDeps || {};
  const routingCfg = () => (deps.routingConfig ? deps.routingConfig() : routingConfig());
  const callbackUnverified = new Set(); // one CLEFFO_CALLBACK_UNVERIFIED alert per order + reference
  const cleffoSigKey = () => (cleffoDeps.config || loadCleffoConfig()).signatureKey;
  // Transactional customer emails (confirmation / shipping / follow-up). A test with its own store gets no log file
  // unless it injects one. kickEmails never throws and never delays the response.
  const orderEmailer = deps.orderEmailer || createOrderEmailer({
    db, cfg: emailConfig(deps.emailEnv || process.env),
    ...(deps.store ? { log: createEmailLog(deps.emailLogPath || null) } : {}),
    ...(deps.emailTransportFactory ? { transportFactory: deps.emailTransportFactory } : {}),
    ...(deps.emailSleep ? { sleep: deps.emailSleep } : {}),
  });
  // 2026-10-01: Customer.io order emails (flags CIO_ORDER_EMAILS_INTERNAL / _CUSTOMER). Not created for tests with their own store.
  const cioOrders = deps.cioOrders !== undefined ? deps.cioOrders : (deps.store ? null : createCioOrderNotifier({ db }));
  const kickEmails = (orderId) => {
    try { orderEmailer.kick(orderId); } catch { /* never block the order flow */ }
    try { if (cioOrders) cioOrders.kick(orderId); } catch { /* never block the order flow */ }
  };
  function onCleffoPaid(order) {
    markConvertedBySession(db, order.session_id, { via: "cleffo", id: order.id });
    forwardInBackground(order.id, "cleffo");
    maybeAutoPush(order.id);
    kickEmails(order.id);
  }
  function recordConsentFor(req, body) {
    return (orderId) => {
      if (!consentLog) return { ok: false };
      const order = db.getOrder(orderId);
      if (!order) return { ok: false };
      const out = recordCheckoutConsent({ log: consentLog, req, body, order, channel: "card-cleffo" });
      const fresh = db.getOrder(orderId) || order;
      fresh.consent = out.ok ? { ...out.summary, confirmedBeforeRedirect: true } : { recorded: false, error: out.error };
      db.upsertOrder(fresh);
      return out.ok ? { ok: true, hash: out.record?.hash } : { ok: false, error: out.error };
    };
  }
  function forwardInBackground(orderId, via) {
    if (!forwardFetch || !orderId) return;
    forwardOrder(db, orderId, { fetchImpl: forwardFetch, url: forwardUrl, via }).catch(() => {});
  }

  function cryptoHealth() {
    const sc = cryptoVerifier.screener?.config || {};
    const list = cryptoVerifier.screener?.localList ? (() => { try { return cryptoVerifier.screener.localList(); } catch { return null; } })() : null;
    const g = ga4Config(cryptoEnv);
    return {
      enabled: cryptoVerifier.config.enabled,
      shippingGate: "onchain_verified_only",
      timeoutMin: cryptoVerifier.config.timeoutMin,
      graceMin: cryptoVerifier.config.graceMin,
      confirmations: cryptoVerifier.config.confirmations,
      chainalysisKey: Boolean(sc.chainalysisKey),
      ofacList: list ? { size: list.size, fresh: list.fresh } : null,
      sanctionsFailClosed: sc.failClosed !== false,
      ga4ServerPurchase: g.enabled,
      ga4ApiSecret: Boolean(g.apiSecret),
    };
  }
  function onCryptoPaid(orderId) { maybeAutoPush(orderId); kickEmails(orderId); }

  const handlerFn = async function handler(req, res) {
  // audit 2026-10-02 (pay-core-25, r2-crash-restart-recovery-9): new URL() throws on a broken request target or Host header; outside the try
  // below that became an unhandled rejection and Node ended the whole payment service. Answer 400 instead (nginx never sends such a request).
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(JSON.stringify({ error: "bad_request" }));
  }
  const path = url.pathname.replace(/\/+$/, "") || "/";

  function json(status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeadersForRequest(req, path),
    });
    res.end(data);
  }

  function noContent() {
    res.writeHead(204, {
      "Cache-Control": "no-store",
      ...corsHeadersForRequest(req, path),
    });
    res.end();
  }

  async function denyUnlessOperator() {
    const ok = await operatorAuthorized(req, {
      checkCrmSession: deps.checkCrmSession,
      fetchImpl: deps.fetchImpl,
    });
    if (!ok) {
      json(401, { error: "unauthorized" });
      return true;
    }
    return false;
  }

  async function operatorContext() {
    return resolveOperator(req, {
      checkCrmSession: deps.checkCrmSession,
      fetchImpl: deps.fetchImpl,
    });
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Cache-Control": "no-store",
      ...corsHeadersForRequest(req, path),
    });
    return res.end();
  }

  try {
    if (path === "/api/health" && req.method === "GET") {
      return json(200, {
        ok: true,
        dryRun: DRY_RUN,
        callbackUrl: callbackUrl(),
        ...secretHealth(),
      });
    }

    if (path === "/api/psp/health" && req.method === "GET") {
      const enabled = isPaymentsEnabled();
      // audit 2026-10-02 (pay-core-20, sec-secrets-privacy-10, sec-pay-18): this answer is public (nginx /api/psp/ is open). The path of the secret
      // file is no longer reported at all (secrets.js) and where the secret came from is for staff only: GET /api/psp/settings (operator) carries `source` in `health`.
      const { umgEnvPath: _path, source: _source, ...secretFlags } = secretHealth();
      return json(200, {
        ok: true,
        service: "crm-umg",
        dryRun: DRY_RUN,
        callbackUrl: callbackUrl(),
        paymentsEnabled: enabled,
        mode: paymentsMode(),
        cryptoWallets: walletFlags(),
        cryptoVerify: cryptoHealth(),
        ...secretFlags,
      });
    }

    if (path === "/api/psp/settings" && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      return json(200, {
        settings: db.getSettings(),
        cleffo: cleffoSettingsView(db),
        health: {
          ...secretHealth(),
          dryRun: DRY_RUN,
          callbackUrl: callbackUrl(),
          paymentsEnabled: isPaymentsEnabled(),
          mode: paymentsMode(),
        },
      });
    }

    if (path === "/api/psp/settings" && req.method === "PUT") {
      if (await denyUnlessOperator()) return;
      const body = await readBody(req);
      const settings = db.saveSettings(body.settings || body);
      return json(200, { settings });
    }

    if (path === "/api/store-orders" && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      let orders = db.listOrders();
      const status = url.searchParams.get("status");
      const method = url.searchParams.get("paymentMethod");
      const q = (url.searchParams.get("q") || "").trim().toLowerCase();
      if (status) orders = orders.filter((o) => o.status === status);
      if (method) orders = orders.filter((o) => (o.paymentMethod || "") === method);
      if (q) {
        orders = orders.filter((o) => {
          const c = o.customer || {};
          const hay = [o.id, o.orderRef, c.email, c.first_name, c.last_name, o.crypto?.txHash]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          return hay.includes(q);
        });
      }
      return json(200, { orders });
    }

    // Staff: remove orders flagged test:true (QA / soft-QA). Real orders are never deletable here.
    const delOrder = path.match(/^\/api\/store-orders\/([^/]+)$/);
    if (delOrder && req.method === "DELETE") {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      const key = decodeURIComponent(delOrder[1]);
      const order = db.getOrder(key) || db.getOrderByRef(key);
      if (!order) return json(404, { ok: false, error: "not_found" });
      if (order.test !== true) return json(409, { ok: false, error: "not_test_order" });
      db.deleteOrder(order.id);
      process.stdout.write(`[store-orders] test order ${order.id}/${order.orderRef || "-"} deleted by ${op.actor || "operator"}\n`);
      return json(200, { ok: true, deleted: order.id, orderRef: order.orderRef || null });
    }

    const fwdAction = path.match(/^\/api\/store-orders\/([^/]+)\/forward$/);
    if (fwdAction && req.method === "POST") {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      if (!forwardFetch) return json(503, { ok: false, error: "store_forward_disabled" });
      const id = decodeURIComponent(fwdAction[1]);
      const result = await forwardOrder(db, id, { fetchImpl: forwardFetch, url: forwardUrl, force: true, via: `staff:${op.actor || "operator"}` });
      const order = db.getOrder(id);
      return json(result.ok ? 200 : result.reason === "not_found" ? 404 : 409, { ...result, storeForward: order?.storeForward || null });
    }

    const cryptoAction = path.match(/^\/api\/store-orders\/([^/]+)\/(mark-paid|ship|tracking)$/);
    if (cryptoAction && req.method === "POST") {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      const id = decodeURIComponent(cryptoAction[1]);
      const action = cryptoAction[2];
      if (action === "mark-paid" && cryptoVerifier.config.adminMarkPaidRequired) {
        // 2026-09-30 launch: ADMIN "Mark crypto paid" {txHash, network, override?, note?}. Needs a green 4-point on-chain check
        // (recipient, token contract, unique amount, confirmations) or an explicit override with a note (logged + alert).
        const adm = await resolveAdmin(req, { checkCrmSession: deps.checkCrmSession, fetchImpl: deps.fetchImpl });
        if (!adm.ok) return json(adm.error === "unauthorized" ? 401 : 403, { ok: false, error: adm.error });
        const body = await readBody(req);
        const target = db.getOrder(id) || db.getOrderByRef(id);
        if (!target || target.paymentMethod !== "crypto" || !target.cryptoPayment) return json(404, { ok: false, error: "not_found" });
        const r = await cryptoVerifier.staffAction(target.id, { action: "admin_mark_paid", txHash: body.txHash ?? body.tx_hash, network: body.network, override: body.override === true, note: body.note }, adm.actor, { admin: true });
        const order = db.getOrder(target.id);
        if (r.ok && isCryptoVerified(order)) onCryptoPaid(order.id);
        return json(r.ok ? 200 : r.status || 400, { ok: r.ok, error: r.error, reused: Boolean(r.reused), paymentConfirmed: isCryptoVerified(order), orderStatus: order.status, fulfillment: order.fulfillment?.status || null, check: r.check || null, crypto: staffCryptoView(order, cryptoEnv) });
      }
      if (action === "mark-paid") {
        // 2026-09-28: staff give the tx hash they found; the sidecar verifies it on-chain. No blind flip to paid.
        const body = await readBody(req);
        const v = validateStaffTxHint(id, body, { store: db });
        if (!v.ok) return json(v.status || 400, { ok: false, error: v.error });
        if (v.alreadyPaid) {
          return json(200, { ok: true, reused: true, order: v.order, paymentConfirmed: true, analyticsEvent: null, fulfillment: v.order.fulfillment?.status || null });
        }
        const r = await cryptoVerifier.staffAction(v.order.id, { action: "add_tx", txHash: v.hint, network: v.network, note: body.note }, op.actor || "operator");
        const order = db.getOrder(v.order.id);
        if (isCryptoVerified(order)) {
          onCryptoPaid(order.id);
          return json(200, { ok: true, reused: false, order, paymentConfirmed: true, analyticsEvent: null, fulfillment: order.fulfillment?.status || null, paymentStatus: order.cryptoPayment.status });
        }
        const hint = (order.cryptoPayment?.txHints || []).find((h) => h.hash === v.hint) || null;
        return json(r.error === "verification_disabled" ? 503 : r.error === "chain_unavailable" ? 503 : 409, {
          ok: false,
          error: r.error || "not_verified_on_chain",
          paymentStatus: order.cryptoPayment?.status || null,
          orderStatus: order.status,
          fulfillment: order.fulfillment?.status || null,
          paymentConfirmed: false,
          txHint: hint,
          crypto: staffCryptoView(order, cryptoEnv),
        });
      }
      const shipBody = await readBody(req).catch(() => ({}));
      const result =
        action === "tracking"
          ? updateTracking(id, shipBody, { store: db, actor: op.actor, via: op.via })
          : shipOrder(id, { store: db, actor: op.actor, via: op.via }, shipBody);
      if (!result.ok) {
        return json(result.status || 400, {
          ok: false,
          error: result.error,
          orderStatus: result.orderStatus || result.order?.status,
          fulfillment: result.fulfillment || result.order?.fulfillment?.status,
          paymentConfirmed: result.paymentConfirmed ?? Boolean(result.order?.paymentConfirmed),
        });
      }
      kickEmails(result.order?.id);
      return json(200, {
        ok: true,
        order: result.order,
        fulfillment: result.order?.fulfillment?.status || "shipped",
      });
    }

    if (path.startsWith("/api/store-orders/") && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      const id = decodeURIComponent(path.slice("/api/store-orders/".length));
      const order = db.getOrder(id) || db.getOrderByRef(id);
      if (!order) return json(404, { error: "not_found" });
      return json(200, { order });
    }

    if (path === "/api/store-orders/poll" && req.method === "POST") {
      if (await denyUnlessOperator()) return;
      const results = await pollPending(db, { adapters: resolveAdapters() });
      return json(200, { results, orders: db.listOrders() });
    }

    if (path === "/api/checkout/charge" && req.method === "POST") {
      if (!isPaymentsEnabled()) {
        return json(503, paymentsDisabledBody());
      }
      const body = await readBody(req);
      { const bad = unavailableLines(body); if (bad) return json(409, itemUnavailableBody(bad)); }
      { const shipBad = shipRegionRefusal(body); if (shipBad) return json(400, shipBad); }   // infra 2026-10-01 ship48
      // infra 2026-09-29 cleffo: USD only, checked before anything is created or charged (either processor).
      if (body?.currency != null && String(body.currency).trim() !== "" && String(body.currency).trim().toUpperCase() !== "USD") {
        return json(400, { ok: false, error: "currency_unsupported", charged: false, message: "Only USD payments are supported. You were not charged." });
      }
      const rc0 = routingCfg();
      const cleffoOnly = rc0.cleffoEnabled === true && rc0.cleffoOnly === true;
      // Cleffo on: an email is always required (a bot without one must not slip past Cleffo to UMG).
      if (rc0.cleffoEnabled === true && !String(body?.customer?.email || "").trim()) {
        return json(400, { ok: false, error: "email_required", charged: false, message: "Please enter your email address to continue to secure payment. You were not charged." });
      }
      let route, config, cardKey, priced, umgRoute;
      // Same order key: one request at a time through "route + price + create the link", so a double click cannot make two attempts.
      const releaseKey = await acquireKeyLock(String(body?.idempotencyKey || body?.extOrderId || "").trim());
      try {
      // Processor routing (UMG only unless CLEFFO_ENABLED=true): sticky email bucket, soft decline -> other once.
      let reusable, history;
      ({ route, config, cardKey, reusable, history } = await routeCharge(db, body, { config: routingCfg(), cleffoDeps, onPaid: onCleffoPaid }));
      if (route.blocked) {
        process.stdout.write(`[routing] refused attempt=${route.attempt} reason=${route.reason}\n`);
        const message = route.reason === "hard_decline_same_card"
          ? "This card was declined by the issuer and cannot be retried. You were not charged. Please use a different card, pay with crypto, or contact support."
          : "We could not complete payment after several attempts. You were not charged on this attempt. Please contact support, pay with crypto, or request a quote.";
        return json(429, { ok: false, error: route.reason, charged: false, attempt: route.attempt, message });
      }
      priced = await priceCardBody(body);
      if (!priced.ok) {
        const message = priced.error === "shipping_mismatch" && priced.message
          ? priced.message
          : priced.error === "unknown_item"
          ? "One of the items in your cart is no longer available. Please refresh the cart and try again."
          : "We could not confirm the price right now. Your card was not charged. Please try again in a minute.";
        return json(priced.status, { ok: false, error: priced.error, unknownItems: priced.unknownItems, message, charged: false, ...(priced.error === "shipping_mismatch" ? { shipping: priced.shipping, shipMethod: priced.shipMethod } : {}) });
      }
      // infra 2026-09-29 honest-charge: same buyer, same server amount, same lines within 15 min under a NEW key = the browser
      // lost our answer and retried. Do not charge again; point at the existing order. Same key is handled by chargeCart (reused).
      const dupKey = String(body?.idempotencyKey || body?.extOrderId || "").trim();
      if (dupKey && !db.getOrderByIdempotency(dupKey)) {
        const dup = db.findRecentCardDuplicate({
          email: body?.customer?.email,
          amount: priced.pricing ? priced.pricing.amount : body?.amount,
          items: body?.items,
          excludeKey: dupKey,
          now: deps.now ? deps.now().getTime() : Date.now(),
        });
        if (dup) {
          process.stdout.write(`[charge] duplicate_recent_order ${dup.id} for a new key: not charged again\n`);
          return json(409, {
            ok: false,
            error: "duplicate_recent_order",
            charged: false,
            existingOrder: dup.id,
            message: `This order was already placed a few minutes ago (order ${dup.id}). You were not charged again. If you want to buy again, please wait 15 minutes or contact support.`,
          });
        }
      }
      // Daily Cleffo cap (CLEFFO_DAILY_CAP_USD): today's PAID Cleffo total + open links younger than CLEFFO_CAP_PENDING_MIN (default 60) + this order's
      // server total over the cap -> this new Cleffo payment goes to UMG instead (reason "cap"). docs/CLEFFO_DAILY_CAP.md.
      if (route.processor === "cleffo") {
        route = capDecision(route, {
          store: db, config,
          amount: priced.pricing ? priced.pricing.amount : body?.amount,
          email: body?.customer?.email, sessionId: body?.session_id || body?.sessionId,
          idempotencyKey: String(body?.idempotencyKey || body?.extOrderId || "").trim(),
          now: deps.now ? deps.now().getTime() : Date.now(),
        }).route;
      }
      umgRoute = route;
      // Capped to UMG but the page showed the Cleffo step (no card fields): ask for the card, nothing charged.
      if (route.reason === "cap" && !hasCard(body)) {
        return json(400, { ok: false, error: "card_required", processor: "umg", reason: "cap", charged: false, message: "Please enter your card details to pay. You were not charged." });
      }
      // Cleffo could not make a link and the storefront (Cleffo step, no card fields) sent no card: nothing to charge on UMG yet.
      if (route.reason === "retry_switch_link_error" && !hasCard(body)) {
        return json(400, { ok: false, error: "card_required", processor: "umg", charged: false, message: "Please enter your card details to pay. You were not charged." });
      }
      if (route.processor === "cleffo") {
        if (cleffoOnly && body?.card) process.stdout.write("[routing] card_ignored\n"); // stale cached page still sends the card; it goes nowhere
        const cl = await startCleffoAttempt(db, {
          req, body, pricing: priced.pricing, route, config, consentLog, reusable,
          recordConsent: recordConsentFor(req, body),
          publicUrl: PUBLIC_URL || deps.publicUrl || "", origin: req.headers.origin,
        }, { cleffoDeps });
        // Cleffo could not even create a link (no charge happened): UMG takes this attempt if the card is on hand.
        // Cleffo-only: never UMG, whatever the body carries.
        // The spare is only for a plain "no link" answer, and only when no Cleffo link of this buyer is open or was left with an
        // unknown outcome / a hard result (that one may still be paid: a UMG charge on top would be a double payment).
        const spareBlocked = (history || []).some((h) => h.processor === "cleffo" && (!h.outcome || h.retryClass === "hard"));
        if (!(cl.linkError && !cl.linkUnknown && hasCard(body) && !cleffoOnly && !spareBlocked)) return json(cl.status, publicChargeBody(cl.body));
        umgRoute = { ...route, processor: "umg", reason: "cleffo_unavailable_fallback" };
      }
      } finally { releaseKey(); }
      const umgSettings = config.cleffoEnabled
        ? (() => { const st = db.getSettings(); return { ...st, processors: (st.processors || []).filter((p) => p.id === "umg") }; })()
        : undefined;
      const result = await chargeCart(priced.pricing ? { ...body, pricing: priced.pricing } : body, { store: db, adapters: resolveAdapters(), ...(umgSettings ? { settings: umgSettings } : {}) });
      if (result.order?.id && !result.reused) {
        const logged = recordUmgRouting(db, result.order.id, { route: umgRoute, config, cardKey, result });
        if (logged) result.order = logged;
      }
      if (result.order) {
        result.chargedAmount = result.order.amount;
        result.priceAdjusted = Boolean(result.order.priceMismatch);
      }
      // infra 2026-09-29 honest-charge: UMG never answered and find-by-ext-id could not say whether the card was charged.
      // Same shape as "pending" plus charged:"unknown", so the page keeps its retry key and does not offer a new attempt.
      // A replay of an unfinished order (pending / 3DS / in flight) is pending too, never "authorized"; in flight = we do not know yet.
      if (result.reused && result.order && String(result.order.status).toLowerCase() !== "approved") result.pending = true;
      if (result.order && (isUnknownOutcome(result.order) || (result.reused && result.order.inFlight))) {
        result.pending = true;
        result.charged = "unknown";
        result.message = "We are confirming your payment with the bank. Please do not pay again. If you do not receive an order confirmation within an hour, contact support.";
      }
      result.processor = "umg";
      result.attempt = result.order?.attemptNumber ?? umgRoute.attempt;
      Object.assign(result, (({ statementDescriptor, statementDescriptorConfirmed }) => ({ statementDescriptor, statementDescriptorConfirmed }))(descriptorFor("umg")));
      if (!result.ok && config.cleffoEnabled) result.next = nextStepFor(db, result.order, config);
      // Consent proof for every card order this request created or re-attempted (approved or declined). The order
      // object in this response is left as-is.
      if (result.order?.id && !result.reused) attachConsent(req, result.order.id, body, "card");
      if (result.ok) {
        markConvertedBySession(db, body.session_id || body.sessionId, {
          via: "charge",
          id: result.order?.id || null,
        });
      }
      const out = json(result.ok ? 200 : 402, publicChargeBody(result));
      // After the answer: a slow or broken order service must never cost the customer the charge response.
      if (result.ok && !result.reused && String(result.order?.status || "").toLowerCase() === "approved") {
        forwardInBackground(result.order.id, "charge");
        kickEmails(result.order.id);
        maybeAutoPush(result.order.id);
      }
      return out;
    }

    // Which processor the next card attempt goes to (creates no order and no charge; it does ask Cleffo about this buyer's open
    // links, may mark a stale one abandoned, and remembers a capped buyer for the cap), so checkout can show card fields (UMG) or the
    // "continue to secure payment page" step (Cleffo) and the matching statement line.
    if (path === "/api/checkout/route" && req.method === "POST") {
      const body = await readBody(req);
      { const bad = unavailableLines(body); if (bad) return json(409, itemUnavailableBody(bad)); }
      const config = routingCfg();
      if (!config.cleffoEnabled) {
        return json(200, { ok: true, processor: "umg", cleffoEnabled: false, attempt: 1, ...pickDesc(descriptorFor("umg")) });
      }
      let { route } = await routeCharge(db, body, { config, cleffoDeps, onPaid: onCleffoPaid });
      if (route.blocked) return json(200, { ok: true, processor: null, blocked: true, reason: route.reason, cleffoEnabled: true, attempt: route.attempt });
      // Daily Cleffo cap: /route has no cart total (amount only if the page sends one), so it answers umg once the day's
      // Cleffo total is used up or this buyer was already capped (then /charge agrees).
      if (route.processor === "cleffo") {
        route = capDecision(route, {
          store: db, config, amount: body?.amount,
          email: body?.customer?.email, sessionId: body?.session_id || body?.sessionId,
          idempotencyKey: String(body?.idempotencyKey || "").trim(),
          now: deps.now ? deps.now().getTime() : Date.now(),
        }).route;
      }
      return json(200, { ok: true, processor: route.processor, cleffoEnabled: true, attempt: route.attempt, reason: route.reason, ...pickDesc(descriptorFor(route.processor)) });
    }

    // Cleffo hosted page -> back here. Token-checked, then settled from the status API, then 302 to the storefront.
    if (path === "/api/checkout/cleffo/return" && req.method === "GET") {
      const o = url.searchParams.get("o") || "";
      const a = url.searchParams.get("a") || "";
      const t = url.searchParams.get("t") || "";
      if (!verifyReturnToken(o, a, t, cleffoSigKey())) {
        process.stdout.write(`[cleffo] return with bad token for ${logSafe(o, 40)}\n`);
        res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end("Invalid payment return link.");
      }
      const r = await confirmCleffoAttempt(db, o, a, { cleffoDeps, onPaid: onCleffoPaid, via: "return" });
      const status = r.ok ? r.status : "pending";
      res.writeHead(302, { Location: storefrontReturnUrl(r.order || { id: o }, a, t, status, process.env, r.attempt?.returnPage), "Cache-Control": "no-store" });
      return res.end();
    }

    if (path === "/api/checkout/cleffo/status" && req.method === "GET") {
      const o = url.searchParams.get("o") || "";
      const a = url.searchParams.get("a") || "";
      // 2026-10-01: token preferably in the X-Order-Token header (kept out of access logs); ?t= stays as fallback.
      const th = req.headers["x-order-token"];
      const t = (typeof th === "string" && th) ? th : (url.searchParams.get("t") || "");
      if (!verifyReturnToken(o, a, t, cleffoSigKey())) return json(403, { ok: false, error: "invalid_token" });
      const r = await confirmCleffoAttempt(db, o, a, { cleffoDeps, onPaid: onCleffoPaid, via: "status" });
      if (!r.order) return json(404, { ok: false, error: "not_found" });
      const d = descriptorFor("cleffo");
      return json(200, {
        ok: true,
        orderId: r.order.id,
        processor: "cleffo",
        attempt: Number(a) || null,
        status: r.ok ? r.status : "pending",
        amount: r.order.amount,
        currency: r.order.currency,
        ...pickDesc(d),
        next: r.status === "declined" ? nextStepFor(db, r.order, routingCfg()) : null,
      });
    }

    // Optional server-to-server notice. Cleffo documents no signed callback: an x-signature is checked when present
    // and logged, but the status API is what settles the order either way.
    if (path === "/api/checkout/cleffo/callback" && req.method === "POST") {
      const raw = await readRaw(req);
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { return json(400, { ok: false, error: "invalid_json" }); }
      const sig = req.headers["x-signature"];
      const sigState = sig ? (verifySignature(raw, sig, cleffoSigKey()) ? "valid" : "invalid") : "absent";
      const d = body.data && typeof body.data === "object" ? body.data : body;
      const ref = String(d.transaction_reference_number || d.transactionReferenceNumber || "").replace(/[^A-Za-z0-9_-]/g, "");
      let found = ref ? db.findAttempt("cleffo", ref) : null;
      // A link whose creation timed out has no reference number on our side: match it by the merchant_order_id we sent. The
      // callback is unsigned and that id is guessable (<order>A<n>), so the reference is taken only when Cleffo's own status
      // API confirms it belongs to exactly that merchant_order_id; an attempt that already has a reference is never re-pointed.
      if (!found) {
        const byMerchant = db.findAttemptByMerchantId("cleffo", d.merchant_order_id ?? d.merchantOrderId);
        const where = byMerchant ? `${logSafe(byMerchant.order.id, 40)} attempt=${byMerchant.attempt.routingAttempt}` : "";
        if (byMerchant && !ref) {
          process.stdout.write(`[cleffo] callback ref_missing ${where} (no transaction reference in the callback)\n`);
        } else if (byMerchant && byMerchant.attempt.processorTxnId) {
          process.stdout.write(`[cleffo] callback ref_conflict ${where} (already has a reference, not replaced)\n`);
        } else if (byMerchant && byMerchant.attempt.processorStatus === "LINK_UNKNOWN") {
          const st = await getPaymentStatus(ref, cleffoDeps);
          if (!st.ok) {
            // Cleffo's own status API did not answer: nothing can be confirmed. Nothing is written; 503 so Cleffo can send it again.
            const seen = `${byMerchant.order.id}#${ref}`;
            if (!callbackUnverified.has(seen)) {
              callbackUnverified.add(seen);
              process.stdout.write(`[pay-alert] CLEFFO_CALLBACK_UNVERIFIED ${where} ref=${logSafe(ref, 60)}\n`);
            }
            return json(503, { ok: false, error: "verification_unavailable" });
          }
          if (st.merchantOrderId === byMerchant.attempt.merchantOrderId) {
            const o = db.getOrder(byMerchant.order.id);
            const i = o.attempts.findIndex((x) => x.attemptId === byMerchant.attempt.attemptId);
            if (i !== -1 && !o.attempts[i].processorTxnId) {
              o.attempts[i] = { ...o.attempts[i], processorTxnId: ref, processorStatus: "LINK_CREATED", reason: "link_recovered_by_callback" };
              db.upsertOrder(o);
              found = db.findAttempt("cleffo", ref);
            }
          } else {
            process.stdout.write(`[cleffo] callback ref_rejected ${where} (Cleffo does not tie that reference to this merchant_order_id)\n`);
          }
        }
      }
      process.stdout.write(`[cleffo] callback ref=${ref || "-"} signature=${sigState} known=${Boolean(found)}\n`);
      if (!found) return json(200, { ok: false, error: "unknown_transaction" });
      const r = await confirmCleffoAttempt(db, found.order.id, found.attempt.routingAttempt, { cleffoDeps, onPaid: onCleffoPaid, via: "callback" });
      return json(200, { ok: true, orderId: found.order.id, status: r.ok ? r.status : "pending", signature: sigState });
    }

    // Staff: Cleffo flag / split / keys (booleans) / descriptors / counts. Read-only.
    if (path === "/api/psp/cleffo" && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      return json(200, { ok: true, cleffo: cleffoSettingsView(db) });
    }

    // 2026-10-01: internal, localhost-only lookup of a buyer's open crypto orders (account backend). No email/token in logs.
    if (path.startsWith("/api/internal/")) {
      if (!isLocalRequest(req)) return json(404, { ok: false, error: "not_found" });
      if (path !== "/api/internal/crypto/pending" || req.method !== "GET") return json(404, { ok: false, error: "not_found" });
      const auth = internalKeyCheck(req, process.env);
      if (!auth.ok) return json(auth.status, { ok: false, error: auth.error });
      if (!internalLimiter.allow("internal-key")) return json(429, { ok: false, error: "rate_limited" });
      // Email only from the X-Customer-Email header, never the query (keeps it out of access logs).
      if (url.searchParams.has("email")) return json(400, { ok: false, error: "email_in_query_not_allowed" });
      const email = normalizeEmail(req.headers["x-customer-email"]);
      if (!email) return json(400, { ok: false, error: "invalid_email" });
      return json(200, pendingCryptoForEmail(db.listOrders(), email, { env: cryptoEnv, secret: cryptoSecret() }));
    }

    if (path === "/api/checkout/crypto" && req.method === "POST") {
      if (!cryptoLimiter.allow(clientIp(req))) {
        return json(429, { ok: false, error: "rate_limited" });
      }
      const body = await readBody(req);
      { const bad = unavailableLines(body); if (bad) return json(409, itemUnavailableBody(bad)); }
      { const shipBad = shipRegionRefusal(body); if (shipBad) return json(400, shipBad); }   // infra 2026-10-01 ship48
      let pricing = null;
      const idemKey = String(body?.idempotencyKey || body?.extOrderId || "").trim();
      if (cryptoPricer && !(idemKey && db.getOrderByIdempotency(idemKey)) && Array.isArray(body?.items) && body.items.length) {
        pricing = await cryptoPricer(body);
        if (!pricing.ok) {
          if (pricing.error === "shipping_mismatch") {
            return json(400, { ok: false, error: "shipping_mismatch", charged: false, message: pricing.message, shipping: pricing.shipping, shipMethod: pricing.shipMethod });
          }
          return json(pricing.status || 503, { ok: false, error: pricing.error, unknownItems: pricing.unknownItems });
        }
      }
      const result = createCryptoCheckout(body, { store: db, pricing, env: cryptoEnv, confirmSecret: cryptoSecret(), now: deps.now });
      if (!result.ok) {
        return json(result.status || 400, { ok: false, error: result.error });
      }
      if (!result.reused) {
        attachConsent(req, result.order?.id, body, "crypto");
        markConvertedBySession(db, body.session_id || body.sessionId, {
          via: "crypto",
          id: result.order?.id || null,
        });
      }
      return json(200, { ...result.public, ...launchFields(result.order, cryptoEnv, result.public.confirmToken), reused: Boolean(result.reused) });
    }

    // 2026-09-30 launch: token-gated public status {status: awaiting|paid|expired}, no PII.
    const cryptoStatus = path.match(/^\/api\/checkout\/crypto\/([^/]+)\/status$/);
    if (cryptoStatus && req.method === "GET") {
      if (!cryptoStatusLimiter.allow(clientIp(req))) return json(429, { ok: false, error: "rate_limited" });
      const order = db.getOrderByRef(decodeURIComponent(cryptoStatus[1])) || null;
      if (!tokenOk(order, orderTokenFrom(req, url), cryptoSecret())) return json(403, { ok: false, error: "invalid_token" });
      return json(200, launchStatus(order, cryptoEnv));
    }

    // 2026-09-30 launch: customer pastes the TxID. {token, network: erc20|trc20, tx_hash, asset?} -> payment_submitted. Never pays.
    const cryptoTxid = path.match(/^\/api\/checkout\/crypto\/([^/]+)\/txid$/);
    if (cryptoTxid && req.method === "POST") {
      if (!cryptoTxidLimiter.allow(clientIp(req))) return json(429, { ok: false, error: "rate_limited" });
      const body = await readBody(req);
      const order = db.getOrderByRef(decodeURIComponent(cryptoTxid[1])) || null;
      if (!tokenOk(order, orderTokenFrom(req, url, body), cryptoSecret())) return json(403, { ok: false, error: "invalid_token" });
      const r = cryptoVerifier.submitCustomerTx(order.id, { network: body.network, txHash: body.tx_hash ?? body.txHash, asset: body.asset });
      if (!r.ok) return json(r.status || 400, { ok: false, error: r.error, ...(r.expected ? { expected: r.expected } : {}) });
      const fresh = db.getOrder(order.id);
      return json(200, { ...launchStatus(fresh, cryptoEnv), ok: true, order_status: "PAYMENT_SUBMITTED", reused: Boolean(r.reused) });
    }

    // Customer "I've sent the payment" (public, rate-limited, signed token). Never releases the order.
    const cryptoConfirm = path.match(/^\/api\/checkout\/crypto\/([^/]+)\/confirm$/);
    if (cryptoConfirm && req.method === "POST") {
      if (!cryptoConfirmLimiter.allow(clientIp(req))) return json(429, { ok: false, error: "rate_limited" });
      const body = await readBody(req);
      const ref = decodeURIComponent(cryptoConfirm[1]);
      const order = db.getOrderByRef(ref) || null;
      if (!order || order.paymentMethod !== "crypto" || !order.cryptoPayment || !verifyConfirmToken(order, body.token || body.confirmToken, cryptoSecret())) {
        return json(403, { ok: false, error: "invalid_token" });
      }
      const r = cryptoVerifier.customerConfirm(order.id, { txHash: body.txHash ?? body.txid });
      if (!r.ok) return json(r.status || 400, { ok: false, error: r.error });
      if (consentLog) {
        const logged = recordCryptoPaymentConfirmed({ log: consentLog, req, body, order: r.order, txHint: r.txHint });
        if (!logged.ok) process.stdout.write(`[consent] crypto confirm log failed for ${order.id}: ${logged.error}\n`);
      }
      process.stdout.write(`[crypto] customer confirmed ${order.id}${r.txHint ? " with tx hint" : ""}\n`);
      return json(200, { ...toPublicCryptoView(r.order, cryptoEnv), txHintReceived: Boolean(r.txHint) });
    }

    if (path.startsWith("/api/checkout/crypto/") && req.method === "GET") {
      const ref = decodeURIComponent(path.slice("/api/checkout/crypto/".length));
      const view = publicCryptoStatus(db, ref, cryptoEnv);
      if (!view) return json(404, { ok: false, error: "not_found" });
      return json(200, view);
    }

    // Staff: crypto payment verification (fields for the CRM UI) and review actions.
    if (path.startsWith("/api/psp/crypto/")) {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      if (path === "/api/psp/crypto/orders" && req.method === "GET") {
        const st = url.searchParams.get("paymentStatus");
        let orders = db.listOrders().filter((o) => o.paymentMethod === "crypto" && o.cryptoPayment);
        if (st) orders = orders.filter((o) => o.cryptoPayment.status === st);
        const cs = db.getCryptoState();
        return json(200, { ok: true, count: orders.length, orders: orders.map((o) => staffCryptoView(o, cryptoEnv)), verifier: { ...cryptoHealth(), scan: cs.scan }, unmatched: cs.unmatched.length, alerts: cs.alerts.length });
      }
      if (path === "/api/psp/crypto/alerts" && req.method === "GET") return json(200, { ok: true, alerts: db.getCryptoState().alerts.slice(-200).reverse() });
      if (path === "/api/psp/crypto/unmatched" && req.method === "GET") return json(200, { ok: true, unmatched: db.getCryptoState().unmatched.slice(-200).reverse() });
      if (path === "/api/psp/crypto/verify-now" && req.method === "POST") return json(200, { ok: true, result: await cryptoVerifier.tick() });
      const one = path.match(/^\/api\/psp\/crypto\/orders\/([^/]+)(\/action)?$/);
      if (one) {
        const key = decodeURIComponent(one[1]);
        const order = db.getOrder(key) || db.getOrderByRef(key);
        if (!order || order.paymentMethod !== "crypto" || !order.cryptoPayment) return json(404, { ok: false, error: "not_found" });
        if (!one[2] && req.method === "GET") return json(200, { ok: true, order: staffCryptoView(order, cryptoEnv) });
        if (one[2] && req.method === "POST") {
          const body = await readBody(req);
          let isAdmin = false;
          if (body.action === "admin_mark_paid" || (body.action === "release" && cryptoVerifier.config.adminMarkPaidRequired)) {
            const adm = await resolveAdmin(req, { checkCrmSession: deps.checkCrmSession, fetchImpl: deps.fetchImpl });
            if (!adm.ok) return json(403, { ok: false, error: "admin_required" });
            isAdmin = true;
          }
          const r = await cryptoVerifier.staffAction(order.id, body, op.actor || "operator", { admin: isAdmin });
          const fresh = db.getOrder(order.id);
          if (r.ok && isCryptoVerified(fresh)) onCryptoPaid(order.id);
          return json(r.ok ? 200 : r.status || 400, { ok: r.ok, error: r.error, order: staffCryptoView(fresh, cryptoEnv) });
        }
      }
      return json(404, { error: "not_found" });
    }

    // 2026-09-30 human-use flag (staff read; admin: clear false positive with note, cancel & refuse, scan now). All logged.
    if (path === "/api/psp/compliance/human-use" || path.startsWith("/api/psp/compliance/human-use/")) {
      if (!humanUse) return json(503, { ok: false, error: "human_use_disabled" });
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      if (req.method === "GET" && path === "/api/psp/compliance/human-use") return json(200, humanUse.view());
      if (req.method === "GET" && path === "/api/psp/compliance/human-use/index") return json(200, humanUse.badgeIndex());
      if (req.method === "POST") {
        const adm = await resolveAdmin(req, { checkCrmSession: deps.checkCrmSession, fetchImpl: deps.fetchImpl });
        if (!adm.ok) return json(403, { ok: false, error: "admin_required" });
        const body = await readBody(req).catch(() => ({}));
        let r;
        if (path === "/api/psp/compliance/human-use/clear") r = humanUse.clearFlag(body.email, { actor: adm.actor, note: body.note });
        else if (path === "/api/psp/compliance/human-use/cancel-refuse") r = humanUse.cancelRefuse(String(body.id || body.orderId || body.quoteId || ""), { actor: adm.actor, note: body.note });
        else if (path === "/api/psp/compliance/human-use/scan-now") r = humanUse.scan();
        // 2026-10-01 two-tier: weak-term review items -> escalate (flag + hold) or dismiss; note required, audited.
        else if (path === "/api/psp/compliance/human-use/review/escalate") r = humanUse.escalateReview(String(body.id || ""), { actor: adm.actor, note: body.note });
        else if (path === "/api/psp/compliance/human-use/review/dismiss") r = humanUse.dismissReview(String(body.id || ""), { actor: adm.actor, note: body.note });
        else return json(404, { error: "not_found" });
        return json(r.ok ? 200 : r.status || 400, r);
      }
      return json(404, { error: "not_found" });
    }

    // Staff: consent proof records for an order (BLR-id, CR-ref or idempotency key) or an email. Read-only.
    if (path === "/api/consent" && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      if (!consentLog) return json(503, { ok: false, error: "consent_log_disabled" });
      const ref = (url.searchParams.get("ref") || "").trim();
      const email = (url.searchParams.get("email") || "").trim();
      if (!ref && !email) return json(400, { ok: false, error: "ref_or_email_required" });
      const records = consentLog.find({ ref, email });
      return json(200, { ok: true, count: records.length, records });
    }

    // Staff: set tracking on any paid order (card / Cleffo / crypto) -> shipped; the shipping email follows.
    const trk = path.match(/^\/api\/fulfillment\/([^/]+)\/tracking$/);
    if (trk && req.method === "POST") {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      // audit 2026-10-02 (pay-core-22): the order is read AFTER the body arrived. Read before, a status update written while the body was
      // still coming in was overwritten by this whole-order upsert. From here to upsertOrder there is no await.
      const body = await readBody(req).catch(() => ({}));
      const order = db.getOrder(decodeURIComponent(trk[1])) || db.getOrderByRef(decodeURIComponent(trk[1]));
      if (!order) return json(404, { ok: false, error: "not_found" });
      const number = String(body.trackingNumber || body.tracking_number || "").replace(/[^A-Za-z0-9 -]/g, "").trim().slice(0, 60);
      if (!number) return json(400, { ok: false, error: "tracking_number_required" });
      if (!isPaidOrder(order)) return json(409, { ok: false, error: "not_paid" });
      if (humanUseBlocks(order)) return json(409, { ok: false, error: "compliance_hold" });
      const at = new Date().toISOString();
      const f = order.fulfillment || {};
      order.fulfillment = {
        ...f, status: "shipped", shippable: false, blockedReason: null, shippedAt: f.shippedAt || at, shippedBy: f.shippedBy || String(op.actor || "operator").slice(0, 160),
        carrier: String(body.carrier || f.carrier || "").slice(0, 60) || null, trackingNumber: number, trackingUpdatedAt: at, trackingUpdatedBy: String(op.actor || "operator").slice(0, 160),
      };
      order.updatedAt = at;
      db.upsertOrder(order);
      kickEmails(order.id);
      return json(200, { ok: true, order: db.getOrder(order.id) });
    }

    if (path.startsWith("/api/emails/")) {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      if (path === "/api/emails/status" && req.method === "GET") {
        const c = orderEmailer.cfg;
        return json(200, { ok: true, enabled: c.enabled, canSend: canSend(c), supportHost: c.support.host || null, supportUser: c.support.user ? maskEmail(c.support.user) : null,
          supportPasswordSet: Boolean(c.support.pass), noreplyPasswordSet: Boolean(c.noreply.pass), alertTo: c.alertTo || null, since: c.since ? new Date(c.since).toISOString() : null,
          followupDays: c.followupDays, types: emailTypes() });
      }
      if (path === "/api/emails/log" && req.method === "GET") {
        const full = url.searchParams.get("full") === "1";
        const rows = orderEmailer.log.read({ orderId: url.searchParams.get("orderId") || undefined, type: url.searchParams.get("type") || undefined, limit: Math.min(1000, Number(url.searchParams.get("limit")) || 200) });
        return json(200, { ok: true, count: rows.length, entries: full ? rows : rows.map((r) => ({ ...r, to: maskEmail(r.to) })) });
      }
      const pv = path.match(/^\/api\/emails\/preview\/([a-z0-9_]+)$/);
      if (pv && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        if (!emailTypes().includes(pv[1])) return json(404, { ok: false, error: "unknown_type" });
        const order = body.orderId ? db.getOrder(body.orderId) || db.getOrderByRef(body.orderId) : sampleOrder(pv[1]);
        if (!order) return json(404, { ok: false, error: "not_found" });
        const r = orderEmailer.preview(pv[1], order, body.data);
        return json(200, { ok: true, type: pv[1], subject: r.subject, guard: r.guard, text: r.text, html: r.html });
      }
      const rs = path.match(/^\/api\/emails\/resend\/([^/]+)\/([a-z0-9_]+)$/);
      if (rs && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const r = await orderEmailer.send(decodeURIComponent(rs[1]), rs[2], { force: true, qa: body.qa === true, via: `resend:${op.actor || "operator"}` });
        return json(r.status === "not_found" ? 404 : r.status === "unknown_type" ? 404 : 200, r);
      }
      if (path === "/api/emails/process" && req.method === "POST") {
        const body = await readBody(req).catch(() => ({}));
        const r = await orderEmailer.processDue({ orderId: body.orderId || undefined, qa: body.qa === true && Boolean(body.orderId), forceFollowup: body.forceFollowup === true && Boolean(body.orderId) });
        return json(200, { ok: true, ...r });
      }
      return json(404, { error: "not_found" });
    }

    if (path.startsWith("/api/rapid/")) {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      const summary = {
        enabled: rapidCfg.enabled, env: rapidCfg.env, endpointHost: new URL(rapidCfg.endpoint).hostname,
        autoPush: rapidCfg.autoPush, allowRealOrders: rapidCfg.allowRealOrders, orderPrefix: rapidCfg.orderPrefix,
        testOrderPrefix: rapidCfg.testOrderPrefix, credentials: Boolean(rapidCfg.username && rapidCfg.password),
        skuMapEntries: Object.keys(rapidSkuMap()).length,
      };
      if (path === "/api/rapid/health" && req.method === "GET") {
        if (!rapidClient) return json(200, { ok: false, error: "rapid_disabled", ...summary });
        const t0 = Date.now();
        try {
          await rapidClient.login();
          return json(200, { ok: true, login: "ok", latencyMs: Date.now() - t0, ...summary, scheduler: rapidScheduler?.state() || null });
        } catch (err) {
          return json(502, { ok: false, login: "failed", error: err.kind || "rapid_error", code: err.code, message: err.message, ...summary });
        }
      }
      if (!rapidClient) return json(503, { ok: false, error: "rapid_disabled" });
      const fail = (err) => json(err instanceof RapidError && typeof err.code === "number" ? 502 : 503, { ok: false, error: err.kind || "rapid_error", code: err.code, message: err.message });
      try {
        if (path === "/api/rapid/couriers" && req.method === "GET") {
          const couriers = await rapidClient.couriersList();
          return json(200, { ok: true, env: rapidCfg.env, count: couriers.length, couriers });
        }
        if (path === "/api/rapid/stock" && req.method === "GET") {
          const products = await rapidClient.productsStock();
          return json(200, { ok: true, env: rapidCfg.env, count: products.length, products });
        }
        if (path === "/api/rapid/alerts" && req.method === "GET") {
          const orders = db.listOrders().filter((o) => o.rapidAlert).map((o) => ({ id: o.id, orderRef: o.orderRef || null, rapid: o.rapid, rapidAlert: o.rapidAlert }));
          return json(200, { ok: true, count: orders.length, orders });
        }
        if (path === "/api/rapid/test-order" && req.method === "POST") {
          if (rapidCfg.env !== "test") return json(403, { ok: false, error: "refused_on_live" });
          const r = await pushSyntheticTestOrder({ client: rapidClient, cfg: rapidCfg });
          process.stdout.write(`[rapid] synthetic test order ${r.prefix}-${r.orderId} by ${op.actor || "operator"}: ${r.ok ? "ok" : "failed"}\n`);
          return json(r.ok ? 200 : 502, r);
        }
        const tOrder = path.match(/^\/api\/rapid\/test-order\/(\d{1,10})$/);
        if (tOrder && (req.method === "GET" || req.method === "DELETE")) {
          if (rapidCfg.env !== "test") return json(403, { ok: false, error: "refused_on_live" });
          const id = Number(tOrder[1]);
          if (req.method === "GET") {
            const orders = await rapidClient.ordersSearch({ order_id: id, order_id_prefix: rapidCfg.testOrderPrefix }, { shipping: true, products: true });
            return json(200, { ok: true, count: orders.length, orders });
          }
          const cancelled = await rapidClient.ordersCancel(id, rapidCfg.testOrderPrefix, "QA synthetic test order");
          return json(200, { ok: cancelled, cancelled, orderId: id, prefix: rapidCfg.testOrderPrefix });
        }
        if (path === "/api/rapid/poll-now" && req.method === "POST") {
          const body = await readBody(req).catch(() => ({}));
          const job = String(body.job || "all");
          const out = {};
          if (job === "all" || job === "status") out.status = await rapidScheduler.runStatusNow();
          if (job === "all" || job === "shipped") out.shipped = await rapidScheduler.runShippedNow(/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : undefined);
          if (job === "all" || job === "stock") out.stock = await rapidScheduler.runStockNow();
          return json(200, { ok: true, job, ...out });
        }
      } catch (err) {
        return fail(err);
      }
      return json(404, { error: "not_found" });
    }

    if (path === "/api/checkout/quote" && req.method === "POST") {
      if (!quoteLimiter.allow(clientIp(req))) return json(429, { ok: false, error: "rate_limited" });
      const body = await readBody(req);
      { const bad = unavailableLines(body); if (bad) return json(409, itemUnavailableBody(bad)); }
      { const shipBad = shipRegionRefusal(body); if (shipBad) return json(400, shipBad); }   // infra 2026-10-01 ship48
      const result = await createQuote(body, { store: db, sendQuoteEmail });
      if (!result.ok) {
        return json(result.status || 400, { ok: false, error: result.error });
      }
      markConvertedBySession(db, body.session_id || body.sessionId, {
        via: "quote",
        id: result.quoteId || null,
      });
      return json(200, {
        ok: true,
        quoteId: result.quoteId,
        message: result.message,
      });
    }

    if (path === "/api/checkout/leads-digest" && req.method === "GET") {
      if (!marketingDigestKeyOk(req)) return json(401, { error: "unauthorized" });
      const day = url.searchParams.get("day");
      const digest = buildLeadsDigest(db, day ? { day } : {});
      if (!digest.ok) return json(digest.status || 400, { error: digest.error });
      return json(200, digest);
    }

    const delAbandon = path.match(/^\/api\/checkout\/abandon\/([^/]+)$/);
    if (delAbandon && req.method === "DELETE") {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      const sid = decodeURIComponent(delAbandon[1]);
      const rec = db.getAbandonedCheckout(sid);
      if (!rec) return json(404, { ok: false, error: "not_found" });
      const email = String(rec.customer?.email || rec.email || "").toLowerCase();
      const isTest = rec.test === true || /^(qa[-+._]|qa@|dry-run@|probe)/.test(email) || /\+(test|qa)[^@]*@/.test(email);
      if (!isTest) return json(409, { ok: false, error: "not_test_record" });
      db.deleteAbandonedCheckout(sid);
      return json(200, { ok: true, deleted: sid });
    }

    if (path === "/api/checkout/abandon" && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      return json(200, { abandoned_checkouts: db.listAbandonedCheckouts() });
    }

    if (path === "/api/checkout/abandon" && req.method === "POST") {
      try {
        const parsed = await readBodySilent(req);
        if (!parsed.ok) return noContent();
        if (!abandonLimiter.allow(clientIp(req))) return noContent();
        stripGift(parsed.body);
        const normalized = normalizeAbandonPayload(parsed.body);
        if (!normalized.ok) {
          if (normalized.silent) return noContent();
          return json(normalized.status || 400, {
            ok: false,
            error: normalized.error,
            message: normalized.message,
          });
        }
        upsertAbandonedLead(db, normalized.record);
        return noContent();
      } catch {
        return noContent();
      }
    }

    if (path === "/api/psp/abandoned-digest" && req.method === "POST") {
      if (await denyUnlessOperator()) return;
      const out = await sendAbandonDigest(db, deps.abandonDigestTransport);
      return json(200, out);
    }

    if (path === "/api/psp/dry-run" && req.method === "POST") {
      if (await denyUnlessOperator()) return;
      const body = await readBody(req);
      // audit 2026-10-02 (pay-core-21, sec-pay-24): an existing key is replayed by chargeCart. On a real order that meant the mock processor
      // could approve a real declined order and the order was then flagged dryRun (invisible to shipping, deletable). A key that already
      // belongs to a non-dry-run order is refused before anything runs; a dry-run order can still be repeated under its own key.
      const dryKey = String(body.idempotencyKey || "").trim();
      const dryExisting = dryKey ? db.getOrderByIdempotency(dryKey) : null;
      if (dryExisting && dryExisting.dryRun !== true) {
        return json(409, { ok: false, error: "key_belongs_to_real_order", dryRun: true });
      }
      const scenario = body.scenario || "soft";
      const cards = {
        approved: "4242424242424242",
        soft: "4242424242420002",
        hard: "4111111111110003",
        timeout: "4242424242420005",
        pending: "4242424242420006",
      };
      const adapters = {
        umg: createMockUmg({ scenario }),
        tagada: {
          id: "tagada",
          async createPayment() {
            if (scenario === "soft" || scenario === "timeout") {
              return {
                ok: true,
                processor: "tagada",
                processorTxnId: "TG-MOCK-1",
                processorStatus: "APPROVED",
                httpStatus: 200,
                informationData: "",
                descriptor: "TAGADA-STUB",
                declineClass: null,
                cascadeAction: "success",
                reason: "approved",
                raw: { stub: true, note: "dry-run Tagada success after UMG soft/timeout" },
              };
            }
            return tagada.createPayment();
          },
        },
        centrobill,
      };
      let dryPricing = null;
      if (body.serverPricing === true) {
        const priced = await priceCardBody({ ...body, idempotencyKey: body.idempotencyKey || "" });
        if (!priced.ok) return json(priced.status, { ok: false, error: priced.error, unknownItems: priced.unknownItems, dryRun: true });
        dryPricing = priced.pricing;
      }
      const result = await chargeCart({
        pricing: dryPricing,
        idempotencyKey: body.idempotencyKey || `DRY-${Date.now()}`,
        amount: body.amount || "20.00",
        currency: "USD",
        customer: body.customer || {
          first_name: "Beverly",
          last_name: "Brower",
          email: "dry-run@biolabsresearch.co",
          address: "123 Coffee Berry Lane",
          country: "USA",
          state: "CA",
          city: "Anaheim",
          zip: "92803",
          phone: "8881234567",
          ip: "192.168.0.1",
          birthday: "1983-02-22",
        },
        items: body.items || [{ sku: "DRY-RUN", name: "CRM dry-run", qty: 1, amount: "20.00" }],
        card: { name: "Beverly Brower", number: cards[scenario] || cards.soft, month: "12", year: "28", cvv: "123" },
        notes: `CRM dry-run scenario=${scenario}`,
      }, {
        store: db,
        adapters,
        settings: {
          killSwitchPsp: null,
          processors: [
            { id: "umg", label: "UMG", enabled: true, priority: 1, mode: "sandbox" },
            { id: "tagada", label: "Tagada", enabled: true, priority: 2, mode: "sandbox" },
            { id: "centrobill", label: "Centrobill", enabled: true, priority: 3, mode: "sandbox" },
          ],
        },
      });
      // Mark mock orders so the store forwarder never treats them as real sales.
      if (result?.order?.id) {
        const dry = db.getOrder(result.order.id);
        if (dry) {
          dry.dryRun = true;
          if (body.test === true) dry.test = true;
          db.upsertOrder(dry);
          result.order = db.getOrder(dry.id);
        }
      }
      return json(200, result);
    }

    if (path === "/api/webhooks/umg" && req.method === "POST") {
      const body = await readBody(req);
      return json(200, await handleProcessorWebhook(db, "umg", body, { adapters: resolveAdapters() }));
    }
    if (path === "/api/webhooks/tagada" && req.method === "POST") {
      const body = await readBody(req);
      return json(200, await handleProcessorWebhook(db, "tagada", body, { adapters: resolveAdapters() }));
    }
    if (path === "/api/webhooks/centrobill" && req.method === "POST") {
      const body = await readBody(req);
      return json(200, await handleProcessorWebhook(db, "centrobill", body, { adapters: resolveAdapters() }));
    }

    if (path === "/api/inventory" || path.startsWith("/api/inventory/")) {
      await handleInventoryHttp({
        path,
        method: req.method,
        json,
        inventory: resolveInventory(),
        readBody: () => readBody(req),
        authorize: () => operatorContext(),
      });
      return;
    }

    if (path === "/" || path === "/api") {
      return json(200, { service: "biolabs-crm-psp", health: "/api/health" });
    }

    return json(404, { error: "not_found" });
  } catch (err) {
    if (err?.message === "payload_too_large") return json(413, { ok: false, error: "payload_too_large" }); // audit 2026-10-02
    const message = err?.message === "invalid_json" ? "invalid_json" : "server_error";
    return json(message === "invalid_json" ? 400 : 500, { error: message });
  }
  };
  handlerFn.rapidScheduler = rapidScheduler;
  handlerFn.humanUse = humanUse;
  handlerFn.cryptoVerifier = cryptoVerifier;
  handlerFn.onCleffoPaid = onCleffoPaid;
  handlerFn.orderEmailer = orderEmailer;
  handlerFn.cioOrders = cioOrders;
  return handlerFn;
}

const handler = createHandler();

// audit 2026-10-02 (pay-cleffo-crypto-12 and 5 duplicates): nginx, ops-watch and the internal lookup all reach this service on loopback;
// it must not depend on the firewall alone to stay away from the internet.
const LISTEN_HOST = "127.0.0.1";

export function startCrmServer(port = PORT, deps = {}) {
  const server = createServer(createHandler(deps));
  return new Promise((resolve) => {
    server.listen(port, LISTEN_HOST, () => resolve(server));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  sharedInventoryStore();
  recoverInFlight(store);
  startPoller(store, { intervalMs: Number(process.env.UMG_POLL_MS || 30000), adapters: liveAdapters() });
  if (process.env.STORE_FORWARD_ENABLED === "true") {
    // Picks up approvals that arrive via webhook/poll and retries failed forwards (backoff inside).
    startForwardSweeper(store, { intervalMs: Number(process.env.STORE_FORWARD_SWEEP_MS || 60000) });
  }
  if (handler.rapidScheduler) {
    handler.rapidScheduler.start(Number(process.env.RAPID_TICK_MS || 60000));
    const c = rapidConfig();
    process.stdout.write(`[rapid] scheduler on env=${c.env} autoPush=${c.autoPush} allowRealOrders=${c.allowRealOrders}\n`);
  }
  if (handler.humanUse) handler.humanUse.start(Number(process.env.HUMAN_USE_SCAN_MS || 60000)); // backfill on first start
  handler.orderEmailer.start(Number(process.env.ORDER_EMAILS_SWEEP_MS || 30000));
  if (handler.cioOrders) {
    handler.cioOrders.start(Number(process.env.CIO_SWEEP_MS || 60000));
    const c = handler.cioOrders.cfg;
    process.stdout.write(`[cio] order emails internal=${c.internal} customer=${c.customer} keySet=${c.keySet} managerTo=${c.managerTo.join(",")} since=${c.since}\n`);
  }
  {
    const c = handler.orderEmailer.cfg;
    process.stdout.write(`[emails] sweeper on enabled=${c.enabled} canSend=${canSend(c)} since=${c.since ? new Date(c.since).toISOString() : "none"}\n`);
  }

  // On-chain crypto verification + 60-min timeout (read-only chain APIs; CRYPTO_VERIFY_ENABLED=false turns it off,
  // shipping of crypto orders stays blocked either way).
  handler.cryptoVerifier.start();
  // Settles open Cleffo payment links from the status API (no-op while there are none).
  startCleffoSweeper(store, { intervalMs: Number(process.env.CLEFFO_SWEEP_MS || 60000), onPaid: handler.onCleffoPaid });
  if (isAbandonDigestEnabled()) {
    const digestMs = Number(process.env.ABANDON_DIGEST_MS || 6 * 60 * 60 * 1000);
    setInterval(() => {
      sendAbandonedDigest(store).catch(() => {});
    }, Number.isFinite(digestMs) && digestMs > 0 ? digestMs : 6 * 60 * 60 * 1000);
  }
  const server = createServer(handler);
  server.listen(PORT, LISTEN_HOST, () => {
    process.stdout.write(`crm-psp listening on :${PORT} mode=${paymentsMode()}\n`);
  });
}
