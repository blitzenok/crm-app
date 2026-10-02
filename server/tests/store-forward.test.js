import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { buildNotifyPayload, forwardOrder, sweepForward, splitSku, isDryRunOrder } from "../lib/store-forward.js";
import { startCrmServer } from "../index.js";

const CUSTOMER = {
  first_name: "Ada", last_name: "Nguyen", email: "ada@lab.example", phone: "4155550100",
  address: "1 Research Way", city: "San Francisco", state: "CA", zip: "94107", country: "USA",
};

function approvedOrder(store, extra = {}) {
  const o = {
    id: store.nextOrderId(), idempotencyKey: `K-${Math.random()}`, createdAt: new Date().toISOString(),
    status: "approved", amount: "168.00", currency: "USD", customer: CUSTOMER,
    items: [{ sku: "bpc-157-10mg", name: "BPC-157", qty: 2, amount: "79.00" }],
    winningProcessor: "umg", winningTxnId: "UMG-1", descriptor: null, attempts: [], ...extra,
  };
  store.upsertOrder(o);
  return o;
}

function fakeFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses.length > 1 ? responses.shift() : responses[0];
    if (r instanceof Error) throw r;
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  };
  fn.calls = calls;
  return fn;
}

test("sku split and payload mapping (server totals left to notify-order)", () => {
  assert.deepEqual(splitSku("bpc-157-10mg"), { slug: "bpc-157", mg: "10mg" });
  assert.deepEqual(splitSku("nad-plus-500mg"), { slug: "nad-plus", mg: "500mg" });
  assert.deepEqual(splitSku("kpv"), { slug: "kpv", mg: "" });
  const store = createStore({ memoryOnly: true });
  const p = buildNotifyPayload(approvedOrder(store));
  assert.equal(p.paymentMethod, "card-umg");
  assert.equal(p.orderData.ref, "BLR-1001");
  assert.equal(p.orderData.customer.firstName, "Ada");
  assert.equal(p.orderData.shipping.address1, "1 Research Way");
  assert.deepEqual(p.orderData.items[0], { slug: "bpc-157", name: "BPC-157", mg: "10mg", qty: 2, price: 79 });
  assert.equal(p.orderData.subtotal, "158.00");
  assert.equal(p.orderData.shippingCost, "10.00");
  assert.equal(p.orderData.total, "168.00");
  assert.doesNotMatch(p.body, /PEPTIDESS|statement/i); // 2026-10-01 no descriptor in the store note
  assert.equal(JSON.stringify(p).includes("4242"), false);
});

test("forward once, retry on failure, skip dry-run", async () => {
  const store = createStore({ memoryOnly: true });
  const o = approvedOrder(store);
  const failing = fakeFetch([new Error("ECONNREFUSED")]);
  const r1 = await forwardOrder(store, o.id, { fetchImpl: failing, logger: {} });
  assert.equal(r1.ok, false);
  assert.equal(store.getOrder(o.id).storeForward.attempts, 1);
  assert.ok(store.getOrder(o.id).storeForward.nextAttemptAt);

  const good = fakeFetch([{ status: 200, body: { ok: true, ref: o.id } }]);
  const r2 = await forwardOrder(store, o.id, { fetchImpl: good, logger: {} });
  assert.equal(r2.ok, true);
  const r3 = await forwardOrder(store, o.id, { fetchImpl: good, logger: {} });
  assert.equal(r3.reason, "already_sent");
  assert.equal(good.calls.length, 1);

  const dry = approvedOrder(store, { idempotencyKey: "DRY-1", dryRun: true });
  assert.equal(isDryRunOrder(dry), true);
  const r4 = await forwardOrder(store, dry.id, { fetchImpl: good, logger: {} });
  assert.equal(r4.reason, "dry_run_or_test");
  const declined = approvedOrder(store, { status: "declined" });
  assert.equal((await forwardOrder(store, declined.id, { fetchImpl: good, logger: {} })).reason, "not_approved");
});

test("sweep only picks real approved orders created since the cutoff", async () => {
  const store = createStore({ memoryOnly: true });
  approvedOrder(store, { createdAt: "2026-09-17T00:00:00.000Z" });
  const fresh = approvedOrder(store);
  const f = fakeFetch([{ status: 200, body: { ok: true, ref: fresh.id } }]);
  const out = await sweepForward(store, { since: "2026-09-28T00:00:00.000Z", fetchImpl: f, logger: {} });
  assert.deepEqual(out.map((x) => x.id), [fresh.id]);
  assert.equal((await sweepForward(store, { since: "2026-09-28T00:00:00.000Z", fetchImpl: f, logger: {} })).length, 0);
});

test("approved charge answers the shop even when forwarding fails, then forwards once", async () => {
  const prev = process.env.PAYMENTS_ENABLED;
  process.env.PAYMENTS_ENABLED = "true";
  const store = createStore({ memoryOnly: true });
  store.saveSettings({ processors: [
    { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
    { id: "tagada", enabled: false, priority: 2, mode: "off" },
    { id: "centrobill", enabled: false, priority: 3, mode: "off" },
  ] });
  const f = fakeFetch([new Error("down")]);
  const server = await startCrmServer(0, {
    store, forwardFetch: f,
    adapters: { umg: { async createPayment() { return { ok: true, processor: "umg", processorTxnId: "UMG-F", processorStatus: "APPROVED", cascadeAction: "success", raw: {} }; } }, tagada: {}, centrobill: {} },
  });
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/checkout/charge`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idempotencyKey: "FWD-1", amount: "20.00", customer: CUSTOMER, items: [{ sku: "kpv-10mg", name: "KPV", qty: 1, amount: "20.00" }], card: { name: "Ada", number: "4242424242424242", month: "12", year: "28", cvv: "123" } }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.order.status, "approved");
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0].body.orderData.ref, body.order.id);
    assert.equal(JSON.stringify(f.calls[0].body).includes("4242"), false);
    assert.equal(store.getOrder(body.order.id).storeForward.sentAt, null);
    assert.equal(store.getOrder(body.order.id).storeForward.lastError, "network_error");
  } finally {
    await new Promise((r) => server.close(r));
    if (prev === undefined) delete process.env.PAYMENTS_ENABLED; else process.env.PAYMENTS_ENABLED = prev;
  }
});
