/**
 * orders-model.js - the rules of the CRM Orders page (2026-09-17): what an orders.json record is, what it is worth,
 * which status group it is in, what its hints, totals and CSV row say, which records the list shows and in what order.
 * Pure functions: no DOM, no network, no HTML. Shared by orders.html (window.OrdersModel) and the Node tests
 * (module.exports), so a redesign of the page keeps the rules and their tests.
 * Spec: docs/superpowers/specs/2026-09-17-crm-orders-page-design.md, section "Rules".
 */
(function (global) {
  'use strict';

  // products-api accepts exactly these on PATCH /msolpeptides-api/orders/:ref (2026-09-09).
  const API_STATUSES = Object.freeze(['new', 'pending', 'paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered', 'cancelled']);
  const GROUPS = {
    unpaid: ['', 'new', 'pending', 'awaiting payment'],
    toship: ['paid', 'payment-confirmed', 'processing'],
    shipped: ['shipped', 'in-transit'],   // stage 1 RET: in transit is still "shipped" for the cards, the revenue and the filters
    delivered: ['delivered'],
    cancelled: ['cancelled']
  };
  // Money received: the same statuses as products-api ORDER_PAID_STATUSES (Revenue card, "Paid (all)" filter).
  const PAID_GROUPS = ['toship', 'shipped', 'delivered'];
  const STEPS = { 'paid': 2, 'payment-confirmed': 2, 'processing': 3, 'shipped': 4, 'in-transit': 4, 'delivered': 5 };
  // The row's Ship shortcut offers itself from the same statuses as before 2026-09-17, compared lower-cased now.
  const SHIPPABLE = ['', 'new', 'pending', 'confirmed', 'awaiting payment', 'paid', 'payment-confirmed', 'processing'];
  // Stage 1 RET (2026-09-30): the same carrier list as products-api (its tracking link is built from it).
  const CARRIERS = Object.freeze(['FedEx', 'USPS', 'UPS', 'DHL', 'Other']);
  const NEEDS_TRACKING = ['shipped', 'in-transit'];
  const LETTER_ORDER = ['confirmation', 'paid', 'shipped', 'in_transit', 'delivered'];

  // Copied from products-api (MARKETING_TEST_REF_RE, MARKETING_EXCLUDE_*) on purpose: the page hides what the marketing
  // list leaves out. MARKETING_EXCLUDE_PATTERNS is not mirrored - it is unset on the server (2026-09-17).
  const TEST_REF = /^(PROBE|BF-SMOKE|BF-MERGE|BF-CIO-TEST|BF-RENDER|BF-TEXT|BF-QA)/i;
  const TEST_ADDRESSES = ['admin@biolabsresearch.co'];
  const TEST_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.co', 'test.com', 'test', 'invalid', 'localhost'];
  const TEST_LOCAL_PREFIXES = ['smoke-', 'checkout-smoke', 'merge-smoke', 'vip-smoke', 'coupon-only', 'qa-cart', 'qa.test', 'qa-test',
    'probe-', 'probe.', 'probe_', 'render-check', 'text-check'];

  // The live checkout sends the first three codes since 2026-09-16 21:38 UTC; before that every order came as "inquiry".
  // products-api keeps only the code, so any other code is printed as stored.
  const PAYMENT_LABELS = {
    'card-simulation': 'Card (simulated at checkout)',
    'crypto-usdt-trc': 'Crypto USDT/USDC \u00b7 Tron (TRC-20)',
    'crypto-usdt-erc': 'Crypto USDT/USDC \u00b7 Ethereum (ERC-20)',
    'inquiry': 'Agreed with the team (old checkout)',
    'card': 'Card',
    'quote-request': 'Price request (not paid)'
  };
  const WALLETS = { 'crypto-usdt-trc': 'Tron (TRC-20)', 'crypto-usdt-erc': 'Ethereum (ERC-20)' };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  // Only ISO date-times are read: the engine's fallback parser takes '1' or 'Sep 10' for dates in 2001.
  const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

  function has(list, value) { return list.indexOf(value) >= 0; }
  // Tables are looked up by own keys only: a stored code such as "constructor" must not reach Object.prototype.
  function lookup(table, key) { return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : ''; }
  // A number only when present, not blank and finite (products-api orderMoney skips the same, blank strings aside).
  function finite(v) {
    if (v === undefined || v === null || (typeof v === 'string' && !v.trim())) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  // A stored value is read only up to 1e9 in size (fix round 1, 2026-09-17): the public order routes store what they
  // are sent, and one absurd figure must not turn a card into $Infinity. Printed sums may go higher: up to MAX_PRINTED,
  // which stays below 2^46 dollars, where doubles still hold every cent (fix round 3).
  const MAX_AMOUNT = 1000000000;
  const MAX_PRINTED = 70000000000000;
  function num(v) {
    const n = finite(v);
    return n !== null && Math.abs(n) <= MAX_AMOUNT ? n : null;
  }
  // Strings are trimmed; a number is kept as written (a zip or a ref may be stored as one); anything else is empty.
  function text(v) {
    if (typeof v === 'string') return v.trim();
    return typeof v === 'number' && Number.isFinite(v) ? String(v) : '';
  }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  // Whole cents. Below 1e13 dollars toPrecision first, so 1.005 * 100 = 100.49999999999999 still rounds up; from 1e13 on
  // those 15 digits would cut real ones, so the dollars and the fraction are taken apart, both exactly (fix round 2).
  function cents(n) {
    if (Math.abs(n) < 1e13) return Math.round(Number((n * 100).toPrecision(15)));
    const whole = Math.trunc(n);
    return whole * 100 + Math.round((n - whole) * 100);
  }
  function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function isTestRef(ref) { return TEST_REF.test(text(ref)); }
  // Unlike the server, no e-mail at all is not a test mark: orders typed in on the page may have none.
  function isTestAddress(email) {
    const addr = text(email).toLowerCase();
    if (!addr) return false;
    const at = addr.lastIndexOf('@');
    if (at <= 0) return true;
    if (has(TEST_ADDRESSES, addr)) return true;
    const local = addr.slice(0, at), domain = addr.slice(at + 1);
    return TEST_DOMAINS.some(d => domain === d || domain.endsWith('.' + d)) || TEST_LOCAL_PREFIXES.some(p => local.startsWith(p));
  }

  function groupOf(statusRaw) {
    for (const g of Object.keys(GROUPS)) if (has(GROUPS[g], statusRaw)) return g;
    return 'other';
  }
  function lineText(i) { return i.name + (i.mg ? ' ' + i.mg : '') + (i.qty > 1 ? ' \u00d7' + i.qty : ''); }

  // orders.json holds shop checkouts ({ref, customer, items, shipping, server figures}), insider signups (typed or not)
  // and orders typed in on this page ({id, ref, company, email, country, product, qty, price, date}); all become one record.
  function normalize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const cust = obj(raw.customer);
    const shipping = obj(raw.shipping);
    const rawItems = Array.isArray(raw.items) ? raw.items : (text(raw.product) ? [{ name: raw.product, qty: raw.qty, price: raw.price }] : []);
    // A null or a string in items is not a line (products-api never writes one); dropping it keeps the card honest.
    const items = rawItems.filter(i => i && typeof i === 'object').map(i => {
      const q = num(i.qty), p = num(i.price);
      const qty = q !== null && q > 0 ? q : 1, price = p !== null && p >= 0 ? p : 0;
      const line = { name: text(i.name) || text(i.slug), slug: text(i.slug), mg: text(i.mg) || text(i.strength), qty, price, sum: cents(qty * price) / 100 };
      if (i.price_manual === true) line.priceManual = true;
      if (Object.prototype.hasOwnProperty.call(i, 'catalog_price')) line.catalogPrice = num(i.catalog_price);
      return line;
    });
    const ref = text(raw.ref);
    const id = ref || text(raw.id);
    const email = text(cust.email) || text(raw.email);
    let kind = 'empty';
    if (raw.type === 'insider-signup') kind = 'signup';
    else if (id || items.length) kind = 'order';
    else if (email || text(cust.firstName) || text(raw.firstName)) kind = 'signup';

    const company = text(cust.company) || text(raw.company);
    const name = (text(cust.firstName) + ' ' + text(cust.lastName)).trim() || (text(raw.firstName) + ' ' + text(raw.lastName)).trim() || company;
    const ship = { address1: text(shipping.address1), address2: text(shipping.address2), city: text(shipping.city),
      state: text(shipping.state), zip: text(shipping.zip), country: text(shipping.country) };
    const shipLabel = text(shipping.label) || text(shipping.method);
    // The first of shippingCost, shipping.cost that is readable and not negative; products-api clamps shipping at 0 (fix round 2).
    const cost = [num(raw.shippingCost), num(shipping.cost)].find(v => v !== null && v >= 0);
    const shipCost = cost !== undefined ? cost : null;

    const coupon = text(raw.coupon);
    const lines = items.map(lineText);
    const signupText = 'Insider signup' + (coupon ? ' \u00b7 ' + coupon : '');
    const linesSum = items.reduce((s, i) => s + cents(i.sum), 0) / 100;
    const subtotal = num(raw.subtotal);
    const clientSubtotal = subtotal !== null ? subtotal : linesSum;
    const total = num(raw.total);
    const cardFee = num(raw.cardFee);
    const serverTotal = num(raw.total_server);
    const due = num(raw.total_due_server);
    let toPay = null;
    if (kind === 'order') {
      // products-api orderMoney: the first figure the server can stand behind, the browser's total last.
      const first = [due, serverTotal, total].find(v => v !== null && v >= 0);
      // Manual orders carry none of them; the server counts those as 0, the page adds up what the order says.
      // Never below zero, like the server's figure: a negative line or shipping cost must not lower the Pending card.
      // Above the read bound it is 0 (fix round 3): qty and price each read up to 1e9, their product need not stay there.
      const fallback = Math.max(0, cents(clientSubtotal) + cents(shipCost || 0) + cents(cardFee || 0)) / 100;
      toPay = first !== undefined ? first : (fallback > MAX_AMOUNT ? 0 : fallback);
    }
    const stored = typeof raw.status === 'string' ? raw.status.trim() : '';
    const statusRaw = stored.toLowerCase();
    const paymentMethod = text(raw.paymentMethod);

    return {
      kind,
      id,
      // The stored ref alone: products-api PATCH /orders/:ref matches it, so the status select and Ship need it (fix round 1).
      ref,
      name,
      company,
      email,
      phone: text(cust.phone) || text(raw.phone),
      country: text(raw.country) || ship.country,
      isTest: kind === 'order' && (raw.source_ref ? raw.test === true : (raw.test === true || isTestRef(id) || isTestAddress(email))),
      duplicateOf: '',
      rowKey: '',
      items,
      itemsText: kind === 'signup' ? signupText : lines.join(', '),
      itemsShort: kind === 'signup' ? signupText : lines.slice(0, 2).join(' \u00b7 '),
      itemsMore: kind === 'signup' ? 0 : Math.max(0, lines.length - 2),
      qty: items.reduce((s, i) => s + i.qty, 0),
      // The checkout total as stored: the card compares it with To pay (spec "Totals"); clientTotal is the CSV "Total".
      total,
      clientTotal: cents(total !== null ? total : clientSubtotal) / 100,
      clientSubtotal,
      linesSum,
      cardFee,
      shipCost,
      shipLabel,
      ship,
      shipTo: [ship.address1, ship.address2, [ship.city, ship.state, ship.zip].filter(Boolean).join(' '), ship.country].filter(Boolean).join(', '),
      shipMethod: [shipLabel, shipCost !== null ? '$' + shipCost.toFixed(2) : ''].filter(Boolean).join(' \u00b7 '),
      serverSubtotal: num(raw.subtotal_server),
      serverTotal,
      discount: num(raw.discount_server),
      discountPct: num(raw.discount_pct_server),
      discountSource: text(raw.discount_source),
      due,
      toPay,
      priceMismatch: raw.price_mismatch === true,
      unknownItems: Array.isArray(raw.unknown_items) ? raw.unknown_items.map(text).filter(Boolean) : [],
      statusRaw,
      group: kind === 'order' ? groupOf(statusRaw) : kind,
      status: kind === 'signup' ? 'Signup' : (kind === 'order' ? (stored ? capitalise(stored) : 'No status') : ''),
      createdAt: text(raw.savedAt) || text(raw.created_at) || text(raw.timestamp) || text(raw.date) || text(raw.createdAt),
      updatedAt: text(raw.updated_at),
      paymentMethod,
      paymentLabel: paymentLabel(paymentMethod),
      coupon,
      notes: text(raw.notes),
      firstName: text(cust.firstName) || text(raw.firstName),
      lastName: text(cust.lastName) || text(raw.lastName),
      managerNote: text(raw.managerNote),
      trackingNumber: text(raw.trackingNumber),
      carrier: has(CARRIERS, text(raw.carrier)) ? text(raw.carrier) : '',
      letters: obj(raw.letters),
      manualPricing: raw.manual_pricing === true,
      catalogSubtotal: num(raw.catalog_subtotal_server),
      payments: normalizePayments(raw.payments),
      chargeCheck: chargeCheckOf(raw),
      edits: normalizeEdits(raw.edits),
      original: obj(raw.original),
      attribution: { source: text(raw.attribution && raw.attribution.source).slice(0, 40).toLowerCase() },
      hasCopies: false
    };
  }

  function normalizePayments(raw) {
    if (!Array.isArray(raw)) return [];
    const list = raw.filter(p => p && typeof p === 'object' && !Array.isArray(p)).map(p => ({
      id: text(p.id),
      at: text(p.at),
      kind: text(p.kind).toLowerCase() === 'refund' ? 'refund' : 'payment',
      method: text(p.method),
      amount: num(p.amount),
      note: text(p.note),
      by: text(p.by)
    }));
    return list.sort((a, b) => {
      const ta = whenMs(a.at), tb = whenMs(b.at);
      const aOk = !Number.isNaN(ta), bOk = !Number.isNaN(tb);
      if (aOk && bOk) return ta - tb;
      if (aOk) return -1;
      if (bOk) return 1;
      return 0;
    });
  }

  function normalizeEdits(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.filter(e => e && typeof e === 'object' && !Array.isArray(e)).map(e => ({
      at: text(e.at),
      by: text(e.by),
      fields: Array.isArray(e.fields) ? e.fields.map(text).filter(Boolean) : [],
      toPayBefore: text(e.toPayBefore),
      toPayAfter: text(e.toPayAfter),
      itemsBefore: num(e.itemsBefore),
      itemsAfter: num(e.itemsAfter)
    }));
  }

  // products-api PATCH /orders/:ref changes the first record with that ref, so the first one in file order is the order.
  function markDuplicates(list) {
    const counts = Object.create(null);
    list.forEach(r => {
      r.duplicateOf = '';
      r.hasCopies = false;
      if (r.kind !== 'order' || !r.id) return;
      counts[r.id] = (counts[r.id] || 0) + 1;
    });
    const seen = new Set();
    list.forEach(r => {
      if (r.kind !== 'order' || !r.id) return;
      if (counts[r.id] > 1) r.hasCopies = true;
      if (seen.has(r.id)) r.duplicateOf = r.id;
      else seen.add(r.id);
    });
    return list;
  }

  // Keys survive reloads (indexes do not): open rows and focus are found again by them. A signup always takes the
  // e-mail form, even with a ref, so it can never take the "#1" of the order that owns that ref.
  function assignRowKeys(list) {
    const seen = new Map();
    list.forEach(r => {
      r.rowKey = '';
      if (r.kind !== 'order' && r.kind !== 'signup') return;
      const base = r.kind === 'order' && r.id ? r.id : '~' + r.kind + ':' + r.email.toLowerCase();
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      r.rowKey = base + '#' + n;
    });
    return list;
  }

  function load(rawArray) {
    const list = (Array.isArray(rawArray) ? rawArray : []).map(raw => normalize(raw)).filter(Boolean);
    return assignRowKeys(markDuplicates(list));
  }

  // The cards count primary orders that are not test orders; search and filters do not change them.
  function stats(list) {
    const s = { total: 0, cancelled: 0, testCount: 0, duplicateCount: 0, signupCount: 0, pending: 0, pendingAmount: 0,
      shipped: 0, delivered: 0, revenue: 0, paidCount: 0 };
    let pendingCents = 0, revenueCents = 0;
    list.forEach(r => {
      if (r.kind === 'signup') { s.signupCount++; return; }
      if (r.kind !== 'order') return;
      if (r.isTest) { s.testCount++; return; }
      if (r.duplicateOf) { s.duplicateCount++; return; }
      s.total++;
      if (r.group === 'cancelled') s.cancelled++;
      if (r.group === 'unpaid') { s.pending++; pendingCents += cents(outstanding(r)); }
      if (r.group === 'shipped') s.shipped++;
      if (r.group === 'delivered') s.delivered++;
      if (has(PAID_GROUPS, r.group)) { s.paidCount++; revenueCents += cents(r.toPay); }
    });
    s.pendingAmount = pendingCents / 100;
    s.revenue = revenueCents / 100;
    return s;
  }

  function statusMatches(r, status) {
    if (status === 'g:paid') return has(PAID_GROUPS, r.group);
    if (status.indexOf('g:') === 0) return r.group === status.slice(2);
    if (status === 'none') return r.statusRaw === '';
    return r.statusRaw === status;
  }

  // A status filter hides signups and copies, so a pressed card and the list show the same number.
  function filter(list, opts) {
    const f = opts || {};
    const q = text(f.search).toLowerCase();
    const status = text(f.status);
    const product = text(f.product);
    const paymentRaw = text(f.payment);
    const payment = has(['unpaid', 'partial', 'paid', 'refunded'], paymentRaw) ? paymentRaw : '';
    return list.filter(r => {
      if (r.kind === 'empty') return false;
      if (r.kind === 'order' && r.isTest && !f.showTest) return false;
      if (r.kind === 'signup' && !f.showSignups) return false;
      if (status && (r.kind !== 'order' || r.duplicateOf || !statusMatches(r, status))) return false;
      if (payment && (r.kind !== 'order' || r.duplicateOf || paymentStatus(r).code !== payment)) return false;
      if (product && !r.items.some(i => i.name === product)) return false;
      // Fields are joined by a line break so a query cannot match across two of them.
      if (q && [r.id, r.name, r.company, r.email, r.phone, r.itemsText, r.shipTo, r.country].join('\n').toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  // Stored statuses products-api no longer accepts (an old "Confirmed") still get a filter option each. "none" and
  // "g:..." are the page's own option values; a stored status spelled like one is left out rather than doubled (fix round 1).
  function statusOptions(list) {
    const values = [];
    list.forEach(r => {
      const v = r.statusRaw;
      if (r.kind !== 'order' || !v || v === 'none' || v.indexOf('g:') === 0) return;
      if (!has(API_STATUSES, v) && !has(values, v)) values.push(v);
    });
    return values.sort().map(v => ({ value: v, label: capitalise(v) + ' (old)' }));
  }

  function sortNewestFirst(list) {
    return list.map((r, i) => ({ r, i, t: whenMs(r.createdAt) }))
      .sort((a, b) => {
        const an = Number.isNaN(a.t), bn = Number.isNaN(b.t);
        if (an || bn) return an === bn ? a.i - b.i : (an ? 1 : -1);
        return (b.t - a.t) || (a.i - b.i);
      })
      .map(x => x.r);
  }

  function hints(r) {
    const out = [];
    if (!r || r.kind !== 'order') return out;
    // A copy shows only this hint (spec hint 7, fix round 1): copies carry no status of their own, so the checks below
    // would ask for payment of an order whose status lives on the first record.
    if (r.duplicateOf) {
      out.push({ tone: 'muted', title: 'Duplicate record.',
        text: 'Order ' + r.duplicateOf + ' is stored more than once; its status is set on the first record.' });
      return out;
    }
    const pay = r.paymentMethod.toLowerCase();
    const open = r.group !== 'delivered' && r.group !== 'cancelled';
    if (r.group === 'unpaid') {
      if (pay === 'card-simulation') {
        out.push({ tone: 'warn', title: 'Card was not charged.',
          text: 'The site only simulates card payment. Contact the customer to arrange payment of ' + formatMoney(r.toPay) + '.' });
      }
      if (pay.indexOf('crypto-') === 0) {
        const shown = totals(r).checkoutTotal;
        out.push({ tone: 'info', title: 'Crypto payment.',
          text: 'The customer was shown the ' + (lookup(WALLETS, pay) || 'crypto') + ' wallet. Check that ' + formatMoney(r.toPay)
            + ' in USDT/USDC has arrived, then set the status to Paid.' + (shown !== null ? ' The checkout showed ' + formatMoney(shown) + '.' : '') });
      }
      if (pay === 'inquiry') {
        out.push({ tone: 'muted', title: 'Payment method not chosen on the site.',
          text: 'The order came through the old checkout \u2014 agree the payment with the customer.' });
      }
    }
    if (open && r.priceMismatch) {
      const cart = formatMoney(r.clientSubtotal), catalog = formatMoney(r.serverSubtotal);
      out.push({ tone: 'warn', title: 'Price check.',
        // A figure the page cannot print (no subtotal_server, or a forged line sum past the print bound) would leave a
        // blank in the sentence, so the same thing is said in words instead (fix round 4).
        text: cart && catalog
          ? "The cart's items came to " + cart + ', catalog prices give ' + catalog + '. Confirm the amount before invoicing.'
          : "The customer's cart and the catalog prices do not agree. Confirm the amount before invoicing." });
    }
    if (open && r.unknownItems.length) {
      // unknown_items holds slugs (or the name when a line had no slug); the line's own name reads better.
      const names = r.unknownItems.map(u => {
        const line = r.items.find(i => i.slug === u);
        return '\u201c' + ((line && line.name) || u) + '\u201d';
      });
      out.push({ tone: 'warn', title: names.length === 1 ? 'Unknown item.' : 'Unknown items.',
        text: names.join(', ') + ' \u2014 not in the catalog, not counted in the amount to pay.' });
    }
    if (open && r.serverTotal === null) {
      out.push({ tone: 'muted', title: 'Amount not checked by the server.',
        text: 'It is shown as entered (older order, typed in by hand, or the catalog was unavailable).' });
    }
    return out;
  }

  function totals(r) {
    const lines = [];
    if (!r || r.kind !== 'order') return { lines, toPay: null, checkoutTotal: null };
    const shippingLine = v => lines.push(v === 0 ? { label: 'Shipping', value: 0, free: true } : { label: 'Shipping', value: v });
    let checkoutTotal = null;
    if (r.serverTotal !== null) {
      if (r.serverSubtotal !== null) {
        lines.push({ label: 'Items', value: r.serverSubtotal });
        const shipped = (cents(r.serverTotal) - cents(r.serverSubtotal)) / 100;
        // Below zero it is not a shipping cost (spec "Shipping cost", fix round 2): no line rather than "Shipping -$5.00".
        if (shipped >= 0) shippingLine(shipped);
      }
      if (r.discount !== null && r.discount > 0) {
        const note = discountLabels(r).card;
        lines.push(note ? { label: 'Discount', value: -r.discount, note } : { label: 'Discount', value: -r.discount });
      }
      if (r.total !== null && Math.abs(r.total - r.toPay) > 0.005) checkoutTotal = r.total;
    } else {
      lines.push({ label: 'Items', value: r.clientSubtotal });
      if (r.shipCost !== null) shippingLine(r.shipCost);
      if (r.cardFee !== null && r.cardFee > 0) lines.push({ label: 'Card fee', value: r.cardFee });
    }
    return { lines, toPay: r.toPay, checkoutTotal };
  }

  function statusStep(r) {
    if (r.kind === 'order' && r.group === 'cancelled') return { step: 0, cancelled: true, label: 'Cancelled' };
    let step = 0;
    if (r.kind === 'order') step = r.group === 'unpaid' ? 1 : (lookup(STEPS, r.statusRaw) || 0);
    return { step, cancelled: false, label: r.status };
  }

  // discount_source is written by products-api: 'coupon:CODE', 'tier:<minimum subtotal>' or 'none'.
  function discountLabels(r) {
    if (!r || r.discount === null || !(r.discount > 0)) return { row: '', card: '' };
    const pct = r.discountPct !== null ? String(cents(r.discountPct) / 100) + '%' : '';
    const amount = pct || formatMoney(r.discount);
    const src = r.discountSource;
    if (src.indexOf('coupon:') === 0) {
      const code = src.slice(7).trim();
      return { row: '\u2212' + amount + (code ? ' ' + code : ''), card: [pct, code].filter(Boolean).join(' \u00b7 ') };
    }
    if (src.indexOf('tier:') === 0) {
      const min = src.slice(5).trim();
      return { row: '\u2212' + amount + ' volume', card: [pct, 'volume' + (min ? ' $' + min + '+' : '')].filter(Boolean).join(' \u00b7 ') };
    }
    return { row: '\u2212' + amount, card: pct };
  }

  function paymentLabel(code) {
    const c = text(code);
    return lookup(PAYMENT_LABELS, c.toLowerCase()) || c;
  }

  function canShip(r) {
    return !!r && r.kind === 'order' && !r.duplicateOf && !!r.ref && has(SHIPPABLE, r.statusRaw);
  }

  function received(r) {
    if (!r || r.kind !== 'order') return 0;
    const list = r.payments;
    if (!Array.isArray(list) || !list.length) {
      return has(PAID_GROUPS, r.group) ? (r.toPay || 0) : 0;
    }
    let pay = 0, refund = 0;
    list.forEach(p => {
      if (!p || typeof p !== 'object') return;
      const a = num(p.amount);
      if (a === null || a < 0) return;
      if (p.kind === 'refund') refund += cents(a);
      else if (p.kind === 'payment') pay += cents(a);
    });
    return Math.max(0, pay - refund) / 100;
  }

  function outstanding(r) {
    if (!r || r.kind !== 'order' || r.toPay === null) return 0;
    return Math.max(0, cents(r.toPay) - cents(received(r))) / 100;
  }

  // Spec 3.1: figures for the Payment column. Broken records do not count as records, so a "Paid" order with
  // only an unreadable amount still falls back to the status group (unlike received(), which then returns 0).
  function paymentFigures(r) {
    const list = r && Array.isArray(r.payments) ? r.payments : [];
    let gross = 0, refunds = 0, valid = 0;
    list.forEach(p => {
      if (!p || typeof p !== 'object') return;
      const kind = text(p.kind).toLowerCase();
      if (kind !== 'payment' && kind !== 'refund') return;
      const a = num(p.amount);
      if (a === null || a < 0) return;
      valid++;
      if (kind === 'refund') refunds += cents(a);
      else gross += cents(a);
    });
    const receivedAmt = valid
      ? Math.max(0, gross - refunds) / 100
      : (r && has(PAID_GROUPS, r.group) ? (r.toPay || 0) : 0);
    return { received: receivedAmt, due: r ? r.toPay : null, refunded: refunds / 100 };
  }

  const PAY_TONES = { paid: 'ok', partial: 'warn', unpaid: 'muted', refunded: 'info', none: '' };
  function chargeCheckOf(raw) {
    const c = raw && typeof raw === 'object' ? raw.charge_check : null;
    if (!c || typeof c !== 'object') return null;
    const result = ['match', 'under', 'over', 'unknown'].indexOf(c.result) !== -1 ? c.result : null;
    return { charged: num(c.charged), expected: num(c.expected), diff: num(c.diff), result };
  }

  // One line for the order card: what to tell the team when the charge does not match the catalog.
  // '' when there is nothing to say (no check at all, or it matched).
  function chargeCheckText(r) {
    const c = r && r.chargeCheck;
    if (!c || !c.result || c.result === 'match') return '';
    const charged = formatMoney(c.charged);
    if (c.result === 'unknown') return 'Charged ' + charged + ' \u2014 an item is not in the catalog, check the price by hand';
    const expected = formatMoney(c.expected);
    const diff = formatMoney(c.diff);
    const verb = c.result === 'over' ? 'overpaid' : 'underpaid';
    const tail = c.result === 'over' ? 'refund the difference' : 'do not ship until settled';
    return 'Charged ' + charged + ', catalog price ' + expected + ' \u2014 ' + verb + ' by ' + diff + ', ' + tail;
  }

  const PAY_LABELS = { paid: 'Paid', partial: 'Partial', unpaid: 'Unpaid', refunded: 'Refunded', none: '' };

  function paymentStatus(r) {
    const fig = paymentFigures(r);
    let code = 'unpaid';
    if (!r || r.kind !== 'order' || r.duplicateOf || !(typeof r.toPay === 'number' && r.toPay > 0)) code = 'none';
    else if (cents(fig.refunded) > 0 && cents(fig.received) === 0) code = 'refunded';
    else if (cents(fig.received) >= cents(r.toPay)) code = 'paid';
    else if (cents(fig.received) > 0 && cents(fig.received) < cents(r.toPay)) code = 'partial';
    else if (r.group === 'cancelled') code = 'none';
    return { code: code, label: PAY_LABELS[code], tone: PAY_TONES[code], received: fig.received, due: fig.due, refunded: fig.refunded };
  }

  function canEdit(r) {
    return !!r && r.kind === 'order' && !!r.ref && !r.duplicateOf && !r.hasCopies;
  }

  function csvSafe(v) {
    const s = v === undefined || v === null ? '' : String(v);
    return /^[=+\-@]/.test(s) ? "'" + s : s;
  }

  function draftError(items) {
    if (!Array.isArray(items) || items.length < 1) return 'Add at least one product';
    for (let i = 0; i < items.length; i++) {
      const q = items[i] && items[i].qty;
      if (typeof q !== 'number' || !Number.isFinite(q) || q !== Math.floor(q) || q < 1) {
        return 'Quantity must be a whole number of at least 1';
      }
    }
    return '';
  }

  function addressLines(r) {
    const s = r.ship;
    return [
      [s.address1, s.address2].filter(Boolean).join(', '),
      [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', '),
      s.country
    ].filter(Boolean);
  }

  // What the Copy address button puts on the clipboard: a label-ready block.
  function addressText(r) {
    const lines = addressLines(r);
    return lines.length ? [r.name].concat(lines).filter(Boolean).join('\n') : '';
  }

  // The 18 columns of 2026-09-17 plus Payment status (after Status, 2026-09-21), then Received, Outstanding, Manager note, Tracking (formula-safe).
  function csvRow(r) {
    return [r.id, r.company || r.name, r.email, r.phone, r.shipTo, r.shipMethod, r.itemsText, r.qty, r.clientTotal, r.serverTotal,
      r.discount, r.due, r.priceMismatch ? 'Price mismatch' : '', r.status, paymentStatus(r).label, r.createdAt.slice(0, 10), r.paymentMethod, r.coupon, r.notes,
      received(r), outstanding(r), csvSafe(r.managerNote), csvSafe(r.trackingNumber)];
  }

  // Fixed en-US money (no toLocaleString): the page must read the same on every manager's machine. Any finite amount up
  // to MAX_PRINTED prints, since a card sum may pass the 1e9 read bound; anything else prints as '' (fix rounds 1-2).
  function formatMoney(n) {
    const v = finite(n);
    if (v === null || Math.abs(v) > MAX_PRINTED) return '';
    const c = cents(Math.abs(v));
    const whole = String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (v < 0 && c > 0 ? '\u2212' : '') + '$' + whole + '.' + pad2(c % 100);
  }

  function whenMs(value) {
    const s = text(value);
    const m = s.match(DATE_ONLY);
    if (m) {
      const t = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      const d = new Date(t);
      return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3] ? t : NaN;
    }
    return DATE_TIME.test(s) ? Date.parse(s.charAt(10) === ' ' ? s.slice(0, 10) + 'T' + s.slice(11) : s) : NaN;
  }

  // Spec "Formatting": the time is read in the browser's zone; the row adds the year only when it is not this year,
  // the card (long) always does.
  function formatWhen(value, opts) {
    const o = opts || {};
    const now = o.now || new Date();
    const s = text(value);
    const t = whenMs(s);
    if (Number.isNaN(t)) return '';
    const d = new Date(t);
    if (DATE_ONLY.test(s)) {
      // A bare date is a calendar day, not an instant: read back in UTC, no zone can move it to the day before.
      const y = d.getUTCFullYear();
      return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + (o.long || y !== now.getFullYear() ? ', ' + y : '');
    }
    const y = d.getFullYear();
    return MONTHS[d.getMonth()] + ' ' + d.getDate() + (o.long || y !== now.getFullYear() ? ', ' + y : '')
      + ' \u00b7 ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function dateInputValue(now) {
    const d = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function isoFromDateInput(value) {
    const m = text(value).match(DATE_ONLY);
    if (!m) return '';
    const y = +m[1], mo = +m[2], day = +m[3];
    const d = new Date(y, mo - 1, day);
    if (d.getFullYear() !== y || d.getMonth() !== mo - 1 || d.getDate() !== day) return '';
    return d.toISOString();
  }

  // Stage 1 RET (2026-09-30): what the tracking dialog and the "Letters sent" row need. Pure, like everything in this file.
  // True when moving r to this status has to ask for the tracking first: the buyer's letter carries the number and the link,
  // and products-api answers 400 "tracking number required" for these two statuses when neither the request nor the order
  // has one. A number with no carrier is asked about too (no carrier = no tracking link in the letter).
  function needsTrackingDialog(r, status) {
    return !!r && r.kind === 'order' && has(NEEDS_TRACKING, text(status).toLowerCase()) && (!text(r.trackingNumber) || !text(r.carrier));
  }
  // The one PATCH body for a status change; track = {trackingNumber, carrier} from the dialog, or null for a plain status.
  function statusPatchBody(status, track) {
    const body = { status: status };
    if (track) {
      body.trackingNumber = text(track.trackingNumber);
      if (has(CARRIERS, text(track.carrier))) body.carrier = text(track.carrier);
    }
    return body;
  }
  // What went out, from order.letters ("confirmation 2026-09-30 12:01 UTC, shipped ..."); an old order has no such field.
  function lettersLabel(letters) {
    const l = obj(letters);
    const out = [];
    LETTER_ORDER.forEach(k => {
      const at = text(obj(l[k]).sentAt);
      if (at && DATE_TIME.test(at) && !Number.isNaN(Date.parse(at))) out.push(k.replace('_', ' ') + ' ' + at.slice(0, 10) + ' ' + at.slice(11, 16) + ' UTC');
    });
    return out.join(', ');
  }

  const api = {
    API_STATUSES, load, normalize, markDuplicates, assignRowKeys, isTestAddress, isTestRef, stats, filter, statusOptions,
    sortNewestFirst, hints, totals, statusStep, discountLabels, paymentLabel, canShip, addressLines, addressText, csvRow,
    formatMoney, formatWhen, whenMs, dateInputValue, isoFromDateInput, received, outstanding, paymentStatus, canEdit, csvSafe, draftError, chargeCheckText, CARRIERS, needsTrackingDialog, statusPatchBody, lettersLabel
  };
  global.OrdersModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
