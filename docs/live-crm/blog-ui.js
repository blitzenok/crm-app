/* Small DOM helpers shared by the CRM blog pages (list and editor). Everything is built with createElement / textContent:
   no innerHTML with data anywhere, so an article title or an e-mail address can never become markup.
   Dialogs and toasts reuse the CRM's own classes (crm.css .modal-*) so the pages look native. */
(function (root) {
  'use strict';

  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // el('div', {className, text, title, on: {click: fn}, 'aria-label': ...}, [children | strings])
  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v === undefined || v === null || v === false) return;
        if (k === 'text') node.textContent = v;
        else if (k === 'className') node.className = v;
        else if (k === 'on') Object.keys(v).forEach(function (ev) { node.addEventListener(ev, v[ev]); });
        else if (k === 'value') node.value = v;
        else if (k === 'checked') node.checked = !!v;
        else if (k === 'disabled') node.disabled = !!v;
        else if (k === 'hidden') node.hidden = !!v;
        else node.setAttribute(k, v === true ? '' : String(v));
      });
    }
    append(node, children);
    return node;
  }
  function append(node, children) {
    if (children === undefined || children === null) return node;
    (Array.isArray(children) ? children : [children]).forEach(function (c) {
      if (c === undefined || c === null || c === false) return;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    });
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

  function toast(msg, type, ms) {
    if (typeof root.toast === 'function') root.toast(msg, type || 'success', ms);
  }

  // The CRM confirm dialog (crm.js) when present; a plain dialog of ours otherwise.
  function confirm(msg, opts) {
    opts = opts || {};
    if (typeof root.confirmDialog === 'function') return root.confirmDialog(msg, { ok: opts.ok, cancel: opts.cancel });
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      dialog({
        title: msg, closable: true, onClose: function () { fin(false); },
        buttons: [
          { label: opts.cancel || 'Cancel', kind: 'cancel', onClick: function (d) { fin(false); d.close(); } },
          { label: opts.ok || 'OK', kind: 'primary', onClick: function (d) { fin(true); d.close(); } },
        ],
      });
    });
  }

  // ---- time -----------------------------------------------------------------------------------------------------------

  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function parse(v) { var d = v instanceof Date ? v : new Date(v); return isNaN(d.getTime()) ? null : d; }
  function fmtTime(v) { var d = parse(v); return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : ''; }
  // "Oct 2, 14:05" in the browser's time zone
  function fmtDateTime(v) { var d = parse(v); return d ? MONTHS[d.getMonth()] + ' ' + d.getDate() + ', ' + fmtTime(d) : ''; }
  function relTime(v, nowMs) {
    var d = parse(v);
    if (!d) return '';
    var diff = ((nowMs === undefined ? Date.now() : nowMs) - d.getTime()) / 1000;
    if (diff < 45) return 'just now';
    if (diff < 3600) return Math.max(1, Math.round(diff / 60)) + ' min ago';
    if (diff < 86400) return Math.round(diff / 3600) + ' h ago';
    if (diff < 172800) return 'yesterday';
    return MONTHS[d.getMonth()] + ' ' + d.getDate();
  }
  // The staff member's name is the part of the e-mail before the @.
  function who(email) {
    var s = String(email || '');
    var at = s.indexOf('@');
    return (at > 0 ? s.slice(0, at) : s) || 'someone';
  }
  function timeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time'; } catch (e) { return 'local time'; }
  }

  // ---- dialogs ----------------------------------------------------------------------------------------------------------

  var stack = [];
  var FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type=hidden]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  function onKeydown(e) {
    var top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === 'Escape') {
      // The CRM's own confirm (crm.js) may be open above this dialog and closes itself on Escape: leave this one alone then.
      if (document.querySelector('.modal-overlay:not(.bw-overlay)')) return;
      if (top.closable) { e.preventDefault(); e.stopPropagation(); top.close(); }
      return;
    }
    if (e.key !== 'Tab') return;
    var nodes = Array.prototype.filter.call(top.modal.querySelectorAll(FOCUSABLE), function (n) { return n.offsetParent !== null || n === document.activeElement; });
    if (!nodes.length) { e.preventDefault(); return; }
    var first = nodes[0];
    var last = nodes[nodes.length - 1];
    if (!top.modal.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  // dialog({title, body, buttons: [{label, kind: primary|secondary|danger|cancel, onClick(dlg), id, disabled}],
  //         width, closable (default true), onClose, focus: selector})
  function dialog(o) {
    o = o || {};
    var previous = document.activeElement;
    var closable = o.closable !== false;
    var titleId = 'bw-dlg-title-' + (stack.length + 1) + '-' + Math.random().toString(36).slice(2, 6);
    var overlay = el('div', { className: 'modal-overlay open bw-overlay' });
    var modal = el('div', { className: 'modal bw-modal' + (o.className ? ' ' + o.className : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId });
    if (o.width) modal.style.width = o.width + 'px';
    var head = el('div', { className: 'modal-header' }, [
      el('div', { className: 'modal-info' }, [el('div', { className: 'modal-title', id: titleId, text: o.title || '' })]),
    ]);
    var closeBtn = null;
    if (closable) {
      closeBtn = el('button', { type: 'button', className: 'modal-close', 'aria-label': 'Close', text: '×' });
      head.appendChild(closeBtn);
    }
    var body = el('div', { className: 'modal-body' });
    append(body, o.body);
    var footLeft = el('div', { className: 'modal-footer-left' });
    var footRight = el('div', { className: 'modal-footer-right' });
    var foot = el('div', { className: 'modal-footer' }, [footLeft, footRight]);
    modal.appendChild(head);
    modal.appendChild(body);
    if ((o.buttons && o.buttons.length) || o.footLeft) modal.appendChild(foot);
    overlay.appendChild(modal);

    var closed = false;
    var dlg = { el: overlay, modal: modal, body: body, foot: footRight, footLeft: footLeft, closable: closable, buttons: {} };
    dlg.close = function () {
      if (closed) return;
      closed = true;
      var i = stack.indexOf(dlg);
      if (i >= 0) stack.splice(i, 1);
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      if (!stack.length) document.removeEventListener('keydown', onKeydown, true);
      if (previous && previous.focus && document.contains(previous)) { try { previous.focus(); } catch (e) { /* element gone */ } }
      if (typeof o.onClose === 'function') o.onClose();
    };
    dlg.setTitle = function (t) { var n = head.querySelector('.modal-title'); if (n) n.textContent = t; };
    if (closeBtn) closeBtn.addEventListener('click', function () { dlg.close(); });

    function addButton(b) {
      var cls = b.kind === 'primary' ? 'btn btn-primary' : b.kind === 'danger' ? 'btn btn-danger' : b.kind === 'cancel' ? 'btn-cancel' : 'btn btn-secondary';
      var node = el('button', { type: 'button', className: cls + ' bw-dlg-btn', text: b.label, disabled: b.disabled });
      node.addEventListener('click', function () { if (!node.disabled && b.onClick) b.onClick(dlg); });
      (b.left ? footLeft : footRight).appendChild(node);
      if (b.id) dlg.buttons[b.id] = node;
      return node;
    }
    (o.buttons || []).forEach(addButton);
    dlg.addButton = addButton;
    // replaces the whole footer (used by multi-step dialogs such as Publish)
    dlg.setButtons = function (list) {
      clear(footLeft); clear(footRight); dlg.buttons = {};
      if (!foot.parentNode) modal.appendChild(foot);
      list.forEach(addButton);
    };

    if (!stack.length) document.addEventListener('keydown', onKeydown, true);
    stack.push(dlg);
    document.body.appendChild(overlay);
    var target = (o.focus && modal.querySelector(o.focus)) || modal.querySelector('input:not([type=checkbox]), textarea, select') || footRight.querySelector('.btn-primary') || closeBtn;
    if (target && target.focus) target.focus();
    return dlg;
  }

  // ---- popover menu ---------------------------------------------------------------------------------------------------

  var openPopover = null;

  function closePopover() {
    if (!openPopover) return;
    var p = openPopover;
    openPopover = null;
    document.removeEventListener('mousedown', p.outside, true);
    document.removeEventListener('keydown', p.key, true);
    window.removeEventListener('resize', p.close);
    if (p.node.parentNode) p.node.parentNode.removeChild(p.node);
    if (p.anchor) p.anchor.setAttribute('aria-expanded', 'false');
    if (p.returnFocus && p.anchor && p.anchor.focus) p.anchor.focus();
    if (p.onClose) p.onClose();
  }

  // popover(anchor, content, {align: 'left'|'right', className, onClose, returnFocus}) -> {close, node}
  function popover(anchor, content, o) {
    o = o || {};
    closePopover();
    var node = el('div', { className: 'bw-pop' + (o.className ? ' ' + o.className : '') });
    append(node, content);
    document.body.appendChild(node);
    var r = anchor.getBoundingClientRect();
    var w = node.offsetWidth;
    var left = o.align === 'right' ? r.right - w : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    var top = r.bottom + 6;
    if (top + node.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - node.offsetHeight - 6);
    node.style.left = left + 'px';
    node.style.top = top + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    var p = {
      node: node, anchor: anchor, onClose: o.onClose, returnFocus: o.returnFocus !== false, close: closePopover,
      outside: function (e) { if (!node.contains(e.target) && !anchor.contains(e.target)) closePopover(); },
      key: function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(); } },
    };
    document.addEventListener('mousedown', p.outside, true);
    document.addEventListener('keydown', p.key, true);
    window.addEventListener('resize', p.close);
    openPopover = p;
    return { close: closePopover, node: node };
  }

  // menu(anchor, [{label, onClick, disabled, danger, hint, separator}], {align}) with arrow-key navigation
  function menu(anchor, items, o) {
    var box = el('div', { className: 'bw-menu', role: 'menu' });
    items.forEach(function (it) {
      if (it.separator) { box.appendChild(el('div', { className: 'bw-menu-sep', role: 'separator' })); return; }
      var b = el('button', { type: 'button', role: 'menuitem', className: 'bw-menu-item' + (it.danger ? ' bw-danger' : ''), disabled: it.disabled });
      b.appendChild(el('span', { text: it.label }));
      if (it.hint) b.appendChild(el('small', { text: it.hint }));
      b.addEventListener('click', function () { closePopover(); if (it.onClick) it.onClick(); });
      box.appendChild(b);
    });
    box.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      var list = Array.prototype.slice.call(box.querySelectorAll('.bw-menu-item:not([disabled])'));
      if (!list.length) return;
      var i = list.indexOf(document.activeElement);
      i = e.key === 'ArrowDown' ? (i + 1) % list.length : (i <= 0 ? list.length - 1 : i - 1);
      e.preventDefault();
      list[i].focus();
    });
    var pop = popover(anchor, box, o);
    var first = box.querySelector('.bw-menu-item:not([disabled])');
    if (first) first.focus();
    return pop;
  }

  // ---- select ---------------------------------------------------------------------------------------------------------
  // Replaces the browser's <select>: its open list cannot be styled, and a click on it moves focus out of the editor, which
  // is what the block-type list in the toolbar must not do. The page keeps DOM focus on the button the whole time
  // (aria-activedescendant points into the list), the list itself lives on <body> so no scrolling column can clip it, and
  // while it is open one capture-phase keydown handler on the document drives it, wherever the focus is (with `keepFocus`
  // a mouse click leaves the caret in the text, so the keys would otherwise go to the editor).
  // select({options: [{value, label, hint?, className?, muted?}], value, placeholder, onChange(value), ariaLabel | labelledBy,
  //         id, className, title, keepFocus}) -> {el, value(), setValue(v), setOptions(list), setDisabled(b), focus(), open(), close(), isOpen()}
  // onChange fires only for a choice made by the person, never for setValue().
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var selSeq = 0;
  var openSel = null;

  function svgPath(d, size, cls) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('width', String(size));
    s.setAttribute('height', String(size));
    s.setAttribute('aria-hidden', 'true');
    if (cls) s.setAttribute('class', cls);
    var p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', 'currentColor');
    p.setAttribute('stroke-width', '1.8');
    p.setAttribute('stroke-linecap', 'round');
    p.setAttribute('stroke-linejoin', 'round');
    s.appendChild(p);
    return s;
  }
  function reducedMotion() {
    try { return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { return false; }
  }

  function select(o) {
    o = o || {};
    var uid = 'bw-sel-' + (++selSeq);
    var options = [];
    var value = o.value === undefined || o.value === null ? '' : o.value;
    var keepFocus = !!o.keepFocus;
    var disabled = false;
    var list = null;        // the open listbox node
    var active = -1;        // highlighted option while open
    var typed = '';
    var typedTimer = null;
    var labelNode = el('span', { className: 'bw-sel-label' });
    var btn = el('button', {
      type: 'button', id: o.id, className: 'bw-sel' + (o.className ? ' ' + o.className : ''), title: o.title,
      role: 'combobox', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-controls': uid + '-list',
      'aria-label': o.ariaLabel, 'aria-labelledby': o.labelledBy,
    }, [labelNode, svgPath('M5 7.5l5 5 5-5', 14, 'bw-sel-chev')]);

    function indexOf(v) {
      for (var i = 0; i < options.length; i++) if (options[i].value === v) return i;
      return -1;
    }
    function paintLabel() {
      var i = indexOf(value);
      labelNode.textContent = i >= 0 ? options[i].label : (o.placeholder || '');
      labelNode.classList.toggle('bw-sel-muted', i < 0 || !!options[i].muted);
    }
    function paintSelected() {
      if (!list) return;
      Array.prototype.forEach.call(list.children, function (row, i) { row.setAttribute('aria-selected', options[i].value === value ? 'true' : 'false'); });
    }

    function place() {
      var r = btn.getBoundingClientRect();
      list.style.minWidth = Math.max(r.width, 160) + 'px';
      list.style.maxHeight = '';
      var h = list.offsetHeight;
      var below = root.innerHeight - r.bottom - 14;
      var above = r.top - 14;
      var up = h > below && above > below;
      var room = up ? above : below;
      if (h > room) { list.style.maxHeight = Math.max(120, room) + 'px'; h = list.offsetHeight; }
      var w = list.offsetWidth;
      list.style.left = Math.max(8, Math.min(r.left, root.innerWidth - w - 8)) + 'px';
      list.style.top = Math.max(8, up ? r.top - 6 - h : r.bottom + 6) + 'px';
      list.classList.toggle('bw-sel-up', up);
    }

    function setActive(i, scroll) {
      if (!list || i < 0 || i >= options.length) return;
      if (active >= 0 && list.children[active]) list.children[active].classList.remove('bw-act');
      active = i;
      var row = list.children[i];
      row.classList.add('bw-act');
      btn.setAttribute('aria-activedescendant', row.id);
      if (scroll) {
        if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
        else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
      }
    }

    function typeahead(ch) {
      typed += ch.toLowerCase();
      clearTimeout(typedTimer);
      typedTimer = setTimeout(function () { typed = ''; }, 700);
      // one letter pressed again walks on to the next option with that letter; a longer prefix stays put while it still fits
      var start = typed.length === 1 ? active + 1 : active;
      for (var n = 0; n < options.length; n++) {
        var i = (Math.max(start, 0) + n) % options.length;
        if (options[i].label.toLowerCase().indexOf(typed) === 0) { setActive(i, true); return; }
      }
    }

    function choose(i) {
      var opt = options[i];
      if (!opt) return;
      var changed = opt.value !== value;
      value = opt.value;
      paintLabel();
      close(true);
      if (changed && typeof o.onChange === 'function') o.onChange(value);
    }

    // The one handler while open (document, capture): it runs before the editor's or the page's own key handlers.
    function onKey(e) {
      if (!list || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
      var k = e.key;
      var handled = true;
      if (k !== ' ' && k.length > 1) { clearTimeout(typedTimer); typed = ''; }   // moving on starts a new typed prefix
      if (k === 'ArrowDown') setActive(Math.min(options.length - 1, active + 1), true);
      else if (k === 'ArrowUp') setActive(Math.max(0, active - 1), true);
      else if (k === 'Home') setActive(0, true);
      else if (k === 'End') setActive(options.length - 1, true);
      else if (k === 'Enter' || (k === ' ' && !typed)) choose(active);
      else if (k === 'Escape') close(true);
      else if (k === 'Tab') { close(false); handled = false; }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') { /* the toolbar would move focus away under an open list */ }
      else if (k.length === 1) typeahead(k);
      else handled = false;
      if (handled) { e.preventDefault(); e.stopPropagation(); }
    }
    function onOutside(e) { if (list && !list.contains(e.target) && !btn.contains(e.target)) close(false); }
    function onMove(e) { if (list && !list.contains(e.target)) close(false); }
    function onResize() { close(false); }

    function open() {
      if (disabled || list || !options.length) return;
      if (openSel) openSel.close();
      closePopover();
      var node = el('div', { id: uid + '-list', className: 'bw-sel-list', role: 'listbox', 'aria-label': o.ariaLabel, 'aria-labelledby': o.labelledBy });
      options.forEach(function (opt, i) {
        var row = el('div', {
          id: uid + '-o' + i, role: 'option', className: 'bw-sel-opt' + (opt.className ? ' ' + opt.className : '') + (opt.muted ? ' bw-sel-muted' : ''),
          'aria-selected': opt.value === value ? 'true' : 'false',
        }, [el('span', { className: 'bw-sel-tick' }, [svgPath('M4.5 10.5l3.5 3.5 7.5-8', 14)]), el('span', { className: 'bw-sel-text', text: opt.label }), opt.hint ? el('small', { text: opt.hint }) : null]);
        row.addEventListener('mousemove', function () { if (active !== i) setActive(i, false); });
        row.addEventListener('click', function () { choose(i); });
        node.appendChild(row);
      });
      // A click in the list must not take focus from where it is (the editor keeps its caret).
      node.addEventListener('mousedown', function (e) { e.preventDefault(); });
      list = node;
      active = -1;
      document.body.appendChild(node);
      place();
      setActive(Math.max(0, indexOf(value)), true);
      btn.setAttribute('aria-expanded', 'true');
      document.addEventListener('keydown', onKey, true);
      document.addEventListener('mousedown', onOutside, true);
      root.addEventListener('resize', onResize);
      openSel = api;
      // The scroll listener waits one frame: focusing the button may scroll its column, and that event must not close the list.
      root.requestAnimationFrame(function () {
        if (list !== node) return;
        node.classList.add('bw-sel-open');
        root.addEventListener('scroll', onMove, true);
      });
    }

    function close(restoreFocus) {
      if (!list) return;
      var node = list;
      list = null;
      active = -1;
      if (openSel === api) openSel = null;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onOutside, true);
      root.removeEventListener('resize', onResize);
      root.removeEventListener('scroll', onMove, true);
      clearTimeout(typedTimer);
      typed = '';
      btn.setAttribute('aria-expanded', 'false');
      btn.removeAttribute('aria-activedescendant');
      node.classList.remove('bw-sel-open');
      var drop = function () { if (node.parentNode) node.parentNode.removeChild(node); };
      if (reducedMotion()) drop();
      else {
        // fades out for a moment; its ids are released at once so a list opened again straight away is the only one with them
        node.setAttribute('aria-hidden', 'true');
        node.style.pointerEvents = 'none';
        Array.prototype.forEach.call(node.querySelectorAll('[id]'), function (n) { n.removeAttribute('id'); });
        node.removeAttribute('id');
        setTimeout(drop, 180);
      }
      if (restoreFocus && !keepFocus) btn.focus();
    }

    if (keepFocus) btn.addEventListener('mousedown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function () {
      if (list) { close(true); return; }
      if (!keepFocus) btn.focus();   // Safari does not focus a button on click
      open();
    });
    btn.addEventListener('keydown', function (e) {
      if (list || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); }
    });
    // Space acts on key-up for a button (Firefox): the key-down already opened the list, so the click must not toggle it shut again.
    btn.addEventListener('keyup', function (e) { if (e.key === ' ') e.preventDefault(); });

    function setOptions(items) {
      close(false);
      options = (items || []).map(function (x) { return { value: x.value, label: String(x.label), hint: x.hint, className: x.className, muted: !!x.muted }; });
      paintLabel();
    }

    var api = {
      el: btn,
      value: function () { return value; },
      setValue: function (v) { value = v === undefined || v === null ? '' : v; paintLabel(); paintSelected(); },
      setOptions: setOptions,
      setDisabled: function (b) { disabled = !!b; btn.disabled = disabled; if (disabled) close(false); },
      focus: function () { btn.focus(); },
      open: open,
      close: function () { close(false); },
      isOpen: function () { return !!list; },
    };
    setOptions(o.options);
    return api;
  }

  function debounce(fn, ms) {
    var t = null;
    var d = function () {
      var args = arguments;
      var self = this;
      if (t !== null) clearTimeout(t);
      t = setTimeout(function () { t = null; fn.apply(self, args); }, ms);
    };
    d.cancel = function () { if (t !== null) { clearTimeout(t); t = null; } };
    return d;
  }

  // Opens the article's preview in a new tab. The tab is opened at once (a click handler may open windows, an async
  // continuation may not) and pointed at the address when `getUrl()` resolves; if it fails the empty tab is closed again.
  var SITE_ORIGIN = 'https://biolabsresearch.co';
  function previewUrl(token) { return SITE_ORIGIN + '/blog-preview#' + token; }
  function openLater(getUrl) {
    var w = null;
    try {
      w = window.open('', '_blank');
      if (w) { w.opener = null; w.document.title = 'Preview'; w.document.body.textContent = 'Preparing the preview\u2026'; }
    } catch (e) { w = null; }
    return Promise.resolve().then(getUrl).then(function (url) {
      if (w && !w.closed) w.location.href = url; else window.open(url, '_blank');
    }, function (err) {
      if (w && !w.closed) w.close();
      throw err;
    });
  }

  // Friendly texts for upload failures (the server answers 413/415/507/429/503 with its own English messages; these are the
  // ones the spec and the author's checklist want to read).
  function uploadError(e, kind) {
    var st = e && e.status;
    if (e && e.name === 'AbortError') return 'Upload cancelled';
    if (st === 0) return 'Upload failed \u2014 check your connection and try again';
    if (st === 401) return 'Session expired \u2014 sign in in another tab and try again';
    if (kind === 'video') {
      if (st === 429) return 'Another video is being processed \u2014 try again in a few minutes';
      if (st === 413) return 'Video is too large (max 100 MB)';
      if (st === 415) return 'Use MP4, MOV or WebM';
      if (st === 503) return 'Video upload is not available right now';
      if (st === 507) return 'Storage is full \u2014 tell the site team';
    } else {
      if (st === 413) return 'Image is too large (max 10 MB, 8000 px per side)';
      if (st === 415) return 'Use JPG, PNG, WebP or GIF';
      if (st === 507) return 'Storage is full \u2014 tell the site team';
    }
    return (e && e.message) || 'Upload failed';
  }

  // ---- the short "how this works" note (the "?" button of the list and of the editor) ---------------------------------
  // One text for both pages, in plain words: the people who open it write articles, they do not know how the site is built.
  var HELP = [
    ['Article list', 'All articles and their status. Draft: not on the site. Scheduled: goes live at the set time. Published: on the site.'],
    ['Writing', 'Type in the big field. Toolbar: headings, lists, links. Insert: image, video, table, FAQ, button.'],
    ['Pictures', 'Pull the left or right edge to resize. Fill in Alt text: what is in the picture.'],
    ['Saving', 'Automatic. The green label shows the time of the last save.'],
    ['Panel on the right', 'Post: address, category, cover. SEO: title and description for Google. Checklist: red must be fixed, yellow is advice.'],
    ['Preview', 'The page as a visitor will see it. Nothing goes to the site.'],
    ['Publish', 'Puts the article on the site at once. Later edits stay hidden until you press Update.'],
    ['The … menu', 'History, Duplicate, Unpublish, Delete (kept in the trash for 30 days).'],
    ['Full screen', 'Hides the CRM menu. Esc brings it back.'],
  ];
  function help() {
    var body = el('div', { className: 'bw-help' }, HELP.map(function (h) {
      return el('div', { className: 'bw-help-row' }, [el('div', { className: 'bw-help-term', text: h[0] }), el('div', { className: 'bw-help-text', text: h[1] })]);
    }));
    return dialog({ title: 'How the Blog works', body: body, width: 640, className: 'bw-help-modal', buttons: [{ label: 'Got it', kind: 'primary', onClick: function (d) { d.close(); } }] });
  }

  root.BlogUi = {
    help: help,
    uploadError: uploadError,
    SITE_ORIGIN: SITE_ORIGIN, previewUrl: previewUrl, openLater: openLater,
    el: el, append: append, clear: clear, toast: toast, confirm: confirm, dialog: dialog, popover: popover, menu: menu, select: select,
    closePopover: closePopover, debounce: debounce, relTime: relTime, fmtTime: fmtTime, fmtDateTime: fmtDateTime, who: who,
    timeZone: timeZone,
  };
}(window));
