'use strict';
/**
 * CRM Tasks page: pure logic, no DOM (spec docs/superpowers/specs/2026-10-01-crm-tasks.md).
 * Browser: window.TasksModel. Node: module.exports (the tests).
 * "Today" and "overdue" are the viewer's calendar day: a due date is a bare day, not an instant.
 */
(function (global) {
  var DAY = 86400000, HOUR = 3600000, MIN = 60000;
  var STATUSES = ['todo', 'in_progress', 'review', 'done'];
  var STATUS_LABEL = { todo: 'To do', in_progress: 'In progress', review: 'Review', done: 'Done' };
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LINK_MAX = 300;
  var LIMITS = { title: 140, description: 4000, comment: 2000, linkLabel: 80, assignees: 10, files: 20 };
  // The server takes up to 900 KB (nginx cuts /api/ at 1 MB); the page shrinks every picture to fit before sending.
  var SHRINK = { MAX_SIDE: 1920, MAX_BYTES: 900 * 1024, QUALITY: [0.85, 0.75, 0.65, 0.55, 0.45, 0.35] };
  var PERIODS = { '7': 7, '30': 30, all: null };

  function normEmail(e) { return typeof e === 'string' ? e.trim().toLowerCase() : ''; }
  function arr(x) { return Array.isArray(x) ? x : []; }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function msOf(v) { var t = typeof v === 'string' && v ? Date.parse(v) : NaN; return isFinite(t) ? t : NaN; }

  /* ── dates and time ───────────────────────────────────────────────────────────────────────── */
  function todayOf(nowMs) {
    var d = new Date(nowMs);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
  function isValidDate(s) {
    var m = typeof s === 'string' ? DATE_ONLY.exec(s) : null;
    if (!m) return false;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(y, mo - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === mo - 1 && dt.getDate() === d;
  }
  function isOverdue(task, nowMs) {
    if (!task || task.status === 'done' || !isValidDate(task.due)) return false;
    return task.due < todayOf(nowMs);   // YYYY-MM-DD compares as text
  }
  function fmtDuration(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n < 0) n = 0;
    var mins = Math.floor(n / MIN);
    if (mins < 60) return mins + 'm';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return mins % 60 ? hours + 'h ' + (mins % 60) + 'm' : hours + 'h';
    var days = Math.floor(hours / 24);
    return hours % 24 ? days + 'd ' + (hours % 24) + 'h' : days + 'd';
  }
  function fmtDue(due, nowMs) {
    if (!isValidDate(due)) return '';
    var y = +due.slice(0, 4), m = +due.slice(5, 7), d = +due.slice(8, 10);
    var s = MON[m - 1] + ' ' + d;
    return y === new Date(nowMs).getFullYear() ? s : s + ', ' + y;
  }

  /* ── who may do what (the server checks again; this only decides which buttons to show) ───── */
  function isAssignee(t, email) { var e = normEmail(email); return !!e && arr(t && t.assignees).some(function (a) { return normEmail(a) === e; }); }
  function isParticipant(t, email) { var e = normEmail(email); return !!e && arr(t && t.participants).some(function (p) { return normEmail(p && p.email) === e; }); }
  function isAuthor(t, email) { var e = normEmail(email); return !!e && !!t && !!t.createdBy && normEmail(t.createdBy.email) === e; }
  function isMember(t, email) { return isAuthor(t, email) || isAssignee(t, email) || isParticipant(t, email); }
  function isAdmin(me) { return !!me && me.role === 'admin'; }
  function canEdit(t, me) { return !!me && (isAdmin(me) || isMember(t, me.email)); }
  function canArchive(t, me) { return !!me && (isAdmin(me) || isAuthor(t, me.email)); }
  function actionsFor(t, me) {
    var none = { join: false, take: false, status: false, edit: false, archive: false, restore: false };
    if (!t || !me) return none;
    if (t.archivedAt) { none.restore = canArchive(t, me); return none; }
    var open = t.status !== 'done';
    var part = isParticipant(t, me.email);
    var edit = canEdit(t, me);
    // Moving a task into work makes its author or assignee a participant (the server does that); an admin who is neither is not
    // added by it, so for an admin "Take" would take nothing: he gets Join instead.
    var mine = isAuthor(t, me.email) || isAssignee(t, me.email);
    return {
      // Join: not on the task yet (any signed-in user may), or a member who is not a participant while it is already running.
      // Take: the author / assignee who has not taken it, from To do or Review.
      join: open && !part && (!mine || t.status === 'in_progress'),
      take: open && !part && mine && t.status !== 'in_progress',
      status: edit,
      edit: edit,
      archive: canArchive(t, me),
      restore: false
    };
  }

  /* ── list: filter, sort ───────────────────────────────────────────────────────────────────── */
  function filterTasks(tasks, o) {
    o = o || {};
    var q = String(o.q || '').trim().toLowerCase();
    var me = normEmail(o.meEmail);
    return arr(tasks).filter(function (t) {
      if (!t) return false;
      if (o.archived) return !!t.archivedAt;
      if (t.archivedAt) return false;
      if (!o.showClosed && t.status === 'done') return false;
      if (o.filter === 'mine' && !isMember(t, me)) return false;
      if (o.filter === 'overdue' && !isOverdue(t, o.nowMs)) return false;
      if (q && String(t.title || '').toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  function countFilters(tasks, o) {
    o = o || {};
    var open = arr(tasks).filter(function (t) { return t && !t.archivedAt && (o.showClosed || t.status !== 'done'); });
    return {
      all: open.length,
      mine: open.filter(function (t) { return isMember(t, o.meEmail); }).length,
      overdue: open.filter(function (t) { return isOverdue(t, o.nowMs); }).length
    };
  }
  var RANK = { in_progress: 0, review: 1, todo: 2, done: 3 };
  function cmpDue(a, b) {   // soonest first, no date last
    var x = isValidDate(a.due) ? a.due : null, y = isValidDate(b.due) ? b.due : null;
    if (x && y) return x < y ? -1 : x > y ? 1 : 0;
    return x ? -1 : y ? 1 : 0;
  }
  function num(v, dflt) { var t = msOf(v); return isFinite(t) ? t : dflt; }
  function cmpN(a, b) { return (b.n || 0) - (a.n || 0); }
  function sortTasks(tasks, mode) {
    var out = arr(tasks).slice();
    var cmp;
    if (mode === 'due') cmp = function (a, b) { return cmpDue(a, b) || cmpN(a, b); };
    else if (mode === 'updated') cmp = function (a, b) { return num(b.updatedAt, 0) - num(a.updatedAt, 0) || cmpN(a, b); };
    else if (mode === 'newest') cmp = cmpN;
    else cmp = function (a, b) {   // smart: what is running first, then by due date, then the most recently touched; closed by closing time
      var ra = RANK[a.status], rb = RANK[b.status];
      ra = ra === undefined ? 4 : ra; rb = rb === undefined ? 4 : rb;
      if (ra !== rb) return ra - rb;
      if (ra === 3) return num(b.doneAt, 0) - num(a.doneAt, 0) || cmpN(a, b);
      return cmpDue(a, b) || num(b.updatedAt, 0) - num(a.updatedAt, 0) || cmpN(a, b);
    };
    return out.sort(cmp);
  }

  /* ── board ────────────────────────────────────────────────────────────────────────────────── */
  function groupByStatus(tasks, o) {
    o = o || {};
    var cols = { todo: [], in_progress: [], review: [], done: [] };
    arr(tasks).forEach(function (t) { if (t && cols[t.status]) cols[t.status].push(t); });
    ['todo', 'in_progress', 'review'].forEach(function (s) { cols[s] = sortTasks(cols[s], 'smart'); });
    cols.done = sortTasks(cols.done, 'smart');
    var hidden = 0;
    if (typeof o.doneWithinDays === 'number') {
      var from = o.nowMs - o.doneWithinDays * DAY;
      var kept = cols.done.filter(function (t) { var d = msOf(t.doneAt); return !isFinite(d) || d >= from; });
      hidden = cols.done.length - kept.length;
      cols.done = kept;
    }
    return { columns: cols, hiddenDone: hidden };
  }

  /* ── people ───────────────────────────────────────────────────────────────────────────────── */
  function workOf(t, email) {
    var w = t && t.work && typeof t.work === 'object' ? t.work : null;
    if (!w) return 0;
    for (var k in w) if (Object.prototype.hasOwnProperty.call(w, k) && normEmail(k) === email) { var n = Number(w[k]); return isFinite(n) && n > 0 ? n : 0; }
    return 0;
  }
  // Per person: tasks they took that are running / in review now, tasks done inside the period (and the time spent on them),
  // time on tasks still open, tasks assigned but not taken. Time comes from the server (`work` of each task); it has no dates,
  // so it is split by the task's state, not by the period.
  function peopleSummary(tasks, people, nowMs, period) {
    var days = Object.prototype.hasOwnProperty.call(PERIODS, period) ? PERIODS[period] : 30;
    var from = days === null ? -Infinity : nowMs - days * DAY;
    var by = {}, order = [];
    function get(email, name) {
      var e = normEmail(email);
      if (!e) return null;
      if (!by[e]) {
        by[e] = { email: e, name: name || e, inProgress: 0, review: 0, done: 0, doneMs: 0, openMs: 0, waiting: 0, active: [] };
        order.push(e);
      }
      return by[e];
    }
    arr(people).forEach(function (p) { if (p) get(p.email, p.name); });
    arr(tasks).forEach(function (t) {
      if (!t || t.archivedAt) return;
      var parts = {};
      arr(t.participants).forEach(function (p) {
        var rec = p && get(p.email);
        if (!rec) return;
        parts[rec.email] = true;
        if (t.status === 'in_progress') { rec.inProgress++; rec.active.push(t); }
        else if (t.status === 'review') rec.review++;
        if (t.status === 'done') {
          var d = msOf(t.doneAt);
          if (days === null || (isFinite(d) && d >= from)) { rec.done++; rec.doneMs += workOf(t, rec.email); }
        } else rec.openMs += workOf(t, rec.email);
      });
      if (t.status !== 'done') arr(t.assignees).forEach(function (a) { var rec = get(a); if (rec && !parts[rec.email]) rec.waiting++; });
    });
    return order.map(function (e) { return by[e]; }).sort(function (a, b) {
      return b.inProgress - a.inProgress || b.done - a.done || a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });
  }

  /* ── links and form checks ────────────────────────────────────────────────────────────────── */
  // The only href the page ever sets from data: a CRM page, by the very rule of the server (crm-tasks.cjs LINK_URL_RE): /crm/ then
  // letters, digits and . _ ~ - / ? = & % # + : @ , ; only (no quote, angle bracket, space, backslash), no "//", no "..", 300 at most.
  var LINK_URL_RE = /^\/crm\/[A-Za-z0-9._~\-/?=&%#+:@,;]*$/;
  function safeLink(url) {
    if (typeof url !== 'string') return '';
    var u = url.trim();
    if (u.length > LINK_MAX || !LINK_URL_RE.test(u) || u.indexOf('//') !== -1 || u.indexOf('..') !== -1) return '';
    return u;
  }
  // The only src the page sets on a picture: a data: URL of a png / jpeg / webp (the CSP of the CRM host has no blob:).
  function safeImageSrc(url) {
    return typeof url === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/]*={0,2}$/.test(url) ? url : '';
  }
  function validateTask(f) {
    f = f || {};
    var errors = {}, value = {};
    var title = typeof f.title === 'string' ? f.title.trim() : '';
    if (!title) errors.title = 'Give the task a title';
    else if (title.length > LIMITS.title) errors.title = 'The title is at most ' + LIMITS.title + ' characters (now ' + title.length + ')';
    else value.title = title;
    var desc = typeof f.description === 'string' ? f.description.trim() : '';
    if (desc.length > LIMITS.description) errors.description = 'The description is at most ' + LIMITS.description + ' characters (now ' + desc.length + ')';
    else if (desc) value.description = desc;
    var seen = {}, list = [];
    arr(f.assignees).forEach(function (a) { var e = normEmail(a); if (e && !seen[e]) { seen[e] = true; list.push(e); } });
    if (list.length > LIMITS.assignees) errors.assignees = 'At most ' + LIMITS.assignees + ' people can be assigned';
    else if (list.length) value.assignees = list;
    var due = typeof f.due === 'string' ? f.due.trim() : '';
    if (due && !isValidDate(due)) errors.due = 'Pick a date';
    else if (due) value.due = due;
    var label = typeof f.linkLabel === 'string' ? f.linkLabel.trim() : '';
    var url = typeof f.linkUrl === 'string' ? f.linkUrl.trim() : '';
    if (label || url) {
      if (!label || !url) errors.link = 'A link needs both a name and an address';
      else if (label.length > LIMITS.linkLabel) errors.link = 'The link name is at most ' + LIMITS.linkLabel + ' characters';
      else if (!safeLink(url)) errors.link = 'The address must be a CRM page: it starts with /crm/ (for example /crm/orders.html), at most 300 characters, letters, digits and . _ ~ - / ? = & % # + : @ , ; only';
      else value.link = { label: label, url: safeLink(url) };
    }
    return { ok: Object.keys(errors).length === 0, errors: errors, value: value };
  }
  function validateComment(text) {
    var t = typeof text === 'string' ? text.trim() : '';
    if (!t) return { ok: false, error: 'Write something first', value: '' };
    if (t.length > LIMITS.comment) return { ok: false, error: 'A comment is at most ' + LIMITS.comment + ' characters (now ' + t.length + ')', value: t };
    return { ok: true, error: '', value: t };
  }

  /* ── history ──────────────────────────────────────────────────────────────────────────────── */
  var FIELD_LABEL = { title: 'the title', description: 'the description', due: 'the due date', link: 'the link', assignees: 'the assignees' };
  function statusName(s) { return STATUS_LABEL[s] || String(s); }
  // The line after the person's name. A comment's text is not in it: the page shows that by itself, as text.
  function describeEvent(ev, nameOf) {
    if (!ev || typeof ev !== 'object') return '';
    var nm = typeof nameOf === 'function' ? nameOf : function (e) { return e; };
    var names = function (a) { return arr(a).map(nm).join(', '); };
    switch (ev.type) {
      case 'created': return 'created the task';
      case 'assigned': {
        var parts = [];
        if (arr(ev.added).length) parts.push('assigned ' + names(ev.added));
        if (arr(ev.removed).length) parts.push('removed ' + names(ev.removed) + ' from the assignees');
        return parts.length ? parts.join('; ') : 'changed the assignees';
      }
      case 'status': return ev.from ? 'moved the task from ' + statusName(ev.from) + ' to ' + statusName(ev.to) : 'moved the task to ' + statusName(ev.to);
      case 'joined': return 'joined the task';
      case 'comment': return 'commented';
      case 'file_added': return 'attached "' + (ev.name || 'a picture') + '"';
      case 'file_removed': return 'removed "' + (ev.name || 'a picture') + '"';
      case 'edited': {
        var f = typeof ev.fields === 'string' ? [ev.fields] : arr(ev.fields);
        return f.length ? 'edited ' + f.map(function (x) { return FIELD_LABEL[x] || String(x); }).join(', ') : 'edited the task';
      }
      case 'archived': return 'archived the task';
      case 'restored': return 'restored the task';
      default: return 'did something (' + String(ev.type) + ')';
    }
  }

  /* ── pictures ─────────────────────────────────────────────────────────────────────────────── */
  function fitSize(w, h, max) {
    var long = Math.max(w, h);
    if (long <= max) return { w: w, h: h };
    var k = max / long;
    return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
  }
  // The picture is always sent as JPEG, so the name gets .jpg (the server names the file itself and keeps ours for display).
  function shrunkName(name) {
    var base = typeof name === 'string' ? name.split(/[\\/]/).pop().trim() : '';
    base = base.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    if (!base) base = 'screenshot';
    if (base.length > 90) base = base.slice(0, 90);
    return base + '.jpg';
  }

  /* ── small things for the page ────────────────────────────────────────────────────────────── */
  function initials(name, email) {
    var base = String(name || email || '').trim();
    if (!base) return '?';
    var p = base.split(/\s+/).filter(Boolean);
    return (p.length > 1 ? p[0][0] + p[p.length - 1][0] : base.slice(0, 2)).toUpperCase();
  }
  function colorIndex(email, n) {
    var s = normEmail(email), h = 0;
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return h % n;
  }
  function parseHash(hash) {
    var m = /^#task=([A-Za-z0-9_-]{1,40})$/.exec(String(hash || ''));
    return m ? m[1] : null;
  }
  function normalizePrefs(raw) {
    var r = raw && typeof raw === 'object' ? raw : {};
    function pick(v, allowed, dflt) { return typeof v === 'string' && allowed.indexOf(v) !== -1 ? v : dflt; }
    return {
      view: pick(r.view, ['list', 'board', 'people'], 'list'),
      filter: pick(r.filter, ['all', 'mine', 'overdue'], 'all'),
      showClosed: r.showClosed === true,
      sort: pick(r.sort, ['smart', 'due', 'updated', 'newest'], 'smart'),
      period: pick(r.period, ['7', '30', 'all'], '30')
    };
  }

  var api = {
    STATUSES: STATUSES, STATUS_LABEL: STATUS_LABEL, LIMITS: LIMITS, SHRINK: SHRINK,
    normEmail: normEmail, todayOf: todayOf, isValidDate: isValidDate, isOverdue: isOverdue, fmtDuration: fmtDuration, fmtDue: fmtDue,
    isMember: isMember, isAssignee: isAssignee, isParticipant: isParticipant, isAuthor: isAuthor, canEdit: canEdit, canArchive: canArchive, actionsFor: actionsFor,
    filterTasks: filterTasks, countFilters: countFilters, sortTasks: sortTasks, groupByStatus: groupByStatus, peopleSummary: peopleSummary,
    workOf: workOf, safeLink: safeLink, safeImageSrc: safeImageSrc, validateTask: validateTask, validateComment: validateComment, describeEvent: describeEvent,
    fitSize: fitSize, shrunkName: shrunkName, initials: initials, colorIndex: colorIndex, parseHash: parseHash, normalizePrefs: normalizePrefs
  };
  global.TasksModel = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
