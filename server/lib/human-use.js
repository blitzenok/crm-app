// Human-use flag + COMPLIANCE_HOLD rule (Yehuda-approved 2026-09-30).
//
// Customer free text is scanned (case-insensitive term list in HUMAN_USE_TERMS_PATH, editable, reloaded on change):
//   crm-umg order notes + quote notes, CRM leads (incl. chat pre-chat leads), products-api contact messages and shop-order
//   notes, and the AI shop chat (customer messages + the chat's own humanUse flag).
// On a match: customer human_use_flag=true, append-only audit line (snippet, source, timestamp), every open order / quote of
// that customer gets complianceHold {status:"COMPLIANCE_HOLD"} and an admin alert is listed in the CRM.
// Every source is READ-ONLY here: no stored correspondence is ever modified or deleted (Legal). Nothing emails the customer.
// Gates that consult humanUseBlocks(): Rapid push, order emails, store-forward (Customer.io), ship.
// Two tiers (Legal 2026-10-01): STRONG terms flag + hold. WEAK terms alone only open a "needs admin review" item + alert
// (no hold); a weak term in the same text as any strong term counts as strong. Admin escalates (flag + hold) or dismisses
// a review item; both need a note and are audited.
// Email lookback: a read-only export of inbound mail (HUMAN_USE_EMAIL_PATH) is one more source ("email"); only messages
// classified "customer" are screened; partner / supplier hits are listed for Legal and never flag anyone.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

export const COMPLIANCE_HOLD = "COMPLIANCE_HOLD";
const CLOSED_ORDER = new Set(["declined", "failed", "error", "cancelled", "canceled", "crypto_cancelled", "refunded", "voided", "expired", "cancelled_compliance"]);
const CLOSED_QUOTE = new Set(["closed", "cancelled", "canceled", "converted", "lost", "rejected"]);
const lcEmail = (e) => String(e || "").trim().toLowerCase();
const sha = (s) => createHash("sha256").update(String(s)).digest("hex").slice(0, 16);

let ACTIVE = null; // the running instance (index.js registers it); gates in other modules read it
export function setActiveHumanUse(inst) { ACTIVE = inst; }
export function activeHumanUse() { return ACTIVE; }

export function isOpenOrder(o) {
  if (!o) return false;
  if (o.fulfillment?.status === "shipped") return false;
  return !CLOSED_ORDER.has(String(o.status || "").toLowerCase());
}
export function isOpenQuote(q) { return Boolean(q) && !CLOSED_QUOTE.has(String(q.status || "").toLowerCase()) && !CLOSED_QUOTE.has(String(q.crmStatus || "").toLowerCase()); }

/** true when an order / quote must not be pushed, shipped, forwarded or emailed. Works without an instance (field only). */
export function humanUseBlocks(order) {
  if (!order) return false;
  if (order.complianceHold && (order.complianceHold.active === true || order.complianceHold.refused === true)) return true;
  const inst = ACTIVE;
  if (!inst) return false;
  return inst.isFlagged(order.customer?.email) && isOpenOrder(order);
}

// ---- terms ------------------------------------------------------------------------------------------------------------
export function compileTerms(cfg) {
  const out = [];
  for (const t of (cfg && Array.isArray(cfg.terms) ? cfg.terms : [])) {
    if (!t || !t.id || !t.pattern) continue;
    try { out.push({ id: String(t.id), label: String(t.label || t.id), tier: t.tier === "weak" ? "weak" : "strong", re: new RegExp(t.pattern, t.caseSensitive === true ? "g" : "gi") }); } catch { /* bad pattern: skipped, reported in status */ }
  }
  return { version: cfg?.version || null, snippetChars: Number(cfg?.snippetChars) > 0 ? Number(cfg.snippetChars) : 60, terms: out, invalid: (cfg?.terms || []).length - out.length };
}

export function scanText(text, compiled) {
  const s = String(text || "");
  if (!s.trim()) return [];
  const hits = [];
  const n = compiled.snippetChars;
  for (const t of compiled.terms) {
    t.re.lastIndex = 0;
    const m = t.re.exec(s);
    if (!m) continue;
    const a = Math.max(0, m.index - n), b = Math.min(s.length, m.index + m[0].length + n);
    hits.push({ termId: t.id, tier: t.tier || "strong", match: m[0].slice(0, 80), snippet: `${a > 0 ? "…" : ""}${s.slice(a, b).replace(/\s+/g, " ").trim()}${b < s.length ? "…" : ""}`.slice(0, 240) });
  }
  return hits;
}

/** Legal's rule: any strong hit (or the chat guard's own flag) makes the whole text strong; weak hits alone -> review. */
export function classifyHits(hits) {
  const strong = (hits || []).some((h) => h.tier !== "weak");
  return { tier: !hits || !hits.length ? null : strong ? "strong" : "weak", hits: (hits || []).map((h) => (strong && h.tier === "weak" ? { ...h, escalatedBy: "co_occurrence" } : h)) };
}

// ---- read-only sources --------------------------------------------------------------------------------------------------
function readJsonSafe(path) { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; } }
// audit 2026-10-02 (pay-rest-14): a source file that is there but cannot be parsed, or a required one that is missing, used to read as "no items" and
// nothing said so. These throw instead; scan() reports the source as failed and raises a [pay-alert] (one source failing does not stop the others).
function readJsonSource(path, { optional = false } = {}) {
  if (!existsSync(path)) { if (optional) return null; throw new Error("source_missing"); }
  return JSON.parse(readFileSync(path, "utf8"));
}
const arr = (x) => (Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x) : []);

export function defaultSources(env = process.env, db = null) {
  const leads = env.HUMAN_USE_LEADS_PATH || "/opt/crm-api/data/leads.json";
  const msgs = env.HUMAN_USE_MESSAGES_PATH || "/var/www/mastersol/html/MSOLPEPTIDES/messages.json";
  const shopOrders = env.HUMAN_USE_SHOP_ORDERS_PATH || "/var/www/mastersol/html/MSOLPEPTIDES/orders.json";
  const convDir = env.HUMAN_USE_CHAT_DIR || "/opt/shop-chat/data/conversations";
  const emailPath = env.HUMAN_USE_EMAIL_PATH || "/var/lib/crm-umg/human-use-email-lookback.json";
  const chatCache = new Map();
  return [
    { id: "order_note", list: () => (db ? db.listOrders() : []).map((o) => ({ ref: o.id, email: o.customer?.email, at: o.createdAt, test: o.test === true, parts: [{ text: o.notes, at: o.createdAt }] })) },
    { id: "quote_note", list: () => (db && db.listQuotes ? db.listQuotes() : []).map((q) => ({ ref: q.id, email: q.customer?.email, at: q.createdAt, test: q.test === true, parts: [{ text: q.notes, at: q.createdAt }] })) },
    { id: "lead_note", list: () => arr(readJsonSource(leads)).map((l) => ({ ref: `lead:${l.id}`, email: l.email, at: l.updated_at || l.created_at, parts: [{ text: l.notes, at: l.updated_at || l.created_at }] })) },
    { id: "contact_message", list: () => arr(readJsonSource(msgs)).map((m) => ({ ref: `msg:${m.id}`, email: m.email, at: m.receivedAt, parts: [{ text: `${m.subject || ""}\n${m.message || ""}`, at: m.receivedAt }] })) },
    { id: "shop_order_note", list: () => arr(readJsonSource(shopOrders)).map((o) => ({ ref: `shop:${o.ref}`, email: o.customer?.email, at: o.timestamp || o.savedAt, test: o.test === true, parts: [{ text: o.notes, at: o.timestamp || o.savedAt }] })) },
    {
      id: "shop_chat",
      list: () => {
        let files = [];
        try { files = readdirSync(convDir).filter((f) => f.endsWith(".json")); } catch { throw new Error("source_missing"); }
        const out = [];
        // audit 2026-10-02 (pay-rest-14): every minute all conversation files were read and parsed again; a file whose mtime and size did not
        // change since the last pass is taken from the cache (the cache is per defaultSources() instance and is trimmed to the files still there).
        const live = new Set(files);
        for (const k of chatCache.keys()) if (!live.has(k)) chatCache.delete(k);
        for (const f of files) {
          let st = null;
          try { st = statSync(join(convDir, f)); } catch { continue; }
          const hit = chatCache.get(f);
          const c = hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size ? hit.conv : readJsonSafe(join(convDir, f));
          if (!c) continue;
          if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) chatCache.set(f, { mtimeMs: st.mtimeMs, size: st.size, conv: c });
          const parts = (c.messages || []).filter((m) => m && (m.role === "user" || m.role === "visitor" || m.role === "customer")).map((m) => ({ text: m.text, at: m.at }));
          out.push({ ref: `chat:${c.cid || f.replace(/\.json$/, "")}`, email: c.email, at: c.lastAt || c.createdAt, parts, chatFlag: Boolean(c.flags && c.flags.humanUse) });
        }
        return out;
      },
    },
    // Read-only mail export (see lib header). Own / newsletter / system / partner mail is never screened for flags.
    { id: "email", list: () => arr(readJsonSource(emailPath, { optional: true })?.messages).filter((m) => m && m.category === "customer").map((m) => ({ ref: `email:${m.mailbox}:${m.messageId}`, email: m.sender, at: m.date, parts: [{ text: `${m.subject || ""}\n${m.text || ""}`, at: m.date }], meta: { mailbox: m.mailbox, messageId: m.messageId, date: m.date } })) },
  ];
}
export function readEmailLookback(env = process.env) {
  const p = env.HUMAN_USE_EMAIL_PATH || "/var/lib/crm-umg/human-use-email-lookback.json";
  return { path: p, data: existsSync(p) ? readJsonSafe(p) : null };
}

// ---- instance ---------------------------------------------------------------------------------------------------------------
export function createHumanUse({ db, env = process.env, sources = null, now = () => new Date(), log = (m) => process.stdout.write(`${m}\n`), statePath, auditPath, termsPath } = {}) {
  const sp = statePath ?? env.HUMAN_USE_STATE_PATH ?? null;
  const ap = auditPath ?? env.HUMAN_USE_AUDIT_PATH ?? null;
  const tp = termsPath ?? env.HUMAN_USE_TERMS_PATH ?? "/etc/crm-umg/human-use-terms.json";
  const srcs = sources || defaultSources(env, db);
  const iso = () => now().toISOString();
  // audit 2026-10-02 (pay-rest-14): the module used to go quiet without a word when its term list or a source could not be read.
  // ops-watch reads [pay-alert] lines; one line per kind every 30 minutes, not one per scan.
  const payAlertAt = {};
  function payAlert(kind, msg) {
    const t = now().getTime();
    if (t - (payAlertAt[kind] || 0) < 30 * 60 * 1000) return;
    payAlertAt[kind] = t;
    log(`[pay-alert] HUMAN_USE_${kind} ${String(msg).slice(0, 200)}`);
  }
  if (!sp || !ap) log(`[pay-alert] HUMAN_USE_PATHS_UNSET ${!sp ? "HUMAN_USE_STATE_PATH " : ""}${!ap ? "HUMAN_USE_AUDIT_PATH " : ""}not set: flags / seen state ${!sp ? "are lost on restart" : ""}${!sp && !ap ? " and " : ""}${!ap ? "no audit trail is written" : ""}`);
  let state = { version: 1, flags: {}, seen: {}, alerts: [], unlinked: [], reviews: [], lastScan: null, backfill: null, backfills: [] };
  if (sp && existsSync(sp)) { const s = readJsonSafe(sp); if (s && s.flags) state = { ...state, ...s }; else if (s === null) throw new Error(`human-use state unreadable: ${sp}`); }
  let terms = { version: null, terms: [], invalid: 0, snippetChars: 60 }, termsMtime = -1, termsError = null;
  const rawUpsertOrder = db.upsertOrder.bind(db);
  const rawUpsertQuote = db.upsertQuote ? db.upsertQuote.bind(db) : null;

  function loadTerms(force = false) {
    try {
      const m = statSync(tp).mtimeMs;
      if (!force && m === termsMtime) return terms;
      const cfg = JSON.parse(readFileSync(tp, "utf8"));
      terms = compileTerms(cfg); termsMtime = m; termsError = null;
      log(`[human-use] terms loaded v=${terms.version} count=${terms.terms.length}${terms.invalid ? ` invalid=${terms.invalid}` : ""}`);
    } catch (err) { termsError = String(err.message || err).slice(0, 160); }
    return terms;
  }
  function save() {
    if (!sp) return;
    mkdirSync(dirname(sp), { recursive: true });
    const tmp = `${sp}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    renameSync(tmp, sp);
  }
  function audit(ev) {
    const line = { at: iso(), ...ev };
    if (ap) { try { mkdirSync(dirname(ap), { recursive: true }); appendFileSync(ap, `${JSON.stringify(line)}\n`, { mode: 0o600 }); chmodSync(ap, 0o600); } catch (err) { log(`[human-use] audit write failed: ${err.message}`); } }
    return line;
  }
  function alert(a) {
    state.alerts = [...state.alerts, { at: iso(), ...a }].slice(-500);
    log(`[human-use] ALERT ${a.type} ${a.ref || ""} ${a.termId || ""}`.trim());
  }
  const isFlagged = (email) => { const f = state.flags[lcEmail(email)]; return Boolean(f && f.human_use_flag === true); };

  function holdRecord(o, key, reason) {
    const f = state.flags[key];
    const last = f?.hits?.[f.hits.length - 1] || {};
    return { active: true, status: COMPLIANCE_HOLD, reason, heldAt: iso(), source: last.source || null, termId: last.termId || null, snippet: last.snippet || null, flagAt: f?.flaggedAt || null, alreadyAtRapid: Boolean(o.rapid && (o.rapid.status === "pushed" || o.rapid.status === "exists")) };
  }
  /** Put every open order + quote of this customer on hold. Only the complianceHold field is added. */
  function applyHolds(key, reason = "human_use_flag") {
    const held = [];
    for (const o of db.listOrders()) {
      if (lcEmail(o.customer?.email) !== key || !isOpenOrder(o) || o.complianceHold?.active) continue;
      o.complianceHold = { ...(o.complianceHold || {}), ...holdRecord(o, key, reason) };
      rawUpsertOrder(o); held.push(o.id);
      if (o.complianceHold.alreadyAtRapid) alert({ type: "held_order_already_at_rapid", ref: o.id, message: "order was pushed to Rapid before the flag: cancel it at the warehouse" });
    }
    if (db.listQuotes && rawUpsertQuote) {
      for (const q of db.listQuotes()) {
        if (lcEmail(q.customer?.email) !== key || !isOpenQuote(q) || q.complianceHold?.active) continue;
        q.complianceHold = { ...(q.complianceHold || {}), ...holdRecord(q, key, reason) };
        rawUpsertQuote(q); held.push(q.id);
      }
    }
    if (held.length) audit({ event: "hold_applied", email: key, refs: held, reason });
    return held;
  }
  function flag(email, hit) {
    const key = lcEmail(email);
    const f = state.flags[key] || { email: key, human_use_flag: false, hits: [], history: [] };
    const dup = f.hits.some((h) => h.source === hit.source && h.ref === hit.ref && h.termId === hit.termId && h.snippet === hit.snippet);
    if (!dup) f.hits = [...f.hits, hit].slice(-100);
    const newly = f.human_use_flag !== true;
    if (newly) { f.human_use_flag = true; f.flaggedAt = iso(); f.history = [...(f.history || []), { at: iso(), event: "flagged", source: hit.source, ref: hit.ref }]; }
    f.lastHitAt = iso();
    state.flags[key] = f;
    audit({ event: newly ? "flagged" : "hit", email: key, source: hit.source, ref: hit.ref, termId: hit.termId, snippet: hit.snippet, textAt: hit.textAt || null, backfill: Boolean(hit.backfill) });
    if (newly) alert({ type: "human_use_flag", email: key, source: hit.source, ref: hit.ref, termId: hit.termId, snippet: hit.snippet });
    return { key, newly };
  }

  /** Weak-only text: a "needs admin review" item + alert. No flag, no hold. One item per source/ref/content. */
  function openReview(srcId, it, hits, { backfill = false } = {}) {
    const email = lcEmail(it.email);
    // id from content (not the terms version): a version bump that finds the same weak hits does not duplicate the item.
    const id = `r_${sha(`${srcId}|${it.ref}|${hits.map((h) => `${h.termId}:${h.snippet}`).join("|")}`).slice(0, 12)}`;
    if ((state.reviews || []).some((r) => r.id === id)) return null;
    const r = { id, at: iso(), status: "open", source: srcId, ref: it.ref, email: email.includes("@") ? email : null, test: it.test === true, textAt: it.at || null, meta: it.meta || null, backfill,
      hits: hits.map((h) => ({ termId: h.termId, tier: h.tier, match: h.match, snippet: h.snippet, textAt: h.textAt || null })) };
    state.reviews = [...(state.reviews || []), r].slice(-2000);
    audit({ event: "review_opened", id, email: r.email, source: srcId, ref: it.ref, terms: r.hits.map((h) => h.termId), snippet: r.hits[0]?.snippet || null, backfill });
    alert({ type: "human_use_review", ref: it.ref, termId: r.hits[0]?.termId, email: r.email, source: srcId, reviewId: id });
    return r;
  }
  /** Admin: escalate a review item to flag + hold (note required, audited). */
  function escalateReview(id, { actor, note }) {
    const r = (state.reviews || []).find((x) => x.id === id);
    if (!r) return { ok: false, status: 404, error: "not_found" };
    if (!String(note || "").trim()) return { ok: false, status: 400, error: "note_required" };
    if (r.status !== "open") return { ok: false, status: 409, error: `already_${r.status}` };
    if (!r.email) return { ok: false, status: 409, error: "no_customer_email" };
    const n = String(note).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 1000);
    for (const h of r.hits) flag(r.email, { source: r.source, ref: r.ref, termId: h.termId, tier: h.tier, match: h.match, snippet: h.snippet, textAt: h.textAt, test: r.test, escalatedFromReview: r.id, escalatedBy: actor, seenAt: iso() });
    Object.assign(r, { status: "escalated", decidedAt: iso(), decidedBy: actor, note: n });
    audit({ event: "review_escalated", id, email: r.email, actor, note: n });
    const held = applyHolds(r.email, "human_use_review_escalated");
    save();
    return { ok: true, review: r, held };
  }
  /** Admin: dismiss a review item (note required, audited). Nothing else changes. */
  function dismissReview(id, { actor, note }) {
    const r = (state.reviews || []).find((x) => x.id === id);
    if (!r) return { ok: false, status: 404, error: "not_found" };
    if (!String(note || "").trim()) return { ok: false, status: 400, error: "note_required" };
    if (r.status !== "open") return { ok: false, status: 409, error: `already_${r.status}` };
    const n = String(note).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 1000);
    Object.assign(r, { status: "dismissed", decidedAt: iso(), decidedBy: actor, note: n });
    audit({ event: "review_dismissed", id, email: r.email, actor, note: n });
    save();
    return { ok: true, review: r };
  }

  /** One pass over every source. Only items whose content changed since the last pass are scanned again. */
  function scan({ backfill = false } = {}) {
    loadTerms();
    if (!terms.terms.length) {
      payAlert("NO_TERMS", `term list empty or unreadable (${tp}: ${termsError || "no terms"}); nothing is being screened`);
      return { ok: false, error: termsError || "no_terms" };
    }
    if (termsError) payAlert("TERMS_ERROR", `term list ${tp} cannot be read now (${termsError}); screening with the last good version`);
    const res = { at: iso(), backfill, termsVersion: terms.version || null, items: 0, scanned: 0, hits: 0, newlyFlagged: [], held: [], unlinked: 0, bySource: {},
      tiers: { strongItems: 0, weakOnlyItems: 0, strongHits: 0, weakHits: 0, weakEscalatedByCooccurrence: 0, reviewsOpened: 0, unlinkedStrong: 0 } };
    const tv = terms.version || "";
    for (const src of srcs) {
      let items = [];
      try { items = src.list() || []; } catch (err) { res.bySource[src.id] = { error: String(err.message).slice(0, 80) }; payAlert(`SOURCE_${String(src.id).toUpperCase()}`, `source ${src.id} cannot be read (${String(err.message).slice(0, 80)}); it is not being screened`); continue; }
      const bs = (res.bySource[src.id] = { items: items.length, hits: 0 });
      for (const it of items) {
        res.items += 1;
        // email is part of the signature: a chat hit that was unlinked re-links once the visitor gives an email.
        const sig = sha(`${tv}|${it.chatFlag ? 1 : 0}|${lcEmail(it.email)}|${(it.parts || []).map((p) => p.text || "").join("\u0001")}`);
        const k = `${src.id}:${it.ref}`;
        if (state.seen[k] === sig) continue;
        state.seen[k] = sig;
        res.scanned += 1;
        const found = [];
        for (const p of it.parts || []) for (const h of scanText(p.text, terms)) found.push({ ...h, textAt: p.at || it.at || null });
        if (it.chatFlag) found.push({ termId: "chat_guard_human_use", tier: "strong", match: "shop-chat humanUse flag", snippet: "(shop chat marked this conversation human_use)", textAt: it.at || null });
        if (!found.length) continue;
        bs.hits += found.length; res.hits += found.length;
        const cls = classifyHits(found);
        for (const h of cls.hits) { if (h.tier === "weak") res.tiers.weakHits += 1; else res.tiers.strongHits += 1; if (h.escalatedBy) res.tiers.weakEscalatedByCooccurrence += 1; }
        bs.strong = (bs.strong || 0) + (cls.tier === "strong" ? 1 : 0); bs.weak = (bs.weak || 0) + (cls.tier === "weak" ? 1 : 0);
        const email = lcEmail(it.email);
        if (cls.tier === "weak") {
          res.tiers.weakOnlyItems += 1;
          if (openReview(src.id, it, cls.hits, { backfill })) res.tiers.reviewsOpened += 1;
          continue;
        }
        res.tiers.strongItems += 1;
        if (!email || !email.includes("@")) {
          res.tiers.unlinkedStrong += 1;
          if (!state.unlinked.some((u) => u.source === src.id && u.ref === it.ref)) {
            state.unlinked = [...state.unlinked, { at: iso(), source: src.id, ref: it.ref, termId: found[0].termId, snippet: found[0].snippet }].slice(-500);
            audit({ event: "unlinked_hit", source: src.id, ref: it.ref, termId: found[0].termId, snippet: found[0].snippet, backfill });
            alert({ type: "human_use_unlinked", source: src.id, ref: it.ref, termId: found[0].termId, snippet: found[0].snippet });
            res.unlinked += 1;
          }
          continue;
        }
        for (const h of cls.hits) {
          const r = flag(email, { source: src.id, ref: it.ref, termId: h.termId, tier: h.tier, escalatedBy: h.escalatedBy || null, match: h.match, snippet: h.snippet, textAt: h.textAt, test: it.test === true, backfill, seenAt: iso(), ...(it.meta ? { meta: it.meta } : {}) });
          if (r.newly && !res.newlyFlagged.includes(r.key)) res.newlyFlagged.push(r.key);
        }
      }
    }
    for (const [key, f] of Object.entries(state.flags)) if (f.human_use_flag) res.held.push(...applyHolds(key));
    state.lastScan = { at: res.at, termsVersion: res.termsVersion, items: res.items, scanned: res.scanned, hits: res.hits, newlyFlagged: res.newlyFlagged.length, held: res.held.length, unlinked: res.unlinked, tiers: res.tiers };
    if (backfill) {
      state.backfill = { ...state.lastScan, backfill: true, bySource: res.bySource };
      state.backfills = [...(state.backfills || []), state.backfill].slice(-20);
    }
    save();
    if (res.newlyFlagged.length || res.held.length) log(`[human-use] scan: ${res.newlyFlagged.length} newly flagged, ${res.held.length} orders/quotes held${backfill ? " (backfill)" : ""}`);
    return { ok: true, ...res };
  }

  /** Called on every order / quote write (creation included): scan its notes, hold it when the customer is flagged. */
  function onWrite(kind, rec) {
    try {
      loadTerms();
      const email = lcEmail(rec?.customer?.email);
      if (terms.terms.length && rec?.notes) {
        const src = kind === "quote" ? "quote_note" : "order_note";
        const k = `${src}:${rec.id}`;
        const sig = sha(`${terms.version || ""}|0|${rec.notes}`);
        if (state.seen[k] !== sig) {
          state.seen[k] = sig;
          const cls = classifyHits(scanText(rec.notes, terms));
          if (cls.tier === "strong" && email.includes("@")) for (const h of cls.hits) flag(email, { source: src, ref: rec.id, termId: h.termId, tier: h.tier, escalatedBy: h.escalatedBy || null, match: h.match, snippet: h.snippet, textAt: rec.createdAt || null, test: rec.test === true, seenAt: iso() });
          else if (cls.tier === "weak") openReview(src, { ref: rec.id, email, at: rec.createdAt || null, test: rec.test === true }, cls.hits.map((h) => ({ ...h, textAt: rec.createdAt || null })));
          save();
        }
      }
      const open = kind === "quote" ? isOpenQuote(rec) : isOpenOrder(rec);
      if (email && isFlagged(email) && open && !rec.complianceHold?.active && !rec.complianceHold?.releasedAt) {
        rec.complianceHold = holdRecord(rec, email, "human_use_flag_at_creation");
        audit({ event: "hold_applied", email, refs: [rec.id], reason: "human_use_flag_at_creation" });
        alert({ type: "held_at_creation", email, ref: rec.id });
        save();
        queueMicrotask(() => { try { applyHolds(email); save(); } catch { /* next scan */ } });
      }
    } catch (err) { log(`[human-use] onWrite failed: ${err.message}`); }
    return rec;
  }
  function install() {
    db.upsertOrder = (o) => rawUpsertOrder(onWrite("order", o));
    if (rawUpsertQuote) db.upsertQuote = (q) => rawUpsertQuote(onWrite("quote", q));
  }

  /** Admin: clear a false positive (note required). Releases the holds this flag put on (refused records stay refused). */
  function clearFlag(email, { actor, note }) {
    const key = lcEmail(email);
    const f = state.flags[key];
    if (!f) return { ok: false, status: 404, error: "not_found" };
    if (!String(note || "").trim()) return { ok: false, status: 400, error: "note_required" };
    const n = String(note).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 1000);
    f.human_use_flag = false; f.clearedAt = iso(); f.clearedBy = actor; f.clearNote = n;
    f.history = [...(f.history || []), { at: iso(), event: "cleared_false_positive", actor, note: n }];
    const released = [];
    const rel = (r) => { r.complianceHold = { ...r.complianceHold, active: false, releasedAt: iso(), releasedBy: actor, releaseNote: n }; };
    for (const o of db.listOrders()) if (lcEmail(o.customer?.email) === key && o.complianceHold?.active && !o.complianceHold.refused) { rel(o); rawUpsertOrder(o); released.push(o.id); }
    if (db.listQuotes && rawUpsertQuote) for (const q of db.listQuotes()) if (lcEmail(q.customer?.email) === key && q.complianceHold?.active && !q.complianceHold.refused) { rel(q); rawUpsertQuote(q); released.push(q.id); }
    audit({ event: "flag_cleared_false_positive", email: key, actor, note: n, released });
    save();
    return { ok: true, flag: f, released };
  }
  /** Admin: cancel & refuse one held order / quote (logged). Permanent; clearing the flag does not release it. */
  function cancelRefuse(ref, { actor, note }) {
    const n = String(note || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 1000) || null;
    const o = db.getOrder(ref) || db.getOrderByRef?.(ref);
    const q = !o && db.getQuote ? db.getQuote(ref) : null;
    const rec = o || q;
    if (!rec) return { ok: false, status: 404, error: "not_found" };
    if (o && o.fulfillment?.status === "shipped") return { ok: false, status: 409, error: "already_shipped" };
    if (rec.complianceHold?.refused) return { ok: true, reused: true, record: rec };
    rec.complianceHold = { ...(rec.complianceHold || { status: COMPLIANCE_HOLD, reason: "admin_cancel_refuse", heldAt: iso() }), active: true, refused: true, refusedAt: iso(), refusedBy: actor, refuseNote: n };
    if (o) {
      rec.fulfillment = { ...(rec.fulfillment || {}), status: "blocked", shippable: false, blockedReason: "compliance_refused" };
      rec.complianceRefusal = { at: iso(), by: actor, note: n, statusBefore: rec.status, paymentMethod: rec.paymentMethod || null, refundNeeded: rec.status === "approved" || rec.paymentConfirmed === true };
      rawUpsertOrder(rec);
    } else rawUpsertQuote(rec);
    audit({ event: "cancel_refuse", ref: rec.id, email: lcEmail(rec.customer?.email), actor, note: n, refundNeeded: Boolean(rec.complianceRefusal?.refundNeeded) });
    alert({ type: "cancel_refuse", ref: rec.id, message: `refused by ${actor}${rec.complianceRefusal?.refundNeeded ? " — refund the payment manually" : ""}` });
    save();
    return { ok: true, record: rec };
  }

  function view() {
    loadTerms();
    const holdsFor = (key) => [
      ...db.listOrders().filter((o) => lcEmail(o.customer?.email) === key && o.complianceHold).map((o) => ({ id: o.id, kind: "order", paymentMethod: o.paymentMethod || null, status: o.status, test: o.test === true, hold: o.complianceHold })),
      ...(db.listQuotes ? db.listQuotes() : []).filter((q) => lcEmail(q.customer?.email) === key && q.complianceHold).map((q) => ({ id: q.id, kind: "quote", status: q.status, hold: q.complianceHold })),
    ];
    return {
      ok: true,
      terms: { path: tp, version: terms.version, count: terms.terms.length, invalid: terms.invalid, error: termsError },
      lastScan: state.lastScan, backfill: state.backfill,
      flags: Object.values(state.flags).map((f) => ({ ...f, records: holdsFor(f.email) })),
      alerts: state.alerts.slice(-200).reverse(), unlinked: state.unlinked.slice(-200).reverse(),
      reviews: (state.reviews || []).slice(-500).reverse(),
      reviewCounts: (state.reviews || []).reduce((a, r) => { a[r.status] = (a[r.status] || 0) + 1; return a; }, {}),
      backfills: (state.backfills || []).slice(-5).reverse(),
      emailLookback: emailLookbackView(),
    };
  }
  /** Mailbox coverage + partner/supplier hits for Legal (listed, never flagged). */
  function emailLookbackView() {
    const { path, data } = readEmailLookback(env);
    if (!data) return { path, present: false };
    const msgs = arr(data.messages);
    const counts = msgs.reduce((a, m) => { a[m.category || "unknown"] = (a[m.category || "unknown"] || 0) + 1; return a; }, {});
    const partnerHits = msgs.filter((m) => m.category === "partner").map((m) => {
      const cls = classifyHits(scanText(`${m.subject || ""}\n${m.text || ""}`, terms));
      return { mailbox: m.mailbox, messageId: m.messageId, date: m.date, sender: m.sender, org: m.org || null, tier: cls.tier, terms: [...new Set(cls.hits.map((h) => h.termId))], snippet: cls.hits[0]?.snippet || m.subject || "" };
    });
    return { path, present: true, generatedAt: data.generatedAt || null, readOnly: data.readOnly === true, mailboxes: data.mailboxes || [], counts, partnerHits };
  }
  /** Minimal index for the red badges on customer / order cards. */
  function badgeIndex() {
    const emails = {}, orders = {};
    for (const f of Object.values(state.flags)) {
      if (!f.human_use_flag) continue;
      const last = f.hits[f.hits.length - 1] || {};
      emails[f.email] = { snippet: last.snippet || "", source: last.source || "", at: f.flaggedAt };
    }
    const add = (r) => { if (r.complianceHold && (r.complianceHold.active || r.complianceHold.refused)) orders[r.id] = { snippet: r.complianceHold.snippet || "", refused: Boolean(r.complianceHold.refused), status: COMPLIANCE_HOLD }; };
    db.listOrders().forEach(add);
    (db.listQuotes ? db.listQuotes() : []).forEach(add);
    for (const o of db.listOrders()) if (o.orderRef && orders[o.id]) orders[o.orderRef] = orders[o.id];
    return { ok: true, emails, orders };
  }
  function start(intervalMs = 60000) {
    loadTerms();
    const first = !state.backfill || (terms.version && state.backfill.termsVersion !== terms.version);
    const r = scan({ backfill: first });
    if (r.ok) log(`[human-use] ${first ? "BACKFILL" : "startup scan"} v=${r.termsVersion}: items=${r.items} scanned=${r.scanned} hits=${r.hits} strongItems=${r.tiers.strongItems} weakOnlyItems=${r.tiers.weakOnlyItems} reviews=${r.tiers.reviewsOpened} flagged=${r.newlyFlagged.length} held=${r.held.length} unlinked=${r.unlinked}`);
    else log(`[human-use] scan not run: ${r.error}`);
    const h = setInterval(() => { try { scan(); } catch (err) { log(`[human-use] scan failed: ${err.message}`); } }, intervalMs);
    h.unref?.();
    return h;
  }
  loadTerms(true);
  return { scan, onWrite, install, isFlagged, clearFlag, cancelRefuse, escalateReview, dismissReview, view, badgeIndex, start, applyHolds, state: () => state, loadTerms };
}
