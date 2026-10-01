'use strict';
// mail-outbox.cjs — a queue in front of the four things products-api sends about an order: the manager letter, the
// customer letter, the order_placed event and the order_status_changed event. Until now each was one attempt with the
// result in the pm2 log only, so a provider that refused everything (Customer.io "Do Not Send", 403 since 27.09) went
// unnoticed. Here a failed effect is retried on a schedule for 48 hours and then written to a dead list with an alert
// line; a queue that is not draining also raises an alert. Loaded by products-api.cjs, which hands in the actual
// senders. Source of truth: services/mail-outbox/ in biofirst-hosting; install — deploy/INSTALL.md.
//
// The queue file holds no personal data: an item is {kind, ref, ...} and the letter or event is built from the order
// in orders.json at the moment of sending, so an order edited in CRM is sent as edited.

const crypto = require('crypto');

// letter_* (stage 1 RET, 30.09): the status letters of services/order-letters, one queue item per letter type and order. letter_rating (02.10,
// services/reviews) is the "How was your order?" letter, queued by an hourly pass of products-api some days after delivery.
// cio_order_delivered (services/cio-events, 30.09): the event the post-delivery journeys start on.
// tg_order / tg_paid (services/tg-alerts, 30.09): the team's Telegram alerts about a new order and a payment received.
// tg_contact (services/tg-alerts, 30.09): the Telegram line about a contact-form message; its ref is a message id in messages.json.
// letter_restock (services/restock, 30.09): "back in stock" letter; its ref is a subscription id, not an order ref — RECORD_KINDS are
// looked up with deps.findRecord(kind, ref) instead of in orders.json, and the record goes to send() where an order goes.
const KINDS = ['mail_manager', 'mail_customer', 'cio_order_placed', 'cio_order_status', 'letter_paid', 'letter_shipped', 'letter_in_transit', 'letter_delivered', 'cio_order_delivered', 'tg_order', 'tg_paid', 'tg_contact', 'letter_restock', 'letter_rating'];
const RECORD_KINDS = ['letter_restock', 'tg_contact'];
const RETRY_MIN = [1, 5, 15, 60, 180, 360];      // after the 1st, 2nd, ... failure; the last step repeats
const GIVE_UP_MS = 48 * 3600 * 1000;
const STUCK_AFTER_MS = 30 * 60 * 1000;
const STUCK_REPEAT_MS = 6 * 3600 * 1000;
const MAX_PER_TICK = 20;
const DEAD_KEEP = 200;
// A request the provider will never accept as it stands. Everything else that is not 2xx (401/403 = key or workspace
// switched off, 408/429/5xx, network, timeout) is worth waiting for.
const DEAD_HTTP = new Set([400, 404, 422]);

function retryable(status) {
  if (typeof status === 'number') return status === 401 || status === 403 || status === 408 || status === 429 || status >= 500;
  return status !== 'not_built';                   // no HTTP status at all: network, timeout, unreadable orders.json
}
// Log and file text: never an address (a client-supplied ref can look like one, so refs go through here too).
function safe(s, max) {
  return String(s === undefined || s === null ? '' : s).replace(/[^\s@,;]+@[^\s@,;]+/g, '<addr>').replace(/\s+/g, ' ').trim().slice(0, max || 120);
}
function fmtAge(ms) {
  const m = Math.floor(ms / 60000);
  return m < 120 ? m + 'm' : Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}
function iso(ms) { return new Date(ms).toISOString(); }
function same(a, kind, ref, data) {
  if (a.kind !== kind || a.ref !== ref) return false;
  return kind !== 'cio_order_status' || (a.data && a.data.status) === (data && data.status);
}
function valid(it) {
  return !!it && typeof it === 'object' && KINDS.includes(it.kind) && typeof it.ref === 'string' && it.ref && typeof it.id === 'string' &&
    Number.isFinite(Date.parse(it.createdAt)) && Number.isFinite(Date.parse(it.nextAt));
}

function createMailOutbox(deps) {
  const log = deps.log || ((s) => console.log(s));
  const logError = deps.logError || ((s) => console.error(s));
  const now = deps.now || Date.now;
  const sendTimeoutMs = Number(deps.sendTimeoutMs) > 0 ? Number(deps.sendTimeoutMs) : 30000;
  const inFlight = new Set();
  let running = false;
  let unreadable = false;
  let stuckAlertAt = 0;
  let timer = null, firstTimer = null;

  // null = the file cannot be read; it is never written over then (that would lose the queue), see the module header.
  function loadQueue() {
    let list;
    try {
      list = deps.readQueue();
      if (!Array.isArray(list)) throw new Error('not an array');
    } catch (e) {
      if (!unreadable) {
        unreadable = true;
        logError('[mail-alert] QUEUE UNREADABLE ' + safe((e && e.name) + ' ' + (e && e.message), 80) + ', nothing is sent from the queue until the file is fixed');
      }
      return null;
    }
    if (unreadable) { unreadable = false; log('[mail-outbox] queue readable again'); }
    return list;
  }
  function saveQueue(list) {
    try { deps.writeQueue(list); return true; }
    catch (e) { logError('[mail-alert] QUEUE WRITE FAILED ' + safe((e && e.message) || e, 80)); return false; }
  }

  function findOrder(ref, kind) {
    if (RECORD_KINDS.includes(kind)) {
      if (typeof deps.findRecord !== 'function') throw new Error('no record reader for ' + kind);
      return deps.findRecord(kind, ref) || null;
    }
    const orders = deps.readOrders();
    if (!Array.isArray(orders)) throw new Error('orders are not an array');
    return orders.find(o => o && o.ref === ref) || null;
  }

  // Take the item off the queue and into the dead list. The dead list is written first: a crash in between leaves
  // the item queued (it dies again next time) instead of losing it.
  function bury(list, idx, why) {
    const it = list[idx] || {};
    const rec = { kind: it.kind, ref: safe(it.ref, 64), createdAt: it.createdAt, diedAt: iso(now()), attempts: it.attempts || 0, lastStatus: it.lastStatus === undefined ? null : it.lastStatus, lastError: it.lastError || null };
    try {
      let dead;
      try { dead = deps.readDead(); if (!Array.isArray(dead)) throw new Error('not an array'); }
      catch (e) { dead = null; logError('[mail-alert] DEAD LIST UNREADABLE ' + safe((e && e.message) || e, 80) + ', not overwritten'); }
      if (dead) { dead.push(rec); deps.writeDead(dead.slice(-DEAD_KEEP)); }
    } catch (e) { logError('[mail-alert] DEAD LIST WRITE FAILED ' + safe((e && e.message) || e, 80)); }
    logError('[mail-alert] DEAD ' + safe(rec.kind) + ' ' + safe(rec.ref, 64) + ' after ' + rec.attempts + ' attempts: ' + safe(why || (rec.lastStatus !== null ? rec.lastStatus : '') + ' ' + (rec.lastError || ''), 70));
    list.splice(idx, 1);
  }

  // Record the result of one attempt. Re-reads the file: another attempt may have changed it while this one was out.
  function outcome(item, res) {
    const list = loadQueue();
    if (!list) return;
    const idx = list.findIndex(x => x && x.id === item.id);
    if (idx < 0) return;
    const it = list[idx];
    if (res.gone) {
      list.splice(idx, 1);
      log('[mail-outbox] dropped ' + it.kind + ' ' + safe(it.ref, 64) + ': order gone');
      saveQueue(list);
      return;
    }
    if (res.expired) {
      it.lastError = 'expired before send';
      bury(list, idx, 'expired before send');
      saveQueue(list);
      return;
    }
    if (res.ok) {
      if (it.attempts > 0) log('[mail-outbox] delivered ' + it.kind + ' ' + safe(it.ref, 64) + ' after ' + it.attempts + ' failed attempts');
      list.splice(idx, 1);
      saveQueue(list);
      return;
    }
    it.attempts = (it.attempts || 0) + 1;
    it.lastStatus = res.status === undefined ? null : res.status;
    it.lastError = safe(res.error) || null;
    const t = now();
    if (!retryable(res.status) || t - Date.parse(it.createdAt) >= GIVE_UP_MS) {
      bury(list, idx);
    } else {
      const wait = RETRY_MIN[Math.min(it.attempts - 1, RETRY_MIN.length - 1)];
      it.nextAt = iso(t + wait * 60000);
      log('[mail-outbox] retry ' + it.kind + ' ' + safe(it.ref, 64) + ' #' + it.attempts + ' status ' + safe(it.lastStatus !== null ? it.lastStatus : it.lastError, 60) + ', next in ' + wait + ' min');
    }
    saveQueue(list);
  }

  // One attempt. Resolves when the result is on file; never rejects.
  function attempt(item) {
    if (inFlight.has(item.id)) return Promise.resolve();
    inFlight.add(item.id);
    return new Promise(resolve => {
      let settled = false, watchdog = null;
      const settle = (res) => {
        if (settled) return;
        settled = true;
        clearTimeout(watchdog);
        inFlight.delete(item.id);
        try { outcome(item, res); } catch (e) { logError('[mail-outbox] ERROR recording ' + item.kind + ' ' + safe(item.ref, 64) + ': ' + safe((e && e.message) || e, 80)); }
        resolve();
      };
      // A letter that waited longer than the give-up window (the service was off, or the queue file sat idle) is stale:
      // "thanks for your order" a week later does more harm than none. It is buried unsent, not tried once more.
      if (now() - Date.parse(item.createdAt) >= GIVE_UP_MS) { settle({ expired: true }); return; }
      let order;
      try { order = findOrder(item.ref, item.kind); }
      catch (e) { settle({ ok: false, status: 'orders_unreadable', error: 'orders.json: ' + ((e && e.message) || e) }); return; }
      if (!order) { settle({ gone: true }); return; }
      // The senders time out on their own after 5 s; this only keeps a sender that never answers from blocking the queue.
      watchdog = setTimeout(() => settle({ ok: false, status: 'timeout', error: 'no answer in ' + sendTimeoutMs + ' ms' }), sendTimeoutMs);
      if (watchdog.unref) watchdog.unref();
      try {
        deps.send(item, order, r => settle({ ok: !!(r && r.ok), status: r ? r.status : undefined, error: r ? r.error : 'no result' }));
      } catch (e) { settle({ ok: false, status: 'send_threw', error: (e && e.message) || e }); }
    });
  }

  // The queue is unreadable or cannot be written: one attempt straight away, as before the queue existed.
  function direct(kind, ref, data) {
    logError('[mail-alert] ' + (unreadable ? 'QUEUE UNREADABLE' : 'QUEUE WRITE FAILED') + ', sent once without retry: ' + kind + ' ' + safe(ref, 64));
    let order;
    try { order = findOrder(ref, kind); } catch (e) { logError('[mail-alert] orders unreadable, not sent: ' + kind + ' ' + safe(ref, 64)); return; }
    if (!order) return;
    try {
      deps.send({ id: 'direct', kind, ref, data }, order, r => {
        if (!r || !r.ok) logError('[mail-outbox] direct ' + kind + ' ' + safe(ref, 64) + ' failed: ' + safe(r && (r.status !== undefined ? r.status : r.error), 60));
      });
    } catch (e) { logError('[mail-outbox] direct ' + kind + ' ' + safe(ref, 64) + ' threw'); }
  }

  // Never throws: it is called from request handlers, after the customer has been answered.
  function enqueue(kind, ref, data) {
    try {
      if (!KINDS.includes(kind) || typeof ref !== 'string' || !ref) { logError('[mail-outbox] ERROR bad enqueue ' + safe(kind, 30) + ' ' + safe(ref, 64)); return false; }
      const list = loadQueue();
      if (!list) { direct(kind, ref, data); return false; }
      if (list.some(x => valid(x) && same(x, kind, ref, data))) { log('[mail-outbox] duplicate ' + kind + ' ' + safe(ref, 64) + ' already queued'); return false; }
      const t = now();
      const item = { id: t.toString(36) + '-' + crypto.randomBytes(3).toString('hex'), kind, ref, createdAt: iso(t), attempts: 0, nextAt: iso(t), lastStatus: null, lastError: null };
      if (kind === 'cio_order_status') item.data = { status: safe(data && data.status, 40) };
      list.push(item);
      if (!saveQueue(list)) { direct(kind, ref, data); return false; }
      attempt(item);
      return true;
    } catch (e) {
      logError('[mail-outbox] ERROR enqueue ' + safe(kind, 30) + ' ' + safe(ref, 64) + ': ' + safe((e && e.message) || e, 80));
      return false;
    }
  }

  function checkStuck() {
    const list = loadQueue();
    if (!list) return;
    if (!list.length) {
      if (stuckAlertAt) { stuckAlertAt = 0; log('[mail-outbox] backlog cleared'); }
      return;
    }
    const t = now();
    let oldest = null;
    for (const it of list) {
      if (!it || !Number.isFinite(Date.parse(it.createdAt))) continue;
      if (!oldest || Date.parse(it.createdAt) < Date.parse(oldest.createdAt)) oldest = it;
    }
    if (!oldest) return;
    const age = t - Date.parse(oldest.createdAt);
    if (age <= STUCK_AFTER_MS) return;
    if (stuckAlertAt && t - stuckAlertAt < STUCK_REPEAT_MS) return;
    stuckAlertAt = t;
    logError('[mail-alert] STUCK ' + list.length + ' waiting, oldest ' + safe(oldest.kind, 30) + ' ' + safe(oldest.ref, 64) + ' ' + fmtAge(age) + ', last ' +
      safe(oldest.lastStatus !== null && oldest.lastStatus !== undefined ? oldest.lastStatus : (oldest.lastError || 'none'), 60));
  }

  // Due items, oldest first, one at a time, at most MAX_PER_TICK; a pass that is still running is not started twice.
  function tick() {
    if (running) return Promise.resolve();
    running = true;
    return (async () => {
      try {
        const list = loadQueue();
        if (!list) return;
        const t = now();
        const due = [];
        for (let i = list.length - 1; i >= 0; i--) {
          if (!valid(list[i])) { bury(list, i, 'malformed queue item'); saveQueue(list); }
        }
        for (const it of list) {
          if (!inFlight.has(it.id) && !(Date.parse(it.nextAt) > t)) due.push(it);
        }
        due.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        for (const it of due.slice(0, MAX_PER_TICK)) await attempt(it);
        checkStuck();
      } catch (e) {
        logError('[mail-outbox] ERROR tick failed: ' + safe((e && e.message) || e, 80));
      } finally { running = false; }
    })();
  }

  function start() {
    const every = Number(deps.intervalMs) > 0 ? Number(deps.intervalMs) : 60000;
    firstTimer = setTimeout(tick, Math.min(5000, every));
    timer = setInterval(tick, every);
    if (firstTimer.unref) firstTimer.unref();
    if (timer.unref) timer.unref();
    const list = loadQueue();
    log('[mail-outbox] on, every ' + every + ' ms' + (list ? ', ' + list.length + ' waiting' : ''));
  }
  function stop() { clearTimeout(firstTimer); clearInterval(timer); }

  return { enqueue, tick, start, stop };
}

module.exports = { createMailOutbox, KINDS, RECORD_KINDS, RETRY_MIN, GIVE_UP_MS, STUCK_AFTER_MS, STUCK_REPEAT_MS, MAX_PER_TICK, DEAD_KEEP, retryable };
