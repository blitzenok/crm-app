'use strict';
// The e-mail rule of the checkout page, for products-api (2026-10-02). The page decides with emailProblem() in
// html/checkout-validate.js (storefront repo, PR #110-#112); this file is that function and nothing else, so an address
// the page lets through is not refused here and one the page refuses is not taken here. test/checkout-email.test.cjs runs
// both on one list of addresses, against the page file of server-snapshot/ (or CHECKOUT_VALIDATE_JS): if the page's rule
// changes, that test fails until this copy follows.
// Only the 200 character cap differs on purpose: sanitizeOrder (products-api) stores at most 200 characters of an address,
// so a longer one would be saved cut off, as a different address.

const MESSAGE = 'Enter a valid email, like you@lab.org.';
const MAX_STORED = 200;

/* Same patterns as checkout-validate.js: letters and digits of any script in domain labels, ASCII atoms before the @. */
const LOCAL_RE = /^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+(\.[A-Za-z0-9!#$%&'*+\/=?^_`{|}~-]+)*$/;
const LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u;
const TLD_RE = /^[\p{L}]{2,24}$/u;

function str(v) { return String(v == null ? '' : v).trim(); }

function nfc(v) {
  v = str(v);
  try { if (v.normalize) v = v.normalize('NFC'); } catch (e) { /* keep as is */ }
  return v;
}

// '' = fine, otherwise the message the page shows under the field (checkout-validate.js emailProblem, same logic).
function emailProblem(value) {
  const v = nfc(value);
  const at = v.lastIndexOf('@');
  if (at < 1 || v.length > 254) return MESSAGE;
  const local = v.slice(0, at);
  const labels = v.slice(at + 1).split('.');
  if (local.length > 64 || !LOCAL_RE.test(local) || labels.length < 2) return MESSAGE;
  for (let i = 0; i < labels.length; i++) if (!LABEL_RE.test(labels[i])) return MESSAGE;
  if (!TLD_RE.test(labels[labels.length - 1])) return MESSAGE;
  return '';
}

// The server's question: the page rule, plus "fits what an order stores". '' = take it.
function problem(value) {
  if (str(value).length > MAX_STORED) return MESSAGE;
  return emailProblem(value);
}

module.exports = { MESSAGE, MAX_STORED, emailProblem, problem };
