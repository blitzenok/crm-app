'use strict';
/**
 * "Account" tag on CRM/orders.html (customer accounts, spec section 8.3): a small tag under the customer name when the
 * customer's e-mail is the login of a shop account. Loaded with `defer` after the page's own scripts; it only watches the
 * orders table and adds one span per matching row, so no line of the page is rewritten.
 *
 * One POST /account-desk/has-account for the e-mails on screen (at most 200 per request). An address already asked about
 * is never asked again; the answers are remembered and painted again whenever the page redraws the list. Any failure (no
 * answer, an error status, a bad body) means no tags and no message, and no further requests until the page is reloaded.
 * Everything put on the page goes through textContent.
 */
(function (global) {
  var MAX = 200;       // service limit per request
  var ROUNDS = 5;      // requests per pass at most: 1000 distinct addresses on one page is far beyond the table's page size
  var EMAIL = /^[^\s@]+@[^\s@]+$/;
  var CELLS = '#orders-tbody td.od-c-customer';

  function norm(s) { return String(s || '').trim().toLowerCase(); }

  function install(win) {
    var doc = win.document;
    var body = doc.getElementById('orders-tbody');
    if (!body || typeof win.MutationObserver !== 'function') return 'skip: no orders table';
    if (doc.getElementById('account-badge-css')) return 'skip: already installed';

    var style = doc.createElement('style');
    style.id = 'account-badge-css';
    style.textContent = '.od-acct-tag{display:block;width:max-content;margin-top:2px;padding:1px 7px;border-radius:10px;font-size:10px;font-weight:700;' +
      'background:#EEF2FF;color:#3730A3;line-height:1.4}';
    doc.head.appendChild(style);

    var asked = Object.create(null);   // address -> true once it was part of a request
    var have = Object.create(null);    // address -> true when the service says it has an account
    var failed = false;
    var running = false;
    var again = false;   // the table changed while a request was in flight: one more pass afterwards
    var timer = 0;

    function token() { try { return win.localStorage.getItem('crm_token') || ''; } catch (e) { return ''; } }

    // The address in a .od-sub line is its own text nodes only: other scripts (human-use-badge.js) put their badges INTO the
    // same element, and their text must not become part of the address.
    function emailOf(sub) {
      var t = '';
      for (var n = sub.firstChild; n; n = n.nextSibling) if (n.nodeType === 3) t += n.nodeValue;
      return norm(t);
    }

    // [{ cell, email }] for the customer cells on screen that show an address
    function onScreen() {
      var out = [];
      var cells = body.querySelectorAll(CELLS);
      for (var i = 0; i < cells.length; i++) {
        var sub = cells[i].querySelector('.od-sub');
        var email = sub ? emailOf(sub) : '';
        if (EMAIL.test(email) && email.length <= 254) out.push({ cell: cells[i], email: email });
      }
      return out;
    }

    // The tag is a sibling right after .od-name: inside it, the name's nowrap + ellipsis would cut the tag off for a long name.
    function paint() {
      onScreen().forEach(function (r) {
        if (!have[r.email] || r.cell.querySelector('.od-acct-tag')) return;
        var name = r.cell.querySelector('.od-name');
        if (!name) return;
        var tag = doc.createElement('span');
        tag.className = 'od-acct-tag';
        tag.textContent = 'Account';
        name.parentNode.insertBefore(tag, name.nextSibling);
      });
    }

    // One request for up to MAX addresses nobody asked about yet. -> true when answered, false on any failure.
    async function ask(list) {
      list.forEach(function (e) { asked[e] = true; });
      var ctrl = typeof win.AbortController === 'function' ? new win.AbortController() : null;
      var t = ctrl ? win.setTimeout(function () { ctrl.abort(); }, 8000) : 0;
      try {
        var init = { method: 'POST', headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' }, body: JSON.stringify({ emails: list }) };
        if (ctrl) init.signal = ctrl.signal;
        var r = await win.fetch('/account-desk/has-account', init);
        if (!r.ok) return false;
        var d = await r.json();
        if (!d || !Array.isArray(d.emails)) return false;
        d.emails.forEach(function (e) { var n = norm(e); if (asked[n]) have[n] = true; });
        return true;
      } catch (e) {
        return false;
      } finally {
        if (t) win.clearTimeout(t);
      }
    }

    async function pass() {
      if (running) { again = true; return; }
      running = true;
      try {
        for (var round = 0; round < ROUNDS && !failed; round++) {
          var fresh = [];
          onScreen().forEach(function (r) { if (!asked[r.email] && fresh.indexOf(r.email) < 0) fresh.push(r.email); });
          if (!fresh.length) break;
          if (!(await ask(fresh.slice(0, MAX)))) failed = true;
          paint();
        }
        paint();
      } finally {
        running = false;
        if (again) { again = false; schedule(); }
      }
    }

    function schedule() {
      if (timer) return;
      timer = win.setTimeout(function () { timer = 0; pass(); }, 50);
    }

    new win.MutationObserver(schedule).observe(body, { childList: true, subtree: true });
    schedule();
    return 'ok';
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { install: install };
  else install(global);
})(typeof window !== 'undefined' ? window : globalThis);
