/* Article editor page: starts everything, owns the post, the draft keeper wiring, the status bar and the publish flow.
   Parts live in blog-edit-panel.js (side tabs), blog-edit-toolbar.js (toolbar, "/" menu, selection bar) and
   blog-edit-dialogs.js (link, video, table, history, schedule, publish, conflict, recover); all share window.BlogEditPage.
   The session token is the one crm.js token() reads: localStorage 'crm_token' (written by login.html, checked by auth.js);
   crm.js does not export token(), so it is read the same way here. */
(function (root) {
  'use strict';

  // ---- pure helpers (also loaded by Node tests) ----------------------------------------------------------------------

  // Copy of slugify() in services/shop-blog/slug.cjs (the server's rule for addresses); test/crm-pages.test.cjs feeds both
  // the same titles and compares. Change one, change the other.
  function slugify(title) {
    if (typeof title !== 'string') return '';
    return title.normalize('NFKD').replace(/[̀-ͯ]/g, function () { return ''; }).toLowerCase()
      .replace(/['‘’`]/g, function () { return ''; })
      .replace(/[^a-z0-9]+/g, function () { return '-'; })
      .replace(/^-+|-+$/g, function () { return ''; })
      .slice(0, 80).replace(/-+$/g, function () { return ''; });
  }

  // Plain text of an article (title and body) for "Download my text".
  function linkHref(n) {
    var marks = n.marks || [];
    for (var i = 0; i < marks.length; i++) {
      if (marks[i] && marks[i].type === 'link' && marks[i].attrs && typeof marks[i].attrs.href === 'string' && marks[i].attrs.href) return marks[i].attrs.href;
    }
    return '';
  }
  // The author asks for this text when something went wrong: what a link or a picture points at is part of it.
  function inlineText(n) {
    if (!n) return '';
    if (n.type === 'text') { var href = linkHref(n); return href ? '[' + (n.text || '') + '](' + href + ')' : (n.text || ''); }
    if (n.type === 'hardBreak') return '\n';
    return (n.content || []).map(inlineText).join('');
  }
  function listText(n, ordered) {
    var start = ordered && n.attrs && n.attrs.start ? Number(n.attrs.start) : 1;
    return (n.content || []).map(function (li, i) {
      var parts = (li.content || []).map(function (c) { return blockText(c); }).filter(Boolean);
      return (ordered ? (start + i) + '. ' : '- ') + parts.join('\n').replace(/\n/g, '\n   ');
    }).join('\n');
  }
  function blockText(n) {
    if (!n) return '';
    var a = n.attrs || {};
    switch (n.type) {
      case 'heading': return new Array((a.level || 2) + 1).join('#') + ' ' + inlineText(n);
      case 'bulletList': return listText(n, false);
      case 'orderedList': return listText(n, true);
      case 'blockquote': case 'callout': return (n.content || []).map(blockText).filter(Boolean).join('\n').split('\n').map(function (l) { return '> ' + l; }).join('\n');
      case 'table': return (n.content || []).map(function (r) { return (r.content || []).map(function (c) { return (c.content || []).map(blockText).join(' ').replace(/\s+/g, ' ').trim(); }).join(' | '); }).join('\n');
      case 'figure': return '![' + (a.alt || '') + '](' + (a.src || '') + ')' + (a.caption ? ' ' + a.caption : '');
      case 'video': return '[Video](' + (a.src || '') + ')' + (a.caption ? ' ' + a.caption : '');
      case 'embed': return '[Video' + (a.title ? ': ' + a.title : '') + '] ' + (a.provider === 'vimeo' ? 'vimeo' : 'youtube') + ':' + (a.videoId || '');   // provider and id: no outside host may appear in the CRM scripts
      case 'faq': return (n.content || []).map(function (q) { return 'Q: ' + ((q.attrs && q.attrs.question) || '') + '\n' + (q.content || []).map(blockText).filter(Boolean).join('\n'); }).join('\n\n');
      case 'button': return '[Button: ' + (a.label || '') + (a.href ? ' -> ' + a.href : '') + ']';
      case 'horizontalRule': return '---';
      case 'toc': return '';
      default: return (n.content && n.content.some(function (c) { return c.type === 'text' || c.type === 'hardBreak'; })) ? inlineText(n) : (n.content || []).map(blockText).filter(Boolean).join('\n');
    }
  }
  function docToText(doc) {
    return ((doc && doc.content) || []).map(blockText).filter(function (t) { return t !== ''; }).join('\n\n');
  }
  function plainText(payload) {
    payload = payload || {};
    return (payload.title ? payload.title + '\n\n' : '') + docToText(payload.doc);
  }

  // What BlogEditor reports after loading a stored document (setDoc / create({doc}) -> {ok, changed}):
  // 'blocked' = not a document, an empty one was loaded (nothing may be saved); 'adjusted' = the engine dropped or corrected
  // something while loading (the author must look before saving); 'clean' = loaded as stored.
  function loadOutcome(result) {
    if (!result || typeof result !== 'object') return 'blocked';   // no report is not "loaded as stored": closed by default
    if (result.ok === false) return 'blocked';
    return result.changed ? 'adjusted' : 'clean';
  }

  var exported = { slugify: slugify, docToText: docToText, plainText: plainText, loadOutcome: loadOutcome };
  if (typeof module === 'object' && module.exports) module.exports = exported;
  if (!root || !root.document || !root.document.getElementById('bw-editor-wrap')) {
    if (root) { root.BlogEditPage = root.BlogEditPage || {}; Object.assign(root.BlogEditPage, exported); }
    return;
  }

  // ---- the page -------------------------------------------------------------------------------------------------------

  var NS = root.BlogEditPage = root.BlogEditPage || {};
  Object.assign(NS, exported);
  if (typeof root.renderNav === 'function') root.renderNav('blog');

  var ui = root.BlogUi;
  var el = ui.el;
  var $ = function (id) { return document.getElementById(id); };

  var api = root.BlogApi.createBlogApi({
    base: '/blog-desk/',
    getToken: function () { try { return localStorage.getItem('crm_token') || ''; } catch (e) { return ''; } },
  });

  var id = new URLSearchParams(root.location.search).get('id') || '';
  var post = null;            // server meta of the article: id, status, live, scheduledAt, previewToken, hasUnpublishedChanges
  var editor = null;
  var panel = null;
  var toolbar = null;
  var slash = null;
  var bubble = null;
  var dialogs = null;
  var keeper = null;
  var categories = [];
  var locked = false;         // the stored text could not be opened: nothing may be saved over it
  var readOnly = false;
  var diverged = false;       // saved edits not yet published (published article)
  var conflictDialog = null;
  var recoverDialog = null;
  var authBanner = null;

  var $title = $('bw-title');
  var $publish = $('bw-publish');
  var $publishMore = $('bw-publish-more');
  var $preview = $('bw-preview');
  var $more = $('bw-more');

  // ---- banners ----------------------------------------------------------------------------------------------------------

  var banners = {};
  function banner(key, text, kind) {
    var host = $('bw-banners');
    if (banners[key]) { if (banners[key].parentNode) banners[key].parentNode.removeChild(banners[key]); delete banners[key]; }
    if (!text) return;
    var node = el('div', { className: 'bw-banner bw-banner-' + (kind || 'warn'), text: text });
    banners[key] = node;
    host.appendChild(node);
  }

  // ---- payload ------------------------------------------------------------------------------------------------------------

  function getPayload() {
    var p = panel.getFields();
    p.title = $title.value.trim();
    p.doc = editor.getDoc();
    return {
      title: p.title, slug: p.slug, seoTitle: p.seoTitle, description: p.description, category: p.category, cover: p.cover,
      focusKeyword: p.focusKeyword, secondaryKeywords: p.secondaryKeywords, author: p.author, noindex: p.noindex, doc: p.doc,
    };
  }
  function changed() {
    if (locked || readOnly || quiet || !keeper) return;
    keeper.change(getPayload());
  }

  // ---- status chips -------------------------------------------------------------------------------------------------------

  function renderChips() {
    var st = keeper ? keeper.state() : 'saved';
    var chip = $('bw-chip-draft');
    var text;
    var kind = 'ok';
    var err = keeper && keeper.lastError();
    if (st === 'saved') text = 'Saved' + ((keeper.savedAt() || (post && post.updatedAt)) ? ' ' + ui.fmtTime(keeper.savedAt() || post.updatedAt) : '');
    else if (st === 'dirty') { text = 'Unsaved changes'; kind = 'neutral'; }
    else if (st === 'saving') { text = 'Saving…'; kind = 'neutral'; }
    else if (st === 'offline') {
      kind = 'bad';
      if (err && err.status === 401) text = 'Session expired — changes kept in this browser';
      else if (err && err.status >= 400 && err.status < 500) text = 'Not saved — ' + (err.message || 'the server refused the text') + '. Changes kept in this browser';
      else text = 'Offline — changes kept in this browser';
    } else if (st === 'conflict') { text = 'Conflict — choose how to continue'; kind = 'bad'; }
    else if (st === 'readonly') { text = 'Read-only — open in another tab'; kind = 'warn'; }
    else text = st;
    if (locked) { text = 'Not opened — nothing will be saved'; kind = 'bad'; }
    chip.textContent = text;
    chip.className = 'bw-chip bw-chip-draft bw-chip-' + kind;

    var site = $('bw-chip-site');
    ui.clear(site);
    if (post) {
      if (post.status === 'published' && post.live) {
        site.className = 'bw-chip bw-chip-site bw-chip-ok';
        site.appendChild(document.createTextNode('Live: '));
        site.appendChild(el('a', { href: ui.SITE_ORIGIN + '/blog/' + post.live.slug, target: '_blank', rel: 'noopener', text: 'version of ' + ui.fmtDateTime(post.live.updatedAt || post.live.publishedAt) }));
      } else if (post.status === 'scheduled') {
        site.className = 'bw-chip bw-chip-site bw-chip-info';
        site.textContent = 'Scheduled for ' + ui.fmtDateTime(post.scheduledAt);
      } else {
        site.className = 'bw-chip bw-chip-site bw-chip-neutral';
        site.textContent = 'Not published';
      }
    }
    var diff = $('bw-chip-diff');
    var showDiff = !!post && post.status === 'published' && (post.hasUnpublishedChanges || diverged);
    diff.hidden = !showDiff;
    diff.textContent = showDiff ? 'Unpublished changes' : '';
    diff.className = 'bw-chip bw-chip-diff bw-chip-warn';
  }

  function renderActions() {
    if (!post) return;
    var published = post.status === 'published';
    var scheduled = post.status === 'scheduled';
    $publish.textContent = published ? 'Update' : scheduled ? 'Publish now' : 'Publish';
    $publishMore.hidden = published;
    $publish.classList.toggle('bw-no-split', published);
    var off = readOnly || locked;
    [$publish, $publishMore, $preview].forEach(function (b) { b.disabled = off; });
    document.title = (($title.value || '').trim() || 'Untitled article') + ' — BioLabs Research';
  }

  function syncToolbar() { if (toolbar && editor) toolbar.update(editor.state()); }

  // TipTap's setEditable() emits an "update" event, which the page would take for a typed change: it would overwrite the
  // local backup with the server text right when the recovery dialog is about to offer that very backup. So every
  // setEditable goes through here and the change handler ignores the event.
  var quiet = false;
  function setEditableQuiet(on) {
    quiet = true;
    try { editor.setEditable(on); } finally { quiet = false; }
    syncToolbar();
  }

  function setReadOnly(on, reason) {
    readOnly = !!on;
    if (editor) setEditableQuiet(!on && !locked);
    $title.disabled = !!on || locked;
    if (panel) panel.setEditable(!on && !locked);
    banner('readonly', on ? (reason || 'This article is open in another tab of this browser, so this tab is read-only. Close the other tab and reload this page to edit here.') : '', 'warn');
    renderActions();
    renderChips();
  }

  // ---- keeper events ------------------------------------------------------------------------------------------------------

  function wireKeeper() {
    keeper.onState(function (s) {
      renderChips();
      if (s === 'saved') { banner('auth', ''); banner('server', ''); }
      if (s === 'readonly' && keeper.readOnlyReason() === 'open_in_another_tab') {
        setReadOnly(true);
        // The other tab answered late, while the "Unsaved text found" dialog was open: the copy is that tab's, not ours.
        if (recoverDialog) { var d = recoverDialog; recoverDialog = null; d.close(); }
      }
    });
    keeper.on('auth', function () { banner('auth', 'Session expired — sign in in another tab, your text is kept', 'bad'); });
    api.on('auth', function () { banner('auth', 'Session expired — sign in in another tab, your text is kept', 'bad'); });
    keeper.on('backup_off', function () { banner('backup', 'Autosave backup is off in this browser', 'warn'); });
    keeper.on('conflict', function (current) {
      if (conflictDialog) return;
      conflictDialog = dialogs.conflict(current);
      var orig = conflictDialog.close;
      conflictDialog.close = function () { conflictDialog = null; orig(); };
    });
  }

  // ---- loading and applying -----------------------------------------------------------------------------------------------

  function setMeta(p) {
    post = {
      id: p.id, status: p.status, live: p.live || null, scheduledAt: p.scheduledAt || null, previewToken: p.previewToken || (post && post.previewToken) || '',
      hasUnpublishedChanges: !!p.hasUnpublishedChanges, updatedAt: p.updatedAt, updatedBy: p.updatedBy,
    };
    diverged = false;
  }

  function growTitle() {
    $title.style.height = 'auto';
    $title.style.height = $title.scrollHeight + 'px';
  }

  function setDocSafely(doc) {
    try { return loadOutcome(editor.setDoc(doc)); } catch (e) {
      console.error('[blog] the stored text could not be opened: ' + e.message);
      return 'blocked';
    }
  }

  // "Some parts were adjusted" strip at the top of the writing area; "could not be opened" is a blocking dialog.
  var adjustedBox = null;
  function adjustedBanner(show) {
    if (adjustedBox && adjustedBox.parentNode) adjustedBox.parentNode.removeChild(adjustedBox);
    adjustedBox = null;
    if (!show) return;
    adjustedBox = el('div', { className: 'bw-adjusted', role: 'status' }, [
      el('span', { text: 'Some parts of this article were adjusted while opening (unsupported formatting was removed). Review the text before saving.' }),
      el('button', { type: 'button', className: 'btn btn-secondary bw-small', text: 'Dismiss', on: { click: function () { adjustedBanner(false); } } }),
    ]);
    var wrap = $('bw-editor-wrap');
    wrap.insertBefore(adjustedBox, wrap.firstChild);
  }
  var blockedDialog = null;
  function blockedNotice() {
    lock();
    adjustedBanner(false);
    if (blockedDialog) return;
    blockedDialog = ui.dialog({
      title: 'This article could not be opened', closable: false, width: 480,
      body: [el('p', { text: 'This article could not be opened correctly. Nothing was changed. Reload the page; if it happens again, tell the site team.' })],
      buttons: [{ label: 'Reload', kind: 'primary', onClick: reload }],
    });
  }
  // Notices for what the editor reported while loading; returns the outcome.
  function noteOutcome(outcome) {
    if (outcome === 'blocked') blockedNotice(); else adjustedBanner(outcome === 'adjusted');
    return outcome;
  }

  // Puts a draft (server version or a recovered copy) into the title, the panel and the editor. -> 'clean'|'adjusted'|'blocked'
  function applyDraft(d) {
    $title.value = d.title || '';
    growTitle();
    panel.setFields(d);
    var outcome = noteOutcome(setDocSafely(d.doc));
    renderActions();
    return outcome;
  }

  function applyChecks(res) {
    if (!res) return;
    panel.setChecks(res.checks, res.slugError);
  }

  // After the server replaced the draft under us (restore, "their version"): everything in the page follows the server.
  // opts.force: the author chose to drop the unsaved text ("Reload their version"). Otherwise a keeper that is not "saved"
  // holds text the server does not have, and replacing the editor would erase it (and its backup): the page keeps it,
  // says so, and the next save shows the conflict choice if the server's version really differs.
  function applyServerPost(p, opts) {
    if (!(opts && opts.force) && keeper && keeper.state() !== 'saved') {
      banner('server', 'The article was changed on the server while you were typing. Your latest edits are kept here and will be saved next; if they clash you will be asked how to continue.', 'warn');
      return 'kept';
    }
    setMeta(p);
    var outcome = applyDraft(p.draft);
    if (outcome === 'blocked') return outcome;   // locked: no reset, no save; a reload shows the server's own text again
    applyChecks(p);
    if (opts && opts.reset) keeper.reset(p.rev, getPayload());
    renderActions();
    renderChips();
    return outcome;
  }

  function lock() {
    locked = true;
    if (editor) setEditableQuiet(false);
    $title.disabled = true;
    if (panel) panel.setEditable(false);
    renderActions();
    renderChips();
  }

  function afterTransition(res) {
    if (res && Number.isInteger(res.rev)) keeper.adoptRev(res.rev);
    return api.get('posts/' + encodeURIComponent(id)).then(function (p) {
      var live = p.live; var status = p.status;
      post.status = status; post.live = live || null; post.scheduledAt = p.scheduledAt || null; post.previewToken = p.previewToken || post.previewToken;
      post.hasUnpublishedChanges = !!p.hasUnpublishedChanges;
      if (status === 'published' && res && res.url) diverged = false;
      renderActions();
      renderChips();
    }, function () { /* the chips stay as they were; the next reload corrects them */ });
  }

  function reload() { root.location.reload(); }

  // Someone else changed the article (409): take the server's version in place, so the explanation toast is not lost to a
  // page reload. The caller flushed first, so what the server holds already contains this author's last saved text.
  function reloadPost(message) {
    return api.get('posts/' + encodeURIComponent(id)).then(function (p) {
      applyServerPost(p, { reset: true });
      if (message) ui.toast(message, 'error', 6000);
    }, function (e) { ui.toast(message || (e && e.message) || 'Could not reload the article', 'error'); });
  }

  function flush() { return keeper.flush(); }

  function save(payload, baseRev, opts) {
    // opts.snapshotBefore: "Keep mine" overwrote someone else's text; the server keeps the replaced text as a version first.
    var body = Object.assign({ rev: baseRev }, payload);
    if (opts && opts.snapshotBefore === true) body.snapshotBefore = true;
    return api.send('PUT', 'posts/' + encodeURIComponent(id), body).then(function (res) {
      // The text is on the server. A failure of the page's own bookkeeping must not look like a failed save: the keeper
      // would retry with the old rev and show a false conflict.
      try {
        applyChecks(res);
        if (post && post.status === 'published') diverged = true;
        if (post) post.updatedAt = res.updatedAt;
        renderChips();
      } catch (e) { console.error('[blog] after-save update failed: ' + e.message); }
      return res;
    });
  }

  // ---- uploads --------------------------------------------------------------------------------------------------------------

  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { cleanup(); resolve(); }, ms);
      function onAbort() { clearTimeout(t); cleanup(); var e = new Error('Upload cancelled'); e.name = 'AbortError'; reject(e); }
      function cleanup() { if (signal) signal.removeEventListener('abort', onAbort); }
      if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort); }
    });
  }

  function onUpload(file, o) {
    return api.upload('media/image', file, { onProgress: o.onProgress, signal: o.signal }).catch(function (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new Error(ui.uploadError(e, 'image'));
    });
  }

  // POST the file (progress), then poll the job every 2 s until it is ready or failed.
  function onVideoUpload(file, o) {
    return api.upload('media/video', file, { onProgress: function (p) { o.onProgress(p * 0.9); }, signal: o.signal }).then(function (job) {
      var jobId = job && job.jobId;
      if (!jobId) throw new Error('The server did not start the video job');
      o.onProgress(0.9, 'Processing video…');
      var misses = 0;
      var started = Date.now();
      function poll() {
        return sleep(2000, o.signal).then(function () {
          return api.get('media/jobs/' + encodeURIComponent(jobId));
        }).then(function (j) {
          misses = 0;
          if (j.state === 'ready') return { src: j.src, poster: j.poster, w: j.w, h: j.h };
          if (j.state === 'failed') throw new Error(j.error || 'The video could not be processed');
          if (Date.now() - started > 20 * 60 * 1000) throw new Error('The video is taking too long to process');
          return poll();
        }, function (e) {
          if (e && e.name === 'AbortError') throw e;
          if (e && e.status === 0 && ++misses < 5) return poll();   // a short network gap while polling is not a failure
          throw e;
        });
      }
      return poll();
    }).catch(function (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e && typeof e.status === 'number') throw new Error(ui.uploadError(e, 'video'));
      throw e;
    });
  }

  function pickImage() {
    var input = el('input', { type: 'file', accept: 'image/*', multiple: true, hidden: true });
    input.addEventListener('change', function () {
      Array.prototype.forEach.call(input.files || [], function (f) { editor.commands.uploadImage(f); });
      if (input.parentNode) input.parentNode.removeChild(input);
    });
    input.addEventListener('cancel', function () { if (input.parentNode) input.parentNode.removeChild(input); });
    document.body.appendChild(input);
    input.click();
  }

  function onUploadsChange(n) {
    var foot = $('bw-foot');
    foot.textContent = n ? n + (n === 1 ? ' upload' : ' uploads') + ' in progress' : '';
    $publish.title = n ? n + (n === 1 ? ' upload' : ' uploads') + ' in progress' : '';
  }

  // ---- top bar actions ---------------------------------------------------------------------------------------------------------

  function copyText(text) {
    if (root.navigator.clipboard && root.navigator.clipboard.writeText) return root.navigator.clipboard.writeText(text);
    return Promise.reject(new Error('no clipboard'));
  }

  function previewNow() {
    ui.openLater(function () {
      return flush().then(function () { return ui.previewUrl(post.previewToken); });
    }).catch(function (e) {
      ui.toast(e && e.state ? 'Could not save the latest text, so the preview would be out of date' : ((e && e.message) || 'Could not open the preview'), 'error');
    });
  }

  function unpublish() {
    ui.confirm('Unpublish this article? It leaves the site and becomes a draft; its address is freed.', { ok: 'Unpublish' }).then(function (yes) {
      if (!yes) return;
      flush().then(function () { return api.send('POST', 'posts/' + encodeURIComponent(id) + '/unpublish', { rev: keeper.rev() }); }).then(function (res) {
        ui.toast('Unpublished');
        return afterTransition(res);
      }).catch(failure);
    });
  }
  function unschedule() {
    flush().then(function () { return api.send('POST', 'posts/' + encodeURIComponent(id) + '/unschedule', { rev: keeper.rev() }); }).then(function (res) {
      ui.toast('Schedule removed');
      return afterTransition(res);
    }).catch(failure);
  }
  function remove() {
    ui.confirm('Delete this article? It moves to the trash and is kept for 30 days.', { ok: 'Delete' }).then(function (yes) {
      if (!yes) return;
      flush().then(function () { return api.send('DELETE', 'posts/' + encodeURIComponent(id), { rev: keeper.rev() }); }).then(function () {
        keeper.discardBackup();
        root.location.href = 'blog.html';
      }).catch(failure);
    });
  }
  function duplicate() {
    flush().then(function () { return api.send('POST', 'posts', { duplicateOf: id }); }).then(function (p) {
      root.location.href = 'blog-edit.html?id=' + encodeURIComponent(p.id);
    }).catch(failure);
  }
  function resetPreviewLink() {
    ui.confirm('Reset the preview link? The old link stops working.', { ok: 'Reset link' }).then(function (yes) {
      if (!yes) return;
      api.send('POST', 'posts/' + encodeURIComponent(id) + '/preview-token', {}).then(function (r) {
        post.previewToken = r.previewToken;
        ui.toast('Preview link reset');
      }, failure);
    });
  }
  function failure(e) {
    if (e && e.status === 409) { reloadPost('The article changed \u2014 review it again'); return; }
    if (e && e.state) { ui.toast('Could not save the article first — check the status at the top of the page', 'error', 5000); return; }
    ui.toast((e && e.message) || 'Something went wrong', 'error');
  }

  function wireBar() {
    $preview.addEventListener('click', previewNow);
    $publish.addEventListener('click', function () { dialogs.publish(); });
    $publishMore.addEventListener('click', function () {
      var items = [];
      if (post.status === 'scheduled') {
        items.push({ label: 'Change schedule…', onClick: dialogs.schedule });
        items.push({ label: 'Unschedule', onClick: unschedule });
      } else if (post.status === 'draft') items.push({ label: 'Schedule…', onClick: dialogs.schedule });
      if (items.length) ui.menu($publishMore, items, { align: 'right' });
    });
    $more.addEventListener('click', function () {
      var published = post.status === 'published';
      ui.menu($more, [
        { label: 'History', onClick: dialogs.history },
        { label: 'Duplicate', onClick: duplicate },
        { label: 'Copy preview link', onClick: function () { copyText(ui.previewUrl(post.previewToken)).then(function () { ui.toast('Preview link copied'); }, function () { ui.toast('Could not copy the link', 'error'); }); } },
        { label: 'Reset preview link', onClick: resetPreviewLink },
        { separator: true },
        { label: 'Unpublish', onClick: unpublish, disabled: !published },
        { label: 'Delete', onClick: remove, disabled: published, danger: true, hint: published ? 'Unpublish first' : '' },
      ], { align: 'right' });
    });
    function setSide(open) {
      document.body.classList.toggle('bw-side-open', open);
      $('bw-settings-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
    }
    $('bw-settings-toggle').addEventListener('click', function () { setSide(!document.body.classList.contains('bw-side-open')); });
    $('bw-side-close').addEventListener('click', function () { setSide(false); $('bw-settings-toggle').focus(); });
  }

  // ---- shortcuts and leaving -----------------------------------------------------------------------------------------------------

  function wireKeys() {
    document.addEventListener('keydown', function (e) {
      var mod = e.metaKey || e.ctrlKey;
      if (!mod || e.altKey) return;
      var k = e.key.toLowerCase();
      if (k === 's' && !e.shiftKey) {
        e.preventDefault();
        if (readOnly || locked) return;
        flush().then(function () { ui.toast('Saved'); }, function (err) { ui.toast(err && err.state === 'conflict' ? 'Resolve the conflict first' : 'Could not save — your text is kept in this browser', 'error'); });
      } else if (k === 'k' && !e.shiftKey && $('bw-editor').contains(document.activeElement) && editor.state().editable) {
        e.preventDefault();
        dialogs.link();
      }
    });
    root.addEventListener('beforeunload', function (e) {
      if (!keeper || locked) return;
      var s = keeper.state();
      var uploading = !!editor && editor.pendingUploads() > 0;   // an image or video still going up is lost on leaving
      if ((s === 'saved' || s === 'readonly') && !uploading) return;
      e.preventDefault();
      e.returnValue = '';
    });
    // Leaving through the CRM menu while the text is only in this browser is the same risk: flush at once on hide.
    document.addEventListener('visibilitychange', function () { if (document.hidden && keeper && !readOnly && !locked) keeper.flush().catch(function () {}); });
  }

  // ---- start ----------------------------------------------------------------------------------------------------------------------

  function showFatal(text, retry) {
    $('bw-loading').hidden = false;
    var box = $('bw-loading');
    ui.clear(box);
    box.appendChild(el('p', { text: text }));
    box.appendChild(el('a', { className: 'btn btn-secondary', href: 'blog.html', text: 'Back to the article list' }));
    if (retry) box.appendChild(el('button', { type: 'button', className: 'btn btn-primary', text: 'Try again', on: { click: retry } }));
  }

  function start(loaded, cats) {
    categories = cats;
    var p = loaded;
    setMeta(p);

    var ctx = {
      ui: ui, api: api, slugify: slugify, plainText: plainText, categories: categories, pickImage: pickImage,
      getEditor: function () { return editor; }, getPost: function () { return post; }, getPayload: getPayload,
      getTitle: function () { return $title.value; }, getDoc: function () { return editor ? editor.getDoc() : null; },
      focusTitle: function () { $title.focus(); },
      isPublished: function () { return !!post && post.status === 'published'; },
      liveSlug: function () { return post && post.live ? post.live.slug : ''; },
      changed: function () { changed(); renderActions(); },
      panel: function () { return panel; },
      keeper: null, flush: flush, afterTransition: afterTransition, applyServerPost: applyServerPost, reloadPost: reloadPost,
      recoverDone: null, dialogs: null,
    };

    panel = NS.createPanel(ctx);

    keeper = root.BlogDraftKeeper.createKeeper({
      storage: (function () { try { return root.localStorage; } catch (e) { return null; } }()),
      channel: typeof root.BroadcastChannel === 'function' ? new root.BroadcastChannel('blog-edit') : null,
      tabId: 't' + Math.random().toString(36).slice(2) + Date.now().toString(36),
      save: save,
    });
    ctx.keeper = keeper;
    dialogs = NS.createDialogs(ctx);
    ctx.dialogs = dialogs;
    ctx.recoverDone = function (restore, payload, diverged) {
      recoverDialog = null;
      // Still (or newly) read-only because of another tab: that tab owns the copy, so nothing is restored here and the
      // editor stays locked; the keeper would ignore every edit anyway.
      var other = keeper.readOnlyReason() === 'open_in_another_tab';
      setReadOnly(other);
      if (other) return;
      if (restore && payload) {
        // a copy that cannot be opened stays in the browser backup (nothing is written over it)
        if (applyDraft(payload) !== 'blocked') {
          // The copy is older than the server's text: putting it back replaces what someone else saved, so keep that as a version.
          if (diverged) keeper.armSnapshot();
          keeper.change(getPayload());
        }
      }
      editor.focus();
    };
    wireKeeper();

    $('bw-loading').hidden = true;
    $('bw-editor-wrap').hidden = false;

    var outcome = 'clean';
    try {
      editor = root.BlogEditor.create({
        element: $('bw-editor'), doc: p.draft.doc, editable: true, placeholder: 'Start writing, or type / for blocks',
        mediaBase: '', onChange: function () { changed(); }, onUpload: onUpload, onVideoUpload: onVideoUpload,
        onLookup: function (q) { return api.get('lookup?q=' + encodeURIComponent(q || '')); }, onUploadsChange: onUploadsChange,
      });
      outcome = loadOutcome(editor.loadResult);
    } catch (e) {
      console.error('[blog] the editor could not open the stored text: ' + e.message);
      outcome = 'blocked';
      editor = root.BlogEditor.create({ element: $('bw-editor'), editable: false, placeholder: '' });
    }

    toolbar = NS.createToolbar(ctx, $('bw-toolbar'));
    slash = NS.createSlash(ctx, $('bw-editor'));
    bubble = NS.createBubble(ctx, $('bw-editor'));
    editor.onSelection(function (s) { toolbar.update(s); slash.refresh(); bubble.refresh(); });
    toolbar.update(editor.state());

    $title.value = p.draft.title || '';
    growTitle();
    panel.setFields(p.draft);
    applyChecks(p);
    renderActions();

    $title.addEventListener('input', function () { growTitle(); panel.refreshPreviews(); changed(); renderActions(); });
    $title.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); editor.focus(); } });
    document.addEventListener('keyup', function (e) { if (e.key === 'Escape') bubble.hide(); });

    wireBar();
    wireKeys();

    var rec = keeper.open(id, p.rev, { blocked: outcome === 'blocked' });
    renderChips();
    if (noteOutcome(outcome) === 'blocked') return;
    if (rec.recoverable) {
      // The other tab's reply arrives within a few ms: wait for it, so a second tab never offers (or discards) the copy.
      setEditableQuiet(false);
      $title.disabled = true;
      setTimeout(function () {
        if (keeper.readOnlyReason() === 'open_in_another_tab') { setReadOnly(true); return; }
        $title.disabled = false;
        setEditableQuiet(true);
        recoverDialog = dialogs.recover(rec.recoverable);
      }, 300);
    } else if (keeper.readOnlyReason() === 'open_in_another_tab') setReadOnly(true);
  }

  function boot() {
    if (!id) { showFatal('No article selected.'); return; }
    Promise.all([api.get('posts/' + encodeURIComponent(id)), api.get('categories')]).then(function (r) {
      start(r[0], (r[1] && r[1].categories) || []);
    }, function (e) {
      if (e && e.status === 404) { showFatal('This article does not exist (it may have been deleted).'); return; }
      if (e && e.status === 401) { showFatal('Session expired — sign in in another tab, then try again.', boot); return; }
      showFatal((e && e.status === 0) ? 'No connection to the blog service.' : ((e && e.message) || 'Could not open the article.'), boot);
    });
  }

  // ---- full-screen working mode -------------------------------------------------------------------------------------------------
  // A class on <body> (CSS in blog-edit.css hides the CRM menu and header): a mode inside the window, not the browser's Fullscreen API.
  // Remembered per browser in localStorage; the class lives on this page only, so every other CRM page keeps its menu.

  var FOCUS_KEY = 'bw_focus_mode';
  function readFocus() { try { return root.localStorage.getItem(FOCUS_KEY) === '1'; } catch (e) { return false; } }
  function saveFocus(on) { try { if (on) root.localStorage.setItem(FOCUS_KEY, '1'); else root.localStorage.removeItem(FOCUS_KEY); } catch (e) { /* storage blocked: the mode just is not remembered */ } }

  // Something that has its own meaning for Escape is open: a dialog (ours or the CRM's), a menu or popover, a list, the selection bar.
  // They close themselves on Escape (and stop it); this check also covers what closes on key-up (the selection bar).
  function escapeBelongsToSomethingElse() {
    return !!document.querySelector('.modal-overlay, .bw-pop, .bw-sel-list, .bw-bubble:not([hidden])');
  }

  function wireFocus() {
    var btn = $('bw-focus');
    if (!btn) return;
    function set(on, remember) {
      document.body.classList.toggle('bw-focus', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      var label = on ? 'Exit full screen' : 'Full screen';
      btn.setAttribute('aria-label', label);
      btn.title = label;
      if (remember) saveFocus(on);
    }
    set(readFocus(), false);
    btn.addEventListener('click', function () { set(!document.body.classList.contains('bw-focus'), true); });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || e.isComposing) return;   // not defaultPrevented: the editor's own keymap prevents the default of Escape too
      if (!document.body.classList.contains('bw-focus') || escapeBelongsToSomethingElse()) return;
      e.preventDefault();
      set(false, true);
    });
  }
  wireFocus();

  // The short note about this page, the same one the article list opens.
  (function () { var b = $('bw-help'); if (b) b.addEventListener('click', function () { ui.help(); }); }());

  boot();
}(typeof window !== 'undefined' ? window : null));
