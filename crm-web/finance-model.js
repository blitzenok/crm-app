'use strict';
/**
 * Finance Reports — pure aggregators over OrdersModel.load() records.
 * Spec: docs/superpowers/specs/2026-09-21-crm-nav-finance.md §4.2
 */
(function (global) {
  var OM = (typeof window !== 'undefined' && window.OrdersModel)
    || (typeof global !== 'undefined' && global.OrdersModel)
    || (typeof require === 'function' ? require('./orders-model.js') : null);

  var DAY = 86400000;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var KNOWN_SOURCE = {
    google: 'Google',
    instagram: 'Instagram',
    facebook: 'Facebook',
    tiktok: 'TikTok',
    newsletter: 'Newsletter',
    direct: 'Direct'
  };

  function cents(n) { return Math.round(Number(n) * 100); }
  function money2(n) { return Math.round(Number(n) * 100) / 100; }
  function fold(s) { return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').trim(); }

  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  function whenOf(r) {
    var s = r && r.createdAt;
    // A bare date has no instant: read it as a local calendar day so ytd/byMonth (local) do not shift it a day west of UTC.
    var m = typeof s === 'string' ? DATE_ONLY.exec(s) : null;
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    return OM.whenMs(s);
  }

  function inPeriod(r, period, now) {
    if (period === 'all' || !period) return true;
    var t = whenOf(r);
    if (Number.isNaN(t)) return false;
    if (period === '30d') return t >= now.getTime() - 30 * DAY;
    if (period === '90d') return t >= now.getTime() - 90 * DAY;
    if (period === 'ytd') return t >= new Date(now.getFullYear(), 0, 1).getTime();
    return true;
  }

  function select(list, opts) {
    opts = opts || {};
    var period = opts.period || 'all';
    var paidOnly = !!opts.paidOnly;
    var includeCancelled = opts.includeCancelled === true;
    var now = opts.now ? new Date(opts.now) : new Date();
    var src = Array.isArray(list) ? list : [];
    return src.filter(function (r) {
      if (!r || r.kind !== 'order' || r.duplicateOf || r.isTest) return false;
      if (!includeCancelled && r.group === 'cancelled') return false;
      if (paidOnly) {
        var code = OM.paymentStatus(r).code;
        if (code !== 'paid' && code !== 'partial') return false;
      }
      return inPeriod(r, period, now);
    });
  }

  function aov(list) {
    var src = Array.isArray(list) ? list : [];
    var orders = src.length;
    var value = src.reduce(function (s, r) { return s + cents(r.toPay || 0); }, 0) / 100;
    var average = orders ? money2(value / orders) : 0;
    var cs = src.map(function (r) { return cents(r.toPay || 0); }).sort(function (a, b) { return a - b; });
    var medianC = 0;
    if (cs.length) {
      var mid = Math.floor(cs.length / 2);
      medianC = cs.length % 2 ? cs[mid] : Math.round((cs[mid - 1] + cs[mid]) / 2);
    }
    var byMonthMap = {};
    src.forEach(function (r) {
      var t = whenOf(r);
      if (Number.isNaN(t)) return;
      var d = new Date(t);
      var y = d.getFullYear(), m = d.getMonth();
      var ym = y + '-' + String(m + 1).padStart(2, '0');
      var e = byMonthMap[ym];
      if (!e) { e = { ym: ym, y: y, m: m, orders: 0, valueC: 0 }; byMonthMap[ym] = e; }
      e.orders++;
      e.valueC += cents(r.toPay || 0);
    });
    var byMonth = Object.keys(byMonthMap).map(function (k) { return byMonthMap[k]; })
      .sort(function (a, b) { return a.y - b.y || a.m - b.m; })
      .map(function (e) {
        return {
          ym: e.ym,
          label: MON[e.m] + ' ' + e.y,
          orders: e.orders,
          value: e.valueC / 100,
          average: e.orders ? money2(e.valueC / 100 / e.orders) : 0
        };
      });
    return { orders: orders, value: value, average: average, median: medianC / 100, byMonth: byMonth };
  }

  function productKey(i) {
    var slug = String(i.slug || '').trim();
    if (slug) return slug;
    // Spec §4.2: an empty name displays as "Unnamed item" and the key is folded from that same name.
    return fold(productName(i) + ' ' + String(i.mg || ''));
  }

  function productName(i) {
    var n = String(i.name || '').trim();
    return n || 'Unnamed item';
  }

  function products(list, opts) {
    var src = Array.isArray(list) ? list : [];
    var top = (opts && opts.top) || 20;
    var map = Object.create(null);
    var keys = [];
    src.forEach(function (r, idx) {
      var items = Array.isArray(r.items) ? r.items : [];
      var orderId = r.id != null && r.id !== '' ? String(r.id) : '#' + idx; // id = ref || raw.id (orders-model); index keeps id-less records apart
      items.forEach(function (i) {
        var key = productKey(i);
        var e = map[key];
        if (!e) {
          e = { key: key, name: productName(i), mg: String(i.mg || '').trim(), units: 0, valueC: 0, orderSet: Object.create(null) };
          map[key] = e;
          keys.push(key);
        }
        e.units += i.qty || 0;
        e.valueC += cents(i.sum || 0);
        e.orderSet[orderId] = 1;
      });
    });
    var rows = keys.map(function (k) {
      var e = map[k];
      return { key: e.key, name: e.name, mg: e.mg, units: e.units, valueC: e.valueC, orders: Object.keys(e.orderSet).length, orderSet: e.orderSet };
    });
    rows.sort(function (a, b) { return b.units - a.units || b.valueC - a.valueC; });
    var totalUnits = rows.reduce(function (s, r) { return s + r.units; }, 0);
    var out = rows;
    if (rows.length > top) {
      var head = rows.slice(0, top);
      var rest = rows.slice(top);
      var otherUnits = rest.reduce(function (s, r) { return s + r.units; }, 0);
      var otherValueC = rest.reduce(function (s, r) { return s + r.valueC; }, 0);
      var otherOrders = Object.create(null);
      rest.forEach(function (r) {
        Object.keys(r.orderSet).forEach(function (id) { otherOrders[id] = 1; });
      });
      out = head.concat([{ key: 'other', name: 'Other', mg: '', units: otherUnits, valueC: otherValueC, orders: Object.keys(otherOrders).length, orderSet: otherOrders }]);
    }
    return out.map(function (r) {
      return { key: r.key, name: r.name, mg: r.mg, units: r.units, orders: r.orders, value: r.valueC / 100, share: totalUnits ? r.units / totalUnits : 0 };
    });
  }

  function sourceOf(r) {
    var src = r && r.attribution && r.attribution.source ? String(r.attribution.source).trim() : '';
    var lower = src.toLowerCase();
    if (src && lower !== 'direct') {
      if (Object.prototype.hasOwnProperty.call(KNOWN_SOURCE, lower)) return KNOWN_SOURCE[lower];
      return src.charAt(0).toUpperCase() + src.slice(1);
    }
    var coupon = r && r.coupon ? String(r.coupon).trim() : '';
    if (coupon) {
      var upper = coupon.toUpperCase();
      if (upper.indexOf('WELCOME') === 0) return 'Newsletter signup';
      if (upper.indexOf('INSIDER') === 0 || upper.indexOf('VIP') === 0) return 'VIP signup';
      return 'Coupon: ' + coupon;
    }
    if (lower === 'direct') return 'Direct';
    return 'Not recorded';
  }

  function sources(list) {
    var src = Array.isArray(list) ? list : [];
    var map = Object.create(null);
    var order = [];
    src.forEach(function (r) {
      var key = sourceOf(r);
      var e = map[key];
      if (!e) { e = { source: key, orders: 0, valueC: 0 }; map[key] = e; order.push(key); }
      e.orders++;
      e.valueC += cents(r.toPay || 0);
    });
    var total = src.length;
    var rows = order.map(function (k) {
      var e = map[k];
      return { source: e.source, orders: e.orders, value: e.valueC / 100, share: total ? e.orders / total : 0 };
    });
    rows.sort(function (a, b) {
      if (a.source === 'Not recorded') return -1;
      if (b.source === 'Not recorded') return 1;
      return b.orders - a.orders || b.value - a.value || (a.source < b.source ? -1 : a.source > b.source ? 1 : 0);
    });
    return rows;
  }

  function ymd(r) {
    return String((r && r.createdAt) || '').slice(0, 10);
  }

  function repeat(list) {
    var src = Array.isArray(list) ? list : [];
    var map = Object.create(null);
    var emails = [];
    src.forEach(function (r) {
      var email = String((r && r.email) || '').trim().toLowerCase();
      if (!email) return;
      var e = map[email];
      if (!e) {
        e = { email: email, name: r.name || '', orders: 0, valueC: 0, first: '', last: '', firstMs: NaN, lastMs: NaN };
        map[email] = e;
        emails.push(email);
      }
      e.orders++;
      e.valueC += cents(r.toPay || 0);
      var t = whenOf(r);
      var day = ymd(r);
      if (!Number.isNaN(t)) {
        if (Number.isNaN(e.firstMs) || t < e.firstMs) { e.firstMs = t; e.first = day; }
        if (Number.isNaN(e.lastMs) || t > e.lastMs) { e.lastMs = t; e.last = day; }
      }
    });
    var all = emails.map(function (k) { return map[k]; });
    var repeatList = all.filter(function (e) { return e.orders >= 2; })
      .sort(function (a, b) { return b.orders - a.orders || b.valueC - a.valueC; })
      .map(function (e) {
        return { email: e.email, name: e.name, orders: e.orders, value: e.valueC / 100, first: e.first, last: e.last };
      });
    return {
      customers: all.length,
      repeat: repeatList.length,
      share: all.length ? repeatList.length / all.length : 0,
      list: repeatList
    };
  }

  // Repeat report (2026-10-02): first purchase vs second-and-later purchases of the same buyer, per period and per time bucket.
  // The buyer is the e-mail (trimmed, lower-cased); orders without one are not counted. A purchase is what select() lets through:
  // a primary order, not a copy or a test, not cancelled, and with opts.paidOnly only paid or partly paid ones. The order number
  // of a buyer is taken over the whole history (period "all"), so an order in the period is a repeat one when the buyer has any
  // earlier purchase, even outside the period. Orders without a readable date come after the dated ones (as RepeatBuyer.numbers
  // on orders.html); they count in the period totals only for period "all" and sit in no bucket.
  // A buyer whose first and second purchase both fall in the period is counted in newCustomers and in returning, so
  // customers is not newCustomers + returning. Money is summed in cents and given in dollars, like the other aggregators.
  function repeatBucketStart(t, bucket) {
    var d = new Date(t);
    if (bucket === 'month') return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - (d.getDay() + 6) % 7).getTime();   // Monday
  }

  function repeatBucketNext(ms, bucket) {
    var d = new Date(ms);
    if (bucket === 'month') return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime();
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 7).getTime();
  }

  function repeatTally() {
    return { cust: Object.create(null), fresh: Object.create(null), back: Object.create(null), of: 0, or: 0, rf: 0, rr: 0 };
  }

  function repeatAdd(t, o) {
    t.cust[o.email] = 1;
    if (o.n === 1) { t.fresh[o.email] = 1; t.of++; t.rf += o.c; }
    else { t.back[o.email] = 1; t.or++; t.rr += o.c; }
  }

  function repeatFinish(t, extra) {
    var customers = Object.keys(t.cust).length;
    var returning = Object.keys(t.back).length;
    var total = t.rf + t.rr;
    var out = {
      customers: customers,
      newCustomers: Object.keys(t.fresh).length,
      returning: returning,
      ordersFirst: t.of,
      ordersRepeat: t.or,
      revenueFirst: t.rf / 100,
      revenueRepeat: t.rr / 100,
      revenue: total / 100,
      repeatRevenueShare: total ? t.rr / total : 0,
      returningShare: customers ? returning / customers : 0
    };
    Object.keys(extra || {}).forEach(function (k) { out[k] = extra[k]; });
    return out;
  }

  // opts: { period: '30d' | '90d' | 'ytd' | 'all', paidOnly, now, bucket: 'week' | 'month' } (bucket defaults to week for 30d/90d, month otherwise).
  function repeatReport(list, opts) {
    opts = opts || {};
    var period = opts.period || 'all';
    var now = opts.now ? new Date(opts.now) : new Date();
    var bucket = opts.bucket === 'week' || opts.bucket === 'month' ? opts.bucket : (period === '30d' || period === '90d' ? 'week' : 'month');
    var history = select(list, { period: 'all', paidOnly: !!opts.paidOnly, now: now });
    var byEmail = Object.create(null);
    history.forEach(function (r, i) {
      var email = String((r && r.email) || '').trim().toLowerCase();
      if (!email) return;
      (byEmail[email] || (byEmail[email] = [])).push({ r: r, i: i, t: whenOf(r) });
    });
    var inside = [];
    Object.keys(byEmail).forEach(function (email) {
      byEmail[email].sort(function (a, b) {
        var an = Number.isNaN(a.t), bn = Number.isNaN(b.t);
        if (an !== bn) return an ? 1 : -1;
        return (an ? 0 : a.t - b.t) || a.i - b.i;
      }).forEach(function (e, pos) {
        if (inPeriod(e.r, period, now)) inside.push({ email: email, n: pos + 1, t: e.t, c: cents(e.r.toPay || 0) });
      });
    });

    // The axis ends with the bucket of today; an order dated later (a typo in the date) goes into that last bucket, so a wrong
    // year cannot stretch the axis into hundreds of empty buckets.
    var stop = repeatBucketStart(now.getTime(), bucket);
    var total = repeatTally();
    var cells = Object.create(null);
    var firstT = NaN;
    inside.forEach(function (o) {
      repeatAdd(total, o);
      if (Number.isNaN(o.t)) return;
      if (Number.isNaN(firstT) || o.t < firstT) firstT = o.t;
      var b = Math.min(repeatBucketStart(o.t, bucket), stop);
      repeatAdd(cells[b] || (cells[b] = repeatTally()), o);
    });

    // A continuous axis: from the start of the period (the first order for "all") to the bucket of today.
    var buckets = [];
    if (!Number.isNaN(firstT)) {
      var from = period === '30d' ? now.getTime() - 30 * DAY : period === '90d' ? now.getTime() - 90 * DAY
        : period === 'ytd' ? new Date(now.getFullYear(), 0, 1).getTime() : firstT;
      for (var ms = Math.min(repeatBucketStart(Math.min(from, firstT), bucket), stop); ms <= stop; ms = repeatBucketNext(ms, bucket)) {
        var d = new Date(ms);
        var y = d.getFullYear(), m = d.getMonth();
        var key = y + '-' + String(m + 1).padStart(2, '0') + (bucket === 'month' ? '' : '-' + String(d.getDate()).padStart(2, '0'));
        var label = bucket === 'month' ? MON[m] + ' ' + y : MON[m] + ' ' + d.getDate();
        buckets.push(repeatFinish(cells[ms] || repeatTally(), { key: key, label: label, start: ms }));
      }
    }
    return repeatFinish(total, { period: period, bucket: bucket, buckets: buckets });
  }

  // Gross margin (2026-09-30). Unit costs come from GET /api/unit-costs ({ items: [{ id, cost, source, match: [{ slug, mg }] }] }):
  // source 'purchase' = weighted average purchase price of the warehouse stock (orders ship from the warehouse), 'pod' = the
  // supplier's POD price where no purchase is recorded. A line is matched by slug + strength only; a strength missing from
  // the list is reported as missing, never guessed from a neighbour.
  function mgKey(mg) { return String(mg || '').toLowerCase().replace(/\s+/g, ''); }
  function slugKey(slug) { return String(slug || '').trim().toLowerCase(); }

  function costIndex(data) {
    var map = new Map();
    var items = data && Array.isArray(data.items) ? data.items : [];
    items.forEach(function (row) {
      if (!row || typeof row !== 'object') return;
      var cost = Number(row.cost);
      if (typeof row.cost !== 'number' || !(cost > 0) || !Array.isArray(row.match)) return;
      row.match.forEach(function (m) {
        if (!m || !slugKey(m.slug) || !mgKey(m.mg)) return;
        map.set(slugKey(m.slug) + '|' + mgKey(m.mg), { unit: cost, id: String(row.id || ''), source: typeof row.source === 'string' ? row.source : '' });
      });
    });
    return map;
  }

  function itemCost(i, index) {
    var slug = slugKey(i && i.slug);
    if (!slug || !index || typeof index.get !== 'function') return null;
    var hit = index.get(slug + '|' + mgKey(i.mg));
    return hit ? { unit: hit.unit, id: hit.id, source: hit.source } : null;
  }

  // Product revenue of an order = amount due minus the shipping and card fee it charged (their cost to us is unknown,
  // so both sides leave them out); the discount is already inside the amount due. Only orders whose every line has a
  // cost go into the totals; product rows count every costed line.
  function margin(list, index) {
    var src = Array.isArray(list) ? list : [];
    var rows = Object.create(null), rowKeys = [];
    var miss = Object.create(null), missKeys = [];
    var costed = 0, revenueC = 0, costC = 0;
    src.forEach(function (r, idx) {
      var items = Array.isArray(r && r.items) ? r.items : [];
      var orderId = r && r.id != null && r.id !== '' ? String(r.id) : '#' + idx;
      var orderCostC = 0, complete = items.length > 0;
      items.forEach(function (i) {
        var c = itemCost(i, index);
        var qty = i.qty || 0;
        if (!c) {
          complete = false;
          var mk = slugKey(i.slug) ? slugKey(i.slug) + '|' + mgKey(i.mg) : productKey(i);
          var me = miss[mk];
          if (!me) { me = miss[mk] = { key: mk, name: productName(i), mg: String(i.mg || '').trim(), units: 0, orderSet: Object.create(null) }; missKeys.push(mk); }
          me.units += qty;
          me.orderSet[orderId] = 1;
          return;
        }
        var lineCostC = cents(c.unit * qty);
        orderCostC += lineCostC;
        var key = slugKey(i.slug) + '|' + mgKey(i.mg);
        var e = rows[key];
        if (!e) { e = rows[key] = { key: key, id: c.id, source: c.source, name: productName(i), mg: String(i.mg || '').trim(), units: 0, valueC: 0, costC: 0 }; rowKeys.push(key); }
        e.units += qty;
        e.valueC += cents(i.sum || 0);
        e.costC += lineCostC;
      });
      if (!complete) return;
      costed++;
      costC += orderCostC;
      revenueC += Math.max(0, cents(r.toPay || 0) - cents(r.shipCost || 0) - cents(r.cardFee || 0));
    });
    var products = rowKeys.map(function (k) {
      var e = rows[k];
      var profitC = e.valueC - e.costC;
      return { key: e.key, id: e.id, source: e.source, name: e.name, mg: e.mg, units: e.units, value: e.valueC / 100, cost: e.costC / 100,
        profit: profitC / 100, pct: e.valueC > 0 ? profitC / e.valueC : null };
    }).sort(function (a, b) { return b.profit - a.profit || b.units - a.units; });
    var missing = missKeys.map(function (k) {
      var e = miss[k];
      return { key: e.key, name: e.name, mg: e.mg, units: e.units, orders: Object.keys(e.orderSet).length };
    }).sort(function (a, b) { return b.units - a.units || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); });
    var profitC = revenueC - costC;
    return { orders: src.length, costed: costed, revenue: revenueC / 100, cost: costC / 100, profit: profitC / 100,
      pct: revenueC > 0 ? profitC / revenueC : null, products: products, missing: missing };
  }

  var api = { select: select, aov: aov, products: products, sources: sources, sourceOf: sourceOf, repeat: repeat, whenOf: whenOf,
    costIndex: costIndex, itemCost: itemCost, margin: margin };
  api.repeatReport = repeatReport;
  global.FinanceModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
