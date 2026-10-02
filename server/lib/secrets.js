import { existsSync, readFileSync } from "node:fs";

const DEFAULT_UMG_ENV_PATH = "/root/secure-quarantine-20260917-audit/umg.env";

function parseEnvFile(raw) {
  const out = {};
  for (const line of String(raw || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function umgEnvPath() {
  return process.env.UMG_ENV_PATH || DEFAULT_UMG_ENV_PATH;
}

export function loadUmgSecret() {
  if (process.env.UMG_API_SECRET) return process.env.UMG_API_SECRET;
  const path = umgEnvPath();
  if (!path || !existsSync(path)) return null;
  const parsed = parseEnvFile(readFileSync(path, "utf8"));
  return parsed.UMG_API_SECRET || parsed.API_KEY || null;
}

export function hasUmgSecret() {
  return Boolean(loadUmgSecret());
}

export function umgAuthorizationValue(secret) {
  return Buffer.from(String(secret), "utf8").toString("base64");
}

export function umgBasicHeader(secret) {
  return `Basic ${umgAuthorizationValue(secret)}`;
}

// audit 2026-10-02 (pay-rest-16): /api/psp/health is public, so this answer no longer carries the path of the secret file
// (umgEnvPath); the path is in docs/UMG_SIDECAR_DEPLOY.md and the unit file.
export function secretHealth() {
  return {
    umgSecretConfigured: hasUmgSecret(),
    source: process.env.UMG_API_SECRET ? "env" : hasUmgSecret() ? "file" : "none",
  };
}
