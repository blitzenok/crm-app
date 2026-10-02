/* Draft keeper of the CRM blog editor: autosave, the local backup, conflict, offline and "one writer per article".
   No DOM here: storage, channel, clock, timers and the save function are injected, so every rule is tested in Node.

   Why each rule exists (spec section 9):
   - The backup is written on EVERY change, before any request, so nothing typed is ever only in memory. It is removed only
     when the same content came back saved, never by time (a clean copy would keep the whole text in localStorage for
     nothing, and fill the quota). On open a dirty copy is offered whatever the clocks say: a laptop clock a day behind
     must not hide the author's text.
   - Autosave waits 1 s after the last edit, but never more than 10 s after the first unsaved one (steady typing is saved).
   - A save in flight does not block typing; the answer's rev is used for the next save, so the author never conflicts
     with himself.
   - 409 stops saving until the author chooses (resolveConflict). 401, network, 5xx, 408 and 429 are "offline": retries after
     5, 15 and then every 30 s; the copy stays. Any other 4xx (the server refused the content) is not retried blindly.
   - "Keep mine" overwrites someone else's text: the save that does it asks the server to keep the replaced text as a
     version first (opts.snapshotBefore), and keeps asking until one save has landed. Restoring a local copy that
     diverged from the server does the same (armSnapshot).
   - The same article open in a second tab of one browser: the newer tab is read-only (two tabs saving one article would
     fight over rev and the copy). The copy belongs to the other tab then: a read-only keeper never writes or removes it. */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BlogDraftKeeper = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  var RETRY_MS = [5000, 15000, 30000];
  var MAX_WAIT_MS = 10000;

  function createKeeper(o) {
    o = o || {};
    var delayMs = typeof o.delayMs === 'number' ? o.delayMs : 1000;   // the checklist follows the save: at 2 s a ticked item lingered noticeably
    var now = o.now || function () { return Date.now(); };
    var timers = o.timers || {
      setTimeout: function (f, ms) { return setTimeout(f, ms); },
      clearTimeout: function (id) { clearTimeout(id); },
    };
    var storage = o.storage || null;
    var channel = o.channel || null;
    var tabId = o.tabId || ('tab-' + Math.random().toString(36).slice(2));

    var id = null;
    var rev = 0;
    var payload = null;
    var seq = 0;                 // counts changes
    var savedSeq = 0;            // the change count whose content is known to be on the server
    var saving = false;
    var pendingFire = false;     // the debounce fired while a save was in flight
    var state = 'saved';
    var conflict = null;
    var lastErr = null;
    var readonlyReason = null;
    var debounceTimer = null;
    var retryTimer = null;
    var retryIdx = 0;
    var firstDirtyAt = 0;
    var openedAt = 0;
    var savedAtMs = 0;
    var authReported = false;
    var overwriting = false;     // "Keep mine" chosen and no save has landed since
    var backupOffReported = false;
    var waiters = [];
    var listeners = {};

    function on(event, cb) {
      (listeners[event] = listeners[event] || []).push(cb);
      return function () { listeners[event] = (listeners[event] || []).filter(function (f) { return f !== cb; }); };
    }
    function emit(event, arg) {
      (listeners[event] || []).slice().forEach(function (cb) { try { cb(arg); } catch (e) { /* a listener must not break saving */ } });
    }

    var isDirty = function () { return seq !== savedSeq; };
    var key = function () { return 'blog-draft:' + id; };

    function stateError(s) {
      var e = new Error('Not saved (' + s + ')');
      e.state = s;
      return e;
    }
    function settleWaiters() {
      if (!waiters.length) return;
      var list = waiters;
      if (state === 'saved') { waiters = []; list.forEach(function (w) { w.res(); }); }
      else if (state === 'conflict' || state === 'offline' || state === 'readonly') {
        waiters = [];
        list.forEach(function (w) { w.rej(stateError(state)); });
      }
    }
    function setState(s) {
      if (s === state) return;
      state = s;
      emit('state', s);
      settleWaiters();
    }

    function backupOff() {
      if (backupOffReported) return;
      backupOffReported = true;
      emit('backup_off');
    }
    function writeBackup(dirty, content) {
      if (readonlyReason) return;
      if (!storage) { backupOff(); return; }
      try {
        storage.setItem(key(), JSON.stringify({ baseRev: rev, payload: content, dirty: dirty, tabId: tabId, at: now() }));
      } catch (e) { backupOff(); }
    }
    function removeBackup() {
      if (readonlyReason || !storage || id === null) return;
      try { storage.removeItem(key()); } catch (e) { /* nothing to remove */ }
    }
    function readBackup() {
      if (!storage) { backupOff(); return null; }
      try {
        var raw = storage.getItem(key());
        if (!raw) return null;
        var b = JSON.parse(raw);
        if (!b || typeof b !== 'object' || !b.dirty || !b.payload || typeof b.payload !== 'object') return null;
        return b;
      } catch (e) { backupOff(); return null; }
    }

    function clearTimers() {
      if (debounceTimer !== null) { timers.clearTimeout(debounceTimer); debounceTimer = null; }
      if (retryTimer !== null) { timers.clearTimeout(retryTimer); retryTimer = null; }
    }
    function scheduleDebounce() {
      if (debounceTimer !== null) timers.clearTimeout(debounceTimer);
      var wait = Math.min(delayMs, Math.max(0, firstDirtyAt + MAX_WAIT_MS - now()));
      debounceTimer = timers.setTimeout(function () {
        debounceTimer = null;
        if (saving) pendingFire = true; else doSave();
      }, wait);
    }
    function scheduleRetry() {
      if (retryTimer !== null) timers.clearTimeout(retryTimer);
      var wait = RETRY_MS[Math.min(retryIdx, RETRY_MS.length - 1)];
      retryIdx++;
      retryTimer = timers.setTimeout(function () { retryTimer = null; doSave(); }, wait);
    }

    async function doSave() {
      if (saving || readonlyReason || state === 'conflict' || !isDirty()) return;
      clearTimers();
      pendingFire = false;
      saving = true;
      setState('saving');
      var sentSeq = seq;
      var sent = payload;
      var res;
      try {
        res = await o.save(sent, rev, overwriting ? { snapshotBefore: true } : undefined);
      } catch (e) {
        saving = false;
        onFail(e);
        return;
      }
      saving = false;
      rev = res && Number.isInteger(res.rev) ? res.rev : rev;
      lastErr = null;
      retryIdx = 0;
      authReported = false;
      savedAtMs = now();
      savedSeq = sentSeq;
      overwriting = false;
      if (!isDirty()) {
        firstDirtyAt = 0;
        removeBackup();
        setState('saved');
        return;
      }
      // Typing went on while the request was out: the copy gets the new baseRev, and the next save follows at once when a
      // flush is waiting or the debounce already fired, otherwise when the debounce does.
      writeBackup(true, payload);
      if (pendingFire || waiters.length) { pendingFire = false; doSave(); return; }
      setState('dirty');
    }

    function onFail(e) {
      pendingFire = false;
      lastErr = e;
      var status = e && typeof e.status === 'number' ? e.status : 0;
      if (status === 409) {
        overwriting = false;
        conflict = (e.body && e.body.current) || {};
        clearTimers();
        setState('conflict');
        emit('conflict', conflict);
        return;
      }
      if (status === 401) {
        setState('offline');
        if (!authReported) { authReported = true; emit('auth', e); }
        scheduleRetry();
        return;
      }
      if (status === 0 || status >= 500 || status === 408 || status === 429) {
        setState('offline');
        scheduleRetry();
        return;
      }
      setState('offline');
      emit('save_error', e);
    }

    function becomeReadonly() {
      readonlyReason = 'open_in_another_tab';
      clearTimers();
      setState('readonly');
    }
    function onMessage(ev) {
      var m = ev && ev.data;
      if (!m || m.id !== id || m.tabId === tabId) return;
      if (m.type === 'open') {
        if (!readonlyReason) channel.postMessage({ type: 'present', id: id, tabId: tabId, openedAt: openedAt });
      } else if (m.type === 'present') {
        if (m.openedAt < openedAt || (m.openedAt === openedAt && String(m.tabId) < String(tabId))) becomeReadonly();
      }
    }

    // opts.blocked: the editor could not open the stored text correctly (BlogEditor loadResult.ok === false) and shows an
    // empty document. Nothing may be saved over the real text and no backup may be written from the empty one, so this
    // keeper is read-only from the start (reason 'blocked'): no channel message, no copy read or written, no request.
    function open(articleId, serverRev, opts) {
      clearTimers();
      id = String(articleId);
      rev = serverRev;
      payload = null;
      seq = 0; savedSeq = 0; saving = false; pendingFire = false;
      conflict = null; lastErr = null; readonlyReason = null; retryIdx = 0; firstDirtyAt = 0; authReported = false; overwriting = false;
      state = 'saved';
      openedAt = now();
      if (opts && opts.blocked) {
        readonlyReason = 'blocked';
        setState('readonly');
        return { recoverable: null };
      }
      var b = readBackup();
      if (channel) {
        channel.onmessage = onMessage;
        try { channel.postMessage({ type: 'open', id: id, tabId: tabId, openedAt: openedAt }); } catch (e) { /* no second-tab guard */ }
      }
      if (!b) return { recoverable: null };
      return { recoverable: { payload: b.payload, at: b.at, baseRev: b.baseRev, diverged: b.baseRev !== serverRev } };
    }

    function change(p) {
      if (id === null || readonlyReason) return;
      if (!isDirty()) firstDirtyAt = now();
      payload = p;
      seq++;
      writeBackup(true, p);
      if (state === 'conflict') return;
      if (state === 'offline') {
        // Network/5xx/401: the retry timer is already running. A refusal (other 4xx) has none: the next edit tries again.
        if (retryTimer === null) scheduleDebounce();
        return;
      }
      if (!saving) setState('dirty');
      scheduleDebounce();
    }

    function flush() {
      if (readonlyReason) return Promise.reject(stateError('readonly'));
      if (state === 'conflict') return Promise.reject(stateError('conflict'));
      if (!isDirty() && !saving) return Promise.resolve();
      return new Promise(function (res, rej) {
        waiters.push({ res: res, rej: rej });
        if (!saving) doSave();
      });
    }

    function resolveConflict(choice, opts) {
      if (readonlyReason) return;
      opts = opts || {};
      var nextRev = Number.isInteger(opts.rev) ? opts.rev : (conflict && Number.isInteger(conflict.rev) ? conflict.rev : rev);
      if (choice === 'theirs') {
        rev = nextRev;
        if (opts.payload) payload = opts.payload;
        conflict = null; lastErr = null;
        clearTimers();
        savedSeq = seq;
        firstDirtyAt = 0;
        removeBackup();
        setState('saved');
        return;
      }
      rev = nextRev;
      conflict = null; lastErr = null;
      overwriting = true;
      state = 'dirty';           // quietly: doSave announces "saving" next
      emit('state', 'dirty');
      doSave();
    }

    // "Restore" of a local copy that diverged from the server: the text it puts back replaces what someone else saved
    // after the copy was made, so the next save asks the server for the safety version, like "Keep mine" does.
    function armSnapshot() {
      if (readonlyReason) return;
      overwriting = true;
    }

    // The server moved the article's rev by itself (publish, unpublish, schedule: they all bump it). Without this the next
    // autosave would conflict with the author's own action.
    function adoptRev(nextRev) {
      if (Number.isInteger(nextRev)) rev = nextRev;
    }
    // The page replaced the text with the server's version (restore from history): nothing is pending any more.
    function reset(nextRev, content) {
      if (readonlyReason) return;
      clearTimers();
      rev = nextRev;
      if (content) payload = content;
      savedSeq = seq; firstDirtyAt = 0; pendingFire = false; conflict = null; lastErr = null; retryIdx = 0;
      removeBackup();
      setState('saved');
    }

    return {
      open: open,
      adoptRev: adoptRev,
      armSnapshot: armSnapshot,
      reset: reset,
      change: change,
      flush: flush,
      state: function () { return state; },
      onState: function (cb) { return on('state', cb); },
      on: on,
      resolveConflict: resolveConflict,
      discardBackup: removeBackup,
      readOnlyReason: function () { return readonlyReason; },
      lastError: function () { return lastErr; },
      savedAt: function () { return savedAtMs; },
      rev: function () { return rev; },
      conflict: function () { return conflict; },
      close: function () { clearTimers(); if (channel) channel.onmessage = null; },
    };
  }

  return { createKeeper: createKeeper };
}));
