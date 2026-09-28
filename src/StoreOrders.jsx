import { Fragment, useEffect, useState } from "react";
import { fetchOrders, pollOrders, runDryRun } from "./pspApi.js";

const STATUS_COLORS = {
  approved: { bg: "#D1FAE5", text: "#065F46", border: "#10B981" },
  pending: { bg: "#E0E7FF", text: "#3730A3", border: "#818CF8" },
  cascading: { bg: "#FEF3C7", text: "#92400E", border: "#F59E0B" },
  declined: { bg: "#FEE2E2", text: "#991B1B", border: "#F87171" },
  refunded: { bg: "#F1F5F9", text: "#475569", border: "#94A3B8" },
  chargeback: { bg: "#FEE2E2", text: "#991B1B", border: "#F87171" },
  new: { bg: "#F1F5F9", text: "#475569", border: "#94A3B8" },
  awaiting_crypto: { bg: "#FEF3C7", text: "#92400E", border: "#F59E0B" },
  crypto_paid: { bg: "#D1FAE5", text: "#065F46", border: "#10B981" },
};

function Badge({ status }) {
  const c = STATUS_COLORS[status] || STATUS_COLORS.new;
  return <span style={{ display: "inline-block", padding: "4px 12px", borderRadius: 20, fontSize: 12, fontWeight: 600, background: c.bg, color: c.text, border: `1px solid ${c.border}` }}>{status || "—"}</span>;
}

function money(amount, currency = "USD") {
  const n = parseFloat(amount) || 0;
  return n.toLocaleString("en-US", { style: "currency", currency, minimumFractionDigits: 2 });
}

function ClearingPanel({ order }) {
  if (!order) return null;
  if (order.paymentMethod === "crypto") {
    const ship = order.fulfillment?.status || "blocked";
    return (
      <div style={{ padding: "8px 8px 18px", color: "#E2E8F0", fontSize: 13 }}>
        <div style={{ marginBottom: 8 }}>
          Crypto order <strong style={{ fontFamily: "'Space Mono',monospace" }}>{order.orderRef}</strong>
          {" · "}amount due {order.amountDue || order.amount} {order.payAsset || "USDT"}
          {" · "}fulfillment {ship}
        </div>
        <div style={{ color: "#94A3B8" }}>
          Mark paid and shipping live on Crypto payments. Shipping stays blocked until a staff member confirms the transfer. This row is not a card capture.
        </div>
      </div>
    );
  }
  return (
    <div style={{ padding: "8px 8px 18px" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 16 }}>
        {[
          ["Order", order.id],
          ["Cart key", order.idempotencyKey],
          ["Winning PSP", order.winningProcessor || "—"],
          ["Routed to / attempt", `${order.paymentProcessor || "—"} · #${order.attemptNumber || (order.routing?.attempts || []).length || "—"}${order.routing?.bucket ? ` (bucket ${order.routing.bucket})` : ""}`],
          ["Txn / descriptor", `${order.winningTxnId || "—"} · ${order.descriptor || "—"}`],
        ].map(([k, v]) => (
          <div key={k} style={{ background: "rgba(15,23,42,0.6)", borderRadius: 10, padding: "10px 12px" }}>
            <div style={{ fontSize: 10, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.7 }}>{k}</div>
            <div style={{ fontSize: 13, color: "#E2E8F0", marginTop: 4, wordBreak: "break-all" }}>{v}</div>
          </div>
        ))}
      </div>
      {(order.routing?.attempts || []).length > 0 && (
        <div style={{ marginBottom: 14, fontSize: 12, color: "#CBD5E1" }}>
          <div style={{ fontSize: 10, color: "#64748B", textTransform: "uppercase", letterSpacing: 0.7, marginBottom: 6 }}>Processor routing (UMG / Cleffo)</div>
          {order.routing.attempts.map((r, i) => (
            <div key={`${r.n}-${i}`}>
              #{r.n} {r.processor} · {r.reason} · {r.outcome || "open"}{r.retryClass ? ` · retry ${r.retryClass}${r.retryBasis ? ` (${r.retryBasis})` : ""}` : ""}{r.countsAsAttempt === false ? " · not counted" : ""}
            </div>
          ))}
        </div>
      )}
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid rgba(148,163,184,0.15)" }}>
            {["#", "PSP", "Mode", "Status", "Class", "Cascade", "UMG id", "Code / info", "Descriptor", "GW", "txid", "Last4", "HTTP", "ms"].map((h) => (
              <th key={h} style={{ padding: "8px 8px", textAlign: "left", color: "#64748B", fontSize: 10, letterSpacing: 0.6, textTransform: "uppercase" }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {(order.attempts || []).map((a, i) => (
            <tr key={a.attemptId} style={{ borderBottom: "1px solid rgba(148,163,184,0.08)", verticalAlign: "top" }}>
              <td style={{ padding: "8px" }}>{i + 1}</td>
              <td style={{ padding: "8px", fontWeight: 700 }}>{a.processor}</td>
              <td style={{ padding: "8px" }}>{a.mode}</td>
              <td style={{ padding: "8px" }}>{a.processorStatus}</td>
              <td style={{ padding: "8px", color: a.declineClass === "hard" ? "#F87171" : a.declineClass === "soft" ? "#F59E0B" : "#10B981" }}>{a.declineClass || "—"}</td>
              <td style={{ padding: "8px" }}>{a.cascadeAction}</td>
              <td style={{ padding: "8px", fontFamily: "'Space Mono',monospace" }}>{a.processorTxnId || "—"}</td>
              <td style={{ padding: "8px", color: "#94A3B8", maxWidth: 220 }}>{[a.informationCode, a.informationData].filter(Boolean).join(" · ") || "—"}</td>
              <td style={{ padding: "8px" }}>{a.descriptor || "—"}</td>
              <td style={{ padding: "8px" }}>{a.gatewayId ?? "—"}</td>
              <td style={{ padding: "8px", fontFamily: "'Space Mono',monospace" }}>{a.txid || "—"}</td>
              <td style={{ padding: "8px" }}>{a.cardLast4 || "—"}</td>
              <td style={{ padding: "8px" }}>{a.httpStatus ?? "—"}</td>
              <td style={{ padding: "8px" }}>{a.latencyMs ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 10, fontSize: 12, color: "#64748B" }}>
        Customer: {[order.customer?.first_name, order.customer?.last_name].filter(Boolean).join(" ")} · {order.customer?.email || "—"} · {order.customer?.country || ""} {order.customer?.city || ""}
      </div>
    </div>
  );
}

export default function StoreOrders({ isAdmin }) {
  const [orders, setOrders] = useState([]);
  const [openId, setOpenId] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState("");

  const reload = () => fetchOrders().then((d) => setOrders(d.orders || [])).catch(() => setErr("CRM payment API is not running. Start with npm run server."));

  useEffect(() => { reload(); }, []);

  const dry = async (scenario) => {
    setBusy(scenario); setErr("");
    try {
      const out = await runDryRun(scenario);
      if (out.order) {
        setOrders((prev) => [out.order, ...prev.filter((o) => o.id !== out.order.id)]);
        setOpenId(out.order.id);
      }
    } catch {
      setErr("Dry-run failed — start the CRM server.");
    } finally {
      setBusy("");
    }
  };

  const poll = async () => {
    setBusy("poll");
    try {
      const out = await pollOrders();
      setOrders(out.orders || []);
    } catch {
      setErr("Poll failed.");
    } finally {
      setBusy("");
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 20, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ margin: "0 0 6px", fontSize: 22 }}>Store orders + clearing</h2>
          <p style={{ margin: 0, color: "#94A3B8", fontSize: 14, maxWidth: 680 }}>
            Full processor data sits beside the order in CRM — never on the storefront. Site stays v2.99a; checkout hook comes later.
          </p>
        </div>
        {isAdmin && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[
              ["soft", "Dry-run soft → next"],
              ["hard", "Dry-run hard stop"],
              ["approved", "Dry-run UMG approved"],
              ["timeout", "Dry-run timeout"],
              ["pending", "Dry-run pending"],
            ].map(([id, label]) => (
              <button key={id} disabled={Boolean(busy)} onClick={() => dry(id)} style={{ padding: "8px 12px", borderRadius: 8, border: "1px solid #334155", background: "rgba(15,23,42,0.8)", color: "#E2E8F0", cursor: "pointer", fontSize: 12 }}>
                {busy === id ? "…" : label}
              </button>
            ))}
            <button disabled={Boolean(busy)} onClick={poll} style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: "linear-gradient(135deg,#0EA5E9,#38BDF8)", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: 600 }}>
              {busy === "poll" ? "Polling…" : "Poll pending"}
            </button>
          </div>
        )}
      </div>
      {err && <div style={{ color: "#F87171", fontSize: 13, marginBottom: 12 }}>{err}</div>}
      <div style={{ background: "rgba(30,41,59,0.55)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 14, overflow: "hidden" }}>
        {orders.length === 0 ? (
          <div style={{ padding: 36, textAlign: "center", color: "#64748B" }}>No store orders yet. Use a dry-run or POST /api/checkout/charge from the future storefront hook.</div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
            <thead>
              <tr style={{ borderBottom: "1px solid rgba(148,163,184,0.15)" }}>
                {["Order", "Status", "Amount", "Customer", "PSP", "Attempts", "Updated"].map((h) => (
                  <th key={h} style={{ padding: "12px 14px", textAlign: "left", color: "#64748B", fontSize: 11, letterSpacing: 0.8, textTransform: "uppercase" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => (
                <Fragment key={o.id}>
                  <tr onClick={() => setOpenId(openId === o.id ? null : o.id)} style={{ borderBottom: "1px solid rgba(148,163,184,0.06)", cursor: "pointer" }}>
                    <td style={{ padding: "12px 14px", fontFamily: "'Space Mono',monospace", fontWeight: 700 }}>{o.id}</td>
                    <td style={{ padding: "12px 14px" }}><Badge status={o.status} /></td>
                    <td style={{ padding: "12px 14px", color: "#38BDF8", fontWeight: 700 }}>{money(o.amount, o.currency)}</td>
                    <td style={{ padding: "12px 14px" }}>{o.customer?.email || "—"}</td>
                    <td style={{ padding: "12px 14px" }}>{o.winningProcessor || o.lastProcessor || "—"}</td>
                    <td style={{ padding: "12px 14px" }}>{(o.attempts || []).length}</td>
                    <td style={{ padding: "12px 14px", color: "#94A3B8", fontSize: 12 }}>{o.updatedAt ? new Date(o.updatedAt).toLocaleString() : "—"}</td>
                  </tr>
                  {openId === o.id && (
                    <tr>
                      <td colSpan={7} style={{ background: "rgba(15,23,42,0.45)" }}>
                        <ClearingPanel order={o} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
