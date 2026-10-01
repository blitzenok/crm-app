'use strict';
// One rule for the page and the server: the same addresses go through checkout-validate.js (the page, as found in
// fixtures/ or CHECKOUT_VALIDATE_JS) and through checkout-email.cjs, and the answers must agree.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../../checkout-email.cjs');

// crm-app has no storefront: fixtures/checkout-validate.cjs is a copy of the page's file (biolabsresearch-co repo, html/checkout-validate.js; .cjs because
// the root package.json says "type": "module");
// refresh it when the storefront changes the rule. CHECKOUT_VALIDATE_JS points at a fresh copy.
const PAGE_FILE = process.env.CHECKOUT_VALIDATE_JS || path.join(__dirname, 'fixtures', 'checkout-validate.cjs');
const page = (() => {   // a fresh copy given as .js is loaded through a .cjs copy for the same reason
  if (PAGE_FILE.endsWith('.cjs')) return require(PAGE_FILE);
  const tmp = path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'checkout-validate-')), 'checkout-validate.cjs');
  fs.copyFileSync(PAGE_FILE, tmp);
  return require(tmp);
})();

// Lists copied from the page's own test (tests/checkout-validate.test.cjs in the storefront repo) plus the cases below them.
const GOOD = ['you@lab.org', 'first.last+tag@sub.example.co.uk', 'a_b-c@x-y.io', 'blitzenok@proton.me',
  'a@münchen.de', 'a@例子.中国', 'a@xn--mnchen-3ya.de',
  'o\'brien@lab.org', 'a&b@lab.org', '1234@5678.org', 'A.B@LAB.ORG', ' you@lab.org ', 'x@a.b.c.d.ee', 'a@x.' + 'c'.repeat(24), 'a'.repeat(64) + '@x.com'];
const BAD = ['plain', 'a@b', 'a@b.c', 'a b@x.com', 'a@x .com', 'a@@x.com', 'a@x..com', '.a@x.com', 'a.@x.com',
  'a..b@x.com', 'a@-x.com', 'a@x-.com', 'a@x.com.', 'a@x_y.com', 'a@x!y.com', 'a@x.c0m', 'a@x,com',
  'a@' + 'x'.repeat(64) + '.com', 'a'.repeat(65) + '@x.com',
  '', '   ', '@x.com', 'a@', 'a@.com', 'a@x.c', 'a@x.' + 'c'.repeat(25), '<b>@x.co', 'a<b>@x.co', 'a@x.co<b>', 'a\u0001@x.co', 'a@x.co\u0000',
  '"a b"@x.com', 'a@[127.0.0.1]', 'a;b@x.co', 'a,b@x.co', 'a@b@c.com', 'mailto:a@x.com'];

test('addresses the page accepts are accepted here, addresses the page refuses are refused here', () => {
  for (const v of GOOD) assert.equal(E.problem(v), '', 'server refused a good address: ' + JSON.stringify(v));
  for (const v of BAD) assert.notEqual(E.problem(v), '', 'server took a bad address: ' + JSON.stringify(v));
  for (const v of GOOD) assert.equal(page.emailProblem(v), '', 'page refused a good address: ' + JSON.stringify(v));
  for (const v of BAD) assert.notEqual(page.emailProblem(v), '', 'page took a bad address: ' + JSON.stringify(v));
});

test('parity on a generated list: same verdict and same message as the page for every address up to 200 characters', () => {
  const locals = ['a', 'ab.cd', 'a+b', 'a.', '.a', 'a..b', 'a b', 'a@b', 'ä', "a'b", 'a'.repeat(64), 'a'.repeat(65), ''];
  const domains = ['x.com', 'x.c', 'x', 'x..com', '-x.com', 'x-.com', 'x_y.com', 'münchen.de', '例子.中国', 'xn--mnchen-3ya.de', '1.2.3.4', 'a.b.c.d.e.f', 'x.co.', '.x.com', 'x'.repeat(63) + '.com', 'x'.repeat(64) + '.com', 'x.' + 'c'.repeat(24), 'x.' + 'c'.repeat(25), 'x.c0m', ''];
  const wraps = [(s) => s, (s) => ' ' + s + ' ', (s) => s.toUpperCase(), (s) => s + '\u0001', (s) => s.normalize('NFD')];
  let n = 0;
  for (const l of locals) for (const d of domains) for (const w of wraps) {
    const v = w(l + '@' + d);
    if (v.trim().length > E.MAX_STORED) continue;
    assert.equal(E.problem(v), page.emailProblem(v), JSON.stringify(v));
    n++;
  }
  assert.ok(n > 1000, 'the list should not shrink: ' + n);
});

test('the message is the one the page shows', () => {
  assert.equal(E.problem('a@b'), page.emailProblem('a@b'));
  assert.equal(E.MESSAGE, page.emailProblem('nope'));
});

test('not strings: the page reads a field as text, so does the server', () => {
  for (const v of [undefined, null, 0, 123, {}, [], true]) assert.notEqual(E.problem(v), '', String(v));
  assert.equal(E.problem(['you@lab.org']), page.emailProblem(['you@lab.org']));   // String([x]) is "x" on both sides
});

test('the one difference: an address longer than an order stores (200) is refused although the page would allow up to 254', () => {
  const long = 'a'.repeat(60) + '@' + ('x'.repeat(60) + '.').repeat(2) + 'com';           // 60 + 1 + 122 + 3 = 186
  const longer = 'a'.repeat(64) + '@' + ('x'.repeat(61) + '.').repeat(2) + 'com';          // 64 + 1 + 124 + 3 = 192
  const over = 'a'.repeat(64) + '@' + ('x'.repeat(63) + '.').repeat(2) + 'x'.repeat(8) + '.com';   // 64 + 1 + 128 + 13 = 206
  assert.ok(long.length <= 200 && longer.length <= 200 && over.length > 200 && over.length <= 254);
  assert.equal(E.problem(long), '');
  assert.equal(E.problem(longer), '');
  assert.equal(page.emailProblem(over), '');   // the page takes it (valid labels, 206 characters)
  assert.notEqual(E.problem(over), '');        // an order would store it cut off at 200
});

test('the module is the page function and a cap, nothing more: no required fields, no suggestions, no other exports', () => {
  assert.deepEqual(Object.keys(E).sort(), ['MAX_STORED', 'MESSAGE', 'emailProblem', 'problem']);
});
