import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { createStore } from "../lib/store.js";
import { buildLeadsDigest, jerusalemDay, publicAttribution, sanitizeAttribution, scoreLead } from "../lib/leads-digest.js";
import { isPaymentsEnabled } from "../lib/payments.js";
import { secretsEqual, sessionBodyOk } from "../lib/operator-auth.js";
import { startCrmServer } from "../index.js";

const KEY = "test-marketing-digest-key";

const QUOTE = {
  idempotencyKey: "BL-QUOTE-G1-1",
  amount: "158.00",
  currency: "USD",
  customer: {
    first_name: "Ada",
    last_name: "Nguyen",
    email: "ada.nguyen@university.edu",
  },
  items: [{ sku: "G1-S", name: "G1-S", qty: 1, amount: "158.00" }],
};

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev === undefined) delete process.env[key];
      else process.env[key] = prev;
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

function seedDay(store) {
  const quote = {
    id: "QT-9001",
    type: "lead",
    status: "quote_requested",
    crmStatus: "Not Contacted",
    idempotencyKey: "BL-QUOTE-DIGEST-1",
    createdAt: "2026-09-22T18:00:00.000Z",
    updatedAt: "2026-09-22T18:00:00.000Z",
    amount: "158.00",
    currency: "USD",
    customer: { first_name: "Ada", last_name: "Nguyen", email: "ada.nguyen@university.edu" },
    items: [{ sku: "G1-S", name: "G1-S", qty: 1, amount: "158.00" }],
    session_id: "sess-real",
    attribution: { utm_source: "google", gclid: "SECRETCLICK", track_token: "should-not-leak" },
    consent_text: "RUO research use only",
    track_token: "should-not-leak",
  };
  store.upsertQuote(quote);
  store.upsertAbandonedCheckout({
    session_id: "sess-qa",
    stage: "contact",
    customer: { first_name: "QA", last_name: "Probe", email: "qa+probe@biolabsresearch.co" },
    items: [{ sku: "G2-T", name: "G2-T", qty: 1, amount: "49.00" }],
    subtotal: "49.00",
    last_seen: "2026-09-22T10:00:00.000Z",
    first_seen: "2026-09-22T10:00:00.000Z",
  });
  store.upsertAbandonedCheckout({
    session_id: "sess-other-day",
    stage: "shipping",
    customer: { first_name: "Other", last_name: "Day", email: "other.day@university.edu" },
    items: [{ sku: "G3-R", name: "G3-R", qty: 1, amount: "10.00" }],
    subtotal: "10.00",
    last_seen: "2026-09-21T10:00:00.000Z",
  });
}

test("leads-digest: 401 without key, 200 with key, Soft-QA flagged, no track_token", async () => {
  await withEnv("MARKETING_DIGEST_KEY", KEY, async () => {
    const store = createStore({ memoryOnly: true });
    seedDay(store);
    await withServer({ store }, async (port) => {
      const missing = await fetch(`http://127.0.0.1:${port}/api/checkout/leads-digest?day=2026-09-22`);
      assert.equal(missing.status, 401);
      assert.equal((await missing.json()).error, "unauthorized");

      const wrong = await fetch(`http://127.0.0.1:${port}/api/checkout/leads-digest?day=2026-09-22`, {
        headers: { "X-Marketing-Key": "nope" },
      });
      assert.equal(wrong.status, 401);

      const ok = await fetch(`http://127.0.0.1:${port}/api/checkout/leads-digest?day=2026-09-22`, {
        headers: { "X-Marketing-Key": KEY },
      });
      assert.equal(ok.status, 200);
      const body = await ok.json();
      assert.equal(body.ok, true);
      assert.equal(body.day, "2026-09-22");
      assert.equal(body.timezone, "Asia/Jerusalem");
      assert.equal(body.counts.total, 2);
      assert.equal(body.counts.real, 1);
      assert.equal(body.counts.soft_qa, 1);
      const dumped = JSON.stringify(body);
      assert.equal(dumped.includes("track_token"), false);
      assert.equal(dumped.includes("SECRETCLICK"), false);
      assert.equal(dumped.includes("should-not-leak"), false);
      const quote = body.rows.find((r) => r.form_page === "checkout_quote");
      assert.equal(quote.email, "ada.nguyen@university.edu");
      assert.equal(quote.quote_number, "QT-9001");
      assert.equal(quote.crm_status, "Not Contacted");
      assert.equal(quote.soft_qa, false);
      assert.equal(quote.attribution.utm_source, "google");
      assert.equal(quote.attribution.gclid, "[present]");
      const qa = body.rows.find((r) => r.form_page === "checkout_abandon:contact");
      assert.equal(qa.soft_qa, true);
      assert.equal(qa.email, "qa+probe@biolabsresearch.co");
    });
  });
});

test("leads-digest rejects a bad day and stays unauthorized when the env key is unset", async () => {
  await withEnv("MARKETING_DIGEST_KEY", undefined, async () => {
    const store = createStore({ memoryOnly: true });
    await withServer({ store }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/checkout/leads-digest`, {
        headers: { "X-Marketing-Key": KEY },
      });
      assert.equal(res.status, 401);
    });
  });
  await withEnv("MARKETING_DIGEST_KEY", KEY, async () => {
    const store = createStore({ memoryOnly: true });
    await withServer({ store }, async (port) => {
      const res = await fetch(`http://127.0.0.1:${port}/api/checkout/leads-digest?day=2026-13-40`, {
        headers: { "X-Marketing-Key": KEY },
      });
      assert.equal(res.status, 400);
      assert.equal((await res.json()).error, "invalid_day");
    });
  });
});

test("operator reads and settings writes are 401 without auth and open with key or CRM session", async () => {
  await withEnv("MARKETING_DIGEST_KEY", KEY, async () => {
    const store = createStore({ memoryOnly: true });
    await withServer({
      store,
      checkCrmSession: async (token) => token === "good-session",
    }, async (port) => {
      const abandon = await fetch(`http://127.0.0.1:${port}/api/checkout/abandon`);
      assert.equal(abandon.status, 401);

      const orders = await fetch(`http://127.0.0.1:${port}/api/store-orders`);
      assert.equal(orders.status, 401);

      const put = await fetch(`http://127.0.0.1:${port}/api/psp/settings`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: { killSwitchPsp: "umg" } }),
      });
      assert.equal(put.status, 401);
      assert.equal(store.getSettings().killSwitchPsp, null);

      const dry = await fetch(`http://127.0.0.1:${port}/api/psp/dry-run`, { method: "POST" });
      assert.equal(dry.status, 401);
      const poll = await fetch(`http://127.0.0.1:${port}/api/store-orders/poll`, { method: "POST" });
      assert.equal(poll.status, 401);

      const withKey = await fetch(`http://127.0.0.1:${port}/api/checkout/abandon`, {
        headers: { "X-Marketing-Key": KEY },
      });
      assert.equal(withKey.status, 200);
      assert.ok(Array.isArray((await withKey.json()).abandoned_checkouts));

      const withSession = await fetch(`http://127.0.0.1:${port}/api/store-orders`, {
        headers: { Authorization: "Bearer good-session" },
      });
      assert.equal(withSession.status, 200);

      const badSession = await fetch(`http://127.0.0.1:${port}/api/psp/settings`, {
        headers: { Authorization: "Bearer stolen", "X-CRM-Role": "admin" },
      });
      assert.equal(badSession.status, 401);

      const saved = await fetch(`http://127.0.0.1:${port}/api/psp/settings`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer good-session",
        },
        body: JSON.stringify({
          settings: {
            processors: [
              { id: "umg", enabled: true, priority: 1, mode: "sandbox" },
              { id: "tagada", enabled: false, priority: 2, mode: "off" },
              { id: "centrobill", enabled: false, priority: 3, mode: "off" },
            ],
          },
        }),
      });
      assert.equal(saved.status, 200);
    });
  });
});

test("storefront OPTIONS and POST abandon+quote still succeed from biolabsresearch.co; payments stay off", async () => {
  assert.equal(isPaymentsEnabled({}), false);
  await withEnv("PAYMENTS_ENABLED", undefined, async () => {
    const store = createStore({ memoryOnly: true });
    await withServer({ store, sendQuoteEmail: async () => {} }, async (port) => {
      const optAbandon = await fetch(`http://127.0.0.1:${port}/api/checkout/abandon`, {
        method: "OPTIONS",
        headers: {
          Origin: "https://biolabsresearch.co",
          "Access-Control-Request-Method": "POST",
          "Access-Control-Request-Headers": "content-type",
        },
      });
      assert.equal(optAbandon.status, 204);
      assert.equal(optAbandon.headers.get("access-control-allow-origin"), "https://biolabsresearch.co");
      assert.notEqual(optAbandon.headers.get("access-control-allow-origin"), "*");

      const optQuote = await fetch(`http://127.0.0.1:${port}/api/checkout/quote`, {
        method: "OPTIONS",
        headers: { Origin: "https://biolabsresearch.co" },
      });
      assert.equal(optQuote.status, 204);
      assert.equal(optQuote.headers.get("access-control-allow-origin"), "https://biolabsresearch.co");

      const abandon = await fetch(`http://127.0.0.1:${port}/api/checkout/abandon`, {
        method: "POST",
        headers: {
          Origin: "https://biolabsresearch.co",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          session_id: "storefront-1",
          stage: "contact",
          customer: { first_name: "Ada", last_name: "Nguyen", email: "ada.nguyen@university.edu" },
          items: [{ sku: "G1-S", name: "G1-S", qty: 1, amount: "20.00" }],
          subtotal: "20.00",
        }),
      });
      assert.equal(abandon.status, 204);
      assert.equal(abandon.headers.get("access-control-allow-origin"), "https://biolabsresearch.co");

      const quote = await fetch(`http://127.0.0.1:${port}/api/checkout/quote`, {
        method: "POST",
        headers: {
          Origin: "https://biolabsresearch.co",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(QUOTE),
      });
      assert.equal(quote.status, 200);
      assert.equal(quote.headers.get("access-control-allow-origin"), "https://biolabsresearch.co");
      assert.equal((await quote.json()).ok, true);

      const charge = await fetch(`http://127.0.0.1:${port}/api/checkout/charge`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://biolabsresearch.co" },
        body: JSON.stringify({ amount: "10.00" }),
      });
      assert.equal(charge.status, 503);
      assert.equal((await charge.json()).error, "payments_disabled");

      const digestCors = await fetch(`http://127.0.0.1:${port}/api/checkout/leads-digest`, {
        method: "OPTIONS",
        headers: { Origin: "https://biolabsresearch.co" },
      });
      assert.equal(digestCors.headers.get("access-control-allow-origin"), null);

      const missingNotify = await fetch(`http://127.0.0.1:${port}/api/notify-order`, { method: "POST" });
      assert.equal(missingNotify.status, 404);
    });
  });
});

test("sanitizeAttribution is the named export live quote.js and abandon.js import", () => {
  assert.equal(publicAttribution, sanitizeAttribution);
  const out = sanitizeAttribution({
    utm_source: "google",
    utm_medium: "cpc",
    landing: "/checkout",
    pages_before_submit: ["/", "/checkout"],
    gclid: "EAIaIQobChMI-secret-click",
    fbclid: "",
    track_token: "should-not-leak",
  });
  assert.equal(out.utm_source, "google");
  assert.equal(out.utm_medium, "cpc");
  assert.equal(out.landing, "/checkout");
  assert.deepEqual(out.pages_before_submit, ["/", "/checkout"]);
  assert.equal(out.gclid, "[present]");
  assert.equal("fbclid" in out, false);
  assert.equal("track_token" in out, false);
  assert.equal(JSON.stringify(out).includes("EAIa"), false);
});

test("digest day boundary uses Asia/Jerusalem and scoreLead flags disposable mail", () => {
  const store = createStore({ memoryOnly: true });
  store.upsertQuote({
    id: "QT-1",
    createdAt: "2026-09-22T21:30:00.000Z",
    amount: "10.00",
    crmStatus: "Not Contacted",
    customer: { email: "night@university.edu", first_name: "Night", last_name: "Owl" },
    items: [{ sku: "G1-S", name: "G1-S", qty: 1, amount: "10.00" }],
  });
  const before = buildLeadsDigest(store, { day: "2026-09-22" });
  const after = buildLeadsDigest(store, { day: "2026-09-23" });
  assert.equal(before.counts.total, 0);
  assert.equal(after.counts.total, 1);
  assert.equal(jerusalemDay(new Date("2026-09-22T21:30:00.000Z")), "2026-09-23");
  const junk = scoreLead({ email: "zxcvbnm@mailinator.com", firstName: "A", lastName: "B" });
  assert.equal(junk.disposable, true);
  assert.equal(junk.soft_qa, true);
  assert.equal(secretsEqual("abc", "abc"), true);
  assert.equal(secretsEqual("abc", "abd"), false);
  assert.equal(sessionBodyOk({ user: { email: "a@b.co", role: "admin" } }), true);
  assert.equal(sessionBodyOk({ ok: true }), false);
});
