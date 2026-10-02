// Read-only on-chain lookups for USDT deposits (2026-09-28). No keys needed for the defaults:
//   TRON  (TRC-20): TronGrid public API (TRONGRID_API_KEY optional, sent as TRON-PRO-API-KEY for a higher rate limit)
//   Ethereum (ERC-20): keyless public JSON-RPC (CRYPTO_ETH_RPC_URL, default publicnode)
// Every function returns normalised transfers:
//   { network, txHash, logIndex, contract, token, decimals, from, to, units (string, integer micro-units),
//     amount (decimal string), blockNumber, timestamp (ms), success, confirmations }
// Nothing here can move funds: there are no keys, no signing and no write calls.
import { createHash } from "node:crypto";

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// Token contracts we RECOGNISE on each network. Recognising is not accepting: USDC on TRC20 stays listed only so a
// deposit of it is seen and sent to staff review (wrong_token) instead of being silently ignored.
export const TOKENS = {
  trc20: {
    TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: { token: "USDT", decimals: 6 },
    TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8: { token: "USDC", decimals: 6 }, // USDC_TRC: recognised, NOT accepted (2026-09-28)
  },
  erc20: {
    "0xdac17f958d2ee523a2206206994597c13d831ec7": { token: "USDT", decimals: 6 },
    "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": { token: "USDC", decimals: 6 },
  },
};

// Tokens that can ever be ACCEPTED per network (2026-09-28, owner decision): USDT on TRC20 + ERC20, USDC on ERC20 only.
// CRYPTO_ACCEPTED_TOKENS (env) further narrows this; it can never widen it.
export const ACCEPTABLE_TOKENS = Object.freeze({ trc20: Object.freeze(["USDT"]), erc20: Object.freeze(["USDT", "USDC"]) });

export function explorerTxUrl(network, txHash) {
  if (!txHash) return null;
  if (network === "trc20") return `https://tronscan.org/#/transaction/${encodeURIComponent(txHash.replace(/^0x/, ""))}`;
  if (network === "erc20") return `https://etherscan.io/tx/${encodeURIComponent(txHash)}`;
  return null;
}

export function explorerAddressUrl(network, addr) {
  if (!addr) return null;
  if (network === "trc20") return `https://tronscan.org/#/address/${encodeURIComponent(addr)}`;
  if (network === "erc20") return `https://etherscan.io/address/${encodeURIComponent(addr)}`;
  return null;
}

export function unitsToAmount(units, decimals = 6) {
  const s = BigInt(units).toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/** "158.37" -> 158370000n (decimals 6). Rejects anything that is not a plain non-negative decimal. */
export function amountToUnits(amount, decimals = 6) {
  const s = String(amount ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("invalid_amount");
  const [i, f = ""] = s.split(".");
  if (f.length > decimals && /[1-9]/.test(f.slice(decimals))) throw new Error("too_many_decimals");
  return BigInt(i) * 10n ** BigInt(decimals) + BigInt((f.slice(0, decimals)).padEnd(decimals, "0") || "0");
}

// ---- TRON base58check <-> hex -------------------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sha256 = (buf) => createHash("sha256").update(buf).digest();

export function tronToHex(addr) {
  let n = 0n;
  for (const ch of String(addr)) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error("invalid_tron_address");
    n = n * 58n + BigInt(v);
  }
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const buf = Buffer.from(hex, "hex");
  if (buf.length !== 25) throw new Error("invalid_tron_address");
  const body = buf.subarray(0, 21);
  const check = buf.subarray(21);
  if (!sha256(sha256(body)).subarray(0, 4).equals(check)) throw new Error("invalid_tron_checksum");
  return body.toString("hex"); // 41 + 20 bytes
}

export function hexToTron(hex) {
  let h = String(hex).replace(/^0x/, "").toLowerCase();
  if (h.length === 40) h = `41${h}`;
  const body = Buffer.from(h, "hex");
  const full = Buffer.concat([body, sha256(sha256(body)).subarray(0, 4)]);
  let n = BigInt(`0x${full.toString("hex")}`);
  let out = "";
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  for (const b of full) { if (b === 0) out = `1${out}`; else break; }
  return out;
}

const topicAddr = (t) => String(t || "").replace(/^0x/, "").slice(-40).toLowerCase();

// ---- pacing (rate limit) -------------------------------------------------------------------------------
function pacer(minGapMs) {
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + minGapMs;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  };
}

async function fetchJson(fetchImpl, url, init = {}, timeoutMs = 15000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { ...init, signal: ctl.signal });
    if (res.status === 429) { const e = new Error("rate_limited"); e.kind = "rate_limited"; throw e; }
    if (!res.ok) { const e = new Error(`http_${res.status}`); e.kind = "http"; throw e; }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ---- TRON ----------------------------------------------------------------------------------------------
export function createTronAdapter({ env = process.env, fetchImpl = globalThis.fetch, minGapMs } = {}) {
  const base = String(env.CRYPTO_TRONGRID_URL || "https://api.trongrid.io").replace(/\/$/, "");
  const key = String(env.TRONGRID_API_KEY || "").trim();
  const pace = pacer(Number(minGapMs ?? env.CRYPTO_API_MIN_GAP_MS ?? 400));
  const headers = { Accept: "application/json", "Content-Type": "application/json", ...(key ? { "TRON-PRO-API-KEY": key } : {}) };
  const get = async (path) => { await pace(); return fetchJson(fetchImpl, `${base}${path}`, { headers }); };
  const post = async (path, body) => { await pace(); return fetchJson(fetchImpl, `${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }); };

  async function latestBlock() {
    const b = await post("/wallet/getnowblock", {});
    const n = Number(b?.block_header?.raw_data?.number);
    if (!Number.isFinite(n)) throw new Error("tron_no_block");
    return n;
  }

  /** All TRC-20 Transfer logs of one tx (any recipient), with success + confirmations. null = unknown / not yet mined. */
  async function getTransfers(txHash, { latest } = {}) {
    const id = String(txHash).replace(/^0x/, "").toLowerCase();
    const info = await post("/wallet/gettransactioninfobyid", { value: id });
    if (!info || !info.id || !Number.isFinite(Number(info.blockNumber))) return null;
    const head = latest ?? await latestBlock();
    const success = String(info?.receipt?.result || "") === "SUCCESS";
    const out = [];
    (info.log || []).forEach((log, i) => {
      if (!log.topics || String(log.topics[0]).replace(/^0x/, "") !== TRANSFER_TOPIC.slice(2)) return;
      if (log.topics.length < 3) return;
      const contract = hexToTron(`41${String(log.address).replace(/^0x/, "").slice(-40)}`);
      const meta = TOKENS.trc20[contract] || null;
      const units = BigInt(`0x${String(log.data || "0").replace(/^0x/, "") || "0"}`).toString();
      out.push({
        network: "trc20", txHash: id, logIndex: i, contract, token: meta?.token || null, decimals: meta?.decimals ?? null,
        from: hexToTron(topicAddr(log.topics[1])), to: hexToTron(topicAddr(log.topics[2])),
        units, amount: meta ? unitsToAmount(units, meta.decimals) : null,
        blockNumber: Number(info.blockNumber), timestamp: Number(info.blockTimeStamp) || null,
        success, confirmations: Math.max(0, head - Number(info.blockNumber)),
      });
    });
    return { txHash: id, success, blockNumber: Number(info.blockNumber), timestamp: Number(info.blockTimeStamp) || null, transfers: out };
  }

  /**
   * Incoming TRC-20 transfers to `address` since `sinceMs` (known tokens only; blockNumber filled in later).
   * audit 2026-10-02 (#392): the page limit (maxPages x 200 rows, ALL tokens, spam included) can end the read before the newest rows;
   * the array then carries `truncated: true` and `lastTimestamp` (newest row actually read, any token) so the caller can resume there
   * instead of treating the scan as complete.
   */
  async function listIncoming(address, { sinceMs, maxPages = 5 } = {}) {
    const out = [];
    let lastTs = 0;
    let fp = "";
    for (let page = 0; page < maxPages; page += 1) {
      const q = new URLSearchParams({ only_to: "true", limit: "200", order_by: "block_timestamp,asc" });
      if (sinceMs) q.set("min_timestamp", String(Math.floor(sinceMs)));
      if (fp) q.set("fingerprint", fp);
      const r = await get(`/v1/accounts/${encodeURIComponent(address)}/transactions/trc20?${q}`);
      if (r && r.success === false) throw new Error("tron_list_failed");
      for (const t of r?.data || []) {
        lastTs = Math.max(lastTs, Number(t?.block_timestamp) || 0);
        const contract = t?.token_info?.address;
        const meta = TOKENS.trc20[contract];
        if (!meta || t.type !== "Transfer" || t.to !== address) continue;
        out.push({
          network: "trc20", txHash: String(t.transaction_id).toLowerCase(), logIndex: null, contract, token: meta.token,
          decimals: meta.decimals, from: t.from, to: t.to, units: String(t.value), amount: unitsToAmount(String(t.value), meta.decimals),
          blockNumber: null, timestamp: Number(t.block_timestamp) || null, success: null, confirmations: null,
        });
      }
      fp = r?.meta?.fingerprint || "";
      if (!fp) break;
    }
    if (fp) { out.truncated = true; out.lastTimestamp = lastTs || null; } // the loop ended on maxPages with more rows waiting
    return out;
  }

  return { network: "trc20", latestBlock, getTransfers, listIncoming };
}

// ---- Ethereum ------------------------------------------------------------------------------------------
export function createEthAdapter({ env = process.env, fetchImpl = globalThis.fetch, minGapMs } = {}) {
  // Comma-separated list; the next URL is tried when one errors (or, for receipts, answers null: some public nodes prune).
  const urls = String(env.CRYPTO_ETH_RPC_URL || "https://ethereum-rpc.publicnode.com,https://eth.drpc.org")
    .split(",").map((u) => u.trim()).filter((u) => /^https:\/\//.test(u));
  const pace = pacer(Number(minGapMs ?? env.CRYPTO_API_MIN_GAP_MS ?? 400));
  let id = 0;
  async function rpcAt(url, method, params) {
    await pace();
    const r = await fetchJson(fetchImpl, url, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    });
    if (r?.error) { const e = new Error(`rpc_${r.error.code}`); e.kind = "rpc"; throw e; }
    return r?.result;
  }
  async function rpc(method, params, { nullIsMiss = false } = {}) {
    let lastErr = null;
    for (const url of urls) {
      try {
        const out = await rpcAt(url, method, params);
        if (out == null && nullIsMiss) continue;
        return out;
      } catch (err) { lastErr = err; }
    }
    if (lastErr && !nullIsMiss) throw lastErr;
    if (lastErr) throw lastErr;
    return null;
  }
  const blockTs = new Map();
  async function timestampOf(blockNumber) {
    if (blockTs.has(blockNumber)) return blockTs.get(blockNumber);
    const b = await rpc("eth_getBlockByNumber", [`0x${blockNumber.toString(16)}`, false]);
    const ts = b ? Number(BigInt(b.timestamp)) * 1000 : null;
    if (blockTs.size > 500) blockTs.clear();
    blockTs.set(blockNumber, ts);
    return ts;
  }
  async function latestBlock() { return Number(BigInt(await rpc("eth_blockNumber", []))); }

  function fromLog(log, head, success = true, ts = null) {
    const contract = String(log.address).toLowerCase();
    const meta = TOKENS.erc20[contract] || null;
    const units = BigInt(log.data && log.data !== "0x" ? log.data : "0x0").toString();
    const bn = Number(BigInt(log.blockNumber));
    return {
      network: "erc20", txHash: String(log.transactionHash).toLowerCase(), logIndex: Number(BigInt(log.logIndex)), contract,
      token: meta?.token || null, decimals: meta?.decimals ?? null,
      from: `0x${topicAddr(log.topics[1])}`, to: `0x${topicAddr(log.topics[2])}`,
      units, amount: meta ? unitsToAmount(units, meta.decimals) : null,
      blockNumber: bn, timestamp: ts, success, confirmations: Math.max(0, head - bn),
    };
  }

  async function getTransfers(txHash, { latest } = {}) {
    const h = String(txHash).toLowerCase();
    const rc = await rpc("eth_getTransactionReceipt", [h.startsWith("0x") ? h : `0x${h}`], { nullIsMiss: true });
    if (!rc || !rc.blockNumber) return null;
    const head = latest ?? await latestBlock();
    const success = rc.status === "0x1";
    const bn = Number(BigInt(rc.blockNumber));
    const ts = await timestampOf(bn);
    const transfers = (rc.logs || [])
      .filter((l) => String(l.topics?.[0]).toLowerCase() === TRANSFER_TOPIC && (l.topics || []).length >= 3)
      .map((l) => fromLog(l, head, success, ts));
    return { txHash: String(rc.transactionHash).toLowerCase(), success, blockNumber: bn, timestamp: ts, transfers };
  }

  /** Incoming USDT/USDC Transfer logs to `address` in [fromBlock, toBlock] (chunked). */
  async function listIncoming(address, { fromBlock, toBlock, chunk = 500 } = {}) {
    const head = toBlock ?? await latestBlock();
    const to = `0x${String(address).toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const out = [];
    for (let a = fromBlock; a <= head; a += chunk) {
      const b = Math.min(head, a + chunk - 1);
      const logs = await rpc("eth_getLogs", [{
        fromBlock: `0x${a.toString(16)}`, toBlock: `0x${b.toString(16)}`,
        address: Object.keys(TOKENS.erc20), topics: [TRANSFER_TOPIC, null, to],
      }]);
      for (const l of logs || []) {
        if (l.removed) continue;
        const bn = Number(BigInt(l.blockNumber));
        out.push(fromLog(l, head, true, await timestampOf(bn)));
      }
    }
    return { transfers: out, toBlock: head };
  }

  return { network: "erc20", latestBlock, getTransfers, listIncoming };
}

export function createChainAdapters(opts = {}) {
  return { trc20: createTronAdapter(opts), erc20: createEthAdapter(opts) };
}
