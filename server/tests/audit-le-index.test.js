import { test } from "node:test";
import "./helpers/ship48-default-address.js"; // infra 2026-10-01 ship48 test data
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, connect } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "../lib/store.js";
import { createHandler, startCrmServer } from "../index.js";

// audit 2026-10-02, batch LE-module-index (low findings on server/index.js). Each test names the finding it pins.

const HERE = dirname(fileURLToPath(import.meta.url));
const GOOD = { Authorization: "Bearer good-session", "Content-Type": "application/json" };
const checkCrmSession = async (token) => (token === "good-session" ? { email: "staff@biolabsresearch.co", role: "staff" } : false);

function fakeRes() {
  return { statusCode: null, headers: null, body: "", writeHead(s, h) { this.statusCode = s; this.headers = h; }, end(b) { this.body = String(b || ""); } };
}

async function boot(deps = {}) {
  const store = createStore({ memoryOnly: true });
  const server = await startCrmServer(0, { store, checkCrmSession, ...deps });
  return { store, server, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// ---- #387 / #712: new URL() outside try ------------------------------------------------------------------------------------
test("#387/#712: an unparsable request target or Host header is answered 400, the handler never rejects", async () => {
  const handler = createHandler({ store: createStore({ memoryOnly: true }) });
  for (const [url, host] of [["//[", "localhost"], ["/api/health", "bad host"], ["http://[::1", "localhost"]]) {
    const res = fakeRes();
    await handler({ method: "GET", url, headers: { host }, on() {} }, res); // pre-fix: rejects with "Invalid URL" -> unhandledRejection kills the service
    assert.equal(res.statusCode, 400, `${url} / ${host}`);
    assert.equal(JSON.parse(res.body).error, "bad_request");
  }
});

test("#387/#712: over a real socket a broken request target gets 400 and the next request is still served", async () => {
  const t = await boot();
  try {
    const port = t.server.address().port;
    const raw = await new Promise((resolve, reject) => {
      const s = connect(port, "127.0.0.1", () => s.write("GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
      let out = "";
      s.on("data", (c) => { out += c; });
      s.on("end", () => resolve(out));
      s.on("error", reject);
    });
    assert.match(raw, /^HTTP\/1\.1 400 /);
    assert.equal((await fetch(`${t.base}/api/health`)).status, 200);
  } finally { await t.close(); }
});

// ---- #382 / #743 / #812: public health shows the path of the secret file ----------------------------------------------------
test("#382/#743/#812: /api/psp/health does not name the secret file path or its source; the operator view keeps the source only", async () => {
  const prev = process.env.UMG_ENV_PATH;
  process.env.UMG_ENV_PATH = "/srv/secret-dir/umg-fake.env";
  const t = await boot();
  try {
    const pub = await fetch(`${t.base}/api/psp/health`);
    const text = await pub.text();
    assert.equal(pub.status, 200);
    assert.doesNotMatch(text, /secret-dir|umg-fake|umgEnvPath/);
    const body = JSON.parse(text);
    assert.equal(body.ok, true);
    assert.equal(typeof body.umgSecretConfigured, "boolean"); // flag stays: the agents' screen and checks read it
    assert.ok("paymentsEnabled" in body && "mode" in body);
    assert.equal("source" in body, false);
    // /api/health is the same helper but is not routed by nginx to this service; covered by the loopback bind (#351)
    const staff = await (await fetch(`${t.base}/api/psp/settings`, { headers: GOOD })).json();
    assert.equal(staff.health.umgEnvPath, undefined); // secrets.js no longer reports the path at all (it is in docs/UMG_SIDECAR_DEPLOY.md and the unit file)
    assert.equal(typeof staff.health.source, "string"); // the staff view still says where the secret came from
  } finally {
    if (prev === undefined) delete process.env.UMG_ENV_PATH; else process.env.UMG_ENV_PATH = prev;
    await t.close();
  }
});

// ---- #384: tracking route read the order before awaiting the body ---------------------------------------------------------------
test("#384: a change written to the order while the tracking body is still arriving is not overwritten", async () => {
  const t = await boot();
  try {
    t.store.upsertOrder({ id: "BLR-9001", idempotencyKey: "TRK-1", paymentMethod: "card", status: "approved", amount: "20.00", currency: "USD", customer: { email: "trk@lab.example" }, attempts: [], items: [] });
    const payload = JSON.stringify({ carrier: "USPS", trackingNumber: "9400111899223197428490" });
    await new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port: t.server.address().port, method: "POST", path: "/api/fulfillment/BLR-9001/tracking", headers: { ...GOOD, "Content-Length": Buffer.byteLength(payload) } }, (res) => {
        res.resume();
        res.on("end", () => { assert.equal(res.statusCode, 200); resolve(); });
      });
      req.on("error", reject);
      req.write(payload.slice(0, 5)); // head of the body only: the handler is now waiting for the rest
      setTimeout(() => {
        const o = t.store.getOrder("BLR-9001");
        t.store.upsertOrder({ ...o, concurrentNote: "written-meanwhile" });
        req.end(payload.slice(5));
      }, 150);
    });
    const after = t.store.getOrder("BLR-9001");
    assert.equal(after.concurrentNote, "written-meanwhile");
    assert.equal(after.fulfillment.trackingNumber, "9400111899223197428490");
    assert.equal(after.fulfillment.status, "shipped");
  } finally { await t.close(); }
});

// ---- #383 / #816: dry-run on the key of a real order -------------------------------------------------------------------------------
test("#383/#816: dry-run refuses a key that belongs to a real order and leaves that order untouched", async () => {
  const t = await boot();
  try {
    t.store.upsertOrder({ id: "BLR-9100", idempotencyKey: "REAL-DECLINED", paymentMethod: "card", status: "declined", amount: "20.00", currency: "USD", customer: { email: "real@lab.example" }, attempts: [], items: [] });
    t.store.upsertOrder({ id: "BLR-9101", idempotencyKey: "REAL-APPROVED", paymentMethod: "card", status: "approved", amount: "20.00", currency: "USD", customer: { email: "real@lab.example" }, attempts: [], items: [] });
    for (const [key, id, status] of [["REAL-DECLINED", "BLR-9100", "declined"], ["REAL-APPROVED", "BLR-9101", "approved"]]) {
      const before = JSON.stringify(t.store.getOrder(id));
      const r = await fetch(`${t.base}/api/psp/dry-run`, { method: "POST", headers: GOOD, body: JSON.stringify({ idempotencyKey: key, scenario: "approved" }) });
      assert.equal(r.status, 409, key);
      assert.equal((await r.json()).error, "key_belongs_to_real_order");
      assert.equal(JSON.stringify(t.store.getOrder(id)), before, `${id} must be byte-identical`);
      assert.equal(t.store.getOrder(id).status, status);
      assert.equal(t.store.getOrder(id).dryRun, undefined);
    }
  } finally { await t.close(); }
});

test("#383/#816: dry-run with a fresh key still works and can be repeated under its own key", async () => {
  const t = await boot();
  try {
    const run = () => fetch(`${t.base}/api/psp/dry-run`, { method: "POST", headers: GOOD, body: JSON.stringify({ idempotencyKey: "DRY-LE-1", scenario: "approved" }) });
    const a = await run();
    assert.equal(a.status, 200);
    const order = t.store.getOrderByIdempotency("DRY-LE-1");
    assert.equal(order.dryRun, true);
    assert.equal((await run()).status, 200); // its own dry-run order: allowed
    assert.equal((await fetch(`${t.base}/api/psp/dry-run`, { method: "POST", headers: GOOD, body: JSON.stringify({ scenario: "approved" }) })).status, 200); // default DRY-<ts> key
  } finally { await t.close(); }
});

// ---- #351 and duplicates: listen on all interfaces ---------------------------------------------------------------------------------
function externalIPv4() {
  for (const list of Object.values(networkInterfaces())) for (const a of list || []) if (a.family === "IPv4" && !a.internal) return a.address;
  return null;
}
function freePort() {
  return new Promise((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
function canConnect(host, port) {
  return new Promise((resolve) => {
    const s = connect({ host, port, timeout: 1500 }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.on("timeout", () => { s.destroy(); resolve(false); });
  });
}

test("#351/#604/#641/#668/#713/#811: the service started as a program listens on 127.0.0.1 only", async (tt) => {
  const ext = externalIPv4();
  if (!ext) return tt.skip("no non-loopback IPv4 address on this machine: cannot tell 0.0.0.0 from 127.0.0.1");
  const dir = mkdtempSync(join(tmpdir(), "le-listen-"));
  const port = await freePort();
  const child = spawn(process.execPath, [join(HERE, "..", "index.js")], {
    env: { ...process.env, PORT: String(port), STORE_PATH: join(dir, "store.json"), PAYMENTS_ENABLED: "false", HUMAN_USE_ENABLED: "false", CRYPTO_VERIFY_ENABLED: "false", UMG_POLL_MS: "3600000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("service did not start")), 8000);
      child.stdout.on("data", (c) => { if (String(c).includes("listening")) { clearTimeout(to); resolve(); } });
      child.on("exit", (code) => { clearTimeout(to); reject(new Error(`service exited early (${code})`)); });
    });
    assert.equal(await canConnect("127.0.0.1", port), true, "loopback must work (nginx, ops-watch)");
    assert.equal(await canConnect(ext, port), false, `must not be reachable on ${ext}`);
  } finally {
    child.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});
