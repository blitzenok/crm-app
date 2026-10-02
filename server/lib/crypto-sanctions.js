// OFAC sanctions screening of the wallet(s) that paid a crypto order, before it may be released (2026-09-28, Legal).
// Sources, in order:
//   1. Chainalysis free Sanctions API (needs CHAINALYSIS_API_KEY; GET public.chainalysis.com/api/v1/address/{addr}).
//   2. Local OFAC SDN digital-currency address list (CRYPTO_OFAC_LIST_PATH, default <state dir>/ofac-crypto-addresses.txt),
//      refreshed daily from the 0xB10C list (generated from OFAC's SDN XML). Accepted as the fallback when fresh.
// A match on ANY source -> "match". No usable source -> "unavailable" (the caller holds the order when fail-closed).
import { existsSync, readFileSync, statSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export const OFAC_LIST_URLS = ["ETH", "TRX", "USDT", "USDC"].map(
  (s) => `https://raw.githubusercontent.com/0xB10C/ofac-sanctioned-digital-currency-addresses/lists/sanctioned_addresses_${s}.txt`,
);

export function sanctionsConfig(env = process.env) {
  const stateDir = env.STORE_PATH ? dirname(env.STORE_PATH) : join(dirname(new URL(import.meta.url).pathname), "..", "data");
  const days = Number(env.CRYPTO_OFAC_LIST_MAX_AGE_DAYS);
  return {
    chainalysisKey: String(env.CHAINALYSIS_API_KEY || "").trim(),
    chainalysisUrl: String(env.CHAINALYSIS_API_URL || "https://public.chainalysis.com/api/v1/address").replace(/\/$/, ""),
    listPath: env.CRYPTO_OFAC_LIST_PATH || join(stateDir, "ofac-crypto-addresses.txt"),
    listMaxAgeMs: (Number.isFinite(days) && days > 0 ? days : 14) * 86400e3,
    autoRefresh: env.CRYPTO_OFAC_AUTO_REFRESH !== "false",
    // Fail closed by default: no screening result -> the order is held, never released.
    failClosed: env.CRYPTO_SANCTIONS_FAIL_CLOSED !== "false",
  };
}

const normAddr = (a) => (String(a || "").trim().startsWith("0x") ? String(a).trim().toLowerCase() : String(a || "").trim());

export function parseOfacList(text) {
  const set = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const a = line.trim();
    if (!a || a.startsWith("#")) continue;
    if (/^0x[0-9a-fA-F]{40}$/.test(a) || /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) set.add(normAddr(a));
  }
  return set;
}

export function createSanctionsScreener({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), log = (m) => process.stdout.write(`${m}\n`), fetchTimeoutMs = 15000 } = {}) {
  const cfg = sanctionsConfig(env);
  let cache = { mtimeMs: 0, set: null };
  let lastRefreshTry = 0;

  function localList() {
    if (!existsSync(cfg.listPath)) return null;
    const st = statSync(cfg.listPath);
    if (!cache.set || cache.mtimeMs !== st.mtimeMs) cache = { mtimeMs: st.mtimeMs, set: parseOfacList(readFileSync(cfg.listPath, "utf8")) };
    return { set: cache.set, ageMs: now() - st.mtimeMs, fresh: now() - st.mtimeMs <= cfg.listMaxAgeMs, size: cache.set.size };
  }

  /** Download the OFAC crypto address lists (read-only GETs) and replace the local file atomically. */
  async function refreshList() {
    lastRefreshTry = now();
    const parts = [];
    for (const url of OFAC_LIST_URLS) {
      // audit 2026-10-02 (#352): screen() awaits this refresh (maybeRefresh), so a hung download used to hang the whole crypto tick;
      // every request (headers and body) now has a deadline, and the existing catch in maybeRefresh logs it.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), fetchTimeoutMs);
      try {
        const res = await fetchImpl(url, { headers: { Accept: "text/plain" }, signal: ctl.signal });
        if (!res.ok) throw new Error(`ofac_list_http_${res.status}`);
        parts.push(await res.text());
      } finally {
        clearTimeout(timer);
      }
    }
    const set = parseOfacList(parts.join("\n"));
    if (set.size < 50) throw new Error("ofac_list_too_small");
    mkdirSync(dirname(cfg.listPath), { recursive: true });
    const body = `# OFAC SDN digital currency addresses (ETH/TRX/USDT/USDC), via 0xB10C/ofac-sanctioned-digital-currency-addresses\n# fetched ${new Date(now()).toISOString()}\n${[...set].sort().join("\n")}\n`;
    writeFileSync(`${cfg.listPath}.tmp`, body);
    renameSync(`${cfg.listPath}.tmp`, cfg.listPath);
    cache = { mtimeMs: 0, set: null };
    log(`[crypto-sanctions] OFAC list refreshed: ${set.size} addresses`);
    return { ok: true, size: set.size };
  }

  async function maybeRefresh() {
    if (!cfg.autoRefresh) return null;
    const l = localList();
    if (l && l.ageMs < 24 * 3600e3) return null;
    if (now() - lastRefreshTry < 3600e3) return null; // at most one try per hour
    try { return await refreshList(); } catch (err) { log(`[crypto-sanctions] OFAC list refresh failed: ${err.message}`); return null; }
  }

  async function chainalysis(addr) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 10000);
    try {
      const res = await fetchImpl(`${cfg.chainalysisUrl}/${encodeURIComponent(addr)}`, {
        headers: { "X-API-Key": cfg.chainalysisKey, Accept: "application/json" }, signal: ctl.signal,
      });
      if (!res.ok) throw new Error(`chainalysis_http_${res.status}`);
      const body = await res.json();
      const ids = Array.isArray(body?.identifications) ? body.identifications : [];
      return { match: ids.length > 0, identifications: ids.map((i) => ({ category: i.category, name: i.name })).slice(0, 5) };
    } finally {
      clearTimeout(t);
    }
  }

  /**
   * Screen addresses. Returns { status: "clear"|"match"|"unavailable", sources, matches, screenedAt, errors }.
   */
  async function screen(addresses) {
    const addrs = [...new Set((addresses || []).map(normAddr).filter(Boolean))];
    const out = { status: "unavailable", sources: [], matches: [], errors: [], screenedAt: new Date(now()).toISOString(), addresses: addrs };
    if (!addrs.length) { out.errors.push("no_sender_address"); return out; }
    let chainalysisOk = false;
    if (cfg.chainalysisKey) {
      try {
        for (const a of addrs) {
          const r = await chainalysis(a);
          if (r.match) out.matches.push({ address: a, source: "chainalysis", identifications: r.identifications });
        }
        chainalysisOk = true;
        out.sources.push("chainalysis");
      } catch (err) {
        out.errors.push(err.message);
      }
    } else {
      out.errors.push("chainalysis_api_key_missing");
    }
    await maybeRefresh();
    const l = localList();
    let listOk = false;
    if (l) {
      for (const a of addrs) if (l.set.has(a)) out.matches.push({ address: a, source: "ofac_sdn_list" });
      if (l.fresh) { listOk = true; out.sources.push("ofac_sdn_list"); }
      else out.errors.push("ofac_list_stale");
    } else {
      out.errors.push("ofac_list_missing");
    }
    if (out.matches.length) out.status = "match";
    else if (chainalysisOk || listOk) out.status = "clear";
    return out;
  }

  return { screen, refreshList, localList, config: cfg };
}
