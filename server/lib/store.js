import { closeSync, copyFileSync, existsSync, fchmodSync, fsyncSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const PROCESSOR_IDS = ["umg", "tagada", "centrobill"];
export const ABANDONED_MAX = 500;
const DECIDED_STATUSES = new Set(["APPROVED", "CAPTURED", "PAID", "DECLINED", "CANCELED", "CANCELLED"]);

export function defaultSettings() {
  return {
    killSwitchPsp: null,
    processors: [
      { id: "umg", label: "UMG", enabled: true, priority: 1, mode: "sandbox" },
      { id: "tagada", label: "Tagada", enabled: false, priority: 2, mode: "off" },
      { id: "centrobill", label: "Centrobill", enabled: false, priority: 3, mode: "off" },
    ],
  };
}

function emptyData() {
  return {
    settings: defaultSettings(),
    orders: [],
    quotes: [],
    abandoned_checkouts: {},
    seq: 1000,
    quoteSeq: 5000,
    abandonedDigestAt: null,
    crypto: emptyCrypto(),
  };
}

// On-chain verifier state: tx ledger (one tx -> one order, ever), scan cursors, unmatched deposits, alerts.
function emptyCrypto() {
  return { ledger: {}, scan: {}, unmatched: [], alerts: [] };
}

function asCrypto(value) {
  const v = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return {
    ledger: v.ledger && typeof v.ledger === "object" && !Array.isArray(v.ledger) ? v.ledger : {},
    scan: v.scan && typeof v.scan === "object" && !Array.isArray(v.scan) ? v.scan : {},
    unmatched: Array.isArray(v.unmatched) ? v.unmatched : [],
    alerts: Array.isArray(v.alerts) ? v.alerts : [],
  };
}

function asAbandonedMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

// audit 2026-10-02 (sec-pay-7): session_id comes from the public beacon; a plain-object lookup by "__proto__" / "constructor"
// returns Object.prototype / a function, and the following field writes pollute the whole process. Only own keys count.
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const UNSAFE_SESSION_IDS = new Set(["__proto__", "constructor", "prototype"]);

function trimAbandonedMap(map, max, keepId) {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  const sorted = keys.sort((a, b) => {
    const ta = map[a]?.last_seen || map[a]?.seen_at || "";
    const tb = map[b]?.last_seen || map[b]?.seen_at || "";
    return String(ta).localeCompare(String(tb));
  });
  let drop = keys.length - max;
  for (const key of sorted) {
    if (drop <= 0) break;
    if (key === keepId) continue;
    delete map[key];
    drop -= 1;
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

/** infra 2026-09-29 honest-charge: "sku:qty" pairs, lower-cased and sorted: the same cart in any line order gives the same key. */
export function itemsKey(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => `${String(it?.sku || it?.slug || "").trim().toLowerCase()}:${Math.max(1, parseInt(it?.qty ?? it?.quantity, 10) || 1)}`)
    .sort()
    .join("|");
}

const normText = (v) => String(v ?? "").trim().toLowerCase().replace(/\s+/g, " ");
/** What a Cleffo payment link carries about the buyer, normalised (case / spacing / phone punctuation do not matter). */
export function buyerKey(c = {}) { // audit 2026-10-02: exported for the same-key retry check in cleffo-checkout.js
  return JSON.stringify([
    normText(c?.first_name ?? c?.firstName), normText(c?.last_name ?? c?.lastName),
    String(c?.phone ?? "").replace(/\D/g, ""),
    normText(c?.country), normText(c?.state), normText(c?.city), normText(c?.zip), normText(c?.address),
  ]);
}

export function createStore(opts = {}) {
  const memoryOnly = opts.memoryOnly === true;
  const filePath = opts.filePath || null;
  let data = emptyData();

  // infra 2026-09-29 cleffo: an unreadable store.json must never mean "start empty" (the BLR counter would restart and
  // hand out duplicate order numbers). Try the previous good version; if that fails too, refuse to start.
  const prevPath = filePath ? `${filePath}.prev` : null;
  function parseStore(path) {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not_an_object");
    return parsed;
  }
  if (!memoryOnly && filePath && (existsSync(filePath) || existsSync(prevPath))) {
    let parsed = null;
    try {
      parsed = parseStore(filePath);
    } catch {
      try {
        parsed = parseStore(prevPath);
        // Keep the broken file for a post-mortem: the first write would replace it (and turn it into the next .prev).
        try { if (existsSync(filePath)) renameSync(filePath, `${filePath}.corrupt-${new Date().toISOString().replace(/[^0-9A-Za-z]/g, "")}`); } catch { /* best effort */ }
        process.stdout.write("[pay-alert] STORE_FROM_PREV store.json was unreadable, loaded store.json.prev (the last write may be lost)\n");
      } catch {
        process.stdout.write("[pay-alert] STORE_UNREADABLE store.json and store.json.prev cannot be read, refusing to start\n");
        throw new Error("store_unreadable");
      }
    }
    data = {
      settings: { ...defaultSettings(), ...(parsed.settings || {}) },
      orders: Array.isArray(parsed.orders) ? parsed.orders : [],
      quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
      abandoned_checkouts: asAbandonedMap(parsed.abandoned_checkouts),
      seq: Number(parsed.seq) || 1000,
      quoteSeq: Number(parsed.quoteSeq) || 5000,
      abandonedDigestAt: parsed.abandonedDigestAt || null,
      crypto: asCrypto(parsed.crypto),
    };
    if (!Array.isArray(data.settings.processors) || data.settings.processors.length === 0) {
      data.settings.processors = defaultSettings().processors;
    }
  }

  // Temp files of earlier processes (a crash between write and rename) are just leftovers.
  if (!memoryOnly && filePath) {
    try {
      const prefix = `.${basename(filePath)}.tmp-`;
      for (const f of readdirSync(dirname(filePath))) if (f.startsWith(prefix)) { try { unlinkSync(join(dirname(filePath), f)); } catch { /* ignore */ } }
    } catch { /* directory not there yet */ }
  }

  // Temp file next to the target (dot-prefixed: the vhosts hide dotfiles) + fsync + rename; the file being replaced is kept as .prev.
  // audit 2026-10-02 (pay-cleffo-crypto-10 / pay-core-6): the file is written compact (the 2-space indent was a third of its size and of the
  // stringify time) and a write whose content equals the last one written by this process is skipped (crypto-verify and the pollers call
  // update paths that change nothing). Both readers use JSON.parse, so an old indented file still loads.
  let lastWritten = null;
  function persist() {
    if (memoryOnly || !filePath) return;
    const json = JSON.stringify(data);
    if (json === lastWritten) return;
    const dir = dirname(filePath);
    mkdirSync(dir, { recursive: true });
    const tmp = join(dir, `.${basename(filePath)}.tmp-${process.pid}`);
    const fd = openSync(tmp, "w");
    try {
      // Same permissions as the file being replaced (the host runs the service as one user and reads the file as another);
      // a first write gets 0600 (audit 2026-10-02 sec-pay-22: buyer addresses, phones and e-mails; every reader on the host runs as root).
      let mode = 0o600;
      try { mode = statSync(filePath).mode & 0o777; } catch {
        try { mode = statSync(prevPath).mode & 0o777; } catch { /* first write */ } // main file moved aside after a start from .prev
      }
      fchmodSync(fd, mode);
      writeSync(fd, json);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(filePath)) {
      try { unlinkSync(prevPath); } catch { /* none yet */ }
      try { linkSync(filePath, prevPath); } catch { try { copyFileSync(filePath, prevPath); } catch { /* keep going: main file is intact */ } }
    }
    renameSync(tmp, filePath);
    lastWritten = json;
  }

  return {
    getSettings() {
      return clone(data.settings);
    },
    saveSettings(next) {
      const incoming = next && typeof next === "object" ? next : {};
      const processors = Array.isArray(incoming.processors)
        ? incoming.processors
        : data.settings.processors;
      const normalized = processors
        .filter((p) => PROCESSOR_IDS.includes(p.id))
        .map((p, i) => ({
          id: p.id,
          label: p.label || p.id,
          enabled: Boolean(p.enabled),
          priority: Number(p.priority) || i + 1,
          mode: ["live", "sandbox", "off"].includes(p.mode) ? p.mode : "off",
        }));
      for (const id of PROCESSOR_IDS) {
        if (!normalized.some((p) => p.id === id)) {
          const fallback = defaultSettings().processors.find((p) => p.id === id);
          normalized.push(fallback);
        }
      }
      // audit 2026-10-02 (pay-rest-13): `??` made null ("Off" in the UI) fall back to the old value, so a kill switch could never be cleared.
      let kill = incoming.killSwitchPsp !== undefined ? incoming.killSwitchPsp : data.settings.killSwitchPsp;
      if (kill === "" || kill === "none") kill = null;
      if (kill && !PROCESSOR_IDS.includes(kill)) kill = null;
      data.settings = { killSwitchPsp: kill, processors: normalized };
      persist();
      return clone(data.settings);
    },
    listOrders() {
      return clone(data.orders).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    getOrder(id) {
      const order = data.orders.find((o) => o.id === id);
      return order ? clone(order) : null;
    },
    getOrderByRef(ref) {
      const want = String(ref || "").trim();
      if (!want) return null;
      const order = data.orders.find((o) => o.orderRef === want);
      return order ? clone(order) : null;
    },
    getOrderByIdempotency(key) {
      if (!key) return null;
      const order = data.orders.find((o) => o.idempotencyKey === key);
      return order ? clone(order) : null;
    },
    /**
     * infra 2026-09-29 honest-charge: a card order by the same buyer (email, any case) with the same server amount and the
     * same set of lines, created within `windowMs`, still approved / pending / in flight, under a DIFFERENT key.
     * Guards the "browser lost the answer, next click has a new key" double charge. Crypto orders do not count.
     */
    findRecentCardDuplicate({ email, amount, items, excludeKey, windowMs = 15 * 60 * 1000, now = Date.now() }) {
      const em = String(email || "").trim().toLowerCase();
      if (!em) return null;
      const want = itemsKey(items);
      let best = null;
      for (const o of data.orders) {
        if (o.paymentMethod === "crypto" || o.idempotencyKey === excludeKey) continue;
        if (String(o.customer?.email || "").trim().toLowerCase() !== em) continue;
        if (!(o.inFlight || ["approved", "pending"].includes(String(o.status || "").toLowerCase()))) continue;
        if (now - (Date.parse(o.createdAt) || 0) > windowMs) continue;
        if (Number(o.amount).toFixed(2) !== Number(amount).toFixed(2) || itemsKey(o.items) !== want) continue;
        if (!best || String(o.createdAt) > String(best.createdAt)) best = o;
      }
      return best ? clone(best) : null;
    },
    /**
     * infra 2026-09-29 cleffo round 3: an order of the same buyer (email) and the same cart (server amount + lines) that still
     * waits on a Cleffo link created less than ttlMin ago (not abandoned), under a DIFFERENT key. The caller hands that link out
     * again instead of creating a second one.
     */
    findLiveCleffoLink({ email, customer, amount, items, shipMethod = "", coupon = "", excludeKey, ttlMin = 60, now = Date.now() }) {
      const em = String(email || "").trim().toLowerCase();
      if (!em) return null;
      const want = itemsKey(items);
      const who = buyerKey(customer);
      const ship = normText(shipMethod);
      const cpn = normText(coupon);
      let best = null;
      for (const o of data.orders) {
        if (o.idempotencyKey === excludeKey || String(o.status || "").toLowerCase() !== "awaiting_payment") continue;
        if (String(o.customer?.email || "").trim().toLowerCase() !== em || itemsKey(o.items) !== want) continue;
        // The link carries the buyer's name, phone and addresses: a corrected address / name is a NEW link, never the old data.
        if (buyerKey(o.customer) !== who || normText(o.priceCheck?.shipMethod) !== ship || normText(o.priceCheck?.coupon) !== cpn) continue;
        const a = [...(o.attempts || [])].reverse().find((x) => x.processor === "cleffo" && x.processorStatus === "LINK_CREATED" && x.paymentLink && !x.abandoned);
        if (!a || now - (Date.parse(a.startedAt) || 0) > ttlMin * 60000) continue;
        if (Number(a.amount ?? o.amount).toFixed(2) !== Number(amount).toFixed(2)) continue;
        if (!best || String(a.startedAt) > String(best.attempt.startedAt)) best = { order: clone(o), attempt: clone(a) };
      }
      return best;
    },
    deleteOrder(id) {
      const i = data.orders.findIndex((o) => o.id === id);
      if (i === -1) return null;
      const [gone] = data.orders.splice(i, 1);
      persist();
      return clone(gone);
    },
    deleteAbandonedCheckout(sessionId) {
      const key = String(sessionId || "");
      if (!key || !hasOwn(data.abandoned_checkouts, key)) return null;
      const gone = data.abandoned_checkouts[key];
      delete data.abandoned_checkouts[key];
      persist();
      return clone(gone);
    },
    nextOrderId() {
      data.seq += 1;
      persist();
      return `BLR-${data.seq}`;
    },
    listQuotes() {
      return clone(data.quotes || []).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    getQuote(id) {
      const quote = (data.quotes || []).find((q) => q.id === id);
      return quote ? clone(quote) : null;
    },
    getQuoteByIdempotency(key) {
      if (!key) return null;
      const quote = (data.quotes || []).find((q) => q.idempotencyKey === key);
      return quote ? clone(quote) : null;
    },
    nextQuoteId() {
      data.quoteSeq = Number(data.quoteSeq) || 5000;
      data.quoteSeq += 1;
      persist();
      return `QT-${data.quoteSeq}`;
    },
    upsertQuote(quote) {
      if (!Array.isArray(data.quotes)) data.quotes = [];
      const idx = data.quotes.findIndex((q) => q.id === quote.id);
      const copy = clone(quote);
      if (idx === -1) data.quotes.push(copy);
      else data.quotes[idx] = copy;
      persist();
      return clone(copy);
    },
    upsertOrder(order) {
      const idx = data.orders.findIndex((o) => o.id === order.id);
      const copy = clone(order);
      if (idx === -1) data.orders.push(copy);
      else data.orders[idx] = copy;
      persist();
      return clone(copy);
    },
    findAttempt(processor, processorTxnId) {
      if (processorTxnId == null || processorTxnId === "") return null;
      const want = String(processorTxnId);
      for (const order of data.orders) {
        const attempt = (order.attempts || []).find(
          (a) => a.processor === processor && String(a.processorTxnId) === want,
        );
        if (attempt) return { order: clone(order), attempt: clone(attempt) };
      }
      return null;
    },
    /** A Cleffo attempt by the merchant_order_id we sent (a link whose creation timed out has no reference number yet). */
    findAttemptByMerchantId(processor, merchantOrderId) {
      const want = String(merchantOrderId || "").replace(/[^A-Za-z0-9]/g, "");
      if (!want) return null;
      for (const order of data.orders) {
        const attempt = (order.attempts || []).find((a) => a.processor === processor && a.merchantOrderId === want);
        if (attempt) return { order: clone(order), attempt: clone(attempt) };
      }
      return null;
    },
    pendingAttempts(processor) {
      const out = [];
      for (const order of data.orders) {
        for (const attempt of order.attempts || []) {
          const st = String(attempt.processorStatus || "").toUpperCase();
          if (attempt.processor !== processor) continue;
          // infra 2026-09-29 honest-charge: besides PENDING / 3DS, any not-yet-decided attempt with a txn id on an order that is still
          // waiting (e.g. "PROCESSING - PENDING VERIFICATION"), otherwise it would hang there forever.
          const undecided = attempt.processorTxnId && order.status === "pending" && !DECIDED_STATUSES.has(st);
          if (st === "PENDING" || st.includes("3DS") || undecided) {
            out.push({ orderId: order.id, attempt: clone(attempt) });
          }
        }
      }
      return out;
    },
    // infra 2026-09-29 honest-charge: attempts whose create call gave no answer (no txn id) on orders still waiting.
    unknownAttempts(processor) { // entries also carry the txn ids already on the order
      const out = [];
      for (const order of data.orders) {
        if (order.status !== "pending") continue;
        for (const attempt of order.attempts || []) {
          if (attempt.processor === processor && attempt.reason === "unknown_outcome" && !attempt.processorTxnId && String(attempt.processorStatus || "").toUpperCase() === "UNKNOWN") {
            out.push({ orderId: order.id, idempotencyKey: order.idempotencyKey, attempt: clone(attempt), knownTxnIds: (order.attempts || []).map((a) => a.processorTxnId).filter(Boolean).map(String) });
          }
        }
      }
      return out;
    },
    snapshot() {
      return clone(data);
    },
    listAbandonedCheckouts() {
      const map = asAbandonedMap(data.abandoned_checkouts);
      return Object.values(clone(map)).sort((a, b) =>
        String(b.last_seen || b.seen_at || "").localeCompare(String(a.last_seen || a.seen_at || "")),
      );
    },
    getAbandonedCheckout(sessionId) {
      const sid = String(sessionId || "").trim();
      if (!sid) return null;
      const map = asAbandonedMap(data.abandoned_checkouts);
      return hasOwn(map, sid) ? clone(map[sid]) : null;
    },
    upsertAbandonedCheckout(record, opts = {}) {
      if (!data.abandoned_checkouts || typeof data.abandoned_checkouts !== "object" || Array.isArray(data.abandoned_checkouts)) {
        data.abandoned_checkouts = {};
      }
      const sid = String(record?.session_id || "").trim();
      if (!sid || UNSAFE_SESSION_IDS.has(sid)) return null; // audit 2026-10-02: assigning "__proto__" would swap the map's prototype
      const prev = hasOwn(data.abandoned_checkouts, sid) ? data.abandoned_checkouts[sid] : undefined;
      const now = record.last_seen || record.seen_at || new Date().toISOString();
      const next = {
        session_id: sid,
        stage: record.stage != null ? String(record.stage) : (prev?.stage || ""),
        customer: record.customer && typeof record.customer === "object" ? clone(record.customer) : (prev?.customer || {}),
        items: Array.isArray(record.items) ? clone(record.items) : (prev?.items || []),
        subtotal: record.subtotal != null ? record.subtotal : (prev?.subtotal ?? "0.00"),
        coupon: record.coupon !== undefined ? clone(record.coupon) : (prev?.coupon ?? null),
        client_timestamp: record.client_timestamp !== undefined ? record.client_timestamp : (prev?.client_timestamp ?? null),
        first_seen: prev?.first_seen || now,
        last_seen: now,
        seen_at: now,
        status: prev?.status === "converted" ? "converted" : "open",
        converted_at: prev?.converted_at || null,
        converted_via: prev?.converted_via || null,
        converted_id: prev?.converted_id || null,
      };
      data.abandoned_checkouts[sid] = next;
      const max = Number(opts.max) > 0 ? Number(opts.max) : ABANDONED_MAX;
      trimAbandonedMap(data.abandoned_checkouts, max, sid);
      persist();
      return clone(next);
    },
    markAbandonedConverted(sessionId, meta = {}) {
      const sid = String(sessionId || "").trim();
      if (!sid) return null;
      if (!data.abandoned_checkouts || typeof data.abandoned_checkouts !== "object") return null;
      if (!hasOwn(data.abandoned_checkouts, sid)) return null;
      const row = data.abandoned_checkouts[sid];
      if (!row) return null;
      row.status = "converted";
      row.converted_at = meta.converted_at || new Date().toISOString();
      row.converted_via = meta.via || meta.converted_via || "checkout";
      row.converted_id = meta.id || meta.converted_id || null;
      persist();
      return clone(row);
    },
    getCryptoState() {
      data.crypto = asCrypto(data.crypto);
      return clone(data.crypto);
    },
    /** Shallow-merge scan / unmatched / alerts (the ledger is only written through claimCryptoTx). */
    saveCryptoState(patch = {}) {
      data.crypto = asCrypto(data.crypto);
      if (patch.scan) data.crypto.scan = clone(patch.scan);
      if (patch.unmatched) data.crypto.unmatched = clone(patch.unmatched).slice(-500);
      if (patch.alerts) data.crypto.alerts = clone(patch.alerts).slice(-500);
      persist();
      return clone(data.crypto);
    },
    /** Claim a chain tx for one order. Returns { ok:true } or { ok:false, orderId } if another order already owns it. */
    claimCryptoTx(key, orderId, meta = {}) {
      data.crypto = asCrypto(data.crypto);
      const k = String(key || "").toLowerCase();
      if (!k) return { ok: false, orderId: null };
      const prev = data.crypto.ledger[k];
      if (prev && prev.orderId !== orderId) return { ok: false, orderId: prev.orderId };
      if (!prev) {
        data.crypto.ledger[k] = { orderId, at: new Date().toISOString(), ...clone(meta) };
        persist();
      }
      return { ok: true, orderId };
    },
    cryptoTxOwner(key) {
      data.crypto = asCrypto(data.crypto);
      return data.crypto.ledger[String(key || "").toLowerCase()]?.orderId || null;
    },
    touchAbandonedDigest(at = new Date().toISOString()) {
      data.abandonedDigestAt = at;
      persist();
      return data.abandonedDigestAt;
    },
  };
}
