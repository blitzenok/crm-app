/**
 * crm-tasks.cjs (2026-10-01) - the team's task planner behind the CRM page Tasks.
 *
 *   GET    /api/tasks[?archived=1]             { ok, tasks, people, me, now }   rows without history, with work / workTotalMs
 *   GET    /api/tasks/:id                      { ok, task, work, workTotalMs }  the whole task, with history
 *   POST   /api/tasks                          { title, description?, assignees?, due?, link? }          -> 201 { task }
 *   PATCH  /api/tasks/:id                      any of title, description, due, link, assignees           -> { task }
 *   POST   /api/tasks/:id/status               { status: todo | in_progress | review | done }
 *   POST   /api/tasks/:id/join | /comments { text } | /archive | /restore
 *   POST   /api/tasks/:id/files                raw bytes of a png / jpeg / webp (X-File-Name: percent-encoded, optional)  -> 201 { task, file }
 *   GET    /api/tasks/:id/files/:fileId        the picture
 *   DELETE /api/tasks/:id/files/:fileId        -> { task }
 *
 * Mounted in server_v14.cjs behind requireAuth (req.userSession = { email, name, role }):
 *     app.use('/api/tasks', requireAuth, require('./crm-tasks.cjs')({ lockedUpdate, DATA_DIR, filesDir }));
 * Everybody signed in may read, create, comment, attach a picture and join. A member of a task (author, assignee, participant) and
 * an admin may edit it, move it between statuses and delete a picture; archive / restore: the author and an admin. Anybody else gets
 * 403 "Join the task first". There is no physical delete of a task. An archived task is read-only until it is restored.
 *
 * Data: data/tasks.json, one array, written only through lockedUpdate, and every change is made INSIDE the callback on the file as
 * the queue hands it over (two people acting at once cannot overwrite each other). The history of a task is only appended to.
 * The file is READ by this module itself, not through readJSON(): readJSON answers an unreadable file with the fallback it is given
 * ([]) and the next write would then replace every task. Unreadable is 503 here, a missing file is [] (first use). The same for
 * data/users.json, which is read for the assignee check and the people list (the /api/users route is closed to staff).
 *
 * Pictures live in filesDir (<taskId>/<fileId>.<ext>), by default /opt/crm-api/task-files: next to data/, not inside it. The nightly
 * backup takes the whole of /opt/crm-api, the 6-hourly one only data/, so the pictures are saved once a night and not 4 times a day
 * for 14 days. The folder is in the server repo's .gitignore (the owner's agents commit with git add -A).
 * The type is decided by the first bytes, never by the header; the name on disk is the server's own; the client's name is only
 * kept for display (cleaned) and never reaches a path or a header. express.json does not read an image body, this module reads the
 * stream itself and stops at 900 KB.
 *
 * Text: the server's sanitizeValue (server_v14.cjs) has already stripped script tags, on*="" handlers, javascript: and data:text/html
 * from every string in req.body and trimmed it; this module adds only what that does not do (control characters, lengths, types)
 * and does not repeat it. The page prints every text through textContent / esc().
 * Plain (req, res, next) handler with no express dependency, so it is testable with node:http. Source and install order:
 * biofirst-hosting services/crm-tasks/ (deploy/INSTALL.md).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = 'tasks.json';
const USERS_FILE = 'users.json';
const STATUSES = ['todo', 'in_progress', 'review', 'done'];
const MAX_TITLE = 140, MAX_DESCRIPTION = 4000, MAX_COMMENT = 2000, MAX_LABEL = 80, MAX_URL = 300;
const MAX_ASSIGNEES = 10, MAX_FILES_PER_TASK = 20;
const MAX_UPLOAD = 900 * 1024;                 // nginx cuts /api/ at 1 MB; the page shrinks a picture to this before sending
const MAX_TOTAL = 200 * 1024 * 1024;           // sum of size over every task
const TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const ID_RE = /^t_[0-9a-f]{12}$/;
const FILE_ID_RE = /^f_[0-9a-f]{16}$/;
// A relative CRM address only: no scheme, no host, no quote or angle bracket; // and .. are refused on top of this.
const LINK_URL_RE = /^\/crm\/[A-Za-z0-9._~\-/?=&%#+:@,;]*$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function httpError(status, message) { const e = new Error(message); e.status = status; return e; }
function normEmail(v) { return typeof v === 'string' ? v.trim().toLowerCase() : ''; }
function iso(ms) { return new Date(ms).toISOString(); }
function clone(v) { return JSON.parse(JSON.stringify(v)); }

function ymdValid(s) {
  const m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(s) : null;
  if (!m) return false;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
}

/* -- time in work ------------------------------------------------------------------------------ */

// The stretches [from, to] in ms during which the task was in_progress, read from the status events of its history. An open
// stretch ends at nowMs. Archiving stops a running stretch (a shelved task must not keep counting), restoring a task that is
// still in_progress starts the next one. Events without a usable date are skipped.
function workIntervals(task, nowMs) {
  const out = [];
  const history = task && Array.isArray(task.history) ? task.history : [];
  let open = null, status = 'todo';
  const close = at => { if (open !== null && at > open) out.push([open, at]); open = null; };
  for (const e of history) {
    const at = e ? Date.parse(e.at) : NaN;
    if (!Number.isFinite(at)) continue;
    if (e.type === 'status' && STATUSES.indexOf(e.to) !== -1) {
      status = e.to;
      if (e.to === 'in_progress') { if (open === null) open = at; } else close(at);
    } else if (e.type === 'archived') close(at);
    else if (e.type === 'restored' && status === 'in_progress' && open === null) open = at;
  }
  close(nowMs);
  return out;
}

// { email: ms } for every participant: the stretches above, each cut at the moment the person joined. Calendar time, no
// working hours; a task sent back from review and taken again keeps counting.
function workByPerson(task, nowMs) {
  const res = {};
  const participants = task && Array.isArray(task.participants) ? task.participants : [];
  if (!participants.length) return res;
  const intervals = workIntervals(task, nowMs);
  for (const p of participants) {
    if (!p || typeof p.email !== 'string') continue;
    const joined = Date.parse(p.joinedAt);
    let ms = 0;
    for (const [from, to] of intervals) {
      const start = Number.isFinite(joined) ? Math.max(from, joined) : from;
      if (to > start) ms += to - start;
    }
    res[p.email] = ms;
  }
  return res;
}

// The wall-clock time the task itself was in progress (people working in parallel are not added twice).
function inProgressMs(task, nowMs) {
  return workIntervals(task, nowMs).reduce((s, [a, b]) => s + (b - a), 0);
}

/* -- validation --------------------------------------------------------------------------------- */

function oneLine(s) { return s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim(); }
function block(s) { return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim(); }

function text(name, v, max, min, multiline) {
  if (typeof v !== 'string') throw httpError(400, name + ' must be text');
  const s = multiline ? block(v) : oneLine(v);
  if (s.length < min) throw httpError(400, name + ' is required');
  if (s.length > max) throw httpError(400, name + ' is too long (at most ' + max + ' characters)');
  return s;
}

function parseDue(v) {
  if (v === null || v === undefined || v === '') return null;
  if (!ymdValid(v)) throw httpError(400, 'due must be a real calendar day, YYYY-MM-DD');
  return v;
}

function parseLink(v) {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw httpError(400, 'link must be { label, url } or null');
  const url = typeof v.url === 'string' ? v.url : '';
  if (!url || url.length > MAX_URL || !LINK_URL_RE.test(url) || url.indexOf('//') !== -1 || url.indexOf('..') !== -1) {
    throw httpError(400, 'link.url must be a CRM address starting with /crm/');
  }
  const label = v.label === undefined || v.label === null ? '' : text('link.label', v.label, MAX_LABEL, 0, false);
  return { label: label || url.slice(0, MAX_LABEL), url };
}

function sameLink(a, b) { return (a ? a.label + '\n' + a.url : '') === (b ? b.label + '\n' + b.url : ''); }

function sniffType(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// What the client calls the file: for display only. Decoded, no control or bidi characters, no slashes, 100 characters.
function cleanFileName(raw, ext) {
  let s = '';
  if (typeof raw === 'string') { try { s = decodeURIComponent(raw); } catch (e) { s = ''; } }
  s = s.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩\\/]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 100).trim();
  return s || 'image.' + ext;
}

/* -- the module --------------------------------------------------------------------------------- */

module.exports = function crmTasks(opts) {
  const o = opts || {};
  if (typeof o.lockedUpdate !== 'function' || !o.DATA_DIR) throw new Error('crm-tasks.cjs needs { lockedUpdate, DATA_DIR, filesDir } from server_v14.cjs');
  if (!o.filesDir) throw new Error('crm-tasks.cjs needs filesDir (the folder of the pictures, outside DATA_DIR)');
  const lockedUpdate = o.lockedUpdate;
  const tasksPath = path.join(String(o.DATA_DIR), FILE);
  const usersPath = path.join(String(o.DATA_DIR), USERS_FILE);
  const filesDir = String(o.filesDir);
  const clock = typeof o.now === 'function' ? o.now : Date.now;

  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(body));
  }
  const ok = (res, status, body) => send(res, status, Object.assign({ ok: true }, body));

  function readList(file, label) {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT' && file === tasksPath) return [];
      throw httpError(503, label + ' cannot be read (' + ((e && e.code) || 'error') + '), restore it by hand before saving anything');
    }
    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { throw httpError(503, label + ' is not readable JSON, restore it by hand before saving anything'); }
    if (!Array.isArray(parsed)) throw httpError(503, label + ' is not a list, restore it by hand before saving anything');
    return parsed;
  }
  const loadAll = () => readList(tasksPath, FILE);
  const loadUsers = () => readList(usersPath, USERS_FILE)
    .filter(u => u && typeof u.email === 'string')
    .map(u => ({ email: normEmail(u.email), name: typeof u.name === 'string' ? u.name : '', admin: u.role === 'admin' }));
  // Admin is what users.json says now, the way requireAdmin of the server reads it (e-mail matched normalized, only the exact role
  // "admin" counts), not the role the session was opened with. Unreadable file = nobody is admin; the rights of a member go on.
  function isAdminNow(email) {
    try { const u = loadUsers().find(x => x.email === email); return !!(u && u.admin); } catch (e) { return false; }
  }

  function who(req) {
    const s = req.userSession;
    const email = normEmail(s && s.email);
    if (!email) return null;
    return { email, name: typeof s.name === 'string' ? s.name : '', admin: isAdminNow(email) };
  }
  const bodyOf = req => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  // verify = false: the caller checks the e-mails against users.json itself (checkKnown), on the task as it is in the queue.
  function parseAssignees(v, verify) {
    if (!Array.isArray(v)) throw httpError(400, 'assignees must be a list of e-mails');
    const out = [];
    for (const x of v) {
      const e = normEmail(x);
      if (!e) throw httpError(400, 'assignees must be a list of e-mails');
      if (out.indexOf(e) === -1) out.push(e);
    }
    if (out.length > MAX_ASSIGNEES) throw httpError(400, 'at most ' + MAX_ASSIGNEES + ' assignees');
    if (verify !== false) checkKnown(out);
    return out;
  }
  function checkKnown(emails) {
    if (!emails.length) return;
    const known = new Set(loadUsers().map(u => u.email));
    for (const e of emails) if (!known.has(e)) throw httpError(400, 'Unknown assignee: ' + e);
  }

  /* who may do what */
  const isAuthor = (task, email) => !!task.createdBy && task.createdBy.email === email;
  const isAssignee = (task, email) => (task.assignees || []).indexOf(email) !== -1;
  const isParticipant = (task, email) => (task.participants || []).some(p => p && p.email === email);
  function requireMember(task, me) {
    if (me.admin || isAuthor(task, me.email) || isAssignee(task, me.email) || isParticipant(task, me.email)) return;
    throw httpError(403, 'Join the task first');
  }
  function requireOpen(task) { if (task.archivedAt) throw httpError(409, 'The task is archived, restore it first'); }
  function requireAuthorOrAdmin(task, me) {
    if (!me.admin && !isAuthor(task, me.email)) throw httpError(403, 'Only the author or an admin can archive or restore a task');
  }

  const view = (task, nowMs, withHistory) => {
    const out = Object.assign({}, task);
    if (!withHistory) delete out.history;
    out.work = workByPerson(task, nowMs);
    out.workTotalMs = inProgressMs(task, nowMs);
    return out;
  };

  // One change of one task, made inside the queue on the file as it is now. fn(task, at) edits its private copy and returns false
  // when there is nothing to do (then nothing is written), or throws httpError (404/403/409..., the file stays untouched).
  async function mutate(id, me, what, fn) {
    let result = null;
    const r = await lockedUpdate(FILE, () => {
      const all = loadAll();
      const i = all.findIndex(t => t && t.id === id);
      if (i === -1) throw httpError(404, 'No such task');
      const task = clone(all[i]);
      const at = iso(clock());
      if (fn(task, at, all) === false) { result = all[i]; return null; }
      task.updatedAt = at;
      const next = all.slice();
      next[i] = task;
      result = task;
      return next;
    }, { action: 'update', user: me.email, details: id + ' ' + what });
    if (!r || !r.ok) throw httpError(500, 'Could not save the change');
    return result;
  }
  const reply = (res, task) => ok(res, 200, { task: view(task, clock(), true) });
  const note = (task, me, at, entry) => task.history.push(Object.assign({ at, by: me.email }, entry));

  /* routes */

  function list(req, res, me, query) {
    const nowMs = clock();
    const withArchived = query.get('archived') === '1';
    const tasks = loadAll().filter(t => t && (withArchived || !t.archivedAt)).map(t => view(t, nowMs, false));
    let people = [];
    try { people = loadUsers().map(u => ({ email: u.email, name: u.name })); } catch (e) { /* the list is still useful without the picker */ }
    ok(res, 200, { tasks, people, me: { email: me.email, name: me.name, role: me.admin ? 'admin' : 'staff' }, now: iso(nowMs) });
  }

  function detail(req, res, me, id) {
    const task = loadAll().find(t => t && t.id === id);
    if (!task) throw httpError(404, 'No such task');
    const nowMs = clock();
    ok(res, 200, { task: view(task, nowMs, true), work: workByPerson(task, nowMs), workTotalMs: inProgressMs(task, nowMs) });
  }

  async function create(req, res, me) {
    const b = bodyOf(req);
    const title = text('title', b.title, MAX_TITLE, 1, false);
    const description = b.description === undefined || b.description === null ? '' : text('description', b.description, MAX_DESCRIPTION, 0, true);
    const due = parseDue(b.due);
    const link = parseLink(b.link);
    const assignees = b.assignees === undefined || b.assignees === null ? [] : parseAssignees(b.assignees);
    let created = null;
    const r = await lockedUpdate(FILE, () => {
      const all = loadAll();
      let id;
      do { id = 't_' + crypto.randomBytes(6).toString('hex'); } while (all.some(t => t && t.id === id));
      const at = iso(clock());
      const task = { id, n: all.reduce((m, t) => Math.max(m, Number(t && t.n) || 0), 0) + 1, title, description, status: 'todo',
        createdBy: { email: me.email, name: me.name }, createdAt: at, updatedAt: at, doneAt: null, archivedAt: null,
        assignees, participants: [], due, link, files: [], history: [] };
      note(task, me, at, { type: 'created' });
      if (assignees.length) note(task, me, at, { type: 'assigned', added: assignees.slice(), removed: [] });
      created = task;
      return all.concat([task]);
    }, () => ({ action: 'create', user: me.email, details: created.id + ' created' }));
    if (!r || !r.ok) throw httpError(500, 'Could not save the task');
    ok(res, 201, { task: view(created, clock(), true) });
  }

  async function patch(req, res, me, id) {
    const b = bodyOf(req);
    const has = k => Object.prototype.hasOwnProperty.call(b, k);
    const want = {};
    if (has('title')) want.title = text('title', b.title, MAX_TITLE, 1, false);
    if (has('description')) want.description = text('description', b.description, MAX_DESCRIPTION, 0, true);
    if (has('due')) want.due = parseDue(b.due);
    if (has('link')) want.link = parseLink(b.link);
    if (has('assignees')) want.assignees = parseAssignees(b.assignees, false);
    if (!Object.keys(want).length) throw httpError(400, 'Nothing to change: send title, description, due, link or assignees');
    const task = await mutate(id, me, 'edit', (t, at) => {
      requireMember(t, me);
      requireOpen(t);
      const fields = [];
      for (const k of ['title', 'description', 'due']) if (k in want && want[k] !== t[k]) { t[k] = want[k]; fields.push(k); }
      if ('link' in want && !sameLink(want.link, t.link)) { t.link = want.link; fields.push('link'); }
      if (fields.length) note(t, me, at, { type: 'edited', fields });
      let assigned = false;
      if ('assignees' in want) {
        const added = want.assignees.filter(e => t.assignees.indexOf(e) === -1);
        checkKnown(added);       // someone already on the task stays even if users.json lost them; only newcomers must exist
        const removed = t.assignees.filter(e => want.assignees.indexOf(e) === -1);
        if (added.length || removed.length) { t.assignees = want.assignees; note(t, me, at, { type: 'assigned', added, removed }); assigned = true; }
      }
      if (!fields.length && !assigned) return false;
    });
    reply(res, task);
  }

  async function setStatus(req, res, me, id) {
    const status = bodyOf(req).status;
    if (STATUSES.indexOf(status) === -1) throw httpError(400, 'status must be one of ' + STATUSES.join(', '));
    const task = await mutate(id, me, 'status ' + status, (t, at) => {
      requireMember(t, me);
      requireOpen(t);
      if (t.status === status) return false;
      // Moving a task into work is taking it: an author or assignee who is not among the participants yet becomes one now.
      if (status === 'in_progress' && (isAuthor(t, me.email) || isAssignee(t, me.email)) && !isParticipant(t, me.email)) {
        t.participants.push({ email: me.email, joinedAt: at });
        note(t, me, at, { type: 'joined' });
      }
      note(t, me, at, { type: 'status', from: t.status, to: status });
      t.status = status;
      t.doneAt = status === 'done' ? at : null;
    });
    reply(res, task);
  }

  async function join(req, res, me, id) {
    const task = await mutate(id, me, 'join', (t, at) => {
      requireOpen(t);
      if (isParticipant(t, me.email)) return false;
      t.participants.push({ email: me.email, joinedAt: at });
      note(t, me, at, { type: 'joined' });
    });
    reply(res, task);
  }

  async function comment(req, res, me, id) {
    const body = text('text', bodyOf(req).text, MAX_COMMENT, 1, true);
    const task = await mutate(id, me, 'comment', (t, at) => { requireOpen(t); note(t, me, at, { type: 'comment', text: body }); });
    reply(res, task);
  }

  async function archive(req, res, me, id, restore) {
    const task = await mutate(id, me, restore ? 'restore' : 'archive', (t, at) => {
      requireAuthorOrAdmin(t, me);
      if (restore ? !t.archivedAt : !!t.archivedAt) return false;
      t.archivedAt = restore ? null : at;
      note(t, me, at, { type: restore ? 'restored' : 'archived' });
    });
    reply(res, task);
  }

  /* pictures */

  const TOO_BIG = 'The picture is larger than 900 KB';
  function readRaw(req) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers && req.headers['content-length']);
      if (Number.isFinite(declared) && declared > MAX_UPLOAD) return reject(httpError(413, TOO_BIG));
      const chunks = []; let size = 0, over = false;
      req.on('data', c => {
        size += c.length;
        if (over) return;                        // keep reading and drop the rest, so that the answer can still reach the client
        if (size > MAX_UPLOAD) { over = true; chunks.length = 0; reject(httpError(413, TOO_BIG)); } else chunks.push(c);
      });
      req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
      req.on('error', () => reject(httpError(400, 'The upload was interrupted')));
      req.on('close', () => reject(httpError(400, 'The upload was interrupted')));   // after resolve this is a no-op
    });
  }

  async function upload(req, res, me, id) {
    const first = loadAll().find(t => t && t.id === id);       // refuse before reading a body for a task that cannot take it
    if (!first) throw httpError(404, 'No such task');
    requireOpen(first);
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!TYPES[type]) throw httpError(415, 'Only png, jpeg and webp pictures can be attached');
    const buf = await readRaw(req);
    if (!buf.length) throw httpError(400, 'The picture is empty');
    if (sniffType(buf) !== type) throw httpError(415, 'The file is not the picture type it says it is');
    const ext = TYPES[type];
    const fileId = 'f_' + crypto.randomBytes(8).toString('hex');
    const record = { id: fileId, name: cleanFileName(req.headers['x-file-name'], ext), type, size: buf.length, by: me.email, at: iso(clock()) };
    const dir = path.join(filesDir, id);
    const onDisk = path.join(dir, fileId + '.' + ext);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(onDisk, buf, { flag: 'wx', mode: 0o600 });
    let task;
    try {
      task = await mutate(id, me, 'file ' + fileId, (t, at, all) => {
        requireOpen(t);
        if (t.files.length >= MAX_FILES_PER_TASK) throw httpError(409, 'A task can hold at most ' + MAX_FILES_PER_TASK + ' pictures');
        const used = all.reduce((s, x) => s + ((x && x.files) || []).reduce((a, f) => a + (Number(f && f.size) || 0), 0), 0);
        if (used + buf.length > MAX_TOTAL) throw httpError(507, 'The picture storage is full (200 MB in total), delete old pictures first');
        record.at = at;
        t.files.push(record);
        note(t, me, at, { type: 'file_added', fileId, name: record.name });
      });
    } catch (e) {
      try { fs.unlinkSync(onDisk); } catch (e2) { /* never written */ }
      throw e;
    }
    ok(res, 201, { task: view(task, clock(), true), file: record });
  }

  function serveFile(req, res, me, id, fileId) {
    const task = loadAll().find(t => t && t.id === id);
    const file = task && (task.files || []).find(f => f && f.id === fileId);
    if (!file || !TYPES[file.type]) throw httpError(404, 'No such file');
    let buf;
    try { buf = fs.readFileSync(path.join(filesDir, id, fileId + '.' + TYPES[file.type])); } catch (e) { throw httpError(404, 'No such file'); }
    res.statusCode = 200;
    res.setHeader('Content-Type', file.type);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Length', String(buf.length));
    res.end(buf);
  }

  async function removeFile(req, res, me, id, fileId) {
    let removed = null;
    const task = await mutate(id, me, 'file removed ' + fileId, (t, at) => {
      requireMember(t, me);
      requireOpen(t);
      const i = t.files.findIndex(f => f && f.id === fileId);
      if (i === -1) throw httpError(404, 'No such file');
      removed = t.files.splice(i, 1)[0];
      note(t, me, at, { type: 'file_removed', fileId, name: removed.name });
    });
    // After the record is gone: a crash in between leaves an unreferenced file, never a record without its bytes.
    try { fs.unlinkSync(path.join(filesDir, id, fileId + '.' + (TYPES[removed.type] || 'bin'))); } catch (e) { /* already gone */ }
    reply(res, task);
  }

  return function crmTasksHandler(req, res, next) {
    // The path is taken as it came: no dot-segment folding, so %2e%2e or .. is just a segment that matches nothing.
    const rawUrl = String(req.url || '/');
    const qi = rawUrl.indexOf('?');
    const query = new URLSearchParams(qi === -1 ? '' : rawUrl.slice(qi + 1));
    const rest = (qi === -1 ? rawUrl : rawUrl.slice(0, qi)).replace(/^\/+|\/+$/g, '');
    const parts = rest === '' ? [] : rest.split('/');
    const m = req.method;
    let run = null;
    if (parts.length === 0) {
      if (m === 'GET') run = me => list(req, res, me, query);
      else if (m === 'POST') run = me => create(req, res, me);
    } else if (ID_RE.test(parts[0])) {
      const id = parts[0];
      if (parts.length === 1) {
        if (m === 'GET') run = me => detail(req, res, me, id);
        else if (m === 'PATCH') run = me => patch(req, res, me, id);
      } else if (parts.length === 2 && m === 'POST') {
        const a = parts[1];
        if (a === 'status') run = me => setStatus(req, res, me, id);
        else if (a === 'join') run = me => join(req, res, me, id);
        else if (a === 'comments') run = me => comment(req, res, me, id);
        else if (a === 'files') run = me => upload(req, res, me, id);
        else if (a === 'archive' || a === 'restore') run = me => archive(req, res, me, id, a === 'restore');
      } else if (parts.length === 3 && parts[1] === 'files' && FILE_ID_RE.test(parts[2])) {
        if (m === 'GET') run = me => serveFile(req, res, me, id, parts[2]);
        else if (m === 'DELETE') run = me => removeFile(req, res, me, id, parts[2]);
      }
    }
    if (!run) return next();
    Promise.resolve().then(() => {
      const me = who(req);
      if (!me) throw httpError(401, 'Authentication required');
      return run(me);
    }).catch(e => {
      if (typeof req.resume === 'function') req.resume();     // an answer given before the body was read must not leave it hanging
      if (res.headersSent) return;
      const status = e && Number.isInteger(e.status) ? e.status : 500;
      if (status === 500) console.error('[crm-tasks]', e && e.message);
      send(res, status, { ok: false, error: status === 500 ? 'Internal error' : e.message });
    });
  };
};
module.exports.workByPerson = workByPerson;
module.exports.workIntervals = workIntervals;
module.exports.inProgressMs = inProgressMs;
module.exports.STATUSES = STATUSES;
