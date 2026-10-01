'use strict';
// What reads the flag this route writes. The readers are the REAL server files of this repo (or fresh live copies, see below), not copies: a trigger over a lead the route marked leaves it out (cio-routes.cjs), and the
// Insiders segment counts "subscribed" from the same flag (products-api.cjs profiles, marketing-segments.cjs built-in rule).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mount = require('../../account-unsubscribe.cjs');

// crm-app layout: this file is crm-api/tests/unsubscribe-sync/. CRM_API_DIR / PRODUCTS_API_FILE point at fresh live copies before a deploy.
const CRM = process.env.CRM_API_DIR || path.join(__dirname, '..', '..');
const PRODUCTS = process.env.PRODUCTS_API_FILE || path.join(__dirname, '..', '..', '..', 'products-api', 'products-api.cjs');
const SECRET = 'c'.repeat(40);

function stand(leads) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unsub-consumers-'));
  fs.writeFileSync(path.join(dir, 'leads.json'), JSON.stringify(leads));
  const routes = {};
  mount({ app: { post: (p, h) => { routes[p] = h; } }, DATA_DIR: dir, env: { ACCOUNT_CRM_SYNC_SECRET: SECRET } });
  const unsubscribe = email => {
    const res = { status() { return this; }, json(b) { this.b = b; return this; } };
    routes[mount.ROUTE]({ headers: { 'x-account-sync-secret': SECRET }, body: { email }, socket: { remoteAddress: '127.0.0.1' } }, res);
    return res.b;
  };
  return { dir, unsubscribe };
}
const L = (id, email, over) => Object.assign({ id, email, company: id, status: 'Not Contacted', unsubscribed: false }, over);

// cio-routes.cjs registers its routes on the app it is given; the trigger route with Customer.io not configured answers who WOULD get it.
function triggerRoute(dir) {
  const saved = {};
  for (const k of Object.keys(process.env)) if (/^(CIO_|CUSTOMERIO_)/.test(k)) { saved[k] = process.env[k]; delete process.env[k]; }
  const routes = {};
  const reg = m => (p, ...h) => { routes[m + ' ' + p] = h[h.length - 1]; };
  const app = { get: reg('GET'), post: reg('POST'), put: reg('PUT'), patch: reg('PATCH'), delete: reg('DELETE'), use() {} };
  require(path.join(CRM, 'cio-routes.cjs'))({ app, requireAuth: (q, s, n) => n(), requireAdmin: (q, s, n) => n(), DATA_DIR: dir });
  Object.assign(process.env, saved);
  const handler = routes['POST /api/cio/campaigns/:id/triggers'];
  assert.equal(typeof handler, 'function', 'the trigger route is still where this test expects it');
  return body => new Promise(resolve => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; } };
    handler({ params: { id: '7' }, body, headers: {} }, res);
  });
}

test('a campaign trigger over a lead the account marked unsubscribed leaves it out; the same trigger before did not', async () => {
  const s = stand([L('lead_a', 'sam@example.com'), L('lead_b', 'kim@example.com')]);
  const trigger = triggerRoute(s.dir);
  const before = await trigger({ emails: ['sam@example.com', 'kim@example.com'] });
  assert.equal(before.body.would_send, 2);
  assert.equal(before.body.excluded_unsubscribed, 0);
  assert.deepEqual(s.unsubscribe('Sam@example.com'), { ok: true, matched: 1, changed: 1 });
  const after = await trigger({ emails: ['sam@example.com', 'kim@example.com'] });
  assert.equal(after.body.would_send, 1);
  assert.equal(after.body.excluded_unsubscribed, 1);
  const alone = await trigger({ emails: ['sam@example.com'] });
  assert.equal(alone.code, 400);
  assert.equal(alone.body.error, 'all_recipients_unsubscribed');
});

test('the Insiders segment: "subscribed" in the profiles of products-api is the negation of the lead flag, and the built-in rule asks for subscribed = true', () => {
  const products = fs.readFileSync(PRODUCTS, 'utf8');
  const m = products.match(/^\s*attrs\.subscribed = (.+);\s*$/m);
  assert.ok(m, 'products-api.cjs computes attrs.subscribed on one line (the contract of this route)');
  const subscribed = new Function('rec', 'return ' + m[1] + ';');
  const segments = fs.readFileSync(path.join(CRM, 'marketing-segments.cjs'), 'utf8');
  assert.match(segments, /id: 'mseg_insiders'[\s\S]{0,300}rules: \[\{ field: 'subscribed', op: 'is', value: true \}\]/);

  const s = stand([L('lead_a', 'sam@example.com')]);
  const read = () => JSON.parse(fs.readFileSync(path.join(s.dir, 'leads.json'), 'utf8'))[0];
  assert.equal(subscribed({ lead: read() }), true);
  s.unsubscribe('sam@example.com');
  assert.equal(subscribed({ lead: read() }), false, 'out of Insiders at the next segment sync');
  assert.equal(subscribed({ lead: null }), false, 'no lead was already "not subscribed"');
});

test('the lead flag is the one the Leads page and the importer already use (leads-store.cjs: unsubscribed, a boolean)', () => {
  const store = fs.readFileSync(path.join(CRM, 'leads-store.cjs'), 'utf8');
  assert.match(store, /unsubscribed: !!partial\.unsubscribed/);
  assert.match(store, /key === 'unsubscribed' \|\| key === 'status_manual_override'\) next\[key\] = !!body\[key\]/);
  const lead = require(path.join(CRM, 'leads-store.cjs')).emptyLead({ company: 'x' });
  assert.equal(lead.unsubscribed, false);
});
