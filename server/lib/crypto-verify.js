// On-chain verification of crypto (USDT) orders, 60-minute timeout, review states, staff actions (2026-09-28).
//
// State machine (order.cryptoPayment.status, mirrored in order.paymentStatus):
//   awaiting_payment -> confirming -> paid (fulfillment ready_to_ship)            only path to shipping
//                    \-> payment_review   partial / overpaid / wrong token / wrong network / late / tx reuse attempt
//                    \-> sanctions_review sender on OFAC list (no ship, no auto refund, alert)
//                    \-> screening_hold   verified but sanctions screening unavailable (fail-closed default)
//   awaiting_payment -(60 min, +grace after customer confirm, no tx seen)-> cancelled (+ "Payment not received" email)
//   cancelled + later payment -> payment_review (late_payment; never auto-ships)
// A customer-entered tx hash is only a lookup hint. Every release needs a transfer that the chain itself reports.
import { depositWallets, readyFulfillment, blockedFulfillment, CRYPTO_PAID, AWAITING_CRYPTO, CRYPTO_REVIEW, CRYPTO_CANCELLED } from "./crypto-checkout.js";
import { PAY, OPEN_STATUSES, cryptoVerifyConfig, paymentDeadline, fixed, normalizeHint } from "./crypto-payment.js";
import { createChainAdapters, explorerTxUrl, explorerAddressUrl, amountToUnits } from "./crypto-chains.js";
import { createSanctionsScreener } from "./crypto-sanctions.js";
import { sendCancelEmail, sendInternalAlert, sendGa4Purchase } from "./crypto-notify.js";

const NETWORKS = ["trc20", "erc20"];
const DUST_UNITS = 1_000_000n; // < 1 USDT: never auto-attributed, never alerted (address-poisoning dust is common)

const lc = (a) => (String(a || "").startsWith("0x") ? String(a).toLowerCase() : String(a || ""));
const nowIso = (ms) => new Date(ms).toISOString();

export function orderNetworks(order, wallets) {
  const n = order.cryptoPayment?.network;
  const list = n ? [n] : NETWORKS;
  return list.filter((x) => (x === "trc20" ? wallets.usdtTrc20 : wallets.usdtErc20));
}

function walletFor(network, wallets) {
  return network === "trc20" ? wallets.usdtTrc20 : network === "erc20" ? wallets.usdtErc20 : null;
}

/** Pure evaluation of the transfers attached to an order. Does not screen sanctions. */
export function evaluatePayment(order, cfg) {
  const cp = order.cryptoPayment || {};
  const transfers = (cp.transfers || []).filter((t) => t.success !== false);
  const reasons = [];
  const required = (n) => cfg.confirmations[n] ?? 20;
  const accepted = transfers.filter((t) => cfg.acceptedTokens.includes(t.token) && !t.wrongNetwork && (!cp.network || t.network === cp.network));
  const wrong = transfers.filter((t) => !accepted.includes(t));
  for (const t of wrong) reasons.push(t.wrongNetwork || (cp.network && t.network !== cp.network) ? "wrong_network" : "wrong_token");
  const sum = accepted.reduce((s, t) => s + BigInt(t.units || "0"), 0n);
  const pay = BigInt(cp.payUnits || "0");
  const pending = accepted.some((t) => t.success !== true || !Number.isFinite(t.confirmations) || t.confirmations < required(t.network) || !t.finalChecked);
  const minConf = accepted.length ? Math.min(...accepted.map((t) => Number(t.confirmations) || 0)) : 0;
  const out = { sumUnits: sum.toString(), received: fixed(sum), minConf, accepted, wrong, reasons, pending };
  if (!transfers.length) return { ...out, next: null };
  if (cp.status === PAY.CANCELLED) return { ...out, next: PAY.REVIEW, reasons: [...reasons, "late_payment"] };
  if (wrong.length) return { ...out, next: PAY.REVIEW };
  if (pending) return { ...out, next: PAY.CONFIRMING };
  if (sum + cfg.toleranceUnits < pay) return { ...out, next: PAY.REVIEW, reasons: [...reasons, "partial_payment"] };
  if (sum > pay + cfg.overpayToleranceUnits) return { ...out, next: PAY.REVIEW, reasons: [...reasons, "overpaid"] };
  return { ...out, next: "screen" };
}

export function staffCryptoView(order, env = process.env) {
  const cp = order.cryptoPayment || {};
  const cfg = cryptoVerifyConfig(env);
  const c = order.customer || {};
  const received = cp.receivedAmount || "0.00";
  let delta = null;
  try { delta = (Number(amountToUnits(received)) - Number(cp.payUnits || 0)) / 1e6; } catch { /* legacy */ }
  return {
    id: order.id,
    orderRef: order.orderRef,
    test: order.test === true,
    createdAt: order.createdAt,
    customer: { name: [c.first_name, c.last_name].filter(Boolean).join(" "), email: c.email || "" },
    orderStatus: order.status,
    paymentStatus: cp.status || order.paymentStatus || null,
    fulfillment: order.fulfillment?.status || null,
    shippable: order.fulfillment?.shippable === true,
    amountUsd: order.amount,
    payAmount: cp.payAmount || order.amountDue || null,
    payAmountUnits: cp.payUnits || null,
    token: cp.token || "USDT",
    network: cp.network || null,
    wallet: cp.wallet || null,
    walletUrl: explorerAddressUrl(cp.network, cp.wallet),
    receivedAmount: received,
    amountDelta: delta == null ? null : delta.toFixed(6),
    confirmations: (cp.transfers || []).length ? Math.min(...cp.transfers.map((t) => Number(t.confirmations) || 0)) : 0,
    requiredConfirmations: cp.requiredConfirmations || (cp.network ? cfg.confirmations[cp.network] : null),
    expiresAt: cp.expiresAt || null,
    cancelAt: cp.expiresAt ? nowIso(paymentDeadline(cp, cfg)) : null,
    customerConfirmed: Boolean(cp.customerConfirmedAt),
    customerConfirmedAt: cp.customerConfirmedAt || null,
    txHints: (cp.txHints || []).map((h) => ({ ...h, explorerUrl: explorerTxUrl(h.network || cp.network, h.hash) })),
    transfers: (cp.transfers || []).map((t) => ({
      txHash: t.txHash, explorerUrl: explorerTxUrl(t.network, t.txHash), network: t.network, token: t.token, amount: t.amount,
      from: t.from, fromUrl: explorerAddressUrl(t.network, t.from), confirmations: t.confirmations, required: cfg.confirmations[t.network] ?? null,
      success: t.success, finalChecked: Boolean(t.finalChecked), matchedBy: t.matchedBy, wrongNetwork: Boolean(t.wrongNetwork), seenAt: t.seenAt,
      blockNumber: t.blockNumber, timestamp: t.timestamp ? nowIso(t.timestamp) : null,
    })),
    reviewReasons: cp.reviewReasons || [],
    latePayment: Boolean(cp.latePayment),
    sanctions: cp.sanctions || null,
    verifiedOnChain: cp.verifiedOnChain === true,
    verifiedAt: cp.verifiedAt || null,
    verifiedVia: cp.verifiedVia || null,
    cancelledAt: cp.cancelledAt || null,
    cancelReason: cp.cancelReason || null,
    cancelEmail: cp.cancelEmail || null,
    staffActions: cp.staffActions || [],
    refunds: cp.refunds || [],
    alerts: cp.alerts || [],
    ga4: cp.ga4 || null,
    lastCheckedAt: cp.lastCheckedAt || null,
    actions: staffActionsAllowed(order),
  };
}

export function staffActionsAllowed(order) {
  const st = order.cryptoPayment?.status;
  const shipped = order.fulfillment?.status === "shipped";
  const out = ["mark_reviewed", "record_refund", "add_tx"];
  if (!shipped && (st === PAY.REVIEW || st === PAY.HOLD)) out.push("release");
  if (!shipped && st !== PAY.CANCELLED) out.push("cancel");
  return out;
}

export function createCryptoVerifier({
  store, env = process.env, chains, screener, fetchImpl = globalThis.fetch, orderEmailer, skuMap = () => ({}),
  now = () => new Date(), log = (m) => process.stdout.write(`${m}\n`), onPaid = null,
} = {}) {
  const cfg = cryptoVerifyConfig(env);
  const adapters = chains || createChainAdapters({ env, fetchImpl });
  const sanctions = screener || createSanctionsScreener({ env, fetchImpl, now: () => now().getTime(), log });
  const mailDeps = { orderEmailer, env, minutes: cfg.timeoutMin };
  let running = false;
  const lastSingle = new Map();

  const wallets = () => depositWallets(env);
  const nowMs = () => now().getTime();

  function update(orderId, fn) {
    const fresh = store.getOrder(orderId);
    if (!fresh || !fresh.cryptoPayment) return null;
    const r = fn(fresh);
    if (r === false) return fresh;
    fresh.updatedAt = nowIso(nowMs());
    store.upsertOrder(fresh);
    return store.getOrder(orderId);
  }

  function alert(orderId, type, message, extra = {}) {
    const at = nowIso(nowMs());
    let ref = null;
    update(orderId, (o) => {
      ref = o.orderRef;
      o.cryptoPayment.alerts = [...(o.cryptoPayment.alerts || []), { type, message, at, ...extra }].slice(-50);
    });
    const st = store.getCryptoState();
    store.saveCryptoState({ alerts: [...st.alerts, { type, orderId, orderRef: ref, message, at, ...extra }] });
    sendInternalAlert({ type, orderId, orderRef: ref, message }, mailDeps).catch(() => {});
  }

  function watched(orders, t) {
    return orders.filter((o) => {
      const cp = o.cryptoPayment;
      if (o.paymentMethod !== "crypto" || !cp || !cp.payUnits) return false;
      if (OPEN_STATUSES.has(cp.status) || cp.status === PAY.HOLD) return true;
      const recent = t - Date.parse(cp.cancelledAt || o.createdAt) < cfg.lateWatchHours * 3600e3;
      return (cp.status === PAY.CANCELLED || cp.status === PAY.REVIEW) && recent && o.fulfillment?.status !== "shipped";
    });
  }

  /** Attach one on-chain transfer to an order (ledger-guarded: a tx can never pay two orders). */
  function claim(orderId, t, matchedBy, extra = {}) {
    const order = store.getOrder(orderId);
    if (!order) return { ok: false, reason: "not_found" };
    const created = Date.parse(order.cryptoPayment.createdAt || order.createdAt);
    if (t.timestamp && t.timestamp < created - cfg.clockSkewMs) return { ok: false, reason: "tx_before_order" };
    const key = `${t.network}:${lc(t.txHash).replace(/^0x/, "")}`;
    const res = store.claimCryptoTx(key, orderId, { amount: t.amount, token: t.token, matchedBy });
    if (!res.ok) return { ok: false, reason: "tx_already_used", owner: res.orderId };
    update(orderId, (o) => {
      const list = o.cryptoPayment.transfers || [];
      const same = list.find((x) => x.network === t.network && lc(x.txHash) === lc(t.txHash) && (x.logIndex == null || t.logIndex == null || x.logIndex === t.logIndex));
      if (same) { Object.assign(same, { ...t, logIndex: t.logIndex ?? same.logIndex, matchedBy: same.matchedBy, seenAt: same.seenAt, finalChecked: same.finalChecked }); return; }
      list.push({ ...t, matchedBy, seenAt: nowIso(nowMs()), finalChecked: false, ...extra });
      o.cryptoPayment.transfers = list;
    });
    log(`[crypto] ${orderId}: ${t.network} tx ${String(t.txHash).slice(0, 12)}… ${t.amount} ${t.token} attached (${matchedBy})`);
    return { ok: true };
  }

  async function lookupHint(orderId, hint, latestByNet) {
    const order = store.getOrder(orderId);
    const cp = order.cryptoPayment;
    const w = wallets();
    const primary = hint.network || cp.network;
    const tryNets = primary ? [primary, ...NETWORKS.filter((n) => n !== primary)] : NETWORKS;
    let result = "not_found";
    for (const net of tryNets) {
      const wallet = walletFor(net, w);
      if (!wallet || !adapters[net]) continue;
      const h = normalizeHint(hint.hash, net);
      if (!h) continue;
      let r = null;
      try {
        r = await adapters[net].getTransfers(h, { latest: latestByNet[net] });
      } catch (err) {
        if (net === primary) throw err;
        continue;
      }
      if (!r) continue;
      const toUs = r.transfers.filter((t) => lc(t.to) === lc(wallet) && t.token);
      if (!toUs.length) { result = r.transfers.length ? "not_to_our_wallet" : "no_token_transfer"; if (net === primary) break; continue; }
      const wrongNet = Boolean(cp.network && net !== cp.network);
      let attached = 0;
      for (const t of toUs) {
        const c = claim(orderId, { ...t, finalChecked: undefined }, hint.via === "staff" ? "staff_tx_hint" : "customer_tx_hint", wrongNet ? { wrongNetwork: true } : {});
        if (c.ok) attached += 1;
        else result = c.reason;
        if (!c.ok && c.reason === "tx_already_used") alert(orderId, "tx_reuse_attempt", `tx ${String(t.txHash).slice(0, 12)}… already belongs to ${c.owner}`);
      }
      if (attached) result = wrongNet ? "found_wrong_network" : "found";
      break;
    }
    update(orderId, (o) => {
      const hh = (o.cryptoPayment.txHints || []).find((x) => x.hash === hint.hash);
      if (!hh) return false;
      hh.tries = (hh.tries || 0) + 1;
      hh.result = result;
      hh.checkedAt = nowIso(nowMs());
      hh.resolved = result !== "not_found" || hh.tries >= 30;
    });
    return result;
  }

  async function refreshTransfers(orderId, network, latest) {
    const order = store.getOrder(orderId);
    const req = cfg.confirmations[network] ?? 20;
    for (const t of order.cryptoPayment.transfers || []) {
      if (t.network !== network) continue;
      if (t.blockNumber != null && t.success === true) {
        const conf = Math.max(0, latest - t.blockNumber);
        if (conf < req || t.finalChecked) {
          update(orderId, (o) => { const x = o.cryptoPayment.transfers.find((y) => y.txHash === t.txHash && y.logIndex === t.logIndex); if (x) x.confirmations = conf; });
          continue;
        }
      }
      // unknown block / success, or just reached the threshold: re-read the tx from the chain (also catches reorgs)
      const r = await adapters[network].getTransfers(t.txHash, { latest });
      update(orderId, (o) => {
        const x = o.cryptoPayment.transfers.find((y) => y.txHash === t.txHash && (y.logIndex == null || y.logIndex === t.logIndex));
        if (!x) return false;
        if (!r) { x.missingChecks = (x.missingChecks || 0) + 1; x.confirmations = 0; return; }
        const m = r.transfers.find((y) => lc(y.to) === lc(x.to) && y.contract === x.contract && y.units === x.units) || null;
        if (!m) { x.success = false; x.note = "transfer_not_in_tx"; return; }
        Object.assign(x, { logIndex: m.logIndex, blockNumber: m.blockNumber, timestamp: m.timestamp || x.timestamp, success: m.success, confirmations: m.confirmations });
        if (m.success && m.confirmations >= req) x.finalChecked = true;
      });
    }
  }

  function matchIncoming(t, netOrders) {
    const units = BigInt(t.units || "0");
    const tol = cfg.toleranceUnits;
    const inWindow = (o, lateOk) => {
      const cp = o.cryptoPayment;
      const start = Date.parse(cp.createdAt || o.createdAt) - cfg.clockSkewMs;
      const end = paymentDeadline(cp, cfg) + (lateOk ? cfg.lateWatchHours * 3600e3 : 0);
      return !t.timestamp || (t.timestamp >= start && t.timestamp <= end);
    };
    const exact = netOrders.filter((o) => {
      const p = BigInt(o.cryptoPayment.payUnits);
      return units + tol >= p && units <= p + tol && inWindow(o, true) && o.cryptoPayment.status !== PAY.HOLD;
    });
    if (exact.length === 1) return { orderId: exact[0].id, by: "unique_amount" };
    if (exact.length > 1) return { ambiguous: exact.map((o) => o.id) };
    if (units < DUST_UNITS) return { dust: true };
    const open = netOrders.filter((o) => o.cryptoPayment.status === PAY.AWAITING && inWindow(o, false));
    if (open.length === 1 && units * 10n >= BigInt(open[0].cryptoPayment.payUnits)) return { orderId: open[0].id, by: "single_open_order" };
    return {};
  }

  function noteUnmatched(t, why) {
    const st = store.getCryptoState();
    const key = `${t.network}:${lc(t.txHash)}`;
    if (st.unmatched.some((u) => u.key === key)) return;
    const rec = { key, network: t.network, txHash: t.txHash, explorerUrl: explorerTxUrl(t.network, t.txHash), token: t.token, amount: t.amount, from: t.from, timestamp: t.timestamp ? nowIso(t.timestamp) : null, reason: why, at: nowIso(nowMs()) };
    store.saveCryptoState({ unmatched: [...st.unmatched, rec], alerts: [...st.alerts, { type: "unmatched_deposit", message: `${t.amount} ${t.token} on ${t.network} (${why})`, at: rec.at, txHash: t.txHash }] });
    sendInternalAlert({ type: "unmatched_deposit", message: `${t.amount} ${t.token} ${t.network} tx ${String(t.txHash).slice(0, 14)}… could not be matched to one order (${why}).` }, mailDeps).catch(() => {});
  }

  async function scanNetwork(network, netOrders, scanState, latest) {
    const w = walletFor(network, wallets());
    const earliest = Math.min(...netOrders.map((o) => Date.parse(o.cryptoPayment.createdAt || o.createdAt))) - cfg.clockSkewMs;
    let incoming;
    if (network === "trc20") {
      const since = Math.max(earliest, (scanState.cursorMs || 0) - 10 * 60000);
      incoming = await adapters.trc20.listIncoming(w, { sinceMs: since });
      scanState.cursorMs = nowMs();
    } else {
      const blocksBack = Math.ceil((nowMs() - earliest) / 12000) + 20;
      let from = Math.max(latest - blocksBack, 0);
      if (scanState.cursorBlock && scanState.cursorBlock + 1 > from) from = scanState.cursorBlock - 5; // small overlap
      if (latest - from > 3000) from = latest - 3000; // cap per tick
      const r = await adapters.erc20.listIncoming(w, { fromBlock: from, toBlock: latest });
      incoming = r.transfers;
      scanState.cursorBlock = r.toBlock;
    }
    for (const t of incoming) {
      const owner = store.cryptoTxOwner(`${network}:${lc(t.txHash).replace(/^0x/, "")}`);
      if (owner) continue;
      const m = matchIncoming(t, netOrders.map((o) => store.getOrder(o.id)).filter(Boolean));
      if (m.orderId) {
        const c = claim(m.orderId, t, m.by);
        if (!c.ok && c.reason !== "tx_already_used") noteUnmatched(t, c.reason);
      } else if (m.ambiguous) noteUnmatched(t, "ambiguous_amount");
      else if (!m.dust) noteUnmatched(t, "no_matching_order");
    }
  }

  async function screenOrder(order) {
    const senders = [...new Set((order.cryptoPayment.transfers || []).filter((t) => t.success !== false).map((t) => t.from).filter(Boolean))];
    const r = await sanctions.screen(senders);
    return r;
  }

  function markPaid(o, via, screenResult, ev) {
    const t = nowIso(nowMs());
    const cp = o.cryptoPayment;
    cp.status = PAY.PAID;
    cp.verifiedOnChain = true;
    cp.verifiedAt = t;
    cp.verifiedVia = via;
    cp.sanctions = screenResult;
    cp.receivedAmount = ev.received;
    o.paymentStatus = PAY.PAID;
    o.status = CRYPTO_PAID;
    o.paymentConfirmed = true;
    o.analyticsEvent = null;
    o.fulfillment = readyFulfillment(o.fulfillment);
    const first = cp.transfers.find((x) => x.success !== false) || {};
    o.crypto = { ...(o.crypto || {}), network: first.network || cp.network, txHash: first.txHash || null, amountReceived: ev.received, markedPaidAt: t, markedPaidBy: via, markedPaidVia: "onchain" };
  }

  /** Evaluate one order and apply the resulting transition. */
  async function evaluateAndApply(orderId, { staffRelease = null } = {}) {
    let order = store.getOrder(orderId);
    if (!order?.cryptoPayment) return null;
    const cp = order.cryptoPayment;
    if (cp.status === PAY.PAID || cp.status === PAY.SANCTIONS) return cp.status;
    const ev = evaluatePayment(order, cfg);
    let next = ev.next;
    if (next === null) return cp.status;
    const keepReview = cp.status === PAY.REVIEW && !staffRelease;
    if (keepReview) next = PAY.REVIEW;
    if (next === "screen" || (cp.status === PAY.HOLD && next !== PAY.REVIEW)) {
      const sr = await screenOrder(order);
      if (sr.status === "match") next = PAY.SANCTIONS;
      else if (sr.status === "clear") next = PAY.PAID;
      else if (!sanctions.config.failClosed) { sr.status = "skipped_fail_open"; next = PAY.PAID; }
      else next = PAY.HOLD;
      const before = cp.status;
      order = update(orderId, (o) => {
        o.cryptoPayment.receivedAmount = ev.received;
        o.cryptoPayment.lastCheckedAt = nowIso(nowMs());
        if (next === PAY.PAID) markPaid(o, "auto_onchain", sr, ev);
        else {
          o.cryptoPayment.sanctions = sr;
          o.cryptoPayment.status = next;
          o.paymentStatus = next;
          o.status = CRYPTO_REVIEW;
          o.paymentConfirmed = false;
          o.fulfillment = blockedFulfillment(next);
        }
      });
      if (next === PAY.PAID) {
        log(`[crypto] ${orderId} VERIFIED on-chain ${ev.received} ${order.cryptoPayment.token}: ready_to_ship`);
        if (onPaid) { try { onPaid(orderId); } catch { /* never blocks */ } }
        const g = await sendGa4Purchase(order, { env, fetchImpl, skuMap: skuMap() });
        update(orderId, (o) => { o.cryptoPayment.ga4 = g; });
      } else if (next === PAY.SANCTIONS) {
        alert(orderId, "sanctions_match", `sender on sanctions list (${sr.matches.map((m) => m.source).join(",")}); no ship, no automatic refund`);
      } else if (before !== PAY.HOLD) {
        alert(orderId, "screening_unavailable", `payment verified but sanctions screening unavailable (${sr.errors.join(",")}); holding`);
      }
      return next;
    }
    const reasons = [...new Set([...(cp.reviewReasons || []), ...ev.reasons])];
    const newReasons = reasons.filter((r) => !(cp.reviewReasons || []).includes(r));
    const changed = next !== cp.status || newReasons.length || ev.received !== cp.receivedAmount;
    if (!changed) { update(orderId, (o) => { o.cryptoPayment.lastCheckedAt = nowIso(nowMs()); o.cryptoPayment.transfers = o.cryptoPayment.transfers; }); return next; }
    update(orderId, (o) => {
      const c = o.cryptoPayment;
      c.receivedAmount = ev.received;
      c.lastCheckedAt = nowIso(nowMs());
      c.reviewReasons = reasons;
      if (ev.reasons.includes("late_payment")) c.latePayment = true;
      c.status = next;
      o.paymentStatus = next;
      o.paymentConfirmed = false;
      o.status = next === PAY.REVIEW ? CRYPTO_REVIEW : AWAITING_CRYPTO;
      o.fulfillment = blockedFulfillment(next);
    });
    if (next === PAY.REVIEW && newReasons.length) {
      alert(orderId, newReasons.includes("partial_payment") ? "partial_payment" : newReasons[0], `payment_review: ${newReasons.join(", ")} (received ${ev.received}, due ${cp.payAmount})`);
    }
    return next;
  }

  async function processTimeouts(scanState) {
    const t = nowMs();
    const w = wallets();
    for (const o of store.listOrders()) {
      const cp = o.cryptoPayment;
      if (o.paymentMethod !== "crypto" || !cp || cp.status !== PAY.AWAITING || (cp.transfers || []).length) continue;
      const deadline = paymentDeadline(cp, cfg);
      if (!deadline || t <= deadline) continue;
      // Only cancel after a successful chain scan that ran after the deadline (a chain API outage never cancels a payer).
      const nets = orderNetworks(o, w);
      if (!nets.length || !nets.every((n) => Date.parse(scanState[n]?.lastOkAt || 0) >= deadline)) continue;
      const cancelled = update(o.id, (x) => {
        const c = x.cryptoPayment;
        c.status = PAY.CANCELLED;
        c.cancelledAt = nowIso(t);
        c.cancelReason = "payment_timeout";
        x.paymentStatus = PAY.CANCELLED;
        x.status = CRYPTO_CANCELLED;
        x.paymentConfirmed = false;
        x.fulfillment = blockedFulfillment("cancelled_unpaid");
      });
      log(`[crypto] ${o.id} cancelled: no payment within ${cfg.timeoutMin} min${cp.customerConfirmedAt ? ` (+${cfg.graceMin} grace)` : ""}`);
      const mail = await sendCancelEmail(cancelled, mailDeps);
      update(o.id, (x) => { x.cryptoPayment.cancelEmail = mail; });
    }
  }

  async function tick() {
    if (!cfg.enabled) return { skipped: "disabled" };
    if (running) return { skipped: "running" };
    running = true;
    const summary = { networks: {}, checked: 0 };
    try {
      const t = nowMs();
      const st = store.getCryptoState();
      const scan = st.scan || {};
      const w = wallets();
      const list = watched(store.listOrders(), t);
      for (const network of NETWORKS) {
        const s = { ...(scan[network] || {}) };
        const netOrders = list.filter((o) => orderNetworks(o, w).includes(network));
        if (!netOrders.length || !adapters[network]) { if (netOrders.length === 0) { s.lastOkAt = nowIso(t); s.idle = true; } scan[network] = s; continue; }
        if (s.nextTryAt && Date.parse(s.nextTryAt) > t) { summary.networks[network] = "backoff"; continue; }
        try {
          const latest = await adapters[network].latestBlock();
          const latestByNet = { [network]: latest };
          for (const o of netOrders) {
            for (const h of (store.getOrder(o.id).cryptoPayment.txHints || []).filter((x) => !x.resolved)) {
              if ((h.network || o.cryptoPayment.network || network) === network) await lookupHint(o.id, h, latestByNet);
            }
          }
          await scanNetwork(network, netOrders, s, latest);
          for (const o of netOrders) await refreshTransfers(o.id, network, latest);
          Object.assign(s, { lastOkAt: nowIso(nowMs()), fails: 0, nextTryAt: null, lastError: null, idle: false, latestBlock: latest });
          summary.networks[network] = "ok";
        } catch (err) {
          s.fails = (s.fails || 0) + 1;
          s.lastError = String(err?.message || err).slice(0, 200);
          s.lastErrorAt = nowIso(nowMs());
          s.nextTryAt = nowIso(nowMs() + Math.min(cfg.backoffMaxMs, 60000 * 2 ** Math.min(s.fails, 6)));
          summary.networks[network] = `error:${s.lastError}`;
          log(`[crypto] ${network} check failed (${s.lastError}); retry after ${s.nextTryAt}`);
        }
        scan[network] = s;
      }
      store.saveCryptoState({ scan });
      for (const o of list) { await evaluateAndApply(o.id); summary.checked += 1; }
      await processTimeouts(scan);
    } finally {
      running = false;
    }
    return summary;
  }

  /** Immediate check of one order (hints + confirmations + evaluation), no wallet scan. Used by staff + customer confirm. */
  async function verifyOrderNow(orderId, { force = false } = {}) {
    if (!cfg.enabled) return { ok: false, error: "verification_disabled" };
    const last = lastSingle.get(orderId) || 0;
    if (!force && nowMs() - last < 30000) return { ok: true, throttled: true, order: store.getOrder(orderId) };
    lastSingle.set(orderId, nowMs());
    const order = store.getOrder(orderId);
    if (!order?.cryptoPayment) return { ok: false, error: "not_found" };
    const nets = [...new Set([...orderNetworks(order, wallets()), ...(order.cryptoPayment.txHints || []).map((h) => h.network).filter(Boolean)])];
    const latestByNet = {};
    try {
      for (const n of NETWORKS) if (adapters[n] && walletFor(n, wallets())) latestByNet[n] = await adapters[n].latestBlock();
      for (const h of (order.cryptoPayment.txHints || []).filter((x) => !x.resolved || force)) await lookupHint(orderId, h, latestByNet);
      for (const n of nets) if (latestByNet[n] != null) await refreshTransfers(orderId, n, latestByNet[n]);
    } catch (err) {
      return { ok: false, error: "chain_unavailable", message: String(err?.message || err).slice(0, 200), order: store.getOrder(orderId) };
    }
    await evaluateAndApply(orderId);
    return { ok: true, order: store.getOrder(orderId) };
  }

  function addHint(orderId, rawHash, via, actor = null, network = null) {
    const order = store.getOrder(orderId);
    if (!order?.cryptoPayment) return { ok: false, error: "not_found" };
    const hash = normalizeHint(rawHash, network || order.cryptoPayment.network);
    if (!hash) return { ok: false, error: "invalid_tx_hash" };
    let added = false;
    update(orderId, (o) => {
      const hints = o.cryptoPayment.txHints || [];
      if (hints.some((h) => h.hash.replace(/^0x/, "") === hash.replace(/^0x/, ""))) return false;
      if (hints.length >= cfg.maxHints) return false;
      hints.push({ hash, via, actor, network: network || o.cryptoPayment.network || null, at: nowIso(nowMs()), resolved: false, result: "pending", tries: 0 });
      o.cryptoPayment.txHints = hints;
      added = true;
    });
    return { ok: true, added, hash };
  }

  /** Customer "I've sent the payment". Never releases anything; extends the cancel deadline by the grace window. */
  function customerConfirm(orderId, { txHash } = {}) {
    const order = store.getOrder(orderId);
    if (!order?.cryptoPayment) return { ok: false, error: "not_found", status: 404 };
    const cp = order.cryptoPayment;
    let hint = null;
    if (txHash != null && String(txHash).trim() !== "") {
      const h = normalizeHint(txHash, cp.network);
      if (!h || (cp.network === "erc20" && !String(txHash).trim().startsWith("0x"))) return { ok: false, error: "invalid_tx_hash", status: 400 };
      hint = h;
    }
    const lateOk = cp.status === PAY.CANCELLED && nowMs() - Date.parse(cp.cancelledAt || 0) < cfg.lateWatchHours * 3600e3;
    if (OPEN_STATUSES.has(cp.status) || lateOk || cp.status === PAY.REVIEW || cp.status === PAY.HOLD) {
      update(orderId, (o) => { if (!o.cryptoPayment.customerConfirmedAt) o.cryptoPayment.customerConfirmedAt = nowIso(nowMs()); });
      if (hint) addHint(orderId, hint, "customer");
      if (cfg.enabled && (hint || OPEN_STATUSES.has(cp.status))) verifyOrderNow(orderId).catch(() => {});
    }
    return { ok: true, status: 200, order: store.getOrder(orderId), txHint: hint };
  }

  async function staffAction(orderId, input = {}, actor = "operator") {
    const order = store.getOrder(orderId);
    if (!order || order.paymentMethod !== "crypto" || !order.cryptoPayment) return { ok: false, status: 404, error: "not_found" };
    const action = String(input.action || "");
    const note = String(input.note || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 1000);
    const t = nowIso(nowMs());
    const logAction = (extra = {}) => update(orderId, (o) => {
      o.cryptoPayment.staffActions = [...(o.cryptoPayment.staffActions || []), { action, actor, at: t, note: note || null, ...extra }];
    });
    const cp = order.cryptoPayment;
    const shipped = order.fulfillment?.status === "shipped";
    log(`[crypto] staff ${action} on ${orderId} by ${actor}`);
    if (action === "mark_reviewed") {
      logAction({ statusAtAction: cp.status });
      update(orderId, (o) => { o.cryptoPayment.reviewedAt = t; o.cryptoPayment.reviewedBy = actor; });
      return { ok: true, order: store.getOrder(orderId) };
    }
    if (action === "record_refund") {
      const net = input.network || cp.network;
      const hash = normalizeHint(input.refundTxHash, net);
      if (!hash) return { ok: false, status: 400, error: "refund_tx_hash_required" };
      let amt;
      try { amt = fixed(amountToUnits(String(input.amount))); } catch { return { ok: false, status: 400, error: "refund_amount_required" }; }
      update(orderId, (o) => { o.cryptoPayment.refunds = [...(o.cryptoPayment.refunds || []), { txHash: hash, explorerUrl: explorerTxUrl(net, hash), amount: amt, network: net, actor, at: t, note: note || null }]; });
      logAction({ refundTxHash: hash, amount: amt });
      return { ok: true, order: store.getOrder(orderId) };
    }
    if (action === "cancel") {
      if (shipped) return { ok: false, status: 409, error: "already_shipped" };
      if (cp.status === PAY.CANCELLED) return { ok: false, status: 409, error: "already_cancelled" };
      update(orderId, (o) => {
        const c = o.cryptoPayment;
        c.status = PAY.CANCELLED; c.cancelledAt = t; c.cancelReason = `staff:${actor}`;
        o.paymentStatus = PAY.CANCELLED; o.status = CRYPTO_CANCELLED; o.paymentConfirmed = false;
        o.fulfillment = blockedFulfillment("cancelled_by_staff");
      });
      logAction({ statusBefore: cp.status });
      return { ok: true, order: store.getOrder(orderId) };
    }
    if (action === "release") {
      if (shipped) return { ok: false, status: 409, error: "already_shipped" };
      if (cp.status === PAY.SANCTIONS) return { ok: false, status: 409, error: "sanctions_match" };
      if (cp.status !== PAY.REVIEW && cp.status !== PAY.HOLD) return { ok: false, status: 409, error: "not_in_review" };
      if (!note) return { ok: false, status: 400, error: "note_required" };
      if (!cfg.enabled) return { ok: false, status: 503, error: "verification_disabled" };
      // re-read every attached tx from the chain now; release needs at least one confirmed, successful transfer of an accepted token
      const nets = [...new Set((cp.transfers || []).map((x) => x.network))];
      try {
        for (const n of nets) await refreshTransfers(orderId, n, await adapters[n].latestBlock());
      } catch (err) {
        return { ok: false, status: 503, error: "chain_unavailable" };
      }
      const fresh = store.getOrder(orderId);
      const ok = (fresh.cryptoPayment.transfers || []).filter((x) => x.success === true && x.finalChecked && cfg.acceptedTokens.includes(x.token));
      if (!ok.length) return { ok: false, status: 409, error: "no_confirmed_onchain_transfer" };
      const sr = await screenOrder(fresh);
      if (sr.status === "match") {
        update(orderId, (o) => { o.cryptoPayment.status = PAY.SANCTIONS; o.paymentStatus = PAY.SANCTIONS; o.cryptoPayment.sanctions = sr; o.fulfillment = blockedFulfillment(PAY.SANCTIONS); });
        alert(orderId, "sanctions_match", "sender on sanctions list at staff release; no ship, no automatic refund");
        logAction({ result: "sanctions_match" });
        return { ok: false, status: 409, error: "sanctions_match" };
      }
      if (sr.status !== "clear") {
        if (sanctions.config.failClosed) { logAction({ result: "screening_unavailable" }); return { ok: false, status: 409, error: "screening_unavailable", errors: sr.errors }; }
        sr.status = "skipped_fail_open";
      }
      const ev = evaluatePayment(fresh, cfg);
      update(orderId, (o) => markPaid(o, `staff_release_after_review:${actor}`, sr, { received: ev.received }));
      logAction({ result: "released", received: ev.received, due: cp.payAmount });
      const paid = store.getOrder(orderId);
      const g = await sendGa4Purchase(paid, { env, fetchImpl, skuMap: skuMap() });
      update(orderId, (o) => { o.cryptoPayment.ga4 = g; });
      return { ok: true, order: store.getOrder(orderId) };
    }
    if (action === "add_tx") {
      const r = addHint(orderId, input.txHash, "staff", actor, input.network || null);
      if (!r.ok) return { ok: false, status: 400, error: r.error };
      logAction({ txHash: r.hash });
      const v = await verifyOrderNow(orderId, { force: true });
      return { ok: v.ok, status: v.ok ? 200 : 503, error: v.error, order: store.getOrder(orderId) };
    }
    return { ok: false, status: 400, error: "unknown_action" };
  }

  return {
    config: cfg,
    tick,
    verifyOrderNow,
    customerConfirm,
    addHint,
    staffAction,
    evaluateAndApply,
    screener: sanctions,
    start(intervalMs = cfg.pollMs) {
      if (!cfg.enabled) { log("[crypto] on-chain verification disabled (CRYPTO_VERIFY_ENABLED=false); crypto orders stay blocked"); return null; }
      const h = setInterval(() => { tick().catch((err) => log(`[crypto] tick failed: ${err?.message || err}`)); }, intervalMs);
      h.unref?.();
      setTimeout(() => { tick().catch(() => {}); }, 5000).unref?.();
      log(`[crypto] on-chain verifier on: every ${Math.round(intervalMs / 1000)}s, timeout ${cfg.timeoutMin}m (+${cfg.graceMin}m after customer confirm), confirmations trc20=${cfg.confirmations.trc20} erc20=${cfg.confirmations.erc20}`);
      return h;
    },
  };
}
