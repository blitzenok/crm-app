import { useEffect, useState } from "react";
import { fetchSettings, saveSettings } from "./pspApi.js";

const inp = {
  width: "100%", padding: "10px 14px", background: "#0F172A",
  border: "1px solid rgba(148,163,184,0.2)", borderRadius: 8,
  color: "#F1F5F9", fontSize: 14, outline: "none", boxSizing: "border-box",
};

function Field({ label, children }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", color: "#94A3B8", fontSize: 11, fontWeight: 600, marginBottom: 5, textTransform: "uppercase", letterSpacing: 0.8 }}>{label}</label>
      {children}
    </div>
  );
}

export default function ProcessorSettings({ isAdmin }) {
  const [data, setData] = useState(null);
  const [settings, setSettings] = useState(null);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");

  const reload = () => fetchSettings().then((d) => {
    setData(d);
    setSettings(d.settings);
  }).catch(() => setErr("CRM payment API is not running. Start with npm run server."));

  useEffect(() => { reload(); }, []);

  const patchProcessor = (id, patch) => {
    setSettings((prev) => ({
      ...prev,
      processors: prev.processors.map((p) => p.id === id ? { ...p, ...patch } : p),
    }));
  };

  const onSave = async () => {
    setMsg(""); setErr("");
    try {
      const out = await saveSettings(settings);
      setSettings(out.settings);
      setMsg("Processor settings saved. Cascade order is UMG → Tagada → Centrobill unless you change priority or kill-switch.");
    } catch {
      setErr("Save failed — is the CRM server up?");
    }
  };

  if (!settings) {
    return <div style={{ color: "#94A3B8", padding: 24 }}>{err || "Loading processor settings…"}</div>;
  }

  const health = data?.health || {};
  const cleffo = data?.cleffo || null;

  return (
    <div>
      <div style={{ marginBottom: 22 }}>
        <h2 style={{ margin: "0 0 6px", fontSize: 22 }}>Payment processors</h2>
        <p style={{ margin: 0, color: "#94A3B8", fontSize: 14, maxWidth: 720 }}>
          Locked SoT: UMG is #1, then Tagada, then Centrobill. Soft decline / timeout / 5xx / processor-down moves to the next enabled PSP with the same cart key. Hard decline (fraud / do-not-honor / invalid card) stops. Clearing stays in CRM only.
        </p>
      </div>
      {cleffo && (
        <div style={{ marginBottom: 22, padding: "14px 16px", background: "rgba(15,23,42,0.6)", borderRadius: 10, fontSize: 13, color: "#CBD5E1" }}>
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Cleffo split (read-only — set on the server)</div>
          <div>Enabled: <b>{cleffo.cleffoEnabled ? "yes" : "no"}</b> · Env: {cleffo.cleffoEnv} · Split to Cleffo: {cleffo.splitPct}% · Max attempts: {cleffo.maxAttempts}</div>
          <div>Keys ready: {cleffo.keys?.ready ? "yes" : "no"} ({cleffo.keys?.baseUrl})</div>
          <div>Statement descriptor — UMG: {cleffo.descriptors?.umg?.configured} · Cleffo: {cleffo.descriptors?.cleffo?.configured}{cleffo.descriptors?.cleffo?.statementDescriptorConfirmed ? "" : " (not confirmed)"}</div>
          <div>Routed attempts: UMG {cleffo.counts?.umg ?? 0} · Cleffo {cleffo.counts?.cleffo ?? 0}</div>
          <div style={{ color: "#94A3B8", marginTop: 4 }}>{cleffo.rules}</div>
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 20 }}>
        <div style={{ background: "rgba(30,41,59,0.8)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 14, padding: 18 }}>
          <div style={{ fontSize: 11, color: "#64748B", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>UMG secret</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: health.umgSecretConfigured ? "#10B981" : "#F59E0B" }}>
            {health.umgSecretConfigured ? "Loaded on server" : "Not loaded — dry-run / mock only"}
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#64748B", fontFamily: "'Space Mono',monospace" }}>
            Path: {health.umgEnvPath || "/root/secure-quarantine-20260917-audit/umg.env"} · source {health.source || "none"}
          </div>
        </div>
        <div style={{ background: "rgba(30,41,59,0.8)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 14, padding: 18 }}>
          <div style={{ fontSize: 11, color: "#64748B", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", marginBottom: 8 }}>UMG callback URL</div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "#38BDF8", wordBreak: "break-all" }}>{health.callbackUrl || "/api/webhooks/umg"}</div>
          <div style={{ marginTop: 8, fontSize: 12, color: "#64748B" }}>Paste this in the UMG portal. Poll fallback runs every 30s for PENDING / 3DS.</div>
        </div>
      </div>

      <div style={{ background: "rgba(30,41,59,0.8)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 14, padding: 20, marginBottom: 16 }}>
        <Field label="Kill-switch (force a single PSP)">
          <select
            style={{ ...inp, cursor: isAdmin ? "pointer" : "not-allowed" }}
            disabled={!isAdmin}
            value={settings.killSwitchPsp || ""}
            onChange={(e) => setSettings((p) => ({ ...p, killSwitchPsp: e.target.value || null }))}
          >
            <option value="">Off — use priority cascade</option>
            <option value="umg">Force UMG only</option>
            <option value="tagada">Force Tagada only</option>
            <option value="centrobill">Force Centrobill only</option>
          </select>
        </Field>
      </div>

      {(settings.processors || []).map((p) => (
        <div key={p.id} style={{ background: "rgba(30,41,59,0.8)", border: "1px solid rgba(148,163,184,0.12)", borderRadius: 14, padding: 20, marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 700 }}>{p.label}</div>
              <div style={{ fontSize: 12, color: "#64748B", marginTop: 2 }}>{p.id === "umg" ? "Live adapter" : "Stub — cascade-ready, not wired"}</div>
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 8, color: "#CBD5E1", fontSize: 13 }}>
              <input type="checkbox" disabled={!isAdmin} checked={p.enabled} onChange={(e) => patchProcessor(p.id, { enabled: e.target.checked })} />
              Enabled
            </label>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>
            <Field label="Priority (1 = first)">
              <input style={inp} type="number" disabled={!isAdmin} value={p.priority} onChange={(e) => patchProcessor(p.id, { priority: Number(e.target.value) })} />
            </Field>
            <Field label="Mode">
              <select style={{ ...inp, cursor: isAdmin ? "pointer" : "not-allowed" }} disabled={!isAdmin} value={p.mode} onChange={(e) => patchProcessor(p.id, { mode: e.target.value })}>
                <option value="sandbox">Sandbox</option>
                <option value="live">Live</option>
                <option value="off">Off</option>
              </select>
            </Field>
          </div>
        </div>
      ))}

      {!isAdmin && <div style={{ color: "#F59E0B", fontSize: 13, marginBottom: 12 }}>Read-only — only Y Admin can change processor settings.</div>}
      {msg && <div style={{ color: "#10B981", fontSize: 13, marginBottom: 12 }}>{msg}</div>}
      {err && <div style={{ color: "#F87171", fontSize: 13, marginBottom: 12 }}>{err}</div>}
      {isAdmin && (
        <button onClick={onSave} style={{ padding: "10px 24px", borderRadius: 8, background: "linear-gradient(135deg,#0EA5E9,#38BDF8)", border: "none", color: "#FFF", cursor: "pointer", fontSize: 14, fontWeight: 600 }}>
          Save processor settings
        </button>
      )}
    </div>
  );
}
