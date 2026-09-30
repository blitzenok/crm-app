'use strict';
// With the crypto part off (no CRYPTO_IMPORT_MODE at all, or off), the card and quote import behaves exactly as it did
// before the crypto part existed. test-ref/card-import.before-crypto.cjs is that earlier file, kept byte for byte
// (sha 24315404...); both run the same scenarios on the same inputs and everything they do or say must be equal.
// A crypto record sitting in the source must change nothing either.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const now = require('../../card-import.cjs');
const before = require('./test-ref/card-import.before-crypto.cjs');
const f = require('./fixtures.cjs');

test('the reference file is the card-import.cjs of commit 97e252a, unchanged', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'test-ref', 'card-import.before-crypto.cjs'))).digest('hex');
  assert.equal(sha, '24315404f105f87adbefa9a92ce8671c64d2b9fd34073e6ad9bc4a0f2d5b7cd8');
});

// One run: ticks in a row on a fresh fake world, the world after each tick and everything said.
function run(mod, over, source, ticks, between) {
  const { deps, state } = f.deps(over);
  const seen = { list: [] };
  deps.readSeen = () => JSON.parse(JSON.stringify(seen.list));
  deps.writeSeen = (l) => { seen.list = l.slice(); };
  state.source = source;
  const imp = mod.createCardImport(deps);
  const out = [];
  for (let i = 0; i < ticks; i++) {
    if (between) between(i, state);
    const r = imp.tick();
    out.push({ r, orders: JSON.parse(JSON.stringify(state.orders)), writes: state.writes, tracked: state.tracked.slice(),
      logs: state.logs.slice(), errors: state.errors.slice(), seen: seen.list.slice() });
  }
  imp.start && imp.stop();
  return { out, mode: imp.mode() };
}
const crypt = f.crypto();
const SRC = f.storeText([f.card(), f.card({ id: 'BLR-2002', attempts: [f.attempt({ mode: 'sandbox' })] }), f.card({ id: 'BLR-2003', status: 'declined' }), crypt], [f.quote()]);
const SCENARIOS = [
  ['on', { mode: 'on' }, SRC, 3],
  ['dry', { mode: 'dry' }, SRC, 3],
  ['off', { mode: 'off' }, SRC, 2],
  ['unknown mode', { mode: 'sure' }, SRC, 2],
  ['on, cryptoMode off spelled out', { mode: 'on', cryptoMode: 'off', cryptoSince: '2026-09-30T00:00:00.000Z' }, SRC, 2],
  ['source unreadable', { mode: 'on' }, '{', 3],
  ['empty source', { mode: 'on' }, f.storeText([], []), 2],
  ['crypto record only', { mode: 'on' }, f.storeText([crypt], []), 2]
];
for (const [name, over, src, ticks] of SCENARIOS) {
  test('crypto off: ' + name + ' - same results, orders, writes, events, log lines and seen journal as before', () => {
    const a = run(before, over, src, ticks);
    const b = run(now, over, src, ticks);
    assert.deepEqual(b, a);
  });
}

test('crypto off: a card refunded after the import, and a deleted order, behave as before', () => {
  const src1 = f.storeText([f.card()], []);
  const src2 = f.storeText([f.card({ status: 'refunded', updatedAt: '2026-09-28T12:00:00.000Z' })], []);
  const step = (i, st) => { if (i === 1) st.source = src2; if (i === 2) st.orders = []; };
  const a = run(before, { mode: 'on' }, src1, 4, step);
  const b = run(now, { mode: 'on' }, src1, 4, step);
  assert.deepEqual(b, a);
});

test('crypto off: a write that fails and a catalog that is down behave as before', () => {
  for (const over of [{ mode: 'on', readProducts: () => [] }, { mode: 'on', writeOrders: () => { throw new Error('disk full'); } }]) {
    assert.deepEqual(run(now, over, SRC, 2), run(before, over, SRC, 2));
  }
});
