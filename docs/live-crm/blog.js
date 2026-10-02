/* Blog list page (spec section 9). Own transport (blog-api.js), not crm.js api(): a 401 must not throw the author out.
   The session token is the one crm.js token() reads: localStorage 'crm_token' (written by login.html, checked by auth.js). */
(function () {
  'use strict';
  if (typeof renderNav === 'function') renderNav('blog');

  var ui = window.BlogUi;
  var el = ui.el;
  var api = window.BlogApi.createBlogApi({
    base: '/blog-desk/',
    getToken: function () { try { return localStorage.getItem('crm_token') || ''; } catch (e) { return ''; } },
  });

  var posts = [];
  var tab = 'all';
  var query = '';
  var loaded = false;
  var busy = {};

  var TABS = [['all', 'All'], ['draft', 'Drafts'], ['scheduled', 'Scheduled'], ['published', 'Published']];

  var $tabs = document.getElementById('bl-tabs');
  var $list = document.getElementById('bl-list');
  var $banner = document.getElementById('bl-banner');
  var $search = document.getElementById('bl-search');
  var $new = document.getElementById('bl-new');
  var $help = document.getElementById('bl-help');
  if ($help) $help.addEventListener('click', function () { ui.help(); });   // the short note about this page, shared with the editor

  function showBanner(text, retry) {
    ui.clear($banner);
    if (!text) { $banner.hidden = true; return; }
    $banner.hidden = false;
    $banner.appendChild(document.createTextNode(text));
    if (retry) $banner.appendChild(el('button', { type: 'button', className: 'btn btn-secondary', text: 'Retry', on: { click: retry } }));
  }

  function errorText(e, fallback) {
    if (e && e.status === 0) return 'No connection to the blog service. Try again in a moment.';
    return (e && e.message) || fallback;
  }

  api.on('auth', function () {
    showBanner('Session expired — sign in in another tab, then press Retry', load);
  });

  // ---- data ---------------------------------------------------------------------------------------------------------

  function load() {
    return api.get('posts').then(function (res) {
      posts = (res && res.posts ? res.posts : []).slice().sort(function (a, b) { return String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')); });
      loaded = true;
      showBanner('');
      render();
    }, function (e) {
      if (e && e.status === 401) return;   // the auth banner is already up
      showBanner(errorText(e, 'Could not load the articles.'), load);
      if (!loaded) render();
    });
  }

  // ---- rendering ----------------------------------------------------------------------------------------------------

  function counts() {
    var c = { all: posts.length, draft: 0, scheduled: 0, published: 0 };
    posts.forEach(function (p) { if (c[p.status] !== undefined) c[p.status]++; });
    return c;
  }

  function matches(p) {
    if (tab !== 'all' && p.status !== tab) return false;
    var q = query.trim().toLowerCase();
    if (!q) return true;
    return String(p.title || '').toLowerCase().indexOf(q) >= 0 || String(p.slug || '').toLowerCase().indexOf(q) >= 0;
  }

  function renderTabs() {
    var c = counts();
    ui.clear($tabs);
    TABS.forEach(function (t) {
      var b = el('button', { type: 'button', role: 'tab', className: 'bl-tab', 'aria-selected': tab === t[0] ? 'true' : 'false', on: { click: function () { tab = t[0]; render(); } } },
        [t[1], el('small', { text: String(c[t[0]]) })]);
      $tabs.appendChild(b);
    });
  }

  function badge(text, cls) { return el('span', { className: 'bl-badge ' + cls, text: text }); }

  function statusBadges(p) {
    var out = [];
    if (p.status === 'published') out.push(badge('Published', 'bl-badge-published'));
    else if (p.status === 'scheduled') out.push(badge('Scheduled' + (p.scheduledAt ? ' · ' + ui.fmtDateTime(p.scheduledAt) : ''), 'bl-badge-scheduled'));
    else out.push(badge('Draft', 'bl-badge-draft'));
    if (p.status === 'published' && p.hasUnpublishedChanges) out.push(badge('Unpublished changes', 'bl-badge-warn'));
    if (p.status === 'published' && p.addressTaken) out.push(badge('Address taken by a site page', 'bl-badge-bad'));
    return out;
  }

  function actionBtn(label, onClick, cls, disabled) {
    return el('button', { type: 'button', className: 'bl-act' + (cls ? ' ' + cls : ''), text: label, disabled: disabled, on: { click: onClick } });
  }

  function row(p) {
    var href = 'blog-edit.html?id=' + encodeURIComponent(p.id);
    var title = String(p.title || '').trim();
    var actions = [
      el('a', { className: 'bl-act', href: href, text: 'Edit' }),
      actionBtn('Preview', function () { preview(p); }, '', !!busy[p.id]),
      actionBtn('Duplicate', function () { duplicate(p); }, '', !!busy[p.id]),
    ];
    if (p.status === 'published') actions.push(actionBtn('Unpublish', function () { unpublish(p); }, '', !!busy[p.id]));
    else actions.push(actionBtn('Delete', function () { remove(p); }, 'bl-act-danger', !!busy[p.id]));
    return el('div', { className: 'bl-row', role: 'listitem' }, [
      el('div', {}, [
        el('a', { className: 'bl-title' + (title ? '' : ' bl-untitled'), href: href, text: title || 'Untitled article' }),
        el('span', { className: 'bl-slug', text: p.slug ? '/blog/' + p.slug : 'No address yet' }),
      ]),
      el('div', { className: 'bl-cat', text: p.category || '—' }),
      el('div', { className: 'bl-status' }, statusBadges(p)),
      el('div', { className: 'bl-when', text: 'Updated ' + ui.relTime(p.updatedAt) + ' by ' + ui.who(p.updatedBy) }),
      el('div', { className: 'bl-actions' }, actions),
    ]);
  }

  function emptyState(text, withNew) {
    var box = el('div', { className: 'bl-empty' }, [el('p', { text: text })]);
    if (withNew) box.appendChild(el('button', { type: 'button', className: 'btn btn-primary', text: 'New article', on: { click: createNew } }));
    return box;
  }

  function render() {
    renderTabs();
    ui.clear($list);
    $list.setAttribute('role', 'list');
    if (!loaded) { $list.appendChild(el('div', { className: 'bl-empty' }, [el('p', { text: 'Loading…' })])); return; }
    if (!posts.length) {
      $list.appendChild(emptyState('No articles yet — write the first one, it stays a draft until you publish it.', true));
      return;
    }
    var shown = posts.filter(matches);
    if (!shown.length) {
      $list.appendChild(emptyState(query.trim() ? 'No article matches “' + query.trim() + '”.' : 'Nothing here yet.', false));
      return;
    }
    shown.forEach(function (p) { $list.appendChild(row(p)); });
  }

  // ---- actions ------------------------------------------------------------------------------------------------------

  function setBusy(id, on) { if (on) busy[id] = true; else delete busy[id]; render(); }

  function createNew() {
    $new.disabled = true;
    api.send('POST', 'posts', {}).then(function (post) {
      window.location.href = 'blog-edit.html?id=' + encodeURIComponent(post.id);
    }, function (e) {
      $new.disabled = false;
      ui.toast(errorText(e, 'Could not create the article.'), 'error');
    });
  }

  function duplicate(p) {
    setBusy(p.id, true);
    api.send('POST', 'posts', { duplicateOf: p.id }).then(function (post) {
      window.location.href = 'blog-edit.html?id=' + encodeURIComponent(post.id);
    }, function (e) {
      setBusy(p.id, false);
      ui.toast(errorText(e, 'Could not duplicate the article.'), 'error');
    });
  }

  function preview(p) {
    ui.openLater(function () {
      return api.get('posts/' + encodeURIComponent(p.id)).then(function (full) { return ui.previewUrl(full.previewToken); });
    }).catch(function (e) { ui.toast(errorText(e, 'Could not open the preview.'), 'error'); });
  }

  // The list rows carry no rev, so a destructive action first reads the article again: if it changed since the list was
  // drawn (someone saved in between) nothing is sent and the list is reloaded; otherwise the fresh rev goes with the request.
  function guarded(p, send) {
    setBusy(p.id, true);
    return api.get('posts/' + encodeURIComponent(p.id)).then(function (full) {
      if (full.updatedAt !== p.updatedAt) {
        ui.toast('The article changed — review it again', 'error');
        return load();
      }
      return send(full.rev).then(load);
    }).catch(function (e) {
      if (e && e.status === 409) { ui.toast('The article changed — review it again', 'error'); return load(); }
      if (e && e.status === 404) { ui.toast('This article no longer exists', 'error'); return load(); }
      ui.toast(errorText(e, 'Could not do that.'), 'error');
    }).then(function () { setBusy(p.id, false); });
  }

  function unpublish(p) {
    ui.confirm('Unpublish “' + (p.title || 'Untitled article') + '”? It leaves the site and becomes a draft; its address is freed.', { ok: 'Unpublish' }).then(function (yes) {
      if (!yes) return;
      guarded(p, function (rev) {
        return api.send('POST', 'posts/' + encodeURIComponent(p.id) + '/unpublish', { rev: rev }).then(function () { ui.toast('Unpublished'); });
      });
    });
  }

  function remove(p) {
    ui.confirm('Delete “' + (p.title || 'Untitled article') + '”? It moves to the trash and is kept for 30 days.', { ok: 'Delete' }).then(function (yes) {
      if (!yes) return;
      guarded(p, function (rev) {
        return api.send('DELETE', 'posts/' + encodeURIComponent(p.id), { rev: rev }).then(function () { ui.toast('Deleted'); });
      });
    });
  }

  $new.addEventListener('click', createNew);
  $search.addEventListener('input', function () { query = $search.value; render(); });
  // names stay current while the page is left open
  setInterval(function () { if (loaded && !document.hidden) render(); }, 60000);

  render();
  load();
}());
