// Mocked chain adapters + sanctions screener for crypto verification tests (no network).
import { unitsToAmount } from "../lib/crypto-chains.js";

export const USDT_TRC = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const USDC_TRC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";
export const USDT_ERC = "0xdac17f958d2ee523a2206206994597c13d831ec7";
export const USDC_ERC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const TOKEN_OF = { [USDT_TRC]: "USDT", [USDC_TRC]: "USDC", [USDT_ERC]: "USDT", [USDC_ERC]: "USDC" };

export function createMockChain(network, { latest = 1000, failWith = null } = {}) {
  const txs = new Map();
  const chain = {
    network,
    latest,
    failWith,
    calls: { latestBlock: 0, getTransfers: 0, listIncoming: 0 },
    /** Add a tx: { hash, to, from, units, contract?, blockNumber?, success?, timestamp? } */
    addTx(tx) {
      const contract = tx.contract || (network === "trc20" ? USDT_TRC : USDT_ERC);
      txs.set(String(tx.hash).toLowerCase(), {
        blockNumber: tx.blockNumber ?? chain.latest, success: tx.success ?? true, timestamp: tx.timestamp ?? Date.now(),
        transfers: [{ to: tx.to, from: tx.from || (network === "trc20" ? "TSenderAddr1111111111111111111111" : `0x${"11".repeat(20)}`), units: String(tx.units), contract }],
      });
    },
    async latestBlock() { chain.calls.latestBlock += 1; if (chain.failWith) throw new Error(chain.failWith); return chain.latest; },
    async getTransfers(hash, { latest: head } = {}) {
      chain.calls.getTransfers += 1;
      if (chain.failWith) throw new Error(chain.failWith);
      const t = txs.get(String(hash).toLowerCase());
      if (!t) return null;
      const h = head ?? chain.latest;
      return {
        txHash: String(hash).toLowerCase(), success: t.success, blockNumber: t.blockNumber, timestamp: t.timestamp,
        transfers: t.transfers.map((x, i) => ({
          network, txHash: String(hash).toLowerCase(), logIndex: i, contract: x.contract, token: TOKEN_OF[x.contract] || null, decimals: 6,
          from: x.from, to: x.to, units: x.units, amount: unitsToAmount(x.units, 6), blockNumber: t.blockNumber, timestamp: t.timestamp,
          success: t.success, confirmations: Math.max(0, h - t.blockNumber),
        })),
      };
    },
    async listIncoming(address, opts = {}) {
      chain.calls.listIncoming += 1;
      if (chain.failWith) throw new Error(chain.failWith);
      const out = [];
      for (const [hash, t] of txs) {
        if (!t.success) continue;
        t.transfers.forEach((x, i) => {
          if (x.to !== address) return;
          if (opts.sinceMs && t.timestamp < opts.sinceMs) return;
          out.push({
            network, txHash: hash, logIndex: network === "trc20" ? null : i, contract: x.contract, token: TOKEN_OF[x.contract] || null, decimals: 6,
            from: x.from, to: x.to, units: x.units, amount: unitsToAmount(x.units, 6),
            blockNumber: network === "trc20" ? null : t.blockNumber, timestamp: t.timestamp,
            success: network === "trc20" ? null : true, confirmations: network === "trc20" ? null : Math.max(0, chain.latest - t.blockNumber),
          });
        });
      }
      return network === "trc20" ? out : { transfers: out, toBlock: chain.latest };
    },
  };
  return chain;
}

export function createMockScreener({ status = "clear", failClosed = true, matches = [] } = {}) {
  const s = {
    status, calls: 0, screened: [],
    config: { failClosed },
    localList: () => null,
    async screen(addresses) {
      s.calls += 1;
      s.screened.push(...addresses);
      return { status: s.status, sources: s.status === "unavailable" ? [] : ["mock"], matches: s.status === "match" ? (matches.length ? matches : addresses.map((a) => ({ address: a, source: "mock" }))) : [], errors: s.status === "unavailable" ? ["mock_unavailable"] : [], screenedAt: new Date().toISOString(), addresses };
    },
  };
  return s;
}
