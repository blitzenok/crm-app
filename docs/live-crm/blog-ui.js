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

  root.BlogUi = {
    uploadError: uploadError,
    SITE_ORIGIN: SITE_ORIGIN, previewUrl: previewUrl, openLater: openLater,
    el: el, append: append, clear: clear, toast: toast, confirm: confirm, dialog: dialog, popover: popover, menu: menu,
    closePopover: closePopover, debounce: debounce, relTime: relTime, fmtTime: fmtTime, fmtDateTime: fmtDateTime, who: who,
    timeZone: timeZone,
  };
}(window));
