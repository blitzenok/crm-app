'use strict';
/**
 * Ad spend & ROAS - pure aggregators for the Finance Reports section (2026-10-01).
 * Spend comes from GET /api/marketing/spend (entries with amountCents), orders from OrdersModel.load(); this file only
 * reads both and never writes. Spec: docs/superpowers/specs/2026-10-01-ad-spend-roas.md
 * Needs FinanceModel (select, sourceOf, whenOf, margin); money is integer cents inside, dollars only at the edge.
 */
(function (global) {
  var FM = (typeof window !== 'undefined' && window.FinanceModel)
    || (typeof global !== 'undefined' && global.FinanceModel)
    || (typeof require === 'function' ? require('./finance-model.js') : null);

  // The sources the form offers for a spend. Meta is one group: a click from Facebook or Instagram (utm_source fb, ig, facebook,
  // instagram) and a bare fbclid (source "meta") are all Meta traffic, and the ad platform bills them together, so a spend filed under
  // meta collects the orders of meta, facebook and instagram. Google has only one label in products-api (gads, google-ads and
  // adwords are all stored as "google"). "direct" is not offered: nobody pays for it.
  var SOURCE_OPTIONS = [
    { value: 'google', label: 'Google' },
    { value: 'meta', label: 'Meta (facebook, instagram, fbclid)' },
    { value: 'tiktok', label: 'TikTok' },
    { value: 'newsletter', label: 'Newsletter' }
  ];
  var GROUP = { facebook: 'meta', instagram: 'meta' };

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function localDay(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function slugKey(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }
  function cents(n) { return Math.round(Number(n) * 100); }
  function capital(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  function grouped(key) { return GROUP[key] || key; }
  // The key an order's source and a spend entry's source share. Orders: finance-model's label; "Direct" and "Not recorded"
  // are one row, because an order with no trail cannot be told from a direct visit.
  function orderKey(r) {
    var label = FM.sourceOf(r);
    if (label === 'Direct' || label === 'Not recorded') return 'direct';
    return grouped(slugKey(label) || 'direct');
  }
  function spendKey(entry) {
    var s = String((entry && entry.source) || '');
    if (s.slice(0, 6) === 'other:') s = s.slice(6);
    return grouped(slugKey(s) || 'direct');
  }
  function labelOf(key, seen) {
    if (key === 'direct') return 'Direct / unknown';
    for (var i = 0; i < SOURCE_OPTIONS.length; i++) if (SOURCE_OPTIONS[i].value === key) return SOURCE_OPTIONS[i].label;
    return (seen && seen[key]) || capital(key);
  }

  // [from, to] of the entries to fetch for a period preset, YYYY-MM-DD local days; '' = no bound. Orders use an instant for
  // 30d/90d, spend has days: the day of "now minus 30 days" is the first day counted.
  function periodRange(period, now) {
    var n = now ? new Date(now) : new Date();
    if (period === '30d' || period === '90d') return { from: localDay(new Date(n.getTime() - (period === '30d' ? 30 : 90) * 86400000)), to: '' };
    if (period === 'ytd') return { from: n.getFullYear() + '-01-01', to: '' };
    return { from: '', to: '' };
  }

  function inRange(day, range) { return (!range.from || day >= range.from) && (!range.to || day <= range.to); }

  // A customer is new in the period when their first paid order in the whole history falls in it; the source is that
  // order's. Orders without an e-mail cannot be recognised and are not counted as new.
  function newCustomerOrders(allOrders, opts) {
    var paid = FM.select(allOrders, { period: 'all', paidOnly: true, now: opts.now });
    var first = Object.create(null), keys = [];
    paid.forEach(function (r) {
      var email = String(r.email || '').trim().toLowerCase();
      if (!email) return;
      var t = FM.whenOf(r);
      if (Number.isNaN(t)) return;
      var cur = first[email];
      if (!cur) { first[email] = { r: r, t: t }; keys.push(email); } else if (t < cur.t) { cur.r = r; cur.t = t; }
    });
    var firsts = keys.map(function (k) { return first[k].r; });
    return FM.select(firsts, { period: opts.period, paidOnly: false, now: opts.now });
  }

  /**
   * opts: { orders: OrdersModel.load() list (all periods), spend: entries of the period, period, paidOnly, now, costIdx }
   * -> { rows, total, marginKnown, costed, ordersCount }
   */
  function build(opts) {
    opts = opts || {};
    var period = opts.period || 'all';
    var now = opts.now ? new Date(opts.now) : new Date();
    var range = periodRange(period, now);
    var selected = FM.select(opts.orders, { period: period, paidOnly: !!opts.paidOnly, now: now });
    var news = newCustomerOrders(opts.orders, { period: period, now: now });
    var map = Object.create(null), seen = Object.create(null), keys = [];
    function row(key) {
      var e = map[key];
      if (!e) { e = map[key] = { key: key, spendC: 0, list: [], newCustomers: 0 }; keys.push(key); }
      return e;
    }
    (Array.isArray(opts.spend) ? opts.spend : []).forEach(function (s) {
      if (!s || s.deleted || typeof s.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s.date) || !inRange(s.date, range)) return;
      var c = Number(s.amountCents);
      if (!(c > 0) || c !== Math.floor(c)) return;
      row(spendKey(s)).spendC += c;
    });
    selected.forEach(function (r) {
      var k = orderKey(r);
      var label = FM.sourceOf(r);
      if (k !== 'direct' && !seen[k]) seen[k] = label;
      row(k).list.push(r);
    });
    news.forEach(function (r) { row(orderKey(r)).newCustomers++; });

    var marginOn = !!opts.costIdx;
    var rows = keys.map(function (k) {
      var e = map[k];
      var revenueC = e.list.reduce(function (s, r) { return s + cents(r.toPay || 0); }, 0);
      var m = marginOn && e.list.length ? FM.margin(e.list, opts.costIdx) : null;
      var profitC = null;
      if (marginOn && !e.list.length) profitC = 0;
      else if (m && m.costed > 0) profitC = cents(m.profit);
      return {
        key: k, label: labelOf(k, seen), spendC: e.spendC, orders: e.list.length, revenueC: revenueC, newCustomers: e.newCustomers,
        cacC: e.spendC > 0 && e.newCustomers > 0 ? Math.round(e.spendC / e.newCustomers) : null,
        roas: e.spendC > 0 ? revenueC / e.spendC : null,
        profitC: profitC, costed: m ? m.costed : 0,
        afterAdsC: profitC === null ? null : profitC - e.spendC
      };
    });
    rows.sort(function (a, b) { return b.spendC - a.spendC || b.revenueC - a.revenueC || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0); });

    var marginPartial = false;
    // Sum of rows. A row with orders but no costed order has profit null: it adds nothing, and the sum is partial (costed < orders).
    function sum(list, label) {
      var t = { label: label, spendC: 0, orders: 0, revenueC: 0, newCustomers: 0, profitC: 0, costed: 0 };
      list.forEach(function (r) {
        t.spendC += r.spendC; t.orders += r.orders; t.revenueC += r.revenueC; t.newCustomers += r.newCustomers; t.costed += r.costed;
        if (r.profitC !== null) t.profitC += r.profitC;
      });
      t.cacC = t.spendC > 0 && t.newCustomers > 0 ? Math.round(t.spendC / t.newCustomers) : null;
      t.roas = t.spendC > 0 ? t.revenueC / t.spendC : null;
      if (!marginOn) { t.profitC = null; t.afterAdsC = null; } else t.afterAdsC = t.profitC - t.spendC;
      if (marginOn && t.costed < t.orders) marginPartial = true;
      return t;
    }
    var total = sum(rows, 'Total');
    var paidChannels = sum(rows.filter(function (r) { return r.spendC > 0; }), 'Paid channels');
    return { rows: rows, total: total, paidChannels: paidChannels, marginOn: marginOn, marginPartial: marginPartial, range: range };
  }

  var api = { SOURCE_OPTIONS: SOURCE_OPTIONS, periodRange: periodRange, build: build,
    orderKey: orderKey, spendKey: spendKey, newCustomerOrders: newCustomerOrders };
  global.AdSpendModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
