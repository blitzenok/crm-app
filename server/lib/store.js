import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const PROCESSOR_IDS = ["umg", "tagada", "centrobill"];
export const ABANDONED_MAX = 500;

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
  };
}

function asAbandonedMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value;
}

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

export function createStore(opts = {}) {
  const memoryOnly = opts.memoryOnly === true;
  const filePath = opts.filePath || null;
  let data = emptyData();

  if (!memoryOnly && filePath && existsSync(filePath)) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf8"));
      data = {
        settings: { ...defaultSettings(), ...(parsed.settings || {}) },
        orders: Array.isArray(parsed.orders) ? parsed.orders : [],
        quotes: Array.isArray(parsed.quotes) ? parsed.quotes : [],
        abandoned_checkouts: asAbandonedMap(parsed.abandoned_checkouts),
        seq: Number(parsed.seq) || 1000,
        quoteSeq: Number(parsed.quoteSeq) || 5000,
        abandonedDigestAt: parsed.abandonedDigestAt || null,
      };
      if (!Array.isArray(data.settings.processors) || data.settings.processors.length === 0) {
        data.settings.processors = defaultSettings().processors;
      }
    } catch {
      data = emptyData();
    }
  }

  function persist() {
    if (memoryOnly || !filePath) return;
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2));
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
      let kill = incoming.killSwitchPsp ?? data.settings.killSwitchPsp;
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
    deleteOrder(id) {
      const i = data.orders.findIndex((o) => o.id === id);
      if (i === -1) return null;
      const [gone] = data.orders.splice(i, 1);
      persist();
      return clone(gone);
    },
    deleteAbandonedCheckout(sessionId) {
      const key = String(sessionId || "");
      if (!key || !data.abandoned_checkouts[key]) return null;
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
    pendingAttempts(processor) {
      const out = [];
      for (const order of data.orders) {
        for (const attempt of order.attempts || []) {
          const st = String(attempt.processorStatus || "").toUpperCase();
          if (attempt.processor === processor && (st === "PENDING" || st.includes("3DS"))) {
            out.push({ orderId: order.id, attempt: clone(attempt) });
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
      const row = asAbandonedMap(data.abandoned_checkouts)[sid];
      return row ? clone(row) : null;
    },
    upsertAbandonedCheckout(record, opts = {}) {
      if (!data.abandoned_checkouts || typeof data.abandoned_checkouts !== "object" || Array.isArray(data.abandoned_checkouts)) {
        data.abandoned_checkouts = {};
      }
      const sid = String(record?.session_id || "").trim();
      if (!sid) return null;
      const prev = data.abandoned_checkouts[sid];
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
      const row = data.abandoned_checkouts[sid];
      if (!row) return null;
      row.status = "converted";
      row.converted_at = meta.converted_at || new Date().toISOString();
      row.converted_via = meta.via || meta.converted_via || "checkout";
      row.converted_id = meta.id || meta.converted_id || null;
      persist();
      return clone(row);
    },
    touchAbandonedDigest(at = new Date().toISOString()) {
      data.abandonedDigestAt = at;
      persist();
      return data.abandonedDigestAt;
    },
  };
}
