/**
 * BioLabs Research CRM: order letters (Customer.io transactional messages) on the Emails page.
 * Stage 1 RET, 2026-09-30. Lives next to marketing-emails.cjs and is loaded by it (deploy/patch-marketing-emails.cjs).
 *
 * The owner's rule: every letter a buyer gets is a Customer.io template that is edited from the CRM. Journey letters
 * already worked that way; this file adds the same for transactional messages:
 *     GET  /api/marketing/emails/transactional/:tid                          message + contents + saved versions + kind
 *     PUT  /api/marketing/emails/transactional/:tid/content/:cid             { subject_b64?, preheader_b64?, body_b64? }
 *     POST /api/marketing/emails/transactional/:tid/content/:cid/restore     { version }
 *     POST /api/marketing/emails/transactional/:tid/content/:cid/test        { subject_b64, body_b64 }  (to the signed-in user)
 * Same order as for journey letters: the live text is read and put in the version ring BEFORE it is written; rights are
 * the same as the journey PUT (any signed-in user, requireAuth in server_v14.cjs); every write is audited.
 *
 * Two kinds of transactional content live in Customer.io, and the routes above serve both (the address is the same, the
 * server finds out which it is):
 *   classic        PUT /v1/transactional/{id}/content/{content_id}. It "fully overwrites" the content, so the payload is the live
 *                  content as Customer.io returned it (minus id/created/updated and nulls) with our three fields replaced.
 *   design_studio  the new order letters are created by "Add content" in the Customer.io interface as Design Studio emails; the
 *                  classic PUT answers 400 "managed by Design Studio" for them. Route: PUT /v1/design_studio/emails/{uuid}
 *                  {content:{subject, preheader_text, html}} (204, a draft) and then POST .../publish (200); only the publish
 *                  makes the text visible in GET /v1/transactional/{id}/contents and puts it into letters. A save is both
 *                  calls as one action: when the publish fails the owner gets an error, not "saved", and the draft is put back.
 *                  The Design Studio email of a message is the one that has the same name as the message.
 *
 * The ring keeps only what the letter was BEFORE a save: the PUBLISHED text (what buyers got), so a restore brings that back. For a
 * Design Studio letter an unpublished draft that differs is not the letter: the editor shows the published text, GET says
 * draft_differs, a save or restore then needs publish_draft:true (409 without it), and the draft is kept aside in the ring entry
 * (raw.draft). The watchman (mail-chain-check) needs what WE wrote, so each successful write also records the sha of the three
 * texts (subject, preheader, body) as Customer.io serves them right after the write, in data/marketing-email-saved.json
 * (see recordSaved): read back, not what was sent, so a normalising API cannot cause a false alarm.
 * Letters are found by their number in /opt/crm-api/.env (CIO_ORDER_CUSTOMER_MSG_ID, CIO_LETTER_*_MSG_ID: what the shop sends to),
 * by name when no number matches (letterKey). One save at a time per letter (withLock).
 *
 * The guard against "the letter went out empty" (tx 3 did for two weeks, 2026-09-08..22, after a rewrite to fields the
 * server never sends): the letters of contract.md of stage 1 are known by the template name in Customer.io. Saving one of
 * them is refused (400) when its text reads a {{ trigger.X }} that the server does not put into message_data, contains the long dash,
 * a stop word, or leaves the subject/body empty. The field lists below are a COPY of the contract, on purpose:
 * products-api (orderMessageData / letter builder) is the other side of it, and a change of one side must be a visible
 * change of the other. A template not in the list is saved as it is, without any check.
 */
'use strict';

const crypto = require('crypto');

/* ── the contract: fields of message_data per letter ─────────────────────────────────────── */

const COMMON_FIELDS = ['ref', 'first_name', 'status', 'payment_state', 'paid_via', 'totals_available',
  'total_due_server', 'shipping_address', 'shipping_method'];
const ITEM_FIELDS = ['items', 'subtotal_server', 'shipping_server', 'discount_server', 'discount_pct_server', 'discount_source'];
const TRACK_FIELDS = ['carrier', 'tracking_number', 'tracking_url'];

// key = template name in Customer.io, after normalizeName().
const CONTRACT = {
  'order-customer': COMMON_FIELDS.concat(ITEM_FIELDS),        // confirmation, tx 3
  'order-paid': COMMON_FIELDS.slice(),
  'order-shipped': COMMON_FIELDS.concat(TRACK_FIELDS),
  'order-in-transit': COMMON_FIELDS.concat(TRACK_FIELDS),
  'order-delivered': COMMON_FIELDS.concat(TRACK_FIELDS)
};

function normalizeName(name) {
  return String(name === undefined || name === null ? '' : name).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

// The contract key of a template, or null for a template that is not in the contract.
function contractKey(name) {
  const k = normalizeName(name);
  return Object.prototype.hasOwnProperty.call(CONTRACT, k) ? k : null;
}

/* ── the check ───────────────────────────────────────────────────────────────────────────── */

// "Long dash" in any spelling that renders as one (built from the code point, so this file holds no such character).
// The plain hyphen and the en dash are fine.
const LONG_DASH = String.fromCharCode(0x2014);
const LONG_DASH_RE = new RegExp(LONG_DASH + '|&mdash;|&#0*8212;|&#x0*2014;', 'i');
// Stop words of contract.md: dosing and usage. Stems, so "dosage", "injection", "administered" are caught too.
const STOP_WORDS = [
  [/\bdos(?:e|es|ed|ing|age|ages)\b/i, 'dose'],
  [/\binject\w*/i, 'inject'],
  [/\badminister\w*/i, 'administer'],
  [/\bper\s+kg\b/i, 'per kg'],
  [/\bdaily\b/i, 'daily']
];

// Names read by Liquid tags: {{ trigger.x }} and {% ... trigger.x ... %}, also trigger["x"]. Text outside Liquid tags is
// not looked at (the word "trigger" in prose is not a variable). Returns [{ name, dynamic? }].
function triggerFields(text) {
  const out = [];
  const tags = String(text || '').match(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g) || [];
  for (const tag of tags) {
    let m;
    const dotted = /(?<![\w.])trigger\s*\.\s*([A-Za-z_][\w-]*)/g;
    while ((m = dotted.exec(tag))) out.push({ name: m[1] });
    const quoted = /(?<![\w.])trigger\s*\[\s*(['"])(.*?)\1\s*\]/g;
    while ((m = quoted.exec(tag))) out.push({ name: m[2] });
    if (/(?<![\w.])trigger\s*\[\s*(?!['"])/.test(tag)) out.push({ name: 'trigger[...]', dynamic: true });
    if (/(?<![\w.])trigger\b(?!\s*[.\[])/.test(tag)) out.push({ name: 'trigger', dynamic: true });
  }
  return out;
}

const PARTS = [['subject', 'subject'], ['preheader_text', 'preheader'], ['body', 'body']];

// texts = { subject, preheader_text, body } (strings). Returns
//   { unknown: [{ field, where }], empty: [where], style: [{ kind: 'dash'|'stop', word, where }] }
// For a key that is not in the contract everything is empty: nothing is checked.
function checkLetter(key, texts) {
  const res = { unknown: [], empty: [], style: [] };
  if (!key || !CONTRACT[key]) return res;
  const allowed = new Set(CONTRACT[key]);
  for (const [prop, where] of PARTS) {
    const text = typeof texts[prop] === 'string' ? texts[prop] : '';
    if ((prop === 'subject' || prop === 'body') && !text.trim()) res.empty.push(where);
    for (const f of triggerFields(text)) {
      if (f.dynamic || !allowed.has(f.name)) {
        if (!res.unknown.some(u => u.field === f.name && u.where === where)) res.unknown.push({ field: f.name, where });
      }
    }
    if (LONG_DASH_RE.test(text)) res.style.push({ kind: 'dash', word: LONG_DASH, where });
    for (const [re, word] of STOP_WORDS) if (re.test(text)) res.style.push({ kind: 'stop', word, where });
  }
  return res;
}

// The 400 message for a save/test. The name of the field comes first, as the brief asks.
function refusalMessage(key, r) {
  if (r.unknown.length) {
    const names = r.unknown.map(u => (u.field === 'trigger[...]' || u.field === 'trigger') ? u.field + ' (' + u.where + ')' : 'trigger.' + u.field + ' (' + u.where + ')').join(', ');
    return 'Unknown field in the letter: ' + names + '. The server does not send it, so the buyer would see a blank there. '
      + 'This letter (' + key + ') gets only: ' + CONTRACT[key].join(', ') + '. Nothing was saved.';
  }
  if (r.empty.length) {
    return 'The ' + r.empty.join(' and ') + ' of this letter is empty, so it would go out blank. Nothing was saved.';
  }
  const dash = r.style.find(s => s.kind === 'dash');
  if (dash) return 'The long dash (' + LONG_DASH + ') is in the ' + dash.where + '. Our letters do not use it: replace it with a comma, a colon or a plain hyphen. Nothing was saved.';
  const stop = r.style[0];
  return 'The word "' + stop.word + '" is in the ' + stop.where + '. Letters do not talk about dosing or use (stop words: dose, dosage, inject, administer, per kg, daily). Nothing was saved.';
}

/* ── sample data for the test letter: exactly the fields of the contract ─────────────────── */

const SAMPLE = {
  ref: 'TEST-0001', first_name: 'Alex', status: 'paid', payment_state: 'paid', paid_via: 'card',
  totals_available: true, total_due_server: '118.75',
  shipping_address: '123 Example Street, Springfield, IL 62701, US', shipping_method: 'Standard',
  items: [{ name: 'Sample product', mg: '5 mg', qty: 1, price: '99.00' }],
  subtotal_server: '99.00', shipping_server: '19.75', discount_server: '0.00', discount_pct_server: '0', discount_source: '',
  carrier: 'FedEx', tracking_number: '123456789012', tracking_url: 'https://www.fedex.com/fedextrack/?trknbr=123456789012'
};

function sampleData(key) {
  if (!key || !CONTRACT[key]) return {};
  const out = {};
  for (const f of CONTRACT[key]) out[f] = JSON.parse(JSON.stringify(SAMPLE[f]));
  return out;
}

/* ── which letter is which ───────────────────────────────────────────────────────────────── */

// The number of each letter's template in /opt/crm-api/.env: what products-api really sends to. blitz-api loads the same
// .env at start, so the numbers are in process.env here (read at call time).
const ENV_IDS = {
  'order-customer': 'CIO_ORDER_CUSTOMER_MSG_ID', 'order-paid': 'CIO_LETTER_PAID_MSG_ID', 'order-shipped': 'CIO_LETTER_SHIPPED_MSG_ID',
  'order-in-transit': 'CIO_LETTER_IN_TRANSIT_MSG_ID', 'order-delivered': 'CIO_LETTER_DELIVERED_MSG_ID'
};
const envId = key => String(process.env[ENV_IDS[key]] || '').trim();

// "Send test to me" recipient (2026-09-30): the owner's CRM account address is a mailbox that no longer exists, so a test sent
// to the session address went nowhere. EMAIL_TEST_TO (comma list, /opt/crm-api/.env) names where tests go: the first valid
// address wins. It comes from the server only, so the page still cannot choose the recipient. Unset: the signed-in address.
const TEST_EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/;
function testRecipient(sessionEmail) {
  const fromEnv = String(process.env.EMAIL_TEST_TO || '').split(',').map(a => a.trim().toLowerCase()).find(a => TEST_EMAIL_RE.test(a));
  return fromEnv || String(sessionEmail || '').trim().toLowerCase();
}

// The contract key of a message: by its number in .env first (that is the template the shop sends to), by its name when no
// number matches. null = not one of the order letters.
function letterKey(message) {
  const id = message && message.id !== undefined && message.id !== null ? String(message.id) : '';
  if (id) for (const k of Object.keys(ENV_IDS)) if (envId(k) === id) return k;
  return contractKey(message && message.name);
}

// Things worth telling the owner about how a template and .env fit together. The letter is still checked either way.
function letterWarnings(message) {
  const out = [];
  const id = message && message.id !== undefined && message.id !== null ? String(message.id) : '';
  const name = message && typeof message.name === 'string' ? message.name : '';
  const idKey = id ? Object.keys(ENV_IDS).find(k => envId(k) === id) || null : null;
  const nameKey = contractKey(name);
  if (idKey && nameKey !== idKey) out.push('This template is the "' + idKey + '" letter (its number is in .env as ' + ENV_IDS[idKey] + ') but it is named "' + name + '". Rename it in Customer.io so that the name and the number agree.');
  if (nameKey && !idKey) {
    if (!envId(nameKey)) out.push('The number of the "' + nameKey + '" letter (' + ENV_IDS[nameKey] + ') is not in .env: the CRM found this template by its name only.');
    else out.push('This template is named "' + nameKey + '" but the shop sends that letter through template ' + envId(nameKey) + ' (' + ENV_IDS[nameKey] + ' in .env), not this one.');
  }
  return out;
}

/* ── the request to Customer.io ──────────────────────────────────────────────────────────── */

// Classic: the read-only parts of a content are dropped and so are nulls (from_id, reply_to_id: "the default sender", which
// the empty from / reply_to strings already say). Everything else goes back as it came, because the PUT overwrites.
const READ_ONLY = new Set(['id', 'created', 'updated']);
function contentPayload(live, next) {
  const p = {};
  for (const [k, v] of Object.entries(live || {})) {
    if (READ_ONLY.has(k) || v === null || v === undefined) continue;
    p[k] = v;
  }
  return Object.assign(p, next);
}

// A plain-text alternative made from the html (Design Studio keeps one next to it); tags out, entities decoded. The same
// function as services/order-letters/deploy/push-templates.cjs, so a letter saved here and a letter pushed there get the same text part.
function htmlToText(html) {
  return String(html)
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (m, href, label) => label.replace(/<[^>]*>/g, '') + ' (' + href + ')')
    .replace(/<\/(p|h2|tr|div)>|<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '  ')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{3,}/g, '  ').trim() + '\n';
}

// Design Studio: the body of the PUT. t.text (the plain-text part) is sent when given.
const dsPayload = t => {
  const content = { subject: t.subject, preheader_text: t.preheader_text, html: t.body };
  if (typeof t.text === 'string') content.text = t.text;
  return { content };
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const sha16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
// What the watchman compares: subject, preheader and body together (mail-chain-check/check.cjs computes the same).
const contentSha = (subject, preheader, body) => sha16([subject, preheader, body].join('\u0000'));
const SAVED_FILE = 'marketing-email-saved.json';
const txKey = (tid, cid) => 'tx:' + tid + ':' + cid;

/* ── routes ──────────────────────────────────────────────────────────────────────────────── */

// ctx is what marketing-emails.cjs already has: the transport, the ring, the readers. Nothing here talks to Customer.io
// in any other way than it does.
function mount(router, ctx) {
  const { httpError, fail, readId, readLineB64, readBody, requireAppKeys, cioRequest, appAuth, appResult, asArray,
    pushVersion, tryRing, versionsFor, invalidateList, writeAuditLog, lockedUpdate, authUtils, mask } = ctx;
  const str = v => (typeof v === 'string' ? v : '');
  const app = (subPath, opts) => cioRequest(ctx.APP_URL, subPath, Object.assign({ auth: appAuth() }, opts));

  // One save or restore at a time per letter (in memory: blitz-api is a single process). Two at once would both read the
  // same live text and the second would overwrite the first without it ever reaching the ring.
  const locks = new Map();
  function withLock(key, fn) {
    const run = (locks.get(key) || Promise.resolve()).then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  }

  /* reading */

  async function loadMessage(tid) {
    const r = await app('/v1/transactional', { logTag: 'GET /v1/transactional' });
    const list = asArray(appResult(r, 'the transactional message list'), 'messages', 'transactional_messages', 'data');
    if (!list) throw new ctx.Upstream('Customer.io answered the transactional list in a shape this panel does not understand');
    const m = list.find(x => x && String(x.id) === tid);
    if (!m) throw httpError(404, 'No such transactional message');
    return m;
  }

  // What is published now: the contents of the message, classic and Design Studio alike.
  async function loadContents(tid) {
    const r = await app('/v1/transactional/' + tid + '/contents', { logTag: 'GET /v1/transactional/' + tid + '/contents' });
    const data = appResult(r, 'the contents of transactional message ' + tid, { allow404: true });
    if (data === null) throw httpError(404, 'No such transactional message');
    const list = asArray(data, 'contents', 'data');
    if (!list) throw new ctx.Upstream('Customer.io answered the message contents in a shape this panel does not understand');
    return list;
  }

  // The three texts of one content as they are live now.
  async function readPublished(tid, cid) {
    const c = (await loadContents(tid)).find(x => x && String(x.id) === cid);
    if (!c) throw httpError(404, 'No such content in this message');
    return { subject: str(c.subject), preheader_text: str(c.preheader_text), body: str(c.body) };
  }
  const sameTexts = (a, b) => !!a && !!b && a.subject === b.subject && a.preheader_text === b.preheader_text && a.body === b.body;

  // The Design Studio email of a message: the one with the same name. null = there is none, the message is classic.
  async function findDesignStudioEmail(name) {
    const r = await app('/v1/design_studio/emails', { logTag: 'GET /v1/design_studio/emails' });
    const data = appResult(r, 'the Design Studio email list', { allow404: true });
    const list = data === null ? [] : (asArray(data, 'emails', 'data') || []);
    const want = normalizeName(name);
    const hits = list.filter(e => e && typeof e.name === 'string' && normalizeName(e.name) === want && UUID_RE.test(String(e.id)));
    if (hits.length > 1) throw httpError(409, 'More than one Design Studio email is named "' + name + '"; the CRM cannot tell which one is this letter. Rename the extra one in Customer.io.');
    return hits.length ? { id: String(hits[0].id), name: hits[0].name } : null;
  }

  // The draft of a Design Studio email: what its editor shows and what a publish would put live.
  async function readDesignStudio(dsId) {
    const r = await app('/v1/design_studio/emails/' + dsId, { logTag: 'GET /v1/design_studio/emails/{id}' });
    const data = appResult(r, 'the Design Studio email', { allow404: true });
    if (data === null) throw httpError(404, 'The Design Studio email of this letter is gone');
    const e = data && data.email;
    const c = e && e.content;
    if (!c || typeof c !== 'object') throw new ctx.Upstream('Customer.io answered the Design Studio email in a shape this panel does not understand');
    return { subject: str(c.subject), preheader_text: str(c.preheader_text), html: str(c.html), text: str(c.text), linked: e.is_linked === true };
  }

  const NOT_LINKED = 'This Design Studio email is not linked to a transactional message, so publishing it would not change any letter. Link it in Customer.io first.';

  // The message, the kind of its content, and the letter as it is right now (the PUBLISHED text: what buyers get) in the
  // shape the ring and the editor use. A classic live content is that object itself. For Design Studio the draft is kept
  // apart: `draft` is what the email holds now, draftDiffers says a person changed it without publishing.
  async function loadOne(tid, cid) {
    const message = await loadMessage(tid);
    const contents = await loadContents(tid);
    const key = letterKey(message);
    const ds = await findDesignStudioEmail(message.name);
    if (!ds) {
      const live = contents.find(c => c && String(c.id) === cid);
      if (!live) throw httpError(404, 'No such content in this message');
      return { message, key, kind: 'classic', live, ds: null, contents };
    }
    if (contents.length !== 1) throw httpError(409, 'This is a Design Studio letter with ' + contents.length + ' contents; the CRM edits a Design Studio letter only when it has exactly one.');
    const pub = contents[0];
    if (String(pub.id) !== cid) throw httpError(404, 'No such content in this message');
    const draft = await readDesignStudio(ds.id);
    if (!draft.linked) throw httpError(409, NOT_LINKED);
    const live = {
      id: pub.id, name: str(pub.name), language: str(pub.language), updated: typeof pub.updated === 'number' ? pub.updated : null,
      subject: str(pub.subject), preheader_text: str(pub.preheader_text), body: str(pub.body), body_plain: str(pub.body_plain),
      design_studio_email_id: ds.id
    };
    const draftDiffers = draft.subject !== live.subject || draft.preheader_text !== live.preheader_text || draft.html !== live.body;
    if (draftDiffers) live.draft = { subject: draft.subject, preheader_text: draft.preheader_text, html: draft.html, text: draft.text };   // kept in the ring, aside
    return { message, key, kind: 'design_studio', live, ds, draft, draftDiffers, contents };
  }

  function summary(c, versions, kind) {
    return {
      id: String(c.id), name: str(c.name), language: str(c.language), kind,
      subject: str(c.subject), preheader_text: str(c.preheader_text), body: str(c.body),
      body_bytes: Buffer.byteLength(str(c.body), 'utf8'),
      updated: typeof c.updated === 'number' ? c.updated : null,
      versions: versions.slice().reverse().map(v => ({ version: v.version, saved_at: v.saved_at, saved_by: v.saved_by, source: v.source, subject: v.subject, bytes: v.bytes }))
    };
  }

  /* writing */

  // Puts `next` live and returns the three texts as Customer.io serves them afterwards (what the ledger must hold).
  async function writeLetter(tid, cid, loaded, next, what) {
    const { live, kind, ds, message } = loaded;
    const readBack = async () => {
      try { return await readPublished(tid, cid); } catch (e) { /* the ledger then holds what we sent */ }
      console.error('[marketing-emails] could not read tx ' + tid + ' back after the write; the ledger holds the texts we sent');
      return { subject: next.subject, preheader_text: next.preheader_text, body: next.body };
    };
    if (kind === 'classic') {
      try {
        appResult(await app('/v1/transactional/' + tid + '/content/' + cid, {
          method: 'PUT', payload: contentPayload(live, next), logTag: 'PUT /v1/transactional/' + tid + '/content/' + cid + (what === 'restore' ? ' (restore)' : '')
        }), 'the ' + (what === 'restore' ? 'restore' : 'change') + ' of this letter');
      } catch (e) {
        if (e && e.status === 400 && /design studio/i.test(e.message || '')) {
          throw httpError(409, 'Customer.io says this letter is managed by Design Studio, but no Design Studio email named "' + str(message.name) + '" was found, so the CRM cannot save it. Nothing was saved.');
        }
        throw e;
      }
      return readBack();
    }
    // Design Studio: draft, then publish. The two are one action for the owner.
    const dsUrl = '/v1/design_studio/emails/' + ds.id;
    const d = loaded.draft;
    const putBack = async () => {
      try {
        appResult(await app(dsUrl, { method: 'PUT', payload: dsPayload({ subject: d.subject, preheader_text: d.preheader_text, body: d.html, text: d.text }), logTag: 'PUT /v1/design_studio/emails/{id} (put the draft back)' }), 'putting the draft back');
        return true;
      } catch (e2) { return false; }
    };
    const backNote = back => (back ? 'The Design Studio draft was put back as it was. ' : 'The draft in Design Studio could NOT be put back: check that email in Design Studio. ');
    try {
      appResult(await app(dsUrl, { method: 'PUT', payload: dsPayload({ subject: next.subject, preheader_text: next.preheader_text, body: next.body, text: htmlToText(next.body) }), logTag: 'PUT /v1/design_studio/emails/{id}' }), 'the change to this Design Studio letter');
    } catch (e) {
      if (e && e.status >= 400 && e.status < 500) throw e;                 // refused: the draft was not touched
      const back = await putBack();                                        // no answer or 5xx: it may have been applied
      throw httpError(500, 'Design Studio did not confirm the change (' + String((e && e.message) || 'error').slice(0, 200) + '). ' + backNote(back) + 'Nothing was saved.');
    }
    let published = null, failure = null;
    try {
      published = appResult(await app(dsUrl + '/publish', { method: 'POST', payload: {}, logTag: 'POST /v1/design_studio/emails/{id}/publish' }), 'the publish of this Design Studio letter');
      if (published && typeof published === 'object' && published.status && published.status !== 'done') throw new Error('the publish ended as "' + String(published.status).slice(0, 40) + '"');
    } catch (e) { failure = e; }
    if (failure) {
      // An answer of 5xx or none does not say the publish did not happen: look at what is live before saying anything.
      let now = null;
      try { now = await readPublished(tid, cid); } catch (e) { /* said below */ }
      if (sameTexts(now, next)) {
        console.error('[marketing-emails] publish of Design Studio letter tx ' + tid + ' answered with an error (' + ((failure && failure.message) || 'error') + ') but the letter is live');
        return now;
      }
      const back = await putBack();
      console.error('[marketing-emails] publish of Design Studio letter tx ' + tid + ' failed: ' + ((failure && failure.message) || 'error') + '; draft put back: ' + back);
      throw httpError(500, 'The text reached Design Studio but publishing it failed (' + String((failure && failure.message) || 'error').slice(0, 200) + '), so buyers still get the previous letter'
        + (now ? '. ' : ' (the CRM could not check what is live). ') + backNote(back) + 'Nothing was saved.');
    }
    // The publish says which message content it wrote to. An answer that names none, or other contents than ours, cannot be
    // trusted: the text may be live in the wrong letter, which cannot be undone from here. Reported, not recorded as saved.
    const mapped = published && Array.isArray(published.mappings) ? published.mappings.map(x => x && String(x.template_id)).filter(Boolean) : [];
    if (!mapped.includes(cid)) {
      console.error('[marketing-emails] publish of the Design Studio email of tx ' + tid + ' mapped to content ' + (mapped.join(',') || 'nothing') + ', expected ' + cid);
      throw httpError(500, 'Design Studio did not say it published this text into content ' + cid + ' (it named: ' + (mapped.join(', ') || 'nothing') + '). Check the letters in Customer.io before anything else. Nothing was recorded as saved.');
    }
    return readBack();
  }

  // What we wrote, for the watchman. The letter is already changed in Customer.io by now, so a failure here must not
  // turn the save into an error: it is logged, and the watchman then says loudly that the letter changed "outside the CRM".
  async function recordSaved(tid, cid, name, texts, user, source) {
    try {
      const key = txKey(tid, cid);
      const entry = { key, tid, content_id: cid, name: str(name), sha16: contentSha(texts.subject, texts.preheader_text, texts.body), saved_at: new Date().toISOString(), saved_by: user, source };
      const r = await lockedUpdate(SAVED_FILE, list => list.filter(x => x && x.key !== key).concat([entry]));
      if (!r || !r.ok) throw new Error('write refused');
    } catch (e) {
      console.error('[marketing-emails] saved-sha ledger not written for ' + txKey(tid, cid) + ': ' + ((e && e.message) || 'error'));
    }
  }

  function refuse(key, texts) {
    const r = checkLetter(key, texts);
    if (r.unknown.length || r.empty.length || r.style.length) throw httpError(400, refusalMessage(key, r));
  }

  // A person changed the Design Studio email without publishing. Saving from here replaces that draft, so it needs a yes.
  function needDraftConsent(loaded, src) {
    if (loaded.kind === 'design_studio' && loaded.draftDiffers && src.publish_draft !== true) {
      throw httpError(409, 'Design Studio holds an unpublished draft of this letter that differs from what buyers get (someone edited it in Design Studio and did not publish). '
        + 'Saving from the CRM replaces that draft: open the letter again and confirm, or publish or discard the draft in Design Studio first. Nothing was saved.');
    }
  }

  /* routes */

  router.get('/transactional/:tid', async (req, res) => {
    try {
      requireAppKeys();
      const tid = readId(req.params.tid, 'message id');
      const message = await loadMessage(tid);
      const contents = await loadContents(tid);
      const key = letterKey(message);
      const ds = await findDesignStudioEmail(message.name);
      const ring = tryRing();
      const shown = contents.filter(c => c && c.id !== undefined);
      let editable = true, reason = '', draftDiffers = false;
      if (ds) {
        if (shown.length !== 1) { editable = false; reason = 'This Design Studio letter has more than one content; edit it in Customer.io.'; }
        else {
          const d = await readDesignStudio(ds.id);                 // the editor shows what buyers get; the draft only raises a flag
          if (!d.linked) { editable = false; reason = NOT_LINKED; }
          draftDiffers = d.subject !== str(shown[0].subject) || d.preheader_text !== str(shown[0].preheader_text) || d.html !== str(shown[0].body);
        }
      }
      res.json({
        message: { id: String(message.id), name: str(message.name) },
        kind: ds ? 'design_studio' : 'classic',
        editable, reason, draft_differs: draftDiffers,
        checked: key !== null,
        template: key,
        fields: key ? CONTRACT[key].slice() : null,
        warnings: letterWarnings(message),
        contents: shown.map(c => summary(c, versionsFor(ring, txKey(tid, String(c.id))), ds ? 'design_studio' : 'classic')),
        fetched_at: new Date().toISOString()
      });
    } catch (e) { fail(res, e, 'GET transactional'); }
  });

  router.put('/transactional/:tid/content/:cid', async (req, res) => {
    try {
      requireAppKeys();
      const tid = readId(req.params.tid, 'message id'), cid = readId(req.params.cid, 'content id');
      const src = (req.body && typeof req.body === 'object') ? req.body : {};
      const subject = readLineB64(src, 'subject', 'subject_b64', ctx.MAX_SUBJECT);
      const preheader = readLineB64(src, 'preheader_text', 'preheader_b64', ctx.MAX_PREHEADER);
      const body = readBody(src);
      if (subject === undefined && preheader === undefined && body === undefined) {
        throw httpError(400, 'Nothing to save: send subject_b64, preheader_b64 or body_b64');
      }
      await withLock(txKey(tid, cid), async () => {
        const loaded = await loadOne(tid, cid);
        const { message, live, key, kind } = loaded;
        const next = {
          subject: subject === undefined ? str(live.subject) : subject,
          preheader_text: preheader === undefined ? str(live.preheader_text) : preheader,
          body: body === undefined ? str(live.body) : body
        };
        const same = next.subject === str(live.subject) && next.preheader_text === str(live.preheader_text) && next.body === str(live.body);
        if (same) return res.json({ ok: true, unchanged: true, content: summary(live, versionsFor(tryRing(), txKey(tid, cid)), kind) });

        refuse(key, next);                                       // before anything is kept or written
        needDraftConsent(loaded, src);

        const user = (req.userSession && req.userSession.email) || 'system';
        const version = await pushVersion(txKey(tid, cid), live, user, 'pre-save');
        const after = await writeLetter(tid, cid, loaded, next, 'save');
        invalidateList();
        await recordSaved(tid, cid, message.name, after, user, 'save');
        writeAuditLog('marketing_emails', 'tx_email_updated', user,
          'transactional ' + tid + ' content ' + cid + ' (' + str(message.name) + ', ' + kind + '): subject ' + next.subject.length + ' chars, body ' + Buffer.byteLength(next.body, 'utf8') + ' bytes; previous kept as v' + version,
          req.ip);
        res.json({ ok: true, kind, saved_version: version, content: summary(Object.assign({}, live, next), versionsFor(tryRing(), txKey(tid, cid)), kind) });
      });
    } catch (e) { fail(res, e, 'PUT transactional'); }
  });

  // A restore is a way back, so the style rules (dash, stop words) only warn here; an unknown field or an empty
  // letter still stops it, because that is the letter that goes out blank.
  router.post('/transactional/:tid/content/:cid/restore', async (req, res) => {
    try {
      requireAppKeys();
      const tid = readId(req.params.tid, 'message id'), cid = readId(req.params.cid, 'content id');
      const src = (req.body && typeof req.body === 'object') ? req.body : {};
      const wanted = Number(src.version);
      if (!Number.isInteger(wanted) || wanted < 1) throw httpError(400, 'version must be a whole number');
      await withLock(txKey(tid, cid), async () => {
        const k = txKey(tid, cid);
        const stored = versionsFor(tryRing(), k).find(v => v.version === wanted);
        if (!stored) throw httpError(404, 'Version ' + wanted + ' is not in the history of this letter');

        const loaded = await loadOne(tid, cid);
        const { message, live, key, kind } = loaded;
        const next = { subject: stored.subject || '', preheader_text: stored.preheader_text || '', body: stored.body || '' };
        const check = checkLetter(key, next);
        if (check.unknown.length || check.empty.length) throw httpError(400, refusalMessage(key, { unknown: check.unknown, empty: check.empty, style: [] }));
        const warnings = check.style.map(s => (s.kind === 'dash' ? 'long dash' : 'word "' + s.word + '"') + ' in the ' + s.where);
        needDraftConsent(loaded, src);

        const user = (req.userSession && req.userSession.email) || 'system';
        const version = await pushVersion(k, live, user, 'pre-restore');
        const after = await writeLetter(tid, cid, loaded, next, 'restore');
        invalidateList();
        await recordSaved(tid, cid, message.name, after, user, 'restore');
        writeAuditLog('marketing_emails', 'tx_email_restored', user,
          'transactional ' + tid + ' content ' + cid + ' (' + str(message.name) + ', ' + kind + '): restored v' + wanted + '; previous kept as v' + version, req.ip);
        res.json({ ok: true, kind, restored_version: wanted, saved_version: version, warnings, content: summary(Object.assign({}, live, next), versionsFor(tryRing(), k), kind) });
      });
    } catch (e) { fail(res, e, 'restore transactional'); }
  });

  // The text in the editor (saved or not) goes to the signed-in user through the inline send, rendered with sample data
  // of exactly the fields this letter gets in real life. The recipient comes from the session and cannot be chosen.
  router.post('/transactional/:tid/content/:cid/test', async (req, res) => {
    try {
      requireAppKeys();
      const tid = readId(req.params.tid, 'message id'), cid = readId(req.params.cid, 'content id');
      const src = (req.body && typeof req.body === 'object') ? req.body : {};
      const subject = readLineB64(src, 'subject', 'subject_b64', ctx.MAX_SUBJECT);
      const body = readBody(src);
      if (!subject || !body) throw httpError(400, 'subject_b64 and body_b64 are both required for a test letter');
      const message = await loadMessage(tid);
      if (!(await loadContents(tid)).some(c => c && String(c.id) === cid)) throw httpError(404, 'No such content in this message');
      const key = letterKey(message);
      refuse(key, { subject, preheader_text: '', body });
      const to = authUtils.normalizeEmail(testRecipient(req.userSession && req.userSession.email));
      if (!authUtils.isValidEmail(to)) throw httpError(400, 'Your account has no usable e-mail address');
      const r = await app('/v1/send/email', {
        method: 'POST',
        payload: { to, identifiers: { email: to }, from: ctx.TEST_FROM, subject, body, message_data: sampleData(key) },
        logTag: 'POST /v1/send/email (tx ' + tid + ' test to ' + mask(to) + ')'
      });
      const data = appResult(r, 'the test letter');
      const deliveryId = data && (data.delivery_id || data.deliveryId || (data.meta && data.meta.delivery_id)) || null;
      writeAuditLog('marketing_emails', 'tx_test_email_sent', to, 'transactional ' + tid + ' (' + str(message.name) + '), delivery ' + (deliveryId || 'unknown'), req.ip);
      res.json({
        ok: true, to, delivery_id: deliveryId, sample: key !== null,
        note: (key ? 'Sample order data was used (ref TEST-0001). ' : 'This template is not one of the order letters, so it went out with no data. ')
          + 'While the workspace is in test mode Customer.io delivers this to the test address configured there, not to you.'
      });
    } catch (e) { fail(res, e, 'transactional test send'); }
  });
}

module.exports = { mount, testRecipient, contractKey, letterKey, letterWarnings, checkLetter, refusalMessage, sampleData, contentPayload, dsPayload, htmlToText, triggerFields, contentSha, CONTRACT, ENV_IDS, SAVED_FILE, sha16, normalizeName };
