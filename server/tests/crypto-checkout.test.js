import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { depositWallets, isShippable } from "../lib/crypto-checkout.js";
import { chargeCart } from "../lib/cascade.js";
import { startCrmServer } from "../index.js";
import { createMockChain, createMockScreener } from "./crypto-mock.js";

const ERC = `0x${"ab".repeat(20)}`;
const TRC = `T${"9".repeat(33)}`;
const KEY = "test-marketing-digest-key";
const TX = `0x${"cd".repeat(32)}`;
const TX_TRON = "ef".repeat(32);

const SAMPLE = {
  idempotencyKey: "BL-CRYPTO-TEST-1",
  amount: "158.00",
  currency: "USD",
  network: "trc20",
  session_id: "bl-sess-crypto-1",
  customer: {
    first_name: "Ada",
    last_name: "Nguyen",
    email: "ada@lab.example",
    phone: "4155550100",
    address: "1 Research Way",
    city: "San Francisco",
    state: "CA",
    zip: "94107",
    country: "USA",
  },
  items: [{ sku: "BL-PEP-001", name: "Research peptide A", qty: 2, amount: "79.00" }],
  notes: "RUO",
};

function withEnv(pairs, fn) {
  const prev = {};
  for (const [key, value] of Object.entries(pairs)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
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

test("deposit wallets come from env and reject key-shaped values", () => {
  assert.deepEqual(depositWallets({}), { usdtErc20: null, usdtTrc20: null });
  assert.deepEqual(depositWallets({ CRYPTO_USDT_ERC: ERC, CRYPTO_USDT_TRC: TRC }), {
    usdtErc20: ERC,
    usdtTrc20: TRC,
  });
  const priv = "ab".repeat(32);
  assert.equal(depositWallets({ CRYPTO_USDT_ERC: priv, CRYPTO_USDT_TRC: `0x${priv}` }).usdtErc20, null);
  assert.equal(depositWallets({ CRYPTO_USDT_ERC: priv, CRYPTO_USDT_TRC: `0x${priv}` }).usdtTrc20, null);
});

test("crypto checkout: pending order, no purchase signal, ship blocked until the staff tx is verified on-chain", async () => {
  await withEnv({
    PAYMENTS_ENABLED: undefined,
    MARKETING_DIGEST_KEY: KEY,
    CRYPTO_USDT_ERC: ERC,
    CRYPTO_USDT_TRC: TRC,
    CRM_PUBLIC_URL: "https://crm.biolabsresearch.co",
  }, async () => {
    const store = createStore({ memoryOnly: true });
    let umgCalled = 0;
    const trc = createMockChain("trc20", { latest: 5000 });
    const erc = createMockChain("erc20", { latest: 9000 });
    await withServer({
      store,
      cryptoChains: { trc20: trc, erc20: erc },
      cryptoScreener: createMockScreener(),
      cryptoConfirmSecret: "x".repeat(40),
      adapters: {
        umg: {
          async createPayment() {
            umgCalled += 1;
            return { ok: true, processor: "umg", processorStatus: "APPROVED", cascadeAction: "success", raw: {} };
          },
        },
      },
      checkCrmSession: async (token) => (
        token === "good-session" ? { email: "staff@biolabsresearch.co", role: "staff" } : false
      ),
    }, async (port) => {
      const base = `http://127.0.0.1:${port}`;

      store.upsertAbandonedCheckout({
        session_id: SAMPLE.session_id,
        stage: "payment",
        customer: SAMPLE.customer,
        items: SAMPLE.items,
        subtotal: "158.00",
      });

      const charge = await fetch(`${base}/api/checkout/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "CARD-STILL-GATED",
          amount: "20.00",
          customer: SAMPLE.customer,
          card: { number: "4242424242424242", month: "12", year: "28", cvv: "123" },
        }),
      });
      assert.equal(charge.status, 503);
      assert.equal(umgCalled, 0);

      const createdRes = await fetch(`${base}/api/checkout/crypto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(SAMPLE),
      });
      assert.equal(createdRes.status, 200);
      const created = await createdRes.json();
      assert.equal(created.ok, true);
      assert.equal(created.status, "awaiting_crypto");
      assert.equal(created.paymentConfirmed, false);
      assert.equal(created.analyticsEvent, null);
      assert.equal(created.amount, "158.00");
      // unique exact amount: 158.00 + 0.01..0.99, returned as amountDue / payAmount (+ integer micro-units)
      assert.match(created.payAmount, /^158\.\d{2}$/);
      assert.notEqual(created.payAmount, "158.00");
      assert.equal(created.amountDue, created.payAmount);
      assert.equal(created.payAmountUnits, String(Math.round(Number(created.payAmount) * 1e6)));
      assert.equal(created.paymentStatus, "awaiting_payment");
      assert.equal(created.network, "trc20");
      assert.equal(created.token, "USDT");
      assert.equal(created.wallet, TRC);
      assert.ok(created.confirmToken && created.confirmToken.length >= 40);
      assert.ok(Date.parse(created.expiresAt) - Date.parse(created.createdAt) === 60 * 60 * 1000);
      assert.equal(created.currency, "USD");
      assert.equal(created.payAsset, "USDT");
      assert.match(created.orderRef, /^CR-[A-Z2-9]{8}$/);
      assert.equal(created.fulfillment, "blocked");
      assert.equal(created.shippable, false);
      assert.equal(created.wallets.usdtErc20, ERC);
      assert.equal(created.wallets.usdtTrc20, TRC);
      assert.equal(created.statusUrl, `https://crm.biolabsresearch.co/api/checkout/crypto/${created.orderRef}`);
      assert.equal(JSON.stringify(created).toLowerCase().includes("payment successful"), false);
      assert.equal(JSON.stringify(created).includes('"purchase"'), false);
      assert.equal(created.customer, undefined);

      const again = await fetch(`${base}/api/checkout/crypto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(SAMPLE),
      }).then((r) => r.json());
      assert.equal(again.reused, true);
      assert.equal(again.orderRef, created.orderRef);
      assert.equal(again.payAmount, created.payAmount);
      assert.equal(store.listOrders().filter((o) => o.paymentMethod === "crypto").length, 1);

      const lead = store.getAbandonedCheckout(SAMPLE.session_id);
      assert.equal(lead.status, "converted");
      assert.equal(lead.converted_via, "crypto");

      const poll = await fetch(`${base}/api/checkout/crypto/${created.orderRef}`).then((r) => r.json());
      assert.equal(poll.paymentConfirmed, false);
      assert.equal(poll.confirmToken, undefined);
      assert.equal(poll.analyticsEvent, null);
      assert.equal(poll.customer, undefined);
      assert.equal(JSON.stringify(poll).toLowerCase().includes("payment successful"), false);

      const anonShip = await fetch(`${base}/api/store-orders/${created.orderId}/ship`, { method: "POST" });
      assert.equal(anonShip.status, 401);

      const staff = { Authorization: "Bearer good-session", "Content-Type": "application/json" };
      const blocked = await fetch(`${base}/api/store-orders/${created.orderRef}/ship`, {
        method: "POST",
        headers: staff,
      });
      assert.equal(blocked.status, 409);
      const blockedBody = await blocked.json();
      assert.equal(blockedBody.error, "ship_blocked");
      assert.equal(blockedBody.paymentConfirmed, false);

      const list = await fetch(`${base}/api/store-orders?paymentMethod=crypto&q=${created.orderRef}`, {
        headers: { "X-Marketing-Key": KEY },
      }).then((r) => r.json());
      assert.equal(list.orders.length, 1);
      assert.equal(list.orders[0].customer.email, "ada@lab.example");
      assert.equal(list.orders[0].fulfillment.status, "blocked");

      const badHash = await fetch(`${base}/api/store-orders/${created.orderId}/mark-paid`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ txHash: "not-a-hash" }),
      });
      assert.equal(badHash.status, 400);

      const noTx = await fetch(`${base}/api/store-orders/${created.orderId}/mark-paid`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ amountReceived: "158.00" }),
      });
      assert.equal(noTx.status, 400);
      assert.equal((await noTx.json()).error, "tx_hash_required");

      const mismatch = await fetch(`${base}/api/store-orders/${created.orderId}/mark-paid`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ txHash: TX, amountReceived: "158.00" }),
      });
      assert.equal(mismatch.status, 400);
      assert.equal((await mismatch.json()).error, "tx_hash_network_mismatch");

      // A staff-entered hash that the chain does not know is NOT a payment
      const unknown = await fetch(`${base}/api/store-orders/${created.orderId}/mark-paid`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ txHash: TX_TRON, amountReceived: "158.00" }),
      });
      assert.equal(unknown.status, 409);
      const unknownBody = await unknown.json();
      assert.equal(unknownBody.error, "not_verified_on_chain");
      assert.equal(unknownBody.paymentConfirmed, false);
      assert.equal(unknownBody.fulfillment, "blocked");
      const stillBlocked = await fetch(`${base}/api/store-orders/${created.orderRef}/ship`, { method: "POST", headers: staff });
      assert.equal(stillBlocked.status, 409);

      // Now the chain has it: right wallet, USDT contract, exact amount, 25 confirmations (>= 20)
      trc.addTx({ hash: TX_TRON, to: TRC, units: created.payAmountUnits, blockNumber: 5000 - 25 });
      const paidRes = await fetch(`${base}/api/store-orders/${created.orderId}/mark-paid`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ txHash: TX_TRON }),
      });
      assert.equal(paidRes.status, 200);
      const paid = await paidRes.json();
      assert.equal(paid.paymentConfirmed, true);
      assert.equal(paid.analyticsEvent, null);
      assert.equal(paid.fulfillment, "ready_to_ship");
      assert.equal(paid.order.fulfillment.status, "ready_to_ship");
      assert.equal(paid.order.fulfillment.shippedAt, null);
      assert.equal(paid.order.cryptoPayment.verifiedOnChain, true);
      assert.equal(paid.order.cryptoPayment.transfers[0].matchedBy, "staff_tx_hint");
      assert.equal(paid.order.cryptoPayment.staffActions.at(-1).actor, "staff@biolabsresearch.co");
      assert.equal(paid.order.crypto.txHash, TX_TRON);
      assert.equal(paid.order.crypto.amountReceived, created.payAmount);
      assert.equal(paid.order.crypto.network, "trc20");

      const pollPaid = await fetch(`${base}/api/checkout/crypto/${created.orderRef}`).then((r) => r.json());
      assert.equal(pollPaid.status, "crypto_paid");
      assert.equal(pollPaid.paymentStatus, "paid");
      assert.equal(pollPaid.paymentConfirmed, true);
      assert.equal(pollPaid.shippable, true);
      assert.equal(pollPaid.fulfillment, "ready_to_ship");
      assert.equal(JSON.stringify(pollPaid).toLowerCase().includes("payment successful"), false);

      const early = await fetch(`${base}/api/store-orders/${created.orderRef}/tracking`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ carrier: "USPS", trackingNumber: "9400100000000000000000" }),
      });
      assert.equal(early.status, 409);

      const shipped = await fetch(`${base}/api/store-orders/${created.orderRef}/ship`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ carrier: "USPS", trackingNumber: "9400100000000000000000" }),
      });
      assert.equal(shipped.status, 200);
      const shippedBody = await shipped.json();
      assert.equal(shippedBody.fulfillment, "shipped");
      assert.equal(shippedBody.order.fulfillment.carrier, "USPS");
      assert.equal(shippedBody.order.fulfillment.trackingNumber, "9400100000000000000000");

      const fix = await fetch(`${base}/api/store-orders/${created.orderRef}/tracking`, {
        method: "POST",
        headers: staff,
        body: JSON.stringify({ carrier: "UPS", trackingNumber: "1Z999AA10123456784", trackingUrl: "javascript:alert(1)" }),
      });
      assert.equal(fix.status, 200);
      const fixed = await fix.json();
      assert.equal(fixed.order.fulfillment.carrier, "UPS");
      assert.equal(fixed.order.fulfillment.trackingUrl, null);
      assert.equal(shippedBody.order.fulfillment.shippedBy, "staff@biolabsresearch.co");
      assert.equal(isShippable(shippedBody.order), false);
    });
  });
});

test("card charge path is unchanged and an approved card order can still ship", async () => {
  await withEnv({ PAYMENTS_ENABLED: "true", MARKETING_DIGEST_KEY: KEY }, async () => {
    const store = createStore({ memoryOnly: true });
    store.saveSettings({
      processors: [
        { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
        { id: "tagada", enabled: false, priority: 2, mode: "off" },
        { id: "centrobill", enabled: false, priority: 3, mode: "off" },
      ],
    });
    let umgCalled = 0;
    await withServer({
      store,
      adapters: {
        umg: {
          async createPayment() {
            umgCalled += 1;
            return {
              ok: true,
              processor: "umg",
              processorTxnId: "UMG-CARD-1",
              processorStatus: "APPROVED",
              cascadeAction: "success",
              raw: {},
            };
          },
        },
        tagada: {},
        centrobill: {},
      },
    }, async (port) => {
      const base = `http://127.0.0.1:${port}`;
      const res = await fetch(`${base}/api/checkout/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idempotencyKey: "CART-PAY-CRYPTO-SAFE",
          amount: "20.00",
          customer: SAMPLE.customer,
          items: SAMPLE.items,
          card: { name: "Ada Nguyen", number: "4242424242424242", month: "12", year: "28", cvv: "123" },
        }),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.order.status, "approved");
      assert.equal(body.order.paymentMethod, undefined);
      assert.equal(umgCalled, 1);

      const ship = await fetch(`${base}/api/store-orders/${body.order.id}/ship`, {
        method: "POST",
        headers: { "X-Marketing-Key": KEY },
      });
      assert.equal(ship.status, 200);
      const shipped = await ship.json();
      assert.equal(shipped.fulfillment, "shipped");
      assert.equal(shipped.order.status, "approved");

      const cryptoMark = await fetch(`${base}/api/store-orders/${body.order.id}/mark-paid`, {
        method: "POST",
        headers: { "X-Marketing-Key": KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ txHash: TX }),
      });
      assert.equal(cryptoMark.status, 409);
      assert.equal((await cryptoMark.json()).error, "not_crypto_order");
    });
  });
});

test("crypto checkout rejects card payloads and does not call UMG", async () => {
  await withEnv({ PAYMENTS_ENABLED: "true", CRYPTO_USDT_ERC: ERC }, async () => {
    const store = createStore({ memoryOnly: true });
    let umgCalled = 0;
    await withServer({
      store,
      adapters: {
        umg: {
          async createPayment() {
            umgCalled += 1;
            return { ok: true, processorStatus: "APPROVED", cascadeAction: "success", raw: {} };
          },
        },
      },
    }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/checkout/crypto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...SAMPLE,
          idempotencyKey: "BL-CRYPTO-CARD",
          card: { number: "4242424242424242", cvv: "123" },
        }),
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "card_not_accepted");
      assert.equal(umgCalled, 0);
      assert.equal(store.listOrders().length, 0);
    });
  });
});

test("direct chargeCart still approves a card when payments are on", async () => {
  const store = createStore({ memoryOnly: true });
  store.saveSettings({
    processors: [
      { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
      { id: "tagada", enabled: false, priority: 2, mode: "off" },
      { id: "centrobill", enabled: false, priority: 3, mode: "off" },
    ],
  });
  const result = await chargeCart({
    idempotencyKey: "DIRECT-CARD",
    amount: "10.00",
    customer: SAMPLE.customer,
    items: SAMPLE.items,
    card: { name: "Ada Nguyen", number: "4242424242424242", month: "12", year: "28", cvv: "123" },
  }, {
    store,
    adapters: {
      umg: {
        async createPayment() {
          return {
            ok: true,
            processor: "umg",
            processorTxnId: "UMG-2",
            processorStatus: "APPROVED",
            cascadeAction: "success",
            raw: {},
          };
        },
      },
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.order.status, "approved");
  assert.equal(isShippable(result.order), true);
});
