// Crypto "awaiting payment" launch contract (2026-09-30, Yehuda):
//   POST /api/checkout/crypto                     -> order_id, amount_usd (2dp, unique cents), networks[], expires_at (24h), status_token
//   GET  /api/checkout/crypto/:order_id/status    -> {status: awaiting|paid|expired} (status_token required, no PII)
//   POST /api/checkout/crypto/:order_id/txid      -> customer TxID -> order status payment_submitted (never paid)
//   Staff: admin-only "Mark crypto paid" (tx hash + network) after a 4-point on-chain check, or a logged admin override.
// Wallet addresses come only from the service env (CRYPTO_USDT_ERC / CRYPTO_USDT_TRC).
import { PAY, cryptoVerifyConfig, paymentDeadline, isCryptoVerified, isTokenAccepted, verifyConfirmToken } from "./crypto-payment.js";
import { explorerTxUrl, amountToUnits } from "./crypto-chains.js";
import { depositWallets } from "./crypto-checkout.js";
import { bearerToken, fetchCrmSession, actorFromSession, marketingDigestKeyOk } from "./operator-auth.js";

export const PAYMENT_SUBMITTED = "payment_submitted";
export const TXID_RE = Object.freeze({ erc20: /^0x[0-9a-fA-F]{64}$/, trc20: /^[0-9a-fA-F]{64}$/ });
export const NETWORK_LABEL = Object.freeze({ erc20: "Ethereum (ERC-20)", trc20: "TRON (TRC-20)" });

const lc = (s) => String(s || "").toLowerCase();
const bare = (h) => lc(h).replace(/^0x/, "");

/** Strict customer/admin TxID format: ERC-20 = 0x + 64 hex, TRC-20 = 64 hex. Returns the lower-cased hash or null. */
export function normalizeTxid(network, raw) {
  const s = String(raw ?? "").trim();
  if (!TXID_RE[network] || !TXID_RE[network].test(s)) return null;
  return lc(s);
}

/** "158.37" from pay units (6 dp). null when the amount is not a whole number of cents. */
export function amountUsd2dp(payUnits) {
  let u;
  try { u = BigInt(String(payUnits)); } catch { return null; }
  if (u % 10000n !== 0n) return null;
  const cents = u / 10000n;
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

/** Networks the customer may pay on, from the env wallets and CRYPTO_ACCEPTED_TOKENS (USDC never on TRC-20). */
export function paymentNetworks(env = process.env) {
  const w = depositWallets(env);
  const cfg = cryptoVerifyConfig(env);
  const out = [];
  const erc = cfg.acceptedByNetwork.erc20 || [];
  const trc = cfg.acceptedByNetwork.trc20 || [];
  if (w.usdtErc20 && erc.length) out.push({ token: erc.join("/"), network: NETWORK_LABEL.erc20, network_id: "erc20", address: w.usdtErc20 });
  if (w.usdtTrc20 && trc.length) out.push({ token: trc.join("/"), network: NETWORK_LABEL.trc20, network_id: "trc20", address: w.usdtTrc20 });
  return out;
}

export function statusPathFor(orderRef) { return `/api/checkout/crypto/${encodeURIComponent(orderRef)}/status`; }

/** Contract fields added to the POST /api/checkout/crypto answer (the old fields stay for the current checkout JS). */
export function launchFields(order, env = process.env, statusToken = null) {
  const cp = order.cryptoPayment || {};
  const base = String(env.CRM_PUBLIC_URL || "").replace(/\/$/, "");
  return {
    order_id: order.orderRef,
    amount_usd: amountUsd2dp(cp.payUnits) || String(cp.payAmount || ""),
    networks: paymentNetworks(env).map(({ token, network, address }) => ({ token, network, address })),
    expires_at: cp.expiresAt || null,
    ...(statusToken ? { status_token: statusToken } : {}),
    status_url: `${base}${statusPathFor(order.orderRef)}`,
    txid_url: `${base}/api/checkout/crypto/${encodeURIComponent(order.orderRef)}/txid`,
  };
}

/** awaiting | paid | expired. A submitted TxID keeps the order "awaiting" (tx_submitted: true) until an admin marks it paid. */
export function launchStatus(order, env = process.env, nowMs = Date.now()) {
  const cp = order.cryptoPayment || {};
  const cfg = cryptoVerifyConfig(env);
  let status = "awaiting";
  if (isCryptoVerified(order)) status = "paid";
  else if (cp.status === PAY.CANCELLED && !cp.customerTx) status = "expired";
  else if (!cp.customerTx && (cp.status === PAY.AWAITING) && cp.expiresAt && nowMs > paymentDeadline(cp, cfg)) status = "expired";
  return { ok: true, order_id: order.orderRef, status, tx_submitted: Boolean(cp.customerTx), expires_at: cp.expiresAt || null };
}

export function orderTokenFrom(req, url, body = null) {
  const h = req.headers["x-order-token"];
  return String((body && (body.token || body.status_token)) || url.searchParams.get("token") || (typeof h === "string" ? h : "") || "");
}

export function tokenOk(order, token, secret) {
  if (!order || order.paymentMethod !== "crypto" || !order.cryptoPayment) return false;
  try { return verifyConfirmToken(order, token, secret); } catch { return false; }
}

/**
 * The order (other than `exceptId`) that really owns this tx hash: an attached transfer that is not provisional (`unclaimed`),
 * or a recorded admin mark-paid / paid tx. audit 2026-10-02: what another buyer merely typed (hint, customer TxID, provisional
 * transfer) is NOT ownership, otherwise anybody can lock the real payer out by entering a public hash first. The ledger owner
 * (store.cryptoTxOwner) is checked by the caller. `weakEmail`: the same buyer's own typed records (same e-mail) still count, so one
 * buyer cannot submit one TxID for two of his orders.
 */
export function findTxOwner(orders, hash, exceptId = null, { weakEmail = null } = {}) {
  const h = bare(hash);
  if (!h) return null;
  const email = String(weakEmail || "").trim().toLowerCase();
  for (const o of orders) {
    if (!o || o.id === exceptId || o.paymentMethod !== "crypto") continue;
    const cp = o.cryptoPayment || {};
    const strong = [cp.adminMarkPaid?.txHash, o.crypto?.txHash, ...(cp.transfers || []).filter((x) => !x.unclaimed).map((x) => x.txHash)];
    if (strong.some((x) => x && bare(x) === h)) return o.id;
    if (!email || String(o.customer?.email || "").trim().toLowerCase() !== email) continue;
    const weak = [cp.customerTx?.hash, ...(cp.customerTxHistory || []).map((x) => x.hash), ...(cp.txHints || []).map((x) => x.hash), ...(cp.transfers || []).filter((x) => x.unclaimed).map((x) => x.txHash)];
    if (weak.some((x) => x && bare(x) === h)) return o.id;
  }
  return null;
}

/**
 * Four-point on-chain check of ONE tx for an order: recipient = our wallet, token = USDT/USDC with the known contract
 * (and accepted on that network), amount = the order's unique amount, confirmed (success + required confirmations).
 * Read-only: TRC-20 via TronGrid public API, ERC-20 via keyless public RPC (Transfer logs of the receipt).
 */
export async function checkTx(adapters, order, network, hash, env = process.env) {
  const cfg = cryptoVerifyConfig(env);
  const cp = order.cryptoPayment || {};
  const w = depositWallets(env);
  const wallet = network === "erc20" ? w.usdtErc20 : network === "trc20" ? w.usdtTrc20 : null;
  const red = (detail) => ({ ok: false, detail });
  const out = {
    at: new Date().toISOString(), network, txHash: hash, explorerUrl: explorerTxUrl(network, hash), found: false, green: false,
    checks: { recipient: red("not checked"), token: red("not checked"), amount: red("not checked"), confirmed: red("not checked") },
    warnings: [], received: "0.00", transfers: [], error: null,
  };
  if (!wallet || !adapters?.[network]) { out.error = "network_not_configured"; return out; }
  let r;
  try { r = await adapters[network].getTransfers(hash); } catch (err) { out.error = "chain_unavailable"; out.errorDetail = String(err?.message || err).slice(0, 120); return out; }
  if (!r) { out.error = "tx_not_found"; for (const k of Object.keys(out.checks)) out.checks[k] = red("tx not found on-chain (or not mined yet)"); return out; }
  out.found = true;
  const all = r.transfers || [];
  const toUs = all.filter((t) => lc(t.to) === lc(wallet));
  out.checks.recipient = toUs.length ? { ok: true, detail: `pays ${wallet}` } : red(all.length ? `token transfer goes to ${all.map((t) => t.to).join(", ")}` : "no token transfer in this tx");
  const good = toUs.filter((t) => t.token && isTokenAccepted(cfg, t.token, network, cp));
  out.checks.token = good.length ? { ok: true, detail: `${[...new Set(good.map((t) => t.token))].join("/")} contract ${[...new Set(good.map((t) => t.contract))].join(", ")}` }
    : red(toUs.length ? `unaccepted token/contract ${toUs.map((t) => t.contract).join(", ")}` : "no transfer to our wallet");
  const sum = good.reduce((s, t) => s + BigInt(t.units || "0"), 0n);
  const due = BigInt(cp.payUnits || "0");
  out.received = amountUsd2dp(sum) || (Number(sum) / 1e6).toFixed(6);
  const diff = sum > due ? sum - due : due - sum;
  out.checks.amount = good.length && diff <= cfg.toleranceUnits ? { ok: true, detail: `${out.received} = due ${amountUsd2dp(due) || cp.payAmount}` }
    : red(`received ${out.received}, due ${amountUsd2dp(due) || cp.payAmount}`);
  const need = cfg.confirmations[network] ?? 20;
  const conf = good.length ? Math.min(...good.map((t) => Number(t.confirmations) || 0)) : Number(r.transfers?.[0]?.confirmations) || 0;
  const success = r.success !== false && good.every((t) => t.success !== false);
  out.checks.confirmed = success && good.length && conf >= need ? { ok: true, detail: `${conf}/${need} confirmations` } : red(success ? `${conf}/${need} confirmations` : "tx failed on-chain");
  const created = Date.parse(cp.createdAt || order.createdAt || 0);
  const ts = good.map((t) => t.timestamp).filter(Boolean);
  if (ts.length && Math.min(...ts) < created - cfg.clockSkewMs) out.warnings.push("tx_before_order");
  out.transfers = good;
  out.green = Object.values(out.checks).every((c) => c.ok) && !out.warnings.length;
  return out;
}

/** Summary for storage / staff view (transfer objects trimmed). */
export function checkSummary(c) {
  if (!c) return null;
  const { transfers, ...rest } = c;
  return { ...rest, transferCount: (transfers || []).length };
}

/** Admin gate: CRM session whose user role is "admin". The marketing key is NOT an admin. */
export async function resolveAdmin(req, opts = {}) {
  if (marketingDigestKeyOk(req, opts.env || process.env)) return { ok: false, admin: false, actor: "marketing-key", error: "admin_required" };
  const token = bearerToken(req);
  if (!token) return { ok: false, admin: false, actor: null, error: "unauthorized" };
  let data = null;
  if (typeof opts.checkCrmSession === "function") {
    try { data = await opts.checkCrmSession(token); } catch { data = null; }
    if (!data) return { ok: false, admin: false, actor: null, error: "unauthorized" };
  } else {
    const s = await fetchCrmSession(token, opts);
    if (!s.ok) return { ok: false, admin: false, actor: null, error: "unauthorized" };
    data = s.data;
  }
  const role = (data && typeof data === "object" && ((data.user && data.user.role) || data.role)) || null;
  const actor = (data && typeof data === "object" && actorFromSession(data)) || "crm-session";
  if (role !== "admin") return { ok: false, admin: false, actor, error: "admin_required" };
  return { ok: true, admin: true, actor };
}
