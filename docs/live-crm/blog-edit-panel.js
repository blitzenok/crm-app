/* Right-hand panel of the article editor: Post, SEO and Checklist tabs (spec section 9).
   Shared namespace window.BlogEditPage; the page core (blog-edit.js) calls createPanel(ctx) once.
   ctx: { ui, api, slugify(title), getTitle(), changed(), getEditor(), getDoc(), isPublished(), liveSlug() }.
   Every field edit calls ctx.changed(): the core collects the whole payload and hands it to the draft keeper. */
(function (root) {
  'use strict';
  var NS = root.BlogEditPage = root.BlogEditPage || {};

  var SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
  var DEFAULT_SUFFIX = ' | BIO LABS Research';
  var SITE_HOST = 'biolabsresearch.co';

  // Counter colours (brief): SEO title <= 60 green, 61-70 yellow, > 70 red; description 120-160 green, else yellow, > 200 red.
  function titleLevel(n) { return n > 70 ? 'bad' : n > 60 ? 'warn' : 'ok'; }
  function descLevel(n) { return n > 200 ? 'bad' : (n >= 120 && n <= 160) ? 'ok' : 'warn'; }

  function createPanel(ctx) {
    var ui = ctx.ui;
    var el = ui.el;
    var panes = { post: document.getElementById('bw-pane-post'), seo: document.getElementById('bw-pane-seo'), check: document.getElementById('bw-pane-check') };
    var tabButtons = Array.prototype.slice.call(document.querySelectorAll('.bw-tab'));
    var badge = document.getElementById('bw-check-badge');

    // card (600x600) and share (1200x630) are the frames the upload made for src; they travel with it and go with it
    var cover = { src: '', alt: '', card: '', share: '' };
    var secondary = [];
    var checks = { required: [], warnings: [], seo: [] };
    var slugServerError = '';
    var lastRisk = '';
    var editable = true;
    var f = {};   // the inputs

    function field(label, control, hint, id) {
      var kids = [el('label', { className: 'bw-label', id: id ? id + '-label' : undefined, text: label, for: id }), control];
      if (hint) kids.push(el('div', { className: 'bw-hint', text: hint }));
      return el('div', { className: 'bw-field' }, kids);
    }
    function changed() { updatePreviews(); ctx.changed(); }

    // ---- Post tab ---------------------------------------------------------------------------------------------------

    f.slug = el('input', { id: 'bw-slug', className: 'bw-input', type: 'text', maxlength: '80', autocomplete: 'off', spellcheck: 'false', 'aria-describedby': 'bw-slug-msg' });
    f.slugMsg = el('div', { id: 'bw-slug-msg', className: 'bw-msg', role: 'status', 'aria-live': 'polite' });
    f.slugFromTitle = el('button', { type: 'button', className: 'btn btn-secondary bw-small', text: 'From title', title: 'Make the address from the title' });
    f.redirectNote = el('div', { className: 'bw-note', hidden: true, text: 'Old address will redirect to the new one' });
    f.slug.addEventListener('input', function () { slugServerError = ''; renderSlugMessage(); changed(); });
    f.slugFromTitle.addEventListener('click', function () {
      f.slug.value = ctx.slugify(ctx.getTitle());
      slugServerError = '';
      renderSlugMessage();
      changed();
      f.slug.focus();
    });

    f.category = ui.select({ id: 'bw-category', labelledBy: 'bw-category-label', onChange: onCategoryChange });
    f.newCategoryRow = el('div', { className: 'bw-row', hidden: true });
    f.newCategory = el('input', { type: 'text', className: 'bw-input', maxlength: '24', placeholder: 'New category name', 'aria-label': 'New category name', autocomplete: 'off' });
    f.newCategoryAdd = el('button', { type: 'button', className: 'btn btn-primary bw-small', text: 'Add' });
    f.newCategoryCancel = el('button', { type: 'button', className: 'btn btn-secondary bw-small', text: 'Cancel' });
    f.categoryMsg = el('div', { className: 'bw-msg bw-msg-bad', role: 'alert' });
    f.newCategoryRow.append(f.newCategory, f.newCategoryAdd, f.newCategoryCancel);
    var NEW_CATEGORY = '\u0000new';
    var categoryBefore = '';
    function onCategoryChange(v) {
      if (v === NEW_CATEGORY) {
        f.newCategoryRow.hidden = false;
        f.newCategory.focus();
      } else { categoryBefore = v; hideNewCategory(); changed(); }
    }
    function hideNewCategory() { f.newCategoryRow.hidden = true; f.newCategory.value = ''; f.categoryMsg.textContent = ''; }
    f.newCategoryCancel.addEventListener('click', function () { hideNewCategory(); f.category.setValue(categoryBefore); });
    function addCategory() {
      var name = f.newCategory.value.trim();
      f.categoryMsg.textContent = '';
      f.newCategoryAdd.disabled = true;
      ctx.api.send('POST', 'categories', { name: name }).then(function (res) {
        setCategories(res.categories, name);
        categoryBefore = name;
        hideNewCategory();
        changed();
      }, function (e) {
        f.categoryMsg.textContent = (e && e.message) || 'Could not add the category';
      }).then(function () { f.newCategoryAdd.disabled = false; });
    }
    f.newCategoryAdd.addEventListener('click', addCategory);
    f.newCategory.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });

    function setCategories(list, select) {
      var cur = select !== undefined ? select : f.category.value();
      var opts = [{ value: '', label: 'Choose a category…', muted: true }];
      (list || []).forEach(function (c) { opts.push({ value: c, label: c }); });
      // a draft may carry a category that is no longer in the list: keep it visible rather than silently dropping it
      if (cur && (list || []).indexOf(cur) < 0) opts.push({ value: cur, label: cur });
      opts.push({ value: NEW_CATEGORY, label: 'New category…', className: 'bw-sel-new' });
      f.category.setOptions(opts);
      f.category.setValue(cur || '');
    }

    f.coverUpload = el('input', { type: 'file', accept: 'image/*', hidden: true, 'aria-label': 'Cover image file' });
    f.coverButton = el('button', { type: 'button', className: 'btn btn-secondary bw-small', text: 'Upload cover' });
    f.coverRemove = el('button', { type: 'button', className: 'btn btn-secondary bw-small', text: 'Remove cover', hidden: true });
    f.coverMsg = el('div', { className: 'bw-msg', role: 'status', 'aria-live': 'polite' });
    f.coverAlt = el('input', { id: 'bw-cover-alt', className: 'bw-input', type: 'text', maxlength: '200', placeholder: 'Describe the cover image', autocomplete: 'off' });
    f.crop11 = el('div', { className: 'bw-crop bw-crop-square', title: 'Article list (1:1)' });
    f.crop191 = el('div', { className: 'bw-crop bw-crop-wide', title: 'Link preview (1.91:1)' });
    f.cropImg1 = el('img', { alt: '' });
    f.cropImg2 = el('img', { alt: '' });
    f.crop11.appendChild(f.cropImg1);
    f.crop191.appendChild(f.cropImg2);
    f.coverButton.addEventListener('click', function () { f.coverUpload.click(); });
    f.coverRemove.addEventListener('click', function () { cover = { src: '', alt: '', card: '', share: '' }; f.coverAlt.value = ''; f.coverMsg.textContent = ''; renderCover(); changed(); });
    f.coverAlt.addEventListener('input', function () { cover.alt = f.coverAlt.value; changed(); });
    f.coverUpload.addEventListener('change', function () {
      var file = f.coverUpload.files && f.coverUpload.files[0];
      f.coverUpload.value = '';
      if (!file) return;
      f.coverMsg.className = 'bw-msg';
      f.coverMsg.textContent = 'Uploading… 0%';
      f.coverButton.disabled = true;
      ctx.api.upload('media/image', file, {
        headers: { 'X-Blog-Cover': '1' },
        onProgress: function (p) { f.coverMsg.textContent = 'Uploading… ' + Math.round(p * 100) + '%'; },
      }).then(function (res) {
        cover = { src: res.src, alt: f.coverAlt.value, card: res.card || '', share: res.share || '' };
        f.coverMsg.textContent = '';
        renderCover();
        changed();
      }, function (e) {
        f.coverMsg.className = 'bw-msg bw-msg-bad';
        f.coverMsg.textContent = ui.uploadError(e, 'image');
      }).then(function () { f.coverButton.disabled = !editable; });
    });
    function renderCover() {
      var has = !!cover.src;
      f.coverRemove.hidden = !has;
      f.coverButton.textContent = has ? 'Replace cover' : 'Upload cover';
      f.crop11.classList.toggle('bw-crop-empty', !has);
      f.crop191.classList.toggle('bw-crop-empty', !has);
      f.cropImg1.hidden = !has; f.cropImg2.hidden = !has;
      if (has) { f.cropImg1.src = cover.src; f.cropImg2.src = cover.src; } else { f.cropImg1.removeAttribute('src'); f.cropImg2.removeAttribute('src'); }
    }

    f.author = el('input', { id: 'bw-author', className: 'bw-input', type: 'text', maxlength: '80', placeholder: 'BIO LAB Team', autocomplete: 'off' });
    f.author.addEventListener('input', changed);
    f.noindex = el('input', { id: 'bw-noindex', type: 'checkbox' });
    f.noindex.addEventListener('change', changed);

    panes.post.appendChild(field('Address', el('div', {}, [el('div', { className: 'bw-row' }, [el('span', { className: 'bw-prefix', text: '/blog/' }), f.slug, f.slugFromTitle]), f.slugMsg, f.redirectNote]), '', 'bw-slug'));
    panes.post.appendChild(field('Category', el('div', {}, [f.category.el, f.newCategoryRow, f.categoryMsg]), '', 'bw-category'));
    panes.post.appendChild(el('div', { className: 'bw-field' }, [
      el('div', { className: 'bw-label', text: 'Cover image' }),
      el('div', { className: 'bw-crops' }, [
        el('figure', { className: 'bw-crop-fig' }, [f.crop11, el('figcaption', { text: 'List card 1:1' })]),
        el('figure', { className: 'bw-crop-fig bw-crop-fig-wide' }, [f.crop191, el('figcaption', { text: 'Link preview 1.91:1' })]),
      ]),
      el('div', { className: 'bw-row' }, [f.coverButton, f.coverRemove, f.coverUpload]),
      f.coverMsg,
      el('label', { className: 'bw-label bw-label-sub', text: 'Cover alt text', for: 'bw-cover-alt' }),
      f.coverAlt,
    ]));
    panes.post.appendChild(field('Author', f.author, '', 'bw-author'));
    panes.post.appendChild(el('div', { className: 'bw-field bw-check' }, [
      f.noindex, el('label', { for: 'bw-noindex', text: 'Hide from search engines (noindex)' }),
      el('div', { className: 'bw-hint', text: 'The article stays reachable by its address but is left out of the sitemap and tells search engines not to list it.' }),
    ]));

    function renderSlugMessage() {
      var v = f.slug.value;
      var msg = slugServerError;
      var cls = 'bw-msg bw-msg-bad';
      if (!msg && v && (v.length < 3 || !SLUG_RE.test(v))) msg = 'Use lowercase letters, numbers and hyphens (3–80 characters)';
      if (!msg && v) { msg = 'Address looks good'; cls = 'bw-msg bw-msg-ok'; }
      f.slugMsg.className = cls;
      f.slugMsg.textContent = msg;
      f.slug.classList.toggle('bw-invalid', cls.indexOf('bad') >= 0 && !!msg);
      var live = ctx.liveSlug();
      f.redirectNote.hidden = !(ctx.isPublished() && live && v && v !== live);
    }

    // ---- SEO tab ----------------------------------------------------------------------------------------------------

    f.seoTitle = el('input', { id: 'bw-seo-title', className: 'bw-input', type: 'text', maxlength: '70', autocomplete: 'off' });
    f.seoTitleCount = el('span', { className: 'bw-count', 'aria-live': 'polite' });
    f.description = el('textarea', { id: 'bw-description', className: 'bw-input bw-textarea', rows: '4', maxlength: '200' });
    f.descCount = el('span', { className: 'bw-count', 'aria-live': 'polite' });
    f.focusKw = el('input', { id: 'bw-focus-kw', className: 'bw-input', type: 'text', maxlength: '100', autocomplete: 'off', placeholder: 'e.g. cjc-1295 identity' });
    f.chips = el('div', { className: 'bw-chips-list' });
    f.secInput = el('input', { id: 'bw-sec-kw', className: 'bw-input', type: 'text', maxlength: '60', autocomplete: 'off', placeholder: 'Type a keyword and press Enter' });
    [f.seoTitle, f.description, f.focusKw].forEach(function (i) { i.addEventListener('input', changed); });
    f.secInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addKeyword(f.secInput.value); }
      else if (e.key === 'Backspace' && !f.secInput.value && secondary.length) { secondary.pop(); renderChips(); changed(); }
    });
    f.secInput.addEventListener('blur', function () { if (f.secInput.value.trim()) addKeyword(f.secInput.value); });
    function addKeyword(raw) {
      var k = String(raw).replace(/,/g, ' ').trim().slice(0, 60);
      f.secInput.value = '';
      if (!k || secondary.length >= 20) return;
      if (secondary.some(function (x) { return x.toLowerCase() === k.toLowerCase(); })) return;
      secondary.push(k);
      renderChips();
      changed();
    }
    function renderChips() {
      ui.clear(f.chips);
      secondary.forEach(function (k, i) {
        f.chips.appendChild(el('span', { className: 'bw-kw' }, [
          k,
          el('button', { type: 'button', className: 'bw-kw-x', 'aria-label': 'Remove ' + k, title: 'Remove', text: '×', disabled: !editable, on: { click: function () { secondary.splice(i, 1); renderChips(); changed(); } } }),
        ]));
      });
    }

    f.snipTitle = el('div', { className: 'bw-snip-title' });
    f.snipUrl = el('div', { className: 'bw-snip-url' });
    f.snipDesc = el('div', { className: 'bw-snip-desc' });
    f.cardImg = el('img', { alt: '' });
    f.cardImgBox = el('div', { className: 'bw-card-img' }, [f.cardImg]);
    f.cardHost = el('div', { className: 'bw-card-host', text: SITE_HOST.toUpperCase() });
    f.cardTitle = el('div', { className: 'bw-card-title' });
    f.cardDesc = el('div', { className: 'bw-card-desc' });
    f.seoList = el('ul', { className: 'bw-checks' });

    panes.seo.appendChild(field('SEO title', el('div', {}, [f.seoTitle, el('div', { className: 'bw-count-row' }, [f.seoTitleCount])]), 'What search results show as the page title. Empty: the article title plus “| BIO LABS Research”.', 'bw-seo-title'));
    panes.seo.appendChild(field('Description', el('div', {}, [f.description, el('div', { className: 'bw-count-row' }, [f.descCount])]), 'Shown under the title in search results; 120–160 characters work best.', 'bw-description'));
    panes.seo.appendChild(field('Focus keyword', f.focusKw, 'The main phrase this article should be found for.', 'bw-focus-kw'));
    panes.seo.appendChild(field('Additional keywords', el('div', {}, [f.chips, f.secInput]), '', 'bw-sec-kw'));
    panes.seo.appendChild(el('div', { className: 'bw-field' }, [
      el('div', { className: 'bw-label', text: 'Google preview' }),
      el('div', { className: 'bw-snippet' }, [f.snipUrl, f.snipTitle, f.snipDesc]),
    ]));
    panes.seo.appendChild(el('div', { className: 'bw-field' }, [
      el('div', { className: 'bw-label', text: 'Share card' }),
      el('div', { className: 'bw-card' }, [f.cardImgBox, el('div', { className: 'bw-card-body' }, [f.cardHost, f.cardTitle, f.cardDesc])]),
    ]));
    panes.seo.appendChild(el('div', { className: 'bw-field' }, [el('div', { className: 'bw-label', text: 'Keyword checks' }), f.seoList]));

    function clip(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s; }
    function effectiveTitle() { var t = f.seoTitle.value.trim(); return t || (ctx.getTitle().trim() ? ctx.getTitle().trim() + DEFAULT_SUFFIX : ''); }
    function effectiveTitleDefault() { var t = ctx.getTitle().trim(); return t ? t + DEFAULT_SUFFIX : 'The article title plus' + DEFAULT_SUFFIX; }
    function counter(node, n, level, text) { node.textContent = text; node.className = 'bw-count bw-count-' + level; }
    function updatePreviews() {
      var et = effectiveTitle();
      counter(f.seoTitleCount, et.length, titleLevel(et.length), et.length + ' / 60');
      var dl = f.description.value.trim().length;
      counter(f.descCount, dl, descLevel(dl), dl + ' / 160');
      f.seoTitle.placeholder = effectiveTitleDefault();
      f.snipTitle.textContent = clip(et || 'Article title', 60);
      f.snipUrl.textContent = SITE_HOST + ' › blog › ' + (f.slug.value || 'address');
      f.snipDesc.textContent = clip(f.description.value.trim() || 'Add a description: it is what people read under the title in search results.', 160);
      f.cardTitle.textContent = clip(et || 'Article title', 70);
      f.cardDesc.textContent = clip(f.description.value.trim(), 120);
      f.cardImgBox.classList.toggle('bw-crop-empty', !cover.src);
      f.cardImg.hidden = !cover.src;
      if (cover.src) f.cardImg.src = cover.src; else f.cardImg.removeAttribute('src');
    }

    // ---- Checks (SEO list and the Checklist tab) ----------------------------------------------------------------------

    function showTab(name) {
      tabButtons.forEach(function (b) {
        var on = b.getAttribute('data-tab') === name;
        b.setAttribute('aria-selected', on ? 'true' : 'false');
        b.tabIndex = on ? 0 : -1;
      });
      Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== name; });
    }
    tabButtons.forEach(function (b, i) {
      b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
      b.addEventListener('keydown', function (e) {
        if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
        var n = tabButtons[(i + (e.key === 'ArrowRight' ? 1 : tabButtons.length - 1)) % tabButtons.length];
        showTab(n.getAttribute('data-tab'));
        n.focus();
      });
    });

    function firstBlockIndex(pred) {
      var doc = ctx.getDoc();
      var list = doc && doc.content ? doc.content : [];
      for (var i = 0; i < list.length; i++) if (pred(list[i])) return i;
      return -1;
    }
    var hasText = function (n) { return !!(n.content && n.content.some(function (c) { return c.type === 'text' && String(c.text || '').trim(); })); };

    // Where a check points: a document path (scroll the text there) or one of the side panel's own fields.
    function jump(item) {
      var ed = ctx.getEditor();
      if (Array.isArray(item.path) && ed) { ed.scrollToPath(item.path); return; }
      var focus = function (tab, node) { showTab(tab); node.focus(); };
      switch (item.code) {
        case 'title': case 'kw_title': ctx.focusTitle(); break;
        case 'slug': case 'kw_slug': focus('post', f.slug); break;
        case 'category': focus('post', f.category); break;
        case 'no_cover': focus('post', f.coverButton); break;
        case 'description': case 'kw_description': case 'description_length': focus('seo', f.description); break;
        case 'title_length': focus('seo', f.seoTitle); break;
        case 'secondary_kw_unused': focus('seo', f.secInput); break;
        case 'body': if (ed) ed.focus(); break;
        case 'kw_first_paragraph': { var p = firstBlockIndex(function (n) { return n.type === 'paragraph' && hasText(n); }); if (ed && p >= 0) ed.scrollToPath([p]); break; }
        case 'kw_headings': { var h = firstBlockIndex(function (n) { return n.type === 'heading'; }); if (ed && h >= 0) ed.scrollToPath([h]); else if (ed) ed.focus(); break; }
        case 'no_internal_link': if (ed) ed.focus(); break;
        default: break;
      }
    }

    function checkItem(item, cls, mark) {
      var clickable = Array.isArray(item.path) || /^(title|slug|category|no_cover|description|title_length|description_length|secondary_kw_unused|body|kw_[a-z_]+|no_internal_link)$/.test(item.code);
      var inner = [el('span', { className: 'bw-mark', 'aria-hidden': 'true', text: mark }), el('span', { className: 'bw-check-text', text: item.message })];
      var node = el('li', { className: 'bw-check-item ' + cls });
      if (clickable) {
        node.appendChild(el('button', { type: 'button', className: 'bw-check-btn', title: 'Go to this place', on: { click: function () { jump(item); } } }, inner));
      } else inner.forEach(function (n) { node.appendChild(n); });
      return node;
    }

    function riskWords(warnings) {
      var out = [];
      warnings.forEach(function (w) {
        if (w.code !== 'risk_word') return;
        var m = /"([^"]+)"/.exec(w.message || '');
        if (m && out.indexOf(m[1]) < 0) out.push(m[1]);
      });
      return out;
    }

    function renderChecks() {
      var req = checks.required || [];
      var warns = checks.warnings || [];
      var dropped = warns.filter(function (w) { return w.code === 'content_dropped'; });
      var other = warns.filter(function (w) { return w.code !== 'content_dropped'; });
      var total = req.length + warns.length;
      badge.hidden = total === 0;
      badge.textContent = String(total);
      badge.className = 'bw-badge' + (req.length || dropped.length ? ' bw-badge-bad' : ' bw-badge-warn');

      var pane = panes.check;
      ui.clear(pane);
      if (dropped.length) {
        var box = el('div', { className: 'bw-dropped', role: 'alert' }, [el('div', { className: 'bw-dropped-title', text: 'Some content could not be saved:' })]);
        var ul = el('ul', { className: 'bw-checks' });
        dropped.forEach(function (w) { ul.appendChild(checkItem(w, 'bw-check-bad', '!')); });
        box.appendChild(ul);
        box.appendChild(el('div', { className: 'bw-hint', text: 'The rest of the article is saved. Check the places listed and add the missing parts again.' }));
        pane.appendChild(box);
      }
      function section(title, items, cls, mark, hint) {
        if (!items.length) return;
        var s = el('div', { className: 'bw-section' }, [el('div', { className: 'bw-section-title', text: title + ' (' + items.length + ')' })]);
        if (hint) s.appendChild(el('div', { className: 'bw-hint', text: hint }));
        var l = el('ul', { className: 'bw-checks' });
        items.forEach(function (it) { l.appendChild(checkItem(it, cls, mark)); });
        s.appendChild(l);
        pane.appendChild(s);
      }
      section('Required to publish', req, 'bw-check-bad', '✗', 'Publish stays off until these are fixed.');
      section('Worth a look', other, 'bw-check-warn', '!', 'These do not block publishing.');
      if (!total) pane.appendChild(el('div', { className: 'bw-allgood', text: 'Nothing to fix. The article is ready to publish.' }));

      ui.clear(f.seoList);
      (checks.seo || []).forEach(function (it) { f.seoList.appendChild(checkItem(it, it.ok ? 'bw-check-ok' : 'bw-check-warn', it.ok ? '✓' : '✗')); });
      if (!(checks.seo || []).length) f.seoList.appendChild(el('li', { className: 'bw-hint', text: 'Checks appear after the first save.' }));

      // Only when the list really changed: a transaction right after a save response can swallow a selection the author is
      // just extending with the keyboard (ProseMirror re-applies its own, older selection to the DOM).
      var ed = ctx.getEditor();
      var words = riskWords(warns);
      var wordsKey = words.join('|');
      if (ed && wordsKey !== lastRisk) { lastRisk = wordsKey; ed.setRiskWords(words); }
    }

    // ---- API for the page core ----------------------------------------------------------------------------------------

    function setFields(d) {
      d = d || {};
      f.slug.value = d.slug || '';
      f.seoTitle.value = d.seoTitle || '';
      f.description.value = d.description || '';
      f.focusKw.value = d.focusKeyword || '';
      f.author.value = d.author || '';
      f.noindex.checked = !!d.noindex;
      secondary = Array.isArray(d.secondaryKeywords) ? d.secondaryKeywords.slice() : [];
      cover = { src: (d.cover && d.cover.src) || '', alt: (d.cover && d.cover.alt) || '', card: (d.cover && d.cover.card) || '', share: (d.cover && d.cover.share) || '' };
      f.coverAlt.value = cover.alt;
      setCategories(ctx.categories || [], d.category || '');
      categoryBefore = d.category || '';
      renderChips();
      renderCover();
      slugServerError = '';
      renderSlugMessage();
      updatePreviews();
    }
    function getFields() {
      return {
        slug: f.slug.value.trim(),
        seoTitle: f.seoTitle.value.trim(),
        description: f.description.value.trim(),
        category: f.category.value() === NEW_CATEGORY ? categoryBefore : f.category.value(),
        cover: { src: cover.src, alt: cover.alt, card: cover.card, share: cover.share },
        focusKeyword: f.focusKw.value.trim(),
        secondaryKeywords: secondary.slice(),
        author: f.author.value.trim(),
        noindex: f.noindex.checked,
      };
    }
    function setChecks(c, slugError) {
      checks = { required: (c && c.required) || [], warnings: (c && c.warnings) || [], seo: (c && c.seo) || [] };
      slugServerError = slugError && slugError.message ? slugError.message : '';
      renderSlugMessage();
      renderChecks();
    }
    function setEditable(on) {
      editable = !!on;
      f.category.setDisabled(!on);
      Object.keys(f).forEach(function (k) { var n = f[k]; if (n && (n.tagName === 'INPUT' || n.tagName === 'SELECT' || n.tagName === 'TEXTAREA' || n.tagName === 'BUTTON')) n.disabled = !on; });
      renderChips();
    }
    function refreshSlugNote() { renderSlugMessage(); }

    showTab('post');
    setCategories([], '');
    renderCover();
    updatePreviews();
    renderChecks();

    return {
      setFields: setFields, getFields: getFields, setChecks: setChecks, setEditable: setEditable, showTab: showTab,
      setCategories: function (list) { ctx.categories = list; setCategories(list); },
      refreshPreviews: updatePreviews, refreshSlugNote: refreshSlugNote,
      focusSlug: function () { showTab('post'); f.slug.focus(); },
      setSlugError: function (msg) { slugServerError = msg || ''; renderSlugMessage(); },
      checks: function () { return checks; },
    };
  }

  NS.createPanel = createPanel;
}(window));
