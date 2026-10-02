/* Toolbar, "/" block menu and the floating selection bar of the article editor (spec section 9).
   Shared namespace window.BlogEditPage. Everything talks to the engine through ctx.getEditor() (BlogEditor.create result):
   commands.*, state(), onSelection(), cursorRect(), deleteCharsBefore(). No engine internals are touched.
   ctx also provides: dialogs (link, video, table, button, emoji), pickImage(). */
(function (root) {
  'use strict';
  var NS = root.BlogEditPage = root.BlogEditPage || {};
  var ui = root.BlogUi;
  var el = ui.el;
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var isMac = /Mac|iPhone|iPad/.test((root.navigator && root.navigator.platform) || '');
  var MOD = isMac ? '⌘' : 'Ctrl+';
  var SHIFT = isMac ? '⇧' : 'Shift+';
  var ALT = isMac ? '⌥' : 'Alt+';
  function keys(s) { return s.replace(/\{M\}/g, MOD).replace(/\{S\}/g, SHIFT).replace(/\{A\}/g, ALT); }

  function icon(paths) {
    var s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('viewBox', '0 0 20 20');
    s.setAttribute('width', '18');
    s.setAttribute('height', '18');
    s.setAttribute('aria-hidden', 'true');
    paths.forEach(function (d) {
      var p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1.6');
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      s.appendChild(p);
    });
    return s;
  }
  var ICONS = {
    code: ['M7 6l-4 4 4 4', 'M13 6l4 4-4 4'],
    link: ['M8.6 11.4a3 3 0 004.2 0l2.4-2.4a3 3 0 00-4.2-4.2l-.9.9', 'M11.4 8.6a3 3 0 00-4.2 0L4.8 11a3 3 0 004.2 4.2l.9-.9'],
    alignLeft: ['M3 5h14', 'M3 9h9', 'M3 13h14', 'M3 17h9'],
    alignCenter: ['M3 5h14', 'M5.5 9h9', 'M3 13h14', 'M5.5 17h9'],
    alignRight: ['M3 5h14', 'M8 9h9', 'M3 13h14', 'M8 17h9'],
    divider: ['M2.5 10h15'],
    undo: ['M5 8h7a4 4 0 010 8H8', 'M8 4.5L4.5 8 8 11.5'],
    redo: ['M15 8H8a4 4 0 000 8h4', 'M12 4.5L15.5 8 12 11.5'],
    plus: ['M10 4v12', 'M4 10h12'],
  };

  // Items shared by the Insert menu and the "/" menu. `run` is called after the typed "/" (if any) has been removed.
  function blockItems(ctx) {
    var cmd = function () { return ctx.getEditor().commands; };
    return [
      { id: 'h2', label: 'Heading 2', words: 'title section h2 subheading', run: function () { cmd().setHeading(2); }, slash: true },
      { id: 'h3', label: 'Heading 3', words: 'h3 subheading', run: function () { cmd().setHeading(3); }, slash: true },
      { id: 'h4', label: 'Heading 4', words: 'h4 subheading', run: function () { cmd().setHeading(4); }, slash: true },
      { id: 'bullets', label: 'Bulleted list', words: 'bullet unordered list ul', run: function () { cmd().toggleBulletList(); }, slash: true },
      { id: 'numbers', label: 'Numbered list', words: 'ordered ol numbers list', run: function () { cmd().toggleOrderedList(); }, slash: true },
      { id: 'quote', label: 'Quote', words: 'blockquote citation', run: function () { cmd().toggleBlockquote(); }, slash: true },
      { id: 'image', label: 'Image', words: 'picture photo upload', run: function () { ctx.pickImage(); }, insert: true, slash: true },
      { id: 'video', label: 'Video', words: 'youtube vimeo movie', run: function () { ctx.dialogs.video(); }, insert: true, slash: true },
      { id: 'table', label: 'Table', words: 'grid rows columns', run: function () { ctx.dialogs.table(); }, insert: true, slash: true, noTable: true },
      { id: 'callout', label: 'Callout', words: 'note warning tip box', run: function () { cmd().insertCallout('note'); }, insert: true, slash: true },
      { id: 'faq', label: 'FAQ', words: 'questions answers accordion', run: function () { cmd().insertFaq(); }, insert: true, slash: true },
      { id: 'button', label: 'Button', words: 'cta link call to action', run: function () { ctx.dialogs.button(); }, insert: true, slash: true },
      { id: 'toc', label: 'Contents', words: 'table of contents toc', run: function () { cmd().insertToc(); }, insert: true, slash: true },
      { id: 'divider', label: 'Divider', words: 'hr line rule separator', run: function () { cmd().insertHorizontalRule(); }, insert: true, slash: true },
      { id: 'emoji', label: 'Emoji', words: 'smile symbol', run: function () { ctx.dialogs.emoji(ctx.slashAnchor && ctx.slashAnchor()); }, insert: true, slash: true },
    ];
  }

  // ---- toolbar -------------------------------------------------------------------------------------------------------

  function createToolbar(ctx, mount) {
    var buttons = [];       // { node, active(state), enabled(state) }
    var tableRow = null;
    var select = null;
    var row = el('div', { className: 'bw-tb-row' });
    var cmd = function () { return ctx.getEditor().commands; };

    // Groups wrap as units when the column is narrow, so a pair like undo/redo never ends up alone on a line.
    var group = el('div', { className: 'bw-tb-group' });
    row.appendChild(group);
    function sep() { group = el('div', { className: 'bw-tb-group' }); row.appendChild(group); }
    function addTo(parent, o) {
      var b = el('button', { type: 'button', className: 'bw-tb-btn' + (o.className ? ' ' + o.className : ''), title: keys(o.title), 'aria-label': o.title.replace(/\s*\(.*\)$/, '') });
      if (o.icon) b.appendChild(icon(o.icon)); else b.appendChild(el('span', { className: 'bw-tb-glyph', text: o.glyph }));
      if (o.toggle) b.setAttribute('aria-pressed', 'false');
      // The editor keeps the caret: pressing a toolbar button must not blur it.
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function (e) { o.run(e, b); });
      parent.appendChild(b);
      buttons.push({ node: b, active: o.active, enabled: o.enabled, toggle: !!o.toggle });
      return b;
    }
    function add(o) { return addTo(group, o); }

    // keepFocus: a click on the list leaves the caret in the text, and the choice is applied to the selection that is still there.
    select = ui.select({
      className: 'bw-tb-select', ariaLabel: 'Text style', title: 'Text style', placeholder: '\u2014', keepFocus: true,
      options: [
        { value: 'paragraph', label: 'Paragraph' },
        { value: 'heading2', label: 'Heading 2', className: 'bw-sel-h2' },
        { value: 'heading3', label: 'Heading 3', className: 'bw-sel-h3' },
        { value: 'heading4', label: 'Heading 4', className: 'bw-sel-h4' },
      ],
      onChange: function (v) {
        if (v === 'paragraph') cmd().setParagraph(); else if (/^heading[234]$/.test(v)) cmd().setHeading(Number(v.slice(7)));
        ctx.getEditor().focus();
      },
    });
    group.appendChild(select.el);
    sep();
    add({ glyph: 'B', className: 'bw-b', title: 'Bold ({M}B)', toggle: true, run: function () { cmd().toggleBold(); }, active: function (s) { return s.marks.bold; } });
    add({ glyph: 'I', className: 'bw-i', title: 'Italic ({M}I)', toggle: true, run: function () { cmd().toggleItalic(); }, active: function (s) { return s.marks.italic; } });
    add({ glyph: 'U', className: 'bw-u', title: 'Underline ({M}U)', toggle: true, run: function () { cmd().toggleUnderline(); }, active: function (s) { return s.marks.underline; } });
    add({ glyph: 'S', className: 'bw-s', title: 'Strikethrough ({M}{S}S)', toggle: true, run: function () { cmd().toggleStrike(); }, active: function (s) { return s.marks.strike; } });
    add({ icon: ICONS.code, title: 'Code ({M}E)', toggle: true, run: function () { cmd().toggleCode(); }, active: function (s) { return s.marks.code; } });
    add({ glyph: 'x₂', title: 'Subscript ({M},)', toggle: true, run: function () { cmd().toggleSubscript(); }, active: function (s) { return s.marks.subscript; } });
    add({ glyph: 'x²', title: 'Superscript ({M}.)', toggle: true, run: function () { cmd().toggleSuperscript(); }, active: function (s) { return s.marks.superscript; } });
    add({ glyph: 'Hl', className: 'bw-hl', title: 'Highlight ({M}{S}H)', toggle: true, run: function () { cmd().toggleHighlight(); }, active: function (s) { return s.marks.highlight; } });
    add({ icon: ICONS.link, title: 'Link ({M}K)', toggle: true, run: function () { ctx.dialogs.link(); }, active: function (s) { return !!s.marks.link; } });
    sep();
    add({ glyph: '•', title: 'Bulleted list ({M}{S}8)', toggle: true, run: function () { cmd().toggleBulletList(); }, active: function (s) { return s.list === 'bulletList'; } });
    add({ glyph: '1.', title: 'Numbered list ({M}{S}7)', toggle: true, run: function () { cmd().toggleOrderedList(); }, active: function (s) { return s.list === 'orderedList'; } });
    add({ glyph: '“', className: 'bw-q', title: 'Quote ({M}{S}B)', toggle: true, run: function () { cmd().toggleBlockquote(); }, active: function (s) { return s.blockquote; } });
    sep();
    ['left', 'center', 'right'].forEach(function (a) {
      add({ icon: ICONS['align' + a.charAt(0).toUpperCase() + a.slice(1)], title: 'Align ' + a + ' ({M}{S}' + (a === 'left' ? 'L' : a === 'center' ? 'E' : 'R') + ')', toggle: true, run: function () { cmd().setTextAlign(a); },
        active: function (s) { return (s.textAlign || 'left') === a; }, enabled: function (s) { return s.block === 'paragraph' || /^heading/.test(s.block); } });
    });
    sep();
    add({ icon: ICONS.divider, title: 'Divider', run: function () { cmd().insertHorizontalRule(); } });
    var insertBtn = add({ glyph: 'Insert ▾', className: 'bw-tb-wide', title: 'Insert a block', run: function (e, b) { openInsert(b); } });
    insertBtn.setAttribute('aria-haspopup', 'menu');
    insertBtn.setAttribute('aria-expanded', 'false');
    sep();
    add({ icon: ICONS.undo, title: 'Undo ({M}Z)', run: function () { cmd().undo(); }, enabled: function (s) { return s.canUndo; } });
    add({ icon: ICONS.redo, title: 'Redo ({M}{S}Z)', run: function () { cmd().redo(); }, enabled: function (s) { return s.canRedo; } });

    function openInsert(anchor) {
      var st = ctx.getEditor().state();
      var items = blockItems(ctx).filter(function (i) { return i.insert; }).map(function (i) {
        return { label: i.label, disabled: !!(i.noTable && st.inTable), onClick: function () { i.run(); } };
      });
      ui.menu(anchor, items);
    }

    // second row, only while the caret is in a table
    tableRow = el('div', { className: 'bw-tb-row bw-tb-table', hidden: true, role: 'group', 'aria-label': 'Table' });
    [
      ['Row above', 'addRowBefore'], ['Row below', 'addRowAfter'], ['Column left', 'addColumnBefore'], ['Column right', 'addColumnAfter'],
      ['Delete row', 'deleteRow'], ['Delete column', 'deleteColumn'], ['Header row', 'toggleHeaderRow'], ['Merge cells', 'mergeCells'], ['Split cell', 'splitCell'], ['Delete table', 'deleteTable'],
    ].forEach(function (t) {
      var danger = t[1] === 'deleteTable';
      var b = el('button', { type: 'button', className: 'bw-tb-btn bw-tb-text' + (danger ? ' bw-danger' : ''), text: t[0], title: t[0] });
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () {
        if (danger) { ui.confirm('Delete this table?', { ok: 'Delete table' }).then(function (yes) { if (yes) cmd().deleteTable(); }); return; }
        cmd()[t[1]]();
      });
      tableRow.appendChild(b);
      buttons.push({ node: b, enabled: function () { return true; } });
    });

    mount.appendChild(row);
    mount.appendChild(tableRow);

    // role=toolbar: one tab stop, arrows move between the buttons
    function focusables() { return Array.prototype.slice.call(mount.querySelectorAll('button:not([disabled])')); }
    mount.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var list = focusables();
      var i = list.indexOf(document.activeElement);
      if (i < 0) return;
      e.preventDefault();
      list[(i + (e.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length].focus();
    });

    function update(s) {
      var ed = s.editable;
      buttons.forEach(function (b) {
        var on = b.active ? !!b.active(s) : false;
        if (b.toggle) b.node.setAttribute('aria-pressed', on ? 'true' : 'false');
        b.node.classList.toggle('bw-active', on);
        b.node.disabled = !ed || (b.enabled ? !b.enabled(s) : false);
      });
      var textBlock = s.block === 'paragraph' || /^heading[234]$/.test(s.block);
      select.setDisabled(!ed || !textBlock);
      select.setValue(textBlock ? s.block : 'other');   // 'other' matches no option: the field shows the dash
      tableRow.hidden = !s.inTable;
      var count = document.getElementById('bw-count');
      if (count) count.textContent = s.words + (s.words === 1 ? ' word' : ' words');
    }
    return { update: update, row: row };
  }

  // ---- "/" menu ------------------------------------------------------------------------------------------------------

  // Opens when a paragraph holds exactly "/" and filters while the author types after it. The engine has no hook for this,
  // so the page reads the caret's block from the DOM on every selection change; Enter/arrows/Escape are caught in the
  // capture phase while the menu is open (before ProseMirror splits the line). Choosing an item first removes "/query".
  function createSlash(ctx, host) {
    var items = blockItems(ctx).filter(function (i) { return i.slash; });
    var open = null;   // { query, index, list, node, listEl }

    function caretBlockText() {
      var sel = root.getSelection && root.getSelection();
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return null;
      var n = sel.anchorNode;
      var elNode = n && (n.nodeType === 3 ? n.parentElement : n);
      var block = elNode && elNode.closest && elNode.closest('p');
      if (!block || !host.contains(block)) return null;
      return block.textContent;
    }
    function filter(q) {
      q = q.toLowerCase().trim();
      return items.filter(function (i) { return !q || i.label.toLowerCase().indexOf(q) >= 0 || i.words.indexOf(q) >= 0; });
    }
    function close() {
      if (!open) return;
      if (open.node.parentNode) open.node.parentNode.removeChild(open.node);
      open = null;
    }
    function paint() {
      ui.clear(open.listEl);
      if (!open.list.length) { open.listEl.appendChild(el('div', { className: 'bw-slash-empty', text: 'No matching block' })); return; }
      open.list.forEach(function (it, i) {
        var b = el('button', { type: 'button', role: 'option', className: 'bw-slash-item' + (i === open.index ? ' bw-on' : ''), 'aria-selected': i === open.index ? 'true' : 'false', text: it.label });
        b.addEventListener('mousedown', function (e) { e.preventDefault(); choose(it); });
        open.listEl.appendChild(b);
      });
      var on = open.listEl.querySelector('.bw-on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }
    function place() {
      var r = ctx.getEditor().cursorRect();
      if (!r) return;
      var h = open.node.offsetHeight;
      var top = r.bottom + 6;
      if (top + h > root.innerHeight - 8) top = Math.max(8, r.top - h - 6);
      open.node.style.top = top + 'px';
      open.node.style.left = Math.max(8, Math.min(r.left, root.innerWidth - open.node.offsetWidth - 8)) + 'px';
    }
    function show() {
      var listEl = el('div', { className: 'bw-slash-list', role: 'listbox', 'aria-label': 'Blocks' });
      var node = el('div', { className: 'bw-slash bw-pop' }, [listEl]);
      document.body.appendChild(node);
      open = { query: '', index: 0, list: filter(''), node: node, listEl: listEl };
      paint();
      place();
    }
    function choose(it) {
      var n = 1 + open.query.length;
      close();
      var ed = ctx.getEditor();
      ed.commands.deleteCharsBefore(n);
      it.run();
    }
    function refresh() {
      var ed = ctx.getEditor();
      if (!ed) return;
      var text = caretBlockText();
      var st = ed.state();
      if (!open) {
        if (text === '/' && st.block === 'paragraph' && st.editable) show();
        return;
      }
      if (text === null || text.charAt(0) !== '/') { close(); return; }
      open.query = text.slice(1);
      open.list = filter(open.query);
      if (!open.list.length && open.query.length > 14) { close(); return; }
      open.index = Math.min(open.index, Math.max(0, open.list.length - 1));
      paint();
      place();
    }

    host.addEventListener('keydown', function (e) {
      if (!open) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open.list.length) return;
        e.preventDefault(); e.stopPropagation();
        open.index = (open.index + (e.key === 'ArrowDown' ? 1 : open.list.length - 1)) % open.list.length;
        paint();
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (!open.list.length) { close(); return; }
        e.preventDefault(); e.stopPropagation();
        choose(open.list[open.index]);
      } else if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        close();
      }
    }, true);
    host.addEventListener('blur', function () { setTimeout(close, 120); }, true);
    root.addEventListener('scroll', function () { if (open) place(); }, true);

    return { refresh: refresh, close: close, isOpen: function () { return !!open; } };
  }

  // ---- floating bar over a text selection ------------------------------------------------------------------------------

  function createBubble(ctx, host) {
    var node = el('div', { className: 'bw-bubble', role: 'toolbar', 'aria-label': 'Selection formatting', hidden: true });
    var btns = {};
    var cmd = function () { return ctx.getEditor().commands; };
    function mk(id, label, title, cls, run) {
      var b = el('button', { type: 'button', className: 'bw-tb-btn ' + cls, title: keys(title), 'aria-label': title.replace(/\s*\(.*\)$/, ''), 'aria-pressed': 'false' }, [label]);
      b.addEventListener('mousedown', function (e) { e.preventDefault(); });
      b.addEventListener('click', function () { run(); refresh(); });
      node.appendChild(b);
      btns[id] = b;
    }
    mk('bold', el('span', { className: 'bw-tb-glyph', text: 'B' }), 'Bold ({M}B)', 'bw-b', function () { cmd().toggleBold(); });
    mk('italic', el('span', { className: 'bw-tb-glyph', text: 'I' }), 'Italic ({M}I)', 'bw-i', function () { cmd().toggleItalic(); });
    mk('link', icon(ICONS.link), 'Link ({M}K)', '', function () { hide(); ctx.dialogs.link(); });
    mk('highlight', el('span', { className: 'bw-tb-glyph', text: 'Hl' }), 'Highlight ({M}{S}H)', 'bw-hl', function () { cmd().toggleHighlight(); });
    document.body.appendChild(node);
    var mouseDown = false;

    function hide() { node.hidden = true; }
    function refresh() {
      var ed = ctx.getEditor();
      if (!ed || mouseDown) { return; }
      var s = ed.state();
      var sel = root.getSelection && root.getSelection();
      if (!s.editable || s.empty || s.selectedNode || !s.selectedText.trim() || !sel || !sel.rangeCount || !host.contains(sel.anchorNode)) { hide(); return; }
      var rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) { hide(); return; }
      Object.keys(btns).forEach(function (k) { btns[k].setAttribute('aria-pressed', s.marks[k] ? 'true' : 'false'); btns[k].classList.toggle('bw-active', !!s.marks[k]); });
      node.hidden = false;
      var w = node.offsetWidth;
      var h = node.offsetHeight;
      var top = rect.top - h - 8;
      if (top < 8) top = rect.bottom + 8;
      node.style.top = top + 'px';
      node.style.left = Math.max(8, Math.min(rect.left + rect.width / 2 - w / 2, root.innerWidth - w - 8)) + 'px';
    }
    host.addEventListener('mousedown', function () { mouseDown = true; hide(); });
    document.addEventListener('mouseup', function () { if (mouseDown) { mouseDown = false; setTimeout(refresh, 0); } });
    host.addEventListener('blur', function () { setTimeout(function () { if (!node.contains(document.activeElement) && !host.contains(document.activeElement)) hide(); }, 100); }, true);
    root.addEventListener('scroll', hide, true);
    root.addEventListener('resize', hide);
    return { refresh: refresh, hide: hide };
  }

  NS.createToolbar = createToolbar;
  NS.createSlash = createSlash;
  NS.createBubble = createBubble;
  NS.blockItems = blockItems;
}(window));
