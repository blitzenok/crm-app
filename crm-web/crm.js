/**
 * BioLabs Research CRM — shared page shell (phase 3, 2026-09-05).
 * Loaded by every migrated page after crm-utils.js and before auth.js:
 *     <script src="crm-utils.js"></script>
 *     <script src="crm.js"></script>
 *     <script src="auth.js"></script>
 * Ordinary script, not a module. Everything lives inside one IIFE and only the names below reach the page,
 * so a page may still declare its own `const API`, `let token`, ... without colliding.
 *
 *   api(path, opts)          fetch with Bearer, JSON in/out, 401 -> login, errors -> toast + throw
 *                            opts: {method, body, headers, toast:false, on401:'throw' (keep the session), raw:true (get the Response)}
 *   toast(msg, type, ms)     also exported as showToast(msg, type)
 *   confirmDialog(msg, opts) Promise<boolean> on the crm.css modal (pages that use native confirm() keep it)
 *   fmtMoney(n) fmtDate(v)   the formatters copied across pages until now
 *   renderNav(activeKey)     the single menu; call it as the first line of the page script
 *   logout()                 POST /api/logout, clear the session, go to the login page
 *   initPwa()                service worker + install banner + standalone splash (runs by itself)
 */
(function (global) {
  'use strict';

  var LOGIN_URL = '/crm/login.html';

  function token() {
    try { return localStorage.getItem('crm_token') || ''; } catch (e) { return ''; }
  }
  function clearSession() {
    try { localStorage.removeItem('crm_token'); localStorage.removeItem('crm_user'); } catch (e) {}
  }

  /* ── toast ───────────────────────────────────────────────────────────── */
  function toastEl() {
    var el = document.getElementById('crm-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'crm-toast';
      el.className = 'toast';
      (document.body || document.documentElement).appendChild(el);
    }
    return el;
  }
  function toast(msg, type, ms) {
    var el = toastEl();
    el.textContent = msg === null || msg === undefined ? '' : String(msg);
    el.className = 'toast show ' + (type || 'success');
    if (el._crmTimer) clearTimeout(el._crmTimer);
    el._crmTimer = setTimeout(function () { el.className = 'toast'; }, ms || 3000);
  }

  /* ── api ─────────────────────────────────────────────────────────────── */
  function hasHeader(h, name) {
    for (var k in h) if (Object.prototype.hasOwnProperty.call(h, k) && k.toLowerCase() === name) return true;
    return false;
  }
  function apiError(msg, status, showToast) {
    var e = new Error(msg);
    e.status = status;
    if (showToast) toast(msg, 'error');
    return e;
  }
  async function api(path, opts) {
    opts = opts || {};
    var showToast = opts.toast !== false;
    var headers = { 'Authorization': 'Bearer ' + token() };
    if (opts.headers) for (var k in opts.headers) if (Object.prototype.hasOwnProperty.call(opts.headers, k)) headers[k] = opts.headers[k];
    var init = { method: opts.method || 'GET', headers: headers };
    var body = opts.body;
    if (body !== undefined && body !== null) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        init.body = body;                       // let the browser set multipart/form-data with its boundary
      } else {
        if (!hasHeader(headers, 'content-type')) headers['Content-Type'] = 'application/json';
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
      }
    }

    var res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw apiError('Cannot reach the server', 0, showToast);
    }

    // on401:'throw' — the caller knows a 401 can mean something other than a dead session (a wrong current
    // password, say): keep the session, fall through and report the server's own message below.
    if (res.status === 401 && opts.on401 !== 'throw') {
      clearSession();
      global.location.href = LOGIN_URL;         // no toast: the page is leaving anyway
      throw apiError('Session expired', 401, false);
    }
    // nginx or a restarting backend, not an expired session: the body is usually HTML, so do not parse it.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw apiError('Server unavailable — please try again in a minute', res.status, showToast);
    }
    // raw: hand a successful response over unread (the caller wants its headers); errors still need the body.
    if (res.ok && opts.raw) return res;

    var text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    var data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }

    if (!res.ok) {
      var msg = data && data.error ? String(data.error) : 'HTTP ' + res.status;
      throw apiError(msg, res.status, showToast);
    }
    return data;
  }

  /* ── confirm dialog ──────────────────────────────────────────────────── */
  function confirmDialog(msg, opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var overlay = document.createElement('div');
      overlay.className = 'modal-overlay open';
      overlay.innerHTML =
        '<div class="modal" style="width:420px">' +
          '<div class="modal-header"><div class="modal-info"><div class="modal-title"></div></div></div>' +
          '<div class="modal-footer"><div class="modal-footer-left"></div><div class="modal-footer-right">' +
            '<button type="button" class="btn-cancel" data-crm-confirm="0"></button>' +
            '<button type="button" class="btn btn-primary" data-crm-confirm="1"></button>' +
          '</div></div>' +
        '</div>';
      overlay.querySelector('.modal-title').textContent = msg === null || msg === undefined ? '' : String(msg);
      overlay.querySelector('[data-crm-confirm="0"]').textContent = opts.cancel || 'Cancel';
      overlay.querySelector('[data-crm-confirm="1"]').textContent = opts.ok || 'OK';

      function close(value) {
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(value);
      }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(false); } }
      overlay.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('[data-crm-confirm]') : null;
        if (btn) return close(btn.getAttribute('data-crm-confirm') === '1');
        if (e.target === overlay) close(false);
      });
      document.addEventListener('keydown', onKey, true);
      (document.body || document.documentElement).appendChild(overlay);
      var ok = overlay.querySelector('[data-crm-confirm="1"]');
      if (ok && ok.focus) ok.focus();
    });
  }

  /* ── formatters ──────────────────────────────────────────────────────── */
  function fmtMoney(n) { return '$' + Number(n || 0).toFixed(2); }
  function fmtDate(v) {
    if (!v) return 'never';
    var d = new Date(v);
    return isNaN(d.getTime()) ? 'never' : d.toLocaleString();
  }

  /* ── navigation ──────────────────────────────────────────────────────── */
  var MSG_BADGE_HTML = '<span class="nav-badge" id="msgBadgeNav" style="display:none"></span>';
  var CHATS_BADGE_HTML = '<span class="nav-badge" id="chatsBadgeNav" style="display:none"></span>';

  function cloneItem(it) {
    var o = { key: it.key, icon: it.icon, label: it.label, m: !!it.m, admin: !!it.admin };
    if (it.id) o.id = it.id;
    if (it.extra) o.extra = it.extra;
    return o;
  }
  function cloneLayout(l) {
    return { groups: ((l && l.groups) || []).map(function (g) {
      return { id: g.id, title: g.title, collapsed: !!g.collapsed, hidden: !!g.hidden, items: (g.items || []).map(cloneItem) };
    }) };
  }
  function defaultLayoutFrom(def) {
    return { groups: def.map(function (g) {
      return { id: g.id, title: g.title, collapsed: !!g.collapsed, hidden: false, items: g.items.map(cloneItem) };
    }) };
  }

  var CrmNav = {
    DASHBOARD: { key: 'dashboard', icon: '📊', label: 'Dashboard' },
    DEFAULT: [
      { id: 'sales', title: 'SALES', collapsed: false, items: [
        { key: 'orders', icon: '📦', label: 'Orders' },
        { key: 'store-orders', icon: '🛒', label: 'Store Orders', m: 1 },
        { key: 'crypto-orders', icon: '🪙', label: 'Crypto payments', m: 1 },
        { key: 'customers', icon: '🧑‍🤝‍🧑', label: 'Customers' },
        { key: 'customer-timeline', icon: '🗂️', label: 'Customer Timeline' },
        { key: 'store-messages', icon: '✉️', label: 'Messages', m: 1, id: 'nav-store-messages', extra: MSG_BADGE_HTML },
        { key: 'chats', icon: String.fromCodePoint(0x1F4AC), label: 'Chats', m: 1, id: 'nav-chats', extra: CHATS_BADGE_HTML },
        { key: 'customer-accounts', icon: '🔐', label: 'Accounts', m: 1 },
        { key: 'quotations', icon: '📋', label: 'Quotations', m: 1 },
        { key: 'sales-entry', icon: '🧾', label: 'Add Sale', m: 1 },
        { key: 'sales-dashboard', icon: '💰', label: 'Sales Dashboard', m: 1 },
        { key: 'abandoned-checkout', icon: '🧾', label: 'Abandoned checkout', m: 1 },
        { key: 'representatives', icon: '👔', label: 'Representatives', m: 1 }
      ] },
      { id: 'marketing', title: 'MARKETING', collapsed: true, items: [
        { key: 'leads', icon: '👥', label: 'All Leads' },
        { key: 'leads-dashboard', icon: '🎯', label: 'Leads Dashboard', m: 1 },
        { key: 'marketing', icon: '📣', label: 'Marketing' },
        { key: 'marketing-segments', icon: '🎯', label: 'Segments', m: 1 },
        { key: 'marketing-emails', icon: '📝', label: 'Emails', m: 1 },
        { key: 'marketing-journeys', icon: '🧭', label: 'Journeys', m: 1 },
        { key: 'marketing-newsletter', icon: '📨', label: 'Newsletter', m: 1 },
        { key: 'reports', icon: '📈', label: 'Leads Reports', m: 1 }
      ] },
      { id: 'finance', title: 'FINANCE', collapsed: true, items: [
        { key: 'finance-reports', icon: '💹', label: 'Finance Reports' },
        { key: 'expenses', icon: '💸', label: 'Expenses', m: 1 },
        { key: 'psp-clearing', icon: '💳', label: 'PSP Clearing', m: 1 },
        { key: 'processors', icon: '🏦', label: 'Processors', m: 1, admin: 1 }
      ] },
      { id: 'store', title: 'STORE', collapsed: true, items: [
        { key: 'inventory', icon: '🏪', label: 'Products' },
        { key: 'inventory-intake', icon: '📦', label: 'Inventory Intake' },
        { key: 'damaged-items', icon: '⚠️', label: 'Damaged Items', m: 1 },
        { key: 'suppliers', icon: '🏭', label: 'Suppliers', m: 1 },
        { key: 'supplier-statement', icon: '🧾', label: 'Supplier Statements', m: 1 },
        { key: 'purchase-orders', icon: '🚚', label: 'Purchase Orders', m: 1 }
      ] },
      { id: 'settings', title: 'SETTINGS', collapsed: true, items: [
        { key: 'store-settings', icon: '⚙️', label: 'Store Settings', m: 1 },
        { key: 'site-texts', icon: '📄', label: 'Site texts', m: 1 },
        { key: 'users', icon: '🔑', label: 'Users', m: 1, admin: 1 },
        { key: 'activity-log', icon: '📜', label: 'Activity Log', m: 1 },
        { key: 'account', icon: '👤', label: 'My Account' }
      ] }
    ],
    layout: function (prefs) {
      var def = CrmNav.DEFAULT;
      if (!prefs || typeof prefs !== 'object' || !Array.isArray(prefs.groups)) return defaultLayoutFrom(def);
      var cat = {};
      def.forEach(function (g) {
        g.items.forEach(function (it) { cat[it.key] = it; });
      });
      var placed = {};
      var seen = {};
      var groups = [];
      prefs.groups.forEach(function (g) {
        if (!g || typeof g !== 'object' || !Array.isArray(g.items)) return;
        if (g.id === 'dashboard') return;
        var src = null;
        for (var i = 0; i < def.length; i++) if (def[i].id === g.id) { src = def[i]; break; }
        if (!src || seen[g.id]) return;
        seen[g.id] = true;
        var items = [];
        g.items.forEach(function (key) {
          if (key === 'dashboard' || !cat[key] || placed[key]) return;
          placed[key] = true;
          items.push(cloneItem(cat[key]));
        });
        groups.push({
          id: src.id,
          title: src.title,
          collapsed: typeof g.collapsed === 'boolean' ? g.collapsed : src.collapsed,
          hidden: typeof g.hidden === 'boolean' ? g.hidden : false,
          items: items
        });
      });
      def.forEach(function (src) {
        if (seen[src.id]) return;
        seen[src.id] = true;
        groups.push({ id: src.id, title: src.title, collapsed: !!src.collapsed, hidden: false, items: [] });
      });
      def.forEach(function (src) {
        var g = null;
        for (var i = 0; i < groups.length; i++) if (groups[i].id === src.id) { g = groups[i]; break; }
        src.items.forEach(function (it) {
          if (placed[it.key]) return;
          placed[it.key] = true;
          g.items.push(cloneItem(it));
        });
      });
      return { groups: groups };
    },
    move: function (layout, key, groupId, index) {
      var next = cloneLayout(layout);
      var srcG = null, srcI = -1, dest = null;
      next.groups.forEach(function (g) {
        if (g.id === groupId) dest = g;
        for (var i = 0; i < g.items.length; i++) {
          if (g.items[i].key === key) { srcG = g; srcI = i; }
        }
      });
      if (!srcG || !dest) return cloneLayout(layout);
      var item = srcG.items.splice(srcI, 1)[0];
      var idx = index;
      if (typeof idx !== 'number' || idx !== idx || idx < 0 || idx > dest.items.length) idx = dest.items.length;
      dest.items.splice(idx, 0, item);
      return next;
    },
    setCollapsed: function (layout, groupId, bool) {
      var next = cloneLayout(layout);
      next.groups.forEach(function (g) { if (g.id === groupId) g.collapsed = !!bool; });
      return next;
    },
    setHidden: function (layout, groupId, bool) {
      var next = cloneLayout(layout);
      next.groups.forEach(function (g) { if (g.id === groupId) g.hidden = !!bool; });
      return next;
    },
    toPrefs: function (layout) {
      return {
        v: 1,
        groups: ((layout && layout.groups) || []).map(function (g) {
          return { id: g.id, collapsed: !!g.collapsed, hidden: !!g.hidden, items: (g.items || []).map(function (it) { return it.key; }) };
        })
      };
    },
    equal: function (a, b) {
      function canon(p) {
        if (p == null) p = CrmNav.toPrefs(CrmNav.layout(null));
        if (!p || typeof p !== 'object' || !Array.isArray(p.groups)) return '';
        return JSON.stringify(p.groups.map(function (g) {
          return [g && g.id, !!(g && g.collapsed), !!(g && g.hidden), (g && Array.isArray(g.items) ? g.items : []).slice()];
        }));
      }
      return canon(a) === canon(b);
    }
  };
  global.CrmNav = CrmNav;

  var LOGO_HTML =
    '<a href="/crm/dashboard.html" class="sidebar-logo">' +
      '<div class="logo-img"><img src="/crm/assets/biolabs-logo.png" alt="BioLabs Research" style="width:42px;height:42px;border-radius:12px;object-fit:cover;" /></div>' +
      '<div class="logo-text-box">' +
        '<div class="logo-name">BioLabs</div>' +
        '<div class="logo-tagline">Research CRM</div>' +
      '</div>' +
    '</a>';

  function escText(s) {
    var fn = global.esc;
    if (typeof fn === 'function') return fn(s);
    return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function currentKey() {
    var last = String(global.location.pathname || '').split('/').pop() || '';
    return last.replace(/\.html$/i, '') || 'dashboard';
  }

  function currentEmail() {
    try {
      var u = global.CRM_CURRENT_USER;
      var email = u && u.email;
      if (!email) {
        var raw = localStorage.getItem('crm_user');
        if (raw) email = (JSON.parse(raw) || {}).email;
      }
      return email ? String(email).toLowerCase() : '';
    } catch (e) { return ''; }
  }

  function currentRole() {
    try {
      var u = global.CRM_CURRENT_USER;
      if (u && u.role) return u.role === 'admin' ? 'admin' : 'staff';
      var raw = localStorage.getItem('crm_user');
      if (raw) {
        var r = (JSON.parse(raw) || {}).role;
        return r === 'admin' ? 'admin' : 'staff';
      }
    } catch (e) {}
    return 'staff';
  }

  function cacheKey() {
    var email = currentEmail();
    return email ? 'crm_nav_prefs:' + email : '';
  }

  function readCache() {
    var k = cacheKey();
    if (!k) return null;
    try {
      var raw = localStorage.getItem(k);
      if (!raw) return null;
      var o = JSON.parse(raw);
      if (!o || typeof o !== 'object') return null;
      return o;
    } catch (e) { return null; }
  }

  function writeCache(rec) {
    var k = cacheKey();
    if (!k) return;
    try { localStorage.setItem(k, JSON.stringify(rec)); } catch (e) {}
  }

  var navState = {
    layout: CrmNav.layout(null),
    active: 'dashboard',
    forcedOpen: undefined,
    menuOpen: false,
    dragging: false,
    dragKey: '',
    dropGroup: '',
    dropped: false,
    dirty: false,
    pendingNav: undefined,
    lastSaved: undefined,
    lastSavedSet: false,
    updatedAt: null,
    saveTimer: null,
    loadSeq: 0,
    pendingPaint: false,
    bound: false,
    badgeSnap: null,
    saveGen: 0,
    inFlight: 0
  };

  function shownGroup(g) {
    return !g.collapsed || navState.forcedOpen === g.id;
  }

  function ensureForcedOpen() {
    if (navState.forcedOpen !== undefined) return;
    navState.forcedOpen = null;
    var active = navState.active;
    navState.layout.groups.forEach(function (g) {
      if (!g.collapsed) return;
      if (g.items.some(function (it) { return it.key === active; })) navState.forcedOpen = g.id;
    });
  }

  function navItemHtml(item, active, draggable) {
    var cls = 'nav-item';
    if (item.m) cls += ' nav-mobile-hidden';
    if (item.key === active) cls += ' active';
    return '<a href="/crm/' + escText(item.key) + '.html"' +
      (item.id ? ' id="' + escText(item.id) + '"' : '') +
      (item.admin ? ' data-admin-only' : '') +
      ' data-nav-key="' + escText(item.key) + '"' +
      ' draggable="' + (draggable ? 'true' : 'false') + '"' +
      ' class="' + cls + '">' +
      '<span class="nav-icon">' + escText(item.icon) + '</span> ' + escText(item.label) +
      (item.extra || '') + '</a>';
  }

  function hiddenCount() {
    var n = 0;
    navState.layout.groups.forEach(function (g) { if (g.hidden) n++; });
    return n;
  }

  function menuBtnLabel() {
    var n = hiddenCount();
    return n ? ('Menu · ' + n + ' hidden') : 'Menu';
  }

  function setMenuOpen(open) {
    navState.menuOpen = !!open;
    var menu = document.getElementById('crm-nav-menu');
    var btn = document.getElementById('crm-nav-menu-btn');
    if (menu) {
      if (open) menu.removeAttribute('hidden');
      else menu.setAttribute('hidden', '');
    }
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (!open && navState.pendingPaint && !navState.dragging) setTimeout(function () { if (!navState.menuOpen && !navState.dragging) paintNav(); }, 0);
  }

  function mouseDevice() {
    try { return !!(global.matchMedia && global.matchMedia('(hover: hover) and (pointer: fine)').matches); } catch (e) { return false; }
  }

  function prefsNow() {
    return CrmNav.toPrefs(navState.layout);
  }

  function markLastSaved(nav) {
    navState.lastSaved = nav;
    navState.lastSavedSet = true;
  }

  function scheduleNavSave() {
    if (navState.saveTimer) clearTimeout(navState.saveTimer);
    navState.saveTimer = setTimeout(function () {
      navState.saveTimer = null;
      flushNavPrefs(false);
    }, 500);
  }

  function flushNavPrefs(keepalive) {
    if (navState.saveTimer) { clearTimeout(navState.saveTimer); navState.saveTimer = null; }
    if (!navState.dirty) return;
    var body = { nav: navState.pendingNav === undefined ? prefsNow() : navState.pendingNav };
    var payload = JSON.stringify(body);
    if (keepalive) {
      try {
        fetch('/api/me/prefs', {
          method: 'PUT',
          headers: { 'Authorization': 'Bearer ' + token(), 'Content-Type': 'application/json' },
          body: payload,
          keepalive: true
        }).catch(function () {});
      } catch (e) {}
      // The browser owns delivery from here. Count it as written: if it is lost, the server wins next time, which
      // is right; keeping dirty would make this cache overwrite edits made on another device forever.
      navState.dirty = false;
      markLastSaved(body.nav);
      writeCache({ nav: body.nav, updatedAt: navState.updatedAt, dirty: false });
      return;
    }
    var gen = navState.saveGen; // a newer commit bumps it: this response is then stale and must not touch dirty/cache
    navState.inFlight++;
    api('/api/me/prefs', { method: 'PUT', body: body, toast: false, on401: 'throw' }).then(function (data) {
      navState.inFlight--;
      if (gen !== navState.saveGen) return;
      navState.dirty = false;
      var prefs = data && data.prefs;
      navState.updatedAt = prefs && prefs.updatedAt || null;
      markLastSaved(body.nav);
      writeCache({ nav: body.nav, updatedAt: navState.updatedAt, dirty: false });
    }).catch(function () {
      navState.inFlight--;
      if (gen !== navState.saveGen) return;
      toast('Menu layout not saved', 'error');
      writeCache({ nav: body.nav, updatedAt: navState.updatedAt, dirty: true });
    });
  }

  function commitPrefs(nav, opts) {
    opts = opts || {};
    // Nothing to send only when nothing is queued or in flight: a revert inside the 500 ms window (or while a PUT is
    // in flight) must itself be sent, otherwise the queued/in-flight change wins on the server.
    var settled = !navState.dirty && !navState.inFlight;
    if (!opts.reset && settled && navState.lastSavedSet && CrmNav.equal(nav, navState.lastSaved)) return;
    navState.dirty = true;
    navState.saveGen++;
    navState.pendingNav = opts.reset ? null : nav;
    writeCache({ nav: navState.pendingNav, updatedAt: navState.updatedAt, dirty: true });
    if (opts.immediate) flushNavPrefs(false);
    else scheduleNavSave();
  }

  function rememberBadge() {
    var b = document.getElementById('msgBadgeNav');
    if (!b) return;
    var tx = b.textContent;
    var ds = b.style.display;
    if ((tx && tx.length) || (ds && ds !== 'none')) {
      navState.badgeSnap = { text: tx, display: ds };
    }
  }

  function paintNav() {
    var box = document.getElementById('crm-nav');
    if (!box) return;
    if (navState.dragging) { navState.pendingPaint = true; return; }
    var keepMenu = navState.menuOpen;
    rememberBadge();
    var heldBadge = document.getElementById('msgBadgeNav');
    if (heldBadge && heldBadge.parentNode) heldBadge.parentNode.removeChild(heldBadge);
    var badgeText = navState.badgeSnap ? navState.badgeSnap.text : (heldBadge ? heldBadge.textContent : null);
    var badgeDisplay = navState.badgeSnap ? navState.badgeSnap.display : (heldBadge ? heldBadge.style.display : null);
    ensureForcedOpen();
    var active = navState.active;
    var role = currentRole();
    var canDrag = mouseDevice();
    var html = LOGO_HTML + '<nav class="nav">';
    html += navItemHtml(CrmNav.DASHBOARD, active, false);
    navState.layout.groups.forEach(function (g) {
      var vis = shownGroup(g);
      var itemsId = 'nav-group-items-' + g.id;
      html += '<section class="nav-group" data-nav-group="' + escText(g.id) + '"' +
        ' data-collapsed="' + (g.collapsed ? '1' : '0') + '"' +
        ' data-hidden="' + (g.hidden ? '1' : '0') + '">';
      html += '<button type="button" class="nav-group-head" aria-expanded="' + (vis ? 'true' : 'false') + '"' +
        ' aria-controls="' + escText(itemsId) + '">' +
        '<span class="nav-group-caret">' + (vis ? '▾' : '▸') + '</span>' +
        '<span class="nav-group-title">' + escText(g.title) + '</span></button>';
      html += '<div class="nav-group-items" id="' + escText(itemsId) + '"' + (vis ? '' : ' hidden') + '>';
      var drawn = 0;
      g.items.forEach(function (it) {
        if (it.admin && role !== 'admin') return;
        html += navItemHtml(it, active, canDrag);
        drawn++;
      });
      if (!drawn) html += '<div class="nav-group-empty">' + escText('Drop here') + '</div>';
      html += '</div></section>';
    });
    html += '<div class="sidebar-spacer"></div>';
    html += '<button type="button" id="crm-nav-menu-btn" class="nav-mobile-hidden nav-item" aria-expanded="' + (keepMenu ? 'true' : 'false') + '">' +
      escText(menuBtnLabel()) + '</button>';
    html += '<a href="#" class="nav-mobile-hidden nav-item nav-signout" draggable="false" onclick="logout()"><span class="nav-icon">🚪</span> Sign Out</a>';
    html += '</nav>';
    html += '<div id="crm-nav-menu"' + (keepMenu ? '' : ' hidden') + '>';
    navState.layout.groups.forEach(function (g) {
      html += '<label><input type="checkbox" data-nav-show="' + escText(g.id) + '"' + (g.hidden ? '' : ' checked') + '> ' +
        escText(g.title) + '</label>';
    });
    html += '<button type="button" data-nav-reset>' + escText('Reset menu') + '</button>';
    html += '</div>';
    box.innerHTML = html;
    var link = document.getElementById('nav-store-messages') || box.querySelector('a.nav-item[data-nav-key="store-messages"]');
    var keep = heldBadge;
    if (link) {
      var spawned = null;
      var spans = link.getElementsByTagName('span');
      for (var si = 0; si < spans.length; si++) {
        if (spans[si].id === 'msgBadgeNav' && spans[si] !== keep) spawned = spans[si];
      }
      if (!keep) keep = spawned;
      if (spawned && keep && spawned !== keep && spawned.parentNode) spawned.parentNode.removeChild(spawned);
      if (!keep) {
        keep = document.createElement('span');
        keep.className = 'nav-badge';
        keep.id = 'msgBadgeNav';
        keep.style.display = 'none';
      }
      if (keep.parentNode !== link) link.appendChild(keep);
      if (badgeText) keep.textContent = badgeText;
      if (badgeDisplay && badgeDisplay !== 'none') keep.style.display = badgeDisplay;
      else if (navState.badgeSnap && navState.badgeSnap.display) keep.style.display = navState.badgeSnap.display;
    }
    rememberBadge();
    paintChatsBadge();
    navState.pendingPaint = false;
    bindNavChrome();
  }

  /* Chats badge (shop-chat, Chats tab): conversations waiting for a person. A plain fetch, not api(): a background
     counter must not toast or send the user to the login page when the chat service is down. */
  var chatsWaiting = 0;
  var chatsTimer = null;
  var chatsPollBusy = false;
  function paintChatsBadge() {
    var b = document.getElementById('chatsBadgeNav');
    if (!b) return;
    b.textContent = chatsWaiting ? String(chatsWaiting) : '';
    b.style.display = chatsWaiting ? 'inline-block' : 'none';
  }
  function pollChats() {
    if (document.hidden || !token()) return;
    if (chatsPollBusy) return;
    chatsPollBusy = true;
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = ctrl ? setTimeout(function () { ctrl.abort(); }, 8000) : null;
    var opts = { headers: { 'Authorization': 'Bearer ' + token() } };
    if (ctrl) opts.signal = ctrl.signal;
    fetch('/chat-desk/summary', opts)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && typeof d.waiting === 'number') { chatsWaiting = d.waiting; paintChatsBadge(); } })
      .catch(function () {})
      .then(function () { chatsPollBusy = false; if (timer) clearTimeout(timer); });
  }
  function startChatsBadge() {
    if (chatsTimer) return;
    pollChats();
    chatsTimer = setInterval(pollChats, 30000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) pollChats(); });
  }

  function queuePaint() {
    if (navState.dragging || navState.menuOpen) { navState.pendingPaint = true; return; }
    paintNav();
  }

  function applyServerPrefs(prefs) {
    var serverNav = prefs && Object.prototype.hasOwnProperty.call(prefs, 'nav') ? prefs.nav : null;
    var updatedAt = prefs && prefs.updatedAt || null;
    var cache = readCache();
    var dirtyNav = navState.dirty ? navState.pendingNav : (cache && cache.dirty ? cache.nav : undefined);
    if (dirtyNav !== undefined) {
      navState.layout = CrmNav.layout(dirtyNav);
      navState.dirty = true;
      navState.pendingNav = dirtyNav;
      queuePaint();
      commitPrefs(dirtyNav, { immediate: true, reset: dirtyNav === null });
      return;
    }
    navState.updatedAt = updatedAt;
    markLastSaved(serverNav);
    writeCache({ nav: serverNav, updatedAt: updatedAt, dirty: false });
    var next = CrmNav.layout(serverNav);
    navState.layout = next;
    if (!CrmNav.equal(serverNav, cache && cache.nav)) {
      rememberBadge();
      queuePaint();
    }
  }

  function syncFromServer() {
    var seq = ++navState.loadSeq;
    api('/api/me/prefs', { toast: false, on401: 'throw' }).then(function (data) {
      if (seq !== navState.loadSeq) return;
      applyServerPrefs(data && data.prefs);
    }).catch(function () {});
  }

  function layoutFromCacheOrDefault() {
    var cache = readCache();
    if (cache && Object.prototype.hasOwnProperty.call(cache, 'nav')) {
      navState.dirty = !!cache.dirty;
      navState.updatedAt = cache.updatedAt || null;
      navState.pendingNav = cache.nav;
      if (!cache.dirty) markLastSaved(cache.nav);
      return CrmNav.layout(cache.nav);
    }
    return CrmNav.layout(null);
  }

  function clearDragDecor() {
    var body = document.body;
    if (body) body.classList.remove('nav-dragging');
    var ph = document.querySelector('.nav-drop-placeholder');
    if (ph && ph.parentNode) ph.parentNode.removeChild(ph);
    var src = document.querySelector('a.nav-item.nav-dragging-item');
    if (src) src.classList.remove('nav-dragging-item');
  }

  function dropIndexFor(groupEl, clientY) {
    var items = [];
    var nodes = groupEl.querySelectorAll('a.nav-item[data-nav-key]');
    for (var i = 0; i < nodes.length; i++) {
      var k = nodes[i].getAttribute('data-nav-key');
      if (k && k !== navState.dragKey) items.push(nodes[i]);
    }
    for (var j = 0; j < items.length; j++) {
      var r = items[j].getBoundingClientRect();
      if (clientY < (r.top + r.bottom) / 2) return j;
    }
    return items.length;
  }

  // dropIndexFor counts drawn items; the layout also holds admin-only items a staff user does not see.
  function layoutIndexFor(gid, visualIdx) {
    var role = currentRole();
    var g = null;
    navState.layout.groups.forEach(function (x) { if (x.id === gid) g = x; });
    if (!g) return visualIdx;
    var full = g.items.filter(function (it) { return it.key !== navState.dragKey; });
    var seen = 0;
    for (var i = 0; i < full.length; i++) {
      if (full[i].admin && role !== 'admin') continue;
      if (seen === visualIdx) return i;
      seen++;
    }
    return full.length;
  }

  function placePlaceholder(groupItems, index) {
    var ph = document.querySelector('.nav-drop-placeholder');
    if (!ph) {
      ph = document.createElement('div');
      ph.className = 'nav-drop-placeholder';
    }
    var items = [];
    var nodes = groupItems.querySelectorAll('a.nav-item[data-nav-key]');
    for (var i = 0; i < nodes.length; i++) {
      if (nodes[i].getAttribute('data-nav-key') !== navState.dragKey) items.push(nodes[i]);
    }
    var empty = groupItems.querySelector('.nav-group-empty');
    if (index >= items.length) {
      if (empty) groupItems.insertBefore(ph, empty);
      else groupItems.appendChild(ph);
    } else {
      groupItems.insertBefore(ph, items[index]);
    }
  }

  function bindNavChrome() {
    if (navState.bound) return;
    navState.bound = true;
    document.addEventListener('click', function (e) {
      if (!navState.menuOpen) return;
      var t0 = e.target;
      if (t0 && t0.nodeType === 3) t0 = t0.parentNode;
      if (!t0 || !t0.closest) return;
      if (t0.closest('#crm-nav-menu') || t0.closest('#crm-nav-menu-btn')) return;
      setMenuOpen(false);
    }, true);
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (t && t.nodeType === 3) t = t.parentNode;
      if (!t || !t.closest) return;
      var head = t.closest('.nav-group-head');
      if (head) {
        var sec = head.closest('section.nav-group');
        var id = sec && sec.getAttribute('data-nav-group');
        if (!id) return;
        var g = null;
        navState.layout.groups.forEach(function (x) { if (x.id === id) g = x; });
        if (!g) return;
        if (shownGroup(g)) {
          if (navState.forcedOpen === id) navState.forcedOpen = null;
          navState.layout = CrmNav.setCollapsed(navState.layout, id, true);
        } else {
          navState.layout = CrmNav.setCollapsed(navState.layout, id, false);
        }
        paintNav();
        commitPrefs(prefsNow());
        return;
      }
      var btn = t.closest('#crm-nav-menu-btn');
      if (btn) {
        setMenuOpen(!navState.menuOpen);
        return;
      }
      var reset = t.closest('[data-nav-reset]');
      if (reset) {
        navState.layout = CrmNav.layout(null);
        navState.forcedOpen = undefined;
        ensureForcedOpen();
        navState.menuOpen = true;
        paintNav();
        commitPrefs(null, { reset: true });
        return;
      }
      var cb = t.closest('#crm-nav-menu input[data-nav-show]');
      if (!cb) {
        var lab = t.closest('#crm-nav-menu label');
        if (lab) cb = lab.querySelector('input[data-nav-show]');
      }
      if (cb) {
        var gid = cb.getAttribute('data-nav-show');
        // A click on the <label> arrives before the browser toggles the input, so read the model, not cb.checked.
        var cur = null;
        navState.layout.groups.forEach(function (x) { if (x.id === gid) cur = x; });
        if (!cur) return;
        e.preventDefault();
        navState.layout = CrmNav.setHidden(navState.layout, gid, !cur.hidden);
        navState.menuOpen = true;
        paintNav();
        commitPrefs(prefsNow());
        return;
      }
      if (navState.menuOpen) {
        if (!t.closest('#crm-nav-menu') && !t.closest('#crm-nav-menu-btn')) setMenuOpen(false);
      }
    });

    document.addEventListener('keydown', function (e) {
      if ((e.key === 'Escape' || e.key === 'Esc') && navState.menuOpen) setMenuOpen(false);
    });

    document.addEventListener('dragstart', function (e) {
      var a = e.target && e.target.closest && e.target.closest('a.nav-item[data-nav-key]');
      if (!a || a.getAttribute('draggable') !== 'true') return;
      var key = a.getAttribute('data-nav-key');
      if (!key || key === 'dashboard' || !mouseDevice()) return;
      navState.dragging = true;
      navState.dragKey = key;
      navState.dropped = false;
      navState.dropGroup = '';
      try {
        e.dataTransfer.setData('text/plain', key);
        e.dataTransfer.effectAllowed = 'move';
      } catch (err) {}
      a.classList.add('nav-dragging-item');
      if (document.body) document.body.classList.add('nav-dragging');
    });

    document.addEventListener('dragover', function (e) {
      if (!navState.dragging) return;
      var nav = e.target && e.target.closest && e.target.closest('nav.nav');
      var items = e.target && e.target.closest && e.target.closest('.nav-group-items');
      var group = e.target && e.target.closest && e.target.closest('section.nav-group');
      e.preventDefault(); // anywhere on the page: a drop outside the nav must not navigate to the dragged link
      try { if (e.dataTransfer) e.dataTransfer.dropEffect = (nav || items || group) ? 'move' : 'none'; } catch (err) {}
      if (nav) {
        var nr = nav.getBoundingClientRect();
        if (e.clientY < nr.top + 40) nav.scrollTop -= 12;
        else if (e.clientY > nr.bottom - 40) nav.scrollTop += 12;
      }
      if (group && group.getAttribute('data-hidden') === '1') return;
      if (items) {
        var gid = group && group.getAttribute('data-nav-group');
        if (!gid) return;
        var idx = dropIndexFor(items, e.clientY);
        navState.dropGroup = gid;
        placePlaceholder(items, idx);
      }
    });

    document.addEventListener('drop', function (e) {
      if (!navState.dragging) return;
      e.preventDefault();
      var items = e.target && e.target.closest && e.target.closest('.nav-group-items');
      var group = e.target && e.target.closest && e.target.closest('section.nav-group');
      if (!items || (group && group.getAttribute('data-hidden') === '1')) return;
      var gid = (group && group.getAttribute('data-nav-group')) || navState.dropGroup;
      if (!gid) return;
      var idx = layoutIndexFor(gid, dropIndexFor(items, e.clientY));
      navState.layout = CrmNav.move(navState.layout, navState.dragKey, gid, idx);
      navState.dropped = true;
    });

    document.addEventListener('dragend', function () {
      var dropped = navState.dropped;
      navState.dragging = false;
      navState.dragKey = '';
      navState.dropped = false;
      clearDragDecor();
      if (dropped) {
        paintNav();
        commitPrefs(prefsNow());
      } else if (navState.pendingPaint) {
        paintNav();
      }
    });

    global.addEventListener('pagehide', function () { flushNavPrefs(true); });
    document.addEventListener('visibilitychange', function () {
      var st = document.visibilityState;
      if (st === 'hidden') flushNavPrefs(true);
      if (st === 'visible') {
        if (navState.pendingPaint && !navState.dragging && !navState.menuOpen) paintNav();
        syncFromServer();
      }
    });
    global.addEventListener('storage', function (e) {
      var k = cacheKey();
      if (!k || !e || e.key !== k) return;
      syncFromServer();
    });
  }

  function renderNav(activeKey) {
    navState.active = activeKey || currentKey();
    navState.layout = layoutFromCacheOrDefault();
    if (navState.forcedOpen === undefined) ensureForcedOpen();
    paintNav();
    syncFromServer();
    startChatsBadge();
  }

  function logout() {
    flushNavPrefs(true);
    var done = false;
    function finish() {
      if (done) return;
      done = true;
      clearSession();
      global.location.href = LOGIN_URL;
    }
    var ctl = null;
    try { ctl = new AbortController(); } catch (e) { ctl = null; }
    var timer = setTimeout(function () {
      if (ctl) { try { ctl.abort(); } catch (e) {} }
      finish();
    }, 2000);
    var init = { method: 'POST', headers: { 'Authorization': 'Bearer ' + token() } };
    if (ctl) init.signal = ctl.signal;
    Promise.resolve()
      .then(function () { return fetch('/api/logout', init); })
      .catch(function () {})
      .then(function () { clearTimeout(timer); finish(); });
    return false;
  }

  /* ── PWA: service worker, install banner, standalone splash ──────────── */
  var SPLASH_HTML =
    '<div id="pwa-splash"><div class="pwa-splash-logo-wrap">' +
      '<img src="/crm/assets/biolabs-logo.png" alt="BioLabs Research">' +
    '</div></div>';
  var BANNER_HTML =
    '<div id="pwa-install-banner">' +
      '<div class="pwa-banner-icon">📱</div>' +
      '<div class="pwa-banner-body">' +
        '<div class="pwa-banner-title">Install BioLabs Research</div>' +
        '<div class="pwa-banner-text">Add to home screen</div>' +
      '</div>' +
      '<div class="pwa-banner-btns">' +
        '<button class="pwa-banner-yes" onclick="showPWASteps()">Install</button>' +
        '<button class="pwa-banner-no" onclick="dismissPWA()">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="pwa-steps" id="pwa-steps">' +
      '<b>How to install:</b><br>' +
      '1. Tap the <b>Share</b> button (↑)<br>' +
      '2. Scroll down and tap <b>"Add to Home Screen"</b><br>' +
      '3. Tap <b>"Add"</b> - Done!<br>' +
      '<br>' +
      '<span style="font-size:11px;opacity:0.7;">Android: Chrome menu (⋮) → "Add to Home screen"</span>' +
    '</div>';

  function isStandalone() {
    return (global.matchMedia && global.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  }

  function initSw() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) { r.update(); });
    }).catch(function () {});
    navigator.serviceWorker.register('/crm/sw.js').then(function (reg) {
      reg.addEventListener('updatefound', function () {
        var nw = reg.installing;
        if (nw) {
          nw.addEventListener('statechange', function () {
            if (nw.state === 'activated') { global.location.reload(); }
          });
        }
      });
    }).catch(function () {});
  }

  function initSplash() {
    if (!isStandalone()) return;                // the page keeps no splash markup when not installed
    if (!document.body) { onReady(initSplash); return; }
    document.body.insertAdjacentHTML('beforeend', SPLASH_HTML);
    var splash = document.getElementById('pwa-splash');
    if (!splash) return;
    splash.classList.add('show');
    global.addEventListener('load', function () {
      setTimeout(function () {
        splash.classList.add('fade-out');
        setTimeout(function () { splash.style.display = 'none'; }, 450);
      }, 500);
    });
  }

  function initBanner() {
    // Only pages that carried the install banner before the shell (dashboard) declare <body data-pwa-banner>; the
    // other pages never showed it and keep their green FAB unobstructed.
    if (!document.body || !document.body.hasAttribute('data-pwa-banner') || document.getElementById('pwa-install-banner')) return;
    document.body.insertAdjacentHTML('beforeend', BANNER_HTML);
    global.dismissPWA = function () {
      var b = document.getElementById('pwa-install-banner');
      if (b) b.classList.remove('show');
      try { sessionStorage.setItem('pwa-dismissed', '1'); } catch (e) {}
    };
    global.showPWASteps = function () {
      var s = document.getElementById('pwa-steps');
      if (s) s.classList.add('show');
    };
    var isMobile = global.innerWidth <= 768 || /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
    var dismissed = '';
    try { dismissed = sessionStorage.getItem('pwa-dismissed') || ''; } catch (e) {}
    if (isMobile && !dismissed && !isStandalone()) {
      setTimeout(function () {
        var b = document.getElementById('pwa-install-banner');
        if (b) b.classList.add('show');
      }, 3000);
    }
  }

  function initPwa() {
    initSw();
    initSplash();                                // as early as the old inline splash markup
    onReady(initBanner);                         // banner sat at the end of <body> before
  }

  function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* ── exports ─────────────────────────────────────────────────────────── */
  global.api = api;
  global.toast = toast;
  global.showToast = toast;
  global.confirmDialog = confirmDialog;
  global.fmtMoney = fmtMoney;
  global.fmtDate = fmtDate;
  global.renderNav = renderNav;
  global.logout = logout;
  global.initPwa = initPwa;

  initPwa();
  // Safety net: a page that forgets renderNav('<key>') in its script still gets the menu.
  onReady(function () {
    var box = document.getElementById('crm-nav');
    if (box && !box.innerHTML.trim()) renderNav();
  });
})(window);
