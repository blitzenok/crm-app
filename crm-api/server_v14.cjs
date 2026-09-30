// Blitz CRM Server — v13.03 (2026-03-22)
// Load environment variables
// require("dotenv").config();

// ═══════════════════════════════════════════════
// STARTUP DEPENDENCY CHECK v12.05
// Runs before anything else — prints clear error if modules are missing
// ═══════════════════════════════════════════════
const REQUIRED_MODULES = [
  'express',
  'cors',
  'debug',
  'ms',
  'depd',
  'inherits',
  'safe-buffer',
];

const missing = [];
for (const mod of REQUIRED_MODULES) {
  try { require.resolve(mod); } catch { missing.push(mod); }
}

if (missing.length > 0) {
  console.error('\n╔══════════════════════════════════════════════╗');
  console.error('║  ❌ BLITZ CRM — MISSING DEPENDENCIES                  ║');
  console.error('║                                                      ║');
  console.error('║  The following npm modules are not installed:        ║');
  missing.forEach(m => console.error(`║    • ${m.padEnd(46)}║`));
  console.error('║                                                      ║');
  console.error('║  Fix: run this command in the server directory:      ║');
  console.error('║                                                      ║');
  console.error(`║  npm install ${missing.join(' ')}`);
  console.error('║                                                      ║');
  console.error('║  Or reinstall everything:  npm install               ║');
  console.error('╚══════════════════════════════════════════════╝\n');
  process.exit(1); // Exit with error code so pm2/systemd knows it failed
}

console.log('✅ All dependencies verified — starting Blitz CRM server...');

const express = require("express");
const fs = require("fs");
const path = require("path");
// Phase 0 (2026-09-04): read /opt/crm-api/.env (KEY=VALUE per line) without a dotenv dependency.
// Existing process.env values win; a missing file is not an error.
(function loadDotEnv() {
  let raw;
  try { raw = fs.readFileSync(path.join(__dirname, ".env"), "utf8"); } catch { return; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    let val = m[2];
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
})();
const cors = require("cors");
const http = require("http");
// Phase 7 (2026-09-06): the optional "ws" dependency and the WebSocket channel it powered were removed — no page opens
// a socket (the front polls over HTTP), so the upgrade endpoint had no client left.
const crypto = require("crypto");
// Phase 2 (2026-09-05): scrypt passwords, legacy SHA-256 migration, per-e-mail login throttle, idle/max session rules.
const authUtils = require("./auth-utils.cjs");
// Phase 6 (2026-09-05): the Telegram bot client and the screenshot helper it drove were removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

const app = express();
app.disable('x-powered-by'); // Don't reveal tech stack
// v13.03: Trust Nginx reverse proxy — makes req.ip return the real client IP
// from X-Real-IP / X-Forwarded-For headers instead of always showing 127.0.0.1
app.set('trust proxy', 1);

// ═══════════════════════════════════════════════════════════════
// CRASH PROTECTION — Keep server alive no matter what
// ═══════════════════════════════════════════════════════════════
// v9.05: Enhanced crash protection with tracking
let crashCount = 0;
// Phase 7 (2026-09-06): the in-memory CRASH_LOG ring buffer was removed — its only readers were the diagnostics routes
// cut in phase 6. Crashes are still counted, printed here and appended to logs/blitz-error-*.log by the handlers below.

process.on('uncaughtException', (err) => {
  crashCount++;
  console.error(`💥 UNCAUGHT EXCEPTION #${crashCount} (server stays alive):`, err.message);
  console.error(err.stack);
  if (global.gc) { try { global.gc(); } catch {} }
});

process.on('unhandledRejection', (reason) => {
  crashCount++;
  const msg = reason instanceof Error ? reason.message : String(reason);
  console.error(`💥 UNHANDLED REJECTION #${crashCount} (server stays alive):`, msg);
});

const PORT = Number(process.env.PORT) || 3001;
const VERSION = "14.09";

// ═══════════════════════════════════════════════
// FILE-BASED LOGGING SYSTEM v12.04
// Writes logs to /logs/ directory for easy download and diagnosis
// ═══════════════════════════════════════════════
const LOG_DIR = path.join(__dirname, "logs");
const LOG_LEVELS = { INFO: 'INFO', WARN: 'WARN', ERROR: 'ERROR', CRASH: 'CRASH', STARTUP: 'STARTUP' };

function ensureLogDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

function getLogFile(type = 'app') {
  const date = new Date().toISOString().split('T')[0];
  return path.join(LOG_DIR, `blitz-${type}-${date}.log`);
}

function writeLog(level, module, message, data = {}) {
  ensureLogDir();
  const ts = new Date().toISOString();
  const line = JSON.stringify({ ts, level, module, message, ...data }) + '\n';
  // Write to daily app log
  try { fs.appendFileSync(getLogFile('app'), line); } catch {}
  // Write errors/crashes to separate error log
  if (level === LOG_LEVELS.ERROR || level === LOG_LEVELS.CRASH) {
    try { fs.appendFileSync(getLogFile('error'), line); } catch {}
  }
}

// Patch crash handlers to also write to file
process.on('uncaughtException', (err) => {
  writeLog(LOG_LEVELS.CRASH, 'process', `Uncaught Exception: ${err.message}`, { stack: (err.stack||'').split('\n').slice(0,8).join('\n') });
});
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  writeLog(LOG_LEVELS.CRASH, 'process', `Unhandled Rejection: ${msg}`, { stack: reason instanceof Error ? (reason.stack||'').split('\n').slice(0,5).join('\n') : '' });
});
const DATA_DIR = path.join(__dirname, "data");
const BACKUP_DIR = path.join(__dirname, "backups");
const AUDIT_DIR = path.join(__dirname, "audit");

// ═══════════════════════════════════════════════════════════════
// 1. CORE INFRASTRUCTURE
// ═══════════════════════════════════════════════════════════════

// Ensure directories
[DATA_DIR, BACKUP_DIR, AUDIT_DIR].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// v13.03: Startup WAL/temp file cleanup — remove orphaned .tmp.* and .wal.* files
// These can accumulate if the server crashes mid-write
(function cleanupOrphanedWriteFiles() {
  try {
    const files = fs.readdirSync(DATA_DIR);
    let cleaned = 0;
    for (const f of files) {
      if (f.includes('.tmp.') || f.includes('.wal.')) {
        try { fs.unlinkSync(path.join(DATA_DIR, f)); cleaned++; } catch {}
      }
    }
    if (cleaned > 0) console.log(`\u{1F9F9} Startup: cleaned ${cleaned} orphaned WAL/temp files`);
  } catch (e) { console.warn('\u26A0\uFE0F Could not clean orphaned write files:', e.message); }
})();

// Phase 6 (2026-09-05): the tombstone system (anti-resurrect for deleted Blitz table records) was removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

// Phase 0 (2026-09-04): hardcoded Blitz user seed (INITIAL_USERS / seedUsers) removed — users live only in data/users.json.

// Phase 6 (2026-09-05): Telegram/leadgreed configuration, group chat ids, the retry sender, the crypto-verification constants (including a hardcoded Etherscan key), the message parsers and httpRequest were removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

// ═══════════════════════════════════════════════════════════════
// 2. ATOMIC FILE OPERATIONS WITH VERSION TRACKING
// ═══════════════════════════════════════════════════════════════

// In-memory version counters — increment on every write
const dataVersions = {};
const dataLocks = new Map(); // Prevents concurrent writes to same file

// Phase 3 (2026-09-05): a corrupt users.json is never repaired automatically — an older copy would silently roll
// passwords back. The broken file is copied to backups/<ts>/users.json.corrupt (once per distinct file), audited as
// users_json_corrupt, and every request that needs the user list fails with 500 until data/users.json is restored by
// hand (procedure in the phase 3 report). Other tables keep the auto-recovery, but candidates are now ordered by the
// backup file's mtime (newest first) instead of by directory name, which sorted startup-/shutdown-/safety- copies ahead
// of the hourly ones; an unreadable backup copy is skipped instead of aborting the recovery.
class UsersJsonCorruptError extends Error {
  constructor(message) { super(message); this.name = "UsersJsonCorruptError"; this.code = "USERS_JSON_CORRUPT"; this.status = 500; }
}
let lastUsersQuarantine = null; // "<mtimeMs>:<size>" of the corrupt file already copied — a burst of requests makes one copy
function quarantineUsersJson(filepath, reason) {
  try {
    const st = fs.statSync(filepath);
    const stamp = st.mtimeMs + ":" + st.size;
    if (stamp === lastUsersQuarantine) return;
    const dirName = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19); // same shape as createBackup(), so cleanupBackups keeps it
    const dir = path.join(BACKUP_DIR, dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(filepath, path.join(dir, "users.json.corrupt"));
    lastUsersQuarantine = stamp;
    console.error(`🔴 users.json is corrupt (${reason}) — copy saved to backups/${dirName}/users.json.corrupt, live file NOT touched; restore it by hand`);
    writeAuditLog("users", "users_json_corrupt", "system", `users.json unreadable (${reason}); copy in backups/${dirName}/users.json.corrupt; manual restore required`);
  } catch (e) { console.error("⚠️ Could not quarantine users.json:", e.message); }
}
function readJSON(filename, fallback) {
  const filepath = path.join(DATA_DIR, filename);
  let corrupt = null;
  try {
    if (fs.existsSync(filepath)) {
      const raw = fs.readFileSync(filepath, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
      console.error(`⚠️ ${filename} is not an array — treating as corrupted`);
      corrupt = "not an array";
    }
  } catch (err) {
    console.error(`❌ Error reading ${filename}:`, err.message);
    corrupt = err.message;
  }
  if (filename === "users.json" && corrupt !== null) {
    quarantineUsersJson(filepath, corrupt);
    throw new UsersJsonCorruptError("users.json is corrupt — manual restore required");
  }
  // FIX C4: Try to recover from the most recent backup before returning the fallback (newest backup file by mtime first)
  try {
    const candidates = [];
    for (const dir of fs.readdirSync(BACKUP_DIR)) {
      const backupFile = path.join(BACKUP_DIR, dir, filename);
      try { const st = fs.statSync(backupFile); if (st.isFile()) candidates.push({ dir, backupFile, mtime: st.mtimeMs }); } catch {}
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    for (const c of candidates) {
      try {
        const backupRaw = fs.readFileSync(c.backupFile, "utf8");
        const backupData = JSON.parse(backupRaw);
        if (Array.isArray(backupData) && backupData.length > 0) {
          console.log(`🔧 AUTO-RECOVERED ${filename} from backup ${c.dir} (${backupData.length} records)`);
          // Restore the file from backup
          fs.writeFileSync(filepath, backupRaw, "utf8");
          return backupData;
        }
      } catch (e) { console.error(`⚠️ Skipping unreadable backup ${c.dir}/${filename}:`, e.message); }
    }
  } catch (recoveryErr) {
    console.error(`⚠️ Backup recovery failed for ${filename}:`, recoveryErr.message);
  }
  return fallback;
}

// v9.05: Atomic write with Write-Ahead Logging (WAL) — validates BEFORE overwriting
function writeJSONAtomic(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  const tempPath = filepath + `.tmp.${Date.now()}.${crypto.randomBytes(4).toString('hex')}`;
  const walPath = filepath + `.wal.${Date.now()}`;

  try {
    // WAL Step 1: Serialize and validate data BEFORE touching disk
    const jsonStr = JSON.stringify(data, null, 2);
    const parsed = JSON.parse(jsonStr); // Verify round-trip
    if (!Array.isArray(parsed)) throw new Error("Data is not an array after round-trip");
    // M3 (2026-09-08): was < 3. JSON.stringify([], null, 2) is "[]" — two characters — so deleting the
    // last row of any table was refused here and answered 500 with the row still on disk. Two is a valid
    // payload; the guard is against a truncated write, and nothing serialises shorter than "[]".
    if (jsonStr.length < 2) throw new Error("Suspiciously small payload");

    // WAL Step 2: Write intent log (what we WANT to write)
    fs.writeFileSync(walPath, jsonStr, "utf8");

    // WAL Step 3: Write to temp file
    fs.writeFileSync(tempPath, jsonStr, "utf8");

    // WAL Step 4: Verify temp file matches intent
    const verify = fs.readFileSync(tempPath, "utf8");
    if (verify !== jsonStr) throw new Error("Temp file content mismatch — disk corruption?");

    // WAL Step 5: Atomic rename (on same filesystem this is atomic)
    fs.renameSync(tempPath, filepath);

    // WAL Step 6: Clean up WAL file (write succeeded)
    try { fs.unlinkSync(walPath); } catch {}

    // Increment version
    const key = filename.replace('.json', '');
    dataVersions[key] = (dataVersions[key] || 0) + 1;

    return true;
  } catch (err) {
    console.error(`❌ Atomic write failed for ${filename}:`, err.message);
    // Clean up temp and WAL files
    try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch {}
    try { if (fs.existsSync(walPath)) fs.unlinkSync(walPath); } catch {}
    return false;
  }
}

// v9.05: Concurrency Queue — serializes writes per table
// If Telegram bot + user save at same ms, they're processed sequentially
const writeQueues = {}; // { tableName: Promise }

// Phase 6 (2026-09-05): lockedWrite() removed — every caller was a Blitz table writer; lockedUpdate below keeps its own queue on writeQueues/dataLocks (see keep_remove_table.md).

// Phase 3 (2026-09-05): read-modify-write of one table inside its write queue. Every users.json writer used to read the
// file outside lockedWrite and hand in a full list, so two requests arriving together (create + password change, two
// first logins) could overwrite each other's change. fn(current) returns the new list, or null/undefined to skip the
// write; an error thrown by fn (a 404/409/403 decided on the fresh data, see httpError) reaches the caller and leaves the
// file untouched. meta may be a function of (next, current) so the audit entry can depend on what fn actually did.
// Resolves { ok, skipped, data }.
async function lockedUpdate(filename, fn, meta) {
  const key = filename.replace('.json', '');
  const prev = writeQueues[key] || Promise.resolve();
  const current = prev.then(async () => {
    const maxWait = 10000;
    const start = Date.now();
    while (dataLocks.has(key)) {
      if (Date.now() - start > maxWait) {
        console.error(`💥 LOCK TIMEOUT on ${key} — forcing unlock (was held ${maxWait}ms)`);
        dataLocks.delete(key);
        break;
      }
      await new Promise(r => setTimeout(r, 10));
    }
    dataLocks.set(key, true);
    try {
      const before = readJSON(filename, []);
      const next = await fn(before);
      if (next === null || next === undefined) return { ok: true, skipped: true, data: before };
      if (!Array.isArray(next)) throw new Error(`lockedUpdate(${filename}): fn must return an array`);
      const success = writeJSONAtomic(filename, next);
      const m = typeof meta === "function" ? meta(next, before) : meta;
      if (success && m) writeAuditLog(key, m.action || "update", m.user || "system", m.details || `${next.length} records`);
      return { ok: success, skipped: false, data: next };
    } finally {
      dataLocks.delete(key);
    }
  });
  writeQueues[key] = current.catch(() => {}); // a rejected update must not block the next writer of this table
  return current;
}
// An error with an HTTP status, thrown inside a lockedUpdate callback and turned into the response by the route.
function httpError(status, message) { const e = new Error(message); e.status = status; return e; }

// ═══════════════════════════════════════════════════════════════
// 3. AUDIT LOGGING — WHO changed WHAT and WHEN
// ═══════════════════════════════════════════════════════════════
function writeAuditLog(table, action, user, details, ip) {
  // v11.02 M5: wrapped in try/catch — disk full or permission errors should not crash the server
  // v13.03: Added optional ip parameter for proper IP capture in audit logs
  try {
    const now = new Date();
    const dateKey = now.toISOString().split('T')[0]; // 2026-02-23
    const logFile = path.join(AUDIT_DIR, `audit_${dateKey}.jsonl`);
    const entry = {
      timestamp: now.toISOString(),
      table,
      action, // "create", "update", "delete", "login", "restore"
      user,   // email or "system"
      details,
      ip: ip || null, // v13.03: now populated by callers that have req.ip
    };
    fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("\u26A0\uFE0F Audit log error:", err.message);
  }
}
// Clean up old audit logs (keep 30 days)
function cleanupAuditLogs() {
  try {
    const files = fs.readdirSync(AUDIT_DIR).filter(f => f.startsWith('audit_') && f.endsWith('.jsonl'));
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    files.forEach(f => {
      const date = f.replace('audit_', '').replace('.jsonl', '');
      if (date < cutoff) {
        fs.unlinkSync(path.join(AUDIT_DIR, f));
        console.log(`🗑️ Old audit log removed: ${f}`);
      }
    });
  } catch (err) {}
}
setInterval(cleanupAuditLogs, 24 * 60 * 60 * 1000); // Daily cleanup

// ═══════════════════════════════════════════════════════════════
// 4. CONFLICT RESOLUTION — Version Tracking (Last-Writer-Wins+)
// ═══════════════════════════════════════════════════════════════

// Each save includes a version number. If a client sends data with an
// older version than what's on server, we log the conflict but still
// accept (LWW) because in a CRM the latest user action is usually correct.
// The audit log captures everything for rollback if needed.

function getVersion(table) {
  if (!dataVersions[table]) {
    // Initialize from file mtime
    const filepath = path.join(DATA_DIR, table + '.json');
    try {
      if (fs.existsSync(filepath)) {
        dataVersions[table] = Math.floor(fs.statSync(filepath).mtimeMs);
      } else {
        dataVersions[table] = 0;
      }
    } catch { dataVersions[table] = 0; }
  }
  return dataVersions[table];
}

// Phase 6 (2026-09-05): syncExternalData (crg-deals/daily-cap counters), its /api/sync routes and its startup timers were removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

// ═══════════════════════════════════════════════════════════════
// 5. POINT-IN-TIME RECOVERY (PITR) — Enhanced Backup System
// ═══════════════════════════════════════════════════════════════

// Backup every 15 minutes (was 1 hour), keep 30 days of daily + 48 hours of hourly
function createBackup(label) {
  const ts = label || new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, ts);
  if (!fs.existsSync(backupPath)) fs.mkdirSync(backupPath, { recursive: true });

  // Phase 7 (2026-09-06): the ten Blitz table names were dead weight after the phase 6 cut (no such files on disk), while
  // the data the CRM actually has — the agent modules' leads/segments/cio-meta — was never copied at all. A missing file
  // is skipped, as before.
  // M4 (2026-09-08): data/marketing-email-backups.json holds the previous texts of the Customer.io letters.
  // It is the only copy of them (the M4 rollback leaves the file in place on purpose), so it belongs here.
  const endpoints = ["users", "leads", "segments", "cio-meta", "marketing-email-backups", "marketing-newsletters"];
  let count = 0;
  endpoints.forEach(ep => {
    const src = path.join(DATA_DIR, ep + ".json");
    const dst = path.join(backupPath, ep + ".json");
    if (fs.existsSync(src)) { fs.copyFileSync(src, dst); count++; }
  });

  // Also backup audit log for today
  const todayAudit = path.join(AUDIT_DIR, `audit_${new Date().toISOString().split('T')[0]}.jsonl`);
  if (fs.existsSync(todayAudit)) {
    fs.copyFileSync(todayAudit, path.join(backupPath, 'audit.jsonl'));
  }

  console.log(`📦 Backup created: ${ts} (${count} data files + audit)`);
  cleanupBackups();
  return ts;
}

function cleanupBackups() {
  try {
    const dirs = fs.readdirSync(BACKUP_DIR).sort();
    const now = Date.now();
    const TWO_DAYS = 48 * 60 * 60 * 1000;
    const THIRTY_DAYS = 30 * 24 * 60 * 60 * 1000;

    // Keep: all backups within 48 hours, one per day for 30 days
    const kept = new Set();
    const dailyKept = new Set();

    dirs.forEach(d => {
      try {
        // Phase 4 (2026-09-05): the date is taken from anywhere in the name (startup-…, manual-…) — before that, such a
        // directory was deleted seconds after creation, because new Date("startup-…") is NaN.
        // Phase 5 (2026-09-05): a directory with no date in the name at all (safety-<table>-<ms>, pre-restore-<ms>,
        // pre-bulk-delete-…) is dated by its own mtime and follows the same policy — phase 4 kept those forever.
        // Its dayKey shares the one-per-day slot with the dated directories; an unreadable directory is kept.
        const m = d.match(/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
        let time;
        if (m) {
          const ts = new Date(m[0].replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3"));
          if (isNaN(ts.getTime())) { kept.add(d); return; }
          time = ts.getTime();
        } else {
          let st; try { st = fs.lstatSync(path.join(BACKUP_DIR, d)); } catch { kept.add(d); return; }
          if (!st.isDirectory()) { kept.add(d); return; } // a stray file or symlink in backups/ is not ours to age out
          time = st.mtimeMs;
        }
        const age = now - time;
        const dayKey = new Date(time).toISOString().slice(0, 10);

        if (age < TWO_DAYS) {
          kept.add(d); // Keep all recent
        } else if (age < THIRTY_DAYS && !dailyKept.has(dayKey)) {
          kept.add(d); // Keep one per day
          dailyKept.add(dayKey);
        }
      } catch { kept.add(d); } // an entry this loop could not judge is kept, never swept below
    });

    dirs.forEach(d => {
      if (!kept.has(d)) {
        fs.rmSync(path.join(BACKUP_DIR, d), { recursive: true, force: true });
        console.log(`🗑️ Old backup removed: ${d}`);
      }
    });
  } catch (err) {
    console.error("⚠️ Backup cleanup error:", err.message);
  }
}

// Backup every 1 hour
setInterval(createBackup, 60 * 60 * 1000);
// Backup on startup — CRITICAL: creates a snapshot before any new client code can write
setTimeout(() => createBackup("startup-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)), 2000);

// Phase 6 (2026-09-05): startupIntegrityCheck (boot-time auto-restore of seven Blitz tables from backups) was removed — those tables are gone and users.json was deliberately excluded from it (see keep_remove_table.md).

// ═══════════════════════════════════════════════════════════════
// v9.05: DAILY SNAPSHOT SYSTEM — "The Safety Net"
// Keeps exactly 7 days of guaranteed-clean daily snapshots
// Runs at 02:00 AM server time to avoid user activity
// ═══════════════════════════════════════════════════════════════
const SNAPSHOT_DIR = path.join(__dirname, "snapshots");
if (!fs.existsSync(SNAPSHOT_DIR)) fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });

function createDailySnapshot() {
  const dateKey = new Date().toISOString().split('T')[0]; // 2026-03-01
  const snapPath = path.join(SNAPSHOT_DIR, dateKey);
  if (fs.existsSync(snapPath)) { console.log(`📸 Daily snapshot ${dateKey} already exists — skipping`); return; }
  fs.mkdirSync(snapPath, { recursive: true });

  // Phase 7 (2026-09-06): same list as createBackup — the Blitz tables (and "partners") no longer exist, leads/segments/cio-meta do.
  const endpoints = ["users", "leads", "segments", "cio-meta", "marketing-newsletters"];
  let count = 0;
  endpoints.forEach(ep => {
    const src = path.join(DATA_DIR, ep + ".json");
    if (fs.existsSync(src)) { fs.copyFileSync(src, path.join(snapPath, ep + ".json")); count++; }
  });
  console.log(`📸 Daily snapshot created: ${dateKey} (${count} files)`);

  // Cleanup: keep only last 7 days
  try {
    const dirs = fs.readdirSync(SNAPSHOT_DIR).sort();
    while (dirs.length > 7) {
      const old = dirs.shift();
      fs.rmSync(path.join(SNAPSHOT_DIR, old), { recursive: true, force: true });
      console.log(`🗑️ Old snapshot removed: ${old}`);
    }
  } catch (err) { console.error("⚠️ Snapshot cleanup error:", err.message); }
}

// Phase 6 (2026-09-05): nightlyDedup (daily-cap/crg-deals) and the 03:00 branch below were removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

// Schedule the daily snapshot at 02:00
function scheduleNightlyTasks() {
  const now = new Date();
  const next2am = new Date(now);
  next2am.setHours(2, 0, 0, 0);
  if (next2am <= now) next2am.setDate(next2am.getDate() + 1);
  const delay2 = next2am - now;

  setTimeout(() => {
    createDailySnapshot();
    setInterval(createDailySnapshot, 24 * 60 * 60 * 1000);
  }, delay2);

  console.log(`⏰ Nightly tasks scheduled: snapshot at 02:00 (in ${Math.round(delay2/60000)}min)`);
}

// Also create snapshot on startup if none exists for today
setTimeout(createDailySnapshot, 5000);
scheduleNightlyTasks();

// ═══════════════════════════════════════════════════════════════
// 6. EXPRESS + SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

// Phase 1 (2026-09-04): CORS fails closed. Only an origin listed verbatim in CORS_ORIGINS (/opt/crm-api/.env,
// comma-separated) is reflected. Any other origin, a request without Origin, or an empty list gets no CORS headers at
// all: the cors package skips itself when the callback answers false, so same-origin and server-to-server calls
// (nginx proxy, curl, products-api session checks) are not affected and no 500 is raised.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
if (ALLOWED_ORIGINS.length === 0) console.warn("⚠️ CORS_ORIGINS is empty — cross-origin browser requests are refused");
app.use(cors({
  origin: (origin, callback) => callback(null, !!origin && ALLOWED_ORIGINS.includes(origin)),
  credentials: true,
}));
// Phase 8 (2026-09-06): express.json and the body sanitizer moved below the rate limiter and the honeypot (section 6) — see there.

// v12.04: HTTP Request Error Logger — logs 4xx/5xx responses to file
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    if (res.statusCode >= 400) {
      writeLog(
        res.statusCode >= 500 ? LOG_LEVELS.ERROR : LOG_LEVELS.WARN,
        'http',
        `${req.method} ${req.path} → ${res.statusCode}`,
        { method: req.method, path: req.path, status: res.statusCode, ms, ip: req.ip }
      );
    }
  });
  next();
});

// v9.05: Input Sanitization Middleware — strips XSS/injection from all POST bodies
function sanitizeValue(val) {
  if (typeof val === 'string') {
    return val
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Strip script tags
      .replace(/on\w+\s*=\s*["'][^"']*["']/gi, '') // Strip event handlers
      .replace(/javascript\s*:/gi, '') // Strip javascript: URIs
      .replace(/data\s*:\s*text\/html/gi, '') // Strip data:text/html
      .trim();
  }
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val && typeof val === 'object') {
    const clean = {};
    for (const [k, v] of Object.entries(val)) {
      // Block prototype pollution
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      clean[k] = sanitizeValue(v);
    }
    return clean;
  }
  return val;
}

// Phase 8 (2026-09-06): the app.use() that ran sanitizeValue over req.body moved with express.json below the honeypot (section 6) — see there; the function above is called from that registration.

// Phase 7 (2026-09-06): the JSON-parse error handler that sat here was folded into the single error middleware at the
// end of section 14 — an error handler only catches what was registered above it, so this one could never answer for a
// route, and a second handler for the same errors is one place too many to keep in step.

// ── FIX C4/C5: Session token authentication ──
// On login success, server issues a random session token.
// All data/admin endpoints require valid token in Authorization header.
// Phase 2 (2026-09-05): a session ends after 12 h without a request or 7 days after login, whichever comes first
// (authUtils.sessionExpired on createdAt + lastSeenAt). lastSeenAt is touched at most once a minute and flushed every
// 30 s; .sessions.json is written atomically (tmp + rename) because the restart recovery below reads it back.
const SESSION_FILE = path.join(DATA_DIR, ".sessions.json");

// Load persisted sessions on startup (survive server restarts)
const activeSessions = new Map();
try {
  if (fs.existsSync(SESSION_FILE)) {
    const saved = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    for (const [token, session] of Object.entries(saved)) {
      if (!authUtils.sessionExpired(session)) activeSessions.set(token, session);
    }
    console.log(`🔑 Restored ${activeSessions.size} active sessions from disk`);
  }
} catch (e) { console.log("⚠️ Could not restore sessions:", e.message); }

let sessionsDirty = false;
function persistSessions() {
  const tmp = SESSION_FILE + ".tmp." + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(activeSessions)), "utf8");
    fs.renameSync(tmp, SESSION_FILE);
    sessionsDirty = false;
  } catch (err) {
    console.error("❌ Failed to persist sessions:", err.message);
    try { fs.unlinkSync(tmp); } catch {}
  }
}
setInterval(() => { if (sessionsDirty) persistSessions(); }, 30 * 1000);

function generateSessionToken() {
  return crypto.randomBytes(32).toString("hex");
}

// Phase 7 (2026-09-06): closeSocketsFor() removed with the WebSocket channel — a session that ends now only has to
// disappear from activeSessions, there is no long-lived socket left to drop.

function cleanupSessions() {
  const gone = new Set();
  for (const [token, session] of activeSessions) {
    if (authUtils.sessionExpired(session)) { activeSessions.delete(token); gone.add(token); }
  }
  if (gone.size > 0) { persistSessions(); console.log(`🧹 Cleaned ${gone.size} expired sessions`); }
}
setInterval(cleanupSessions, 60 * 60 * 1000); // Hourly cleanup

// Ends every session of one user (password change or reset, deletion). Returns how many sessions were removed.
function endSessionsFor(email) {
  const gone = new Set();
  for (const [token, session] of activeSessions) {
    if (session && sameEmail(session.email, email)) { activeSessions.delete(token); gone.add(token); }
  }
  if (gone.size > 0) persistSessions();
  return gone.size;
}

// Auth middleware — checks Authorization: Bearer <token>
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required" });
  }
  const token = authHeader.slice(7);
  const session = activeSessions.get(token);
  if (!session) {
    return res.status(401).json({ error: "Invalid or expired session" });
  }
  const now = Date.now();
  if (authUtils.sessionExpired(session, now)) {
    activeSessions.delete(token);
    sessionsDirty = true;
    return res.status(401).json({ error: "Session expired" });
  }
  if (now - (typeof session.lastSeenAt === "number" ? session.lastSeenAt : session.createdAt) >= 60 * 1000) {
    session.lastSeenAt = now;
    sessionsDirty = true;
  }
  req.userSession = session; // Attach user info to request
  next();
}

// Admin-only middleware — phase 0 (2026-09-04): role comes from data/users.json (role === "admin"), no hardcoded e-mail list
// Phase 2 (2026-09-05): users.json is also edited by hand (other agents), so e-mails are always compared normalized.
function sameEmail(a, b) { return authUtils.normalizeEmail(a) === authUtils.normalizeEmail(b); }
function findUserIndex(list, email) { return list.findIndex(u => u && sameEmail(u.email, email)); }
// Phase 5 (2026-09-05): one role vocabulary — "admin" | "staff". role: "user" written into users.json by hand (older
// records, other agents) reads as "staff"; publicUser() in auth-utils normalizes the same way, so /api/login,
// /api/session and GET /api/users now agree. The file itself is never rewritten for this.
function normalizeRole(role) { return role === "admin" ? "admin" : "staff"; }
function getUserRole(email) {
  if (!email) return "staff";
  const u = readJSON("users.json", []).find(x => x && sameEmail(x.email, email));
  return normalizeRole(u && u.role);
}
function isAdminEmail(email) { return getUserRole(email) === "admin"; }
function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!isAdminEmail(req.userSession.email)) {
      return res.status(403).json({ error: "Admin access required" });
    }
    next();
  });
}

// Rate limiting: 200 req/min per IP
const rateLimitMap = new Map();

const RATE_LIMIT_WINDOW = 60 * 1000;
const RATE_LIMIT_MAX = 300; // v9.05: was 200

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitMap.has(ip)) { rateLimitMap.set(ip, { count: 1, windowStart: now }); return next(); }
  const entry = rateLimitMap.get(ip);
  if (now - entry.windowStart > RATE_LIMIT_WINDOW) { entry.count = 1; entry.windowStart = now; return next(); }
  entry.count++;
  if (entry.count > RATE_LIMIT_MAX) return res.status(429).json({ error: "Too many requests" });
  next();
}
setInterval(() => { const now = Date.now(); for (const [ip, e] of rateLimitMap) { if (now - e.windowStart > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(ip); } }, 5 * 60 * 1000);

// v10.1: Auto-ban IPs that hit blocked paths repeatedly
// v13.03: Lowered threshold from 15 → 5 — with honeypot decoy paths, any scanner
// will hit multiple blocked paths immediately, so 5 hits is already clearly malicious
const ipBanMap = new Map(); // ip → { count, firstSeen, banned }
const IP_BAN_THRESHOLD = 5; // v13.03: 5 blocked requests = auto-ban (was 15)
const IP_BAN_DURATION = 24 * 60 * 60 * 1000; // 24 hours
const IP_BAN_WINDOW = 60 * 60 * 1000; // Count within 1 hour

// Security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  if (req.path.startsWith('/api/')) { res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate'); res.setHeader('Pragma', 'no-cache'); }
  next();
});
app.use('/api/', rateLimit);

// Block attack paths
// v10.1: Rate-limit audit logging for repeated blocked requests (same IP+path)
const blockedRequestLog = new Map(); // key="ip|path" → lastLoggedAt
const BLOCKED_LOG_COOLDOWN = 3600000; // Only log same IP+path combo once per hour

app.use((req, res, next) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  
  // v10.1: Check if IP is auto-banned
  const banEntry = ipBanMap.get(ip);
  if (banEntry && banEntry.banned) {
    if (Date.now() - banEntry.bannedAt < IP_BAN_DURATION) {
      return res.status(403).json({ error: "Forbidden" });
    }
    ipBanMap.delete(ip); // Ban expired
  }
  
  // v13.03: HONEYPOT DECOY PATHS — expanded blocked list mixes real sensitive paths
  // with convincing fake decoys. Attackers cannot distinguish real from fake,
  // making targeted probing useless. All return identical 403 Forbidden.
  const blocked = [
    // ── Real sensitive paths (always block)
    '/.env', '/.env.production', '/.env.local', '/.env.development',
    '/etc/passwd', '/..%2f', '/../', '/@fs/',
    '/.git', '/.htaccess', '/web.config', '/xmlrpc',
    '/wp-admin', '/wp-login', '/phpinfo', '/admin.php',
    '/composer.json', '/package.json', '/package-lock.json',
    // ── Decoy: fake config & credential files (look real, are fake)
    '/config/database.yml', '/config/secrets.yml', '/config/master.key',
    '/api/config', '/api/keys', '/api/secrets', '/api/env', '/api/token',
    '/server/config.json', '/backend/config.js', '/backend/.env',
    '/.secrets', '/secrets.json', '/credentials.json', '/serviceaccount.json',
    // ── Decoy: fake admin & management paths
    '/admin', '/administrator', '/admin/login', '/admin/dashboard',
    '/manage', '/management', '/panel', '/cpanel', '/plesk',
    '/phpmyadmin', '/pma', '/mysql', '/adminer',
    // ── Decoy: fake backup & data files
    '/backup', '/backup.sql', '/backup.zip', '/db.sql', '/dump.sql',
    '/data.json', '/export.json', '/users.json', '/database.json',
    '/crm-data.zip', '/crm-backup.zip', '/blitz-data.zip',
    // ── Decoy: fake source & deploy artifacts
    '/src/config.js', '/dist/config.js', '/.github', '/Dockerfile',
    '/docker-compose.yml', '/.dockerenv', '/Makefile',
    '/deploy.sh', '/setup.sh', '/install.sh',
    // ── Decoy: fake framework & CMS paths
    '/laravel', '/symfony', '/rails', '/django', '/flask',
    '/joomla', '/drupal', '/magento', '/prestashop',
    '/cgi-bin', '/cgi-sys', '/shell', '/cmd', '/exec',
    // ── Decoy: fake token & key files
    '/token', '/tokens.json', '/auth.json', '/jwt.json',
    '/private.key', '/id_rsa', '/id_rsa.pub', '/ssh',
    '/telegram.token', '/bot.token', '/api.key',
  ];
  // Phase 4 (2026-09-05): a decoy matches the whole path or a prefix on a segment boundary ('/admin', '/admin/x',
  // '/admin.php'), not any substring — '/api/users/admin@…' and '/api/admin/*' are live routes. Decoys that already end
  // with '/' ('/../', '/@fs/') stay plain prefixes.
  const p = req.path.toLowerCase();
  const hit = b => p === b || p.startsWith(b.endsWith("/") ? b : b + "/") || p.startsWith(b + ".");
  // Directory-traversal probes are still caught anywhere in the path (review S): no live route contains these.
  const TRAVERSAL = ["/../", "/..%2f", "/@fs/"];
  if (TRAVERSAL.some(x => p.includes(x)) || blocked.some(hit)) {
    const logKey = `${ip}|${req.path}`;
    const now = Date.now();
    const lastLogged = blockedRequestLog.get(logKey) || 0;
    if (now - lastLogged > BLOCKED_LOG_COOLDOWN) {
      // v10.05: Skip audit logging for localhost — Nginx/health checks create noise (50+/day)
      if (ip !== '127.0.0.1' && ip !== '::1' && ip !== '::ffff:127.0.0.1') {
        writeAuditLog("security", "blocked_request", "unknown", `Path: ${req.path} IP: ${ip}`, ip);
      }
      blockedRequestLog.set(logKey, now);
    }
    // v10.1: Track and auto-ban aggressive scanners (not localhost)
    if (ip !== '127.0.0.1' && ip !== '::1') {
      const entry = ipBanMap.get(ip) || { count: 0, firstSeen: now };
      if (now - entry.firstSeen > IP_BAN_WINDOW) { entry.count = 0; entry.firstSeen = now; }
      entry.count++;
      if (entry.count >= IP_BAN_THRESHOLD) {
        entry.banned = true; entry.bannedAt = now;
        writeAuditLog("security", "ip_auto_banned", "system", `IP ${ip} banned for 24h after ${entry.count} blocked requests`, ip);
        console.log(`🛡️ AUTO-BAN: ${ip} (${entry.count} blocked requests in ${Math.round((now - entry.firstSeen)/1000)}s)`);
      }
      ipBanMap.set(ip, entry);
    }
    // Cleanup old entries every so often
    if (blockedRequestLog.size > 500) {
      for (const [k, t] of blockedRequestLog) {
        if (now - t > BLOCKED_LOG_COOLDOWN * 2) blockedRequestLog.delete(k);
      }
    }
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
});

// Phase 8 (2026-09-06): the body is read here and not at the top of this section — a decoy path or an over-limit IP is
// answered 403/429 above without parsing any JSON, and the parser's own verdicts (413/400) now leave with the security
// headers set above them, which used to be registered after express.json. Nothing between cors and this point touches
// req.body, so the routes see exactly what they saw before.
// Phase 7 (2026-09-06): 10mb was unreachable anyway — nginx caps /api/ at its default client_max_body_size 1m on both
// CRM hosts. 512kb is half of that, so an oversized body is refused by this JSON handler (413 JSON) before nginx answers
// with its HTML page, and it still holds ~1 000 rows of a leads import (today: 9 leads, leads.json 5.6 KB).
app.use(express.json({ limit: "512kb" }));
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'object') {
    req.body = sanitizeValue(req.body);
  }
  next();
});

// Input sanitization middleware
app.use('/api/', (req, res, next) => {
  if (req.method === 'POST' && req.body && typeof req.body === 'object') {
    // Prevent prototype pollution — check OWN properties only (not inherited ones like 'constructor')
    const keys = Object.keys(req.body);
    if (keys.includes('__proto__') || keys.includes('prototype')) {
      return res.status(400).json({ error: "Invalid input" });
    }
  }
  next();
});

// ═══════════════════════════════════════════════════════════════
// 7. LOGIN & AUTHENTICATION
// ═══════════════════════════════════════════════════════════════

const loginAttempts = new Map();
const LOGIN_MAX_ATTEMPTS = 5; // v9.05: was 3
const LOGIN_BLOCK_DURATION = 10 * 60 * 1000; // v9.05: 10 min (was 15)
setInterval(() => { const now = Date.now(); for (const [ip, e] of loginAttempts) { if (now - e.firstAttempt > LOGIN_BLOCK_DURATION) loginAttempts.delete(ip); } }, 5 * 60 * 1000);

// Phase 2 (2026-09-05): per-e-mail throttle on top of the per-IP block — 10 failures in 15 min lock that e-mail for 15 min
// (429 + Retry-After) no matter how many IPs the attempts come from. In memory; a restart clears it.
const loginThrottle = authUtils.createLoginThrottle();
setInterval(() => loginThrottle.sweep(), 5 * 60 * 1000);
// The pre-phase-2 client sent {email, passwordHash} (unsalted SHA-256 hex); that body is accepted until this date so
// scripts that still use it keep working, but only against a not-yet-migrated user.
const LEGACY_LOGIN_FORMAT_UNTIL = Date.parse("2026-10-05T00:00:00Z");

// ═══════════════════════════════════════════════════════════════
// LOGIN — users.json only (phase 0 2026-09-04: hardcoded seed fallback removed)
// Phase 2 (2026-09-05): body is {email, password} (plaintext over TLS). Passwords are stored as scrypt (passwordScrypt);
// a user still on the legacy SHA-256 hex (passwordHash) is verified against it and migrated to scrypt on this first
// successful login. A failed login never tells whether the e-mail exists.
// ═══════════════════════════════════════════════════════════════
app.post("/api/login", async (req, res) => {
  const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
  const now = Date.now();

  // IP blocking
  const entry = loginAttempts.get(ip);
  if (entry && entry.count >= LOGIN_MAX_ATTEMPTS) {
    const unblockTime = entry.firstAttempt + LOGIN_BLOCK_DURATION;
    if (now < unblockTime) {
      const minsLeft = Math.ceil((unblockTime - now) / 60000);
      res.set("Retry-After", String(Math.ceil((unblockTime - now) / 1000)));
      return res.status(429).json({ error: "blocked", minutes: minsLeft });
    }
    loginAttempts.delete(ip);
  }

  const body = req.body && typeof req.body === "object" ? req.body : {};
  const emailClean = authUtils.normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : null;
  const legacyHash = password === null && typeof body.passwordHash === "string" ? body.passwordHash : null;
  if (!emailClean || (password === null && legacyHash === null)) {
    return res.status(400).json({ error: "Missing credentials" });
  }
  if (password !== null && password.length > 200) return res.status(400).json({ error: "Password too long (max 200)" });
  if (legacyHash !== null && now > LEGACY_LOGIN_FORMAT_UNTIL) {
    return res.status(400).json({ error: "Send {email, password}; the passwordHash form is no longer accepted" });
  }

  // Per-e-mail lock — checked before any hashing work
  const lock = loginThrottle.check(emailClean);
  if (lock.locked) {
    // the lock itself was audited when it tripped; requests made during it only feed the per-IP counter
    const hit = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
    hit.count++; if (hit.count === 1) hit.firstAttempt = now; loginAttempts.set(ip, hit);
    res.set("Retry-After", String(lock.retryAfterSec));
    return res.status(429).json({ error: "blocked", minutes: lock.retryAfterMin });
  }

  const fileUsers = readJSON("users.json", []);
  const user = fileUsers.find(u => u && sameEmail(u.email, emailClean));
  let ok = false, migrate = false;
  if (user && password !== null) {
    ok = authUtils.verifyPassword(password, user);
    migrate = ok && authUtils.needsMigration(user);
    if (typeof user.passwordScrypt !== "string") authUtils.verifyScrypt(password, authUtils.DUMMY_SCRYPT); // legacy or password-less record: keep the cost of a scrypt check
  } else if (user && legacyHash !== null) {
    writeAuditLog("auth", "login_legacy_format", emailClean, "IP: " + ip, ip);
    if (authUtils.needsMigration(user)) ok = authUtils.sha256HexEqual(legacyHash, user.passwordHash);
  } else if (password !== null) {
    authUtils.verifyScrypt(password, authUtils.DUMMY_SCRYPT); // unknown e-mail: spend the same time as a real check
  }

  if (ok) {
    loginAttempts.delete(ip);
    loginThrottle.clear(emailClean);
    const token = generateSessionToken();
    activeSessions.set(token, { email: user.email, name: user.name, role: getUserRole(user.email), pageAccess: user.pageAccess, createdAt: now, lastSeenAt: now });
    persistSessions();
    // ── Record lastLogin (and the scrypt migration) in users.json — read and written inside the users.json queue (phase 3) ──
    try {
      const newScrypt = migrate ? authUtils.hashPassword(password) : null; // hashed before entering the queue (scrypt is slow)
      let migratedNow = false;
      const r = await lockedUpdate("users.json", list => {
        const idx = findUserIndex(list, emailClean);
        if (idx === -1) return null;
        const u = Object.assign({}, list[idx], { lastLogin: new Date(now).toISOString() });
        if (newScrypt && authUtils.needsMigration(u)) { u.passwordScrypt = newScrypt; delete u.passwordHash; migratedNow = true; }
        return list.map((x, i) => i === idx ? u : x);
      }, () => migratedNow ? { action: "password_migrated", user: emailClean, details: "[users] legacy SHA-256 hash replaced by scrypt on login" } : null);
      if (r.skipped) { // the account was deleted while the password was being checked: no session for it (review S)
        activeSessions.delete(token); persistSessions();
        writeAuditLog("auth", "login_failed", emailClean, "account removed during login, IP: " + ip, ip);
        return res.status(401).json({ error: "invalid", remaining: LOGIN_MAX_ATTEMPTS });
      }
      if (!r.ok) console.error("⚠️ Failed to update lastLogin for", emailClean);
    } catch (e) { console.error("⚠️ Failed to update lastLogin:", e.message); }
    console.log("✅ Login OK:", emailClean);
    writeAuditLog("auth", "login_success", emailClean, "IP: " + ip, ip);
    res.json({ ok: true, token, user: { email: user.email, name: user.name, role: getUserRole(user.email), pageAccess: user.pageAccess } });
  } else {
    const current = loginAttempts.get(ip) || { count: 0, firstAttempt: now };
    current.count++;
    if (current.count === 1) current.firstAttempt = now;
    loginAttempts.set(ip, current);
    const remaining = LOGIN_MAX_ATTEMPTS - current.count;
    const failure = loginThrottle.recordFailure(emailClean);

    console.log("❌ Login FAILED:", emailClean, "| IP:", ip);
    writeAuditLog("auth", "login_failed", emailClean, "IP: " + ip, ip);

    if (failure.locked) {
      if (failure.justLocked) writeAuditLog("auth", "login_locked", emailClean, `${failure.failures} failures in window, IP: ${ip}`, ip);
      res.set("Retry-After", String(failure.retryAfterSec));
      return res.status(429).json({ error: "blocked", minutes: failure.retryAfterMin });
    }
    if (remaining <= 0) {
      res.set("Retry-After", String(Math.ceil(LOGIN_BLOCK_DURATION / 1000)));
      return res.status(429).json({ error: "blocked", minutes: Math.ceil(LOGIN_BLOCK_DURATION / 60000) });
    }
    res.status(401).json({ error: "invalid", remaining });
  }
});

// ── Logout ──
app.post("/api/logout", (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    if (activeSessions.has(token)) {
      writeAuditLog("auth", "logout", activeSessions.get(token).email, "");
      activeSessions.delete(token);
      persistSessions();
    }
  }
  res.json({ ok: true });
});

// ── Session validation ──
app.get("/api/session", requireAuth, (req, res) => {
  res.json({ ok: true, user: { email: req.userSession.email, name: req.userSession.name, role: getUserRole(req.userSession.email), pageAccess: req.userSession.pageAccess } });
});

// ═══════════════════════════════════════════════════════════════
// 8. DATA ENDPOINTS — With Atomic Writes + Audit + Versioning
// ═══════════════════════════════════════════════════════════════

const endpoints = ["users"]; // phase 6 (2026-09-05): the eleven Blitz tables are gone; users.json is the only one left (read by /api/health)

// Phase 6 (2026-09-05): the payment notification dedup sets (hashes, ids, transitions) were removed with the Telegram notifications — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

// Phase 6 (2026-09-05): the generic GET loop over eleven Blitz tables was replaced by this one route — users.json is the only table
// left (see keep_remove_table.md). The body is the same as the loop produced: data, version, timestamp and an
// (always empty) tombstoned list. A corrupt users.json still throws out of readJSON → 500 + quarantine (phase 3).
// v9.16 kept as a signal only: a list that suddenly reads empty is logged and audited (readJSON already tried the backups).
let lastKnownUsersCount = 0;
app.get("/api/users", requireAdmin, (req, res) => { // phase 2 (2026-09-05): the user list is admin-only
  const data = readJSON("users.json", []).map(authUtils.publicUser); // phase 2: role/createdAt included, password fields never leave the server
  if (data.length === 0 && lastKnownUsersCount > 5) {
    console.error(`🔴 DATA LOSS DETECTED [users]: returning 0 records, last known count was ${lastKnownUsersCount}.`);
    writeAuditLog("users", "data_loss_detected", req.userSession.email, `[users] GET returned 0 records, last known=${lastKnownUsersCount}.`);
  }
  if (data.length > 0) lastKnownUsersCount = data.length;
  res.json({ data, version: getVersion("users"), timestamp: Date.now(), tombstoned: [] });
});

// Phase 6 (2026-09-05): POST /api/payments removed — Blitz affiliate finance with Telegram notifications, no caller (see keep_remove_table.md).

// Phase 6 (2026-09-05): the generic POST loop over nine Blitz tables (merge, shrinkage protection, tombstones, broadcast) was removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

// Users — separate endpoint to preserve full data + audit
// Phase 2 (2026-09-05): POST {email, name, role} creates ONE user with a generated password that is returned once in the
// reply and never logged.
// Phase 3 (2026-09-05): the Blitz whole-list form (array body / {data: [...]}, the old merge handler) is gone — no page or
// script sends it any more; such a body is answered with 400.
app.post("/api/users", requireAdmin, async (req, res) => { // v11.02 H2: admin-only
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || Array.isArray(body.data) || typeof body.email !== "string") {
    return res.status(400).json({ error: "Send {email, name, role}" });
  }
  return createUser(req, res);
});

async function createUser(req, res) {
  const email = authUtils.normalizeEmail(req.body.email);
  const name = typeof req.body.name === "string" ? req.body.name.trim() : "";
  const role = req.body.role === "admin" ? "admin" : (req.body.role === "staff" || req.body.role === undefined ? "staff" : null);
  if (!authUtils.isValidEmail(email)) return res.status(400).json({ error: "Enter a valid e-mail address" });
  if (!name || name.length > 80) return res.status(400).json({ error: "Name is required (max 80 characters)" });
  if (!role) return res.status(400).json({ error: "Role must be admin or staff" });
  if (findUserIndex(readJSON("users.json", []), email) !== -1) return res.status(409).json({ error: "User already exists" }); // cheap early answer; decided again on the fresh list below
  const password = authUtils.generatePassword();
  const user = { email, name, role, pageAccess: [], createdAt: new Date().toISOString(), createdBy: req.userSession.email, passwordScrypt: authUtils.hashPassword(password) };
  let r;
  try {
    r = await lockedUpdate("users.json", list => {
      if (findUserIndex(list, email) !== -1) throw httpError(409, "User already exists");
      return [...list, user];
    }, { action: "user_created", user: req.userSession.email, details: `[users] ${email} (${role}) created` });
  } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); throw e; }
  if (!r.ok) return res.status(500).json({ error: "Write failed" });
  const updated = r.data;
  console.log(`👥 User created: ${email} (${role}) by ${req.userSession.email}`);
  res.status(201).json({ ok: true, user: { email, name, role }, password });
}

// DELETE /api/users/:email — admin-only direct user deletion (v13.00)
// Bypasses the merge logic entirely — removes user from file immediately
// Phase 2 (2026-09-05): admins can be deleted too, except yourself and the last remaining admin; sessions of the user end.
app.delete("/api/users/:email", requireAdmin, async (req, res) => {
  // Phase 5 (2026-09-05): Express has already decoded :email — a second decode turned %2540 into "@" (the route then
  // acted on an account the path did not name) and threw URIError on a broken percent, answered as 500.
  const targetEmail = authUtils.normalizeEmail(req.params.email);
  const adminEmail = req.userSession.email;

  if (!targetEmail) return res.status(400).json({ error: "Email required" });

  if (sameEmail(targetEmail, adminEmail)) return res.status(403).json({ error: "You cannot delete your own account" });
  // Phase 3 (2026-09-05): existence and the last-admin rule are decided on the list read inside the users.json queue.
  let found, r;
  try {
    r = await lockedUpdate("users.json", list => {
      const foundIdx = findUserIndex(list, targetEmail);
      found = list[foundIdx];
      if (!found) throw httpError(404, "User not found");
      if (found.role === "admin" && list.filter(u => u && u.role === "admin").length <= 1) throw httpError(403, "Cannot delete the last admin");
      return list.filter((u, i) => i !== foundIdx);
    }, () => ({ action: "delete", user: adminEmail, details: `[users] Deleted user: ${targetEmail} (${found.name || 'unnamed'})` }));
  } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); throw e; }
  if (!r.ok) return res.status(500).json({ error: "Write failed" });
  const updated = r.data;
  endSessionsFor(targetEmail);
  console.log(`🗑️ User deleted: ${targetEmail} by ${adminEmail}`);
  res.json({ ok: true, count: updated.length });
});

// Phase 4 (2026-09-05): admin changes another user's role and/or display name. Sessions of the target are NOT ended —
// requireAdmin reads the role from users.json on every request, so a demotion takes effect on the target's next call and
// a rename needs no re-login. Existence and the last-admin rule are decided on the list read inside the users.json queue.
app.patch("/api/users/:email", requireAdmin, async (req, res) => {
  // Phase 5 (2026-09-05): Express has already decoded :email — a second decode turned %2540 into "@" (the route then
  // acted on an account the path did not name) and threw URIError on a broken percent, answered as 500.
  const targetEmail = authUtils.normalizeEmail(req.params.email);
  const adminEmail = req.userSession.email;
  if (!targetEmail) return res.status(400).json({ error: "Email required" });

  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : null;
  const patch = {};
  if (body && body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "staff") return res.status(400).json({ error: "Role must be admin or staff" });
    patch.role = body.role;
  }
  if (body && body.name !== undefined) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 80) return res.status(400).json({ error: "Name is required (max 80 characters)" });
    patch.name = name;
  }
  if (patch.role === undefined && patch.name === undefined) return res.status(400).json({ error: "Send {role} and/or {name}" });
  // renaming yourself is fine; changing your own role is not — it needs no data, so it is answered before the queue
  if (patch.role !== undefined && sameEmail(targetEmail, adminEmail)) return res.status(400).json({ error: "You cannot change your own role" });

  const changedFields = [];
  const detailParts = [];
  let r;
  try {
    r = await lockedUpdate("users.json", list => {
      const idx = findUserIndex(list, targetEmail);
      const before = list[idx];
      if (!before) throw httpError(404, "User not found");
      const changes = {};
      Object.keys(patch).forEach(k => { if (before[k] !== patch[k]) changes[k] = patch[k]; });
      if (changes.role === "staff" && before.role === "admin" && list.filter(u => u && u.role === "admin").length <= 1) {
        throw httpError(409, "Cannot demote the last admin");
      }
      if (changes.role !== undefined) { changedFields.push("role"); detailParts.push(`role ${before.role === "admin" ? "admin" : "staff"} → ${changes.role}`); }
      if (changes.name !== undefined) { changedFields.push("name"); detailParts.push(`name "${before.name || ""}" → "${changes.name}"`); }
      if (changedFields.length === 0) return null; // nothing to change — no write, no audit entry
      const after = Object.assign({}, before, changes, { updatedAt: Date.now() });
      return list.map((x, i) => i === idx ? after : x);
    }, () => ({ action: "user_updated", user: adminEmail, details: `[users] ${targetEmail}: ${detailParts.join(", ")}` }));
  } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); throw e; }
  if (!r.ok) return res.status(500).json({ error: "Write failed" });
  const updated = r.data;
  const current = updated[findUserIndex(updated, targetEmail)];
  if (r.skipped) return res.json({ ok: true, user: authUtils.publicUser(current) });
  console.log(`✏️ User updated: ${targetEmail} (${changedFields.join(", ")}) by ${adminEmail}`);
  res.json({ ok: true, user: authUtils.publicUser(current) });
});

// Phase 2 (2026-09-05): admin resets a user's password — a new generated one is returned once; the user's sessions end.
app.post("/api/users/:email/reset-password", requireAdmin, async (req, res) => {
  // Phase 5 (2026-09-05): Express has already decoded :email — a second decode turned %2540 into "@" (the route then
  // acted on an account the path did not name) and threw URIError on a broken percent, answered as 500.
  const targetEmail = authUtils.normalizeEmail(req.params.email);
  if (findUserIndex(readJSON("users.json", []), targetEmail) === -1) return res.status(404).json({ error: "User not found" }); // early answer; decided again on the fresh list
  const password = authUtils.generatePassword();
  const newScrypt = authUtils.hashPassword(password); // hashed before entering the queue (scrypt is slow)
  let r;
  try {
    r = await lockedUpdate("users.json", list => {
      const idx = findUserIndex(list, targetEmail);
      if (idx === -1) throw httpError(404, "User not found");
      const u = Object.assign({}, list[idx], { passwordScrypt: newScrypt, updatedAt: Date.now() });
      delete u.passwordHash;
      return list.map((x, i) => i === idx ? u : x);
    }, { action: "password_reset", user: req.userSession.email, details: `[users] password reset for ${targetEmail}` });
  } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); throw e; }
  if (!r.ok) return res.status(500).json({ error: "Write failed" });
  endSessionsFor(targetEmail);
  writeAuditLog("auth", "password_reset", req.userSession.email, `for ${targetEmail}, IP: ${req.ip}`, req.ip);
  console.log(`🔑 Password reset: ${targetEmail} by ${req.userSession.email}`);
  res.json({ ok: true, email: targetEmail, password });
});

// Phase 2 (2026-09-05): a signed-in user changes their own password; every session of the user ends (the page sends
// them back to the login form).
app.post("/api/me/password", requireAuth, async (req, res) => {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const current = typeof body.current === "string" ? body.current : "";
  const next = typeof body.new === "string" ? body.new : "";
  if (next.length < authUtils.PASSWORD_MIN_LENGTH) return res.status(400).json({ error: `Password must be at least ${authUtils.PASSWORD_MIN_LENGTH} characters` });
  if (next.length > 200 || current.length > 200) return res.status(400).json({ error: "Password too long (max 200)" });
  if (next === current) return res.status(400).json({ error: "The new password must differ from the current one" });
  const email = req.userSession.email;
  // guessing the current password with a stolen token is metered by the same per-e-mail throttle as the login form
  const lock = loginThrottle.check(email);
  if (lock.locked) {
    res.set("Retry-After", String(lock.retryAfterSec));
    return res.status(429).json({ error: `Too many failed attempts — try again in ${lock.retryAfterMin} min` });
  }
  const existing = readJSON("users.json", []);
  const idx = findUserIndex(existing, email);
  if (idx === -1) return res.status(401).json({ error: "Invalid or expired session" });
  if (!authUtils.verifyPassword(current, existing[idx])) {
    const failure = loginThrottle.recordFailure(email);
    writeAuditLog("auth", "password_change_failed", email, "wrong current password, IP: " + req.ip, req.ip);
    if (failure.locked) { res.set("Retry-After", String(failure.retryAfterSec)); return res.status(429).json({ error: `Too many failed attempts — try again in ${failure.retryAfterMin} min` }); }
    return res.status(401).json({ error: "Current password is incorrect" });
  }
  loginThrottle.clear(email);
  const newScrypt = authUtils.hashPassword(next); // hashed before entering the queue (scrypt is slow)
  let r;
  try {
    r = await lockedUpdate("users.json", list => {
      const i = findUserIndex(list, email);
      if (i === -1) throw httpError(401, "Invalid or expired session");
      const u = Object.assign({}, list[i], { passwordScrypt: newScrypt, updatedAt: Date.now() });
      delete u.passwordHash;
      return list.map((x, j) => j === i ? u : x);
    }, { action: "password_changed", user: email, details: "[users] password changed by the user" });
  } catch (e) { if (e.status && e.status < 500) return res.status(e.status).json({ error: e.message }); throw e; }
  if (!r.ok) return res.status(500).json({ error: "Write failed" });
  endSessionsFor(email);
  writeAuditLog("auth", "password_changed", email, "IP: " + req.ip, req.ip);
  res.status(204).end();
});

function cleanUiNav(nav) {
  if (!nav || typeof nav !== "object" || Array.isArray(nav)) return { error: "nav must be an object or null" };
  const raw = JSON.stringify(nav);
  if (Buffer.byteLength(raw, "utf8") > 16384) return { error: "nav is too large (max 16384 bytes)" };
  if (nav.v !== 1) return { error: "nav.v must be 1" };
  if (!Array.isArray(nav.groups)) return { error: "nav.groups must be an array" };
  if (nav.groups.length > 30) return { error: "nav.groups must have at most 30 entries" };
  const groups = [];
  const seenGroups = new Set(), seenItems = new Set();
  for (const g of nav.groups) {
    if (!g || typeof g !== "object" || Array.isArray(g)) return { error: "each group must be an object" };
    if (typeof g.id !== "string" || !/^[a-z0-9-]{1,40}$/.test(g.id)) return { error: "invalid group id" };
    if (seenGroups.has(g.id)) return { error: "duplicate group id" };
    seenGroups.add(g.id);
    if (Object.prototype.hasOwnProperty.call(g, "collapsed") && typeof g.collapsed !== "boolean") return { error: "group.collapsed must be a boolean" };
    if (Object.prototype.hasOwnProperty.call(g, "hidden") && typeof g.hidden !== "boolean") return { error: "group.hidden must be a boolean" };
    if (!Array.isArray(g.items)) return { error: "group.items must be an array" };
    if (g.items.length > 100) return { error: "group.items must have at most 100 entries" };
    const items = [];
    for (const it of g.items) {
      if (typeof it !== "string" || !/^[a-z0-9-]{1,60}$/.test(it)) return { error: "invalid item id" };
      if (seenItems.has(it)) return { error: "duplicate item id" };
      seenItems.add(it);
      items.push(it);
    }
    const out = { id: g.id };
    if (Object.prototype.hasOwnProperty.call(g, "collapsed")) out.collapsed = g.collapsed;
    if (Object.prototype.hasOwnProperty.call(g, "hidden")) out.hidden = g.hidden;
    out.items = items;
    groups.push(out);
  }
  return { nav: { v: 1, groups } };
}

app.get("/api/me/prefs", requireAuth, (req, res) => {
  const email = authUtils.normalizeEmail(req.userSession.email);
  const list = readJSON("ui-prefs.json", []);
  const rec = list.find(e => e && sameEmail(e.email, email));
  const prefs = rec ? { nav: rec.nav == null ? null : rec.nav, updatedAt: rec.updatedAt == null ? null : rec.updatedAt } : { nav: null, updatedAt: null };
  res.json({ ok: true, email, prefs });
});

app.put("/api/me/prefs", requireAuth, async (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body) || !Object.prototype.hasOwnProperty.call(body, "nav")) {
    return res.status(400).json({ error: "Body must be an object with a nav field" });
  }
  const navIn = body.nav;
  let cleaned = null;
  if (navIn !== null) {
    const checked = cleanUiNav(navIn);
    if (checked.error) return res.status(400).json({ error: checked.error });
    cleaned = checked.nav;
  }
  const email = authUtils.normalizeEmail(req.userSession.email);
  let updatedAt = null;
  const r = await lockedUpdate("ui-prefs.json", list => {
    const next = list.filter(e => !(e && sameEmail(e.email, email)));
    if (navIn !== null) { updatedAt = new Date().toISOString(); next.push({ email, nav: cleaned, updatedAt }); }
    return next;
  });
  if (!r.ok) return res.status(500).json({ error: "Write failed" });
  res.json({ ok: true, email, prefs: { nav: cleaned, updatedAt } });
});

// Phase 6 (2026-09-05): GET /api/versions and the ZIP export/import 501 stubs were removed — Blitz table versions, no caller (see keep_remove_table.md).

// Phase 6 (2026-09-05): the Blitz backup/restore HTTP routes (download, restore from a request body, list, manual backup) and the BLITZ_BACKUP_DENY guard that hid them were removed — createBackup()/cleanupBackups() and the startup/hourly backups stay (see keep_remove_table.md).

// ═══════════════════════════════════════════════════════════════
// 9. HTTP SERVER
// ═══════════════════════════════════════════════════════════════

const server = http.createServer(app);

// Phase 7 (2026-09-06): the WebSocket server on /ws (client set, auth at the upgrade, "versions"/"pong"/heartbeat
// messages) and broadcastUpdate() were removed — no page has opened a socket since the front-end shell landed, so the
// only traffic here was the heartbeat timer. With no 'upgrade' listener left, an upgrade request to /ws is answered by
// the normal Express stack (404). The nginx /ws locations on the CRM hosts can go with it.

// ═══════════════════════════════════════════════════════════════
// 10. AUDIT LOG ENDPOINTS
// ═══════════════════════════════════════════════════════════════

// GET audit logs for a specific date or range
app.get("/api/audit", requireAdmin, (req, res) => {
  const { date, days } = req.query;
  const targetDate = date || new Date().toISOString().split('T')[0];
  const numDays = parseInt(days) || 1;

  const logs = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(targetDate);
    d.setDate(d.getDate() - i);
    const dateKey = d.toISOString().split('T')[0];
    const logFile = path.join(AUDIT_DIR, `audit_${dateKey}.jsonl`);
    try {
      if (fs.existsSync(logFile)) {
        const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
        lines.forEach(line => {
          try { logs.push(JSON.parse(line)); } catch {}
        });
      }
    } catch {}
  }

  logs.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  res.json(logs.slice(0, 500)); // Max 500 entries
});

// Phase 6 (2026-09-05): GET /api/backups, POST /api/restore/:backup and POST /api/backup were removed — Blitz point-in-time recovery over HTTP, no caller (see keep_remove_table.md).

// ═══════════════════════════════════════════════════════════════
// 12. HEALTH & MONITORING
// ═══════════════════════════════════════════════════════════════

// Activity feed — phase 0 (2026-09-04): requires a valid session (was an open "temporary debug" endpoint)
app.get("/api/activity", requireAuth, (req, res) => {
  // Real CRM Activity Feed - merges multiple data sources
  const MSOL = '/var/www/mastersol/html/MSOLPEPTIDES';
  const activities = [];
  
  function safeRead(filePath) {
    try { return JSON.parse(require('fs').readFileSync(filePath, 'utf8')); }
    catch(e) { return []; }
  }
  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + ' min ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' hr ago';
    return Math.floor(diff / 86400000) + 'd ago';
  }
  function fmtTime(dt) {
    try { return new Date(dt).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }); }
    catch(e) { return '--:--'; }
  }
  function fmtDate(dt) {
    try { return new Date(dt).toLocaleDateString('en-US', { month: 'short', day: '2-digit' }); }
    catch(e) { return ''; }
  }
  
  // 1. Activity Log (stock writeoffs, supplier payments, etc.)
  safeRead(MSOL + '/activity_log.json').forEach(entry => {
    const iconMap = { stock_writeoff:'\u{1F4E6}', supplier_payment:'\u{1F4B8}', stock_movement:'\u{1F504}', sale:'\u{1F4B0}', customer_created:'\u{1F9D1}', order:'\u{1F6D2}', quotation:'\u{1F4CB}', purchase_order:'\u{1F69A}', expense:'\u{1F4DD}' };
    activities.push({
      icon: iconMap[entry.type] || '\u{1F4CC}',
      company: entry.type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
      action: entry.description || entry.type,
      time: fmtTime(entry.created_at),
      date: fmtDate(entry.created_at),
      timestamp: new Date(entry.created_at).getTime() / 1000,
      color: 'new',
      type: entry.type,
      user: entry.user || 'system',
      ago: timeAgo(entry.created_at)
    });
  });
  
  // 2. Store Orders
  safeRead(MSOL + '/orders.json').forEach(order => {
    const dt = order.created_at || order.date || order.timestamp || order.savedAt;
    if (!dt) return;
    const cust = order.customer ? ((order.customer.firstName || '') + ' ' + (order.customer.lastName || '')).trim() : 'Unknown';
    const items = (order.items || []).map(i => i.qty + 'x ' + i.name).join(', ') || 'Items';
    const total = parseFloat(order.total || order.subtotal) || (order.items || []).reduce((s, i) => s + (parseFloat(i.price) || 0) * (parseInt(i.qty) || 0), 0);
    activities.push({
      icon: '\u{1F6D2}', company: 'Order ' + (order.ref || ''),
      action: cust + ': ' + items + ' ($' + total.toFixed(2) + ')',
      time: fmtTime(dt), date: fmtDate(dt),
      timestamp: new Date(dt).getTime() / 1000,
      color: 'new', type: 'order', ago: timeAgo(dt)
    });
  });
  
  // 3. Sales
  safeRead(MSOL + '/sales.json').forEach(sale => {
    const dt = sale.created_at || sale.date || sale.timestamp || sale.savedAt;
    if (!dt) return;
    activities.push({
      icon: '\u{1F4B0}', company: sale.customer || sale.client || 'Sale',
      action: 'Sale: ' + (sale.product || sale.items || '') + ' - $' + (parseFloat(sale.amount || sale.total) || 0).toFixed(2),
      time: fmtTime(dt), date: fmtDate(dt),
      timestamp: new Date(dt).getTime() / 1000,
      color: 'new', type: 'sale', ago: timeAgo(dt)
    });
  });
  
  // 4. New Customers
  safeRead(MSOL + '/customers.json').forEach(c => {
    if (!c.created_at || c.id === 'walkin') return;
    activities.push({
      icon: '\u{1F9D1}', company: c.name || c.customer_id || 'Customer',
      action: 'New customer (' + (c.type || 'Individual') + ')',
      time: fmtTime(c.created_at), date: fmtDate(c.created_at),
      timestamp: new Date(c.created_at).getTime() / 1000,
      color: 'new', type: 'customer_created', ago: timeAgo(c.created_at)
    });
  });
  
  // 5. Stock Movements
  safeRead(MSOL + '/stock_movements.json').forEach(m => {
    const dt = m.created_at || m.date || m.timestamp;
    if (!dt) return;
    activities.push({
      icon: '\u{1F504}', company: m.product || 'Stock',
      action: 'Stock ' + (m.direction || 'movement') + ': ' + (m.qty || 0) + ' units',
      time: fmtTime(dt), date: fmtDate(dt),
      timestamp: new Date(dt).getTime() / 1000,
      color: '', type: 'stock_movement', ago: timeAgo(dt)
    });
  });
  
  // 6. Supplier Payments
  safeRead(MSOL + '/supplier_payments.json').forEach(p => {
    const dt = p.created_at || p.date || p.timestamp || p.payment_date;
    if (!dt) return;
    activities.push({
      icon: '\u{1F4B8}', company: p.supplier || 'Supplier',
      action: 'Payment: $' + (parseFloat(p.amount) || 0).toFixed(2) + ' - ' + (p.method || ''),
      time: fmtTime(dt), date: fmtDate(dt),
      timestamp: new Date(dt).getTime() / 1000,
      color: '', type: 'supplier_payment', ago: timeAgo(dt)
    });
  });
  
  // Sort by timestamp descending
  activities.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  
  res.json({
    ok: true,
    activities: activities.slice(0, 20),
    total: activities.length,
    updated: new Date().toISOString(),
    sources: {
      activity_log: safeRead(MSOL + '/activity_log.json').length,
      orders: safeRead(MSOL + '/orders.json').length,
      sales: safeRead(MSOL + '/sales.json').length,
      customers: safeRead(MSOL + '/customers.json').length,
      stock_movements: safeRead(MSOL + '/stock_movements.json').length,
      supplier_payments: safeRead(MSOL + '/supplier_payments.json').length
    }
  });
});

app.get("/api/health", (req, res) => {
  // Public: basic status only. No sensitive info.
  const basic = { status: "ok", version: VERSION, time: new Date().toISOString() };

  // If authenticated as admin, include extended info
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const session = activeSessions.get(authHeader.slice(7));
    if (session && isAdminEmail(session.email)) {
      const dataFiles = endpoints.map(ep => {
        const file = path.join(DATA_DIR, ep + ".json");
        const exists = fs.existsSync(file);
        let size = 0, records = 0;
        if (exists) { size = fs.statSync(file).size; try { records = JSON.parse(fs.readFileSync(file, "utf8")).length; } catch {} }
        return { table: ep, exists, size, records, version: getVersion(ep) };
      });
      return res.json({ ...basic, uptime: process.uptime(), sessions: activeSessions.size, tables: dataFiles });
    }
  }
  res.json(basic);
});

// Phase 6 (2026-09-05): GET /api/logs, /api/logs/download and /api/logs/list were removed with SERVER_LOG_BUFFER — Blitz diagnostics, no caller; writeLog keeps writing logs/blitz-*.log (see keep_remove_table.md).

// Phase 6 (2026-09-05): section 13 (Telegram bot polling and commands, group message formats, USDT/TRC20/ERC20/BTC checks, wallet verification, the offer-message parser and the leadgreed audit route) was removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).


// Phase 6 (2026-09-05): POST /api/admin/backup, POST /api/admin/dedup, POST /api/reconcile and GET /api/autob2026/status were removed — Blitz affiliate-CRM code, no caller (see keep_remove_table.md).

// Phase 7 (2026-09-06): the global error handler moved below the agent modules' mounts (section 14) — registered
// here it never saw a throw or a rejected promise from leads-store.cjs / cio-routes.cjs, and Express answered those with
// its own HTML page.
// ═══════════════════════════════════════════════════════════════
// MEMORY MONITORING — detect leaks before they crash
// ═══════════════════════════════════════════════════════════════
const memoryLog = [];
const MAX_MEMORY_LOG = 120;

function getMemorySnapshot() {
  const mem = process.memoryUsage();
  return {
    timestamp: new Date().toISOString(),
    rss: Math.round(mem.rss / 1024 / 1024),
    heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
    heapTotal: Math.round(mem.heapTotal / 1024 / 1024),
    external: Math.round(mem.external / 1024 / 1024),
    sessions: activeSessions.size,
    uptime: Math.round(process.uptime()),
  };
}

setInterval(() => {
  const snap = getMemorySnapshot();
  memoryLog.push(snap);
  if (memoryLog.length > MAX_MEMORY_LOG) memoryLog.shift();
  if (snap.heapUsed > 400) {
    console.error(`🚨 HIGH MEMORY: heap=${snap.heapUsed}MB rss=${snap.rss}MB`);
  }
  // v9.05: Force GC at 500MB to prevent OOM
  if (snap.heapUsed > 500 && global.gc) {
    console.warn(`🧹 Forcing GC at ${snap.heapUsed}MB heap...`);
    try { global.gc(); } catch {}
  }
  if (memoryLog.length >= 10) {
    const tenAgo = memoryLog[memoryLog.length - 10];
    const growth = snap.heapUsed - tenAgo.heapUsed;
    if (growth > 50) console.error(`🚨 MEMORY LEAK: heap grew ${growth}MB in 10min (${tenAgo.heapUsed}→${snap.heapUsed}MB)`);
  }
}, 60000);

// Phase 6 (2026-09-05): GET /api/admin/diagnostics and GET /api/admin/logs/download were removed — Blitz diagnostics, no caller; the memory monitor above stays (see keep_remove_table.md).

// ═══════════════════════════════════════════════════════════════
// GRACEFUL SHUTDOWN — flush data before dying
// ═══════════════════════════════════════════════════════════════
let shutdownInProgress = false; // v11.02 M3: prevent double-shutdown on SIGTERM+SIGINT
function gracefulShutdown(signal) {
  if (shutdownInProgress) return;
  shutdownInProgress = true;
  console.log(`\n🛑 ${signal} — graceful shutdown...`);
  server.close(() => console.log("✅ HTTP closed"));
  persistSessions();
  try { createBackup("shutdown-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)); console.log("✅ Emergency backup"); } catch {}
  writeAuditLog("system", "shutdown", "system", `${signal} — uptime: ${Math.round(process.uptime())}s, heap: ${Math.round(process.memoryUsage().heapUsed/1024/1024)}MB`);
  setTimeout(() => process.exit(0), 2000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ═══════════════════════════════════════════════════════════════
// 14. START SERVER
// ═══════════════════════════════════════════════════════════════

// Phase 6 (2026-09-05): the built-React static mount and the SPA fallback were removed — /opt/crm-api/public does not exist and nginx proxies only /api to this port (see keep_remove_table.md).

// Campaigns & Email Management module (v14.09)
// Phase 7 (2026-09-06): these two mounts stay where they are; the error middleware is registered AFTER them (below), so
// a throw or a rejected promise inside their routes is answered with JSON instead of Express' HTML page.
try {
  require('./leads-store.cjs')({ app, requireAuth, requireAdmin, DATA_DIR });
  console.log('✅ leads-store.cjs mounted');
} catch (e) {
  console.warn('⚠️  leads-store.cjs failed:', e.message);
}
try {
  require('./cio-routes.cjs')({ app, requireAuth, requireAdmin, DATA_DIR });
  console.log('✅ cio-routes.cjs mounted');
} catch (e) {
  console.warn('⚠️  cio-routes.cjs failed:', e.message);
}
// Marketing segments (M2, 2026-09-08): rules over the same attributes that already travel to Customer.io with
// every identify, kept in step with a manual segment there. Wrapped like the two mounts above for the same
// reason — a broken module must cost the Segments page, not the CRM login. Auth stands at the mount; the module
// writes nothing but its own two files, and it writes them through lockedUpdate.
try {
  const segmentsRoutes = require('./marketing-segments.cjs')({ lockedUpdate, DATA_DIR });
  app.use('/api/marketing/segments', requireAuth, segmentsRoutes);
  console.log('✅ marketing-segments.cjs mounted');
} catch (e) {
  console.warn('⚠️  marketing-segments.cjs failed:', e.message);
}
// Marketing panel (M1, 2026-09-08): read-only view of the Customer.io account. Wrapped like the two
// mounts above for the same reason — a broken module must cost the Marketing page, not the CRM login.
// Auth is applied here, at the mount, so no route inside can be published by accident.
try {
  app.use('/api/marketing', requireAuth, require('./marketing-routes.cjs'));
  console.log('✅ marketing-routes.cjs mounted');
} catch (e) {
  console.warn('⚠️  marketing-routes.cjs failed:', e.message);
}

// ── M3 newsletter mount (begin) ─────────────────────────────────────────────────────
// Newsletter (M3, 2026-09-08): one-off letters through the API-triggered broadcast in Customer.io.
// Wrapped like the mounts above for the same reason — a broken module must cost the Newsletter page,
// not the CRM login. Auth is applied at the mount, so no route inside can be published by accident.
// lockedUpdate and DATA_DIR are handed in: data/marketing-newsletters.json is written through the same
// per-table queue as every other table of this server, and READ by the module itself, because readJSON()
// answers an unreadable file with its fallback and a fallback of [] would wipe the record of every issue
// ever sent (the same reasoning as marketing-segments.cjs).
try {
  app.use('/api/marketing/newsletter', requireAuth,
    require('./marketing-newsletter.cjs')({ lockedUpdate, DATA_DIR }));
  console.log('✅ marketing-newsletter.cjs mounted');
} catch (e) {
  console.warn('⚠️  marketing-newsletter.cjs failed:', e.message);
}
// ── M3 newsletter mount (end) ───────────────────────────────────────────────────────

// Phase 0 (2026-09-04): GET /api/sheets-token removed (returned a Google OAuth token without auth).
// M4 (2026-09-08): letter texts in Customer.io and the two person actions. Two mounts, one module: the routers
// are separate so that /api/marketing/emails and /api/marketing/people can be told apart in the log and in nginx
// if they ever need different limits. requireAuth sits on the mount, so no route inside can be published by
// accident, and the try/catch keeps a broken module from taking the whole CRM (and its login) down with it.
try {
  const marketingEmails = require('./marketing-emails.cjs')({ DATA_DIR, lockedUpdate, writeAuditLog });
  app.use('/api/marketing/emails', requireAuth, marketingEmails.emails);
  app.use('/api/marketing/people', requireAuth, marketingEmails.people);
  console.log('✅ marketing-emails.cjs mounted (/api/marketing/emails, /api/marketing/people)');
} catch (e) {
  console.error('⚠️ marketing-emails.cjs not mounted:', e.message);
}

// Ad spend (2026-10-01): entries for the Ad spend & ROAS section of Finance Reports (GET/POST /api/marketing/spend, DELETE /:id).
// requireAuth on the mount (every signed-in user may write, STAFF_WRITES = all); written through lockedUpdate; a broken module
// must not take the CRM's login down with it.
try {
  app.use('/api/marketing/spend', requireAuth, require('./marketing-spend.cjs')({ lockedUpdate, DATA_DIR }));
  console.log('✅ marketing-spend.cjs mounted (/api/marketing/spend)');
} catch (e) {
  console.error('⚠️ marketing-spend.cjs not mounted:', e.message);
}

// Journeys (2026-09-30): the map of shop events against Customer.io journeys, read only (GET /api/marketing/journeys).
// Same shape as the mounts above: requireAuth on the mount, and a broken module must not take the CRM's login down with it.
try {
  app.use('/api/marketing/journeys', requireAuth, require('./marketing-journeys.cjs')({}));
  console.log('✅ marketing-journeys.cjs mounted (/api/marketing/journeys)');
} catch (e) {
  console.error('⚠️ marketing-journeys.cjs not mounted:', e.message);
}

// Customer timeline (2026-09-30): one read-only customer record per e-mail across leads, both order books (orders.json,
// crm-umg store.json), abandoned checkouts, contact messages and the consent log (GET /api/customers, /api/customers/:email).
// PII, so requireAuth sits on the mount; the module only reads its sources. Wrapped like the mounts above.
try {
  app.use('/api/customers', requireAuth, require('./customer-timeline.cjs')({ dataDir: DATA_DIR }));
  console.log('✅ customer-timeline.cjs mounted (/api/customers)');
} catch (e) {
  console.error('⚠️ customer-timeline.cjs not mounted:', e.message);
}

// Automations (2026-10-01): the live status of the shop's automations for the CRM page Automations, read only
// (GET /api/automations/status). Staff only (requireAuth on the mount); the module reads a white list of .env keys, status
// files and queue counts and sends nothing. Wrapped like the mounts above: a broken module must not take the login down.
try {
  app.use('/api/automations/status', requireAuth, require('./automations-status.cjs')({}));
  console.log('✅ automations-status.cjs mounted (/api/automations/status)');
} catch (e) {
  console.error('⚠️ automations-status.cjs not mounted:', e.message);
}

// Unit costs (2026-09-30): the supplier price list for the gross margin on Finance Reports (GET /api/unit-costs).
// Staff only; data/unit-costs.json is read per request. Wrapped like the mounts above.
try {
  app.use('/api/unit-costs', requireAuth, require('./unit-costs.cjs')({ file: path.join(DATA_DIR, 'unit-costs.json') }));
  console.log('✅ unit-costs.cjs mounted (/api/unit-costs)');
} catch (e) {
  console.error('⚠️ unit-costs.cjs not mounted:', e.message);
}

// ═══════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER — catch-all, always returns JSON
// Last middleware in the stack, so it also answers for the modules mounted above.
// ═══════════════════════════════════════════════════════════════
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err); // review S: a response already under way is closed by Express' final handler instead of hanging until the client times out
  // A body-parser verdict is a client mistake, answered without a line from this handler (the 4xx logger above records it since phase 8, when express.json moved below it).
  if (err.type === 'entity.too.large') {
    if (!res.headersSent) res.status(413).json({ error: "Request body too large" });
    return;
  }
  if (err.type === 'entity.parse.failed') { // only body-parser's verdict: a SyntaxError thrown inside a route is a server bug and stays 500
    if (!res.headersSent) res.status(400).json({ error: "Invalid JSON in request body" });
    return;
  }
  console.error('💥 Express error:', err.message);
  // Phase 5 (2026-09-05): a client error that Express/body-parser already classified (err.status 4xx — a broken percent
  // in a route param, malformed JSON, oversized body) is answered with that code; anything else stays 500 with no detail.
  const code = Number.isInteger(err.status) && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (!res.headersSent) res.status(code).json({ error: code === 500 ? "Internal server error" : "Bad request" });
});

server.listen(PORT, "127.0.0.1", () => {
  const startTime = new Date().toISOString();
  // Count records in each data file for startup report
  const dataReport = {};
  ['users'].forEach(ep => { // phase 6 (2026-09-05): users.json is the only data file left
    const file = path.join(DATA_DIR, ep + '.json');
    try {
      if (fs.existsSync(file)) {
        const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
        dataReport[ep] = Array.isArray(arr) ? arr.length : 'N/A';
      } else { dataReport[ep] = 'MISSING'; }
    } catch(e) { dataReport[ep] = `ERROR: ${e.message}`; }
  });

  // Write startup log to file
  writeLog(LOG_LEVELS.STARTUP, 'server', `Blitz CRM v${VERSION} started on port ${PORT}`, {
    nodeVersion: process.version,
    platform: process.platform,
    pid: process.pid,
    dataDir: DATA_DIR,
    dataReport,
    startTime
  });

  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║  🚀 Blitz CRM Server v${VERSION}               ║`);
  console.log(`║  📡 HTTP on port ${PORT}                        ║`);
  console.log(`║  💾 Data: ${DATA_DIR.slice(-30).padEnd(30)}    ║`);
  console.log(`║  📦 Hourly backups + daily snapshots (7-day)  ║`);
  console.log(`║  📋 Audit: 30-day rolling log                ║`);
  console.log(`║  🔒 WAL atomic writes + concurrency queue     ║`);
  console.log(`║  🛡️  Auto-ban attackers + path traversal block ║`);
  console.log(`╚══════════════════════════════════════════════╝\n`);
  console.log(`📊 Data files: ${JSON.stringify(dataReport)}`);
  console.log(`📁 Logs directory: ${LOG_DIR}`);
});

// Phase 0 (2026-09-04): POST /api/set-sheets-token removed (secret in code, wrote into /root).
