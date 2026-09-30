'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ci = require('../../card-import.cjs');
const f = require('./fixtures.cjs');

const ctx = { slugs: ci.slugList(f.CATALOG), sanitizeOrder: f.fakeSanitize, priceCheck: f.fakePriceCheck,
  discountFields: f.fakeDiscountFields, isExcludedAddress: f.fakeExcluded };
const withEmail = (maker, email) => maker({ customer: Object.assign(maker().customer, { email }) });

test('parseSource refuses anything but the sidecar store shape', () => {
  assert.equal(ci.parseSource('{').ok, false);
  assert.equal(ci.parseSource('[]').ok, false);
  assert.deepEqual(ci.parseSource('{"orders":[]}'), { ok: false, reason: 'source has no orders/quotes arrays' });
  const ok = ci.parseSource(f.storeText([f.card()], []));
  assert.equal(ok.ok, true); assert.equal(ok.orders.length, 1); assert.equal(ok.quotes.length, 0);
});

test('recordProblem names the first missing field', () => {
  assert.equal(ci.recordProblem(f.card(), 'card'), '');
  assert.equal(ci.recordProblem(f.quote(), 'quote'), '');
  assert.equal(ci.recordProblem(f.card({ id: 'X-1' }), 'card'), 'bad id');
  assert.equal(ci.recordProblem(f.quote({ id: 'BLR-1' }), 'quote'), 'bad id');
  assert.equal(ci.recordProblem(f.card({ attempts: undefined }), 'card'), 'bad attempts');
  assert.equal(ci.recordProblem(f.card({ items: [] }), 'card'), 'bad items');
  assert.equal(ci.recordProblem(f.card({ items: [{ sku: 'bpc-157-10mg', name: 'B', qty: 0, amount: '1' }] }), 'card'), 'bad item qty');
  assert.equal(ci.recordProblem(f.card({ amount: 'x' }), 'card'), 'bad amount');
  assert.equal(ci.recordProblem(f.card({ updatedAt: 'soon' }), 'card'), 'bad updatedAt');
  assert.equal(ci.recordProblem(f.card({ customer: null }), 'card'), 'bad customer');
});

test('splitSku takes the longest catalog slug', () => {
  assert.deepEqual(ci.splitSku('bpc-157-tb-500-blend-20mg', ctx.slugs), { slug: 'bpc-157-tb-500-blend', mg: '20mg' });
  assert.deepEqual(ci.splitSku('bpc-157-10mg', ctx.slugs), { slug: 'bpc-157', mg: '10mg' });
  assert.equal(ci.splitSku('DRY-RUN', ctx.slugs), null);
  // The shop sends a bare slug (no dosage) when a cart line has no mg tier (checkout-charge.js:94-97) — a real match.
  assert.deepEqual(ci.splitSku('bpc-157', ctx.slugs), { slug: 'bpc-157', mg: '' });
});

test('couponFromNotes reads "coupon:CODE" only', () => {
  assert.equal(ci.couponFromNotes('coupon:insider25'), 'INSIDER25');
  assert.equal(ci.couponFromNotes('paid; coupon:INSIDER25'), 'INSIDER25');
  assert.equal(ci.couponFromNotes('Funnel check Sep 19 - not a real order'), '');
  assert.equal(ci.couponFromNotes(undefined), '');
});

test('isTestRecord: only a live payment from a real address is real', () => {
  const t = (rec, kind) => ci.isTestRecord(rec, kind || 'card', f.fakeExcluded);
  assert.equal(t(f.card()), false);
  assert.equal(t(f.card({ attempts: [f.attempt({ mode: 'sandbox' })] })), true);
  assert.equal(t(f.card({ attempts: [f.attempt({ processorStatus: 'DECLINED' })] })), true);
  assert.equal(t(f.card({ items: [{ sku: 'DRY-RUN', name: 'CRM dry-run', qty: 1, amount: '20.00' }] })), true);
  assert.equal(t(f.card({ idempotencyKey: 'DRY-17' })), true);
  assert.equal(t(withEmail(f.card, 'qa+k299@biolabsresearch.co')), true);
  assert.equal(t(withEmail(f.card, 'x@blrcommerce.io')), true);
  assert.equal(t(withEmail(f.card, 'a@example.com')), true);
  assert.equal(t(f.quote(), 'quote'), false);
  assert.equal(t(withEmail(f.quote, ''), 'quote'), true);
  // A live approval that comes back as CAPTURED, PAID or SUCCESS (not the literal string "approved") is still real.
  assert.equal(t(f.card({ attempts: [f.attempt({ processorStatus: 'CAPTURED' })] })), false);
  assert.equal(t(f.card({ attempts: [f.attempt({ processorStatus: 'UNKNOWN', cascadeAction: 'success' })] })), false);
  // R3 (owner, 28.09): a live card charge with no email at all is still real money — the address rule (which would
  // otherwise call it a test, since isExcludedAddress treats anything without '@' as excluded) does not apply to it.
  assert.equal(t(withEmail(f.card, '')), false);
  assert.equal(t(withEmail(f.card, 'not-an-email')), false);
  // Every other test rule still applies to a live-no-email record.
  assert.equal(t(Object.assign(withEmail(f.card, ''), { attempts: [f.attempt({ mode: 'sandbox' })] })), true);
  assert.equal(t(Object.assign(withEmail(f.card, ''), { idempotencyKey: 'DRY-9' })), true);
  // A price request with no email is still a test — only kind === 'card' is exempted.
  assert.equal(t(withEmail(f.quote, ''), 'quote'), true);
  // '@' present but with nothing before it is not "no '@' at all" — the ordinary address rule still applies.
  assert.equal(t(withEmail(f.card, '@realmail.net')), true);
});

test('approvalOf recognizes CAPTURED, PAID, SUCCESS and cascadeAction "success" — same set as the payment module', () => {
  assert.equal(ci.approvalOf(f.card({ attempts: [f.attempt({ processorStatus: 'CAPTURED' })] })).processorStatus, 'CAPTURED');
  assert.equal(ci.approvalOf(f.card({ attempts: [f.attempt({ processorStatus: 'PAID' })] })).processorStatus, 'PAID');
  assert.equal(ci.approvalOf(f.card({ attempts: [f.attempt({ processorStatus: 'SUCCESS' })] })).processorStatus, 'SUCCESS');
  assert.equal(ci.approvalOf(f.card({ attempts: [f.attempt({ processorStatus: 'WAITING', cascadeAction: 'success' })] })).cascadeAction, 'success');
  assert.equal(ci.approvalOf(f.card({ attempts: [f.attempt({ processorStatus: 'DECLINED' })] })), null);
});

test('approvalOf skips a doublePaid attempt: the CRM payment is the first, real approval (a second Cleffo payment is a refund case)', () => {
  const first = f.attempt({ processor: 'cleffo', processorStatus: 'PAID', processorTxnId: 'REF1', finishedAt: '2026-09-28T10:00:02.000Z' });
  const second = f.attempt({ processor: 'cleffo', processorStatus: 'PAID', processorTxnId: 'REF2', doublePaid: true, finishedAt: '2026-09-29T09:00:00.000Z' });
  const rec = f.card({ attempts: [first, second] });
  assert.equal(ci.approvalOf(rec).processorTxnId, 'REF1');
  const o = ci.buildOrder(rec, 'card', ctx);
  assert.equal(o.payments.length, 1);
  assert.equal(o.payments[0].at, '2026-09-28T10:00:02.000Z');
  assert.match(o.payments[0].note, /REF1/);
  assert.doesNotMatch(o.payments[0].note, /REF2/);
  // only a doublePaid PAID attempt = no approval at all
  assert.equal(ci.approvalOf(f.card({ attempts: [second] })), null);
});

test('buildOrder: an approved card payment becomes a paid CRM order with one payment', () => {
  const o = ci.buildOrder(f.card(), 'card', ctx);
  assert.equal(o.ref, 'BLR-2001');
  assert.equal(o.paymentMethod, 'card');
  assert.equal(o.status, 'paid');
  assert.equal(o.source, 'card'); assert.equal(o.source_ref, 'BLR-2001');
  assert.equal(o.source_updated_at, '2026-09-28T10:00:02.000Z');
  assert.equal(o.test, undefined);
  assert.deepEqual(o.customer, { firstName: 'Ann', lastName: 'Lee', email: 'ann.lee@realmail.net', phone: '+15550100' });
  assert.deepEqual(o.shipping, { address1: '1 Main St', city: 'LA', state: 'CA', zip: '90001', country: 'US' });
  assert.deepEqual(o.items, [{ name: 'BPC-157', slug: 'bpc-157', mg: '10mg', qty: 2, price: 79 }]);
  assert.deepEqual(o.payments, [{ id: 'card:BLR-2001', at: '2026-09-28T10:00:02.000Z', kind: 'payment', method: 'card',
    amount: 158, note: 'umg TX123 ····4242', by: 'card-import' }]);
  assert.deepEqual(o.charge_check, { charged: '158.00', expected: '158.00', diff: '0.00', result: 'match' });
  assert.equal(o.total_due_server, '158.00');
});

test('buildOrder: a price request becomes an unpaid order', () => {
  const o = ci.buildOrder(f.quote(), 'quote', ctx);
  assert.equal(o.paymentMethod, 'quote-request');
  assert.equal(o.status, 'new');
  assert.equal(o.payments, undefined);
  assert.equal(o.charge_check, undefined);
  assert.equal(o.total_due_server, '125.00');
});

test('charge check: under, over and unknown', () => {
  const under = ci.buildOrder(f.card({ amount: '100.00' }), 'card', ctx);
  assert.equal(under.charge_check.result, 'under'); assert.equal(under.charge_check.diff, '58.00');
  // Coupon noted but charged in full: the customer paid 39.50 too much.
  const over = ci.buildOrder(f.card({ notes: 'coupon:INSIDER25' }), 'card', ctx);
  assert.deepEqual(over.charge_check, { charged: '158.00', expected: '118.50', diff: '39.50', result: 'over' });
  const unknown = ci.buildOrder(f.card({ items: [{ sku: 'nad-plus-500mg', name: 'NAD+', qty: 1, amount: '60.00' }], amount: '60.00' }), 'card', ctx);
  assert.deepEqual(unknown.charge_check, { charged: '60.00', expected: null, diff: null, result: 'unknown' });
  assert.equal(unknown.total_due_server, '60.00');
});

test('buildOrder returns null when the catalog check was skipped', () => {
  const skipped = Object.assign({}, ctx, { priceCheck: () => ({ price_check: 'skipped' }) });
  assert.equal(ci.buildOrder(f.card(), 'card', skipped), null);
});

test('buildOrder: a CAPTURED live approval is a real payment, note carries processor and last4', () => {
  const rec = f.card({ attempts: [f.attempt({ processorStatus: 'CAPTURED' })] });
  const o = ci.buildOrder(rec, 'card', ctx);
  assert.equal(o.test, undefined);
  assert.equal(o.payments[0].note, 'umg TX123 ····4242');
});

test('buildOrder: an unresolved sku is "unknown" even when priceCheck (matching by name) sees no problem', () => {
  // The real priceCheck can find an item by name and price it at the base rate even without a matching slug
  // (products-api.cjs:456, :374-375) — buildOrder must not trust its silence here.
  const byName = Object.assign({}, ctx, {
    priceCheck: () => ({ subtotal_server: '79.00', total_server: '79.00', price_mismatch: false })
  });
  const rec = f.card({ items: [{ sku: 'zzz-mystery-10mg', name: 'BPC-157', qty: 1, amount: '79.00' }], amount: '79.00' });
  const o = ci.buildOrder(rec, 'card', byName);
  assert.equal(o.items[0].slug, '');
  assert.deepEqual(o.charge_check, { charged: '79.00', expected: null, diff: null, result: 'unknown' });
  assert.equal(o.total_due_server, '79.00');
});

test('mergeInto: new on top, repeat is a no-op, update touches payment facts only, foreign ref is reported', () => {
  const existing = [{ ref: 'BF-1', status: 'new' }];
  const a = ci.buildOrder(f.card(), 'card', ctx);
  const first = ci.mergeInto(existing, [{ order: a, kind: 'card' }]);
  assert.deepEqual(first.next.map(o => o.ref), ['BLR-2001', 'BF-1']);
  assert.equal(first.created.length, 1);
  const again = ci.mergeInto(first.next, [{ order: ci.buildOrder(f.card(), 'card', ctx), kind: 'card' }]);
  assert.equal(again.created.length + again.updated.length, 0);
  // The team shipped it and left a note; then the payment module touched the record.
  const edited = first.next.map(o => o.ref === 'BLR-2001' ? Object.assign({}, o, { status: 'shipped', managerNote: 'sent' }) : o);
  const later = ci.buildOrder(f.card({ updatedAt: '2026-09-29T09:00:00.000Z', amount: '160.00' }), 'card', ctx);
  const upd = ci.mergeInto(edited, [{ order: later, kind: 'card' }]);
  assert.equal(upd.updated.length, 1);
  const row = upd.next.find(o => o.ref === 'BLR-2001');
  assert.equal(row.status, 'shipped'); assert.equal(row.managerNote, 'sent');
  assert.equal(row.payments.length, 1); assert.equal(row.payments[0].amount, 160);
  assert.equal(row.source_updated_at, '2026-09-29T09:00:00.000Z');
  // F4: a ref held by an order this import never created (no source_ref at all) is "foreign" — history, not an error.
  const taken = ci.mergeInto([{ ref: 'BLR-2001', status: 'new' }], [{ order: a, kind: 'card' }]);
  assert.deepEqual(taken.taken, [{ ref: 'BLR-2001', reason: 'foreign' }]); assert.equal(taken.created.length, 0);
});

test('mergeInto: a ref removed from orders.json ("seen") is not recreated', () => {
  const a = ci.buildOrder(f.card(), 'card', ctx);
  const seen = new Set(['BLR-2001']); // this import created it before; CRM no longer has it
  const m = ci.mergeInto([], [{ order: a, kind: 'card' }], seen);
  assert.equal(m.created.length, 0);
  assert.deepEqual(m.deleted, ['BLR-2001']);
});

test('mergeInto: two records in one read claiming the same ref only create once', () => {
  const a = ci.buildOrder(f.card(), 'card', ctx);
  const b = ci.buildOrder(f.card(), 'card', ctx); // e.g. the same source record parsed twice on a corrupt read
  const m = ci.mergeInto([], [{ order: a, kind: 'card' }, { order: b, kind: 'card' }]);
  assert.equal(m.created.length, 1);
});

test('mergeInto: same ref but a different source record (seq restarted and reused it) is reported, not merged', () => {
  const a = ci.buildOrder(f.card(), 'card', ctx);
  const reused = ci.buildOrder(f.card({ createdAt: '2027-01-01T00:00:00.000Z', updatedAt: '2027-01-01T00:00:01.000Z' }), 'card', ctx);
  const r = ci.mergeInto([a], [{ order: reused, kind: 'card' }]);
  // F4: the import DID create this ref (cur.source_ref matches) but the identity under it changed — "changed", a
  // real problem, unlike the "foreign" case above.
  assert.deepEqual(r.taken, [{ ref: 'BLR-2001', reason: 'changed' }]);
  assert.equal(r.updated.length, 0);
  // Backward compatible: an order from before this field existed has no source_created_at, so it is not flagged.
  const oldFormat = Object.assign({}, a); delete oldFormat.source_created_at;
  const r2 = ci.mergeInto([oldFormat], [{ order: reused, kind: 'card' }]);
  assert.equal(r2.taken.length, 0);
});

test('F5 applyRefunds: a card refunded after import gets one refund payment, CRM status and notes untouched', () => {
  const a = ci.buildOrder(f.card(), 'card', ctx);
  const edited = Object.assign({}, a, { status: 'shipped', managerNote: 'sent' });
  const rec = f.card({ status: 'refunded', updatedAt: '2026-09-29T09:00:00.000Z' });
  const r = ci.applyRefunds([edited], [rec]);
  assert.equal(r.refunded.length, 1);
  assert.deepEqual(r.refunded[0], { ref: 'BLR-2001', status: 'refunded', amount: 158, test: false });
  const row = r.next.find(o => o.ref === 'BLR-2001');
  assert.equal(row.status, 'shipped'); assert.equal(row.managerNote, 'sent'); // execution status untouched
  assert.equal(row.payments.length, 2);
  assert.deepEqual(row.payments[1], { id: 'refund:BLR-2001', at: '2026-09-29T09:00:00.000Z', kind: 'refund',
    method: 'card', amount: 158, note: 'refunded', by: 'card-import' });
  assert.equal(row.source_updated_at, '2026-09-29T09:00:00.000Z');
  // chargeback reads the same way
  const b = ci.buildOrder(f.card({ id: 'BLR-2005' }), 'card', ctx);
  const r3 = ci.applyRefunds([b], [f.card({ id: 'BLR-2005', status: 'CHARGEBACK', updatedAt: '2026-09-29T10:00:00.000Z' })]);
  assert.equal(r3.refunded[0].status, 'chargeback');
});

test('F5 applyRefunds: repeating the same refunded record does not add a second refund payment', () => {
  const a = ci.buildOrder(f.card(), 'card', ctx);
  const rec = f.card({ status: 'refunded', updatedAt: '2026-09-29T09:00:00.000Z' });
  const once = ci.applyRefunds([a], [rec]);
  const twice = ci.applyRefunds(once.next, [rec]);
  assert.equal(twice.refunded.length, 0);
  assert.equal(twice.next.find(o => o.ref === 'BLR-2001').payments.length, 2);
});

test('F5 applyRefunds: a record refunded before this import ever approved it has no CRM order to find, nothing happens', () => {
  const rec = f.card({ id: 'BLR-9999', status: 'refunded' });
  const r = ci.applyRefunds([{ ref: 'BF-1', status: 'new' }], [rec]);
  assert.equal(r.refunded.length, 0);
  assert.deepEqual(r.next.map(o => o.ref), ['BF-1']);
});

test('F5 applyRefunds: a test order\'s refund is reported so a repeat still does not duplicate, but is marked test', () => {
  const a = ci.buildOrder(f.card({ attempts: [f.attempt({ mode: 'sandbox' })] }), 'card', ctx);
  assert.equal(a.test, true);
  const rec = f.card({ status: 'refunded', attempts: [f.attempt({ mode: 'sandbox' })] });
  const r = ci.applyRefunds([a], [rec]);
  assert.equal(r.refunded[0].test, true);
});

// R1: the sidecar's seq can restart and reuse a ref (store.js:59-78 on a corrupt/missing seq) — a new record under
// the same BLR-2001 with a different createdAt is not the record CRM's order was built from, so a refund on it must
// not touch Ann's real $158 payment. Same rule as mergeInto's sameSource: source_ref matches AND source_created_at
// matches (an order with no source_created_at, the pre-F1 format, is always treated as the same record).
test('R1 applyRefunds: a refund for a ref whose source record changed identity is not applied', () => {
  const ann = ci.buildOrder(f.card({ id: 'BLR-2001', amount: '158.00' }), 'card', ctx); // source_created_at 2026-09-28T10:00:00.000Z
  const zed = f.card({ id: 'BLR-2001', amount: '300.00', status: 'refunded', createdAt: '2026-09-29T08:00:00.000Z',
    updatedAt: '2026-09-29T08:00:05.000Z' });
  const r = ci.applyRefunds([ann], [zed]);
  assert.equal(r.refunded.length, 0);
  assert.deepEqual(r.mismatched, ['BLR-2001']);
  const row = r.next.find(o => o.ref === 'BLR-2001');
  assert.equal(row.payments.length, 1); // still only Ann's original card:158 payment, no refund:300 added
  assert.equal(row.payments[0].amount, 158);
});

test('R1 applyRefunds: an order with no source_created_at (old format) is still treated as the same record', () => {
  const a = ci.buildOrder(f.card(), 'card', ctx);
  delete a.source_created_at;
  const rec = f.card({ status: 'refunded', updatedAt: '2026-09-29T09:00:00.000Z' });
  const r = ci.applyRefunds([a], [rec]);
  assert.equal(r.refunded.length, 1);
  assert.deepEqual(r.mismatched, []);
});

test('tick off: nothing is read', () => {
  let reads = 0;
  const { deps } = f.deps({ mode: 'off', readSource: () => { reads++; return '{}'; } });
  ci.createCardImport(deps).tick();
  assert.equal(reads, 0);
});

test('tick dry: logs what it would do once, writes nothing, sends nothing', () => {
  const { deps, state } = f.deps({ mode: 'dry' });
  const imp = ci.createCardImport(deps);
  imp.tick(); imp.tick();
  assert.equal(state.writes, 0); assert.deepEqual(state.tracked, []);
  assert.equal(state.logs.filter(l => l.startsWith('[card-import] DRY would create')).length, 2);
});

test('tick on: writes once, events only for live records after the start date', () => {
  const sandbox = f.card({ id: 'BLR-2002', attempts: [f.attempt({ mode: 'sandbox' })] });
  const old = f.card({ id: 'BLR-1999', createdAt: '2026-09-20T10:00:00.000Z' });
  const { deps, state } = f.deps();
  state.source = f.storeText([f.card(), sandbox, old, f.card({ id: 'BLR-2003', status: 'declined' })], [f.quote()]);
  const imp = ci.createCardImport(deps);
  assert.deepEqual(imp.tick(), { created: 4, updated: 0 });
  assert.equal(state.writes, 1);
  assert.deepEqual(state.orders.map(o => o.ref).sort(), ['BLR-1999', 'BLR-2001', 'BLR-2002', 'QT-3001']);
  assert.equal(state.orders.find(o => o.ref === 'BLR-2002').test, true);
  assert.deepEqual(state.tracked.sort(), ['BLR-2001', 'QT-3001']);
  assert.deepEqual(imp.tick(), { created: 0, updated: 0 });
  assert.equal(state.writes, 1);
});

test('tick: an order deleted in CRM is not recreated and does not re-fire order_placed', () => {
  const { deps, state } = f.deps(); // default source: one card (BLR-2001) + one quote (QT-3001)
  const imp = ci.createCardImport(deps);
  assert.deepEqual(imp.tick(), { created: 2, updated: 0 });
  assert.deepEqual(state.tracked.sort(), ['BLR-2001', 'QT-3001']);
  state.orders = state.orders.filter(o => o.ref !== 'BLR-2001'); // the owner deletes the card order in CRM
  assert.deepEqual(imp.tick(), { created: 0, updated: 0 });
  assert.deepEqual(state.orders.map(o => o.ref), ['QT-3001']);
  assert.deepEqual(state.tracked.sort(), ['BLR-2001', 'QT-3001']); // unchanged: no repeat event
});

test('F5 tick: a webhook refund on an already-imported card writes one refund payment and one REFUND log line', () => {
  const { deps, state } = f.deps();
  const imp = ci.createCardImport(deps);
  assert.deepEqual(imp.tick(), { created: 2, updated: 0 });
  assert.equal(state.writes, 1);
  state.source = f.storeText([f.card({ status: 'refunded', updatedAt: '2026-09-29T09:00:00.000Z' })], [f.quote()]);
  assert.deepEqual(imp.tick(), { created: 0, updated: 0 });
  assert.equal(state.writes, 2);
  const row = state.orders.find(o => o.ref === 'BLR-2001');
  assert.equal(row.payments.length, 2);
  assert.equal(row.payments[1].kind, 'refund');
  assert.deepEqual(state.errors.filter(e => e.startsWith('[card-import] REFUND')),
    ['[card-import] REFUND BLR-2001 refunded amount=158.00']);
  // A repeat tick with the same still-refunded source record does not write again or log again.
  assert.deepEqual(imp.tick(), { created: 0, updated: 0 });
  assert.equal(state.writes, 2);
  assert.equal(state.errors.filter(e => e.startsWith('[card-import] REFUND')).length, 1);
});

// R2: a sandbox refund is CRM housekeeping (F5 applyRefunds already marks it test:true), not the owner's money —
// it must update the order silently, never reach logError (ops-watch/Telegram).
test('R2 tick: a webhook refund on an already-imported SANDBOX card writes one refund payment and no REFUND log line', () => {
  const rec = f.card({ id: 'BLR-2020', attempts: [f.attempt({ mode: 'sandbox' })] });
  const { deps, state } = f.deps();
  state.source = f.storeText([rec], []);
  const imp = ci.createCardImport(deps);
  assert.deepEqual(imp.tick(), { created: 1, updated: 0 });
  assert.equal(state.orders.find(o => o.ref === 'BLR-2020').test, true);
  state.source = f.storeText([Object.assign({}, rec, { status: 'refunded', updatedAt: '2026-09-29T09:00:00.000Z' })], []);
  assert.deepEqual(imp.tick(), { created: 0, updated: 0 });
  const row = state.orders.find(o => o.ref === 'BLR-2020');
  assert.equal(row.payments.length, 2);
  assert.equal(row.payments[1].kind, 'refund');
  assert.deepEqual(state.errors.filter(e => e.startsWith('[card-import] REFUND')), []);
  // A repeat tick on the same still-refunded sandbox record does not add a second refund payment.
  assert.deepEqual(imp.tick(), { created: 0, updated: 0 });
  assert.equal(state.orders.find(o => o.ref === 'BLR-2020').payments.length, 2);
});

// R1 tick: reproduces FINAL-fixes.md's repro-refund-wrong-source.txt — after Ann's card (BLR-2001, $158) is
// imported, the sidecar's seq restarts and BLR-2001 is reused by a different record (Zed, refunded $300). The
// refund must not land on Ann's order, and the alert fires exactly once for the process, not once per mismatch.
test('R1 tick: a refund for a ref whose source record changed identity is not applied, one ERROR line for the process', () => {
  const { deps, state } = f.deps(); // default source: Ann's card BLR-2001 $158 + a quote
  const imp = ci.createCardImport(deps);
  assert.deepEqual(imp.tick(), { created: 2, updated: 0 });
  const zed = f.card({ id: 'BLR-2001', amount: '300.00', status: 'refunded', createdAt: '2026-09-29T08:00:00.000Z',
    updatedAt: '2026-09-29T08:00:05.000Z' });
  state.source = f.storeText([zed], [f.quote()]);
  assert.deepEqual(imp.tick(), { created: 0, updated: 0 });
  const row = state.orders.find(o => o.ref === 'BLR-2001');
  assert.equal(row.payments.length, 1); // still only Ann's original card:158 payment, refund:300 not applied
  assert.equal(row.payments[0].amount, 158);
  assert.deepEqual(state.errors.filter(e => e.startsWith('[card-import] ERROR refund for a different record')),
    ['[card-import] ERROR refund for a different record, not applied: BLR-2001']);
  // A second, different ref hitting the same mismatch does not repeat the alert ("once per process", not per ref).
  state.orders.push({ ref: 'BLR-1999', source_ref: 'BLR-1999', source_created_at: '2026-09-20T10:00:00.000Z', payments: [] });
  const zed2 = f.card({ id: 'BLR-1999', amount: '400.00', status: 'refunded', createdAt: '2026-09-29T09:00:00.000Z' });
  state.source = f.storeText([zed, zed2], [f.quote()]);
  imp.tick();
  assert.equal(state.errors.filter(e => e.startsWith('[card-import] ERROR refund for a different record')).length, 1);
});

test('F4 tick: a ref already in CRM from before the import logs one INFO line, not an error, and does not repeat', () => {
  const { deps, state } = f.deps();
  state.orders = [{ ref: 'BLR-2001', status: 'new' }]; // e.g. QT-5021 from the old agents' bridge
  const imp = ci.createCardImport(deps);
  imp.tick(); imp.tick();
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.logs.filter(l => l.startsWith('[card-import] ref already in CRM')),
    ['[card-import] ref already in CRM from before the import, left as is: BLR-2001']);
  assert.equal(state.writes, 1); // the untouched foreign ref does not block the quote from importing
});

test('F1 tick: an unreadable seen-ref journal (not ENOENT) stops the tick — writes and sends nothing', () => {
  const { deps, state } = f.deps({ readSeen: () => { throw new Error('bad json'); } });
  const imp = ci.createCardImport(deps);
  const r = imp.tick();
  assert.deepEqual(r, { error: 'seen' });
  assert.equal(state.writes, 0);
  assert.deepEqual(state.tracked, []);
  assert.equal(state.orders.length, 0);
  assert.deepEqual(state.errors, ['[card-import] ERROR seen log unreadable: bad json']);
  imp.tick(); // same reason again: one line total, not two (problem() dedups by state, like the other guards)
  assert.deepEqual(state.errors, ['[card-import] ERROR seen log unreadable: bad json']);
});

test('F1 tick: a seen-ref journal that is not an array of strings stops the tick', () => {
  const { deps, state } = f.deps({ readSeen: () => [{ ref: 'BLR-2001' }] });
  const r = ci.createCardImport(deps).tick();
  assert.deepEqual(r, { error: 'seen' });
  assert.equal(state.writes, 0);
  assert.deepEqual(state.errors, ['[card-import] ERROR seen log unreadable: not an array of strings']);
});

test('F1 tick: a missing seen-ref journal (ENOENT) is still an empty journal, unchanged from before', () => {
  const { deps, state } = f.deps({ readSeen: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  const r = ci.createCardImport(deps).tick();
  assert.deepEqual(r, { created: 2, updated: 0 });
  assert.equal(state.writes, 1);
  assert.deepEqual(state.errors, []);
});

test('tick on: persists the seen-ref journal through optional deps.readSeen/writeSeen (survives a restart)', () => {
  let seenFile = [];
  const { deps, state } = f.deps({ readSeen: () => seenFile.slice(), writeSeen: (list) => { seenFile = list.slice(); } });
  ci.createCardImport(deps).tick();
  assert.deepEqual(seenFile.sort(), ['BLR-2001', 'QT-3001']);
  state.orders = state.orders.filter(o => o.ref !== 'BLR-2001');
  // A fresh createCardImport() call has no in-process memory of what it created before — like after a pm2 restart.
  assert.deepEqual(ci.createCardImport(deps).tick(), { created: 0, updated: 0 });
});

test('tick: an "approved" record with no approving attempt is logged, not silently treated as an ordinary test', () => {
  const { deps, state } = f.deps();
  state.source = f.storeText([f.card({ attempts: [f.attempt({ processorStatus: 'DECLINED', cascadeAction: 'stop' })] })], []);
  const imp = ci.createCardImport(deps);
  imp.tick(); imp.tick();
  assert.deepEqual(state.errors, ['[card-import] ERROR approved record with no approving attempt: BLR-2001']);
  assert.equal(state.orders[0].test, true);
});

// R3: a live card charge with no email imports as a real (non-test) order, logs one LIVE-NO-EMAIL line (once per
// ref), and fires no Customer.io event — there is no address to send one to.
test('R3 tick: a live card charge with no email is a real order, one LIVE-NO-EMAIL line, no Customer.io event', () => {
  const rec = withEmail(f.card, '');
  const { deps, state } = f.deps();
  state.source = f.storeText([rec], []);
  const imp = ci.createCardImport(deps);
  imp.tick(); imp.tick();
  const order = state.orders.find(o => o.ref === 'BLR-2001');
  assert.equal(order.test, undefined); // real, not a test order
  assert.deepEqual(state.errors, ['[card-import] LIVE-NO-EMAIL BLR-2001 amount=158.00']);
  assert.deepEqual(state.tracked, []);
  assert.equal(state.logs.filter(l => l.startsWith('[card-import] event')).length, 0);
});

// C1: LIVE-NO-EMAIL only ever fires next to a real, on-mode order creation — never in dry, never for a record that
// is a test for some other reason, and never a second time for a ref the journal already knows about.
test('C1 tick dry: a live card charge with no email logs no LIVE-NO-EMAIL line', () => {
  const rec = withEmail(f.card, '');
  const { deps, state } = f.deps({ mode: 'dry' });
  state.source = f.storeText([rec], []);
  ci.createCardImport(deps).tick();
  assert.deepEqual(state.errors, []);
  assert.equal(state.logs.filter(l => l.startsWith('[card-import] DRY would create')).length, 1);
});

test('C1 tick: a live-approved record with no email that is still a test (DRY- probe) logs no LIVE-NO-EMAIL line', () => {
  const rec = Object.assign(withEmail(f.card, ''), { idempotencyKey: 'DRY-9' });
  const { deps, state } = f.deps();
  state.source = f.storeText([rec], []);
  ci.createCardImport(deps).tick();
  assert.equal(state.orders.find(o => o.ref === 'BLR-2001').test, true);
  assert.deepEqual(state.errors, []);
});

test('C1 tick: a second tick, and a fresh process sharing the same seen-ref journal, log no further LIVE-NO-EMAIL line', () => {
  const rec = withEmail(f.card, '');
  let seenFile = [];
  const { deps, state } = f.deps({ readSeen: () => seenFile.slice(), writeSeen: (list) => { seenFile = list.slice(); } });
  state.source = f.storeText([rec], []);
  const imp1 = ci.createCardImport(deps);
  imp1.tick(); // creates the order, one LIVE-NO-EMAIL line
  imp1.tick(); // same process, ref already in orders.json: no new line
  assert.deepEqual(state.errors, ['[card-import] LIVE-NO-EMAIL BLR-2001 amount=158.00']);
  state.errors.length = 0;
  // The order.json check alone would already suppress a re-create here (same as the "deleted in CRM" test), so
  // remove it too: only the seen-ref journal (persisted in seenFile, read fresh by the new process) can still be
  // protecting against a second LIVE-NO-EMAIL line after a restart that also lost the CRM-side record.
  state.orders = state.orders.filter(o => o.ref !== 'BLR-2001');
  const imp2 = ci.createCardImport(deps); // a fresh process (e.g. after a pm2 restart), same journal file
  imp2.tick();
  assert.deepEqual(state.errors, []);
  assert.deepEqual(state.orders.map(o => o.ref), []); // journal alone kept it from being recreated
});

test('tick: a source parse error is reported only after two consecutive failures (source.json is not written atomically)', () => {
  const { deps, state } = f.deps();
  state.source = '{"orders": 1}'; // e.g. a read that landed mid-write
  const imp = ci.createCardImport(deps);
  imp.tick();
  assert.deepEqual(state.errors, []); // a single blip stays quiet
  state.source = f.storeText([], []);
  imp.tick();
  assert.deepEqual(state.errors, []); // recovered before the second read: never escalated, no "ok again" either
  state.source = '{"orders": 1}';
  imp.tick(); imp.tick();
  assert.deepEqual(state.errors, ['[card-import] ERROR source has no orders/quotes arrays']);
});

test('run: an uncaught exception inside tick is reported once per state change, not once per tick', async () => {
  const { deps, state } = f.deps({ intervalMs: 20, readProducts: () => { throw new Error('catalog api down'); } });
  const imp = ci.createCardImport(deps);
  imp.start();
  await new Promise(r => setTimeout(r, 150));
  imp.stop();
  assert.deepEqual(state.errors, ['[card-import] ERROR tick failed: catalog api down']);
});

test('tick: a live mismatch raises one MISMATCH line, a test one does not', () => {
  const { deps, state } = f.deps();
  state.source = f.storeText([
    f.card({ notes: 'coupon:INSIDER25' }),
    f.card({ id: 'BLR-2002', notes: 'coupon:INSIDER25', attempts: [f.attempt({ mode: 'sandbox' })] })
  ], []);
  ci.createCardImport(deps).tick();
  assert.deepEqual(state.errors.filter(e => e.startsWith('[card-import] MISMATCH')),
    ['[card-import] MISMATCH BLR-2001 over charged=158.00 expected=118.50']);
});

test('tick: a broken source is reported once and recovery is logged', () => {
  const { deps, state } = f.deps();
  state.source = '{"orders": 1}';
  const imp = ci.createCardImport(deps);
  imp.tick(); imp.tick();
  assert.deepEqual(state.errors, ['[card-import] ERROR source has no orders/quotes arrays']);
  state.source = f.storeText([], []);
  imp.tick();
  assert.ok(state.logs.includes('[card-import] ok again (was: source has no orders/quotes arrays)'));
  assert.equal(state.writes, 0);
});

test('tick: an unreadable source file and an empty catalog write nothing', () => {
  const a = f.deps();
  a.state.source = Object.assign(new Error('gone'), { code: 'ENOENT' });
  ci.createCardImport(a.deps).tick();
  assert.deepEqual(a.state.errors, ['[card-import] ERROR source unreadable: ENOENT']);
  const b = f.deps({ readProducts: () => [] });
  ci.createCardImport(b.deps).tick();
  assert.equal(b.state.writes, 0);
  assert.deepEqual(b.state.errors, ['[card-import] ERROR catalog unavailable']);
});

test('tick: a malformed record is skipped with one line, the rest still import', () => {
  const { deps, state } = f.deps();
  state.source = f.storeText([f.card({ id: 'BLR-2009', items: [] }), f.card()], []);
  const imp = ci.createCardImport(deps);
  imp.tick(); imp.tick();
  assert.deepEqual(state.errors, ['[card-import] ERROR skipped record BLR-2009: bad items']);
  assert.deepEqual(state.orders.map(o => o.ref), ['BLR-2001']);
});

test('tick: a write failure is reported and nothing is sent', () => {
  const { deps, state } = f.deps({ writeOrders: () => { throw new Error('disk full'); } });
  ci.createCardImport(deps).tick();
  assert.deepEqual(state.errors, ['[card-import] ERROR orders.json write failed: disk full']);
  assert.deepEqual(state.tracked, []);
});

test('tick: events are off when the start date is missing', () => {
  const { deps, state } = f.deps({ eventsSince: '' });
  ci.createCardImport(deps).tick();
  assert.deepEqual(state.tracked, []);
  assert.ok(state.errors.some(e => e.includes('CARD_IMPORT_EVENTS_SINCE')));
});

test('unknown mode falls back to off with an error', () => {
  const { deps, state } = f.deps({ mode: 'yes' });
  const imp = ci.createCardImport(deps);
  assert.equal(imp.mode(), 'off');
  assert.ok(state.errors[0].includes('unknown CARD_IMPORT_MODE'));
});

test('start runs the first tick soon and keeps going; stop halts it', async () => {
  let reads = 0;
  const { deps } = f.deps({ intervalMs: 30, readSource: () => { reads++; return f.storeText([], []); } });
  const imp = ci.createCardImport(deps);
  imp.start();
  await new Promise(r => setTimeout(r, 120));
  imp.stop();
  const seen = reads;
  assert.ok(seen >= 2, 'ticks: ' + seen);
  await new Promise(r => setTimeout(r, 80));
  assert.equal(reads, seen);
});
