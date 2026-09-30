'use strict';
/**
 * Repeat buyer mark on CRM/orders.html (2026-10-01). Loaded with `defer` after the page's own script, so it only
 * wraps two page functions (rowHtml, OrdersModel.filter) and adds one checkbox; no line of the page is rewritten.
 *
 * Rule = Finance Reports "Repeat customers" (finance-model.js select() + repeat()): an order counts when it is a primary
 * order (kind order, not a duplicate copy, not a test order, not cancelled) with an e-mail; the buyer is the e-mail,
 * trimmed and lower-cased; no e-mail means the order is not counted and gets no mark. The order is numbered by date
 * within its buyer: the first gets nothing, the second "Repeat · 2nd order", and so on. Orders without a readable date
 * come after the dated ones. Unlike Finance Reports the list is not narrowed to paid orders or to a period.
 */
(function (global) {
  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

  function emailOf(r) { return String((r && r.email) || '').trim().toLowerCase(); }

  // The same instant finance-model.js whenOf() gives (a bare date is a local calendar day). whenMs is OrdersModel.whenMs.
  function whenOf(r, whenMs) {
    var s = r && r.createdAt;
    var m = typeof s === 'string' ? DATE_ONLY.exec(s) : null;
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return whenMs ? whenMs(s) : Date.parse(s);
  }

  // finance-model.js select() with period "all", not paid-only, cancelled left out.
  function countable(r) {
    return !!r && r.kind === 'order' && !r.duplicateOf && !r.isTest && r.group !== 'cancelled' && !!emailOf(r);
  }

  // Map of record -> its number among the same buyer's orders (1 = first). Records that do not count are not in the map.
  function numbers(list, whenMs) {
    var byEmail = Object.create(null);
    var src = Array.isArray(list) ? list : [];
    src.forEach(function (r, i) {
      if (!countable(r)) return;
      var k = emailOf(r);
      (byEmail[k] || (byEmail[k] = [])).push({ r: r, i: i, t: whenOf(r, whenMs) });
    });
    var out = new Map();
    Object.keys(byEmail).forEach(function (k) {
      byEmail[k].sort(function (a, b) {
        var an = Number.isNaN(a.t), bn = Number.isNaN(b.t);
        if (an !== bn) return an ? 1 : -1;
        return (an ? 0 : a.t - b.t) || a.i - b.i;
      }).forEach(function (e, pos) { out.set(e.r, pos + 1); });
    });
    return out;
  }

  function ordinal(n) {
    var m100 = n % 100, m10 = n % 10;
    if (m100 >= 11 && m100 <= 13) return n + 'th';
    return n + (m10 === 1 ? 'st' : m10 === 2 ? 'nd' : m10 === 3 ? 'rd' : 'th');
  }

  function chipText(n) { return 'Repeat · ' + ordinal(n) + ' order'; }

  // Puts the chip at the end of the first od-ref box of a row's HTML (next to the order number and the page's own chips).
  // A row without that box comes back unchanged.
  function withChip(html, n) {
    if (!(n >= 2) || typeof html !== 'string') return html;
    var at = html.indexOf('<div class="od-ref">');
    if (at < 0) return html;
    var close = html.indexOf('</div>', at);
    if (close < 0) return html;
    return html.slice(0, close) + '<span class="od-chip od-chip-repeat">' + chipText(n) + '</span>' + html.slice(close);
  }

  // Wires the page. Returns a word for the console: "ok" or why it stayed out of the way.
  function install(win) {
    var doc = win.document, OM = win.OrdersModel;
    if (!OM || typeof OM.filter !== 'function' || typeof OM.whenMs !== 'function') return 'skip: no OrdersModel';
    if (typeof win.rowHtml !== 'function' || typeof win.applyFilters !== 'function') return 'skip: page functions missing';
    if (doc.getElementById('repeat-only')) return 'skip: already installed';
    var anchor = doc.getElementById('show-signups');
    var host = anchor && anchor.closest ? anchor.closest('label') : null;
    if (!host || !host.parentNode) return 'skip: filter row missing';

    var cache = { list: null, size: -1, map: null };
    // Recounted on every filter pass (one per redraw of the list); rows drawn in between reuse the last count.
    function numbersFor(list, fresh) {
      if (fresh || cache.list !== list || cache.size !== list.length) cache = { list: list, size: list.length, map: numbers(list, OM.whenMs) };
      return cache.map;
    }

    var style = doc.createElement('style');
    // :has() lets the chip drop under a long order number instead of squeezing the number into an ellipsis.
    style.textContent = '.od-chip-repeat{background:#ECFDF5;color:#059669}.od-ref:has(.od-chip-repeat){flex-wrap:wrap;row-gap:2px}';
    doc.head.appendChild(style);

    var label = doc.createElement('label');
    label.className = 'od-check';
    label.innerHTML = '<input type="checkbox" id="repeat-only"> Repeat orders <b id="count-repeat">0</b>';
    host.parentNode.insertBefore(label, host.nextSibling);
    var box = label.querySelector('input');
    box.addEventListener('change', function () { win.applyFilters(); });

    var origRow = win.rowHtml;
    win.rowHtml = function (r) {
      var html = origRow.apply(this, arguments);
      try {
        var list = typeof allOrders !== 'undefined' ? allOrders : null;   // the page's own list (a let, not a window property)
        return list ? withChip(html, numbersFor(list).get(r)) : html;
      } catch (e) { return html; }
    };

    var origFilter = OM.filter;
    OM.filter = function (list) {
      var out = origFilter.apply(this, arguments);
      try {
        var nums = numbersFor(list, true);
        var n = 0;
        nums.forEach(function (v) { if (v >= 2) n++; });
        var badge = doc.getElementById('count-repeat');
        if (badge) badge.textContent = String(n);
        if (box.checked) out = out.filter(function (r) { return nums.get(r) >= 2; });
      } catch (e) { /* the list stays as the page made it */ }
      return out;
    };

    // The page may have drawn its first list before this script ran.
    if (typeof loadedOnce !== 'undefined' && loadedOnce) win.applyFilters({ keepPage: true });
    return 'ok';
  }

  var api = { numbers: numbers, countable: countable, ordinal: ordinal, chipText: chipText, withChip: withChip, install: install };
  global.RepeatBuyer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    try { install(window); } catch (e) { if (typeof console !== 'undefined') console.warn('repeat-buyer: ' + e.message); }
  }
})(typeof window !== 'undefined' ? window : globalThis);
