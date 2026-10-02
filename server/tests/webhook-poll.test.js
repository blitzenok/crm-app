import { test } from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { chargeCart } from "../lib/cascade.js";
import { handleProcessorWebhook } from "../lib/webhooks.js";
import { pollPending } from "../lib/poller.js";
import { createMockUmg } from "../lib/processors/umg.js";
import { startCrmServer } from "../index.js";

test("UMG webhook updates clearing beside the order", async () => {
  const store = createStore({ memoryOnly: true });
  store.saveSettings({
    processors: [
      { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
      { id: "tagada", enabled: false, priority: 2, mode: "off" },
      { id: "centrobill", enabled: false, priority: 3, mode: "off" },
    ],
  });
  const charged = await chargeCart({
    idempotencyKey: "CART-WH-1",
    amount: "20.00",
    customer: { first_name: "A", last_name: "B", email: "a@b.co", phone: "12345", country: "USA" },
    card: { number: "4242424242420006", month: "12", year: "28", cvv: "123" },
  }, { store, adapters: { umg: createMockUmg({ scenario: "pending" }), tagada: {}, centrobill: {} } });
  assert.equal(charged.pending, true);
  const txnId = charged.order.attempts[0].processorTxnId;
  // audit 2026-10-02: the webhook is only a "go and check" signal; the status comes from the processor (mock getTransaction = APPROVED)
  const wh = await handleProcessorWebhook(store, "umg", { ID: txnId, Status: "APPROVED", descriptor: "PEPTIDESS SHOP" }, { adapters: { umg: createMockUmg() } });
  assert.equal(wh.ok, true);
  assert.equal(wh.processorStatus, "APPROVED");
  const order = store.getOrder(charged.order.id);
  assert.equal(order.status, "approved");
  assert.equal(order.winningProcessor, "umg");
  assert.equal(order.attempts[0].processorStatus, "APPROVED");
});

// audit 2026-10-02: webhook authenticity. Orders are seeded directly; the processor stub answers what the "real" UMG would.
function seedOrder(store, { id = "O-WH", status = "pending", txn = "TXN-100", processorStatus = "PENDING" } = {}) {
  store.upsertOrder({
    id, status, createdAt: "2026-10-02T10:00:00.000Z",
    attempts: [{ attemptId: `${id}-a1`, processor: "umg", processorTxnId: txn, processorStatus, descriptor: "ORIG", informationData: "orig" }],
  });
  return txn;
}
function stubUmg(reply) {
  const calls = [];
  return {
    calls,
    umg: {
      async getTransaction(txnId, deps) {
        calls.push({ txnId, deps });
        if (reply instanceof Error) throw reply;
        return reply;
      },
    },
  };
}

test("webhook: forged APPROVED for a declined order does not flip it (processor says DECLINED)", async () => {
  const store = createStore({ memoryOnly: true });
  const txn = seedOrder(store, { status: "declined", processorStatus: "DECLINED" });
  const { umg, calls } = stubUmg({ ok: false, processorStatus: "DECLINED", raw: { status: "DECLINED" } });
  const res = await handleProcessorWebhook(store, "umg", { ID: txn, Status: "APPROVED" }, { adapters: { umg } });
  assert.equal(res.ok, true);
  assert.equal(res.processorStatus, "DECLINED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].txnId, txn);
  const order = store.getOrder("O-WH");
  assert.equal(order.status, "declined");
  assert.notEqual(order.attempts[0].processorStatus, "APPROVED");
});

test("webhook: forged REFUNDED for an approved order does not change it (processor says APPROVED)", async () => {
  const store = createStore({ memoryOnly: true });
  const txn = seedOrder(store, { status: "approved", processorStatus: "APPROVED" });
  const { umg } = stubUmg({ ok: true, processorStatus: "APPROVED", raw: { status: "APPROVED" } });
  const res = await handleProcessorWebhook(store, "umg", { ID: txn, Status: "REFUNDED" }, { adapters: { umg } });
  assert.equal(res.ok, true);
  assert.equal(store.getOrder("O-WH").status, "approved");
  assert.equal(store.getOrder("O-WH").attempts[0].processorStatus, "APPROVED");
});

test("webhook: only the processor's answer reaches the attempt, body fields are ignored", async () => {
  const store = createStore({ memoryOnly: true });
  const txn = seedOrder(store);
  const { umg } = stubUmg({ ok: true, processorStatus: "APPROVED", raw: { status: "APPROVED", descriptor: "REAL SHOP", information_data: "" } });
  const res = await handleProcessorWebhook(store, "umg", {
    ID: txn, Status: "APPROVED", descriptor: "<img src=x onerror=1>", information_data: "evil", informationData: "evil2", gateway_id: 666,
  }, { adapters: { umg } });
  assert.equal(res.ok, true);
  const order = store.getOrder("O-WH");
  assert.equal(order.status, "approved");
  assert.equal(order.attempts[0].descriptor, "REAL SHOP");
  const dump = JSON.stringify(order);
  assert.equal(dump.includes("onerror"), false);
  assert.equal(dump.includes("evil"), false);
  assert.notEqual(order.attempts[0].gatewayId, 666);
});

test("webhook: processor unreachable (throws / PROCESSOR_DOWN / empty answer / no getTransaction) leaves the order alone", async () => {
  const cases = [
    stubUmg(new Error("boom")).umg,
    stubUmg({ ok: false, processorStatus: "PROCESSOR_DOWN", raw: {} }).umg,
    stubUmg(null).umg,
    stubUmg({ ok: false, raw: {} }).umg,
    {},
  ];
  for (const umg of cases) {
    const store = createStore({ memoryOnly: true });
    const txn = seedOrder(store);
    const before = JSON.stringify(store.getOrder("O-WH"));
    const res = await handleProcessorWebhook(store, "umg", { ID: txn, Status: "APPROVED" }, { adapters: { umg } });
    assert.deepEqual(res, { ok: false, error: "verification_unavailable" });
    assert.equal(JSON.stringify(store.getOrder("O-WH")), before);
  }
});

test("webhook: unknown transaction id gets no processor call and no echo", async () => {
  const store = createStore({ memoryOnly: true });
  seedOrder(store);
  const { umg, calls } = stubUmg({ ok: true, processorStatus: "APPROVED", raw: {} });
  const res = await handleProcessorWebhook(store, "umg", { ID: "ATTACKER-<b>42</b>", Status: "APPROVED" }, { adapters: { umg } });
  assert.deepEqual(res, { ok: false, error: "unknown_transaction" });
  assert.equal(JSON.stringify(res).includes("ATTACKER"), false);
  assert.equal(calls.length, 0);
  // same id under another processor is also unknown (attempt is looked up per processor)
  const other = await handleProcessorWebhook(store, "tagada", { ID: "TXN-100" }, { adapters: { umg, tagada: { getTransaction: async () => { throw new Error("must not be called"); } } } });
  assert.equal(other.error, "unknown_transaction");
  const none = await handleProcessorWebhook(store, "umg", { Status: "APPROVED" }, { adapters: { umg } });
  assert.deepEqual(none, { ok: false, error: "missing_transaction_id" });
});

test("webhook: a real non-approved answer (ok:false, status REFUNDED) is applied, ok:false alone is not a failure", async () => {
  const store = createStore({ memoryOnly: true });
  const txn = seedOrder(store, { status: "approved", processorStatus: "APPROVED" });
  const { umg } = stubUmg({ ok: false, processorStatus: "REFUNDED", raw: { status: "REFUNDED" } });
  const res = await handleProcessorWebhook(store, "umg", { ID: txn }, { adapters: { umg } });
  assert.equal(res.ok, true);
  assert.equal(store.getOrder("O-WH").status, "refunded");
});

test("webhook: processorDeps are passed to the processor lookup", async () => {
  const store = createStore({ memoryOnly: true });
  const txn = seedOrder(store);
  const { umg, calls } = stubUmg({ ok: true, processorStatus: "DECLINED", raw: {} });
  await handleProcessorWebhook(store, "umg", { ID: txn }, { adapters: { umg }, processorDeps: { umg: { timeoutMs: 1234 } } });
  assert.equal(calls[0].deps.timeoutMs, 1234);
});

test("HTTP /api/webhooks/umg: forged APPROVED for a declined order returns 200 and leaves it declined", async () => {
  const store = createStore({ memoryOnly: true });
  const txn = seedOrder(store, { status: "declined", processorStatus: "DECLINED" });
  const { umg, calls } = stubUmg({ ok: true, processorStatus: "DECLINED", raw: {} });
  const server = await startCrmServer(0, { store, adapters: { umg, tagada: {}, centrobill: {} } });
  try {
    const { port } = server.address();
    const post = (b) => fetch(`http://127.0.0.1:${port}/api/webhooks/umg`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const r = await post({ ID: txn, Status: "APPROVED", descriptor: "evil" });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).processorStatus, "DECLINED");
    assert.equal(calls.length, 1);
    assert.equal(store.getOrder("O-WH").status, "declined");
    const r2 = await post({ ID: "NOPE", Status: "APPROVED" });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).error, "unknown_transaction");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("poll fallback flips PENDING to APPROVED without a webhook", async () => {
  const store = createStore({ memoryOnly: true });
  store.saveSettings({
    processors: [
      { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
      { id: "tagada", enabled: false, priority: 2, mode: "off" },
      { id: "centrobill", enabled: false, priority: 3, mode: "off" },
    ],
  });
  const charged = await chargeCart({
    idempotencyKey: "CART-POLL-1",
    amount: "20.00",
    customer: { first_name: "A", last_name: "B", email: "a@b.co", phone: "12345", country: "USA" },
    card: { number: "4242424242420006", month: "12", year: "28", cvv: "123" },
  }, { store, adapters: { umg: createMockUmg({ scenario: "pending" }), tagada: {}, centrobill: {} } });
  assert.equal(charged.order.status, "pending");
  const results = await pollPending(store, { adapters: { umg: createMockUmg() } });
  assert.equal(results[0].status, "APPROVED");
  assert.equal(store.getOrder(charged.order.id).status, "approved");
});
