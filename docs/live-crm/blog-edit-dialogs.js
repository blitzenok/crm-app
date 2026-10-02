/* Dialogs of the article editor: link, video, table, button, emoji, history, schedule, publish, conflict, recover, download.
   Shared namespace window.BlogEditPage; blog-edit.js calls createDialogs(ctx) once.
   ctx: { ui, api, keeper, getEditor(), getPost(), getPayload(), panel(), plainText(payload), applyServerPost(post),
          afterTransition(res), reloadPost(message) }. */
(function (root) {
  'use strict';
  var NS = root.BlogEditPage = root.BlogEditPage || {};

  function createDialogs(ctx) {
    var ui = ctx.ui;
    var el = ui.el;
    var ed = function () { return ctx.getEditor(); };
    var CHANGED = 'The article changed \u2014 review it again';

    function msgBox() { return el('div', { className: 'bw-msg bw-msg-bad', role: 'alert' }); }
    function row(label, control, id) { return el('div', { className: 'bw-field' }, [el('label', { className: 'bw-label', for: id, text: label }), control]); }
    function checkRow(id, label, checked) {
      return el('div', { className: 'bw-check' }, [el('input', { type: 'checkbox', id: id, checked: checked }), el('label', { for: id, text: label })]);
    }

    // ---- link ---------------------------------------------------------------------------------------------------------

    function normalizeAddress(v) {
      v = String(v || '').trim();
      // "example.com/page" typed without a scheme: the editor only accepts full addresses
      if (v && !/^[a-z][a-z0-9+.-]*:/i.test(v) && !/^[/#]/.test(v) && /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(\/|$|\?|#)/i.test(v)) return 'https://' + v;
      return v;
    }

    function link() {
      var e = ed();
      var st = e.state();
      var existing = st.link;
      var needsText = st.empty && !existing;
      var url = el('input', { id: 'bw-link-url', className: 'bw-input', type: 'text', autocomplete: 'off', placeholder: 'Paste an address or search the site below', value: existing ? existing.href : '' });
      var text = el('input', { id: 'bw-link-text', className: 'bw-input', type: 'text', autocomplete: 'off', placeholder: 'Link text (optional)' });
      var results = el('div', { className: 'bw-lookup', role: 'listbox', 'aria-label': 'Pages and articles of the site' });
      var newTab = checkRow('bw-link-tab', 'Open in new tab', existing ? existing.newTab : false);
      var nofollow = checkRow('bw-link-nofollow', 'nofollow', existing ? existing.nofollow : false);
      var err = msgBox();
      var body = [row('Address', url, 'bw-link-url')];
      if (needsText) body.push(row('Text', text, 'bw-link-text'));
      body.push(el('div', { className: 'bw-label', text: 'Link to a page of the site' }), results, newTab, nofollow, err);

      var seq = 0;
      function search(q) {
        var my = ++seq;
        ctx.api.get('lookup?q=' + encodeURIComponent(q)).then(function (list) {
          if (my !== seq) return;
          ui.clear(results);
          (Array.isArray(list) ? list : []).forEach(function (it) {
            var b = el('button', { type: 'button', role: 'option', className: 'bw-lookup-item' }, [
              el('span', { className: 'bw-kind bw-kind-' + (it.kind === 'product' ? 'product' : 'article'), text: it.kind === 'product' ? 'Product' : 'Article' }),
              el('span', { className: 'bw-lookup-title', text: it.title }),
              el('small', { text: it.url }),
            ]);
            b.addEventListener('click', function () {
              url.value = it.url;
              if (needsText && !text.value) text.value = it.title;
              err.textContent = '';
              url.focus();
            });
            results.appendChild(b);
          });
          if (!results.firstChild) results.appendChild(el('div', { className: 'bw-hint', text: q ? 'No page found' : 'Nothing to suggest yet' }));
        }, function () {
          if (my !== seq) return;
          ui.clear(results);
          results.appendChild(el('div', { className: 'bw-hint', text: 'Search is not available right now. You can still paste an address.' }));
        });
      }
      var debounced = ui.debounce(function () { search(url.value.trim()); }, 250);

      function apply() {
        var href = normalizeAddress(url.value);
        if (!href) { err.textContent = 'Enter an address'; url.focus(); return; }
        var ok = ed().commands.setLink({ href: href, newTab: newTab.firstChild.checked, nofollow: nofollow.firstChild.checked, text: text.value.trim() || undefined });
        if (!ok) { err.textContent = 'This address is not allowed'; url.focus(); return; }
        dlg.close();
      }
      var buttons = [
        { label: 'Cancel', kind: 'cancel', onClick: function (d) { d.close(); } },
        { label: existing ? 'Update link' : 'Add link', kind: 'primary', onClick: apply },
      ];
      if (existing) buttons.unshift({ label: 'Remove link', kind: 'danger', left: true, onClick: function (d) { ed().commands.unsetLink(); d.close(); } });
      var dlg = ui.dialog({ title: existing ? 'Edit link' : 'Add link', body: body, buttons: buttons, width: 520, onClose: function () { debounced.cancel(); seq++; ed().focus(); } });
      url.addEventListener('input', function () { err.textContent = ''; debounced(); });
      url.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); apply(); } });
      search('');
      url.focus();
      url.select();
    }

    // ---- video --------------------------------------------------------------------------------------------------------

    function video() {
      var tabs = el('div', { className: 'bw-dtabs', role: 'tablist' });
      var panes = {};
      var urlIn = el('input', { id: 'bw-video-url', className: 'bw-input', type: 'text', autocomplete: 'off', placeholder: 'Paste a YouTube or Vimeo address' });
      var titleIn = el('input', { id: 'bw-video-title', className: 'bw-input', type: 'text', maxlength: '120', autocomplete: 'off', placeholder: 'Describe the video for screen readers' });
      var err = msgBox();
      panes.link = el('div', {}, [row('Video address', urlIn, 'bw-video-url'), row('Title', titleIn, 'bw-video-title'), err]);
      var file = el('input', { type: 'file', accept: 'video/mp4,video/quicktime,video/webm', hidden: true, 'aria-label': 'Video file' });
      var pick = el('button', { type: 'button', className: 'btn btn-secondary', text: 'Choose a video file' });
      pick.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        ed().commands.uploadVideo(f);
        dlg.close();
      });
      panes.upload = el('div', { hidden: true }, [
        el('p', { className: 'bw-hint', text: 'MP4, MOV or WebM, up to 100 MB. The video is converted after the upload; a placeholder in the text shows the progress and you can keep writing.' }),
        pick, file,
      ]);
      function select(name) {
        Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
        Array.prototype.forEach.call(tabs.children, function (b) { b.setAttribute('aria-selected', b.getAttribute('data-tab') === name ? 'true' : 'false'); });
        dlg.foot.querySelector('.btn-primary').hidden = name !== 'link';
      }
      [['link', 'Link'], ['upload', 'Upload']].forEach(function (t) {
        tabs.appendChild(el('button', { type: 'button', role: 'tab', className: 'bw-dtab', 'data-tab': t[0], text: t[1], 'aria-selected': t[0] === 'link' ? 'true' : 'false', on: { click: function () { select(t[0]); } } }));
      });
      function insert() {
        var parsed = root.BlogEditor.parseVideoUrl(urlIn.value.trim());
        if (!parsed) { err.textContent = 'Paste a YouTube or Vimeo address'; urlIn.focus(); return; }
        var ok = ed().commands.insertEmbed({ provider: parsed.provider, videoId: parsed.videoId, title: titleIn.value.trim() });
        if (!ok) { err.textContent = 'This video address is not allowed'; return; }
        dlg.close();
      }
      var dlg = ui.dialog({
        title: 'Add a video', body: [tabs, panes.link, panes.upload], width: 520,
        buttons: [{ label: 'Cancel', kind: 'cancel', onClick: function (d) { d.close(); } }, { label: 'Insert video', kind: 'primary', onClick: insert }],
        onClose: function () { ed().focus(); },
      });
      urlIn.addEventListener('input', function () { err.textContent = ''; });
      urlIn.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); insert(); } });
      urlIn.focus();
    }

    // ---- table --------------------------------------------------------------------------------------------------------

    function table() {
      var rows = 3;
      var cols = 3;
      var grid = el('div', { className: 'bw-grid', role: 'grid', 'aria-label': 'Table size' });
      var label = el('div', { className: 'bw-grid-label', 'aria-live': 'polite' });
      var rowsIn = el('input', { id: 'bw-table-rows', className: 'bw-input bw-num', type: 'number', min: '1', max: '100', value: '3' });
      var colsIn = el('input', { id: 'bw-table-cols', className: 'bw-input bw-num', type: 'number', min: '1', max: '30', value: '3' });
      var header = checkRow('bw-table-header', 'Header row', true);
      var cells = [];
      for (var r = 1; r <= 8; r++) {
        for (var c = 1; c <= 8; c++) {
          (function (rr, cc) {
            var cell = el('button', { type: 'button', className: 'bw-cell', tabindex: '-1', 'aria-label': rr + ' rows by ' + cc + ' columns' });
            cell.addEventListener('mouseenter', function () { rows = rr; cols = cc; paint(); });
            cell.addEventListener('focus', function () { rows = rr; cols = cc; paint(); });
            cell.addEventListener('click', function () { rows = rr; cols = cc; paint(); insert(); });
            grid.appendChild(cell);
            cells.push([rr, cc, cell]);
          }(r, c));
        }
      }
      function paint() {
        cells.forEach(function (x) { x[2].classList.toggle('bw-on', x[0] <= rows && x[1] <= cols); });
        label.textContent = rows + ' × ' + cols;
        rowsIn.value = String(rows);
        colsIn.value = String(cols);
      }
      rowsIn.addEventListener('input', function () { rows = Math.max(1, Math.min(100, parseInt(rowsIn.value, 10) || 1)); paintFrom(); });
      colsIn.addEventListener('input', function () { cols = Math.max(1, Math.min(30, parseInt(colsIn.value, 10) || 1)); paintFrom(); });
      function paintFrom() { cells.forEach(function (x) { x[2].classList.toggle('bw-on', x[0] <= rows && x[1] <= cols); }); label.textContent = rows + ' × ' + cols; }
      function insert() {
        var ok = ed().commands.insertTable({ rows: rows, cols: cols, withHeaderRow: header.firstChild.checked });
        if (ok) dlg.close(); else ui.toast('A table cannot be inserted here', 'error');
      }
      var dlg = ui.dialog({
        title: 'Insert a table', width: 420,
        body: [grid, label, el('div', { className: 'bw-row' }, [row('Rows', rowsIn, 'bw-table-rows'), row('Columns', colsIn, 'bw-table-cols')]), header],
        buttons: [{ label: 'Cancel', kind: 'cancel', onClick: function (d) { d.close(); } }, { label: 'Insert table', kind: 'primary', onClick: insert }],
        onClose: function () { ed().focus(); },
      });
      paint();
    }

    // ---- button block -------------------------------------------------------------------------------------------------

    function button() {
      var label = el('input', { id: 'bw-btn-label', className: 'bw-input', type: 'text', maxlength: '60', autocomplete: 'off', value: 'Read more' });
      var href = el('input', { id: 'bw-btn-href', className: 'bw-input', type: 'text', autocomplete: 'off', placeholder: '/products/… or https://…' });
      var err = msgBox();
      function insert() {
        if (!label.value.trim()) { err.textContent = 'Add the button text'; label.focus(); return; }
        var a = normalizeAddress(href.value);
        if (!a) { err.textContent = 'Add the address the button opens'; href.focus(); return; }
        if (!ed().commands.insertButton({ href: a, label: label.value.trim() })) { err.textContent = 'This address is not allowed'; href.focus(); return; }
        dlg.close();
      }
      var dlg = ui.dialog({
        title: 'Add a button', width: 440, body: [row('Button text', label, 'bw-btn-label'), row('Address', href, 'bw-btn-href'), err],
        buttons: [{ label: 'Cancel', kind: 'cancel', onClick: function (d) { d.close(); } }, { label: 'Add button', kind: 'primary', onClick: insert }],
        onClose: function () { ed().focus(); }, focus: '#bw-btn-href',
      });
      [label, href].forEach(function (i) { i.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); insert(); } }); });
    }

    // ---- emoji --------------------------------------------------------------------------------------------------------

    function emoji(anchor) {
      var list = (root.BlogEditor && root.BlogEditor.EMOJI) || [];
      var search = el('input', { type: 'search', className: 'bw-input', placeholder: 'Search emoji', 'aria-label': 'Search emoji', autocomplete: 'off' });
      var grid = el('div', { className: 'bw-emoji-grid' });
      function paint() {
        var q = search.value.trim().toLowerCase();
        ui.clear(grid);
        var shown = 0;
        list.forEach(function (it) {
          if (q && String(it.name).toLowerCase().indexOf(q) < 0 && String(it.keywords || '').toLowerCase().indexOf(q) < 0) return;
          if (shown++ > 400) return;
          var b = el('button', { type: 'button', className: 'bw-emoji', title: it.name, 'aria-label': it.name, text: it.char });
          b.addEventListener('mousedown', function (e) { e.preventDefault(); });
          b.addEventListener('click', function () { ui.closePopover(); ed().commands.insertEmoji(it.char); });
          grid.appendChild(b);
        });
        if (!shown) grid.appendChild(el('div', { className: 'bw-hint', text: 'No emoji found' }));
      }
      search.addEventListener('input', paint);
      var pop = ui.popover(anchor || document.querySelector('.bw-tb-wide') || document.body, [search, grid], { className: 'bw-emoji-pop' });
      paint();
      search.focus();
      return pop;
    }

    // ---- download ("Download my text") --------------------------------------------------------------------------------

    function download(payload) {
      var text = ctx.plainText(payload);
      var name = 'article-' + (payload.slug || 'untitled') + '.txt';
      // The limit is on the ENCODED length: encodeURIComponent turns every newline and space-like character into 3 bytes,
      // and browsers refuse data: addresses somewhere near 2 MB.
      var encoded = encodeURIComponent(text);
      if (encoded.length > 1500000) {
        var ta = el('textarea', { className: 'bw-input bw-textarea bw-bigtext', rows: '14', readonly: true });
        ta.value = text;
        ui.dialog({
          title: 'Copy your text', width: 640, body: [el('p', { className: 'bw-hint', text: 'The text is too long for a download link. Copy it and keep it somewhere safe.' }), ta],
          buttons: [{ label: 'Close', kind: 'cancel', onClick: function (d) { d.close(); } }, { label: 'Copy', kind: 'primary', onClick: function () {
            ta.select();
            var done = function () { ui.toast('Copied'); };
            if (root.navigator.clipboard && root.navigator.clipboard.writeText) root.navigator.clipboard.writeText(text).then(done, function () { document.execCommand('copy'); done(); });
            else { document.execCommand('copy'); done(); }
          } }],
        });
        return;
      }
      var a = el('a', { href: 'data:text/plain;charset=utf-8,' + encoded, download: name, hidden: true });
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    // ---- history ------------------------------------------------------------------------------------------------------

    function history() {
      var post = ctx.getPost();
      var list = el('div', { className: 'bw-versions', 'aria-live': 'polite' }, [el('div', { className: 'bw-hint', text: 'Loading…' })]);
      var dlg = ui.dialog({ title: 'History', width: 560, body: [el('p', { className: 'bw-hint', text: 'A copy is kept at every Publish or Update and about every 10 minutes while you write.' }), list], buttons: [{ label: 'Close', kind: 'cancel', onClick: function (d) { d.close(); } }] });
      ctx.api.get('posts/' + encodeURIComponent(post.id) + '/versions').then(function (res) {
        var versions = res && res.versions ? res.versions : [];
        ui.clear(list);
        if (!versions.length) { list.appendChild(el('div', { className: 'bw-hint', text: 'No earlier versions yet.' })); return; }
        versions.forEach(function (v) {
          var restore = el('button', { type: 'button', className: 'btn btn-secondary bw-small', text: 'Restore this version' });
          restore.addEventListener('click', function () { restoreVersion(v, dlg, restore); });
          list.appendChild(el('div', { className: 'bw-version' }, [
            el('div', {}, [el('strong', { text: ui.fmtDateTime(v.savedAt) }), el('span', { className: 'bw-hint', text: ' · ' + ui.who(v.by) }), el('div', { className: 'bw-version-title', text: v.title || 'Untitled' })]),
            restore,
          ]));
        });
      }, function (e) {
        ui.clear(list);
        list.appendChild(el('div', { className: 'bw-msg bw-msg-bad', text: (e && e.message) || 'Could not load the history' }));
      });
    }
    function restoreVersion(v, dlg, btn) {
      ui.confirm('Restore the version of ' + ui.fmtDateTime(v.savedAt) + '? Your current draft is replaced by it.', { ok: 'Restore' }).then(function (yes) {
        if (!yes) return;
        btn.disabled = true;
        ctx.flush().then(function () {
          return ctx.api.send('POST', 'posts/' + encodeURIComponent(ctx.getPost().id) + '/restore', { version: v.version, rev: ctx.keeper.rev() });
        }).then(function (post) {
          var outcome = ctx.applyServerPost(post, { reset: true });
          dlg.close();
          if (outcome !== 'blocked' && outcome !== 'kept') ui.toast('Version restored');
        }, function (e) {
          btn.disabled = false;
          if (e && e.status === 409) { dlg.close(); ctx.reloadPost(CHANGED); return; }
          ui.toast((e && e.state) ? 'Could not save the current text first' : ((e && e.message) || 'Could not restore'), 'error');
        });
      });
    }

    // ---- schedule -----------------------------------------------------------------------------------------------------

    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function localInput(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }

    function schedule() {
      var post = ctx.getPost();
      var min = new Date(Date.now() + 5 * 60000);
      var input = el('input', { id: 'bw-schedule-at', className: 'bw-input', type: 'datetime-local', min: localInput(min), value: post.scheduledAt ? localInput(new Date(post.scheduledAt)) : '' });
      var err = msgBox();
      function submit() {
        if (!input.value) { err.textContent = 'Pick a date and time'; input.focus(); return; }
        var at = new Date(input.value);
        if (isNaN(at.getTime()) || at.getTime() < Date.now() + 4 * 60000) { err.textContent = 'Pick a time at least 5 minutes from now'; return; }
        dlg.buttons.go.disabled = true;
        err.textContent = '';
        ctx.flush().then(function () {
          return ctx.api.send('POST', 'posts/' + encodeURIComponent(ctx.getPost().id) + '/schedule', { rev: ctx.keeper.rev(), at: at.toISOString() });
        }).then(function (res) {
          ctx.afterTransition(res);
          ui.toast('Scheduled for ' + ui.fmtDateTime(at));
          dlg.close();
        }, function (e) {
          dlg.buttons.go.disabled = false;
          if (e && e.status === 409) { dlg.close(); ctx.reloadPost(CHANGED); return; }
          if (e && e.status === 422 && Array.isArray(e.body && e.body.required)) { err.textContent = 'Fix the required items first: ' + e.body.required.map(function (r) { return r.message; }).join('; '); return; }
          err.textContent = (e && e.state) ? 'Could not save the article first' : ((e && e.message) || 'Could not schedule');
        });
      }
      var buttons = [{ label: 'Cancel', kind: 'cancel', onClick: function (d) { d.close(); } }, { id: 'go', label: post.scheduledAt ? 'Change time' : 'Schedule', kind: 'primary', onClick: submit }];
      var dlg = ui.dialog({
        title: 'Schedule publication', width: 440,
        body: [row('Publish at', input, 'bw-schedule-at'), el('div', { className: 'bw-hint', text: 'Your time zone: ' + ui.timeZone() }), err],
        buttons: buttons, onClose: function () { ed().focus(); },
      });
      input.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); submit(); } });
    }

    // ---- publish ------------------------------------------------------------------------------------------------------

    var CHECK_TEXT = {
      live: 'The article is live.',
      redirected: 'The site redirects this address elsewhere — tell the site team.',
      foreign: 'Another page answers at this address.',
      stale: 'The site still shows the previous version; it should update within a minute.',
      unreachable: 'Could not verify the page right now.',
      skipped: 'Publishing to the site is switched off (preview mode).',
    };

    function itemList(items, cls, mark) {
      var ul = el('ul', { className: 'bw-checks' });
      items.forEach(function (it) {
        ul.appendChild(el('li', { className: 'bw-check-item ' + cls }, [el('span', { className: 'bw-mark', 'aria-hidden': 'true', text: mark }), el('span', { className: 'bw-check-text', text: it.message })]));
      });
      return ul;
    }

    function publish() {
      var post = ctx.getPost();
      var isUpdate = post.status === 'published';
      var verb = isUpdate ? 'Update' : 'Publish';
      var dlg = ui.dialog({ title: verb + ' article', width: 520, body: [el('p', { className: 'bw-hint', text: 'Saving your latest text…' })], buttons: [{ label: 'Cancel', kind: 'cancel', onClick: function (d) { d.close(); } }] });
      var timer = null;

      function showError(text) {
        ui.clear(dlg.body);
        dlg.body.appendChild(el('div', { className: 'bw-msg bw-msg-bad', role: 'alert', text: text }));
        dlg.setButtons([{ label: 'Close', kind: 'cancel', onClick: function (d) { d.close(); } }]);
      }

      var lastKey = null;
      function render(force) {
        var checks = ctx.panel().checks();
        // Rebuilding the body drops the keyboard focus from the buttons: only do it when something shown has changed.
        var key = [(checks.required || []).length, (checks.warnings || []).length, ed().pendingUploads(), ed().failedUploads()].join('|');
        if (!force && key === lastKey) return;
        lastKey = key;
        var req = checks.required || [];
        var warns = checks.warnings || [];
        var pending = ed().pendingUploads();
        var failed = ed().failedUploads();
        ui.clear(dlg.body);
        if (req.length) {
          dlg.body.appendChild(el('div', { className: 'bw-section' }, [el('div', { className: 'bw-section-title', text: 'Required (' + req.length + ')' }), itemList(req, 'bw-check-bad', '✗')]));
        }
        if (pending) dlg.body.appendChild(el('div', { className: 'bw-msg bw-msg-bad', text: pending + (pending === 1 ? ' upload' : ' uploads') + ' in progress — wait until ' + (pending === 1 ? 'it is' : 'they are') + ' done.' }));
        if (failed) dlg.body.appendChild(el('div', { className: 'bw-msg bw-msg-bad', text: failed + (failed === 1 ? ' upload failed' : ' uploads failed') + ' and ' + (failed === 1 ? 'is' : 'are') + ' not part of the article. Retry or dismiss ' + (failed === 1 ? 'it' : 'them') + ' in the text.' }));
        if (warns.length) {
          dlg.body.appendChild(el('div', { className: 'bw-section' }, [el('div', { className: 'bw-section-title', text: 'Worth a look (' + warns.length + ')' }), el('div', { className: 'bw-hint', text: 'These do not block publishing.' }), itemList(warns, 'bw-check-warn', '!')]));
        }
        if (!req.length && !warns.length && !pending && !failed) dlg.body.appendChild(el('div', { className: 'bw-allgood', text: 'Everything is in place.' }));
        var blocked = req.length > 0 || pending > 0;
        var label = pending ? pending + (pending === 1 ? ' upload' : ' uploads') + ' in progress' : req.length ? 'Fix ' + req.length + ' required ' + (req.length === 1 ? 'item' : 'items') : verb;
        dlg.setButtons([
          { label: 'Cancel', kind: 'cancel', onClick: function (d) { d.close(); } },
          { id: 'go', label: label, kind: 'primary', disabled: blocked, onClick: confirmPublish },
        ]);
      }

      function confirmPublish() {
        dlg.buttons.go.disabled = true;
        dlg.buttons.go.textContent = verb + '…';
        ctx.flush().then(function () {
          return ctx.api.send('POST', 'posts/' + encodeURIComponent(ctx.getPost().id) + '/publish', { rev: ctx.keeper.rev() });
        }).then(function (res) {
          ctx.afterTransition(res);
          success(res);
        }, function (e) {
          if (e && e.status === 409) { dlg.close(); ctx.reloadPost(CHANGED); return; }
          if (e && e.status === 422 && e.code === 'slug') {
            var se = e.body && e.body.slugError;
            showError((se && se.message) || e.message);   // the server's words: an imported article on an old page needs a different answer than "change the address"
            ctx.panel().setSlugError((se && se.message) || e.message);
            return;
          }
          if (e && e.status === 422 && Array.isArray(e.body && e.body.required)) { showError('Fix the required items first: ' + e.body.required.map(function (r) { return r.message; }).join('; ')); return; }
          if (e && e.state) { showError('Could not save the article first, so nothing was published. Check the status at the top of the page.'); return; }
          showError((e && e.message) || 'Could not publish');
        });
      }

      function success(res) {
        if (timer) clearInterval(timer);
        ui.clear(dlg.body);
        dlg.setTitle(isUpdate ? 'Article updated' : 'Article published');
        var absolute = res.url || '';
        var items = [];
        // the address comes from the server; only an https address becomes a link
        items.push(el('p', {}, [/^https:\/\//.test(absolute) ? el('a', { href: absolute, target: '_blank', rel: 'noopener', className: 'bw-link', text: absolute }) : el('span', { className: 'bw-link', text: absolute })]));
        items.push(el('p', { text: CHECK_TEXT[res.check] || CHECK_TEXT.unreachable }));
        var notSwitched = (res.warnings || []).some(function (w) { return w && w.code === 'not_switched'; });
        if (notSwitched) items.push(el('p', { text: 'Published; the site will update within a minute.' }));
        items.push(el('p', { className: 'bw-facts', text: 'In blog list: ' + (res.inList ? 'yes' : 'no') }));
        items.push(el('p', { className: 'bw-facts', text: 'In sitemap: ' + (res.inSitemap ? 'yes' : 'no (noindex)') }));
        items.forEach(function (n) { dlg.body.appendChild(n); });
        dlg.setButtons([{ label: 'Close', kind: 'primary', onClick: function (d) { d.close(); } }]);
      }

      // The upload count can change while the dialog is open (an upload ends): keep the button honest.
      timer = setInterval(function () { if (dlg.buttons.go && !dlg.buttons.go.textContent.endsWith('…')) render(); }, 1000);
      var origClose = dlg.close;
      dlg.close = function () { clearInterval(timer); origClose(); };

      ctx.flush().then(function () { render(true); }, function (e) {
        var why = e && e.state === 'conflict' ? 'The article was changed by someone else. Resolve the conflict first.' : e && e.state === 'readonly' ? 'This tab is read-only.' : 'The latest text could not be saved yet (' + ((e && e.state) || 'error') + '). It is kept in this browser; try again when the status at the top says Saved.';
        showError(why);
      });
    }

    // ---- conflict and recovery ----------------------------------------------------------------------------------------

    function conflict(current) {
      current = current || {};
      var who = current.updatedBy ? ui.who(current.updatedBy) : 'someone';
      var when = current.updatedAt ? ui.fmtDateTime(current.updatedAt) : 'a moment ago';
      var dlg = ui.dialog({
        title: 'This article was changed elsewhere', closable: false, width: 520,
        body: [
          el('p', { text: who + ' saved a newer version at ' + when + '. Your latest changes are not saved yet; they are kept in this browser.' }),
          el('p', { className: 'bw-hint', text: 'Autosave is paused until you choose.' }),
        ],
        buttons: [
          { label: 'Download my text', kind: 'secondary', left: true, onClick: function () { download(ctx.getPayload()); } },
          { label: 'Reload their version', kind: 'secondary', onClick: function () {
            ui.confirm('Reload their version? Your unsaved text is discarded. Download it first if you want a copy.', { ok: 'Reload their version' }).then(function (yes) {
              if (!yes) return;
              ctx.api.get('posts/' + encodeURIComponent(ctx.getPost().id)).then(function (post) {
                dlg.close();
                ctx.applyServerPost(post, { reset: true, force: true });
              }, function (e) { ui.toast((e && e.message) || 'Could not load their version', 'error'); });
            });
          } },
          { label: 'Keep mine (overwrite)', kind: 'primary', onClick: function () {
            dlg.close();
            ctx.keeper.resolveConflict('mine', { rev: current.rev });
          } },
        ],
      });
      return dlg;
    }

    function recover(rec) {
      var dlg = ui.dialog({
        title: 'Unsaved text found', closable: false, width: 520,
        body: [
          el('p', { text: 'You have unsaved text from ' + ui.fmtDateTime(rec.at) + '.' }),
          rec.diverged ? el('p', { className: 'bw-msg bw-msg-bad', text: 'The article was saved by someone else after that. Restoring puts your text over their version; download it first if you want to compare.' }) : null,
        ],
        buttons: [
          { label: 'Download', kind: 'secondary', left: true, onClick: function () { download(rec.payload); } },
          { label: 'Discard', kind: 'secondary', onClick: function () { ctx.keeper.discardBackup(); dlg.close(); ctx.recoverDone(false); } },
          { label: 'Restore', kind: 'primary', onClick: function () { dlg.close(); ctx.recoverDone(true, rec.payload, !!rec.diverged); } },
        ],
      });
      return dlg;
    }

    return { link: link, video: video, table: table, button: button, emoji: emoji, history: history, schedule: schedule, publish: publish, conflict: conflict, recover: recover, download: download };
  }

  NS.createDialogs = createDialogs;
}(window));
