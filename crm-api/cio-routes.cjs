'use strict';

/**
 * BioFirest CRM — Customer.io proxy, segments, RUO lint, unsubscribe suppression.
 * Keys load from process.env and optional /opt/crm-api/cio.env.
 * NEVER expose keys to the client. Never log secret values.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const RUO_PATTERNS = [
  { term: 'mg/kg', re: /\bmg\s*\/\s*kg\b/i },
  { term: 'mcg', re: /\bmcg\b/i },
  { term: 'per week', re: /\bper\s+week\b/i },
  { term: 'cycle', re: /\bcycle\b/i },
  { term: 'reconstitution', re: /\breconstitut(?:e|ion|ing)\b/i },
  { term: 'injection', re: /\binject(?:ion|ions|ed|ing)?\b/i },
  { term: 'protocol', re: /\bprotocol\b/i },
  { term: 'weight loss', re: /\bweight\s*loss\b/i },
  { term: 'burn fat', re: /\bburn(?:s|ing)?\s+fat\b/i },
  { term: 'heals', re: /\bheals?\b/i },
  { term: 'treats', re: /\btreats?\b/i },
  { term: 'like Ozempic', re: /\blike\s+ozempic\b/i },
  { term: 'alternative to', re: /\balternative\s+to\b/i },
];

const SEGMENT_FIELDS = new Set([
  'country',
  'product_category',
  'order_count',
  'total_spent',
  'email_opens',
  'email_clicks',
  'account_age_days',
  'last_order_date',
]);

const SEGMENT_OPS = new Set(['eq', 'neq', 'in', 'gte', 'lte', 'gt', 'lt', 'after', 'before']);

function ruoLint(text) {
  const src = String(text || '');
  const blocked = [];
  for (const p of RUO_PATTERNS) {
    if (p.re.test(src)) blocked.push(p.term);
  }
  return { ok: blocked.length === 0, blocked_terms: blocked };
}

function parseEnvFile(filePath) {
  const out = {};
  try {
    if (!fs.existsSync(filePath)) return out;
    for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const m = t.match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch (e) {
    console.warn('[cio] env read failed:', e.message);
  }
  return out;
}

function loadCioConfig() {
  const fileEnv = parseEnvFile('/opt/crm-api/cio.env');
  const appKey = process.env.CIO_APP_API_KEY || fileEnv.CIO_APP_API_KEY || '';
  const trackKey = process.env.CIO_TRACKING_API_KEY || fileEnv.CIO_TRACKING_API_KEY || '';
  const siteId = process.env.CIO_SITE_ID || fileEnv.CIO_SITE_ID || '';
  return {
    appKey: String(appKey).trim(),
    trackKey: String(trackKey).trim(),
    siteId: String(siteId).trim(),
    configured: Boolean(String(appKey).trim()),
  };
}

function notConfigured(res) {
  return res.json({ ok: false, error: 'cio_not_configured' });
}

function httpJson(opts, body, attempt) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, r => {
      let d = '';
      r.on('data', c => { d += c; });
      r.on('end', () => {
        let json = null;
        try { json = d ? JSON.parse(d) : {}; } catch { json = { raw: d.slice(0, 240) }; }
        resolve({ status: r.statusCode, json, headers: r.headers });
      });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(new Error('cio_timeout')); });
    if (body) req.write(body);
    req.end();
  }).then(async result => {
    if (result.status === 429 && !attempt) {
      await new Promise(r => setTimeout(r, 800));
      return httpJson(opts, body, true);
    }
    return result;
  });
}

function cioRequest(cfg, method, apiPath, payload) {
  const body = payload == null ? null : JSON.stringify(payload);
  const headers = {
    Authorization: 'Bearer ' + cfg.appKey,
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return httpJson({
    hostname: 'api.customer.io',
    path: apiPath.startsWith('/v1/') ? apiPath : '/v1/' + apiPath.replace(/^\//, ''),
    method,
    headers,
  }, body);
}

function nowIso() { return new Date().toISOString(); }
function newId() { return 'seg_' + crypto.randomBytes(6).toString('hex'); }

function sanitizeRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const field = String(rule.field || '').trim();
  const op = String(rule.op || 'eq').trim();
  if (!SEGMENT_FIELDS.has(field) || !SEGMENT_OPS.has(op)) return null;
  return { field, op, value: rule.value };
}

function sanitizeSegment(body, existing) {
  const name = String((body && body.name) || (existing && existing.name) || '').trim();
  const rawRules = (body && body.rules) || (existing && existing.rules) || [];
  const rules = Array.isArray(rawRules) ? rawRules.map(sanitizeRule).filter(Boolean) : [];
  return { name, rules };
}

module.exports = function mountCioRoutes({ app, requireAuth, requireAdmin, DATA_DIR }) {
  if (!app || !requireAuth || !requireAdmin) throw new Error('cio-routes: app, requireAuth, requireAdmin required');

  const segFile = path.join(DATA_DIR, 'segments.json');
  const metaFile = path.join(DATA_DIR, 'cio-meta.json');

  function readJson(file, fallback) {
    try {
      if (!fs.existsSync(file)) return fallback;
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return raw == null ? fallback : raw;
    } catch (e) {
      console.warn('[cio] read', path.basename(file), e.message);
      return fallback;
    }
  }
  function writeJson(file, data) {
    const tmp = file + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }
  if (!fs.existsSync(segFile)) writeJson(segFile, []);
  if (!fs.existsSync(metaFile)) writeJson(metaFile, { last_sync_at: null });

  function readLeads() {
    try {
      const f = path.join(DATA_DIR, 'leads.json');
      if (!fs.existsSync(f)) return [];
      const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
      return Array.isArray(raw) ? raw : [];
    } catch { return []; }
  }

  function resolveTriggerAudience(body) {
    const leads = readLeads();
    const wanted = new Map();
    const ids = Array.isArray(body && body.lead_ids) ? body.lead_ids : [];
    const emails = Array.isArray(body && body.emails) ? body.emails.map(e => String(e).toLowerCase()) : [];
    const segmentId = body && body.segment_id;

    if (ids.length) {
      for (const l of leads) if (ids.includes(l.id)) wanted.set(l.id, l);
    }
    if (emails.length) {
      for (const l of leads) if (l.email && emails.includes(String(l.email).toLowerCase())) wanted.set(l.id, l);
    }
    if (segmentId) {
      const segs = readJson(segFile, []);
      const seg = segs.find(s => s.id === segmentId);
      if (seg) {
        for (const l of leads) {
          if (leadMatchesSegment(l, seg)) wanted.set(l.id, l);
        }
      }
    }
    if (!ids.length && !emails.length && !segmentId) {
      for (const l of leads) wanted.set(l.id, l);
    }

    const all = [...wanted.values()];
    const excluded = all.filter(l => l.unsubscribed);
    const allowed = all.filter(l => !l.unsubscribed);
    return { allowed, excluded };
  }

  function leadMatchesSegment(lead, seg) {
    const rules = (seg && seg.rules) || [];
    if (!rules.length) return false;
    return rules.every(rule => matchRule(lead, rule));
  }

  function matchRule(lead, rule) {
    const field = rule.field;
    const op = rule.op;
    const val = rule.value;
    const source = {
      country: lead.country,
      product_category: lead.product_category || lead.category || '',
      order_count: Number(lead.order_count || 0),
      total_spent: Number(lead.total_spent || 0),
      email_opens: Number(lead.email_opens || 0),
      email_clicks: Number(lead.email_clicks || 0),
      account_age_days: lead.created_at ? Math.floor((Date.now() - new Date(lead.created_at).getTime()) / 86400000) : 0,
      last_order_date: lead.last_order_date || '',
    };
    const left = source[field];
    if (op === 'in') {
      const arr = Array.isArray(val) ? val : String(val).split(',').map(s => s.trim());
      return arr.map(String).map(s => s.toLowerCase()).includes(String(left || '').toLowerCase());
    }
    if (op === 'eq') return String(left || '').toLowerCase() === String(val || '').toLowerCase();
    if (op === 'neq') return String(left || '').toLowerCase() !== String(val || '').toLowerCase();
    if (op === 'gte' || op === 'after') return left >= val;
    if (op === 'lte' || op === 'before') return left <= val;
    if (op === 'gt') return left > val;
    if (op === 'lt') return left < val;
    return false;
  }

  app.get('/api/cio/status', requireAuth, (req, res) => {
    const cfg = loadCioConfig();
    const meta = readJson(metaFile, { last_sync_at: null });
    res.json({
      ok: true,
      configured: cfg.configured,
      last_sync_at: meta.last_sync_at || null,
    });
  });

  app.get('/api/cio/campaigns', requireAuth, async (req, res) => {
    const cfg = loadCioConfig();
    if (!cfg.configured) return notConfigured(res);
    try {
      const r = await cioRequest(cfg, 'GET', '/v1/campaigns');
      if (r.status >= 400) return res.status(r.status).json({ ok: false, error: 'cio_upstream', status: r.status });
      writeJson(metaFile, { last_sync_at: nowIso() });
      res.json({ ok: true, campaigns: r.json.campaigns || r.json.data || r.json });
    } catch (e) {
      res.status(502).json({ ok: false, error: 'cio_upstream', detail: e.message });
    }
  });

  app.get('/api/cio/campaigns/:id', requireAuth, async (req, res) => {
    const cfg = loadCioConfig();
    if (!cfg.configured) return notConfigured(res);
    try {
      const r = await cioRequest(cfg, 'GET', '/v1/campaigns/' + encodeURIComponent(req.params.id));
      if (r.status >= 400) return res.status(r.status).json({ ok: false, error: 'cio_upstream', status: r.status });
      res.json({ ok: true, campaign: r.json.campaign || r.json });
    } catch (e) {
      res.status(502).json({ ok: false, error: 'cio_upstream', detail: e.message });
    }
  });

  app.post('/api/cio/campaigns/:id/triggers', requireAdmin, async (req, res) => {
    const body = req.body || {};
    const lintText = [body.subject, body.body, body.text, body.message].filter(Boolean).join('\n');
    if (lintText) {
      const lint = ruoLint(lintText);
      if (!lint.ok) {
        return res.status(400).json({ ok: false, error: 'ruo_blocked', blocked_terms: lint.blocked_terms });
      }
    }

    const { allowed, excluded } = resolveTriggerAudience(body);
    if (excluded.length && !allowed.length) {
      return res.status(400).json({
        ok: false,
        error: 'all_recipients_unsubscribed',
        excluded: excluded.length,
      });
    }

    const cfg = loadCioConfig();
    if (!cfg.configured) {
      return res.json({
        ok: false,
        error: 'cio_not_configured',
        would_send: allowed.length,
        excluded_unsubscribed: excluded.length,
      });
    }

    const emails = allowed.map(l => l.email).filter(e => e && e.includes('@'));
    try {
      const payload = {
        emails,
        email_ignore_missing: true,
        email_add_duplicates: false,
        data: body.data || {},
      };
      const r = await cioRequest(cfg, 'POST', '/v1/campaigns/' + encodeURIComponent(req.params.id) + '/triggers', payload);
      if (r.status >= 400) {
        return res.status(r.status).json({
          ok: false,
          error: 'cio_upstream',
          status: r.status,
          excluded_unsubscribed: excluded.length,
        });
      }
      res.json({
        ok: true,
        triggered: emails.length,
        excluded_unsubscribed: excluded.length,
        result: r.json,
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: 'cio_upstream', detail: e.message });
    }
  });

  app.get('/api/cio/messages', requireAuth, async (req, res) => {
    const cfg = loadCioConfig();
    if (!cfg.configured) return notConfigured(res);
    try {
      const since = req.query.since ? String(req.query.since) : '';
      let apiPath = '/v1/activities';
      const qs = [];
      if (since) qs.push('start=' + encodeURIComponent(since));
      qs.push('limit=100');
      if (qs.length) apiPath += '?' + qs.join('&');
      const r = await cioRequest(cfg, 'GET', apiPath);
      if (r.status >= 400) return res.status(r.status).json({ ok: false, error: 'cio_upstream', status: r.status });
      writeJson(metaFile, { last_sync_at: nowIso() });
      res.json({ ok: true, messages: r.json.activities || r.json.messages || r.json.data || r.json });
    } catch (e) {
      res.status(502).json({ ok: false, error: 'cio_upstream', detail: e.message });
    }
  });

  app.get('/api/cio/deliverability', requireAuth, async (req, res) => {
    const cfg = loadCioConfig();
    if (!cfg.configured) {
      return res.json({
        ok: true,
        configured: false,
        metrics: { sends: null, delivery: null, open: null, click: null, unsub: null, complaint: null, bounce: null },
        note: 'Customer.io not connected',
      });
    }
    try {
      const r = await cioRequest(cfg, 'GET', '/v1/activities?limit=100');
      const items = (r.json && (r.json.activities || r.json.data)) || [];
      const counts = { sends: 0, delivery: 0, open: 0, click: 0, unsub: 0, complaint: 0, bounce: 0 };
      for (const a of items) {
        const t = String(a.type || a.metric || '').toLowerCase();
        if (/sent|send/.test(t)) counts.sends++;
        if (/deliver/.test(t)) counts.delivery++;
        if (/open/.test(t)) counts.open++;
        if (/click/.test(t)) counts.click++;
        if (/unsub/.test(t)) counts.unsub++;
        if (/complaint|spam/.test(t)) counts.complaint++;
        if (/bounce/.test(t)) counts.bounce++;
      }
      res.json({ ok: true, configured: true, metrics: counts });
    } catch (e) {
      res.json({
        ok: true,
        configured: true,
        metrics: { sends: null, delivery: null, open: null, click: null, unsub: null, complaint: null, bounce: null },
        note: 'metrics_unavailable',
      });
    }
  });

  app.post('/api/cio/lint', requireAuth, (req, res) => {
    const text = (req.body && (req.body.text || req.body.body || req.body.message)) || '';
    const result = ruoLint(text);
    res.json(result);
  });

  app.get('/api/segments', requireAuth, (req, res) => {
    res.json({ ok: true, fields: [...SEGMENT_FIELDS], segments: readJson(segFile, []) });
  });

  app.post('/api/segments', requireAuth, (req, res) => {
    const cleaned = sanitizeSegment(req.body || {});
    if (!cleaned.name) return res.status(400).json({ ok: false, error: 'name_required' });
    const seg = {
      id: newId(),
      name: cleaned.name,
      rules: cleaned.rules,
      created_at: nowIso(),
      updated_at: nowIso(),
    };
    const all = readJson(segFile, []);
    all.push(seg);
    writeJson(segFile, all);
    res.json({ ok: true, segment: seg });
  });

  app.put('/api/segments/:id', requireAuth, (req, res) => {
    const all = readJson(segFile, []);
    const idx = all.findIndex(s => s.id === req.params.id);
    if (idx < 0) return res.status(404).json({ ok: false, error: 'not_found' });
    const cleaned = sanitizeSegment(req.body || {}, all[idx]);
    if (!cleaned.name) return res.status(400).json({ ok: false, error: 'name_required' });
    const next = { ...all[idx], name: cleaned.name, rules: cleaned.rules, updated_at: nowIso() };
    all[idx] = next;
    writeJson(segFile, all);
    res.json({ ok: true, segment: next });
  });

  return { ruoLint, loadCioConfig, SEGMENT_FIELDS };
};

module.exports.ruoLint = ruoLint;
module.exports.loadCioConfig = loadCioConfig;
module.exports.SEGMENT_FIELDS = SEGMENT_FIELDS;
