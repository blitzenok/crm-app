import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createStore } from "./lib/store.js";
import { secretHealth } from "./lib/secrets.js";
import { chargeCart, ADAPTERS } from "./lib/cascade.js";
import { handleProcessorWebhook } from "./lib/webhooks.js";
import { pollPending, startPoller } from "./lib/poller.js";
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
  markCryptoPaid,
  publicCryptoStatus,
  shipOrder,
  updateTracking,
  walletFlags,
} from "./lib/crypto-checkout.js";
import { createInventoryStore, INVENTORY_PATH } from "./lib/inventory.js";
import { seedInventory } from "./lib/inventory-seed.js";
import { handleInventoryHttp } from "./lib/inventory-http.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const STORE_PATH = process.env.STORE_PATH || join(__dirname, "data", "store.json");
const DRY_RUN = process.env.UMG_DRY_RUN === "1" || process.env.UMG_DRY_RUN === "true";
const PUBLIC_URL = (process.env.CRM_PUBLIC_URL || "").replace(/\/$/, "");

const store = createStore({ filePath: STORE_PATH });
let defaultInventoryStore = null;

function sharedInventoryStore() {
  if (!defaultInventoryStore) {
    defaultInventoryStore = createInventoryStore({ filePath: INVENTORY_PATH });
    seedInventory(defaultInventoryStore);
  }
  return defaultInventoryStore;
}

function liveAdapters() {
  if (DRY_RUN) {
    return { umg: createMockUmg({ scenario: "soft" }), tagada, centrobill };
  }
  return ADAPTERS;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function callbackUrl() {
  const path = "/api/webhooks/umg";
  return PUBLIC_URL ? `${PUBLIC_URL}${path}` : path;
}

function readBodySilent(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
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
  function resolveInventory() {
    if (deps.inventory) return deps.inventory;
    return sharedInventoryStore();
  }
  const sendQuoteEmail = deps.sendQuoteEmail || sendQuoteNotification;
  const resolveAdapters = () => deps.adapters || liveAdapters();
  const abandonLimiter = deps.abandonLimiter || createRateLimiter();
  const cryptoLimiter = deps.cryptoLimiter || createRateLimiter();
  const sendAbandonDigest = deps.sendAbandonDigest || sendAbandonedDigest;

  return async function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
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
      return json(200, {
        ok: true,
        service: "crm-umg",
        dryRun: DRY_RUN,
        callbackUrl: callbackUrl(),
        paymentsEnabled: enabled,
        mode: paymentsMode(),
        cryptoWallets: walletFlags(),
        ...secretHealth(),
      });
    }

    if (path === "/api/psp/settings" && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      return json(200, {
        settings: db.getSettings(),
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

    const cryptoAction = path.match(/^\/api\/store-orders\/([^/]+)\/(mark-paid|ship|tracking)$/);
    if (cryptoAction && req.method === "POST") {
      const op = await operatorContext();
      if (!op.ok) return json(401, { error: "unauthorized" });
      const id = decodeURIComponent(cryptoAction[1]);
      const action = cryptoAction[2];
      if (action === "mark-paid") {
        const body = await readBody(req);
        const result = markCryptoPaid(id, body, { store: db, actor: op.actor, via: op.via });
        if (!result.ok) {
          return json(result.status || 400, {
            ok: false,
            error: result.error,
            orderStatus: result.orderStatus,
            fulfillment: result.fulfillment,
            paymentConfirmed: result.paymentConfirmed,
            amountDue: result.amountDue,
            amountReceived: result.amountReceived,
          });
        }
        return json(200, {
          ok: true,
          reused: Boolean(result.reused),
          order: result.order,
          paymentConfirmed: Boolean(result.order?.paymentConfirmed),
          analyticsEvent: result.order?.analyticsEvent || null,
          fulfillment: result.order?.fulfillment?.status || null,
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
      const result = await chargeCart(body, { store: db, adapters: resolveAdapters() });
      if (result.ok) {
        markConvertedBySession(db, body.session_id || body.sessionId, {
          via: "charge",
          id: result.order?.id || null,
        });
      }
      return json(result.ok ? 200 : 402, result);
    }

    if (path === "/api/checkout/crypto" && req.method === "POST") {
      if (!cryptoLimiter.allow(clientIp(req))) {
        return json(429, { ok: false, error: "rate_limited" });
      }
      const body = await readBody(req);
      const result = createCryptoCheckout(body, { store: db });
      if (!result.ok) {
        return json(result.status || 400, { ok: false, error: result.error });
      }
      if (!result.reused) {
        markConvertedBySession(db, body.session_id || body.sessionId, {
          via: "crypto",
          id: result.order?.id || null,
        });
      }
      return json(200, { ...result.public, reused: Boolean(result.reused) });
    }

    if (path.startsWith("/api/checkout/crypto/") && req.method === "GET") {
      const ref = decodeURIComponent(path.slice("/api/checkout/crypto/".length));
      const view = publicCryptoStatus(db, ref);
      if (!view) return json(404, { ok: false, error: "not_found" });
      return json(200, view);
    }

    if (path === "/api/checkout/quote" && req.method === "POST") {
      const body = await readBody(req);
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

    if (path === "/api/checkout/abandon" && req.method === "GET") {
      if (await denyUnlessOperator()) return;
      return json(200, { abandoned_checkouts: db.listAbandonedCheckouts() });
    }

    if (path === "/api/checkout/abandon" && req.method === "POST") {
      try {
        const parsed = await readBodySilent(req);
        if (!parsed.ok) return noContent();
        if (!abandonLimiter.allow(clientIp(req))) return noContent();
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
      const result = await chargeCart({
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
      return json(200, result);
    }

    if (path === "/api/webhooks/umg" && req.method === "POST") {
      const body = await readBody(req);
      return json(200, handleProcessorWebhook(db, "umg", body));
    }
    if (path === "/api/webhooks/tagada" && req.method === "POST") {
      const body = await readBody(req);
      return json(200, handleProcessorWebhook(db, "tagada", body));
    }
    if (path === "/api/webhooks/centrobill" && req.method === "POST") {
      const body = await readBody(req);
      return json(200, handleProcessorWebhook(db, "centrobill", body));
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
    const message = err?.message === "invalid_json" ? "invalid_json" : "server_error";
    return json(message === "invalid_json" ? 400 : 500, { error: message });
  }
  };
}

const handler = createHandler();

export function startCrmServer(port = PORT, deps = {}) {
  const server = createServer(createHandler(deps));
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  sharedInventoryStore();
  startPoller(store, { intervalMs: Number(process.env.UMG_POLL_MS || 30000), adapters: liveAdapters() });
  if (isAbandonDigestEnabled()) {
    const digestMs = Number(process.env.ABANDON_DIGEST_MS || 6 * 60 * 60 * 1000);
    setInterval(() => {
      sendAbandonedDigest(store).catch(() => {});
    }, Number.isFinite(digestMs) && digestMs > 0 ? digestMs : 6 * 60 * 60 * 1000);
  }
  const server = createServer(handler);
  server.listen(PORT, "0.0.0.0", () => {
    process.stdout.write(`crm-psp listening on :${PORT} mode=${paymentsMode()}\n`);
  });
}
