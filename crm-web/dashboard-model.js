'use strict';
/**
 * Shop dashboard aggregators over OrdersModel.load() records.
 * Spec: docs/superpowers/specs/2026-09-21-crm-dashboard.md §2.1
 */
(function (global) {
  var OM = (typeof window !== 'undefined' && window.OrdersModel)
    || (typeof global !== 'undefined' && global.OrdersModel)
    || (typeof require === 'function' ? require('./orders-model.js') : null);
  var FM = (typeof window !== 'undefined' && window.FinanceModel)
    || (typeof global !== 'undefined' && global.FinanceModel)
    || (typeof require === 'function' ? require('./finance-model.js') : null);

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var STATUS_LABELS = {
    unpaid: 'Awaiting payment',
    toship: 'To ship',
    shipped: 'Shipped',
    delivered: 'Delivered',
    cancelled: 'Cancelled',
    other: 'Other'
  };
  var PERIODS = ['30d', '90d', 'ytd', 'all'];

  function cents(n) { return Math.round(Number(n) * 100); }
  function money2(n) { return Math.round(Number(n) * 100) / 100; }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function periodOf(p) {
    return PERIODS.indexOf(p) >= 0 ? p : '30d';
  }
  function nowOf(n) {
    return n instanceof Date && !Number.isNaN(n.getTime()) ? n : new Date();
  }
  function countOf(n, fallback) {
    return typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : fallback;
  }
  function codeOf(r) { return OM.paymentStatus(r).code; }

  function split(records, opts) {
    opts = opts || {};
    var period = periodOf(opts.period);
    var now = nowOf(opts.now);
    var src = Array.isArray(records) ? records : [];
    var real = src.filter(function (r) {
      return r && r.kind === 'order' && !r.isTest && !r.duplicateOf;
    });
    var inPeriod = FM.select(src, { period: period, paidOnly: false, includeCancelled: true, now: now });
    var active = [];
    var cancelled = [];
    inPeriod.forEach(function (r) {
      if (r.group === 'cancelled') cancelled.push(r);
      else active.push(r);
    });
    var open = real.filter(function (r) { return r.group !== 'cancelled'; });
    return { real: real, active: active, cancelled: cancelled, open: open };
  }

  function tiles(s) {
    s = s || {};
    var active = Array.isArray(s.active) ? s.active : [];
    var cancelled = Array.isArray(s.cancelled) ? s.cancelled : [];
    var open = Array.isArray(s.open) ? s.open : [];
    var paid = active.filter(function (r) {
      var c = codeOf(r);
      return c === 'paid' || c === 'partial';
    });
    var revenue = paid.reduce(function (a, r) { return a + cents(r.toPay || 0); }, 0) / 100;
    var owing = open.filter(function (r) {
      var ps = OM.paymentStatus(r);
      return (ps.code === 'unpaid' || ps.code === 'partial') && ps.refunded === 0;
    });
    var outstanding = owing.reduce(function (a, r) { return a + cents(OM.outstanding(r)); }, 0) / 100;
    var toShip = open.filter(function (r) {
      return codeOf(r) === 'paid' && r.group !== 'shipped' && r.group !== 'delivered';
    });
    return {
      orders: active.length,
      cancelled: cancelled.length,
      revenue: revenue,
      paidCount: paid.length,
      average: paid.length ? money2(revenue / paid.length) : 0,
      outstanding: outstanding,
      owingCount: owing.length,
      toShip: toShip.length
    };
  }

  function months(real, opts) {
    opts = opts || {};
    var now = nowOf(opts.now);
    var count = countOf(opts.count, 6);
    var src = Array.isArray(real) ? real : [];
    var out = [];
    var i, d, y, m, inMonth, live, paid;
    for (i = count - 1; i >= 0; i--) {
      d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      y = d.getFullYear();
      m = d.getMonth();
      inMonth = src.filter(function (r) {
        var t = FM.whenOf(r);
        if (Number.isNaN(t)) return false;
        var rd = new Date(t);
        return rd.getFullYear() === y && rd.getMonth() === m;
      });
      live = inMonth.filter(function (r) { return r.group !== 'cancelled'; });
      paid = live.filter(function (r) {
        var c = codeOf(r);
        return c === 'paid' || c === 'partial';
      });
      out.push({
        ym: y + '-' + pad2(m + 1),
        label: MON[m] + ' ' + y,
        short: MON[m] + (y === now.getFullYear() ? '' : ' \u2019' + String(y).slice(-2)),
        orders: live.length,
        revenue: paid.reduce(function (a, r) { return a + cents(r.toPay || 0); }, 0) / 100
      });
    }
    return out;
  }

  function byStatus(s) {
    s = s || {};
    var active = Array.isArray(s.active) ? s.active : [];
    var cancelled = Array.isArray(s.cancelled) ? s.cancelled : [];
    var all = active.concat(cancelled);
    if (!all.length) return [];
    var counts = {};
    all.forEach(function (r) {
      var g = Object.prototype.hasOwnProperty.call(STATUS_LABELS, r.group) ? r.group : 'other';
      counts[g] = (counts[g] || 0) + 1;
    });
    return Object.keys(STATUS_LABELS).filter(function (k) { return counts[k]; }).map(function (k) {
      return { code: k, label: STATUS_LABELS[k], orders: counts[k], share: counts[k] / all.length };
    });
  }

  function recent(real, opts) {
    opts = opts || {};
    var limit = countOf(opts.limit, 8);
    var src = Array.isArray(real) ? real : [];
    return OM.sortNewestFirst(src).slice(0, limit);
  }

  function build(records, opts) {
    opts = opts || {};
    var period = periodOf(opts.period);
    var now = nowOf(opts.now);
    var s = split(records, { period: period, now: now });
    return {
      period: period,
      tiles: tiles(s),
      months: months(s.real, { now: now, count: countOf(opts.months, 6) }),
      status: byStatus(s),
      products: FM.products(s.active, { top: 5 }),
      sources: FM.sources(s.active),
      recent: recent(s.real, { limit: countOf(opts.recent, 8) })
    };
  }

  var api = {
    STATUS_LABELS: STATUS_LABELS,
    PERIODS: PERIODS,
    split: split,
    tiles: tiles,
    months: months,
    byStatus: byStatus,
    recent: recent,
    build: build
  };
  global.DashboardModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
