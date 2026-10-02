import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "../lib/store.js";

function capture(fn) {
  const lines = [];
  const orig = process.stdout.write;
  process.stdout.write = (s) => { lines.push(String(s)); return true; };
  try { return { result: fn(), lines }; } finally { process.stdout.write = orig; }
}

test("store.json: temp file + rename leaves no temp file, keeps the previous good version as store.json.prev", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "store.json");
  const s = createStore({ filePath: file });
  s.nextOrderId(); // seq 1001 -> file exists
  s.nextOrderId(); // seq 1002 -> prev holds 1001
  assert.equal(JSON.parse(readFileSync(file, "utf8")).seq, 1002);
  assert.equal(JSON.parse(readFileSync(`${file}.prev`, "utf8")).seq, 1001);
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
});

test("store.json unreadable at start: falls back to store.json.prev and says so; never starts empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "store.json");
  const s = createStore({ filePath: file });
  s.nextOrderId(); s.nextOrderId(); s.nextOrderId();
  writeFileSync(file, '{"seq": 10'); // torn write
  const { result, lines } = capture(() => createStore({ filePath: file }));
  assert.equal(result.nextOrderId(), "BLR-1003"); // prev had seq 1002
  assert.ok(lines.some((l) => l.startsWith("[pay-alert] STORE_FROM_PREV")));
});

test("store.json and store.json.prev both unreadable: refuses to start with [pay-alert] STORE_UNREADABLE", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "store.json");
  writeFileSync(file, "not json");
  const { lines } = capture(() => {
    assert.throws(() => createStore({ filePath: file }), /store_unreadable/);
  });
  assert.ok(lines.some((l) => l.startsWith("[pay-alert] STORE_UNREADABLE")));
  assert.equal(readFileSync(file, "utf8"), "not json"); // untouched
});

test("no store file at all = a fresh install (empty), no alert", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "sub", "store.json");
  const { result, lines } = capture(() => createStore({ filePath: file }));
  assert.equal(result.nextOrderId(), "BLR-1001");
  assert.equal(lines.length, 0);
  assert.ok(existsSync(file));
});

test("write keeps the permissions of the file it replaces; a first write is 0600 (audit 2026-10-02 sec-pay-22)", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "store.json");
  const s = createStore({ filePath: file });
  s.nextOrderId();
  assert.equal(statSync(file).mode & 0o777, 0o600);
  chmodSync(file, 0o640);
  s.nextOrderId();
  assert.equal(statSync(file).mode & 0o777, 0o640);
  s.nextOrderId();
  assert.equal(statSync(file).mode & 0o777, 0o640); // stays after the next replace too
});

test("start from store.json.prev keeps the broken file as store.json.corrupt-<ts> before the first write", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "store.json");
  const s = createStore({ filePath: file });
  s.nextOrderId(); s.nextOrderId();
  writeFileSync(file, '{"seq": 5');
  const { result } = capture(() => createStore({ filePath: file }));
  const kept = readdirSync(dir).filter((n) => n.startsWith("store.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0]), "utf8"), '{"seq": 5');
  result.nextOrderId();
  assert.equal(JSON.parse(readFileSync(file, "utf8")).seq, 1002);
  assert.equal(JSON.parse(readFileSync(`${file}.prev`, "utf8")).seq, 1001); // the good .prev is still the good one until then
});

test("leftover temp files of an earlier process are removed at start", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "store.json");
  createStore({ filePath: file }).nextOrderId();
  writeFileSync(join(dir, ".store.json.tmp-99999"), "half");
  createStore({ filePath: file });
  assert.deepEqual(readdirSync(dir).filter((n) => n.includes(".tmp-")), []);
});

test("after a start from .prev the first write takes its permissions from .prev (the broken main file is gone)", () => {
  const dir = mkdtempSync(join(tmpdir(), "store-atomic-"));
  const file = join(dir, "store.json");
  const s = createStore({ filePath: file });
  s.nextOrderId();
  chmodSync(file, 0o640);
  s.nextOrderId(); // .prev is the 0640 file
  writeFileSync(file, "{broken");
  const { result } = capture(() => createStore({ filePath: file }));
  result.nextOrderId();
  assert.equal(statSync(file).mode & 0o777, 0o640);
});
