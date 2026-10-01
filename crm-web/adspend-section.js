'use strict';
/**
 * Ad spend & ROAS section of finance-reports.html (2026-10-01): the headline tiles, the table per source, the period's entries
 * and the "Add spend" window (source chips, its own calendar; no browser dialogs).
 * The page calls AdSpendSection.render() at the end of its own render() and AdSpendSection.error() when orders did not load.
 * It reads the page's globals allOrders, costIdx, periodVal(), paidOnlyVal() and the helpers esc / escAttr / api / toast /
 * confirmDialog, and draws everything from AdSpendModel. It never writes to
 * orders or payments (POST / PUT / DELETE /api/marketing/spend only). Its styles travel with this file (one <style> in the
 * head), so a redesign does not touch the page.
 * Every class, id and data attribute here starts with "spend-", never "ad-": ad blockers hide elements by such names
 * (.ad-label, .ad-table, #ad-campaign are in EasyList), and the window lost its labels and a whole row on 2026-10-01.
 */
(function (global) {
  var AM = global.AdSpendModel;
  var seq = 0;           // a slower answer of an older render must not draw over a newer one
  var built = false;
  var styled = false;
  var howOpen = false;   // "How it's counted" stays open across redraws
  var entries = [];
  var form = null;       // the open window: { overlay, id ('' = a new entry), source, day, view: {y, m}, busy }

  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var DOTS = { google: '#EA4335', meta: '#1877F2', tiktok: '#111827', newsletter: '#7C3AED', direct: '#B8C4DC' };
  var PENCIL = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4zM13.5 6.5l4 4"/></svg>';
  var TRASH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  var CSS = [
    '#fin-adspend .spend-table{min-width:0!important;width:100%;}',
    '#fin-adspend .spend-total td{font-weight:700;}',
    '#fin-adspend .spend-num{white-space:nowrap;}',
    '#fin-adspend .spend-flag{display:inline-block;font-size:10px;font-weight:700;color:#8A5A00;background:#FFF4D6;border-radius:6px;padding:1px 6px;margin-left:4px;white-space:nowrap;}',
    '#fin-adspend .spend-bar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:-4px 0 14px;}',
    '#fin-adspend .spend-link{border:none;background:none;padding:0;font-size:12px;font-weight:600;color:#5A6685;cursor:pointer;text-decoration:underline;text-underline-offset:3px;}',
    '#fin-adspend .spend-kpis{grid-template-columns:repeat(auto-fit,minmax(150px,1fr));}',   // the page's own .fin-tiles, five across
    '#fin-adspend .tile-value.spend-muted{font-size:14px;font-weight:600;letter-spacing:0;line-height:27px;}',
    '#fin-adspend .spend-kpi-s{font-size:11px;color:#8A94A6;margin-top:2px;}',
    '#fin-adspend .spend-muted{color:#8A94A6;font-weight:400;}',
    '#fin-adspend .spend-pos{color:#0E7A3E;}',
    '#fin-adspend .spend-neg{color:#C62828;}',
    '#fin-adspend .spend-pill{display:inline-block;background:#EEF2FA;color:#1B2A4A;border-radius:20px;padding:1px 9px;font-weight:700;}',
    '#fin-adspend .spend-dot,.spend-modal .spend-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:1px;}',
    '#fin-adspend .spend-how{margin:0 0 12px;}',
    '#fin-adspend .spend-how[hidden]{display:none;}',
    '#fin-adspend .spend-h{font-size:13px;font-weight:700;color:#1B2A4A;margin:20px 0 8px;}',
    '#fin-adspend .spend-acts{white-space:nowrap;text-align:right;}',
    '#fin-adspend .spend-act{border:1px solid #EAECF4;border-radius:8px;padding:5px 7px;margin-left:4px;background:#fff;color:#8A94A6;cursor:pointer;line-height:0;}',
    '#fin-adspend .spend-act:hover{background:#F0F3FA;color:#1B2A4A;}',
    '#fin-adspend .spend-act.spend-del:hover{background:#FEF2F2;color:#C62828;border-color:#FECACA;}',
    '#fin-adspend .spend-empty{border:1px dashed #D5DBE8;border-radius:12px;padding:22px 16px;text-align:center;font-size:13px;color:#1B2A4A;display:flex;flex-direction:column;align-items:center;gap:6px;}',
    '#fin-adspend .spend-empty .btn{margin-top:8px;}',
    '.spend-modal form{display:flex;flex-direction:column;min-height:0;}',
    '.spend-modal .modal-body>*{flex-shrink:0;}',   // a short screen scrolls the body, it does not squeeze the fields
    '.spend-modal .modal-header{align-items:center;}',
    '.spend-modal .spend-field{display:flex;flex-direction:column;gap:5px;min-width:0;}',
    '.spend-modal .spend-field[hidden],.spend-modal .spend-cal[hidden]{display:none;}',
    '.spend-modal .spend-label{font-size:12px;font-weight:700;color:#1B2A4A;}',
    '.spend-modal .spend-two{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
    '.spend-modal .spend-chips{display:flex;flex-wrap:wrap;gap:6px;}',
    '.spend-modal .spend-chip{border:1px solid #D5DBE8;background:#fff;border-radius:20px;padding:6px 13px;font-size:13px;font-weight:600;color:#1B2A4A;cursor:pointer;}',
    '.spend-modal .spend-chip.is-on{background:#E6F4EA;border-color:#1F7A3D;color:#145C2C;}',
    '.spend-modal .spend-datebtn{text-align:left;background:#fff;cursor:pointer;}',
    '.spend-modal .spend-cal{border:1px solid #E8ECF4;border-radius:12px;padding:10px;}',
    '.spend-modal .spend-cal-head{display:flex;justify-content:space-between;align-items:center;font-size:13px;font-weight:700;color:#1B2A4A;margin-bottom:6px;}',
    '.spend-modal .spend-cal-nav{width:28px;height:28px;border:1px solid #E8ECF4;border-radius:8px;background:#fff;cursor:pointer;font-size:15px;color:#1B2A4A;}',
    '.spend-modal .spend-cal-nav:disabled,.spend-modal .spend-day:disabled{opacity:.35;cursor:default;}',
    '.spend-modal .spend-cal-grid{display:grid;grid-template-columns:repeat(7,1fr);gap:2px;text-align:center;}',
    '.spend-modal .spend-dow{font-size:11px;color:#8A94A6;padding:4px 0;}',
    '.spend-modal .spend-day{border:none;background:none;border-radius:8px;padding:7px 0;font-size:13px;color:#1B2A4A;cursor:pointer;}',
    '.spend-modal .spend-day:hover:not(:disabled){background:#F0F3FA;}',
    '.spend-modal .spend-day.is-today{box-shadow:inset 0 0 0 1px #1F7A3D;}',
    '.spend-modal .spend-day.is-sel{background:#1F7A3D;color:#fff;font-weight:700;}',
    '.spend-modal .spend-cal-quick{display:flex;gap:6px;margin-top:8px;}',
    '.spend-modal .spend-msg{font-size:12px;color:#C62828;}',
    '.spend-modal .spend-msg:empty{display:none;}',
    '@media(max-width:768px){',
    // phones: every row is a small card (label left, value right); the page's own rule would keep a wide scrolling table
    '#fin-adspend .spend-kpis{grid-template-columns:1fr 1fr;}',
    '#fin-adspend .spend-table thead{display:none!important;}',
    '#fin-adspend .spend-table tbody tr{display:block!important;border:1px solid #E8ECF4!important;border-radius:10px;margin-bottom:10px;padding:6px 12px!important;}',
    '#fin-adspend .spend-table tbody td,#fin-adspend .spend-table tbody td:first-child{display:flex!important;justify-content:space-between;gap:12px;padding:5px 0!important;border:none!important;font-size:12px!important;text-align:right;}',
    '#fin-adspend .spend-table tbody td::before{content:attr(data-label);color:#5A6685;font-weight:600;text-align:left;}',
    '#fin-adspend .spend-table tbody td:first-child{font-weight:700;font-size:13px!important;text-align:left;}',
    '}',
    '@media(max-width:480px){.spend-modal .spend-two{grid-template-columns:1fr;}}'
  ].join('\n');

  function byId(id) { return global.document.getElementById(id); }
  function money(c) { return global.OrdersModel.formatMoney(c / 100); }
  function roasText(x) { return x.toFixed(2) + '×'; }
  function body() { return global.document.querySelector('#fin-adspend .fin-body'); }
  function say(text, type) { if (typeof global.toast === 'function') global.toast(text, type); }
  function muted(text) { return '<span class="spend-muted">' + global.esc(text) + '</span>'; }
  function dot(key) { return '<span class="spend-dot" style="background:' + (DOTS[key] || '#0E9F6E') + '"></span>'; }
  function shortLabel(label) { return String(label).split(' (')[0]; }
  function sourceLabel(key) {
    for (var i = 0; i < AM.SOURCE_OPTIONS.length; i++) if (AM.SOURCE_OPTIONS[i].value === key) return shortLabel(AM.SOURCE_OPTIONS[i].label);
    var k = String(key || '');
    if (k.slice(0, 6) === 'other:') k = k.slice(6);
    return k.charAt(0).toUpperCase() + k.slice(1);
  }
  function pad2(n) { return ('0' + n).slice(-2); }
  function ymd(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
  function dayOf(d) { return ymd(d.getFullYear(), d.getMonth(), d.getDate()); }
  function today() { return dayOf(new Date()); }
  function yesterday() { var d = new Date(); return dayOf(new Date(d.getFullYear(), d.getMonth(), d.getDate() - 1)); }
  // '2026-10-01' -> 'Oct 1, 2026'; anything else is shown as it came
  function fmtDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m && MONTHS[m[2] - 1] ? MONTHS[m[2] - 1].slice(0, 3) + ' ' + Number(m[3]) + ', ' + m[1] : String(s || '');
  }
  // The nearest element at or above the click that carries the attribute (an icon inside a button is the click's target).
  function hit(ev, name) {
    for (var t = ev && ev.target; t && t.getAttribute; t = t.parentNode) {
      var v = t.getAttribute(name);
      if (v !== null && v !== undefined) return { el: t, v: v };
    }
    return null;
  }

  function cell(label, html, cls) {
    return '<td data-label="' + global.escAttr(label) + '"' + (cls ? ' class="' + cls + '"' : '') + '>' + html + '</td>';
  }

  // Why a ratio has no number, in words: a source nobody paid for, a source with no spend entered, or no new customer yet.
  function why(r, total, noCustomers) {
    if (r.spendC > 0) return noCustomers;
    return !total && r.key === 'direct' ? 'not ads' : 'no spend';
  }
  // A margin known for only some of the row's orders says so; none known is "cost unknown", never a zero.
  function profitHtml(r, v, marginOn, colour) {
    if (!marginOn) return muted('cost list not loaded');
    if (v === null || (r.orders > 0 && r.costed === 0)) return muted('cost unknown');
    var part = r.costed < r.orders ? ' ' + muted('(' + r.costed + ' of ' + r.orders + ' orders)') : '';
    var cls = colour && !part && v !== 0 ? (v > 0 ? 'spend-pos' : 'spend-neg') : '';
    return (cls ? '<span class="' + cls + '">' + global.esc(money(v)) + '</span>' : global.esc(money(v))) + part;
  }

  function tile(label, valueHtml, sub) {
    return '<div data-tile="adspend"><div class="tile-label">' + global.esc(label) + '</div>' + valueHtml +
      (sub ? '<div class="spend-kpi-s">' + global.esc(sub) + '</div>' : '') + '</div>';
  }
  function tileValue(text, isMuted) { return '<div class="tile-value' + (isMuted ? ' spend-muted' : '') + '">' + global.esc(text) + '</div>'; }

  // The headline numbers are the Paid channels row: the sources that have spend, nothing else mixed in.
  function tiles(res, paidOnly) {
    var p = res.paidChannels;
    var unknown = !res.marginOn || (p.orders > 0 && p.costed === 0);
    return '<div class="fin-tiles spend-kpis">' +
      tile('Spend', tileValue(money(p.spendC))) +
      tile(paidOnly ? 'Revenue, paid channels' : 'Order value, paid channels', tileValue(money(p.revenueC))) +
      tile('ROAS', p.roas === null ? tileValue('no spend', true) : tileValue(roasText(p.roas))) +
      tile('Cost per new customer', p.cacC === null ? tileValue(why(p, true, 'no new customers'), true) : tileValue(money(p.cacC))) +
      tile('Profit after ads', p.spendC === 0 ? tileValue('no spend', true)
        : unknown ? tileValue(res.marginOn ? 'cost unknown' : 'cost list not loaded', true) : tileValue(money(p.afterAdsC)),
        p.spendC > 0 && !unknown && p.costed < p.orders ? 'cost known for ' + p.costed + ' of ' + p.orders + ' orders' : '') +
      '</div>';
  }

  function roasTable(res, paidOnly) {
    var head = ['Source', 'Spend', 'Orders', paidOnly ? 'Revenue' : 'Order value', 'New customers', 'CAC', 'ROAS', 'Gross profit', 'Profit after ads'];
    function cells(r, total) {
      // one span: on phones a cell is a row "label left, value right", and the dot must stay with the name
      var src = '<span>' + (total ? '' : dot(r.key)) + global.esc(r.label) + (!total && r.spendC > 0 && r.orders === 0 ? ' <span class="spend-flag">no orders</span>' : '') + '</span>';
      var N = 'spend-num';   // numbers never break across lines; a narrow table scrolls inside its wrapper instead
      return cell(head[0], src) +
        cell(head[1], global.esc(money(r.spendC)), N) + cell(head[2], String(r.orders), N) + cell(head[3], global.esc(money(r.revenueC)), N) +
        cell(head[4], String(r.newCustomers), N) +
        cell(head[5], r.cacC === null ? muted(why(r, total, 'no new customers')) : global.esc(money(r.cacC)), N) +
        cell(head[6], r.roas === null ? muted(why(r, total)) : '<span class="spend-pill">' + global.esc(roasText(r.roas)) + '</span>', N) +
        cell(head[7], profitHtml(r, r.profitC, res.marginOn, false), N) +
        cell(head[8], profitHtml(r, r.afterAdsC, res.marginOn, true), N);
    }
    var note = 'Spend is what was entered for the period. New customer = first paid order of that e-mail in the whole history falls in the period ' +
      '(orders without an e-mail are not counted). CAC = spend / new customers, ROAS = ' + (paidOnly ? 'paid revenue' : 'order value') + ' / spend. ' +
      'Gross profit is the Margin section’s, for the orders that have a cost for every item' +
      (res.marginOn ? (res.marginPartial ? ' (' + res.total.costed + ' of ' + res.total.orders + ' orders in this total; the rest is unknown, not zero)' : '') : ' (cost list not loaded)') +
      '. "Direct / unknown" is every order with no recorded source, so it has no ROAS by design; Total is blended over all sources; Paid channels is the same sums over the sources that have spend, and the tiles above show that row. Channel rows include all visits from that site (unpaid posts and search too), so ROAS/CAC for Meta and Google can be higher than for paid clicks alone.';
    return tiles(res, paidOnly) +
      '<p class="fin-note spend-how" id="spend-how"' + (howOpen ? '' : ' hidden') + '>' + global.esc(note) + '</p>' +
      '<div class="fin-table-wrap"><table class="spend-table" data-table="adspend"><thead><tr>' +
      head.map(function (h) { return '<th>' + global.esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      res.rows.map(function (r) { return '<tr data-key="' + global.escAttr(r.key) + '">' + cells(r, false) + '</tr>'; }).join('') +
      '<tr class="spend-total">' + cells(res.total, true) + '</tr><tr class="spend-total">' + cells(res.paidChannels, true) + '</tr></tbody></table></div>';
  }

  function entriesTable(list) {
    if (!list.length) {
      return '<div class="spend-empty"><div>No spend entered for this period</div>' + muted('Add what you paid for ads to see ROAS and the cost of a new customer.') +
        '<button type="button" class="btn btn-secondary" data-spend-add="1">Add spend</button></div>';
    }
    return '<div class="fin-table-wrap"><table class="spend-table" data-table="adspend-entries"><thead><tr><th>Date</th><th>Source</th><th>Campaign</th><th>Note</th><th>Added by</th><th>Amount</th><th></th></tr></thead><tbody>' +
      list.map(function (e) {
        return '<tr data-id="' + global.escAttr(e.id) + '">' + cell('Date', global.esc(fmtDay(e.date)), 'spend-num') +
          cell('Source', '<span>' + dot(AM.spendKey(e)) + global.esc(sourceLabel(e.source)) + '</span>') +
          cell('Campaign', e.campaign ? global.esc(e.campaign) : muted('none')) + cell('Note', e.note ? global.esc(e.note) : muted('none')) +
          cell('Added by', (e.createdBy ? global.esc(e.createdBy) : muted('unknown')) + (e.updatedBy ? ' ' + muted('(edited by ' + e.updatedBy + ')') : '')) +
          cell('Amount', global.esc(money(e.amountCents)), 'spend-num') +
          '<td data-label="" class="spend-acts"><button type="button" class="spend-act" data-spend-edit="' + global.escAttr(e.id) + '" aria-label="Edit" title="Edit">' + PENCIL + '</button>' +
          '<button type="button" class="spend-act spend-del" data-spend-del="' + global.escAttr(e.id) + '" aria-label="Delete" title="Delete">' + TRASH + '</button></td></tr>';
      }).join('') + '</tbody></table></div>';
  }

  function sectionHtml() {
    return '<div class="spend-bar"><button type="button" class="spend-link" id="spend-how-btn" data-spend-how="1" aria-expanded="' + (howOpen ? 'true' : 'false') + '">How it’s counted</button>' +
      '<button type="button" class="btn btn-primary" data-spend-add="1">Add spend</button></div>' +
      '<div id="spend-roas"><div class="fin-loading">Loading…</div></div>' +
      '<h4 class="spend-h">Entries in this period</h4><div id="spend-entries"></div>';
  }

  function draw() {
    var res = AM.build({ orders: global.allOrders, spend: entries, period: global.periodVal(), paidOnly: global.paidOnlyVal(), now: new Date(), costIdx: global.costIdx });
    byId('spend-roas').innerHTML = roasTable(res, global.paidOnlyVal());
    byId('spend-entries').innerHTML = entriesTable(entries);
  }

  /* ── the "Add spend" / "Edit spend" window ──────────────────────────── */
  function formHtml(editing) {
    var title = editing ? 'Edit spend' : 'Add spend';
    return '<div class="modal spend-modal" style="width:520px" role="dialog" aria-modal="true" aria-label="' + title + '">' +
      '<div class="modal-header"><div class="modal-info"><div class="modal-title">' + title + '</div></div>' +
      '<button type="button" class="modal-close" data-spend-close="1" aria-label="Close">×</button></div>' +
      '<form id="spend-form" autocomplete="off" novalidate><div class="modal-body">' +
      '<div class="spend-field"><div class="spend-label">Source</div><div class="spend-chips" id="spend-src"></div></div>' +
      '<div class="spend-field" id="spend-other-wrap" hidden><label class="spend-label" for="spend-other">Source name</label><input class="field-input" type="text" id="spend-other" maxlength="40" placeholder="Ram"></div>' +
      '<div class="spend-two">' +
      '<div class="spend-field"><label class="spend-label" for="spend-amount">Amount, USD</label><input class="field-input" type="text" id="spend-amount" inputmode="decimal" placeholder="0.00"></div>' +
      '<div class="spend-field"><div class="spend-label">Date</div><button type="button" class="field-input spend-datebtn" id="spend-date" data-spend-cal="toggle" aria-expanded="false"></button></div>' +
      '</div><div class="spend-cal" id="spend-cal" hidden></div>' +
      '<div class="spend-field"><label class="spend-label" for="spend-campaign">Campaign</label><input class="field-input" type="text" id="spend-campaign" maxlength="80"></div>' +
      '<div class="spend-field"><label class="spend-label" for="spend-note">Note</label><input class="field-input" type="text" id="spend-note" maxlength="200"></div>' +
      '<div class="spend-msg" id="spend-msg" role="alert"></div>' +
      '</div><div class="modal-footer"><div class="modal-footer-left"></div><div class="modal-footer-right">' +
      '<button type="button" class="btn-cancel" data-spend-close="1">Cancel</button>' +
      '<button type="submit" class="btn btn-primary" id="spend-submit">' + (editing ? 'Save changes' : 'Add spend') + '</button></div></div></form></div>';
  }

  function chipsHtml() {
    return AM.SOURCE_OPTIONS.map(function (o) { return { value: o.value, label: shortLabel(o.label), title: o.label }; })
      .concat([{ value: 'other', label: 'Other', title: 'Any other source: type its name' }])
      .map(function (o) {
        return '<button type="button" class="spend-chip' + (form.source === o.value ? ' is-on' : '') + '" data-spend-src="' + global.escAttr(o.value) + '" title="' + global.escAttr(o.title) +
          '" aria-pressed="' + (form.source === o.value ? 'true' : 'false') + '">' + (o.value === 'other' ? '' : dot(o.value)) + global.esc(o.label) + '</button>';
      }).join('');
  }

  // One month, Sunday first. A day after today cannot be picked; the list of spend starts in 2020 (the server's own bounds).
  function calHtml() {
    var y = form.view.y, m = form.view.m, now = today();
    var first = new Date(y, m, 1).getDay(), days = new Date(y, m + 1, 0).getDate();
    var html = '<div class="spend-cal-head"><button type="button" class="spend-cal-nav" data-spend-cal="prev" aria-label="Previous month"' + (ymd(y, m, 1) <= '2020-01-01' ? ' disabled' : '') + '>‹</button>' +
      '<span>' + MONTHS[m] + ' ' + y + '</span>' +
      '<button type="button" class="spend-cal-nav" data-spend-cal="next" aria-label="Next month"' + (ymd(y, m, days) >= now ? ' disabled' : '') + '>›</button></div><div class="spend-cal-grid">' +
      ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].map(function (d) { return '<span class="spend-dow">' + d + '</span>'; }).join('');
    for (var i = 0; i < first; i++) html += '<span></span>';
    for (var d = 1; d <= days; d++) {
      var day = ymd(y, m, d);
      html += day > now || day < '2020-01-01' ? '<button type="button" class="spend-day" disabled>' + d + '</button>'
        : '<button type="button" class="spend-day' + (day === form.day ? ' is-sel' : '') + (day === now ? ' is-today' : '') + '" data-spend-day="' + day + '">' + d + '</button>';
    }
    return html + '</div><div class="spend-cal-quick"><button type="button" class="spend-chip" data-spend-day="' + now + '">Today</button>' +
      '<button type="button" class="spend-chip" data-spend-day="' + yesterday() + '">Yesterday</button></div>';
  }

  function formMsg(text) { byId('spend-msg').textContent = text || ''; }
  function drawChips() {
    byId('spend-src').innerHTML = chipsHtml();
    byId('spend-other-wrap').hidden = form.source !== 'other';
  }
  function drawDate(open) {
    var btn = byId('spend-date'), cal = byId('spend-cal');
    btn.textContent = fmtDay(form.day);
    cal.hidden = !open;
    if (btn.setAttribute) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) cal.innerHTML = calHtml();
  }
  function focus(id) { var e = byId(id); if (e && e.focus) e.focus(); }

  function onKey(ev) {
    if (!form || ev.key !== 'Escape') return;
    ev.preventDefault();
    if (!byId('spend-cal').hidden) drawDate(false); else closeForm();   // Escape closes the calendar first, then the window
  }

  // entry: the one to edit, or nothing for a new one. An edited entry whose source has no chip (facebook, other:ram) opens
  // as "Other" with its name typed in: the server turns a known name typed there back into its key.
  function openForm(entry) {
    if (form) return;
    var doc = global.document;
    var day = entry ? entry.date : today();
    var known = entry && AM.SOURCE_OPTIONS.some(function (o) { return o.value === entry.source; });
    var overlay = doc.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.innerHTML = formHtml(!!entry);
    doc.body.appendChild(overlay);
    form = { overlay: overlay, id: entry ? entry.id : '', source: entry ? (known ? entry.source : 'other') : '', day: day,
      view: { y: Number(day.slice(0, 4)), m: Number(day.slice(5, 7)) - 1 }, busy: false };
    byId('spend-other').value = entry && !known ? String(entry.source).replace(/^other:/, '') : '';
    byId('spend-amount').value = entry ? (entry.amountCents / 100).toFixed(2) : '';
    byId('spend-campaign').value = entry ? entry.campaign || '' : '';
    byId('spend-note').value = entry ? entry.note || '' : '';
    drawChips();
    drawDate(false);
    overlay.addEventListener('click', onFormClick);
    byId('spend-form').addEventListener('submit', onSubmit);
    doc.addEventListener('keydown', onKey, true);
    focus('spend-amount');
  }

  function closeForm() {
    if (!form || form.busy) return;   // a request on its way keeps the window: its answer has to land somewhere
    global.document.removeEventListener('keydown', onKey, true);
    if (form.overlay.parentNode) form.overlay.parentNode.removeChild(form.overlay);
    form = null;
  }

  function onFormClick(ev) {
    var h;
    if (hit(ev, 'data-spend-close')) { closeForm(); return; }
    if ((h = hit(ev, 'data-spend-src'))) {
      form.source = h.v;
      drawChips();
      formMsg('');
      if (h.v === 'other') focus('spend-other');
      return;
    }
    if ((h = hit(ev, 'data-spend-day'))) {
      form.day = h.v;
      form.view = { y: Number(h.v.slice(0, 4)), m: Number(h.v.slice(5, 7)) - 1 };
      drawDate(false);
      return;
    }
    if ((h = hit(ev, 'data-spend-cal'))) {
      if (h.v === 'toggle') { drawDate(byId('spend-cal').hidden); return; }
      var d = new Date(form.view.y, form.view.m + (h.v === 'next' ? 1 : -1), 1);
      form.view = { y: d.getFullYear(), m: d.getMonth() };
      drawDate(true);
    }
  }

  function onSubmit(ev) {
    ev.preventDefault();
    if (form.busy) return;
    var src = form.source;
    var other = byId('spend-other').value.trim();
    var amount = byId('spend-amount').value.trim();
    if (!src) { formMsg('Choose a source'); return; }
    if (src === 'other') {
      if (!other) { formMsg('Type the source name'); focus('spend-other'); return; }
      src = 'other:' + other;
    }
    if (!amount) { formMsg('Enter the amount'); focus('spend-amount'); return; }
    var btn = byId('spend-submit');
    btn.disabled = true;
    form.busy = true;
    formMsg('');
    var id = form.id;
    global.api('/api/marketing/spend' + (id ? '/' + encodeURIComponent(id) : ''), { method: id ? 'PUT' : 'POST', toast: false, body: {
      date: form.day, source: src, campaign: byId('spend-campaign').value, amount: amount, note: byId('spend-note').value } })
      .then(function (r) {
        form.busy = false;
        closeForm();
        return refresh().then(function () {
          var inList = entries.some(function (e) { return r && r.entry && e.id === r.entry.id; });
          say(inList ? (id ? 'Spend updated' : 'Spend added') : (id ? 'Saved' : 'Added') + ', but its date is outside the selected period');
        });
      })
      .catch(function (e) {
        if (!form) return;
        form.busy = false;
        btn.disabled = false;
        formMsg((e && e.message) || 'Could not save');
      });
  }

  /* ── the section's own clicks ───────────────────────────────────────── */
  function remove(id, btn) {
    var e = entries.filter(function (x) { return x.id === id; })[0];
    var what = e ? ' (' + sourceLabel(e.source) + ', ' + money(e.amountCents) + ', ' + fmtDay(e.date) + ')' : '';
    return global.confirmDialog('Delete this spend entry' + what + '? It stays in the audit log.', { ok: 'Delete' }).then(function (yes) {
      if (!yes) return;
      btn.disabled = true;
      return global.api('/api/marketing/spend/' + encodeURIComponent(id), { method: 'DELETE', toast: false })
        .then(function () { say('Spend entry deleted'); return refresh(); })
        .catch(function (err) { btn.disabled = false; say((err && err.message) || 'Could not delete', 'error'); });
    });
  }

  function onSectionClick(ev) {
    var h;
    if (hit(ev, 'data-spend-add')) { openForm(); return; }
    if ((h = hit(ev, 'data-spend-edit'))) {
      var entry = entries.filter(function (x) { return x.id === h.v; })[0];
      if (entry) openForm(entry);
      return;
    }
    if ((h = hit(ev, 'data-spend-how'))) {
      howOpen = !howOpen;
      byId('spend-how').hidden = !howOpen;
      if (h.el.setAttribute) h.el.setAttribute('aria-expanded', howOpen ? 'true' : 'false');
      return;
    }
    if ((h = hit(ev, 'data-spend-del'))) remove(h.v, h.el);
  }

  function addStyle() {
    if (styled) return;
    var s = global.document.createElement('style');
    s.textContent = CSS;
    global.document.head.appendChild(s);
    styled = true;
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
      byId('spend-roas').innerHTML = '<div class="fin-error">Could not load ad spend</div>';
      byId('spend-entries').innerHTML = '';
    });
  }

  function render() {
    if (!built) {
      var b = body();
      if (!b) return Promise.resolve();
      addStyle();
      b.innerHTML = sectionHtml();
      if (!b._adWired) { b.addEventListener('click', onSectionClick); b._adWired = true; }   // the body element outlives error()
      built = true;
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
