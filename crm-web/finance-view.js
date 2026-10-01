'use strict';
/**
 * Finance Reports, the look of the page (2026-10-01): the period switch, the overview tiles and the five sections
 * (average order value, product demand, margin, sources, repeat customers). The page's render() hands over to
 * FinanceView.render(ctx) when this file is loaded; the numbers still come from FinanceModel, nothing is counted here
 * except which month was the best one. Read-only: no request is sent from this file.
 *
 * The page keeps its own controls (#fin-period, #fin-paid-only, #fin-refresh) and its periodVal() / paidOnlyVal() /
 * persist(): they are hidden and driven from the switch drawn here, so the Ad spend section and the saved choice work as before.
 * Styles travel with this file (one <style> in the head) under the .finv class it puts on the page's .content.
 * Names start with "finv-": never "ad-" (ad blockers hide such elements, see adspend-section.js).
 */
(function (global) {
  var FM = global.FinanceModel;
  var styled = false;
  var open = {};         // which "How it's counted" notes are open, by section; they stay open across redraws

  var PERIODS = [['30d', '30 days'], ['90d', '90 days'], ['ytd', 'This year'], ['all', 'All time']];
  var PERIOD_TEXT = { '30d': 'last 30 days', '90d': 'last 90 days', ytd: 'this year', all: 'all time' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var SOURCE_COLOR = { google: '#EA4335', meta: '#1877F2', facebook: '#1877F2', instagram: '#1877F2', tiktok: '#111827',
    newsletter: '#7C3AED', 'newsletter signup': '#7C3AED', 'vip signup': '#7C3AED', direct: '#B8C4DC', 'not recorded': '#B8C4DC' };
  var PALETTE = ['#0E9F6E', '#F59E0B', '#06B6D4', '#EC4899', '#8B5CF6', '#84CC16'];
  var COST_BASIS = { purchase: 'Purchase avg', pod: 'POD price' };
  var MAX_MONTHS = 12;
  var MAX_BARS = { week: 14, month: 12 };   // columns of the repeat chart; the table under it has every bucket
  var NEW_COLOR = '#B8C4DC', BACK_COLOR = '#0E9F6E';

  var CSS = [
    '.finv .fin-panel>*:not(.finv-ctl){display:none;}',
    '.finv .finv-ctl{display:flex;flex-wrap:wrap;align-items:center;gap:14px;width:100%;}',
    '.finv .finv-seg{display:inline-flex;background:#fff;border:1px solid #E1E6F0;border-radius:10px;padding:3px;gap:2px;}',
    '.finv .finv-seg button{border:none;background:none;padding:6px 14px;border-radius:7px;font-size:13px;font-weight:500;color:#5A6685;cursor:pointer;white-space:nowrap;}',
    '.finv .finv-seg button.is-on{background:#1B2A4A;color:#fff;}',
    '.finv .finv-switch{display:inline-flex;align-items:center;gap:8px;border:none;background:none;padding:0;font-size:13px;color:#1B2A4A;cursor:pointer;}',
    '.finv .finv-switch i{position:relative;width:34px;height:20px;border-radius:20px;background:#CBD5E1;transition:background .15s;}',
    '.finv .finv-switch i::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s;}',
    '.finv .finv-switch[aria-checked="true"] i{background:#1F7A3D;}',
    '.finv .finv-switch[aria-checked="true"] i::after{left:16px;}',
    '.finv .finv-refresh{margin-left:auto;border:1px solid #E1E6F0;background:#fff;border-radius:10px;padding:7px 14px;font-size:13px;font-weight:500;color:#5A6685;cursor:pointer;}',
    '.finv .finv-refresh:hover{color:#1B2A4A;border-color:#CBD5E1;}',
    // tiles: a column with the figure on its bottom line, so a label that wraps does not push the figure down
    '.finv .fin-tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px;}',
    '.finv .fin-tiles [data-tile]{display:flex;flex-direction:column;background:#fff;border:1px solid #E8ECF4;border-radius:14px;padding:14px 16px;min-width:0;}',
    '.finv .tile-label{text-transform:none;letter-spacing:0;font-size:12px;font-weight:500;color:#6B7280;}',
    '.finv .tile-value{margin-top:auto;padding-top:10px;font-size:24px;font-weight:600;line-height:30px;letter-spacing:-0.01em;color:#1B2A4A;font-variant-numeric:tabular-nums;white-space:nowrap;word-break:normal;}',
    '.finv .finv-small{font-size:14px;font-weight:400;letter-spacing:0;color:#8A94A6;}',
    '.finv .tile-value.finv-quiet{font-size:13px;font-weight:400;letter-spacing:0;color:#8A94A6;}',
    '.finv .tile-value.finv-neg,.finv .finv-neg{color:#C62828;}',
    '.finv .finv-sub{font-size:11px;color:#8A94A6;margin-top:3px;}',
    '.finv #fin-summary{margin-bottom:6px;}',
    '.finv #fin-summary .fin-caption{margin:-6px 0 14px;}',
    // quiet type: sentence case, regular weights, no tracking (crm.css sets the table head in bold capitals with !important)
    '.finv .report-card h3{font-weight:600;}',
    '.finv .report-card thead th{text-transform:none!important;letter-spacing:0!important;font-size:12px!important;font-weight:500!important;color:#8A94A6!important;background:transparent!important;border-bottom:1px solid #E8ECF4!important;}',
    '.finv .report-card tbody td{font-weight:400;letter-spacing:0;color:#1B2A4A;}',
    '.finv .finv-num{white-space:nowrap;font-variant-numeric:tabular-nums;}',
    '.finv .finv-nowrap{white-space:nowrap;text-align:left;}',
    '.finv .finv-quiet{color:#8A94A6;}',
    '.finv .finv-h{font-size:13px;font-weight:600;color:#1B2A4A;margin:20px 0 8px;}',
    '.finv .finv-link{border:none;background:none;padding:0;margin-top:12px;font-size:12px;font-weight:500;color:#5A6685;cursor:pointer;text-decoration:underline;text-underline-offset:3px;}',
    '.finv .finv-how[hidden]{display:none;}',
    '.finv .finv-empty{border:1px dashed #D5DBE8;border-radius:12px;padding:22px 16px;text-align:center;font-size:13px;color:#5A6685;}',
    '.finv .finv-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;vertical-align:1px;}',
    // order value by month: plain columns, never wider than 40px, so one month is a small column and not a wall
    '.finv .finv-months{display:flex;align-items:flex-end;gap:12px;margin:2px 0 18px;overflow-x:auto;}',
    '.finv .finv-month{flex:0 0 auto;min-width:44px;display:flex;flex-direction:column;align-items:center;gap:5px;}',
    '.finv .finv-month b{font-size:11px;font-weight:500;color:#1B2A4A;white-space:nowrap;}',
    '.finv .finv-month i{display:block;width:32px;border-radius:6px 6px 2px 2px;background:#55B685;}',
    '.finv .finv-month span{font-size:11px;color:#8A94A6;white-space:nowrap;}',
    '.finv .finv-bar{display:inline-block;vertical-align:middle;width:110px;max-width:30vw;height:6px;border-radius:6px;background:#EEF2F7;margin-left:10px;overflow:hidden;}',
    '.finv .finv-bar i{display:block;height:100%;border-radius:6px;background:#55B685;}',
    '.finv .finv-stack{display:flex;height:10px;border-radius:10px;overflow:hidden;background:#EEF2F7;margin:2px 0 16px;}',
    // repeat customers by week or month: two columns per bucket (new, returning), the returning count above them
    '.finv .finv-legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:#5A6685;margin:0 0 8px;}',
    '.finv .finv-months[data-chart="repeat"]{gap:6px;}',
    '.finv .finv-pair{display:flex;align-items:flex-end;gap:3px;}',
    '.finv .finv-pair i{width:14px;}',
    '.finv .finv-pair i.finv-c-new{background:#B8C4DC;}',
    '.finv .finv-pair i.finv-c-back{background:#0E9F6E;}',
    '.finv .report-card .finv-total td{font-weight:600;border-top:1px solid #E8ECF4;}',
    '.finv .finv-stack i{display:block;height:100%;}',
    '@media(max-width:768px){',
    '.finv .fin-tiles{grid-template-columns:1fr 1fr;}',
    '.finv .finv-refresh{margin-left:0;}',
    '.finv .finv-seg button{padding:6px 10px;}',
    '}'
  ].join('\n');

  function doc() { return global.document; }
  function esc(s) { return global.esc(s); }
  function money(n) { return global.OrdersModel.formatMoney(n); }
  function pct(share) { return Math.round(Number(share) * 100) + '%'; }
  function pct1(p) { return Math.round(p * 1000) / 10 + '%'; }
  function quiet(text) { return '<span class="finv-quiet">' + esc(text) + '</span>'; }
  function bodyOf(id) { return doc().querySelector('#' + id + ' .fin-body'); }
  function label(p) { return p.name + (p.mg ? ' ' + p.mg : ''); }
  // '2026-10-01' -> 'Oct 1, 2026'; anything else is shown as it came
  function fmtDay(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    return m && MONTHS[m[2] - 1] ? MONTHS[m[2] - 1] + ' ' + Number(m[3]) + ', ' + m[1] : String(s || '');
  }
  function hit(ev, name) {
    for (var t = ev && ev.target; t && t.getAttribute; t = t.parentNode) {
      var v = t.getAttribute(name);
      if (v !== null && v !== undefined) return { el: t, v: v };
    }
    return null;
  }

  /* ── pieces ─────────────────────────────────────────────────────────── */
  // A figure: the cents and the "%" are set smaller and lighter than the number. cls: 'finv-quiet' for words in place
  // of a number, 'finv-neg' for a loss.
  function figure(text, cls) {
    var m = cls === 'finv-quiet' ? null : /^(.*?)(\.\d{2}|%)$/.exec(text);
    return '<div class="tile-value' + (cls ? ' ' + cls : '') + '">' +
      (m ? esc(m[1]) + '<span class="finv-small">' + esc(m[2]) + '</span>' : esc(text)) + '</div>';
  }
  function tile(name, text, valueHtml, sub) {
    return '<div data-tile="' + global.escAttr(name) + '"><div class="tile-label">' + esc(text) + '</div>' +
      (sub ? '<div class="finv-sub">' + esc(sub) + '</div>' : '') + valueHtml + '</div>';
  }
  function table(name, head, rows) {
    return '<div class="fin-table-wrap"><table data-table="' + name + '"><thead><tr>' +
      head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }
  function td(html, num) { return '<td' + (num ? ' class="finv-num"' : '') + '>' + html + '</td>'; }
  function empty(text) { return '<div class="finv-empty">' + esc(text) + '</div>'; }
  function how(id, text) {
    return '<button type="button" class="finv-link" data-finv-how="' + id + '" aria-expanded="' + (open[id] ? 'true' : 'false') + '">How it’s counted</button>' +
      '<p class="fin-note finv-how" id="finv-how-' + id + '"' + (open[id] ? '' : ' hidden') + '>' + esc(text) + '</p>';
  }
  function sourceColor(name, i) { return SOURCE_COLOR[String(name).toLowerCase()] || PALETTE[i % PALETTE.length]; }
  function dot(color) { return '<span class="finv-dot" style="background:' + color + '"></span>'; }

  /* ── the top of the page ────────────────────────────────────────────── */
  function marginTile(name, ctx, m, text) {
    if (ctx.costsError) return figure('cost list not loaded', 'finv-quiet');
    if (!m || m.orders === 0) return figure('no orders', 'finv-quiet');
    if (m.costed === 0) return figure('cost unknown', 'finv-quiet');
    return figure(text, name === 'profit' && m.profit < 0 ? 'finv-neg' : '');
  }

  // rr = FinanceModel.repeatReport(): the Repeat customers tile says what the section's Returning tile says; null = the old count.
  function overview(ctx, aov, m, rep, rr) {
    var partial = m && !ctx.costsError && m.costed > 0 && m.costed < m.orders ? 'cost known for ' + m.costed + ' of ' + m.orders + ' orders' : '';
    return '<div class="fin-tiles" data-tiles="overview">' +
      tile('o-orders', 'Orders', figure(String(aov.orders))) +
      tile('o-value', 'Order value', figure(money(aov.value))) +
      tile('o-average', 'Average order', aov.orders ? figure(money(aov.average)) : figure('no orders', 'finv-quiet')) +
      tile('o-margin', 'Gross margin', marginTile('pct', ctx, m, m && m.pct !== null ? pct1(m.pct) : 'cost unknown'), partial) +
      (rr ? tile('o-repeat', 'Repeat customers', rr.customers ? figure(pct(rr.returningShare)) : figure('no customers', 'finv-quiet'),
        rr.customers ? rr.returning + ' of ' + rr.customers + ' ordered again' : '')
        : tile('o-repeat', 'Repeat customers', rep.customers ? figure(pct(rep.share)) : figure('no customers', 'finv-quiet'),
          rep.customers ? rep.repeat + ' of ' + rep.customers + ' bought twice or more' : '')) +
      '</div><span class="fin-caption">' + esc('Order value = amount due (not cash received) · ' + (ctx.paidOnly ? 'paid orders, ' : 'all orders, ') +
        (PERIOD_TEXT[ctx.period] || ctx.period)) + '</span>';
  }

  /* ── sections ───────────────────────────────────────────────────────── */
  function aovHtml(aov) {
    if (!aov.orders) return empty('No orders in this period');
    var best = aov.byMonth.reduce(function (b, x) { return !b || x.value > b.value ? x : b; }, null);
    var html = '<div class="fin-tiles">' +
      tile('average', 'Average', figure(money(aov.average))) +
      tile('median', 'Median', figure(money(aov.median))) +
      tile('best-month', 'Best month', best ? figure(money(best.value)) : figure('no dated orders', 'finv-quiet'),
        best ? best.label + ', ' + best.orders + (best.orders === 1 ? ' order' : ' orders') : '') +
      '</div>';
    var months = aov.byMonth.slice(-MAX_MONTHS);
    if (months.length > 1) {
      var max = months.reduce(function (s, x) { return Math.max(s, x.value); }, 0);
      html += '<div class="finv-h" style="margin-top:0">Order value by month' + (aov.byMonth.length > MAX_MONTHS ? ' ' + quiet('(last ' + MAX_MONTHS + ')') : '') + '</div>' +
        '<div class="finv-months" data-chart="aov">' + months.map(function (x) {
          return '<div class="finv-month"><b>' + esc(money(x.value)) + '</b><i style="height:' + (max > 0 ? Math.max(2, Math.round(x.value / max * 96)) : 2) + 'px"></i><span>' + esc(x.label) + '</span></div>';
        }).join('') + '</div>';
    }
    return html + table('aov', ['Month', 'Orders', 'Value', 'Average'], aov.byMonth.map(function (x) {
      return '<tr>' + td(esc(x.label)) + td(String(x.orders), true) + td(esc(money(x.value)), true) + td(esc(money(x.average)), true) + '</tr>';
    }));
  }

  function productsHtml(prods, none) {
    if (none) return empty('No orders in this period');
    return table('products', ['Product', 'Units', 'Orders', 'Value', 'Share of units'], prods.map(function (p) {
      return '<tr data-key="' + global.escAttr(p.key) + '">' + td(esc(label(p))) + td(String(p.units), true) + td(String(p.orders), true) + td(esc(money(p.value)), true) +
        td(pct(p.share) + '<span class="finv-bar"><i style="width:' + Math.round(p.share * 100) + '%"></i></span>', true) + '</tr>';
    })) + '<p class="fin-note">Line value = price × qty as saved in the order, before discount and shipping</p>';
  }

  function marginHtml(ctx, m, none) {
    if (ctx.costsError) return '<div class="fin-error">' + esc(ctx.costsError) + '</div>';
    if (none) return empty('No orders in this period');
    var html = '<div class="fin-tiles">' +
      tile('m-revenue', 'Product revenue', marginTile('revenue', ctx, m, money(m.revenue))) +
      tile('m-cost', 'Cost of goods', marginTile('cost', ctx, m, money(m.cost))) +
      tile('m-profit', 'Gross profit', marginTile('profit', ctx, m, money(m.profit))) +
      tile('m-pct', 'Margin', marginTile('pct', ctx, m, m.pct === null ? 'no revenue' : pct1(m.pct))) +
      '</div>';
    html += '<p class="fin-note" data-margin-coverage style="margin-top:0">' +
      esc(m.costed + ' of ' + m.orders + ' orders have a cost for every item; only they are in the totals above.') + '</p>';
    if (m.products.length) {
      html += table('margin', ['Product', 'Units', 'Value', 'Cost', 'Profit', 'Margin', 'Cost basis'], m.products.map(function (p) {
        return '<tr data-key="' + global.escAttr(p.key) + '">' + td(esc(label(p))) + td(String(p.units), true) + td(esc(money(p.value)), true) + td(esc(money(p.cost)), true) +
          td('<span' + (p.profit < 0 ? ' class="finv-neg"' : '') + '>' + esc(money(p.profit)) + '</span>', true) +
          td(p.pct === null ? quiet('no value') : pct1(p.pct), true) + td(COST_BASIS[p.source] ? esc(COST_BASIS[p.source]) : quiet('unknown')) + '</tr>';
      }));
    }
    if (m.missing.length) {
      html += '<div class="finv-h">' + dot('#F59E0B') + 'No cost in the price list</div>' +
        table('margin-missing', ['Product', 'Units', 'Orders'], m.missing.map(function (x) {
          return '<tr data-key="' + global.escAttr(x.key) + '">' + td(esc(label(x))) + td(String(x.units), true) + td(String(x.orders), true) + '</tr>';
        }));
    }
    return html + how('margin', 'Product revenue = amount due minus the shipping and card fee charged (the discount is already in it). ' +
      'Cost = weighted average purchase price of that product across the warehouse purchase orders (orders ship from the warehouse); ' +
      'the supplier POD price where no purchase is recorded. The free solvent vial is included. ' +
      'Not in it: warehouse (Rapid) fees, inbound shipping, COAs and other per-order costs, card fees, ads.');
  }

  function sourcesHtml(srcs, none) {
    if (none) return empty('No orders in this period');
    var colors = srcs.map(function (s, i) { return sourceColor(s.source, i); });
    return '<div class="finv-stack" data-chart="sources">' + srcs.map(function (s, i) {
      return '<i style="width:' + (s.share * 100).toFixed(2) + '%;background:' + colors[i] + '" title="' + global.escAttr(s.source + ' ' + pct(s.share)) + '"></i>';
    }).join('') + '</div>' +
      table('sources', ['Source', 'Orders', 'Value', 'Share of orders'], srcs.map(function (s, i) {
        return '<tr>' + td('<span>' + dot(colors[i]) + esc(s.source) + '</span>') + td(String(s.orders), true) + td(esc(money(s.value)), true) + td(pct(s.share), true) + '</tr>';
      })) + '<p class="fin-note">Source is recorded for orders placed after the shop update (stage B); older orders show what the coupon tells.</p>';
  }

  var REPEAT_LIST_NOTE = 'Customers are matched by e-mail; orders without e-mail are not counted here.';
  function repeatListHtml(rep) {
    return rep.list.length ? table('repeat', ['Name', 'Email', 'Orders', 'Value', 'First', 'Last'], rep.list.map(function (c) {
      return '<tr>' + td(c.name ? esc(c.name) : quiet('no name')) + td(esc(c.email)) + td(String(c.orders), true) + td(esc(money(c.value)), true) +
        td(esc(fmtDay(c.first)), true) + td(esc(fmtDay(c.last)), true) + '</tr>';
    })) : empty('Nobody has bought twice in this period yet');
  }

  // The way the section looked before the repeat report; drawn only while finance-model.js has no repeatReport().
  function repeatHtml(rep, none) {
    if (none) return empty('No orders in this period');
    return '<div class="fin-tiles">' +
      tile('customers', 'Customers', figure(String(rep.customers))) +
      tile('repeat', 'Bought twice or more', figure(String(rep.repeat))) +
      tile('share', 'Share', rep.customers ? figure(pct(rep.share)) : figure('no customers', 'finv-quiet')) +
      '</div>' + repeatListHtml(rep) + '<p class="fin-note">' + REPEAT_LIST_NOTE + '</p>';
  }

  function repeatPair(x, max) {
    function col(v, cls, name) {
      return '<i class="' + cls + '" title="' + global.escAttr(name + ': ' + v) + '" style="height:' + (v > 0 ? Math.max(2, Math.round(v / max * 96)) : 0) + 'px"></i>';
    }
    return '<div class="finv-pair">' + col(x.newCustomers, 'finv-c-new', 'New') + col(x.returning, 'finv-c-back', 'Returning') + '</div>';
  }

  function repeatReportHtml(rr, rep, none) {
    if (none) return empty('No orders in this period');
    if (!rr.customers) return empty('No orders with an e-mail in this period');
    var weekly = rr.bucket === 'week';
    var html = '<div class="fin-tiles">' +
      tile('customers', 'Customers', figure(String(rr.customers)), 'with an order in this period') +
      tile('new', 'New customers', figure(String(rr.newCustomers)), 'first purchase in this period') +
      tile('returning', 'Returning customers', figure(String(rr.returning)), pct(rr.returningShare) + ' of customers ordered again') +
      tile('repeat-revenue', 'Repeat revenue', figure(money(rr.revenueRepeat)), pct(rr.repeatRevenueShare) + ' of order value') +
      '</div>';
    var bars = rr.buckets.slice(-MAX_BARS[rr.bucket]);
    if (!rr.returning) {
      html += empty('Nobody has come back in this period yet');
    } else if (bars.length > 1) {
      var max = bars.reduce(function (s, x) { return Math.max(s, x.newCustomers, x.returning); }, 0);
      html += '<div class="finv-h" style="margin-top:0">Customers by ' + (weekly ? 'week' : 'month') +
        (rr.buckets.length > bars.length ? ' ' + quiet('(last ' + bars.length + ')') : '') + '</div>' +
        '<div class="finv-legend">' + '<span>' + dot(NEW_COLOR) + 'New</span><span>' + dot(BACK_COLOR) + 'Returning</span>' +
        (weekly ? '<span>' + quiet('weeks start on Monday') + '</span>' : '') + '</div>' +
        '<div class="finv-months" data-chart="repeat">' + bars.map(function (x) {
          return '<div class="finv-month"><b>' + x.returning + '</b>' + repeatPair(x, max) + '<span>' + esc(x.label) + '</span></div>';
        }).join('') + '</div>';
    }
    function row(name, x, cls) {
      return '<tr' + (cls ? ' class="' + cls + '"' : '') + ' data-bucket="' + global.escAttr(x.key || 'total') + '"><td class="finv-nowrap">' + name + '</td>' + td(String(x.customers), true) + td(String(x.newCustomers), true) +
        td(String(x.returning), true) + td(String(x.ordersFirst), true) + td(String(x.ordersRepeat), true) + td(esc(money(x.revenueFirst)), true) +
        td(esc(money(x.revenueRepeat)), true) + td(x.revenue > 0 ? pct(x.repeatRevenueShare) : quiet('no orders'), true) + '</tr>';
    }
    html += '<div class="finv-h">By ' + (weekly ? 'week' : 'month') + '</div>' +
      table('repeat-periods', [weekly ? 'Week of' : 'Month', 'Customers', 'New', 'Returning', 'First orders', 'Repeat orders', 'First revenue', 'Repeat revenue', 'Repeat share'],
        rr.buckets.map(function (x) { return row(esc(weekly ? fmtDay(x.key) : x.label), x); }).concat([row('Whole period', rr, 'finv-total')]));
    if (rep.list.length) html += '<div class="finv-h">Customers with two or more orders in this period</div>' + repeatListHtml(rep);
    return html +
      how('repeat', 'A customer is the e-mail on the order; orders without one are not counted. A purchase follows the Paid only switch: on = paid orders, off = every order that is not cancelled. ' +
        'The order number of a customer runs over their whole history, so an order is a repeat one when the customer has any earlier purchase, even before this period. ' +
        'New = first purchase falls in this period. Returning = a second or later order falls in this period. Someone whose first and second order are both in the period is in New and in Returning, so Customers is not New + Returning. ' +
        'Weeks start on Monday, so the first week of a 30 or 90 days period shows only the days inside the period, and the current week only the days so far. ' +
        'Repeat revenue = amount due of second and later orders (not cash received). The Repeat marks on the Orders page count every order, so they match this report with Paid only off.');
  }

  /* ── the period switch ──────────────────────────────────────────────── */
  function byId(id) { return doc().getElementById(id); }
  function change(el) { el.dispatchEvent(new global.Event('change')); }

  function panelHtml() {
    var period = byId('fin-period').value || 'all';
    var paid = !!byId('fin-paid-only').checked;
    return '<div class="finv-seg" role="group" aria-label="Period">' + PERIODS.map(function (p) {
      return '<button type="button" data-finv-period="' + p[0] + '"' + (p[0] === period ? ' class="is-on" aria-pressed="true"' : ' aria-pressed="false"') + '>' + p[1] + '</button>';
    }).join('') + '</div>' +
      '<button type="button" class="finv-switch" role="switch" data-finv-paid="1" aria-checked="' + (paid ? 'true' : 'false') + '"><i></i>Paid only</button>' +
      '<button type="button" class="finv-refresh" data-finv-refresh="1">Refresh</button>';
  }

  function onPanel(ev) {
    var h;
    if ((h = hit(ev, 'data-finv-period'))) {
      var sel = byId('fin-period');
      if (sel.value === h.v) return;
      sel.value = h.v;
      change(sel);                       // the page's own listener saves the choice and redraws
    } else if (hit(ev, 'data-finv-paid')) {
      var box = byId('fin-paid-only');
      box.checked = !box.checked;
      change(box);
    } else if (hit(ev, 'data-finv-refresh')) {
      byId('fin-refresh').click();
    }
  }

  function onContent(ev) {
    var h = hit(ev, 'data-finv-how');
    if (!h) return;
    open[h.v] = !open[h.v];
    byId('finv-how-' + h.v).hidden = !open[h.v];
    if (h.el.setAttribute) h.el.setAttribute('aria-expanded', open[h.v] ? 'true' : 'false');
  }

  // Builds the switch once and keeps it in step with the page's hidden controls (the page restores the saved period itself).
  function panel() {
    var p = doc().querySelector('.fin-panel');
    if (!p) return;
    if (!styled) {
      var s = doc().createElement('style');
      s.textContent = CSS;
      doc().head.appendChild(s);
      styled = true;
    }
    if (!p._finv) {
      var ctl = doc().createElement('div');
      ctl.className = 'finv-ctl';
      ctl.addEventListener('click', onPanel);
      p.appendChild(ctl);
      p._finv = ctl;
      var content = p.parentNode;
      if (content) {
        if (content.classList) content.classList.add('finv');
        content.addEventListener('click', onContent);
      }
    }
    p._finv.innerHTML = panelHtml();
  }

  /* ── the page calls this instead of drawing the sections itself ─────── */
  // ctx: { orders: OrdersModel.load() list, period, paidOnly, costIdx, costsError, now }
  function render(ctx) {
    panel();
    var selected = FM.select(ctx.orders, { period: ctx.period, paidOnly: ctx.paidOnly, now: ctx.now || new Date() });
    var aov = FM.aov(selected);
    var none = aov.orders === 0;
    var m = ctx.costIdx && !ctx.costsError ? FM.margin(selected, ctx.costIdx) : null;
    var rep = FM.repeat(selected);
    // The report numbers a customer's orders over the whole list, not over the selected period.
    var rr = null, repeatSection;
    try {
      if (typeof FM.repeatReport === 'function') rr = FM.repeatReport(ctx.orders, { period: ctx.period, paidOnly: ctx.paidOnly, now: ctx.now || new Date() });
      repeatSection = rr ? repeatReportHtml(rr, rep, none) : repeatHtml(rep, none);
    } catch (e) { console.error(e); rr = null; repeatSection = repeatHtml(rep, none); }   // the old count and the old section stand in: a failing report or its drawing must not take the page down
    byId('fin-summary').innerHTML = overview(ctx, aov, m, rep, rr);
    bodyOf('fin-aov').innerHTML = aovHtml(aov);
    bodyOf('fin-products').innerHTML = productsHtml(FM.products(selected, { top: 20 }), none);
    bodyOf('fin-margin').innerHTML = marginHtml(ctx, m || FM.margin(selected, null), none);
    bodyOf('fin-sources').innerHTML = sourcesHtml(FM.sources(selected), none);
    bodyOf('fin-repeat').innerHTML = repeatSection;
  }

  global.FinanceView = { render: render, panel: panel };
  // The switch is there before the orders arrive: the page's own select must not flash on load.
  if (global.document && global.document.addEventListener) global.document.addEventListener('DOMContentLoaded', panel);
})(typeof window !== 'undefined' ? window : global);
