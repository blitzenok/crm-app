'use strict';
/**
 * Ad spend & ROAS section of finance-reports.html (2026-10-01): the table per source, the entry form and the period's entries.
 * The page calls AdSpendSection.render() at the end of its own render() and AdSpendSection.error() when orders did not load.
 * It reads the page's globals allOrders, costIdx, periodVal(), paidOnlyVal() and the helpers esc / escAttr / api, and draws
 * everything from AdSpendModel. It writes only through POST / DELETE /api/marketing/spend, never to orders or payments.
 */
(function (global) {
  var AM = global.AdSpendModel;
  var seq = 0;           // a slower answer of an older render must not draw over a newer one
  var built = false;
  var entries = [];

  function byId(id) { return global.document.getElementById(id); }
  function money(c) { return global.OrdersModel.formatMoney(c / 100); }
  function dash(v, f) { return v === null || v === undefined ? '—' : f(v); }
  function roasText(x) { return x.toFixed(2) + '×'; }
  function body() { return global.document.querySelector('#fin-adspend .fin-body'); }
  function sourceLabel(key) {
    for (var i = 0; i < AM.SOURCE_OPTIONS.length; i++) if (AM.SOURCE_OPTIONS[i].value === key) return AM.SOURCE_OPTIONS[i].label;
    var k = String(key || '');
    if (k.slice(0, 6) === 'other:') k = k.slice(6);
    return k.charAt(0).toUpperCase() + k.slice(1);
  }
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function td(label, value, extra) {
    return '<td data-label="' + global.escAttr(label) + '"' + (extra || '') + '>' + global.esc(value) + '</td>';
  }

  function roasTable(res, paidOnly) {
    var head = ['Source', 'Spend', 'Orders', paidOnly ? 'Revenue' : 'Order value', 'New customers', 'CAC', 'ROAS', 'Gross profit', 'Profit after ads'];
    function cells(r, total) {
      var src = global.esc(r.label) + (!total && r.spendC > 0 && r.orders === 0 ? ' <span class="ad-flag">no orders</span>' : '');
      // A margin known for only some of the row's orders says so; none known is a dash, never a zero.
      var part = r.costed < r.orders ? ' (' + r.costed + ' of ' + r.orders + ' orders)' : '';
      var profit = r.profitC === null ? '—' : money(r.profitC) + part;
      var after = r.afterAdsC === null ? '—' : money(r.afterAdsC) + part;
      var N = ' class="ad-num"';   // numbers never break across lines; a narrow table scrolls inside its wrapper instead
      return '<td data-label="Source">' + src + '</td>' +
        td(head[1], money(r.spendC), N) + td(head[2], String(r.orders), N) + td(head[3], money(r.revenueC), N) + td(head[4], String(r.newCustomers), N) +
        td(head[5], dash(r.cacC, money), N) + td(head[6], dash(r.roas, roasText), N) + td(head[7], profit, N) +
        td(head[8], after, N);
    }
    var html = '<div class="fin-table-wrap"><table class="ad-table" data-table="adspend"><thead><tr>' +
      head.map(function (h) { return '<th>' + global.esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      res.rows.map(function (r) { return '<tr data-key="' + global.escAttr(r.key) + '">' + cells(r, false) + '</tr>'; }).join('') +
      '<tr class="ad-total">' + cells(res.total, true) + '</tr><tr class="ad-total">' + cells(res.paidChannels, true) + '</tr></tbody></table></div>';
    var note = 'Spend is what was entered below for the period. New customer = first paid order of that e-mail in the whole history falls in the period ' +
      '(orders without an e-mail are not counted). CAC = spend / new customers, ROAS = ' + (paidOnly ? 'paid revenue' : 'order value') + ' / spend. ' +
      'Gross profit is the Margin section’s, for the orders that have a cost for every item' +
      (res.marginOn ? (res.marginPartial ? ' (' + res.total.costed + ' of ' + res.total.orders + ' orders in this total; the rest is unknown, not zero)' : '') : ' (cost list not loaded)') +
      '. "Direct / unknown" is every order with no recorded source, so its ROAS row is empty by design; Total is blended over all sources; Paid channels is the same sums over the sources that have spend. Channel rows include all visits from that site (unpaid posts and search too), so ROAS/CAC for Meta and Google can be higher than for paid clicks alone.';
    return html + '<p class="fin-note">' + global.esc(note) + '</p>';
  }

  function entriesTable(list) {
    if (!list.length) return '<div class="fin-empty">No spend entered for this period</div>';
    return '<div class="fin-table-wrap"><table class="ad-table" data-table="adspend-entries"><thead><tr><th>Date</th><th>Source</th><th>Campaign</th><th>Amount</th><th>Note</th><th>Added by</th><th></th></tr></thead><tbody>' +
      list.map(function (e) {
        return '<tr data-id="' + global.escAttr(e.id) + '">' + td('Date', e.date, ' class="ad-num"') + td('Source', sourceLabel(e.source)) + td('Campaign', e.campaign || '—') +
          td('Amount', money(e.amountCents), ' class="ad-num"') + td('Note', e.note || '—') + td('Added by', e.createdBy || '—') +
          '<td data-label=""><button type="button" class="ad-del" data-del="' + global.escAttr(e.id) + '">Delete</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function formHtml() {
    var opts = AM.SOURCE_OPTIONS.map(function (o) { return '<option value="' + global.escAttr(o.value) + '">' + global.esc(o.label) + '</option>'; }).join('') +
      '<option value="other">Other…</option>';
    return '<div id="ad-roas"><div class="fin-loading">Loading…</div></div>' +
      '<h3 style="margin-top:18px">Add spend</h3>' +
      '<form id="ad-form" class="ad-form" autocomplete="off">' +
      '<label>Date<input type="date" id="ad-date" value="' + global.escAttr(today()) + '" required></label>' +
      '<label>Source<select id="ad-source">' + opts + '</select></label>' +
      '<label id="ad-other-wrap" hidden>Source name<input type="text" id="ad-other" maxlength="40" placeholder="e.g. Ram"></label>' +
      '<label>Campaign<input type="text" id="ad-campaign" maxlength="80"></label>' +
      '<label>Amount, USD<input type="text" id="ad-amount" inputmode="decimal" placeholder="0.00" required></label>' +
      '<label>Note<input type="text" id="ad-note" maxlength="200"></label>' +
      '<button type="submit" id="ad-submit">Add</button>' +
      '</form><div id="ad-msg" class="fin-note" role="status"></div>' +
      '<h3 style="margin-top:18px">Entries in this period</h3><div id="ad-entries"></div>';
  }

  function msg(text, isError) {
    var m = byId('ad-msg');
    if (!m) return;
    m.textContent = text || '';
    m.style.color = isError ? '#C62828' : '';
  }

  function draw() {
    var res = AM.build({ orders: global.allOrders, spend: entries, period: global.periodVal(), paidOnly: global.paidOnlyVal(), now: new Date(), costIdx: global.costIdx });
    byId('ad-roas').innerHTML = roasTable(res, global.paidOnlyVal());
    byId('ad-entries').innerHTML = entriesTable(entries);
  }

  function wire() {
    byId('ad-source').addEventListener('change', function () { byId('ad-other-wrap').hidden = byId('ad-source').value !== 'other'; });
    byId('ad-form').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var src = byId('ad-source').value;
      var other = byId('ad-other').value.trim();
      if (src === 'other') {
        if (!other) { msg('Type the source name', true); return; }
        src = 'other:' + other;
      }
      var btn = byId('ad-submit');
      btn.disabled = true;
      msg('Saving…', false);
      global.api('/api/marketing/spend', { method: 'POST', toast: false, body: {
        date: byId('ad-date').value, source: src, campaign: byId('ad-campaign').value, amount: byId('ad-amount').value.trim(), note: byId('ad-note').value } })
        .then(function (r) {
          byId('ad-amount').value = ''; byId('ad-campaign').value = ''; byId('ad-note').value = '';
          btn.disabled = false;
          return refresh().then(function () {
            var inList = entries.some(function (e) { return r && r.entry && e.id === r.entry.id; });
            msg(inList ? 'Added' : 'Added, but its date is outside the selected period', false);
          });
        })
        .catch(function (e) { btn.disabled = false; msg((e && e.message) || 'Could not save', true); });
    });
    byId('ad-entries').addEventListener('click', function (ev) {
      var t = ev.target;
      var id = t && t.getAttribute && t.getAttribute('data-del');
      if (!id) return;
      if (typeof global.confirm === 'function' && !global.confirm('Delete this spend entry? It stays in the audit log.')) return;
      t.disabled = true;
      global.api('/api/marketing/spend/' + encodeURIComponent(id), { method: 'DELETE', toast: false })
        .then(function () { msg('Deleted', false); return refresh(); })
        .catch(function (e) { t.disabled = false; msg((e && e.message) || 'Could not delete', true); });
    });
  }

  function refresh() {
    var mine = ++seq;
    var range = AM.periodRange(global.periodVal(), new Date());
    var q = (range.from ? '?from=' + encodeURIComponent(range.from) : '') + (range.to ? (range.from ? '&' : '?') + 'to=' + encodeURIComponent(range.to) : '');
    return global.api('/api/marketing/spend' + q, { toast: false }).then(function (d) {
      if (mine !== seq) return;
      entries = d && Array.isArray(d.entries) ? d.entries : [];
      draw();
    }).catch(function () {
      if (mine !== seq) return;
      byId('ad-roas').innerHTML = '<div class="fin-error">Could not load ad spend</div>';
      byId('ad-entries').innerHTML = '';
    });
  }

  function render() {
    if (!built) {
      var b = body();
      if (!b) return Promise.resolve();
      b.innerHTML = formHtml();
      built = true;
      wire();
    }
    return refresh();
  }

  function error() {
    seq++;               // a spend answer still on its way must not draw over this message
    built = false;
    var b = body();
    if (b) b.innerHTML = '<div class="fin-error">Could not load orders</div>';
  }

  global.AdSpendSection = { render: render, error: error };
})(typeof window !== 'undefined' ? window : global);
