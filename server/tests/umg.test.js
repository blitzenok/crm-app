import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCreatePayload, createPayment, getTransaction, mapUmgResponse, transactionUrl } from "../lib/processors/umg.js";

const SAMPLE = {
  customer: {
    first_name: "Beverly",
    last_name: "Brower",
    email: "test@test.com",
    address: "123 Coffee Berry Lane",
    country: "US",
    state: "CA",
    city: "Anaheim",
    zip: "92803",
    phone: "8881234567",
    ip: "192.168.0.1",
    birthday: "1983-02-22",
  },
  card: { name: "Beverly Brower", number: "4242424242424242", month: "12", year: "2028", cvv: "123" },
  amount: "20.00",
  currency: "USD",
  extOrderId: "SANDBOX-TEST-001",
};

test("create payload matches verified UMG field names and never uses birtdday key", () => {
  const payload = buildCreatePayload({ ...SAMPLE, secret: "dummy-key" });
  assert.equal(payload.vendor, "BioLabs Research");
  assert.equal(payload.userData.country, "USA");
  assert.equal(payload.userData.birthday, "1983-02-22");
  assert.equal("birtdday" in payload.userData, false);
  assert.equal(payload.cardData.type, "2");
  assert.equal(payload.cardData.year, "28");
  assert.equal(payload.amount, "20.00");
  assert.equal(payload.ext_order_id, "SANDBOX-TEST-001");
  assert.equal(payload.subscription_status, 0);
  assert.ok(payload.Authorization);
  assert.notEqual(payload.Authorization, "dummy-key");
});

test("mapUmgResponse keeps full clearing fields and treats HTTP 201 DECLINED as valid adapter output", () => {
  const mapped = mapUmgResponse({
    id: 5136,
    status: "DECLINED",
    date: "Sep 17, 2026 10:48:13 AM",
    information_data: "Activity limit exceeded; Code:203",
    gateway_id: 7,
    descriptor: "PEPTIDESS SHOP",
    ext_order_id: "SANDBOX-TEST-001",
    txid: null,
    card: { number: "424242****4242" },
  }, 201);
  assert.equal(mapped.ok, false);
  assert.equal(mapped.processorTxnId, "5136");
  assert.equal(mapped.processorStatus, "DECLINED");
  assert.equal(mapped.descriptor, "PEPTIDESS SHOP");
  assert.equal(mapped.gatewayId, 7);
  assert.equal(mapped.declineClass, "soft");
  assert.equal(mapped.cascadeAction, "next");
  assert.equal(mapped.cardLast4, "4242");
});

test("createPayment uses Basic auth + JSON body and does not require a live key when fetch is injected", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      status: 201,
      async text() {
        return JSON.stringify({
          id: 9001,
          status: "APPROVED",
          date: "Sep 17, 2026 10:00:00 AM",
          descriptor: "PEPTIDESS SHOP",
          gateway_id: 7,
          txid: "TX1",
          ext_order_id: "SANDBOX-TEST-001",
          card: { number: "424242****4242" },
        });
      },
    };
  };
  const result = await createPayment(SAMPLE, { secret: "unit-test-secret", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.processorStatus, "APPROVED");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://pay.umg.inc/rest/v1/transactions");
  assert.match(calls[0].opts.headers.Authorization, /^Basic /);
  const sent = JSON.parse(calls[0].opts.body);
  assert.equal(sent.cardData.number, "4242424242424242");
  assert.ok(!JSON.stringify(result.raw).includes("unit-test-secret"));
});

test("a refused connection is soft processor-down once find-by-ext-id confirms nothing was charged", async () => {
  // infra 2026-09-29 honest-charge: a timeout alone is no longer "declined": UMG is asked by our key first (200 + [] = no charge).
  const fetchImpl = async (url) => {
    if (String(url).includes("/find-by-ext-id/")) return { status: 200, async text() { return "[]"; } };
    const err = new Error("fetch failed"); // connection refused: the request never reached UMG
    err.cause = { code: "ECONNREFUSED" };
    throw err;
  };
  const result = await createPayment(SAMPLE, { secret: "unit-test-secret", fetchImpl, timeoutMs: 5, findDelayMs: 0 });
  assert.equal(result.declineClass, "soft");
  assert.equal(result.cascadeAction, "next");
  assert.equal(result.processorStatus, "PROCESSOR_DOWN");
  assert.equal(result.noChargeConfirmed, true);
});

test("getTransaction hits verified poll URL shape", async () => {
  const secret = "unit-test-secret";
  const url = transactionUrl(5136, secret);
  assert.match(url, /\/rest\/v1\/transactions\/5136\?Authorization=/);
  const fetchImpl = async () => ({
    status: 200,
    async text() {
      return JSON.stringify({ id: 5136, status: "APPROVED", descriptor: "PEPTIDESS SHOP" });
    },
  });
  const result = await getTransaction(5136, { secret, fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.processorStatus, "APPROVED");
});

test("missing secret does not throw and does not call the network", async () => {
  let called = 0;
  const result = await createPayment(SAMPLE, {
    secret: null,
    fetchImpl: async () => { called += 1; throw new Error("should not run"); },
  });
  assert.equal(called, 0);
  assert.equal(result.declineClass, "soft");
  assert.match(result.informationData, /UMG_API_SECRET/);
});
