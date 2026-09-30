'use strict';
// Shared by the tests: the REAL lockedUpdate / writeJSONAtomic of the snapshot's server_v14.cjs, cut out by name and run over a temp
// data dir, so the module is tested against the write path it will meet on the server and not against a copy of it.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');

// Two layouts. biofirst-hosting: services/ad-spend/{marketing-spend.cjs,crm/,test/} next to server-snapshot/. crm-app (the PR of
// deploy/INSTALL.md): crm-api/{marketing-spend.cjs,tests/ad-spend/} and crm-web/ (the pages); there the server file and the CRM
// pages are the repo's own. SERVER_FILE / CRM_DIR / PRODUCTS_API_FILE override both (fresh live copies before a deploy).
const INFRA = fs.existsSync(path.join(__dirname, '..', 'marketing-spend.cjs'));
const SNAP = process.env.SNAPSHOT_DIR || path.join(__dirname, '..', '..', '..', 'server-snapshot');
const SPEND = INFRA ? path.join(__dirname, '..', 'marketing-spend.cjs') : path.join(__dirname, '..', '..', 'marketing-spend.cjs');
const ADMODEL = INFRA ? path.join(__dirname, '..', 'crm', 'adspend-model.js') : path.join(__dirname, '..', '..', '..', 'crm-web', 'adspend-model.js');
const ADSECTION = ADMODEL.replace('adspend-model.js', 'adspend-section.js');
// Default: the snapshot of 2026-09-30 (before this deploy).
const SERVER_FILE = process.env.SERVER_FILE || (INFRA ? path.join(__dirname, 'fixtures', 'server_v14.orig.cjs') : path.join(__dirname, '..', '..', 'server_v14.cjs'));
const CRM_DIR = process.env.CRM_DIR || (INFRA ? path.join(SNAP, 'var/www/mastersol/html/CRM') : path.join(__dirname, '..', '..', '..', 'crm-web'));
const PRODUCTS_API = process.env.PRODUCTS_API_FILE || path.join(SNAP, 'var/www/mastersol/html/MSOLPEPTIDES/products-api.cjs');

// The text of `function name(...) { ... }` (or `async function`) by brace counting from its first `{`.
function extractFunction(src, header) {
  const at = src.indexOf(header);
  if (at === -1) throw new Error('not found in server file: ' + header);
  let i = src.indexOf('{', src.indexOf(')', at));
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  throw new Error('unbalanced: ' + header);
}

function makeServerWriters(dataDir) {
  const src = fs.readFileSync(SERVER_FILE, 'utf8');
  const audit = [];
  const parts = [
    extractFunction(src, 'function writeJSONAtomic(filename, data)'),
    extractFunction(src, 'async function lockedUpdate(filename, fn, meta)')
  ].join('\n');
  const factory = new Function('fs', 'path', 'crypto', 'DATA_DIR', 'dataVersions', 'dataLocks', 'writeQueues', 'readJSON', 'writeAuditLog',
    parts + '\nreturn { lockedUpdate, writeJSONAtomic };');
  const readJSON = (filename, fallback) => {
    try { const p = JSON.parse(fs.readFileSync(path.join(dataDir, filename), 'utf8')); return Array.isArray(p) ? p : fallback; } catch (e) { return fallback; }
  };
  const w = factory(fs, path, crypto, dataDir, {}, new Map(), {}, readJSON, (table, action, user, details) => audit.push({ table, action, user, details }));
  return { lockedUpdate: w.lockedUpdate, audit };
}

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

// A server with the handler mounted at /api/marketing/spend behind a fake requireAuth (x-user header = the session's e-mail;
// none = 401), like server_v14 mounts it. express.json is imitated: a parsed req.body, as the real server has.
function listen(handler, opts) {
  const server = http.createServer((req, res) => {
    const prefix = '/api/marketing/spend';
    if (!req.url.startsWith(prefix)) { res.statusCode = 404; return res.end('no'); }
    const user = req.headers['x-user'];
    if (!user) { res.statusCode = 401; res.setHeader('Content-Type', 'application/json'); return res.end('{"error":"Authentication required"}'); }
    req.userSession = { email: user };
    req.url = req.url.slice(prefix.length) || '/';
    const notMine = () => { res.statusCode = 404; res.setHeader('Content-Type', 'application/json'); res.end('{"error":"not found"}'); };
    if (opts && opts.rawBody) return handler(req, res, notMine);   // the handler reads the stream itself (readRawBody)
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw && !(opts && opts.noParse)) { try { req.body = JSON.parse(raw); } catch (e) { res.statusCode = 400; return res.end('{"error":"bad json"}'); } }
      handler(req, res, notMine);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function call(server, method, p, body, user) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = { 'content-type': 'application/json' };
    if (user !== null) headers['x-user'] = user || 'ann@example.com';
    if (data) headers['content-length'] = data.length;
    const req = http.request({ host: '127.0.0.1', port: server.address().port, method, path: '/api/marketing/spend' + p, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = JSON.parse(t); } catch (e) {} resolve({ status: res.statusCode, body: j, text: t }); });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}


// crm-app: the root package.json says "type": "module", so require() of a classic crm-web/*.js script loads it as an ES module
// and gets nothing; a .cjs copy in a temp dir loads it the way the page code expects (same as products-api/tests/load-crm-model.cjs).
function loadJs(file) {
  if (!/\.js$/.test(file)) return require(file);
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'adspend-js-')), path.basename(file, '.js') + '.cjs');
  fs.copyFileSync(file, tmp);
  return require(tmp);
}

module.exports = { loadJs, SNAP, SPEND, ADMODEL, ADSECTION, SERVER_FILE, CRM_DIR, PRODUCTS_API, extractFunction, makeServerWriters, tmpDir, listen, call };
