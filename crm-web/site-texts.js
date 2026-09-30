(function () {
  renderNav('site-texts');
  var BLOCK = 'science.faq';
  var clusters = [];

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'text') node.textContent = attrs[k];
        else if (k === 'className') node.className = attrs[k];
        else if (k === 'click') node.addEventListener('click', attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function harvest() {
    var next = [];
    document.querySelectorAll('[data-cluster]').forEach(function (box) {
      var items = [];
      box.querySelectorAll('[data-item]').forEach(function (row) {
        items.push({
          id: row.getAttribute('data-item') || '',
          q: row.querySelector('[data-q]').value,
          a: row.querySelector('[data-a]').value
        });
      });
      next.push({
        id: box.getAttribute('data-cluster') || '',
        title: box.querySelector('[data-cluster-title]').value,
        items: items
      });
    });
    clusters = next;
  }

  function field(labelText, control) {
    return el('div', { className: 'field' }, [el('label', { text: labelText }), control]);
  }

  function move(arr, i, delta) {
    var j = i + delta;
    if (j < 0 || j >= arr.length) return arr;
    var copy = arr.slice();
    var t = copy[i]; copy[i] = copy[j]; copy[j] = t;
    return copy;
  }

  function renderClusters() {
    var mount = document.getElementById('clusters');
    while (mount.firstChild) mount.removeChild(mount.firstChild);
    clusters.forEach(function (c, ci) {
      var box = el('div', { className: 'cluster', 'data-cluster': c.id || '' });
      var title = el('input', { 'data-cluster-title': '1', maxlength: '80', placeholder: 'e.g. Scope — optional' });
      title.value = c.title || '';
      box.appendChild(field('Group title (optional)', title));
      var head = el('div', { className: 'cluster-head' }, [
        el('button', { type: 'button', className: 'btn btn-secondary', text: 'Up', click: function () { harvest(); clusters = move(clusters, ci, -1); renderClusters(); } }),
        el('button', { type: 'button', className: 'btn btn-secondary', text: 'Down', click: function () { harvest(); clusters = move(clusters, ci, 1); renderClusters(); } }),
        el('button', { type: 'button', className: 'btn-cancel', text: 'Remove group', click: function () {
          harvest();
          if (clusters.length < 2) { toast('Keep at least one group', 'error'); return; }
          clusters.splice(ci, 1);
          renderClusters();
        } })
      ]);
      box.appendChild(head);
      (c.items || []).forEach(function (it, ii) {
        var q = el('input', { 'data-q': '1', maxlength: '200' });
        q.value = it.q || '';
        var a = el('textarea', { 'data-a': '1', maxlength: '2000' });
        a.value = it.a || '';
        var row = el('div', { className: 'item', 'data-item': it.id || '' }, [
          field('Question', q),
          field('Answer', a),
          el('div', { className: 'row-actions' }, [
            el('button', { type: 'button', className: 'btn btn-secondary', text: 'Up', click: function () { harvest(); clusters[ci].items = move(clusters[ci].items, ii, -1); renderClusters(); } }),
            el('button', { type: 'button', className: 'btn btn-secondary', text: 'Down', click: function () { harvest(); clusters[ci].items = move(clusters[ci].items, ii, 1); renderClusters(); } }),
            el('button', { type: 'button', className: 'btn-cancel', text: 'Remove question', click: function () {
              harvest();
              if (clusters[ci].items.length < 2) { toast('A group needs at least one question', 'error'); return; }
              clusters[ci].items.splice(ii, 1);
              renderClusters();
            } })
          ])
        ]);
        box.appendChild(row);
      });
      box.appendChild(el('button', { type: 'button', className: 'btn btn-secondary', text: 'Add question', click: function () {
        harvest();
        clusters[ci].items.push({ id: '', q: '', a: '' });
        renderClusters();
      } }));
      mount.appendChild(box);
    });
  }

  function renderVersions(list) {
    var box = document.getElementById('versions-box');
    while (box.firstChild) box.removeChild(box.firstChild);
    if (!list.length) {
      box.appendChild(el('div', { className: 'note', text: 'No previous saves yet. The first save keeps the original FAQ here so you can restore it.' }));
      return;
    }
    var table = el('table', { className: 'versions' });
    var thead = document.createElement('thead');
    var hr = document.createElement('tr');
    ['When', 'Who', 'Preview', ''].forEach(function (t) { hr.appendChild(el('th', { text: t })); });
    thead.appendChild(hr);
    table.appendChild(thead);
    var tb = document.createElement('tbody');
    list.forEach(function (v) {
      var first = (((v.snapshot || {}).clusters || [])[0] || {}).items || [];
      var q = first[0] ? first[0].q : '';
      var tr = document.createElement('tr');
      tr.appendChild(el('td', { text: v.saved_at || '' }));
      tr.appendChild(el('td', { text: v.saved_by || '' }));
      tr.appendChild(el('td', { className: 'preview', text: q }));
      var td = document.createElement('td');
      td.appendChild(el('button', {
        type: 'button', className: 'btn btn-secondary', text: 'Restore',
        click: function () { restore(v.saved_at); }
      }));
      tr.appendChild(td);
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    box.appendChild(table);
  }

  async function restore(at) {
    var ok = await confirmDialog('Publish this previous version now? It will replace the live FAQ.');
    if (!ok) return;
    try {
      await api('/msolpeptides-api/site-copy/restore', { method: 'POST', body: { block: BLOCK, saved_at: at } });
      toast('Restored — live on the Science page');
      await reload();
    } catch (err) { /* api() already toasted */ }
  }

  async function reload() {
    var data = await api('/msolpeptides-api/site-copy?block=' + encodeURIComponent(BLOCK));
    document.getElementById('kicker').value = data.kicker || '';
    document.getElementById('title').value = data.title || '';
    clusters = Array.isArray(data.clusters) ? data.clusters : [];
    var meta = document.getElementById('saved-meta');
    if (data.from_seed) meta.textContent = 'This is the original Science FAQ. Save to take it under CRM.';
    else meta.textContent = 'Last saved by ' + (data.updated_by || 'unknown') + (data.updated_at ? ' at ' + data.updated_at : '') + '.';
    renderClusters();
    var vers = await api('/msolpeptides-api/site-copy/versions?block=' + encodeURIComponent(BLOCK));
    renderVersions(vers.versions || []);
  }

  document.getElementById('add-group').addEventListener('click', function () {
    harvest();
    clusters.push({ id: '', title: '', items: [{ id: '', q: '', a: '' }] });
    renderClusters();
  });

  document.getElementById('save-btn').addEventListener('click', async function () {
    harvest();
    document.getElementById('form-err').textContent = '';
    try {
      await api('/msolpeptides-api/site-copy', {
        method: 'PUT',
        body: {
          block: BLOCK,
          kicker: document.getElementById('kicker').value,
          title: document.getElementById('title').value,
          clusters: clusters
        }
      });
      toast('Saved — live on the Science page');
      await reload();
    } catch (err) {
      document.getElementById('form-err').textContent = err.message || 'Could not save';
    }
  });

  reload().catch(function (err) {
    document.getElementById('saved-meta').textContent = err.message || 'Could not load';
  });
})();
