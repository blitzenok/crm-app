// products-api.cjs — product data + image upload API
// Port 4000 — nginx proxies /msolpeptides-api/ here

const http = require('http');
const https = require('https');   // shop stage 2: order notifications go out through the Customer.io API
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'products-data.json');
const IMAGES_DIR = path.join(__dirname, 'product-images');
const ACTIVITY_LOG_FILE = path.join(__dirname, 'activity_log.json');
const PORT = 4000;
// Phase 0 (2026-09-04): the admin secret lives in /opt/crm-api/.env (ADMIN_SECRET), shared with blitz-api.
// Missing or empty value = fail closed: X-Admin-Secret auth is disabled and only Bearer sessions work.
const ENV_FILE = '/opt/crm-api/.env';
function readEnvFile(file) {
  const out = {};
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { return out; }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let val = m[2];
    if (val.length >= 2 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) val = val.slice(1, -1);
    out[m[1]] = val;
  }
  return out;
}
const ADMIN_SECRET = String(readEnvFile(ENV_FILE).ADMIN_SECRET || process.env.ADMIN_SECRET || '');
if (!ADMIN_SECRET) console.error('[auth] ADMIN_SECRET missing in ' + ENV_FILE + ' — X-Admin-Secret auth disabled (fail closed)');
// Shop stage 0 (2026-09-06): order notifications go to the addresses in .env (ORDER_NOTIFY_TO, comma-separated) instead of the
// hard-coded admin@mastersol-ltd.com,info@biofirst.co — the second domain has been another company's server since August.
const ORDER_NOTIFY_TO = String(readEnvFile(ENV_FILE).ORDER_NOTIFY_TO || process.env.ORDER_NOTIFY_TO || 'admin@biolabsresearch.co').replace(/[\r\n\t]+/g, ' ').trim();

// Shop stage 2 (2026-09-06): the notification itself. There is no MTA on this droplet — the sendmail call that used to
// stand in notify-order delivered nothing to anyone — so both letters go out through the Customer.io Transactional API,
// the account the shop already uses for marketing. Settings come from the same .env as ADMIN_SECRET and are read once, at
// startup: an empty CIO_APP_API_KEY means nothing is sent at all and the order path behaves exactly as it did before
// (put the key in /opt/crm-api/.env and restart products-api). CIO_API_BASE overrides the region outright and is the seam
// the local test stand points at its own stub.
const CIO_ENV = readEnvFile(ENV_FILE);
const CIO_API_KEY = String(CIO_ENV.CIO_APP_API_KEY || process.env.CIO_APP_API_KEY || '').trim();
const CIO_ORDER_MANAGER_MSG_ID = String(CIO_ENV.CIO_ORDER_MANAGER_MSG_ID || process.env.CIO_ORDER_MANAGER_MSG_ID || '').trim();
const CIO_ORDER_CUSTOMER_MSG_ID = String(CIO_ENV.CIO_ORDER_CUSTOMER_MSG_ID || process.env.CIO_ORDER_CUSTOMER_MSG_ID || '').trim();
const CIO_REGION = String(CIO_ENV.CIO_REGION || process.env.CIO_REGION || 'us').trim().toLowerCase();
const CIO_SEND_TIMEOUT_MS = 5000;
// Customer.io takes the recipients of one letter as a single string, and a list kept by hand in .env comes with spaces
// and the odd trailing comma: "a@x.com, b@y.com" can be refused whole, and the log would say no more than HTTP 400.
const CIO_MANAGER_TO = ORDER_NOTIFY_TO.split(',').map(a => a.trim()).filter(Boolean).join(',');
let CIO_URL = null;
try {
  const base = String(CIO_ENV.CIO_API_BASE || process.env.CIO_API_BASE || (CIO_REGION === 'eu' ? 'https://api-eu.customer.io' : 'https://api.customer.io')).trim().replace(/\/+$/, '');
  const u = new URL(base + '/v1/send/email');
  // Plain http only to this machine — that is the seam the local test stand needs and the only place it is harmless.
  // .env is edited by other root agents as well, and one mistyped http:// host would put the key on the wire in clear
  // text in an Authorization header.
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) CIO_URL = u;
} catch (e) { /* reported right below */ }
const CIO_READY = !!(CIO_API_KEY && CIO_URL);
if (!CIO_API_KEY) console.error('[cio] CIO_APP_API_KEY missing in ' + ENV_FILE + ' — order emails are not sent (orders are saved as before)');
else if (!CIO_URL) console.error('[cio] CIO_API_BASE/CIO_REGION must be an https:// address (http:// only for 127.0.0.1) — order emails are not sent');
else {
  console.log('[cio] order emails go through ' + CIO_URL.host);
  if (!CIO_ORDER_MANAGER_MSG_ID || !CIO_MANAGER_TO) console.error('[cio] CIO_ORDER_MANAGER_MSG_ID or ORDER_NOTIFY_TO missing — the manager gets no notification');
  if (!CIO_ORDER_CUSTOMER_MSG_ID) console.error('[cio] CIO_ORDER_CUSTOMER_MSG_ID missing — the customer gets no confirmation');
}

// Shop stage 3 (2026-09-07): behaviour events. The same Customer.io account, a different door — letters go through the
// App API above (Bearer), people and events go through the Track API, which has credentials of its own: the site id and
// the tracking key, sent as HTTP basic auth (site_id:key). Checked against docs.customer.io/integrations/api/track/:
// identify is PUT /api/v1/customers/{id}, an event is POST /api/v1/customers/{id}/events with {name, data}.
// Empty keys mean not one outgoing request and every route behaves exactly as it did before; CIO_TRACK_API_BASE is the
// seam the local test stand points at its own stub.
const CIO_SITE_ID = String(CIO_ENV.CIO_SITE_ID || process.env.CIO_SITE_ID || '').trim();
const CIO_TRACKING_API_KEY = String(CIO_ENV.CIO_TRACKING_API_KEY || process.env.CIO_TRACKING_API_KEY || '').trim();
// Signs the token the storefront is handed by /subscribe; without it /track cannot tell whose cart it is being told about.
const CIO_TRACK_TOKEN_SECRET = String(CIO_ENV.CIO_TRACK_TOKEN_SECRET || process.env.CIO_TRACK_TOKEN_SECRET || '').trim();
let CIO_TRACK_URL = null;
try {
  const base = String(CIO_ENV.CIO_TRACK_API_BASE || process.env.CIO_TRACK_API_BASE || (CIO_REGION === 'eu' ? 'https://track-eu.customer.io' : 'https://track.customer.io')).trim().replace(/\/+$/, '');
  const u = new URL(base);
  // Plain http only to this machine — the same rule, and for the same reason, as CIO_API_BASE above.
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1' || u.hostname === '[::1]';
  if (u.protocol === 'https:' || (u.protocol === 'http:' && loopback)) CIO_TRACK_URL = u;
} catch (e) { /* reported right below */ }
const CIO_TRACK_READY = !!(CIO_SITE_ID && CIO_TRACKING_API_KEY && CIO_TRACK_URL);
if (!CIO_SITE_ID || !CIO_TRACKING_API_KEY) console.error('[cio-track] CIO_SITE_ID / CIO_TRACKING_API_KEY missing in ' + ENV_FILE + ' — no events and no profiles are sent (orders and signups are saved as before)');
else if (!CIO_TRACK_URL) console.error('[cio-track] CIO_TRACK_API_BASE/CIO_REGION must be an https:// address (http:// only for 127.0.0.1) — no events are sent');
else console.log('[cio-track] events go to ' + CIO_TRACK_URL.host);
if (!CIO_TRACK_TOKEN_SECRET) console.error('[cio-track] CIO_TRACK_TOKEN_SECRET missing in ' + ENV_FILE + ' — POST /track answers 503 and the storefront gets no token');

if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

// Phase 0 (2026-09-04): no DEFAULT_PRODUCTS fallback any more. If products-data.json is unreadable we log it,
// GET /products answers 503 and writeProducts refuses to run, so a broken file is never replaced by defaults.
let catalogUnreadable = false;
function readProducts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('products-data.json is not an array');
    catalogUnreadable = false;
    return parsed;
  } catch (e) {
    catalogUnreadable = true;
    console.error('[products] catalog unreadable, file left untouched:', e.message);
    return [];
  }
}
// Phase 1 (2026-09-04): every JSON data file is written atomically — temp file next to it, fsync, rename over the
// original — so an interrupted write leaves the old file intact and no temp file behind. Symlinks are resolved first
// (products-data.json is linked from the shop docroot) so the link itself is never replaced by a plain file.
function writeJsonAtomic(file, data) {
  let target = file;
  try { target = fs.realpathSync(file); } catch (e) { /* file does not exist yet: create it at the given path */ }
  const tmp = target + '.tmp.' + process.pid + '.' + crypto.randomBytes(4).toString('hex');
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', 0o644);
    fs.writeFileSync(fd, Buffer.from(JSON.stringify(data, null, 2))); // fd + Buffer: loops until every byte is written
    fs.fsyncSync(fd);
    // rename swaps the inode, so carry the previous owner and mode over (a new file keeps 0644 / the process owner)
    try { const st = fs.statSync(target); fs.fchmodSync(fd, st.mode & 0o777); fs.fchownSync(fd, st.uid, st.gid); }
    catch (e) { if (e.code !== 'ENOENT') console.error('[data] could not keep owner/mode of ' + target + ':', e.message); }
    fs.closeSync(fd); fd = undefined;
    fs.renameSync(tmp, target);
  } catch (e) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (e2) { /* already closed */ } }
    try { fs.unlinkSync(tmp); } catch (e2) { /* nothing to clean up */ }
    throw e;
  }
}
// A missing data file is the fallback (first write creates it); a broken one throws, so it is answered with 500 and
// never silently replaced by a fresh list on the next write (the catalog has its own guard, see readProducts).
function readJsonOrFallback(file, fallback) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
  return JSON.parse(raw);
}
function writeProducts(data) {
  if (catalogUnreadable) throw new Error('catalog unreadable - refusing to overwrite products-data.json');
  if (!Array.isArray(data)) throw new Error('writeProducts: expected an array');
  writeJsonAtomic(DATA_FILE, data);
}
// Phase 8 (2026-09-06): documents first, catalog second, rollback on failure - same order as stock-writeoffs (phase 7).
// Each step is { name, save, after, before }: they are written in that order and, if one of them throws, every step
// that already ran is written back to its "before" snapshot. Returns the error that stopped the sequence, or null.
// The catalog is always the last step, so a failed catalog write only rolls documents back; the step that threw needs
// no rollback of its own, because writeJsonAtomic leaves its target untouched when it fails.
function commitOrRollback(steps) {
  const done = [];
  try {
    for (const step of steps) { step.save(step.after); done.push(step); }
    return null;
  } catch (e) {
    for (const step of done.reverse()) {
      try { step.save(step.before); }
      catch (e2) { console.error('[' + step.name + '] rollback failed, file left as written:', e2.message); }
    }
    return e;
  }
}

// Phase 0 (2026-09-04): helpers for the auth gate, body limits and input checks (see bottom of file).
function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'png';
  if (buf.toString('ascii', 0, 4) === 'GIF8') return 'gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}
// Minimal shape check for the public notify-order body (checkout inquiry or insider signup). Returns an error string or null.
function validateNotifyOrder(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'Body must be a JSON object';
  const od = data.orderData;
  if (!od || typeof od !== 'object' || Array.isArray(od)) return 'orderData must be an object';
  for (const k of ['subject', 'body', 'paymentMethod']) {
    if (data[k] !== undefined && data[k] !== null && typeof data[k] !== 'string') return k + ' must be a string';
  }
  if (od.ref !== undefined && (typeof od.ref !== 'string' || od.ref.length > 64)) return 'orderData.ref must be a string (max 64)';
  if (od.tc_accepted !== undefined && typeof od.tc_accepted !== 'boolean') return 'orderData.tc_accepted must be a boolean';
  if (od.tc_accepted_at !== undefined && typeof od.tc_accepted_at !== 'string') return 'orderData.tc_accepted_at must be a string';
  if (od.items !== undefined && (!Array.isArray(od.items) || od.items.length > 50)) return 'orderData.items must be an array (max 50)';
  // Shop stage 0 (2026-09-06): each item is checked too — [null] and negative quantities used to be stored as sent.
  if (Array.isArray(od.items)) {
    for (let i = 0; i < od.items.length; i++) {
      const it = od.items[i];
      if (!it || typeof it !== 'object' || Array.isArray(it)) return 'orderData.items[' + i + '] must be an object';
      if (it.qty !== undefined && it.qty !== null && it.qty !== '' && !(Number.isInteger(Number(it.qty)) && Number(it.qty) >= 1 && Number(it.qty) <= 999)) return 'orderData.items[' + i + '].qty must be a positive integer (max 999)';
      if (it.price !== undefined && it.price !== null && it.price !== '' && !(Number.isFinite(Number(it.price)) && Number(it.price) >= 0)) return 'orderData.items[' + i + '].price must be a non-negative number';
      if (it.slug !== undefined && it.slug !== null && it.slug !== '' && !/^[a-z0-9-]{1,64}$/i.test(String(it.slug))) return 'orderData.items[' + i + '].slug may contain only letters, digits and -';
    }
  }
  // Shop stage 2 (2026-09-06): money is checked for sign as well, and orderData.shipping.cost is checked at all —
  // priceCheck reads shipping from it when shippingCost is absent, so a negative one used to walk into total_due_server
  // and out onto the invoice the manager sends.
  const shipCost = (od.shipping && typeof od.shipping === 'object') ? od.shipping.cost : undefined;
  for (const [k, v] of [['subtotal', od.subtotal], ['total', od.total], ['shippingCost', od.shippingCost], ['shipping.cost', shipCost]]) {
    if (v === undefined || v === null || v === '') continue;
    if (!Number.isFinite(Number(v))) return 'orderData.' + k + ' must be numeric';
    if (Number(v) < 0) return 'orderData.' + k + ' must be a non-negative number';
  }
  // Shop stage B (2026-09-21): missing/null attribution is fine; anything else must be a plain object.
  if (od.attribution != null && (typeof od.attribution !== 'object' || Array.isArray(od.attribution))) return 'orderData.attribution must be an object';
  return null;
}
// Shop stage 0 (2026-09-06): what notify-order stores. Only these fields, trimmed and capped; status/savedAt are never taken
// from the client (the customer used to be able to submit an order already marked paid). Everything the CRM pages read
// (customer, shipping, items with mg, sums, coupon, notes, paymentMethod, timestamp) is kept.
// Control characters are dropped by code point (line breaks and tabs stay in free text such as notes).
function stripControls(text, keepLineBreaks) {
  let out = '';
  for (const ch of String(text)) {
    const c = ch.charCodeAt(0);
    if (c >= 32 && c !== 127) out += ch;
    else if (keepLineBreaks && (c === 9 || c === 10 || c === 13)) out += ch;
  }
  return out;
}
function cleanStr(v, max) {
  return stripControls(v === undefined || v === null ? '' : v, true).trim().slice(0, max || 200);
}
function cleanNum(v) { return (v === undefined || v === null || v === '') ? undefined : String(v).trim().slice(0, 32); }
function sanitizeOrder(od, paymentMethod) {
  const src = (od && typeof od === 'object') ? od : {};
  const cust = (src.customer && typeof src.customer === 'object') ? src.customer : {};
  const ship = (src.shipping && typeof src.shipping === 'object') ? src.shipping : {};
  const out = {};
  if (src.ref !== undefined && src.ref !== null && String(src.ref).trim() !== '') out.ref = cleanStr(src.ref, 64);
  if (src.type !== undefined && src.type !== null) out.type = cleanStr(src.type, 40);
  out.customer = { firstName: cleanStr(cust.firstName, 80), lastName: cleanStr(cust.lastName, 80), email: cleanStr(cust.email, 200), phone: cleanStr(cust.phone, 40), company: cleanStr(cust.company, 120) };
  out.shipping = { address1: cleanStr(ship.address1), address2: cleanStr(ship.address2), city: cleanStr(ship.city, 100), state: cleanStr(ship.state, 100), zip: cleanStr(ship.zip, 20), country: cleanStr(ship.country, 60), method: cleanStr(ship.method, 40), cost: cleanNum(ship.cost), label: cleanStr(ship.label, 80) };
  out.items = (Array.isArray(src.items) ? src.items : []).map(i => ({
    name: cleanStr(i.name, 120), slug: cleanStr(i.slug, 64),
    qty: (i.qty === undefined || i.qty === null || i.qty === '') ? 1 : Number(i.qty),
    price: (i.price === undefined || i.price === null || i.price === '') ? 0 : Number(i.price),
    mg: cleanStr(i.mg, 20)
  }));
  for (const k of ['subtotal', 'shippingCost', 'total']) { const v = cleanNum(src[k]); if (v !== undefined) out[k] = v; }
  out.paymentMethod = cleanStr(paymentMethod !== undefined && paymentMethod !== null ? paymentMethod : src.paymentMethod, 40);
  out.notes = cleanStr(src.notes, 2000);
  out.coupon = cleanStr(src.coupon, 40);
  if (src.timestamp !== undefined && src.timestamp !== null) out.timestamp = cleanStr(src.timestamp, 40);
  if (typeof src.tc_accepted === 'boolean') out.tc_accepted = src.tc_accepted;
  if (typeof src.tc_accepted_at === 'string') out.tc_accepted_at = cleanStr(src.tc_accepted_at, 40);
  const attr = attributionOf(src.attribution);
  if (attr) out.attribution = attr;
  out.savedAt = new Date().toISOString();
  return out;
}

// Shop stage B (2026-09-21): fold the shopfront trail to {source, medium, campaign, referrer, landing}.
// The browser sends raw utm_*/click-id name/referrer host; we slug the source here so CRM never has to.
// No field in the body → no field on the order (old pages stay as they were).
const ATTR_SOURCE_ALIAS = Object.assign(Object.create(null), {
  ig: 'instagram', insta: 'instagram', instagram: 'instagram',
  fb: 'facebook', facebook: 'facebook',
  meta: 'meta',
  google: 'google', adwords: 'google', googleads: 'google', 'google-ads': 'google', gads: 'google',
  tiktok: 'tiktok', tt: 'tiktok',
  newsletter: 'newsletter', email: 'newsletter', mail: 'newsletter',
  'customer.io': 'newsletter', customerio: 'newsletter', cio: 'newsletter',
  direct: 'direct', '(direct)': 'direct', none: 'direct'
});
const ATTR_CLICK = Object.assign(Object.create(null), {
  gclid: 'google', fbclid: 'meta', ttclid: 'tiktok', msclkid: 'bing'
});
const ATTR_HOST = Object.assign(Object.create(null), {
  'mail.google.com': 'email', 'outlook.live.com': 'email', 'outlook.office.com': 'email',
  'mail.yahoo.com': 'email', 'mail.proton.me': 'email', 'protonmail.com': 'email',
  'instagram.com': 'instagram',
  'facebook.com': 'facebook', 'fb.com': 'facebook', 'messenger.com': 'facebook',
  'tiktok.com': 'tiktok',
  't.co': 'x', 'twitter.com': 'x', 'x.com': 'x',
  'youtube.com': 'youtube', 'youtu.be': 'youtube',
  'bing.com': 'bing',
  'duckduckgo.com': 'duckduckgo',
  'yahoo.com': 'yahoo',
  'reddit.com': 'reddit',
  'linkedin.com': 'linkedin', 'lnkd.in': 'linkedin'
});
const ATTR_HOST_PREFIX = ['mobile.', 'www.', 'lm.', 'm.', 'l.'];
const ATTR_PSL = Object.assign(Object.create(null), { co: 1, com: 1, net: 1, org: 1, ac: 1, gov: 1 });
const ATTR_OWN_HOST = /(^|\.)(biolabsresearch\.co|blrcommerce\.io|mastersol-ltd\.com)$/;   // the browser drops these too; repeated here on purpose
const ATTR_GOOGLE = /(^|\.)google\.[a-z]{2,3}(\.[a-z]{2,3})?$/;                            // google.com, google.co.uk, maps.google.de — not google.evil.com
const ATTR_LANDING = /^\/[A-Za-z0-9\-._~\/%]*$/;

// Only strings are read from the trail: String() on a crafted object ({toString: null}) throws, and a 500 here would cost a customer the order.
function attrStr(v) { return typeof v === 'string' ? v : ''; }
function attrSlug(v) {
  return attrStr(v).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '');
}

function attrHostStrip(host) {
  let h = host;
  let again = true;
  while (again) {
    again = false;
    for (const p of ATTR_HOST_PREFIX) {
      if (h.length > p.length && h.slice(0, p.length) === p) { h = h.slice(p.length); again = true; break; }
    }
  }
  return h;
}

function attrSecondLabel(host) {
  const parts = host.split('.');
  if (parts.length < 2) return '';
  const sld = parts[parts.length - 2];
  if (parts.length >= 3 && ATTR_PSL[sld]) return parts[parts.length - 3];
  return sld;
}

function attributionSource(raw) {
  const src = raw || {};
  const utm = attrStr(src.utm_source).toLowerCase().trim();
  if (utm) {
    if (Object.prototype.hasOwnProperty.call(ATTR_SOURCE_ALIAS, utm)) return ATTR_SOURCE_ALIAS[utm];
    const sl = attrSlug(utm);
    if (sl) return sl;
  }
  const click = attrStr(src.click).toLowerCase().trim();
  if (click && Object.prototype.hasOwnProperty.call(ATTR_CLICK, click)) return ATTR_CLICK[click];
  let host = attrHostStrip(attrStr(src.referrer).toLowerCase().trim());
  if (ATTR_OWN_HOST.test(host)) host = '';
  if (host) {
    if (ATTR_HOST[host]) return ATTR_HOST[host];
    if (ATTR_GOOGLE.test(host)) return 'google';
    if (host.slice(0, 13) === 'search.yahoo.') return 'yahoo';
    const dot = host.indexOf('.');
    if (dot > 0 && host.slice(0, dot) === 'pinterest') return 'pinterest';
    if (dot > 0) {
      const sl = attrSlug(attrSecondLabel(host));
      if (sl) return sl;
    }
  }
  return 'direct';
}

function attributionOf(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const landing = attrStr(raw.landing).slice(0, 200);
  return {
    source: attributionSource(raw),
    medium: attrSlug(raw.utm_medium),
    campaign: cleanStr(attrStr(raw.utm_campaign), 80),
    referrer: attrStr(raw.referrer).toLowerCase().replace(/[^a-z0-9.-]/g, '').slice(0, 120),   // a hostname, nothing else
    landing: ATTR_LANDING.test(landing) ? landing : ''                                           // a site path, nothing else
  };
}

// Sitewide qty-pack math (v2.94 / qty-upsell.js): unit rates for 1/2/3 bottles from list U
//   1: round(U)   2: round(U*89/99)   3: round(U*79/99)
// Cart lines store the unit rate (not line total); line total = unit * qty.
// strength_prices remain the source of truth; pack_tiers_* are derived.
const PACK_RATIO_2 = 89 / 99;
const PACK_RATIO_3 = 79 / 99;
function normMgKey(mg) {
  return String(mg == null ? '' : mg).replace(/\s+/g, '').toLowerCase();
}
function catalogUnitForStrength(product, mg) {
  if (!product) return NaN;
  const sp = product.strength_prices;
  if (mg && sp && typeof sp === 'object') {
    const key = normMgKey(mg);
    if (!Array.isArray(sp)) {
      for (const k of Object.keys(sp)) if (normMgKey(k) === key && Number.isFinite(Number(sp[k]))) return Number(sp[k]);
    } else {
      for (const e of sp) if (e && normMgKey(e.mg || e.strength || e.label) === key && Number.isFinite(Number(e.price))) return Number(e.price);
    }
  }
  const base = Number(product.price);
  return Number.isFinite(base) ? base : NaN;
}
function packUnitTiersFromU(u) {
  if (!Number.isFinite(u) || u <= 0) return null;
  return {
    1: Math.round(u),
    2: Math.round(u * PACK_RATIO_2),
    3: Math.round(u * PACK_RATIO_3)
  };
}
function packTiersByStrength(product) {
  const out = {};
  if (!product) return out;
  const strengths = Array.isArray(product.strengths) && product.strengths.length
    ? product.strengths
    : (product.strength_prices && typeof product.strength_prices === 'object' && !Array.isArray(product.strength_prices)
        ? Object.keys(product.strength_prices) : []);
  const seen = new Set();
  for (const s of strengths) {
    const key = normMgKey(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const u = catalogUnitForStrength(product, key);
    const tiers = packUnitTiersFromU(u);
    if (tiers) out[key] = tiers;
  }
  if (!Object.keys(out).length) {
    const u = Number(product.price);
    const tiers = packUnitTiersFromU(u);
    if (tiers) out['default'] = tiers;
  }
  return out;
}
function packUnitForQty(tiers, qty) {
  if (!tiers || typeof tiers !== 'object') return NaN;
  const q = Math.max(1, parseInt(qty, 10) || 1);
  if (q >= 3 && tiers[3] != null) return Number(tiers[3]);
  if (q >= 2 && tiers[2] != null) return Number(tiers[2]);
  if (tiers[1] != null) return Number(tiers[1]);
  if (tiers['1'] != null) return Number(tiers['1']);
  return NaN;
}
function enrichProductPackFields(product) {
  if (!product || typeof product !== 'object') return product;
  const by = packTiersByStrength(product);
  product.pack_tiers_by_strength = by;
  const keys = Object.keys(by);
  if (keys.length) product.pack_tiers = by[keys[0]];
  product.pack_formula = '1=U; 2=round(U*89/99); 3=round(U*79/99)';
  return product;
}

// The catalog unit price of one order line: strength list U, then qty-pack unit tier
// (v2.94 Semax ratios). NaN when the product is unknown.
function catalogPriceFor(product, mg, qty) {
  if (!product) return NaN;
  const u = catalogUnitForStrength(product, mg);
  if (!Number.isFinite(u)) return NaN;
  const tiers = packUnitTiersFromU(u);
  if (!tiers) return u;
  const q = (qty === undefined || qty === null) ? 1 : qty;
  const unit = packUnitForQty(tiers, q);
  return Number.isFinite(unit) ? unit : u;
}
// Server-side price check: the browser's subtotal/total stay as sent (that is what the customer saw), the catalog's
// figures are stored next to them with a flag, so the manager sees when a stale cart or an edited request disagrees.
function priceCheck(order) {
  const catalog = readProducts();
  if (catalogUnreadable || !catalog.length) return { price_check: 'skipped' };
  const bySlug = new Map(), byName = new Map();
  for (const p of catalog) {
    if (!p || typeof p !== 'object') continue;
    if (p.slug) bySlug.set(String(p.slug), p);
    if (p.name) byName.set(String(p.name).trim().toLowerCase(), p);
  }
  let sum = 0; const unknown = [];
  for (const it of order.items) {
    const p = (it.slug && bySlug.get(it.slug)) || byName.get(String(it.name || '').toLowerCase());
    const price = catalogPriceFor(p, it.mg, it.qty);
    if (!p || !Number.isFinite(price)) { unknown.push(it.slug || it.name || '?'); continue; }
    sum += price * it.qty;
  }
  const clientSubtotal = order.subtotal !== undefined ? Number(order.subtotal) : order.items.reduce((a, i) => a + i.price * i.qty, 0);
  // Shop stage 2 (2026-09-06): clamped at zero, so the figure the manager invoices does not depend on that one check in
  // validateNotifyOrder holding for every future caller of priceCheck.
  const shipping = Math.max(0, Number(order.shippingCost !== undefined ? order.shippingCost : (order.shipping && order.shipping.cost)) || 0);
  const out = { subtotal_server: sum.toFixed(2), total_server: (sum + shipping).toFixed(2), price_mismatch: unknown.length > 0 || !(Math.abs(sum - clientSubtotal) <= 0.005) };
  if (unknown.length) out.unknown_items = unknown;
  return out;
}
// Shop stage 2 (2026-09-06): the storefront promises 25% off with INSIDER25 and shows a 5/10/15% volume ladder, but
// nothing computed either one — orders.json carried the full amount and a bare coupon string, and the manager had to work
// the invoice out by hand. The percentage is taken from subtotal_server (the catalog's own figure, the one a stale or
// edited cart cannot set), shipping is never discounted, and coupon and ladder do not stack: the larger percentage wins,
// a tie goes to the coupon. A second code is one line in COUPONS.
const COUPONS = { INSIDER25: 25 };
const DISCOUNT_TIERS = [[500, 15], [250, 10], [100, 5]];   // [minimum subtotal in dollars, percent], largest first
function discountFields(order, check) {
  // Catalog unreadable (priceCheck skipped): there is no base to trust, so no discount fields are written at all — the
  // order itself still has to be saved, that is the stage 0 behaviour.
  if (!check || check.price_check === 'skipped') return {};
  // Cents, so 267.00 at 25% comes out 66.75 and Server total minus Discount is exactly Due after discount. total_server
  // is the source for shipping as well: whatever priceCheck counted as shipping stays counted the same way here.
  const subtotalCents = Math.round(Number(check.subtotal_server) * 100);
  const totalCents = Math.round(Number(check.total_server) * 100);
  if (!Number.isFinite(subtotalCents) || !Number.isFinite(totalCents)) return {};
  let pct = 0, source = 'none';
  if (subtotalCents > 0) {   // nothing to take a percentage from: every item unknown, or a free sample on its own
    const code = String(order.coupon || '').trim().toUpperCase();
    const couponPct = Object.prototype.hasOwnProperty.call(COUPONS, code) && Number.isFinite(COUPONS[code]) ? COUPONS[code] : 0;
    let tierPct = 0, tierMin = 0;
    for (const t of DISCOUNT_TIERS) if (subtotalCents >= t[0] * 100) { tierMin = t[0]; tierPct = t[1]; break; }
    if (couponPct > 0 && couponPct >= tierPct) { pct = couponPct; source = 'coupon:' + code; }
    else if (tierPct > 0) { pct = tierPct; source = 'tier:' + tierMin; }
  }
  const discountCents = Math.round(subtotalCents * pct / 100);   // a half cent rounds up, that is in the customer's favour: 100.10 at 5% gives 5.01
  return {
    discount_server: (discountCents / 100).toFixed(2),
    discount_pct_server: pct,
    discount_source: source,
    total_due_server: ((totalCents - discountCents) / 100).toFixed(2)
  };
}

// CRM order edit (2026-09-18): priceCheck() above is the storefront path and is not
// touched. The CRM wrapper does two sums (catalog vs quoted) and takes the discount
// only from lines that are not price_manual — a manager's quoted price is already
// the price, and stacking INSIDER25 on top of it would be a discount nobody asked for.
function crmActor(req) {
  const e = String((req && req.crmEmail) || '').trim();
  if (!e || e === 'x-admin-secret') return 'unknown';
  return e;
}
function cloneJson(v) {
  if (v === undefined) return undefined;
  try { return JSON.parse(JSON.stringify(v)); } catch (e) { return v; }
}
function captureOriginal(order) {
  // Snapshot of the record as it was before the first CRM write. Extra keys (legacy
  // `product`, a top-level email) stay so we can still say "what they ordered".
  // edits/payments/original/updated_at are not part of that answer.
  const skip = { edits: 1, payments: 1, original: 1, updated_at: 1 };
  const out = {};
  if (!order || typeof order !== 'object') return out;
  for (const k of Object.keys(order)) {
    if (skip[k]) continue;
    out[k] = cloneJson(order[k]);
  }
  const defaults = {
    items: [], customer: {}, shipping: {},
    subtotal: '', shippingCost: '', total: '',
    coupon: '', notes: '', paymentMethod: '', status: '', savedAt: '',
    subtotal_server: '', total_due_server: ''
  };
  for (const k of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) out[k] = defaults[k];
  }
  return out;
}
function moneyDue(order) {
  const v = (order && (order.total_due_server !== undefined ? order.total_due_server
    : (order.total_server !== undefined ? order.total_server : order.total)));
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(2) : String(v == null ? '0.00' : v);
}
function pushOrderEdit(order, req, fields, before) {
  if (!order || typeof order !== 'object') return;
  if (!Array.isArray(order.edits)) order.edits = [];
  order.edits.push({
    at: new Date().toISOString(),
    by: crmActor(req),
    fields: Array.isArray(fields) ? fields.slice() : [],
    toPayBefore: before && before.toPay !== undefined ? before.toPay : moneyDue(order),
    toPayAfter: moneyDue(order),
    itemsBefore: before && before.items !== undefined ? before.items : (Array.isArray(order.items) ? order.items.length : 0),
    itemsAfter: Array.isArray(order.items) ? order.items.length : 0
  });
  if (order.edits.length > 10) order.edits.splice(0, order.edits.length - 10);
}
function ensureOriginal(order) {
  if (order && !order.original) order.original = captureOriginal(order);
}
function liftLegacyCustomer(order) {
  // Wholesale / pre-checkout rows stored email/company at the top level. The card
  // reads customer.email; without this lift a first items-edit would leave the
  // buyer blank even though the address is on the record.
  if (!order || (order.customer && typeof order.customer === 'object' && !Array.isArray(order.customer))) return;
  order.customer = {
    firstName: cleanStr(order.firstName, 80),
    lastName: cleanStr(order.lastName, 80),
    email: cleanStr(order.email, 200),
    phone: cleanStr(order.phone, 40),
    company: cleanStr(order.company, 120)
  };
}
function orderCopies(orders, ref) {
  const list = Array.isArray(orders) ? orders : [];
  let n = 0;
  for (const o of list) if (o && typeof o.ref === 'string' && o.ref === ref) n++;
  return n;
}
function findOrder(orders, ref) {
  const list = Array.isArray(orders) ? orders : [];
  return list.find(o => o && typeof o.ref === 'string' && o.ref === ref);
}
function asIntQty(v) {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^(0|[1-9]\d*)$/.test(v.trim())) return parseInt(v.trim(), 10);
  return NaN;
}
function asMoney(v) {
  if (typeof v === 'boolean' || v === undefined || v === null || v === '') return NaN;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && Number.isFinite(Number(v))) return Number(v);
  return NaN;
}
function productHasStrengths(product) {
  const sp = product && product.strength_prices;
  if (!sp || typeof sp !== 'object') return false;
  if (Array.isArray(sp)) return sp.length > 0;
  return Object.keys(sp).length > 0;
}
function dosageListed(product, mg) {
  const sp = product && product.strength_prices;
  if (!sp || typeof sp !== 'object') return true;
  const key = normMgKey(mg);
  if (!key) return false;
  if (Array.isArray(sp)) {
    return sp.some(e => e && normMgKey(e.mg || e.strength || e.label) === key);
  }
  for (const k of Object.keys(sp)) if (normMgKey(k) === key) return true;
  return false;
}
function listedDosages(product) {
  const sp = product && product.strength_prices;
  if (!sp || typeof sp !== 'object') return [];
  if (Array.isArray(sp)) {
    const out = [];
    for (const e of sp) {
      const raw = e && (e.mg || e.strength || e.label);
      if (raw != null && String(raw).trim()) out.push(String(raw).trim());
    }
    return out;
  }
  return Object.keys(sp);
}
function catalogMgKey(product, mg) {
  if (mg === undefined || mg === null || mg === '') return '';
  if (!product || !productHasStrengths(product)) return cleanStr(mg, 20);
  const want = normMgKey(mg);
  if (!want) return cleanStr(mg, 20);
  const sp = product.strength_prices;
  if (Array.isArray(sp)) {
    for (const e of sp) {
      const raw = e && (e.mg || e.strength || e.label);
      if (raw != null && normMgKey(raw) === want) return String(raw);
    }
  } else {
    for (const k of Object.keys(sp)) if (normMgKey(k) === want) return k;
  }
  return cleanStr(mg, 20);
}
function catalogMaps(catalog) {
  if (catalog === undefined) catalog = readProducts();
  const bySlug = new Map(), byName = new Map();
  if (!catalogUnreadable && Array.isArray(catalog)) {
    for (const p of catalog) {
      if (!p || typeof p !== 'object') continue;
      if (p.slug) {
        bySlug.set(String(p.slug), p);
        bySlug.set(String(p.slug).toLowerCase(), p);
      }
      if (p.name) byName.set(String(p.name).trim().toLowerCase(), p);
    }
  }
  return { catalog: catalog || [], bySlug, byName };
}
function findCatalogProduct(it, maps) {
  const slug = String((it && it.slug) || '');
  if (slug && maps.bySlug.has(slug)) return maps.bySlug.get(slug);
  if (slug && maps.bySlug.has(slug.toLowerCase())) return maps.bySlug.get(slug.toLowerCase());
  const name = String((it && it.name) || '').trim().toLowerCase();
  if (name && maps.byName.has(name)) return maps.byName.get(name);
  return null;
}
function validateCrmItemShapes(items) {
  if (!Array.isArray(items)) return 'items must be an array';
  if (!items.length) return 'items must not be empty';
  if (items.length > 50) return 'items: at most 50 lines';
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const pfx = 'items[' + i + ']';
    if (!it || typeof it !== 'object' || Array.isArray(it)) return pfx + ' must be an object';
    const slug = (it.slug === undefined || it.slug === null) ? '' : String(it.slug).trim();
    const name = (it.name === undefined || it.name === null) ? '' : String(it.name).trim();
    if (!slug && !name) return pfx + ' needs a slug or a name';
    if (slug && !/^[a-z0-9-]{1,64}$/i.test(slug)) return pfx + '.slug may contain only letters, digits and -';
    if (name.length > 120) return pfx + '.name must be a string (max 120)';
    const qty = asIntQty(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 999) return pfx + '.qty must be a positive integer (max 999)';
    if (it.mg !== undefined && it.mg !== null && it.mg !== '') {
      if (typeof it.mg === 'object') return pfx + '.mg must be a string (max 20)';
      if (String(it.mg).length > 20) return pfx + '.mg must be a string (max 20)';
    }
    if (it.price_manual !== undefined && typeof it.price_manual !== 'boolean') return pfx + '.price_manual must be a boolean';
    if (it.price_manual === true) {
      const price = asMoney(it.price);
      if (!Number.isFinite(price) || price < 0 || price > 1e6) return pfx + '.price must be a number 0..1000000';
    }
  }
  return null;
}
function parseCrmItems(rawItems, maps) {
  const shape = validateCrmItemShapes(rawItems);
  if (shape) return { error: shape };
  maps = maps || catalogMaps();
  if (catalogUnreadable || !maps.catalog.length) return { skipped: true };
  const groups = new Map();
  for (let i = 0; i < rawItems.length; i++) {
    const it = rawItems[i];
    const pfx = 'items[' + i + ']';
    const manual = it.price_manual === true;
    const product = findCatalogProduct(it, maps);
    if (!manual && !product) {
      return { error: pfx + ' ' + (it.slug || it.name || 'item') + ' is not in the catalog' };
    }
    if (!manual && product && productHasStrengths(product) && !dosageListed(product, it.mg)) {
      const avail = listedDosages(product);
      const availTxt = avail.length ? ' (available: ' + avail.join(', ') + ')' : '';
      if (!normMgKey(it.mg)) {
        return { error: pfx + ' dosage is required for this product' + availTxt };
      }
      return { error: pfx + ' dosage not in the catalog' + availTxt };
    }
    const slug = cleanStr((product && product.slug) || it.slug || '', 64);
    const name = cleanStr(it.name || (product && product.name) || slug, 120);
    const mg = catalogMgKey(product, it.mg);
    const qty = asIntQty(it.qty);
    const price = manual ? asMoney(it.price) : NaN;
    const key = slug.toLowerCase() + '\0' + normMgKey(mg) + '\0' + name.trim().toLowerCase() + '\0' + (manual ? ('m\0' + Number(price).toFixed(2)) : 'c');
    const cur = groups.get(key);
    if (cur) { cur.qty += qty; continue; }
    const line = { name: name, slug: slug, qty: qty };
    if (mg) line.mg = mg;
    if (manual) { line.price_manual = true; line.price = price; }
    if (product) line._product = product;
    groups.set(key, line);
  }
  const items = [];
  for (const line of groups.values()) {
    const product = line._product;
    delete line._product;
    const catUnit = catalogPriceFor(product, line.mg, line.qty);
    const catOk = product && Number.isFinite(catUnit);
    if (line.price_manual) {
      line.catalog_price = catOk ? catUnit : null;
    } else {
      if (!catOk) return { error: (line.slug || line.name) + ' is not in the catalog' };
      line.price = catUnit;
    }
    items.push(line);
  }
  return { items: items };
}
const CRM_MONEY_KEYS = ['unknown_items', 'price_mismatch', 'price_check', 'subtotal_server', 'catalog_subtotal_server', 'total_server', 'discount_server', 'discount_pct_server', 'discount_source', 'total_due_server', 'manual_pricing'];
function priceCheckCrm(order, maps) {
  // Two passes over the same lines: catalog_subtotal_server ignores quoted prices,
  // subtotal_server uses them. priceCheck() for notify-order is left alone on purpose.
  maps = maps || catalogMaps();
  if (catalogUnreadable || !maps.catalog.length) return { price_check: 'skipped' };
  let catalogSum = 0, billed = 0, discountable = 0;
  let anyManual = false;
  const unknown = [];
  const items = (order && Array.isArray(order.items)) ? order.items : [];
  for (const it of items) {
    if (!it || typeof it !== 'object') { unknown.push('?'); continue; }
    const p = findCatalogProduct(it, maps);
    const catUnit = catalogPriceFor(p, it.mg, it.qty);
    const catOk = !!(p && Number.isFinite(catUnit));
    const catLine = catOk ? catUnit * Number(it.qty || 0) : 0;
    if (catOk) catalogSum += catLine;
    if (it.price_manual === true) {
      anyManual = true;
      const unit = asMoney(it.price);
      billed += (Number.isFinite(unit) ? unit : 0) * Number(it.qty || 0);
    } else if (catOk) {
      billed += catLine;
      discountable += catLine;
    } else {
      billed += (Number(it.price) || 0) * Number(it.qty || 0);
      unknown.push(it.slug || it.name || '?');
    }
  }
  const shipping = Math.max(0, Number(order && (order.shippingCost !== undefined ? order.shippingCost : (order.shipping && order.shipping.cost))) || 0);
  const out = {
    catalog_subtotal_server: catalogSum.toFixed(2),
    subtotal_server: billed.toFixed(2),
    total_server: (billed + shipping).toFixed(2),
    discount_subtotal_server: discountable.toFixed(2),
    price_mismatch: unknown.length > 0,
    manual_pricing: anyManual
  };
  if (unknown.length) out.unknown_items = unknown;
  return out;
}
function applyCrmMoney(order, maps) {
  if (!order || !Array.isArray(order.items) || !order.items.length) return { skipped: false, unchanged: true };
  const check = priceCheckCrm(order, maps);
  if (!check || check.price_check === 'skipped') return { skipped: true };
  for (const k of CRM_MONEY_KEYS) delete order[k];
  const disc = discountFields(order, { subtotal_server: check.discount_subtotal_server, total_server: check.total_server });
  order.catalog_subtotal_server = check.catalog_subtotal_server;
  order.subtotal_server = check.subtotal_server;
  order.total_server = check.total_server;
  order.price_mismatch = check.price_mismatch === true;
  if (check.unknown_items && check.unknown_items.length) order.unknown_items = check.unknown_items;
  if (check.manual_pricing) order.manual_pricing = true;
  Object.assign(order, disc);
  // store-orders.html and the card still read subtotal/total — keep them equal to
  // the quoted server figures so a dead checkout total does not survive a CRM edit.
  order.subtotal = order.subtotal_server;
  order.total = order.total_server;
  return { skipped: false };
}
const FORGED_ORDER_KEYS = ['payments', 'edits', 'original', 'updated_at', 'catalog_subtotal_server', 'subtotal_server', 'total_server', 'discount_server', 'discount_pct_server', 'discount_source', 'total_due_server', 'price_mismatch', 'price_check', 'unknown_items', 'manual_pricing', 'test', 'source', 'source_ref', 'source_created_at', 'source_updated_at', 'charge_check', 'channel', 'letters', 'alerts'];
function stripForgedOrderFields(obj) {
  const out = Object.assign({}, obj);
  for (const k of FORGED_ORDER_KEYS) delete out[k];
  return out;
}
function decodePathPart(s) {
  try { return decodeURIComponent(String(s || '')); } catch (e) { return String(s || ''); }
}
function parseIsoStamp(v) {
  if (v === undefined || v === null || v === '') return new Date().toISOString();
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}
const CRM_SHIP_STR = { address1: 200, address2: 200, city: 100, state: 100, zip: 20, country: 60, method: 40, label: 80 };
const CRM_CUST_STR = { firstName: 80, lastName: 80, phone: 40, company: 120 };
function mergeCustomerPatch(order, src) {
  if (!order.customer || typeof order.customer !== 'object' || Array.isArray(order.customer)) order.customer = {};
  for (const k of Object.keys(CRM_CUST_STR)) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    if (src[k] !== null && typeof src[k] === 'object') return 'customer.' + k + ' must be a string';
    order.customer[k] = cleanStr(src[k], CRM_CUST_STR[k]);
  }
  return null;
}
function mergeShippingPatch(order, src) {
  if (!order.shipping || typeof order.shipping !== 'object' || Array.isArray(order.shipping)) order.shipping = {};
  for (const k of Object.keys(CRM_SHIP_STR)) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    if (src[k] !== null && typeof src[k] === 'object') return 'shipping.' + k + ' must be a string';
    order.shipping[k] = cleanStr(src[k], CRM_SHIP_STR[k]);
  }
  if (Object.prototype.hasOwnProperty.call(src, 'cost')) {
    const cost = asMoney(src.cost);
    if (!Number.isFinite(cost) || cost < 0 || cost > 1e6) return 'shipping.cost must be a non-negative number (max 1000000)';
    order.shipping.cost = cost;
    order.shippingCost = cost;
  }
  return null;
}
function mergeDedupeKeep(keep, copies) {
  const removedRecords = [];
  for (let i = 1; i < copies.length; i++) {
    const copy = copies[i];
    if (!copy || typeof copy !== 'object') { removedRecords.push(copy); continue; }
    removedRecords.push(cloneJson(copy));
    if ((!Array.isArray(keep.payments) || !keep.payments.length) && Array.isArray(copy.payments) && copy.payments.length) {
      keep.payments = cloneJson(copy.payments);
    }
    if (!keep.original && copy.original) keep.original = cloneJson(copy.original);
    if (!String(keep.trackingNumber || '').trim() && String(copy.trackingNumber || '').trim()) keep.trackingNumber = copy.trackingNumber;
    if (!String(keep.managerNote || '').trim() && String(copy.managerNote || '').trim()) keep.managerNote = copy.managerNote;
    if (!String(keep.status || '').trim() && String(copy.status || '').trim()) keep.status = copy.status;
  }
  return removedRecords;
}

// Shop stage 2 (2026-09-06): what a letter is allowed to know, and in what shape. Two rules meet here.
// The white list: the stored order carries more than a letter needs — phone, company, notes, the browser's own totals,
// the raw price-check flags — and a template renders whatever it is handed, so the letter is built field by field. The
// money is the server's own (task 1): those are the figures the manager invoices. Shipping is total_server minus
// subtotal_server, so the numbers in the letter always add up to the same total.
// The scrub: Customer.io renders Liquid, which does not escape by default, and its templates are edited in the
// provider's own interface, not here. A name or an address typed into the public checkout form must therefore not reach
// a template still shaped like markup, or the shop sends a DKIM-signed letter from its own domain carrying somebody
// else's link. HTMLISH (defined just below, the same definition the catalog is checked against) says what markup is;
// here every value is escaped unconditionally, because an order is saved whatever was typed into it and a
// tag can also be assembled out of two fields that each look harmless on their own. orders.json keeps the text
// the customer sent — only the copy travelling to the provider is cleaned.
// mailHeaderValue lived here until this stage; it had exactly one caller, the sendmail block removed from notify-order.
function mailSafe(v) {
  // Escaped, not deleted, and unconditionally: the previous version scrubbed only values that looked like markup on
  // their own, so a tag split across two fields (first name "<a href=\"https://evil.example\"", last name ">Pay here")
  // walked through untouched and met again in the letter. Escaping every angle bracket, ampersand and quote means no
  // field can contribute a fragment of markup at all, while the text still reads as written ("Purity >98%" survives).
  // The three schemes are broken first, before escaping, in case a template ever drops a value into an href.
  return String(v === undefined || v === null ? '' : v)
    .replace(/\s+/g, ' ')
    .replace(/\b(javascript|vbscript)\s*:+/gi, '$1 ')
    .replace(/\bdata\s*:+\s*text\/html/gi, 'data text/html')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .trim();
}
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Markup is refused outright here rather than scrubbed: this value is also the envelope address the provider is asked
// to deliver to, and an address that needs cleaning is not an address.
function looksLikeEmail(v) { return typeof v === 'string' && v.length <= 200 && EMAIL_RE.test(v.trim()) && !HTMLISH.test(v); }
function orderMessageData(order) {
  const c = order.customer || {}, s = order.shipping || {};
  const txt = mailSafe;                                          // every string in the letter goes through the scrub
  const cityLine = [s.city, s.state, s.zip].map(txt).filter(Boolean).join(' ');
  const data = {
    ref: txt(order.ref),
    customer_name: [c.firstName, c.lastName].map(txt).filter(Boolean).join(' '),
    first_name: txt(c.firstName),                                // stage 1 RET: the new tx 3 greets by trigger.first_name, also while letters are off
    customer_email: txt(c.email),
    shipping_address: [s.address1, s.address2, cityLine, s.country].map(txt).filter(Boolean).join(', '),
    shipping_method: txt(s.label) || txt(s.method),
    items: (Array.isArray(order.items) ? order.items : []).map(i => ({
      name: txt(i.name), mg: txt(i.mg),
      qty: Number(i.qty) || 0,
      price: Number.isFinite(Number(i.price)) ? Number(i.price).toFixed(2) : ''
    })),
    coupon: txt(order.coupon),
    payment_method: txt(order.paymentMethod),
    placed_at: txt(order.savedAt)
  };
  // The server figures are missing when the catalog could not be read (priceCheck skipped): then the letter carries no
  // sums at all rather than invented ones. These come from the server's own arithmetic, not from the request, so they
  // go in as they are.
  for (const k of ['subtotal_server', 'discount_server', 'discount_pct_server', 'discount_source', 'total_due_server']) {
    if (order[k] !== undefined) data[k] = order[k];
  }
  if (order.subtotal_server !== undefined && order.total_server !== undefined) {
    data.shipping_server = ((Math.round(Number(order.total_server) * 100) - Math.round(Number(order.subtotal_server) * 100)) / 100).toFixed(2);
  }
  // Whether the order can be shipped from the letter alone. A clean order and a broken one used to produce the same
  // letter: a line that is not in the catalog is listed among the items but missing from the sums (ship it and the shop
  // is out a vial), and an unreadable catalog leaves no server figures at all, so the only money in the letter would be
  // the browser's word for it. price_mismatch and price_check themselves stay out — one flag is what a manager acts on.
  data.totals_available = order.price_check !== 'skipped' && order.subtotal_server !== undefined;
  data.needs_review = order.price_mismatch === true || !data.totals_available;
  data.unknown_items = (Array.isArray(order.unknown_items) ? order.unknown_items : []).map(mailSafe).filter(Boolean).join(', ');
  return data;
}
// One transactional message. No retry — a letter that never arrives is cheaper than an order handler stuck on a provider
// — and the log gets the kind, the order ref and the status only: never the key, the addresses or the body.
function cioSendEmail(messageId, to, identity, messageData, kind, ref, onResult) {
  const tag = '[cio] ' + kind + ' email for ' + (ref || '(no ref)');
  // Mail outbox (2026-09-29): onResult, when given, hears the outcome once — every branch below ends in report().
  let reported = false;
  const report = (ok, status, errorText) => {
    if (reported || typeof onResult !== 'function') return;
    reported = true;
    try { onResult(ok, status, errorText); } catch (e) { console.error(tag + ': result callback failed (' + ((e && e.message) || 'error') + ')'); }
  };
  let payload;
  try {
    payload = JSON.stringify({ transactional_message_id: messageId, to: to, identifiers: { email: identity }, message_data: messageData });
  } catch (e) { console.error(tag + ': not built (' + ((e && e.message) || 'error') + ')'); report(false, 'not_built', 'not built'); return; }
  let done = false;
  const finish = (ok, what, status) => { if (done) return; done = true; if (ok) console.log(tag + ': ' + what); else console.error(tag + ': ' + what); report(ok, status, ok ? '' : what); };
  let r;
  try {
    r = (CIO_URL.protocol === 'https:' ? https : http).request({
      protocol: CIO_URL.protocol, hostname: CIO_URL.hostname, port: CIO_URL.port || undefined, path: CIO_URL.pathname,
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + CIO_API_KEY, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: CIO_SEND_TIMEOUT_MS
    }, resp => {
      resp.resume();                                 // the answer is of no use here; draining it frees the socket
      resp.on('error', () => { /* an aborted answer must not take the process down */ });
      finish(resp.statusCode >= 200 && resp.statusCode < 300, 'HTTP ' + resp.statusCode, resp.statusCode);
    });
  } catch (e) { console.error(tag + ': not sent (' + ((e && e.message) || 'error') + ')'); report(false, undefined, 'not sent (' + ((e && e.message) || 'error') + ')'); return; }
  r.on('timeout', () => r.destroy(new Error('timed out after ' + CIO_SEND_TIMEOUT_MS + ' ms')));
  r.on('error', e => finish(false, 'not sent (' + ((e && e.message) || 'error') + ')'));
  r.end(payload);
}
// Both letters for one order: the manager always, the customer when the checkout left a usable address.
function sendOrderEmails(order) {
  if (!CIO_READY) return;
  const data = orderMessageData(order), ref = order.ref || '';
  // CIO_MANAGER_TO may hold several addresses; identifiers names one person, so the first address identifies the letter.
  if (CIO_ORDER_MANAGER_MSG_ID && CIO_MANAGER_TO) cioSendEmail(CIO_ORDER_MANAGER_MSG_ID, CIO_MANAGER_TO, CIO_MANAGER_TO.split(',')[0], data, 'manager', ref);
  const to = order.customer && typeof order.customer.email === 'string' ? order.customer.email.trim() : '';
  if (CIO_ORDER_CUSTOMER_MSG_ID && looksLikeEmail(to)) cioSendEmail(CIO_ORDER_CUSTOMER_MSG_ID, to, to, data, 'customer', ref);
}

// Shop stage 3 (2026-09-07): one Track API request. Built after cioSendEmail and for the same reasons — no retry, a
// five second timeout, the answer drained and never parsed. The log gets the event, the order ref (or a short hash of
// the address, never the address itself) and the status code. Every caller answers its own client first: a throw here,
// after res.end(), is what takes the process down.
function cioTrackId(email, ref) { return ref || crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 8); }
function cioTrackRequest(method, subPath, payloadObj, tag, onDone, onResult) {
  // Mail outbox (2026-09-29): onResult(ok, status, errorText), when given, hears the outcome exactly once (see cioSendEmail).
  let reported = false;
  const report = (ok, status, errorText) => {
    if (reported || typeof onResult !== 'function') return;
    reported = true;
    try { onResult(ok, status, errorText); } catch (e) { console.error(tag + ' result callback failed: ' + ((e && e.message) || 'error')); }
  };
  if (!CIO_TRACK_READY) { report(true, 'skipped', ''); return; }
  // onDone (cart attributes, 2026-09-07) runs once this request is over — successfully or not — so that a second
  // request can be made to wait for the first. It decides nothing: a caller whose second request has to go either way
  // is called on failures too, and a throw inside it is caught here instead of reaching the event loop.
  const after = () => { if (typeof onDone !== 'function') return; try { onDone(); } catch (e) { console.error(tag + ' follow-up failed: ' + ((e && e.message) || 'error')); } };
  let payload;
  try { payload = JSON.stringify(payloadObj); } catch (e) { console.error(tag + ' not built (' + ((e && e.message) || 'error') + ')'); report(false, 'not_built', 'not built'); after(); return; }
  let done = false;
  const finish = (ok, what, status) => { if (done) return; done = true; if (ok) console.log(tag + ' ' + what); else console.error(tag + ' ' + what); report(ok, status, ok ? '' : what); after(); };
  let r;
  try {
    r = (CIO_TRACK_URL.protocol === 'https:' ? https : http).request({
      protocol: CIO_TRACK_URL.protocol, hostname: CIO_TRACK_URL.hostname, port: CIO_TRACK_URL.port || undefined,
      path: CIO_TRACK_URL.pathname.replace(/\/+$/, '') + subPath,
      method: method,
      headers: {
        'Authorization': 'Basic ' + Buffer.from(CIO_SITE_ID + ':' + CIO_TRACKING_API_KEY).toString('base64'),
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload)
      },
      timeout: CIO_SEND_TIMEOUT_MS
    }, resp => {
      resp.resume();                                 // the answer is of no use here; draining it frees the socket
      resp.on('error', () => { /* an aborted answer must not take the process down */ });
      finish(resp.statusCode >= 200 && resp.statusCode < 300, 'HTTP ' + resp.statusCode, resp.statusCode);
    });
  } catch (e) { console.error(tag + ' not sent (' + ((e && e.message) || 'error') + ')'); report(false, undefined, 'not sent (' + ((e && e.message) || 'error') + ')'); after(); return; }
  r.on('timeout', () => r.destroy(new Error('timed out after ' + CIO_SEND_TIMEOUT_MS + ' ms')));
  r.on('error', e => finish(false, 'not sent (' + ((e && e.message) || 'error') + ')'));
  r.end(payload);
}
function cioTrackIdentify(email, attrs) {
  if (!CIO_TRACK_READY || !email || !attrs) return;
  cioTrackRequest('PUT', '/api/v1/customers/' + encodeURIComponent(email), attrs, '[cio-track] identify ' + cioTrackId(email));
}
function cioTrackEvent(email, name, data, ref) {
  if (!CIO_TRACK_READY || !email || !name) return;
  cioTrackRequest('POST', '/api/v1/customers/' + encodeURIComponent(email) + '/events', { name: name, data: data || {} }, '[cio-track] ' + name + ' ' + cioTrackId(email, ref));
}
// The profile first, the event second: an event for a person Customer.io has never heard of creates an empty one, and
// the attributes are what the campaigns segment on. No keys configured means not even the file read below.
function cioTrackWithProfile(email, eventName, data, ref, attrOpts) {
  if (!CIO_TRACK_READY) return;
  const addr = String(email === undefined || email === null ? '' : email).trim().toLowerCase();
  if (!looksLikeEmail(addr)) return;                 // an order without a usable address has no profile to attach to
  cioTrackIdentify(addr, orderAttributesFor(addr, attrOpts));
  cioTrackEvent(addr, eventName, data, ref);
}
// Shop stage 3, cart attributes (2026-09-07): the abandonment campaign filters its trigger on a profile attribute
// ("there is something in the cart"), and an event on its own puts nothing on a profile. A cart event therefore carries
// the state of the cart with it — these three attributes and nothing else. The order history is not touched here: it is
// recounted on the order path, and reading orders.json on every change of a cart would be a file read per keystroke.
// The attributes are sent first and the event only once they have been answered. That orders the sending, not the
// processing: a 200 from the Track API means "queued", and the provider gives no order guarantee — two cart changes in
// quick succession can still leave the profile on the earlier count until the next event fixes it (the same class as
// two order statuses in a row). It is worth the one round trip all the same: the campaign's exit condition and its
// segments read this attribute later, when nothing is in flight. The event is sent whether the attributes arrived or
// not — a hiccup at the provider must not swallow the cart event itself.
function cartAttributesFor(email, data) {
  const count = trackNum(data && data.item_count), total = trackNum(data && data.total);
  return {
    email: email,
    cart_item_count: count === undefined ? 0 : count,   // no number from the browser means an empty cart, not "unknown"
    cart_total: total === undefined ? 0 : total,
    cart_updated_at: new Date().toISOString()
  };
}
function cioTrackCart(email, name, data) {
  if (!CIO_TRACK_READY || !email) return;
  cioTrackRequest('PUT', '/api/v1/customers/' + encodeURIComponent(email), cartAttributesFor(email, data),
    '[cio-track] cart ' + cioTrackId(email), () => cioTrackEvent(email, name, data));
}
// Attributes are recounted from orders.json rather than incremented: orders are created and edited in the CRM as well,
// and a counter kept on the side would drift away from the file within a day. Statuses that count as money received are
// the ones the CRM offers after payment; a cancelled order counts for nothing at all.
const ORDER_PAID_STATUSES = ['paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered'];   // in-transit: stage 1 RET, counts like shipped
const TRACK_ORDERS_FILE = path.join(__dirname, 'orders.json');
function trackEmail(v) { return String(v === undefined || v === null ? '' : v).trim().toLowerCase(); }
// What the order was worth: the server's own figure when there is one, the browser's word for it only as a last resort.
function orderMoney(o) {
  for (const v of [o.total_due_server, o.total_server, o.total]) {
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return 0;
}
function orderStamp(o) {
  return (typeof o.created_at === 'string' && o.created_at) || (typeof o.timestamp === 'string' && o.timestamp) || (typeof o.savedAt === 'string' && o.savedAt) || '';
}
// The attributes of §2 of the contract for one address. Absent values are left out entirely rather than sent empty:
// an empty attribute in Customer.io overwrites whatever the letters put there. unsubscribed and created_at are never
// written from here — the first belongs to Customer.io (writing it would revive someone who opted out), the second it
// sets itself. orders is the array the caller already has in hand, so one request reads the file at most once.
// Every string leaving for the provider goes through mailSafe, the same scrub the letters use (see its definition
// above). Customer.io renders Liquid, which does not escape by default, and its templates are written by hand in the
// provider's interface; a profile, meanwhile, is addressed by e-mail alone, so anyone can write attributes onto the
// profile of an address they do not own. Unescaped, a first name typed into the public form would arrive as live
// markup in the next letter that person receives — signed with the shop's own domain. The address itself is left
// alone: it is the identifier the profile is found by, it has already passed looksLikeEmail, and the URL escapes it
// separately. Numbers are numbers. cleanStr first, mailSafe second: escaping and then cutting to length could slice
// an entity in half.
function orderAttributesFor(email, opts) {
  const o = opts || {};
  const key = trackEmail(email);
  if (!key) return null;
  const attrs = { email: key };
  if (o.source) attrs.source = o.source;
  if (o.firstName) attrs.first_name = mailSafe(cleanStr(o.firstName, 80));
  if (o.coupon) attrs.coupon = mailSafe(cleanStr(o.coupon, 40));
  // The cart is empty once an order has been placed — the shop clears it — so the abandonment campaign has to let this
  // person out. Only the counter is reset, because that is what the filter reads; cart_total keeps the last cart's figure.
  if (o.cartCleared) attrs.cart_item_count = 0;
  // M6: consent as the profile sees it — what was agreed to, when, and on which path. Sent only by the
  // signup route, so an order never overwrites it: an attribute that is not in the request is left alone.
  // The strings are escaped like every other string here, for the reason spelled out above — the text comes
  // off a page a browser was looking at, and Liquid does not escape.
  if (o.consent) {
    attrs.marketing_consent = o.consent.marketing_consent === true;
    if (o.consent.marketing_consent_at) attrs.marketing_consent_at = mailSafe(cleanStr(o.consent.marketing_consent_at, 40));
    if (o.consent.consent_source) attrs.consent_source = mailSafe(cleanStr(o.consent.consent_source, 40));
    if (o.consent.consent_text) attrs.consent_text = mailSafe(cleanStr(o.consent.consent_text, 200));
  }
  let orders;
  try { orders = Array.isArray(o.orders) ? o.orders : readJsonOrFallback(TRACK_ORDERS_FILE, []); }
  catch (e) { return attrs; }                        // unreadable orders.json: the profile is still worth writing
  if (!Array.isArray(orders)) return attrs;
  let count = 0, total = 0, paid = 0, last = null, lastAt = '';
  for (const ord of orders) {
    if (!ord || typeof ord !== 'object') continue;
    if (trackEmail(ord.customer && ord.customer.email) !== key) continue;
    const status = String(ord.status || '').trim().toLowerCase();
    if (status === 'cancelled') continue;
    // Card import (2026-09-27): a sandbox-mode card payment (order.test) must not inflate a real person's order
    // count, total or paid sum in Customer.io.
    if (ord.test === true) continue;
    count++;
    const money = orderMoney(ord);
    total += money;
    if (ORDER_PAID_STATUSES.includes(status)) paid += money;
    // orders.json is in no single order — the storefront puts its orders on top, the CRM appends its own — so the last
    // order is the one with the newest stamp; equal or missing stamps keep the first one met, which for a storefront
    // order is the newest anyway.
    const stamp = orderStamp(ord);
    if (last === null || stamp > lastAt) { last = ord; lastAt = stamp; }
  }
  if (!count || !last) return attrs;
  attrs.orders_count = count;
  attrs.orders_total = Math.round(total * 100) / 100;
  attrs.orders_paid_total = Math.round(paid * 100) / 100;
  const when = (typeof last.created_at === 'string' && last.created_at) || (typeof last.timestamp === 'string' && last.timestamp) || '';
  if (when) attrs.last_order_at = mailSafe(cleanStr(when, 40));
  if (last.ref) attrs.last_order_ref = mailSafe(cleanStr(last.ref, 64));
  if (last.shipping && last.shipping.country) attrs.country = mailSafe(cleanStr(last.shipping.country, 80));
  // The slugs go as one comma-joined string, not an array: the identify schema takes string | integer | boolean, and
  // Customer.io answers 200 even to an attribute it did not store — an array would have been refused in silence and the
  // owner would see an empty field with nothing to explain it.
  const slugs = (Array.isArray(last.items) ? last.items : []).map(i => mailSafe(cleanStr(i && i.slug, 64))).filter(Boolean).slice(0, 10);
  if (slugs.length) attrs.last_products = slugs.join(',');
  if (typeof last.tc_accepted_at === 'string' && last.tc_accepted_at) attrs.tc_accepted_at = mailSafe(cleanStr(last.tc_accepted_at, 40));
  if (!attrs.first_name && last.customer && last.customer.firstName) attrs.first_name = mailSafe(cleanStr(last.customer.firstName, 80));
  if (!attrs.coupon && last.coupon) attrs.coupon = mailSafe(cleanStr(last.coupon, 40));
  return attrs;
}
// The order event carries the shop's own figures — the ones a stale or edited cart cannot set — and no personal data at
// all: address, phone and notes stay in orders.json. needs_review is the flag the manager's letter already shows.
// Strings are escaped with mailSafe for the reason spelled out over the attributes above — an item name comes from a
// browser too. orders.json still keeps the text the customer sent; only the copy travelling to the provider is scrubbed.
// order_delivered (cio-events 2026-09-30): the post-delivery letters print {{ trigger.order_number }}; the order number is the ref.
function orderDeliveredData(order) {
  const ref = mailSafe(cleanStr(order.ref, 64));
  return { ref: ref, order_number: ref, status: 'delivered' };
}
function orderPlacedData(order) {
  const data = { ref: mailSafe(cleanStr(order.ref, 64)) };
  data.items = (Array.isArray(order.items) ? order.items : []).slice(0, 30).map(i => {
    const it = { name: mailSafe(cleanStr(i && i.name, 120)), slug: mailSafe(cleanStr(i && i.slug, 64)), qty: Number(i && i.qty) || 0 };
    const price = Number(i && i.price);
    if (Number.isFinite(price) && price >= 0) it.price = price;
    const mg = mailSafe(cleanStr(i && i.mg, 20));
    if (mg) it.mg = mg;
    return it;
  });
  for (const k of ['subtotal_server', 'discount_server', 'discount_source', 'total_due_server']) {
    const v = order[k];
    if (v === undefined || v === null || v === '') continue;
    data[k] = typeof v === 'string' ? mailSafe(cleanStr(v, 40)) : v;
  }
  if (order.coupon) data.coupon = mailSafe(cleanStr(order.coupon, 40));
  if (order.paymentMethod) data.payment_method = mailSafe(cleanStr(order.paymentMethod, 40));
  data.needs_review = order.price_mismatch === true || order.price_check === 'skipped' || order.subtotal_server === undefined;
  return data;
}
// The token the storefront keeps in localStorage. POST /track is public — the shop is static and its visitors are
// anonymous — so without a signature anyone could invent cart events, and profiles, for any address at all. The address
// therefore travels signed, and /track never takes one out of the request body. base64url is spelled out instead of
// Buffer's own 'base64url' encoding, which is newer than the node this file has to keep running on.
function trackTokenFor(emailLower) {
  if (!CIO_TRACK_TOKEN_SECRET || !emailLower) return null;
  const head = Buffer.from(String(emailLower), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return head + '.' + crypto.createHmac('sha256', CIO_TRACK_TOKEN_SECRET).update(emailLower).digest('hex').slice(0, 32);
}
// The address a token stands for, or null. Both halves are checked for shape first, and the address itself as well:
// timingSafeEqual throws on buffers of unequal length, and a signature is only worth comparing at all once the thing it
// signs is an address.
function emailFromTrackToken(token) {
  if (!CIO_TRACK_TOKEN_SECRET || typeof token !== 'string' || token.length > 400) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const head = token.slice(0, dot), sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(head) || !/^[0-9a-f]{32}$/.test(sig)) return null;
  let email;
  try { email = Buffer.from(head.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8').trim().toLowerCase(); }
  catch (e) { return null; }
  if (!looksLikeEmail(email)) return null;
  const expect = Buffer.from(crypto.createHmac('sha256', CIO_TRACK_TOKEN_SECRET).update(email).digest('hex').slice(0, 32), 'utf8');
  const got = Buffer.from(sig, 'utf8');
  if (got.length !== expect.length || !crypto.timingSafeEqual(got, expect)) return null;
  return email;
}
// What a browser is allowed to say about a cart (contract §3, limits §4). Anything else is dropped without a word: these
// values are rendered by Liquid templates, where an unexpected key is noise at best and somebody else's link at worst.
const TRACK_EVENTS = ['cart_updated', 'checkout_started'];
const TRACK_CART_URL = 'https://biolabsresearch.co/checkout.html';
const TRACK_BODY_LIMIT = 8 * 1024;
const CHECKOUT_ID_BODY_LIMIT = 2 * 1024;           // {email, firstName, page} and nothing else
const QUOTE_BODY_LIMIT = 8 * 1024;                 // a cart of up to 50 lines and a code
// The scrub is inside trackStr rather than at its one call site: everything this function returns is on its way to a
// Liquid template, and a slug or an item name here is whatever the browser typed. Escaping comes after the cut, so no
// entity is sliced in half.
function trackStr(v, max) { return typeof v === 'string' ? mailSafe(stripControls(v, false).trim().slice(0, max)) : ''; }
function trackNum(v) {
  if (v === undefined || v === null || v === '' || (typeof v !== 'number' && typeof v !== 'string')) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
function trackEventData(raw) {
  const src = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
  const data = {};
  const items = (Array.isArray(src.items) ? src.items : []).slice(0, 30).map(i => {
    const it = {};
    for (const k of ['slug', 'name', 'mg']) { const s = trackStr(i && i[k], 120); if (s) it[k] = s; }
    const qty = trackNum(i && i.qty), price = trackNum(i && i.price);
    if (qty !== undefined) it.qty = qty;
    if (price !== undefined) it.price = price;
    return it;
  }).filter(i => Object.keys(i).length);
  if (items.length) data.items = items;
  const total = trackNum(src.total), count = trackNum(src.item_count);
  if (total !== undefined) data.total = total;
  if (count !== undefined) data.item_count = count;
  data.cart_url = TRACK_CART_URL;                    // the shop's own link, never the browser's: a letter renders it
  return data;
}
// Catalog fields are rendered by the storefront through innerHTML and inline onclick handlers, so anything shaped like
// markup, a script URL or an event handler is refused at the door; short fields that end up inside attributes and handler
// strings (name, category, tagline, badge, strengths) may not contain quotes, angle brackets, backticks or backslashes.
// Plain '<5%' / '>98%' in a description is fine — only tag/URL/handler shapes match.
const HTMLISH = /<\s*[a-zA-Z\/!?]|javascript\s*:|\bon[a-z]+\s*=|data\s*:\s*text\/html|&#x?[0-9a-f]+;?|&(apos|quot);/i;
const SHORT_FIELDS = ['name', 'category', 'tagline', 'badge', 'strengths', 'mg'];
const SLUG_RE = /^[a-z0-9-]{1,64}$/;
const IMAGE_URL_RE = /^(\/(media|product-images)\/[A-Za-z0-9._\/-]+(\?[A-Za-z0-9=&._-]*)?|https:\/\/media\.base44\.com\/[A-Za-z0-9._\/%-]+(\?[A-Za-z0-9=&._-]*)?)$/;
function findHtmlish(value, where) {
  if (typeof value === 'string') return HTMLISH.test(value) ? where : '';
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const r = findHtmlish(value[i], where + '[' + i + ']'); if (r) return r; } return ''; }
  if (value && typeof value === 'object') { for (const k of Object.keys(value)) { const r = findHtmlish(value[k], where + '.' + k); if (r) return r; } return ''; }
  return '';
}
function validateProductFields(p, where) {
  const html = findHtmlish(p, where);
  if (html) return html + ' contains markup or script';
  for (const k of SHORT_FIELDS) {
    const vals = Array.isArray(p[k]) ? p[k] : (p[k] === undefined || p[k] === null ? [] : [p[k]]);
    for (const v of vals) if (typeof v === 'string' && /["'<>`\\]/.test(v)) return where + ': ' + k + ' may not contain quotes, angle brackets, backticks or backslashes';
  }
  if (p.slug !== undefined && p.slug !== null && p.slug !== '' && !SLUG_RE.test(String(p.slug))) return where + ': slug may contain only a-z, 0-9 and - (max 64)';
  if (p.image_url !== undefined && p.image_url !== null && p.image_url !== '' && !IMAGE_URL_RE.test(String(p.image_url))) return where + ': image_url must be /media/…, /product-images/… or https://media.base44.com/…';
  for (const k of ['price', 'original_price']) {
    if (p[k] !== undefined && p[k] !== null && !(typeof p[k] === 'number' && Number.isFinite(p[k]))) return where + ': ' + k + ' must be a number';
  }
  return '';
}
// Phase 1 (2026-09-04): whole-catalog save from CRM Inventory (POST /products) — shape check and server-side merge.
function validateCatalogPayload(list) {
  if (!Array.isArray(list)) return 'Expected an array of products';
  if (list.length === 0) return 'Refusing to replace the catalog with an empty list';
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!p || typeof p !== 'object' || Array.isArray(p)) return 'Product #' + i + ' is not an object';
    const hasId = (typeof p.id === 'string' && p.id.trim() !== '') || typeof p.id === 'number';
    const hasSlug = typeof p.slug === 'string' && p.slug.trim() !== '';
    if (!hasId && !hasSlug) return 'Product #' + i + ' has neither id nor slug';
    if (p.price !== undefined && p.price !== null && !(typeof p.price === 'number' && Number.isFinite(p.price))) {
      return 'Product #' + i + ': price must be a number';
    }
    const fieldErr = validateProductFields(p, 'Product #' + i);   // shop stage 0
    if (fieldErr) return fieldErr;
  }
  return '';
}
// Merge by id (fallback: slug when the incoming item has no id). Fields missing from the payload are kept from the
// stored record; products missing from the payload are dropped (that is how Inventory deletes); unknown ones are added.
function mergeCatalog(existing, incoming) {
  const byId = new Map(), bySlug = new Map();
  for (const p of existing) {
    if (!p || typeof p !== 'object') continue;
    if (p.id !== undefined && p.id !== null) byId.set(String(p.id), p);
    if (typeof p.slug === 'string' && p.slug) bySlug.set(p.slug, p);
  }
  return incoming.map(p => {
    const prev = (p.id !== undefined && p.id !== null) ? byId.get(String(p.id)) : bySlug.get(p.slug);
    return prev ? Object.assign({}, prev, p) : p;
  });
}

// Phase 3 (2026-09-05): order statuses accepted by PATCH /orders/:ref — the union of what orders.html sends (shipped) and
// the select in store-orders.html (pending … cancelled); the brief's new/paid are in the set too.
const ORDER_STATUSES = ['new', 'pending', 'paid', 'payment-confirmed', 'processing', 'shipped', 'in-transit', 'delivered', 'cancelled'];   // in-transit: stage 1 RET
// The id/ref part of a /prefix/<id> URL: query string dropped, percent-decoded (a malformed escape is used as-is).
function idFromUrl(req, prefix) {
  const raw = String(req.url || '').split('?')[0].slice(prefix.length);
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}
// Shape check for one product sent to PUT /products/:id (the same rules as validateCatalogPayload, per record).
function validateProductPayload(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) return 'Expected a product object';
  if (p.name !== undefined && typeof p.name !== 'string') return 'name must be a string';
  if (p.price !== undefined && p.price !== null && !(typeof p.price === 'number' && Number.isFinite(p.price))) return 'price must be a number';
  return validateProductFields(p, 'Product');   // shop stage 0
}
// The stored product addressed by an id from the URL: by id, or by slug for a record that has no id (Inventory sends p.id||p.slug).
function findProductIndex(list, id) {
  return list.findIndex(p => p && ((p.id !== undefined && p.id !== null && String(p.id) === id) || ((p.id === undefined || p.id === null) && p.slug === id)));
}

function jsonReply(res, code, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}


// CRM lead upsert for VIP/exit-intent Insider signups AND checkout inquiries.
// Reuses emptyLead from leads-store so the JSON schema stays aligned with blitz-api.
let emptyLeadFn = null;
try {
  emptyLeadFn = require('/opt/crm-api/leads-store.cjs').emptyLead;
} catch (e) {
  console.error('[crm-leads] could not load leads-store emptyLead:', e.message);
}
const CRM_LEADS_FILE = '/opt/crm-api/data/leads.json';
let siteCopyStore = null;
try { siteCopyStore = require('/opt/shop-content/site-copy-lib.cjs').defaultStore(); }
catch (e) { console.error('[site-copy] lib not loaded:', e.message); }

function sleepMs(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (e) {
    const until = Date.now() + ms;
    while (Date.now() < until) { /* spin */ }
  }
}

function isInsiderSignup(orderData, subject) {
  const od = orderData && typeof orderData === 'object' ? orderData : {};
  if (od.type === 'insider-signup') return true;
  if (/insider signup/i.test(String(subject || ''))) return true;
  // Coupon-only: VIP popup may omit type. Do not treat real checkouts (ref/items) as signups.
  if (od.coupon && !od.ref && !Array.isArray(od.items)) return true;
  return false;
}

function pageFromBody(body) {
  const m = String(body || '').match(/^Page:\s*(.+)$/im);
  return m ? m[1].trim() : '';
}

function acquireLeadsLock() {
  const lockPath = CRM_LEADS_FILE + '.lock';
  const started = Date.now();
  while (Date.now() - started < 2500) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, String(process.pid));
      return { fd, lockPath };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 8000) fs.unlinkSync(lockPath);
      } catch (e2) { /* ignore stale-lock races */ }
      sleepMs(40);
    }
  }
  return null;
}

function releaseLeadsLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch (e) {}
  try { fs.unlinkSync(lock.lockPath); } catch (e) {}
}


function isCheckoutInquiry(orderData) {
  const od = orderData && typeof orderData === 'object' ? orderData : {};
  if (od.ref) return true;
  if (Array.isArray(od.items) && od.items.length > 0) return true;
  return false;
}

function checkoutCustomer(orderData) {
  const od = orderData && typeof orderData === 'object' ? orderData : {};
  const c = (od.customer && typeof od.customer === 'object') ? od.customer : {};
  const email = String(c.email || od.email || '').trim();
  const firstName = String(c.firstName || c.first_name || od.firstName || od.first_name || '').trim();
  const lastName = String(c.lastName || c.last_name || od.lastName || od.last_name || '').trim();
  const companyField = String(c.company || od.company || '').trim();
  const phone = String(c.phone || od.phone || '').trim();
  const fullName = [firstName, lastName].filter(Boolean).join(' ').trim();
  const localPart = (email.split('@')[0] || 'Checkout').trim();
  const company = companyField || fullName || localPart;
  return { email, phone, company, firstName, lastName };
}

function summarizeCheckoutItems(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map(it => {
    if (!it || typeof it !== 'object') return String(it);
    const name = String(it.name || it.slug || it.id || 'item').trim();
    const qty = it.qty != null ? it.qty : (it.quantity != null ? it.quantity : 1);
    const price = it.price != null ? ' @' + it.price : '';
    return name + ' x' + qty + price;
  }).join('; ');
}

function priorityRank(p) {
  const v = String(p || '').trim().toLowerCase();
  if (v === 'high') return 3;
  if (v === 'medium') return 2;
  if (v === 'low') return 1;
  return 0;
}

function upsertCheckoutLead(orderData, subject, body, paymentMethod) {
  if (!isCheckoutInquiry(orderData)) return { skipped: true };
  // Insider/VIP path owns coupon-only / insider-signup payloads.
  if (isInsiderSignup(orderData, subject)) return { skipped: true, reason: 'insider' };

  const od = orderData && typeof orderData === 'object' ? orderData : {};
  const cust = checkoutCustomer(od);
  const email = cust.email;
  if (!email) return { skipped: true, reason: 'no_email' };

  const coupon = String(od.coupon || (od.localStorage && od.localStorage.coupon) || '').trim();
  const page = pageFromBody(body) || String(od.page || '').trim();
  const pay = String(paymentMethod || od.paymentMethod || '').trim();
  const ref = String(od.ref || '').trim();
  const itemsSummary = summarizeCheckoutItems(od.items);

  let notes = 'Source: Checkout inquiry.';
  if (ref) notes += ' Ref: ' + ref + '.';
  if (itemsSummary) notes += ' Items: ' + itemsSummary + '.';
  if (pay) notes += ' PaymentMethod: ' + pay + '.';
  if (page) notes += ' Page: ' + page + '.';

  const lock = acquireLeadsLock();
  try {
    const leads = readJsonOrFallback(CRM_LEADS_FILE, []);
    if (!Array.isArray(leads)) throw new Error('leads.json is not an array - lead not written');

    const emailKey = email.toLowerCase();
    const idx = leads.findIndex(l => String(l.email || '').trim().toLowerCase() === emailKey);
    const ts = new Date().toISOString();

    if (idx >= 0) {
      const prev = leads[idx];
      // Keep existing coupon; set only if provided and previously empty.
      if (coupon && !String(prev.coupon || '').trim()) prev.coupon = coupon;
      const prevNotes = String(prev.notes || '').trim();
      // Append checkout details without wiping VIP/other notes; avoid exact dupe lines.
      if (!prevNotes.includes(notes)) {
        prev.notes = [prevNotes, notes].filter(Boolean).join('\n');
      } else if (ref && !prevNotes.includes(ref)) {
        prev.notes = [prevNotes, 'Checkout ref update: ' + ref + (itemsSummary ? ' Items: ' + itemsSummary + '.' : '')].filter(Boolean).join('\n');
      }
      if (priorityRank(prev.priority) < priorityRank('High')) prev.priority = 'High';
      if (!String(prev.company || '').trim()) prev.company = cust.company;
      if (cust.phone && !String(prev.phone || '').trim()) prev.phone = cust.phone;
      prev.updated_at = ts;
      leads[idx] = prev;
    } else {
      const partial = {
        company: cust.company,
        email,
        phone: cust.phone,
        country: String((od.shipping && od.shipping.country) || od.country || '').trim(),
        city: String((od.shipping && od.shipping.city) || od.city || '').trim(),
        status: 'Not Contacted',
        priority: 'High',
        coupon,
        notes,
      };
      const lead = typeof emptyLeadFn === 'function'
        ? emptyLeadFn(partial)
        : {
            id: 'lead_' + require('crypto').randomBytes(6).toString('hex'),
            status: 'Not Contacted',
            priority: 'High',
            company: cust.company,
            country: partial.country,
            city: partial.city,
            email,
            phone: cust.phone,
            notes,
            coupon,
            last_email_sent_at: null,
            last_open_at: null,
            last_click_at: null,
            unsubscribed: false,
            cio_person_id: null,
            status_manual_override: false,
            created_at: ts,
            updated_at: ts,
          };
      if (lead) lead.priority = 'High';
      leads.push(lead);
    }

    writeJsonAtomic(CRM_LEADS_FILE, leads);
    return { ok: true, updated: idx >= 0 };
  } finally {
    releaseLeadsLock(lock);
  }
}

// M6 (2026-09-08): what a signup records about consent. The stamp and the source are the server's own —
// a browser cannot claim it agreed last year, or that the consent came from somewhere it did not. The
// promise the visitor was reading travels as text, so "what exactly did this person agree to" does not
// depend on the page still saying the same thing a year from now. The text is stored as typed (the same
// rule orders.json follows); only the copy that travels to Customer.io is escaped.
function consentRecord(text) {
  const rec = { marketing_consent: true, marketing_consent_at: new Date().toISOString(), consent_source: 'subscribe' };
  const t = cleanStr(text, 200);
  if (t) rec.consent_text = t;
  return rec;
}
// The four keys a lead is allowed to gain, rebuilt rather than copied. upsertInsiderLead below is called
// from two places — the signup route, which hands it the record above, and notify-order, which hands it a
// body a browser wrote — so a record is taken apart here instead of being assigned wholesale: without this
// an object in a request could put keys of its own choosing into leads.json.
function consentKeys(rec) {
  if (!rec || typeof rec !== 'object' || rec.marketing_consent !== true) return null;
  const out = {
    marketing_consent: true,
    marketing_consent_at: cleanStr(rec.marketing_consent_at, 40) || new Date().toISOString(),
    consent_source: cleanStr(rec.consent_source, 40) || 'subscribe'
  };
  const t = cleanStr(rec.consent_text, 200);
  if (t) out.consent_text = t;
  return out;
}

// consent (M6) is a parameter and never part of orderData: notify-order passes none, and a claim of consent
// must come only from the path that captured it.
function upsertInsiderLead(orderData, subject, body, consent) {
  if (!isInsiderSignup(orderData, subject)) return { skipped: true };
  const od = orderData && typeof orderData === 'object' ? orderData : {};
  const email = String(od.email || '').trim();
  if (!email) return { skipped: true, reason: 'no_email' };

  const firstName = String(od.firstName || od.first_name || '').trim();
  const localPart = (email.split('@')[0] || 'Insider').trim();
  const companyBase = firstName || localPart;
  const company = /\(Insider\)\s*$/i.test(companyBase) ? companyBase : (companyBase + ' (Insider)');
  const coupon = String(od.coupon || 'INSIDER25').trim() || 'INSIDER25';
  const page = pageFromBody(body);
  let notes = 'Source: VIP exit-intent / Insider signup.';
  if (page) notes += ' Page: ' + page;
  // Four extra keys go onto the lead; the schema of leads-store (the owner's agent owns that file) is not
  // touched and nothing in it is renamed.
  const consentFields = consentKeys(consent);

  const lock = acquireLeadsLock();
  try {
    const leads = readJsonOrFallback(CRM_LEADS_FILE, []);
    if (!Array.isArray(leads)) throw new Error('leads.json is not an array - lead not written');

    const emailKey = email.toLowerCase();
    const idx = leads.findIndex(l => String(l.email || '').trim().toLowerCase() === emailKey);
    const ts = new Date().toISOString();

    if (idx >= 0) {
      const prev = leads[idx];
      prev.coupon = coupon || prev.coupon;
      const prevNotes = String(prev.notes || '').trim();
      if (!prevNotes.includes(notes)) {
        prev.notes = [prevNotes, notes].filter(Boolean).join('\n');
      }
      prev.updated_at = ts;
      if (!String(prev.company || '').trim()) prev.company = company;
      if (consentFields) Object.assign(prev, consentFields);   // the record says when this person last agreed, and to what
      leads[idx] = prev;
    } else {
      const partial = {
        company,
        email,
        phone: '',
        country: '',
        city: '',
        status: 'Not Contacted',
        coupon,
        notes,
      };
      const lead = typeof emptyLeadFn === 'function'
        ? emptyLeadFn(partial)
        : {
            id: 'lead_' + require('crypto').randomBytes(6).toString('hex'),
            status: 'Not Contacted',
            priority: '',
            company,
            country: '',
            city: '',
            email,
            phone: '',
            notes,
            coupon,
            last_email_sent_at: null,
            last_open_at: null,
            last_click_at: null,
            unsubscribed: false,
            cio_person_id: null,
            status_manual_override: false,
            created_at: ts,
            updated_at: ts,
          };
      if (consentFields) Object.assign(lead, consentFields);
      leads.push(lead);
    }

    writeJsonAtomic(CRM_LEADS_FILE, leads);
    return { ok: true, updated: idx >= 0 };
  } finally {
    releaseLeadsLock(lock);
  }
}


// Parse multipart form data for image upload
function parseMultipart(body, boundary) {
  const parts = {};
  const boundaryBuf = Buffer.from('--' + boundary);
  let start = 0;
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  
  while (start < bodyBuf.length) {
    const bStart = bodyBuf.indexOf(boundaryBuf, start);
    if (bStart === -1) break;
    const contentStart = bStart + boundaryBuf.length + 2; // skip \r\n
    const bEnd = bodyBuf.indexOf(boundaryBuf, contentStart);
    if (bEnd === -1) break;
    
    const part = bodyBuf.slice(contentStart, bEnd - 2); // remove trailing \r\n
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) { start = bEnd; continue; }
    
    const headerStr = part.slice(0, headerEnd).toString();
    const data = part.slice(headerEnd + 4);
    
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type: ([^\r\n]+)/);
    
    if (nameMatch) {
      if (filenameMatch) {
        parts[nameMatch[1]] = { filename: filenameMatch[1], data, contentType: ctMatch ? ctMatch[1] : 'application/octet-stream' };
      } else {
        parts[nameMatch[1]] = data.toString();
      }
    }
    start = bEnd;
  }
  return parts;
}

// Shop stage 0 (2026-09-06): the storefront's own origins. biofirst.* were left over from July — biofirst.co has been another
// company's server since August and .fit/.shop only redirect there, so nothing legitimate calls this API from them.
const ALLOWED_ORIGINS = new Set([
  'https://biolabsresearch.co',
  'https://www.biolabsresearch.co',
  'https://mastersol-ltd.com',
  'https://www.mastersol-ltd.com'
]);

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Expose-Headers', 'X-CRM-Fields');
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── the identities the marketing list leaves out ─────────────────────────────────────────────────────────────
// M2b (2026-09-08): besides customers, orders.json and leads.json carry the traces of every test this shop has been
// through — the smoke orders of the phases, QA carts, render probes — and the shop's own manager mailbox, which gets
// a copy of every order. A profile at the provider is created by writing to it and is billed per profile, so the
// first sync would turn each of those into a line on the invoice and into a member of a segment that is meant to
// describe buyers. They are dropped here, in the one place the marketing list is built, and counted, so the page can
// say how many were dropped and whoever reads it can tell the filter did something.
//
// The rules are literal on purpose — nothing here guesses whether an address "looks like a test":
//   domains       the reserved ones (RFC 2606: example.com/.org/.net and .test/.invalid/.localhost) plus example.co
//                 and test.com — not reserved, but not anybody's shop address either: it is what gets typed into a
//                 form that has to be filled in. A domain matches as itself and as a suffix: looksLikeEmail already
//                 refuses an address whose domain has no dot in it at all, so "test", "invalid" and "localhost"
//                 only ever turn up as qa@shop.test.
//   local parts   the prefixes the stands of the earlier phases actually wrote (smoke-…, qa-cart…, probe-…). Each
//                 one ends in a separator on purpose: a bare "probe" would take a real probert@ out of the list too,
//                 and nothing here can put back an address the filter took away.
//   test orders   an order whose ref begins with one of those phases' prefixes is nobody's money: it is left out of
//                 the attributes. An address whose orders are all test orders and which never signed up is not a
//                 person at all and is left out of the list entirely.
//   addresses     admin@biolabsresearch.co, the manager mailbox of ORDER_NOTIFY_TO.
// MARKETING_EXCLUDE_PATTERNS in /opt/crm-api/.env extends the list without a deploy: comma-separated regular
// expressions (no flags, matched against the whole lower-cased address), read once at startup like every other
// setting in this file. One that does not compile is named at startup and ignored — a typo must not take the
// marketing list down with it.
const MARKETING_EXCLUDE_DOMAINS = ['example.com', 'example.org', 'example.net', 'example.co', 'test.com', 'test', 'invalid', 'localhost'];
const MARKETING_EXCLUDE_LOCAL_PREFIXES = ['smoke-', 'checkout-smoke', 'merge-smoke', 'vip-smoke', 'coupon-only', 'qa-cart', 'qa.test', 'qa-test', 'probe-', 'probe.', 'probe_', 'render-check', 'text-check'];
const MARKETING_EXCLUDE_ADDRESSES = new Set(['admin@biolabsresearch.co']);
const MARKETING_TEST_REF_RE = /^(PROBE|BF-SMOKE|BF-MERGE|BF-CIO-TEST|BF-RENDER|BF-TEXT|BF-QA)/i;
const MARKETING_EXCLUDE_PATTERNS = String(readEnvFile(ENV_FILE).MARKETING_EXCLUDE_PATTERNS || process.env.MARKETING_EXCLUDE_PATTERNS || '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(pattern => {
    try { return new RegExp(pattern); }
    catch (e) { console.error('[marketing] MARKETING_EXCLUDE_PATTERNS: ignoring ' + JSON.stringify(pattern) + ' — ' + e.message); return null; }
  })
  .filter(Boolean);
function isTestOrderRef(order) {
  return !!order && (order.test === true || MARKETING_TEST_REF_RE.test(String(order.ref || '')));
}
// rec is what the route has collected about this address: { real: it has an order that is not a test order,
// lead: its record in leads.json }. Called with rec undefined the address alone decides.
function isExcludedIdentity(email, rec) {
  const addr = trackEmail(email);
  const at = addr.lastIndexOf('@');
  if (at <= 0) return true;
  if (MARKETING_EXCLUDE_ADDRESSES.has(addr)) return true;
  const local = addr.slice(0, at), domain = addr.slice(at + 1);
  if (MARKETING_EXCLUDE_DOMAINS.some(d => domain === d || domain.endsWith('.' + d))) return true;
  if (MARKETING_EXCLUDE_LOCAL_PREFIXES.some(p => local.startsWith(p))) return true;
  if (MARKETING_EXCLUDE_PATTERNS.some(re => re.test(addr))) return true;
  // Test orders only, and no signup: a probe, not a customer. An order that was cancelled still makes a person —
  // the rule is about what wrote the record, not about whether the money ever arrived.
  if (rec && !rec.real && !rec.lead) return true;
  return false;
}
// Masked for the answer: the page says how many were left out and shows enough of an address to recognise a stand of
// one's own — never the whole address, which is the very thing that identifies a profile at the provider.
function maskIdentity(addr) {
  const s = String(addr || '');
  const at = s.lastIndexOf('@');
  if (at <= 0) return '***';
  const local = s.slice(0, at);
  return (local.length <= 2 ? local.slice(0, 1) : local.slice(0, 2)) + '***@' + s.slice(at + 1);
}

// Route handlers. Reached only through the gate below: public routes directly, everything else after isAuthorized().
function handleRequest(req, res) {
  const pathname = String(req.url || '').split('?')[0];

  // site-copy (2026-09-10): CRM-edited shop texts. Data and lib live in /opt/shop-content
  // (outside every docroot). Missing lib → 503 and Science keeps its hardcoded FAQ.
  if (siteCopyStore) {
    if (req.method === 'GET' && pathname === '/msolpeptides-api/site-copy') {
      const block = new URL(req.url, 'http://localhost').searchParams.get('block') || '';
      const out = req.crmAuthorized ? siteCopyStore.getAuth(block) : siteCopyStore.getPublic(block);
      jsonReply(res, out.status, out.body);
      return;
    }
    if (req.method === 'GET' && pathname === '/msolpeptides-api/site-copy/versions') {
      const block = new URL(req.url, 'http://localhost').searchParams.get('block') || '';
      const out = siteCopyStore.listVersions(block);
      jsonReply(res, out.status, out.body);
      return;
    }
    if (req.method === 'PUT' && pathname === '/msolpeptides-api/site-copy') {
      readBody(req, (err, data) => {
        if (err || !data || typeof data !== 'object' || Array.isArray(data)) { jsonReply(res, 400, { error: 'Invalid request' }); return; }
        const out = siteCopyStore.put(data, req.crmEmail || '');
        if (out.status === 200) logActivity('site-copy', 'Updated ' + String(data.block || ''), req.crmEmail || '', data.block);
        jsonReply(res, out.status, out.body);
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/msolpeptides-api/site-copy/restore') {
      readBody(req, (err, data) => {
        if (err || !data || typeof data !== 'object' || Array.isArray(data)) { jsonReply(res, 400, { error: 'Invalid request' }); return; }
        const out = siteCopyStore.restore(data.block, data.saved_at, req.crmEmail || '');
        if (out.status === 200) logActivity('site-copy', 'Restored ' + String(data.block || ''), req.crmEmail || '', data.block);
        jsonReply(res, out.status, out.body);
      });
      return;
    }
  }


  // GET products (public - filter sensitive fields). Phase 1 (2026-09-04): an authorized CRM caller (Bearer session or
  // X-Admin-Secret, checked by the gate below and flagged as req.crmAuthorized) gets the full records so Inventory can
  // edit and save them without losing cost / stock / supplier fields; everyone else still gets SAFE_FIELDS only.
  if (req.method === 'GET' && pathname === '/msolpeptides-api/products') {
    const products = readProducts();
    if (catalogUnreadable) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
    if (req.crmAuthorized) {
      res.setHeader('Cache-Control', 'private, no-store');   // full records must never be cached in front of the app
      res.setHeader('X-CRM-Fields', 'full');                  // Inventory refuses to edit without this marker
      const full = (Array.isArray(products) ? products : []).map(p => enrichProductPackFields(Object.assign({}, p)));
      jsonReply(res, 200, full);
      return;
    }
    const SAFE_FIELDS = ['id','name','slug','category','price','original_price','stock_status','is_active','badge','tagline','description','benefits','image_url','strengths','strengths_placeholder','strength_prices','strength_originals','pack_tiers','pack_tiers_by_strength','pack_formula'];
    const safe = (Array.isArray(products) ? products : []).filter(p => p.is_active !== false).map(p => {
      const enriched = enrichProductPackFields(Object.assign({}, p));
      const out = {};
      SAFE_FIELDS.forEach(f => { if (enriched[f] !== undefined) out[f] = enriched[f]; });
      return out;
    });
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(safe));
    return;
  }

  // POST products (save all). Phase 1 (2026-09-04): validated and merged on the server (see mergeCatalog) instead of
  // replacing the file with whatever the client sent.
  if (req.method === 'POST' && pathname === '/msolpeptides-api/products') {
    readBody(req, (err, incoming) => {
      if (err) { jsonReply(res, 400, {error:'Invalid JSON'}); return; }
      const invalid = validateCatalogPayload(incoming);
      if (invalid) { jsonReply(res, 400, {error: invalid}); return; }
      const existing = readProducts();
      if (catalogUnreadable) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
      const merged = mergeCatalog(existing, incoming);
      writeProducts(merged);
      jsonReply(res, 200, {ok:true, count: merged.length});
    });
    return;
  }

  // Phase 3 (2026-09-05): single-product routes for CRM Inventory (auth through the gate). PUT merges the sent fields into
  // the stored record — id and slug never change; an id nobody has creates the product (Inventory's "Add product" path,
  // 201). DELETE removes one product (404 if unknown). Both write products-data.json atomically through writeProducts;
  // the whole-list POST /products above stays for compatibility but Inventory no longer calls it.
  if ((req.method === 'PUT' || req.method === 'DELETE') && pathname.startsWith('/msolpeptides-api/products/')) {
    const id = idFromUrl(req, '/msolpeptides-api/products/');
    if (!id || id.length > 64 || id.includes('/')) { jsonReply(res, 400, {error:'Invalid product id'}); return; }
    if (req.method === 'DELETE') {
      const products = readProducts();
      if (catalogUnreadable) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
      const idx = findProductIndex(products, id);
      if (idx === -1) { jsonReply(res, 404, {error:'Product not found'}); return; }
      const remaining = products.filter((p, i) => i !== idx);
      if (remaining.length === 0) { jsonReply(res, 400, {error:'Refusing to empty the catalog'}); return; } // same floor as validateCatalogPayload
      writeProducts(remaining);
      console.log('[products] DELETE ' + id + ' (' + remaining.length + ' left)');
      jsonReply(res, 200, {ok:true, count: remaining.length});
      return;
    }
    readBody(req, (err, incoming) => {
      if (err) { jsonReply(res, 400, {error:'Invalid JSON'}); return; }
      const invalid = validateProductPayload(incoming);
      if (invalid) { jsonReply(res, 400, {error: invalid}); return; }
      const products = readProducts();
      if (catalogUnreadable) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
      const idx = findProductIndex(products, id);
      const patch = Object.assign({}, incoming);
      delete patch.id; delete patch.slug; // fixed by the URL / the stored record
      if (Object.keys(patch).length === 0) { jsonReply(res, 400, {error:'Nothing to update'}); return; }
      let saved, code;
      if (idx === -1) {
        if (products.some(p => p && p.slug === id)) { jsonReply(res, 409, {error:'Address this product by its id'}); return; } // slug of a record that has an id: no duplicates
        if (typeof incoming.name !== 'string' || !incoming.name.trim()) { jsonReply(res, 400, {error:'name is required for a new product'}); return; }
        const slug = typeof incoming.slug === 'string' && incoming.slug.trim() ? incoming.slug.trim() : '';
        if (slug && products.some(p => p && p.slug === slug)) { jsonReply(res, 409, {error:'A product with this slug already exists'}); return; }
        saved = Object.assign({ id }, slug ? { slug } : {}, patch);
        products.push(saved); code = 201;
      } else {
        saved = Object.assign({}, products[idx], patch);
        products[idx] = saved; code = 200;
      }
      writeProducts(products);
      console.log('[products] PUT ' + id + ' ' + (code === 201 ? 'created' : 'updated') + ' [' + Object.keys(patch).join(',') + ']');
      jsonReply(res, code, {ok:true, product: saved, count: products.length});
    });
    return;
  }

  // POST image upload
  if (req.method === 'POST' && pathname.startsWith('/msolpeptides-api/upload-image')) {
    const ct = req.headers['content-type'] || '';
    const boundaryMatch = ct.match(/boundary=([^\s;]+)/);
    if (!boundaryMatch) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400); res.end(JSON.stringify({error:'No boundary'})); return;
    }
    const boundary = boundaryMatch[1];
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks);
        const parts = parseMultipart(body, boundary);
        const file = parts['image'];
        const slug = parts['slug'] || 'product';
        if (!file || !file.data) {
          res.setHeader('Content-Type', 'application/json');
          res.writeHead(400); res.end(JSON.stringify({error:'No image'})); return;
        }
        // Phase 0 (2026-09-04): slug whitelist, extension whitelist by name AND magic bytes, path confined to product-images/
        if (!/^[a-z0-9-]{1,64}$/.test(slug)) {
          jsonReply(res, 400, {error:'Invalid slug (a-z, 0-9, dash, max 64)'}); return;
        }
        const ext = String(file.filename || '').split('.').pop().toLowerCase();
        const sniffed = sniffImageType(file.data);
        if (!['jpg', 'jpeg', 'png', 'webp', 'gif'].includes(ext) || !sniffed || (ext === 'jpg' ? 'jpeg' : ext) !== sniffed) {
          jsonReply(res, 400, {error:'Only jpg/jpeg/png/webp/gif images are accepted'}); return;
        }
        const fname = slug + '-' + Date.now() + '.' + ext;
        const fpath = path.join(IMAGES_DIR, fname);
        if (!fpath.startsWith(IMAGES_DIR + path.sep)) {
          jsonReply(res, 400, {error:'Invalid path'}); return;
        }
        // Phase 7 (2026-09-06): the catalog is read and gated BEFORE the image file is written - a broken
        // products-data.json used to leave an orphan image on disk and answer 200 with linked:false.
        const products = readProducts();
        if (catalogUnreadable) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
        fs.writeFileSync(fpath, file.data);
        // Phase 2 (2026-09-05): the shop (biolabsresearch.co) serves this folder as /product-images/ (docroot symlink), so that
        // is the stored path; the catalog record gets image_url through the atomic catalog write (the old saveProducts() never
        // existed, so image_url was silently never written). A catalog problem is reported, the upload itself still succeeds.
        const url = '/product-images/' + fname;
        let linked = false;
        try {
          const prod = products.find(p => p && (p.slug === slug || String(p.id) === slug));
          if (prod) {
            writeProducts(products.map(p => p === prod ? Object.assign({}, p, { image_url: url }) : p));
            linked = true;
          }
        } catch(e2) { console.error('[upload-image] image saved but catalog not updated:', e2.message); }
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ok:true, url, linked}));
      } catch(e) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(500); res.end(JSON.stringify({error: e.message}));
      }
    });
    return;
  }


  // POST /msolpeptides-api/notify-order — save order + send email notification

  // Phase 0 (2026-09-04): POST /msolpeptides-api/deploy-template removed (it rewrote the public product.html).


  if (req.method === 'GET' && pathname === '/msolpeptides-api/notify-order') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(405);
    res.end(JSON.stringify({ error: 'Method not allowed. Use POST.' }));
    return;
  }

  // Restock alerts (2026-09-30, services/restock/): the storefront's "notify me when it is back in stock".
  if (req.method === 'GET' && pathname === '/msolpeptides-api/stock-status') { restockReplyStatus(res); return; }
  if (req.method === 'GET' && pathname === '/msolpeptides-api/restock-unsubscribe') { restockReplyUnsubscribePage(req, res); return; }
  if (req.method === 'POST' && pathname === '/msolpeptides-api/restock-unsubscribe') { restockReplyUnsubscribe(req, res); return; }
  if (req.method === 'POST' && pathname === '/msolpeptides-api/restock-subscribe') {
    // JSON only: a plain HTML form on another site (text/plain, urlencoded, multipart) must not be able to subscribe anybody.
    if (restockContentType(req) !== 'application/json') { req.resume(); jsonReply(res, 415, {error:'Content-Type must be application/json'}); return; }
    readBody(req, (err, data) => {
      if (err) { jsonReply(res, 400, {error:'Invalid request'}); return; }
      restockReplySubscribe(req, res, data);
    });
    return;
  }
  if (req.method === 'POST' && pathname === '/msolpeptides-api/subscribe') {
    readBody(req, (err, data) => {
      if (err || !data || typeof data !== 'object' || Array.isArray(data)) { jsonReply(res, 400, {error:'Invalid subscription'}); return; }
      if (typeof data.email !== 'string' || data.email.length > 200 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim())) {
        jsonReply(res, 400, {error:'A valid email is required (max 200)'}); return;
      }
      for (const field of ['firstName', 'coupon', 'page', 'consent_text']) {
        if (data[field] !== undefined && typeof data[field] !== 'string') { jsonReply(res, 400, {error:field + ' must be a string'}); return; }
      }
      // M6 (2026-09-08): consent is recorded with the signup. A body with no flag at all counts as consent,
      // because this form is the act itself — somebody typed an address into "get the insider code" and
      // pressed the button — and because storefront copies cached before M6 send exactly that body (the js is
      // served with a ten minute cache): refusing them would turn a working form into a dead one for a while.
      // An explicit false is the one case that creates nothing: no lead, no profile in Customer.io, no event.
      if (data.marketing_consent !== undefined && typeof data.marketing_consent !== 'boolean') {
        jsonReply(res, 400, {error:'marketing_consent must be true or false'}); return;
      }
      if (data.marketing_consent === false) {
        jsonReply(res, 400, {error:'Marketing consent is required to join the insider list'}); return;
      }
      const consent = consentRecord(data.consent_text);
      const lead = {type:'insider-signup', email:data.email.trim(), firstName:cleanStr(data.firstName, 80), coupon:cleanStr(data.coupon, 40)};
      try {
        const result = upsertInsiderLead(lead, 'Insider signup', 'Page: ' + cleanStr(data.page, 1000), consent);
        if (!result || !result.ok) throw new Error('Lead was not saved');
        // Shop stage 3 (2026-09-07): the answer carries the token the storefront needs for /track, on a repeat signup as
        // well — that is how a second device gets its cart attached to the same person.
        const signupEmail = lead.email.toLowerCase();
        const answer = {ok:true, updated: !!result.updated};
        const token = trackTokenFor(signupEmail);
        if (token) answer.track_token = token;
        jsonReply(res, 200, answer);
        // Own try, after the answer: a throw on a finished response goes straight out of the handler (see notify-order).
        try {
          cioTrackWithProfile(signupEmail, 'subscribed', {
            coupon: mailSafe(lead.coupon) || undefined,
            page: mailSafe(cleanStr(data.page, 200)) || undefined,
            first_name: mailSafe(lead.firstName) || undefined
          }, null, {source: 'insider-signup', firstName: lead.firstName, coupon: lead.coupon, consent: consent});
        } catch (trackErr) { console.error('[cio-track] subscribed skipped: ' + ((trackErr && trackErr.message) || trackErr)); }
        // Infra 2026-09-22: the code letter comes from the Welcome journey (Customer.io campaign 4, on the `subscribed`
        // event sent above). The letter this handler also sent (sendInsiderWelcomeEmail, added 2026-09-09) reached the
        // subscriber a second before it with the same code, so it was removed together with its last_email_sent_at
        // stamp (the CRM loads that field but shows it nowhere). The old code is in the git history of this file.
      } catch (e) {
        console.error('[subscribe] lead could not be saved');
        jsonReply(res, 500, {error:'Could not subscribe, please try again'});
      }
    });
    return;
  }

  // Shop stage 3 (2026-09-07): cart events from the browser. The route is public of necessity, so the address is not
  // taken from the request at all — it comes out of a token this server signed in /subscribe, and a failed check is 400
  // with nothing leaving the machine. The 8 KB body limit is applied before a byte is read, by the gate at the bottom of
  // the file (bodyLimitFor): it answers 413 and drains the socket instead of collecting the body in memory.
  if (req.method === 'GET' && pathname === '/msolpeptides-api/track') {
    jsonReply(res, 405, { error: 'Method not allowed. Use POST.' });
    return;
  }

  if (req.method === 'POST' && pathname === '/msolpeptides-api/track') {
    if (!CIO_TRACK_TOKEN_SECRET) { req.resume(); jsonReply(res, 503, {error:'Event tracking is not configured'}); return; }
    readBody(req, (err, data) => {
      if (err || !data || typeof data !== 'object' || Array.isArray(data)) { jsonReply(res, 400, {error:'Invalid event'}); return; }
      const email = emailFromTrackToken(data.token);
      if (!email) { jsonReply(res, 400, {error:'Invalid token'}); return; }
      const name = typeof data.event === 'string' ? data.event.trim() : '';
      if (!TRACK_EVENTS.includes(name)) { jsonReply(res, 400, {error:'Unknown event'}); return; }
      const payload = trackEventData(data.data);
      jsonReply(res, 200, {ok: true});
      // Own try, after the answer, for the same reason as the order emails below.
      try { cioTrackCart(email, name, payload); } catch (trackErr) { console.error('[cio-track] ' + name + ' skipped: ' + ((trackErr && trackErr.message) || trackErr)); }
    });
    return;
  }

  // Coupon quote (2026-09-07): the checkout page has a coupon field and no Apply button, so nothing ever told the
  // customer what INSIDER25 does — the storefront could not know, because the discount is worked out here. This route
  // answers that one question and nothing else: it reads the catalog, runs the same priceCheck + discountFields the
  // order path runs, and returns the figures. The rules stay in one place on purpose — a copy in the browser would
  // drift away from this one the first time a code or a tier changes. Nothing is written, no mail, no events.
  if (req.method === 'GET' && pathname === '/msolpeptides-api/coupon-quote') {
    jsonReply(res, 405, { error: 'Method not allowed. Use POST.' });
    return;
  }

  if (req.method === 'POST' && pathname === '/msolpeptides-api/coupon-quote') {
    readBody(req, (err, data) => {
      if (err || !data || typeof data !== 'object' || Array.isArray(data)) { jsonReply(res, 400, { error: 'Invalid request' }); return; }
      const coupon = (data.coupon === undefined || data.coupon === null) ? '' : data.coupon;
      if (typeof coupon !== 'string' || coupon.length > 40) { jsonReply(res, 400, { error: 'coupon must be a string (max 40)' }); return; }
      if (!Array.isArray(data.items) || !data.items.length) { jsonReply(res, 400, { error: 'items must be a non-empty array' }); return; }
      // Same validator the order path uses: quantities, prices and shipping are checked by one set of rules.
      const invalid = validateNotifyOrder({ orderData: { items: data.items, shippingCost: data.shippingCost } });
      if (invalid) { jsonReply(res, 400, { error: invalid.replace('orderData.', '') }); return; }
      // Через sanitizeOrder, а не своим map: заказ оценивается именно им, и ручная сборка
      // расходилась с ним на мелочах — slug с хвостовым пробелом обнулял сумму, а доставка,
      // присланная как shipping.cost (форма заказа), в котировке терялась.
      const order = sanitizeOrder({ items: data.items, coupon, shippingCost: data.shippingCost, shipping: data.shipping }, null);
      const check = priceCheck(order);
      // Catalog unreadable: there is no base to price against, and a guess here would be a number the customer reads
      // as a promise. 503 is the same answer the catalog writers give in that state.
      if (!check || check.price_check === 'skipped') { jsonReply(res, 503, { error: 'Catalog unavailable' }); return; }
      const disc = discountFields(order, check);
      const code = coupon.trim().toUpperCase();
      const shippingCents = Math.round(Number(check.total_server) * 100) - Math.round(Number(check.subtotal_server) * 100);
      const reply = {
        ok: true,
        coupon: code,
        // Straight from the table, not inferred from discount_source: a code is still a valid code when the cart is
        // empty of priced items and the percentage comes out zero.
        recognized: Object.prototype.hasOwnProperty.call(COUPONS, code),
        subtotal: check.subtotal_server,
        shipping: (shippingCents / 100).toFixed(2),
        discount: disc.discount_server || '0.00',
        discount_pct: disc.discount_pct_server || 0,
        discount_source: disc.discount_source || 'none',
        total_due: disc.total_due_server || check.total_server,
        price_mismatch: check.price_mismatch === true
      };
      if (check.unknown_items) reply.unknown_items = check.unknown_items;
      jsonReply(res, 200, reply);
    });
    return;
  }

  // Shop stage 3 (2026-09-07, owner's decision): the address typed on the checkout page. It hands the browser the same
  // token /subscribe does and writes the person into Customer.io — and nothing else. No event (once it has the token the
  // browser sends checkout_started itself, through /track) and no lead: a lead is still born when the order is sent.
  if (req.method === 'GET' && pathname === '/msolpeptides-api/checkout-identify') {
    jsonReply(res, 405, { error: 'Method not allowed. Use POST.' });
    return;
  }

  if (req.method === 'POST' && pathname === '/msolpeptides-api/checkout-identify') {
    readBody(req, (err, data) => {
      if (err || !data || typeof data !== 'object' || Array.isArray(data)) { jsonReply(res, 400, {error:'Invalid request'}); return; }
      // Stricter than /subscribe on purpose: /subscribe hands the address to cioTrackWithProfile, which checks it with
      // looksLikeEmail before anything leaves; this route calls identify directly, so the same check has to stand here.
      // Without it a string like <b>@x.co passes the plain regexp and becomes the identifier of a profile.
      if (!looksLikeEmail(data.email)) {
        jsonReply(res, 400, {error:'A valid email is required (max 200)'}); return;
      }
      if (data.firstName !== undefined && typeof data.firstName !== 'string') { jsonReply(res, 400, {error:'firstName must be a string'}); return; }
      const addr = data.email.trim().toLowerCase();
      const answer = {ok: true};
      const token = trackTokenFor(addr);             // no signing secret: still 200, simply without a token
      if (token) answer.track_token = token;
      jsonReply(res, 200, answer);
      // Own try, after the answer, as everywhere else on this path.
      try {
        if (CIO_TRACK_READY) {                       // no Track keys: not one request, and orders.json is not even read
          // No source at all. The address may well belong to a subscriber already, and saying "came from checkout" would
          // move that person out of the subscriber segment; what marks them here is checkout_email_at. page is accepted
          // (the storefront sends the same body shape as /subscribe) and goes nowhere — identify carries only §2.
          const attrs = orderAttributesFor(addr, {firstName: data.firstName});
          attrs.checkout_email_at = new Date().toISOString();
          cioTrackIdentify(addr, attrs);
        }
      } catch (trackErr) { console.error('[cio-track] checkout identify skipped: ' + ((trackErr && trackErr.message) || trackErr)); }
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/msolpeptides-api/notify-order') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      let ref;
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const invalid = validateNotifyOrder(data);
        if (invalid) { jsonReply(res, 400, {error: invalid}); return; }
        const { subject, body, orderData, paymentMethod } = data;
        const signup = isInsiderSignup(orderData, subject);
        // Shop stage 0 (2026-09-06): only known fields are stored (sanitizeOrder), a resent ref — retry after a network
        // error, double click — does not create a second record (that is where the duplicate BF-… orders came from), the
        // catalog price is checked and stored next to the browser's figures, and insider signups become leads only:
        // they are not orders and used to clutter orders.json.
        const clean = sanitizeOrder(orderData, paymentMethod);
        ref = clean.ref;
        // Stage 1 RET (2026-09-30): the server, not the page, says this order came from the shop (letterAllowed needs it);
        // a test flag from the page only ever removes letters.
        clean.channel = 'shop';
        if (orderData && orderData.test === true) clean.test = true;
        // Card import (2026-09-27): ref prefix reserved (notify-order) — same reservation as the anonymous POST
        // /orders check further down: an anonymous caller taking a BLR-/QT- ref first would make the import skip
        // the real payment as "already there".
        if (ref && /^(BLR|QT)-/i.test(ref)) { jsonReply(res, 400, {error: 'ref prefix reserved'}); return; }
        let placedOrders = null;   // shop stage 3: the array the order was written into, so the attribute recount reads no file twice
        if (!signup) {
          const ordersFile = path.join(__dirname, 'orders.json');
          const orders = readJsonOrFallback(ordersFile, []);
          if (ref && orders.some(o => o && o.ref === ref)) { jsonReply(res, 200, { ok: true, ref, duplicate: true }); return; }
          const check = priceCheck(clean);
          Object.assign(clean, check, discountFields(clean, check));   // shop stage 2
          orders.unshift(clean);
          writeJsonAtomic(ordersFile, orders);
          placedOrders = orders;
        }

        // VIP/exit-intent Insider signup + checkout inquiry -> CRM lead (must not fail notify)
        try {
          upsertInsiderLead(orderData || {}, subject, body);
        } catch (crmErr) {
          console.error('[crm-leads] insider upsert failed:', crmErr && crmErr.message);
        }
        try {
          upsertCheckoutLead(orderData || {}, subject, body, paymentMethod);
        } catch (crmErr2) {
          console.error('[crm-leads] checkout upsert failed:', crmErr2 && crmErr2.message);
        }

        // Shop stage 2 (2026-09-06): the sendmail call that used to stand here is gone — there is no MTA on this server and
        // it delivered nothing to anyone; the notification now goes through the Customer.io Transactional API instead.
        // The customer is answered first, on purpose: a slow or broken provider must never cost anyone their order.
        jsonReply(res, 200, { ok: true, ref });
        if (!signup) {
          // Deliberately its own try: a throw after the answer has been sent would land in the catch below, and jsonReply
          // on a finished response throws again — straight out of the handler and into a pm2 restart.
          try { if (mailOutbox && clean.ref) { mailOutbox.enqueue('mail_manager', clean.ref); orderLettersConfirm(clean); } else sendOrderEmails(clean); } catch (mailErr) { console.error('[cio] order emails skipped:', (mailErr && mailErr.message) || mailErr); }
          // Shop stage 3 (2026-09-07): the event does not depend on the letters — a shop with no templates configured
          // still needs its automations to learn that an order happened. A repeated ref returned above, so this runs
          // once per stored order.
          try { if (mailOutbox && clean.ref) mailOutbox.enqueue('cio_order_placed', clean.ref); else cioTrackWithProfile(clean.customer && clean.customer.email, 'order_placed', orderPlacedData(clean), clean.ref, {orders: placedOrders, source: 'order', cartCleared: true}); }
          catch (trackErr) { console.error('[cio-track] order_placed skipped: ' + ((trackErr && trackErr.message) || trackErr)); }
          tgAlertsOnCreated(clean);   // tg-alerts: the team's Telegram group hears about the order
        }
      } catch(e) {
        // Shop stage 0 (2026-09-06): the request body is no longer written to the log — it carries name, phone and address.
        console.error('[notify-order] failed:', (e && e.message) || e, 'ref:', ref || '(none)');
        jsonReply(res, 500, { error: 'Could not save the order, please try again' });
      }
    });
    return;
  }


  // GET /msolpeptides-api/messages — list all contact messages
  if (req.method === 'GET' && pathname === '/msolpeptides-api/messages') {
    const messagesFile = path.join(__dirname, 'messages.json');
    let messages = [];
    try { messages = JSON.parse(fs.readFileSync(messagesFile, 'utf8')); } catch(e) {}
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(messages));
    return;
  }

  // POST /msolpeptides-api/contact — save contact form submission
  if (req.method === 'POST' && pathname === '/msolpeptides-api/contact') {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const data = JSON.parse(Buffer.concat(chunks).toString());
        const { firstName, lastName, email, org, subject, message } = data;
        if (!email || !message) {
          res.writeHead(400); res.end(JSON.stringify({error:'Missing required fields'})); return;
        }
        const messagesFile = path.join(__dirname, 'messages.json');
        const messages = readJsonOrFallback(messagesFile, []);
        const newMsg = {
          id: Date.now().toString(),
          firstName, lastName, email, org, subject, message,
          status: 'unread',
          receivedAt: new Date().toISOString()
        };
        messages.unshift(newMsg);
        writeJsonAtomic(messagesFile, messages);
        tgContactQueue(newMsg);   // tg-alerts: the team's Telegram group hears about the message
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, id: newMsg.id }));
      } catch(e) {
        console.error('[contact] failed:', e && e.stack || e);
        res.writeHead(500); res.end(JSON.stringify({ error: 'Could not save the message, please try again' }));
      }
    });
    return;
  }

  // PATCH /msolpeptides-api/messages/:id — mark as read
  if (req.method === 'PATCH' && pathname.startsWith('/msolpeptides-api/messages/')) {
    const msgId = pathname.split('/').pop();
    const messagesFile = path.join(__dirname, 'messages.json');
    const messages = readJsonOrFallback(messagesFile, []);
    const msg = messages.find(m => m.id === msgId);
    if (msg) { msg.status = 'read'; writeJsonAtomic(messagesFile, messages); }
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ===== ORDERS ROUTES =====
  const ORDERS_FILE = path.join(__dirname, 'orders.json');
  function loadOrders() {
    return readJsonOrFallback(ORDERS_FILE, []);
  }
  function saveOrdersData(orders) {
    writeJsonAtomic(ORDERS_FILE, orders);
  }
  // Phase 4 (2026-09-05): the next MS-NNN for an order the caller sent no ref for. The highest number already used as a
  // ref or an id (either case) plus one, three digits with leading zeros; past 999 the number simply gets longer.
  // Review P: the route is public, so a stored ref like "MS-99999999999999999999" must not poison the counter — numbers
  // that are not safe integers or exceed 999999 are ignored, and the issued ref is bumped until it is unused.
  function nextManualRef(orders) {
    const list = Array.isArray(orders) ? orders : [];
    let max = 0;
    list.forEach(o => {
      if (!o || typeof o !== 'object') return;
      [o.ref, o.id].forEach(v => {
        const m = typeof v === 'string' ? v.match(/^MS-(\d+)$/i) : null;
        if (!m) return;
        const n = parseInt(m[1], 10);
        if (!Number.isSafeInteger(n) || n > 999999) return;
        if (n > max) max = n;
      });
    });
    let n = max + 1, ref = 'MS-' + String(n).padStart(3, '0');
    while (list.some(o => o && o.ref === ref)) { n++; ref = 'MS-' + String(n).padStart(3, '0'); }
    return ref;
  }

  // GET /msolpeptides-api/marketing/profiles — M2 (2026-09-08): the same attributes that identify sends to
  // Customer.io, for every address the shop knows, so a CRM segment and a Customer.io filter can talk about the
  // same person. Read-only: nothing here writes a file and nothing here calls the provider.
  //
  // Counted by orderAttributesFor() itself — the function the order path already uses — rather than by a second
  // implementation next to it: two counters of "how much has this person spent" drift apart within a week, and the
  // whole point of the segment is that CRM and Customer.io agree. Three fields it does not produce are added here:
  //   first_order_at   the oldest order of that address (identify only ever needed the newest)
  //   subscribed       lead exists in leads.json and is not marked unsubscribed (Customer.io owns the real opt-out
  //                    flag; this is the CRM's own list, which is what the CRM can segment on). "Not marked" is
  //                    truthiness, the same test leads-store.cjs applies: that file carries "true", 1 and "yes"
  //                    as well as booleans, and reading any of those as "still subscribed" would put someone who
  //                    opted out into a campaign.
  //   lead_created_at  when the lead was created
  // coupon falls back to the lead's coupon when the last order carried none.
  //
  // Test and service identities are not in the answer at all (isExcludedIdentity, above the request handler): the
  // list is what the first sync writes to Customer.io as profiles, and a smoke order of a phase must not become one.
  // How many were left out travels with the answer as excluded {count, sample} — masked, and never more than five.
  //
  // orders.json is read once for the whole answer and handed to orderAttributesFor via opts.orders, so N addresses
  // cost one file read, not N. An unreadable file answers 503 — an empty list would read as "nobody ordered anything"
  // and every segment would quietly empty itself in Customer.io on the next sync. A file that is simply not there yet
  // is not an error (the same rule readJsonOrFallback follows everywhere else in this file).
  if (req.method === 'GET' && pathname === '/msolpeptides-api/marketing/profiles') {
    let orders, leads;
    try {
      orders = readJsonOrFallback(TRACK_ORDERS_FILE, []);
      if (!Array.isArray(orders)) throw new Error('orders.json is not an array');
    } catch (e) {
      console.error('[marketing] orders.json unreadable:', e.message);
      jsonReply(res, 503, {error:'Order history temporarily unavailable'});
      return;
    }
    try {
      leads = readJsonOrFallback(CRM_LEADS_FILE, []);
      if (!Array.isArray(leads)) throw new Error('leads.json is not an array');
    } catch (e) {
      console.error('[marketing] leads.json unreadable:', e.message);
      jsonReply(res, 503, {error:'Lead list temporarily unavailable'});
      return;
    }
    // M2b: every attribute below is counted over realOrders — the same list without the test orders of the phases'
    // stands (isTestOrderRef). The full list is still walked here, so an address that only ever placed a test order
    // is met, recognised and counted among the excluded rather than silently missing.
    const realOrders = orders.filter(o => o && typeof o === 'object' && !isTestOrderRef(o));
    const byEmail = new Map();   // normalized address -> { first: oldest real order, lead, real: has an order of its own }
    for (const ord of orders) {
      if (!ord || typeof ord !== 'object') continue;
      // looksLikeEmail, not merely "not empty": orders.json and leads.json are both edited by hand and imported
      // from spreadsheets, and a row with "n/a" in the address column would otherwise become a person in the CRM
      // — and a member Customer.io could never be told about.
      const addr = trackEmail(ord.customer && ord.customer.email);
      if (!addr || !looksLikeEmail(addr)) continue;
      const rec = byEmail.get(addr) || { first: '', lead: null, real: false };
      if (!isTestOrderRef(ord)) {
        rec.real = true;
        // Cancelled orders count for nothing here either — orderAttributesFor skips them, and first_order_at has to
        // agree with orders_count, or "first order more than 90 days ago" would fire for a customer who has none.
        if (String(ord.status || '').trim().toLowerCase() !== 'cancelled') {
          const stamp = orderStamp(ord);
          if (stamp && (!rec.first || stamp < rec.first)) rec.first = stamp;
        }
      }
      byEmail.set(addr, rec);
    }
    for (const lead of leads) {
      if (!lead || typeof lead !== 'object') continue;
      const addr = trackEmail(lead.email);
      if (!addr || !looksLikeEmail(addr)) continue;
      const rec = byEmail.get(addr) || { first: '', lead: null, real: false };
      // Two leads with the same address (the file is edited by hand and imported from Sheets): the older record wins
      // the created_at, the newer one wins the flags — same as reading them in file order and keeping the earliest date.
      if (!rec.lead) rec.lead = lead;
      else {
        const prev = String(rec.lead.created_at || ''), now = String(lead.created_at || '');
        if (now && (!prev || now < prev)) rec.lead = Object.assign({}, lead, { unsubscribed: rec.lead.unsubscribed || lead.unsubscribed });
        else rec.lead = Object.assign({}, rec.lead, { unsubscribed: rec.lead.unsubscribed || lead.unsubscribed });
      }
      byEmail.set(addr, rec);
    }
    const profiles = [];
    const excludedList = [];
    for (const [addr, rec] of byEmail) {
      if (isExcludedIdentity(addr, rec)) { excludedList.push(addr); continue; }
      const attrs = orderAttributesFor(addr, { orders: realOrders }) || { email: addr };
      if (rec.first) attrs.first_order_at = mailSafe(cleanStr(rec.first, 40));
      attrs.subscribed = !!rec.lead && !rec.lead.unsubscribed;
      if (rec.lead) {
        if (!attrs.coupon && rec.lead.coupon) attrs.coupon = mailSafe(cleanStr(rec.lead.coupon, 40));
        if (rec.lead.created_at) attrs.lead_created_at = mailSafe(cleanStr(rec.lead.created_at, 40));
        if (!attrs.country && rec.lead.country) attrs.country = mailSafe(cleanStr(rec.lead.country, 80));
      }
      profiles.push(attrs);
    }
    res.setHeader('Cache-Control', 'private, no-store');   // addresses of every customer: never cached in front of the app
    const answer = {
      profiles: profiles, count: profiles.length,
      excluded: { count: excludedList.length, sample: excludedList.slice(0, 5).map(maskIdentity) },
      computed_at: new Date().toISOString()
    };
    // ?summary=1 — the two numbers without the list. The list is every customer the shop has; the CRM page prints
    // "N excluded" and has no business pulling all of it into a browser to do so. Anything else, the segment module
    // included, asks without the parameter and gets the answer it has always got, with excluded added to it.
    if (/(^|&)summary=1(&|$)/.test(String(req.url || '').split('?')[1] || '')) delete answer.profiles;
    jsonReply(res, 200, answer);
    return;
  }

  // GET /msolpeptides-api/orders
  if (req.method === 'GET' && pathname === '/msolpeptides-api/orders') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(loadOrders()));
    return;
  }

  // POST /msolpeptides-api/orders — Phase 4 (2026-09-05): the server issues the ref (MS-NNN) when the caller sends none,
  // a ref that is already stored is answered without a second record (a re-clicked Save or a retried request), and
  // created_at is stamped. Callers: orders.html (manual orders). The storefront checkout goes through notify-order and
  // the nginx of biolabsresearch.co does not proxy /orders, so notify-order is left alone.
  // Concurrency: readBody -> end -> loadOrders -> nextManualRef -> saveOrdersData run in one synchronous stretch with no
  // await in between, so Node serialises parallel requests by itself and two of them cannot pick the same number.
  if (req.method === 'POST' && pathname === '/msolpeptides-api/orders') {
    readBody(req, (err, orderData) => {
      if (err) { jsonReply(res, 400, {error:'Invalid JSON'}); return; }
      if (!orderData || typeof orderData !== 'object' || Array.isArray(orderData)) { jsonReply(res, 400, {error:'Body must be a JSON object'}); return; }
      let ref;
      if (orderData.ref !== undefined && orderData.ref !== null) {
        if (typeof orderData.ref !== 'string') { jsonReply(res, 400, {error:'ref must be a string (max 64)'}); return; }
        ref = orderData.ref.trim();
        if (ref.length > 64) { jsonReply(res, 400, {error:'ref must be a string (max 64)'}); return; }
        if (ref === '') ref = undefined;   // whitespace-only ref counts as none
        else if (!/^[A-Za-z0-9._-]+$/.test(ref)) { jsonReply(res, 400, {error:'ref may contain only letters, digits, . _ -'}); return; } // review P: keeps the log and the file clean
      }
      // Card import (2026-09-27): BLR-/QT- refs belong to the payment module's records (services/card-import); an
      // anonymous caller taking one first would make the import skip the real payment as "already there".
      if (ref !== undefined && !req.crmAuthorized && /^(BLR|QT)-/i.test(ref)) { jsonReply(res, 400, {error: 'ref prefix reserved'}); return; }
      // Crypto import (2026-09-30): CR- numbers are issued by the payment module; only notify-order (the storefront) takes one from a page.
      if (ref !== undefined && !req.crmAuthorized && /^CR-/i.test(ref)) { jsonReply(res, 400, {error: 'ref prefix reserved'}); return; }
      if (ref === undefined && !req.crmAuthorized) {
        // ORDERS_PUBLIC = yes: an anonymous caller keeps the old contract (its own ref is required); a CRM session that
        // turned out invalid is answered 401 like every protected route, so the page goes back to the login form.
        const sentCredentials = !!(req.headers['authorization'] || req.headers['x-admin-secret']);
        jsonReply(res, sentCredentials ? 401 : 400, {error: sentCredentials ? 'Unauthorized' : 'Missing order data'}); return;
      }
      const orders = loadOrders();
      if (ref !== undefined && orders.some(o => o && o.ref === ref)) {
        // idempotent: the record is already there. The duplicate flag is for the CRM page only — to an anonymous caller
        // it would be an oracle telling whether a given storefront ref exists (review P).
        jsonReply(res, 200, req.crmAuthorized ? {ok: true, id: ref, duplicate: true} : {ok: true, id: ref}); return;
      }
      const issued = ref === undefined;
      if (issued) ref = nextManualRef(orders);
      // Public route: an anonymous body used to be stored as sent, so payments/edits/
      // original/server totals would have been accepted the moment the card started
      // showing them. Strip those keys for every caller; a CRM session then runs the
      // same quoted-price path as PATCH.
      const order = stripForgedOrderFields(Object.assign({}, orderData, {ref: ref}));
      // Card import (2026-09-27): an anonymous order used to keep the status it sent, "paid" included, and CRM counted
      // it as money received. Only a CRM session sets a status on this route.
      if (!req.crmAuthorized) delete order.status;
      if (req.crmAuthorized) {
        if (order.customer && typeof order.customer === 'object' && !Array.isArray(order.customer)) {
          const c = {
            firstName: cleanStr(order.customer.firstName, 80),
            lastName: cleanStr(order.customer.lastName, 80),
            email: cleanStr(order.customer.email, 200),
            phone: cleanStr(order.customer.phone, 40),
            company: cleanStr(order.customer.company, 120)
          };
          order.customer = c;
        }
        if (order.items !== undefined) {
          const parsed = parseCrmItems(order.items);
          if (parsed.skipped) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
          if (parsed.error) { jsonReply(res, 400, {error: parsed.error}); return; }
          order.items = parsed.items;
        }
        if (order.shipping && typeof order.shipping === 'object' && !Array.isArray(order.shipping)) {
          const shipErr = mergeShippingPatch(order, order.shipping);
          if (shipErr) { jsonReply(res, 400, {error: shipErr}); return; }
        }
        if (order.coupon !== undefined) order.coupon = cleanStr(order.coupon, 40);
        if (order.managerNote !== undefined) {
          if (typeof order.managerNote !== 'string' || order.managerNote.length > 2000) {
            jsonReply(res, 400, {error:'managerNote must be a string (max 2000)'}); return;
          }
          order.managerNote = cleanStr(order.managerNote, 2000);
        }
        if (Array.isArray(order.items) && order.items.length) {
          const money = applyCrmMoney(order);
          if (money.skipped) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
        }
      }
      if (!order.created_at) order.created_at = new Date().toISOString();
      orders.push(order);
      saveOrdersData(orders);
      console.log('[orders] POST ' + ref + (issued ? ' (server ref)' : ''));
      jsonReply(res, 200, {ok: true, id: ref});
    });
    return;
  }


  // CRM order edit (2026-09-18): payment and dedupe routes sit above PATCH/DELETE
  // /orders/:ref because those match on startsWith and would swallow
  // DELETE .../payments/:id (pop() = payment id, filter matches nothing, 200 no-op).
  const ORDER_PAY_RE = /^\/msolpeptides-api\/orders\/([^/]+)\/payments(?:\/([^/]+))?$/;
  const ORDER_DEDUPE_RE = /^\/msolpeptides-api\/orders\/([^/]+)\/dedupe$/;

  if (req.method === 'POST' && ORDER_DEDUPE_RE.test(pathname)) {
    const ref = decodePathPart(pathname.match(ORDER_DEDUPE_RE)[1]);
    const orders = loadOrders();
    const copies = orders.filter(o => o && typeof o.ref === 'string' && o.ref === ref);
    if (!copies.length) { jsonReply(res, 404, {error:'Order not found'}); return; }
    const keep = copies[0];
    const removed = copies.length - 1;
    if (removed > 0) {
      ensureOriginal(keep);
      const before = { toPay: moneyDue(keep), items: Array.isArray(keep.items) ? keep.items.length : 0 };
      const removedRecords = mergeDedupeKeep(keep, copies);
      const next = [];
      let kept = false;
      for (const o of orders) {
        if (o && typeof o.ref === 'string' && o.ref === ref) {
          if (!kept) { next.push(o); kept = true; }
        } else next.push(o);
      }
      keep.updated_at = new Date().toISOString();
      pushOrderEdit(keep, req, ['dedupe'], before);
      if (keep.edits && keep.edits.length) keep.edits[keep.edits.length - 1].removedRecords = removedRecords;
      saveOrdersData(next);
      try { logActivity('order_dedupe', 'Removed ' + removed + ' duplicate(s) of ' + ref, crmActor(req), ref); }
      catch (e) { console.error('[orders] dedupe activity:', e && e.message); }
      jsonReply(res, 200, {ok: true, removed: removed, order: keep, removedRecords: removedRecords});
    } else {
      jsonReply(res, 200, {ok: true, removed: 0, order: keep});
    }
    return;
  }

  if ((req.method === 'POST' || req.method === 'DELETE') && ORDER_PAY_RE.test(pathname)) {
    const pm = pathname.match(ORDER_PAY_RE);
    const ref = decodePathPart(pm[1]);
    const payId = pm[2] !== undefined ? decodePathPart(pm[2]) : '';
    if (req.method === 'POST') {
      if (payId) { jsonReply(res, 400, {error:'POST payments does not take an id in the path'}); return; }
      readBody(req, (err, body) => {
        if (err) { jsonReply(res, 400, {error:'Invalid JSON'}); return; }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { jsonReply(res, 400, {error:'Body must be a JSON object'}); return; }
        const kind = typeof body.kind === 'string' ? body.kind.trim() : '';
        if (kind !== 'payment' && kind !== 'refund') { jsonReply(res, 400, {error:'kind must be payment or refund'}); return; }
        const amount = asMoney(body.amount);
        if (!Number.isFinite(amount) || amount <= 0 || amount > 1e6) { jsonReply(res, 400, {error:'amount must be a number > 0 and <= 1000000'}); return; }
        if (body.method !== undefined && (typeof body.method !== 'string' || body.method.length > 40)) { jsonReply(res, 400, {error:'method must be a string (max 40)'}); return; }
        if (body.note !== undefined && (typeof body.note !== 'string' || body.note.length > 500)) { jsonReply(res, 400, {error:'note must be a string (max 500)'}); return; }
        if (body.id !== undefined && (typeof body.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(body.id))) { jsonReply(res, 400, {error:'id may contain only letters, digits, . _ -'}); return; }
        const at = parseIsoStamp(body.at);
        if (!at) { jsonReply(res, 400, {error:'at must be an ISO date'}); return; }
        const orders = loadOrders();
        const copies = orderCopies(orders, ref);
        if (!copies) { jsonReply(res, 404, {error:'Order not found'}); return; }
        if (copies > 1) { jsonReply(res, 409, {error:'Order ref is stored more than once', copies: copies}); return; }
        const order = findOrder(orders, ref);
        if (!Array.isArray(order.payments)) order.payments = [];
        const id = body.id || ('pay-' + crypto.randomBytes(4).toString('hex'));
        const existing = order.payments.find(p => p && p.id === id);
        if (existing) { jsonReply(res, 200, {ok: true, id: existing.id, order: order}); return; }
        if (order.payments.length >= 50) { jsonReply(res, 400, {error:'Too many payments (max 50)'}); return; }
        ensureOriginal(order);
        const before = { toPay: moneyDue(order), items: Array.isArray(order.items) ? order.items.length : 0 };
        const rec = {
          id: id,
          at: at,
          kind: kind,
          method: cleanStr(body.method, 40),
          amount: Number(amount.toFixed(2)),
          by: crmActor(req)
        };
        if (body.note !== undefined) rec.note = cleanStr(body.note, 500);
        order.payments.push(rec);
        order.updated_at = new Date().toISOString();
        pushOrderEdit(order, req, ['payments'], before);
        saveOrdersData(orders);
        try { logActivity('order_payment', kind + ' ' + rec.amount + ' on ' + ref, rec.by, ref); }
        catch (e) { console.error('[orders] payment activity:', e && e.message); }
        jsonReply(res, 200, {ok: true, id: id, order: order});
      });
      return;
    }
    // DELETE .../payments/:id
    if (!payId) { jsonReply(res, 400, {error:'payment id required'}); return; }
    const orders = loadOrders();
    const copies = orderCopies(orders, ref);
    if (!copies) { jsonReply(res, 404, {error:'Order not found'}); return; }
    if (copies > 1) { jsonReply(res, 409, {error:'Order ref is stored more than once', copies: copies}); return; }
    const order = findOrder(orders, ref);
    const list = Array.isArray(order.payments) ? order.payments : [];
    const idx = list.findIndex(p => p && p.id === payId);
    if (idx < 0) { jsonReply(res, 404, {error:'Payment not found'}); return; }
    ensureOriginal(order);
    const before = { toPay: moneyDue(order), items: Array.isArray(order.items) ? order.items.length : 0 };
    list.splice(idx, 1);
    order.payments = list;
    order.updated_at = new Date().toISOString();
    pushOrderEdit(order, req, ['payments'], before);
    saveOrdersData(orders);
    try { logActivity('order_payment', 'deleted ' + payId + ' on ' + ref, crmActor(req), ref); }
    catch (e) { console.error('[orders] payment activity:', e && e.message); }
    jsonReply(res, 200, {ok: true, order: order});
    return;
  }

  // PATCH /msolpeptides-api/orders/:ref — status (as of phase 3) plus CRM content
  // (items/customer/shipping/coupon/managerNote). sanitizeOrder is not applied: it
  // builds a new object and would drop status, created_at, tracking, edits, payments,
  // original, and rewrite savedAt, sliding a July order to the top of the list.
  if (req.method === 'PATCH' && pathname.startsWith('/msolpeptides-api/orders/')) {
    if (ORDER_PAY_RE.test(pathname) || ORDER_DEDUPE_RE.test(pathname) || pathname.slice('/msolpeptides-api/orders/'.length).includes('/')) {
      jsonReply(res, 404, {error:'Order not found'}); return;
    }
    const orderId = idFromUrl(req, '/msolpeptides-api/orders/');
    readBody(req, (err, update) => {
      if (err) { jsonReply(res, 400, {error:'Invalid JSON'}); return; }
      if (!update || typeof update !== 'object' || Array.isArray(update)) { jsonReply(res, 400, {error:'Body must be a JSON object'}); return; }
      const status = typeof update.status === 'string' ? update.status.trim().toLowerCase() : undefined;
      if (update.status !== undefined && (status === undefined || !ORDER_STATUSES.includes(status))) {
        jsonReply(res, 400, {error:'status must be one of ' + ORDER_STATUSES.join(', ')}); return;
      }
      for (const k of ['trackingNumber', 'notes']) {
        if (update[k] !== undefined && (typeof update[k] !== 'string' || update[k].length > 500)) { jsonReply(res, 400, {error: k + ' must be a string (max 500)'}); return; }
      }
      // Stage 1 RET: the carrier is one of a fixed list (its tracking link is built from it); empty leaves it unset.
      if (update.carrier !== undefined && (typeof update.carrier !== 'string' || (update.carrier.trim() !== '' && !orderLettersCanonicalCarrier(update.carrier)))) {
        jsonReply(res, 400, {error: 'carrier must be one of ' + ORDER_CARRIER_LIST}); return;
      }
      if (update.managerNote !== undefined && (typeof update.managerNote !== 'string' || update.managerNote.length > 2000)) {
        jsonReply(res, 400, {error:'managerNote must be a string (max 2000)'}); return;
      }
      if (update.coupon !== undefined && (typeof update.coupon !== 'string' || update.coupon.length > 40)) {
        jsonReply(res, 400, {error:'coupon must be a string (max 40)'}); return;
      }
      if (update.customer !== undefined) {
        if (!update.customer || typeof update.customer !== 'object' || Array.isArray(update.customer)) {
          jsonReply(res, 400, {error:'customer must be an object'}); return;
        }
        if (Object.prototype.hasOwnProperty.call(update.customer, 'email')) {
          jsonReply(res, 400, {error:'email cannot be changed here'}); return;
        }
        for (const k of Object.keys(CRM_CUST_STR)) {
          if (update.customer[k] === undefined) continue;
          if (typeof update.customer[k] === 'object') { jsonReply(res, 400, {error:'customer.' + k + ' must be a string'}); return; }
        }
      }
      if (update.shipping !== undefined) {
        if (!update.shipping || typeof update.shipping !== 'object' || Array.isArray(update.shipping)) {
          jsonReply(res, 400, {error:'shipping must be an object'}); return;
        }
        for (const k of Object.keys(CRM_SHIP_STR)) {
          if (update.shipping[k] === undefined) continue;
          if (typeof update.shipping[k] === 'object') { jsonReply(res, 400, {error:'shipping.' + k + ' must be a string'}); return; }
        }
        if (Object.prototype.hasOwnProperty.call(update.shipping, 'cost')) {
          const cost = asMoney(update.shipping.cost);
          if (!Number.isFinite(cost) || cost < 0 || cost > 1e6) { jsonReply(res, 400, {error:'shipping.cost must be a non-negative number (max 1000000)'}); return; }
        }
      }
      if (update.items !== undefined) {
        const shape = validateCrmItemShapes(update.items);
        if (shape) { jsonReply(res, 400, {error: shape}); return; }
      }
      const content = update.items !== undefined || update.customer !== undefined || update.shipping !== undefined || update.coupon !== undefined || update.managerNote !== undefined;
      const dupSensitive = update.items !== undefined || update.customer !== undefined || update.shipping !== undefined || update.coupon !== undefined;
      const needsMoney = update.items !== undefined || update.coupon !== undefined || (update.shipping !== undefined && Object.prototype.hasOwnProperty.call(update.shipping, 'cost'));
      if (status === undefined && update.trackingNumber === undefined && update.carrier === undefined && update.notes === undefined && !content) {
        jsonReply(res, 400, {error:'Nothing to update'}); return;
      }
      if (content) {
        if (typeof update.expectedUpdatedAt !== 'string') {
          jsonReply(res, 400, {error:'expectedUpdatedAt is required'}); return;
        }
      }
      const orders = loadOrders();
      const order = findOrder(orders, orderId);
      if (!order) { jsonReply(res, 404, {error:'Order not found'}); return; }
      if (content && String(order.updated_at || '') !== String(update.expectedUpdatedAt)) {
        jsonReply(res, 409, {error:'Order changed elsewhere', order: order}); return;
      }
      if (dupSensitive && orderCopies(orders, orderId) > 1) {
        jsonReply(res, 409, {error:'Order ref is stored more than once', copies: orderCopies(orders, orderId)}); return;
      }
      let parsedItems = null;
      const storedHasItems = Array.isArray(order.items) && order.items.length > 0;
      let maps = null;
      if (update.items !== undefined || (needsMoney && storedHasItems)) {
        maps = catalogMaps();
        if (catalogUnreadable || !maps.catalog.length) {
          jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return;
        }
      }
      if (update.items !== undefined) {
        parsedItems = parseCrmItems(update.items, maps);
        if (parsedItems.skipped) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
        if (parsedItems.error) { jsonReply(res, 400, {error: parsedItems.error}); return; }
      }
      const statusChanged = status !== undefined && status !== String(order.status || '').trim().toLowerCase();
      // Stage 1 RET: shipped and in-transit need a tracking number (in the request or already on the order), before
      // anything on the order is touched: the buyer's letter carries it.
      const trackingMissing = statusChanged ? orderLettersTrackingProblem(status, update, order) : '';
      if (trackingMissing) { jsonReply(res, 400, {error: trackingMissing}); return; }
      const fields = [];
      const before = { toPay: moneyDue(order), items: Array.isArray(order.items) ? order.items.length : 0 };
      if (content) {
        ensureOriginal(order);
        liftLegacyCustomer(order);
      }
      if (parsedItems && parsedItems.items) { order.items = parsedItems.items; fields.push('items'); }
      if (update.customer !== undefined) {
        const custErr = mergeCustomerPatch(order, update.customer);
        if (custErr) { jsonReply(res, 400, {error: custErr}); return; }
        fields.push('customer');
      }
      if (update.shipping !== undefined) {
        const shipErr = mergeShippingPatch(order, update.shipping);
        if (shipErr) { jsonReply(res, 400, {error: shipErr}); return; }
        fields.push('shipping');
      }
      if (update.coupon !== undefined) { order.coupon = cleanStr(update.coupon, 40); fields.push('coupon'); }
      if (update.managerNote !== undefined) { order.managerNote = cleanStr(update.managerNote, 2000); fields.push('managerNote'); }
      if (status !== undefined) order.status = status;
      if (update.trackingNumber !== undefined) order.trackingNumber = update.trackingNumber;
      if (update.carrier !== undefined) {
        const carrierSet = orderLettersCanonicalCarrier(update.carrier);
        if (carrierSet || order.carrier) order.carrier = carrierSet;
      }
      if (update.notes !== undefined) order.notes = update.notes;
      if (needsMoney && Array.isArray(order.items) && order.items.length) {
        if (!maps) maps = catalogMaps();
        if (catalogUnreadable || !maps.catalog.length) {
          jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return;
        }
        const money = applyCrmMoney(order, maps);
        if (money.skipped) { jsonReply(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
      }
      if (fields.length) pushOrderEdit(order, req, fields, before);
      order.updated_at = new Date().toISOString();
      saveOrdersData(orders);
      console.log('[orders] PATCH ' + orderId + (status !== undefined ? ' status=' + status : '') + (fields.length ? ' fields=' + fields.join(',') : '') + (update.trackingNumber !== undefined ? ' trackingNumber' : '') + (update.notes !== undefined ? ' notes' : ''));
      jsonReply(res, 200, {ok: true, order: order});
      if (fields.length) {
        try { logActivity('order_updated', 'Patched ' + orderId + ' (' + fields.join(',') + ')', crmActor(req), orderId); }
        catch (e) { console.error('[orders] patch activity:', e && e.message); }
      }
      // Card import (2026-09-27): a manager moving a sandbox-mode card payment through its statuses must not
      // tell Customer.io a real status change happened.
      if (statusChanged && order.test !== true) {
        try { if (mailOutbox && order.ref) mailOutbox.enqueue('cio_order_status', order.ref, {status: status}); else cioTrackWithProfile(order.customer && order.customer.email, 'order_status_changed', {ref: mailSafe(cleanStr(order.ref, 64)), status: mailSafe(status)}, order.ref, {orders: orders, source: 'order'}); }
        catch (trackErr) { console.error('[cio-track] order_status_changed skipped: ' + ((trackErr && trackErr.message) || trackErr)); }
        // order_delivered (cio-events 2026-09-30): the journeys that start after delivery listen to this name, not to the status event.
        if (status === 'delivered') {
          try { if (mailOutbox && order.ref) mailOutbox.enqueue('cio_order_delivered', order.ref); else cioTrackWithProfile(order.customer && order.customer.email, 'order_delivered', orderDeliveredData(order), order.ref); }
          catch (trackErr) { console.error('[cio-track] order_delivered skipped: ' + ((trackErr && trackErr.message) || trackErr)); }
        }
        try { orderLettersOnStatus(order, status); } catch (letterErr) { console.error('[letters] ERROR status letter skipped: ' + ((letterErr && letterErr.message) || letterErr)); }
        tgAlertsOnStatus(order, status);
      }
    });
    return;
  }

  // DELETE /msolpeptides-api/orders/:id
  if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/orders/')) {
    const orderId = pathname.split('/').pop();
    const orders = loadOrders();
    const filtered = orders.filter(function(o) { return o.ref !== orderId; });
    saveOrdersData(filtered);
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ok: true}));
    return;
  }


// ============================================================
// SALES OPS MODULE — Customers, Sales/Billing, Invoices, Stock
// Added Aug 5 2026 — mirrors "Daily Sales" app UX inside the CRM
// ============================================================

const CUSTOMERS_FILE = path.join(__dirname, 'customers.json');
const SALES_FILE = path.join(__dirname, 'sales.json');
const INVOICES_FILE = path.join(__dirname, 'invoices.json');
const STOCK_MOVEMENTS_FILE = path.join(__dirname, 'stock_movements.json');

function loadJsonFile(file, fallback) {
  return readJsonOrFallback(file, fallback);
}
function saveJsonFile(file, data) {
  writeJsonAtomic(file, data);
}
function loadCustomers() { return loadJsonFile(CUSTOMERS_FILE, []); }
function saveCustomers(d) { saveJsonFile(CUSTOMERS_FILE, d); }
function loadSales() { return loadJsonFile(SALES_FILE, []); }
function saveSales(d) { saveJsonFile(SALES_FILE, d); }
function loadInvoices() { return loadJsonFile(INVOICES_FILE, []); }
function saveInvoices(d) { saveJsonFile(INVOICES_FILE, d); }
function loadStockMovements() { return loadJsonFile(STOCK_MOVEMENTS_FILE, []); }
function saveStockMovements(d) { saveJsonFile(STOCK_MOVEMENTS_FILE, d); }

function genId(prefix) {
  return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();
}

function nextInvoiceNumber() {
  const invoices = loadInvoices();
  let max = 100; // start invoice numbers at 101
  invoices.forEach(inv => { if (inv.invoice_number > max) max = inv.invoice_number; });
  return max + 1;
}

// Phase 1 (2026-09-04): the callback runs exactly once. A parse error goes to cb(err); an exception thrown by the
// handler itself is logged and answered with 500 (it used to re-enter the callback with the error, and res is in scope
// here because readBody lives inside handleRequest).
function readBody(req, cb) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let data;
    try { data = body ? JSON.parse(body) : {}; }
    catch(e) { cb(e); return; }
    try { cb(null, data); }
    catch(e) {
      console.error('[api] handler error on ' + routeKey(req) + ':', e && e.stack || e);
      if (!res.headersSent) sendJSON(res, 500, {error:'Internal error'});
    }
  });
}

function sendJSON(res, code, obj) {
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(code);
  res.end(JSON.stringify(obj));
}

// ---------- CUSTOMERS ----------

// GET /msolpeptides-api/customers
if (req.method === 'GET' && pathname === '/msolpeptides-api/customers') {
  const customers = loadCustomers();
  const sales = loadSales();
  // compute balance (due) per customer: sum of due across their transactions
  const withBalance = customers.map(c => {
    const custSales = sales.filter(s => s.customer_id === c.id);
    const balance = custSales.reduce((sum, s) => sum + (s.due || 0), 0);
    const totalSpent = custSales.reduce((sum, s) => sum + (s.total || 0), 0);
    return Object.assign({}, c, { balance, total_transactions: custSales.length, total_spent: totalSpent });
  });
  sendJSON(res, 200, withBalance);
  return;
}

// POST /msolpeptides-api/customers - create
if (req.method === 'POST' && pathname === '/msolpeptides-api/customers') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error: 'Bad request'}); return; }
    const customers = loadCustomers();
    const newCustomer = {
      id: genId('CUST'),
      customer_id: (data.customer_id || data.name || 'CUST').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12),
      name: data.name || 'Unnamed Customer',
      phone: data.phone || '',
      email: data.email || '',
      type: data.type || 'Individual',
      address: data.address || '',
      credit_limit: Number(data.credit_limit) || 0,
      created_at: new Date().toISOString(),
      source: data.source || 'direct'
    };
    customers.push(newCustomer);
    saveCustomers(customers);
    sendJSON(res, 200, {ok: true, customer: newCustomer});
  });
  return;
}

// PUT /msolpeptides-api/customers/:id - update
if (req.method === 'PUT' && pathname.startsWith('/msolpeptides-api/customers/')) {
  const custId = decodeURIComponent(pathname.split('/').pop());
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error: 'Bad request'}); return; }
    const customers = loadCustomers();
    const c = customers.find(x => x.id === custId);
    if (!c) { sendJSON(res, 404, {error: 'Customer not found'}); return; }
    ['name','phone','email','type','address','credit_limit','customer_id'].forEach(f => {
      if (data[f] !== undefined) c[f] = f === 'credit_limit' ? Number(data[f]) : data[f];
    });
    saveCustomers(customers);
    sendJSON(res, 200, {ok: true, customer: c});
  });
  return;
}

// DELETE /msolpeptides-api/customers/:id
if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/customers/')) {
  const custId = decodeURIComponent(pathname.split('/').pop());
  if (custId === 'walkin') { sendJSON(res, 400, {error: 'Cannot delete Walk-in Customer'}); return; }
  const customers = loadCustomers();
  const filtered = customers.filter(x => x.id !== custId);
  saveCustomers(filtered);
  sendJSON(res, 200, {ok: true});
  return;
}

// GET /msolpeptides-api/customers/:id/statement?from=YYYY-MM-DD&to=YYYY-MM-DD
if (req.method === 'GET' && /^\/msolpeptides-api\/customers\/[^\/]+\/statement/.test(pathname)) {
  const urlObj = new URL(req.url, 'http://localhost');
  const custId = decodeURIComponent(urlObj.pathname.split('/')[3]);
  const from = urlObj.searchParams.get('from');
  const to = urlObj.searchParams.get('to');
  const customers = loadCustomers();
  const customer = customers.find(c => c.id === custId);
  if (!customer) { sendJSON(res, 404, {error: 'Customer not found'}); return; }
  let sales = loadSales().filter(s => s.customer_id === custId);
  if (from) sales = sales.filter(s => s.created_at >= from);
  if (to) sales = sales.filter(s => s.created_at <= (to + 'T23:59:59.999Z'));
  sales.sort((a, b) => a.created_at.localeCompare(b.created_at));
  const total_amount = sales.reduce((sum, s) => sum + (s.total || 0), 0);
  const total_due = sales.reduce((sum, s) => sum + (s.due || 0), 0);
  sendJSON(res, 200, {
    customer,
    total_transactions: sales.length,
    total_amount,
    total_due,
    transactions: sales
  });
  return;
}

// ---------- SALES / BILLING ----------

// GET /msolpeptides-api/sales?from=&to=&customer_id=
if (req.method === 'GET' && pathname.startsWith('/msolpeptides-api/sales') && !pathname.includes('/sales/')) {
  const urlObj = new URL(req.url, 'http://localhost');
  let sales = loadSales();
  const from = urlObj.searchParams.get('from');
  const to = urlObj.searchParams.get('to');
  const customerId = urlObj.searchParams.get('customer_id');
  if (from) sales = sales.filter(s => s.created_at >= from);
  if (to) sales = sales.filter(s => s.created_at <= (to + 'T23:59:59.999Z'));
  if (customerId) sales = sales.filter(s => s.customer_id === customerId);
  sales.sort((a, b) => b.created_at.localeCompare(a.created_at));
  sendJSON(res, 200, sales);
  return;
}

// POST /msolpeptides-api/sales - record a sale (Add Sale)
if (req.method === 'POST' && pathname === '/msolpeptides-api/sales') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error: 'Bad request'}); return; }
    const lineItems = Array.isArray(data.line_items) ? data.line_items : [];
    if (lineItems.length === 0) { sendJSON(res, 400, {error: 'At least one product line required'}); return; }

    const products = readProducts();
    // Phase 7 (2026-09-06): 503 gate in front of every writeProducts() call site, so a broken products-data.json
    // is reported and left alone instead of the request failing halfway through (or writing the other files first).
    if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }

    // Validate stock availability first (never go negative)
    for (const li of lineItems) {
      const product = products.find(p => p.id === li.product_id);
      if (!product) { sendJSON(res, 400, {error: `Product not found: ${li.product_id}`}); return; }
      const currentQty = Number(product.stock_qty || 0);
      if (currentQty < Number(li.qty)) {
        sendJSON(res, 409, {error: `Insufficient stock for ${product.name}. Available: ${currentQty}, requested: ${li.qty}`});
        return;
      }
    }

    // Customer credit-limit check (only for on-credit sales, i.e. due > 0)
    const customers = loadCustomers();
    const customerId = data.customer_id || 'walkin';
    const customer = customers.find(c => c.id === customerId) || customers.find(c => c.id === 'walkin');

    const subtotal = lineItems.reduce((sum, li) => sum + (Number(li.qty) * Number(li.unit_price)), 0);
    const total = subtotal; // tax handling can be added later
    const paidAmount = Number(data.paid_amount) || 0;
    const due = Math.max(0, total - paidAmount);

    if (customer && customer.credit_limit > 0 && due > 0) {
      const existingSales = loadSales().filter(s => s.customer_id === customer.id);
      const existingBalance = existingSales.reduce((sum, s) => sum + (s.due || 0), 0);
      if (existingBalance + due > customer.credit_limit) {
        sendJSON(res, 409, {
          error: `Credit limit exceeded for ${customer.name}. Limit: $${customer.credit_limit}, current balance: $${existingBalance.toFixed(2)}, this sale would add: $${due.toFixed(2)}. Ask an admin to override.`
        });
        return;
      }
    }

    // Commit: decrement stock in memory; the files are written at the end of this handler
    lineItems.forEach(li => {
      const product = products.find(p => p.id === li.product_id);
      product.stock_qty = Number(product.stock_qty || 0) - Number(li.qty);
    });

    const movements = loadStockMovements();
    const movementsBefore = movements.slice();
    lineItems.forEach(li => {
      movements.push({
        id: genId('MOV'),
        product_id: li.product_id,
        type: 'out',
        qty: Number(li.qty),
        reason: 'sale',
        user: data.user || 'unknown',
        created_at: new Date().toISOString()
      });
    });

    // Create sale transaction
    const invoiceNumber = nextInvoiceNumber();
    const sale = {
      id: genId('SALE'),
      invoice_number: invoiceNumber,
      customer_id: customer ? customer.id : 'walkin',
      customer_name: customer ? customer.name : 'Walk-in Customer',
      line_items: lineItems.map(li => {
        const product = products.find(p => p.id === li.product_id);
        return {
          product_id: li.product_id,
          name: product ? product.name : li.name,
          qty: Number(li.qty),
          unit_price: Number(li.unit_price),
          total: Number(li.qty) * Number(li.unit_price)
        };
      }),
      subtotal,
      total,
      currency: 'USD',
      payment_type: data.payment_type || 'Cash',
      paid_amount: paidAmount,
      due,
      source: 'direct',
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    };
    const sales = loadSales();
    const salesBefore = sales.slice();
    sales.push(sale);

    // Generate invoice record
    const invoices = loadInvoices();
    const invoicesBefore = invoices.slice();
    const invoice = {
      id: genId('INV'),
      invoice_number: invoiceNumber,
      transaction_id: sale.id,
      customer_id: sale.customer_id,
      customer_name: sale.customer_name,
      line_items: sale.line_items,
      subtotal,
      total,
      currency: 'USD',
      status: due > 0 ? 'partially_paid' : 'paid',
      issued_at: new Date().toISOString()
    };
    invoices.push(invoice);

    // Phase 8 (2026-09-06): documents first, catalog second, rollback on failure - same order as stock-writeoffs
    // (phase 7). The catalog used to be written before the sale existed anywhere, so a failure below - or a broken
    // sales.json - left the stock reduced with no movement, sale or invoice to explain where it went.
    const failed = commitOrRollback([
      { name: 'stock-movements', save: saveStockMovements, after: movements, before: movementsBefore },
      { name: 'sales', save: saveSales, after: sales, before: salesBefore },
      { name: 'invoices', save: saveInvoices, after: invoices, before: invoicesBefore },
      { name: 'catalog', save: writeProducts, after: products }
    ]);
    if (failed) {
      console.error('[sales] write failed, sale ' + sale.id + ' rolled back:', failed.message);
      sendJSON(res, 500, {error: 'Could not record sale'}); return;
    }

    sendJSON(res, 200, {ok: true, sale, invoice});
  });
  return;
}

// GET /msolpeptides-api/sales/:id
if (req.method === 'GET' && /^\/msolpeptides-api\/sales\/[^\/]+$/.test(pathname)) {
  const saleId = decodeURIComponent(pathname.split('/').pop());
  const sales = loadSales();
  const sale = sales.find(s => s.id === saleId);
  if (!sale) { sendJSON(res, 404, {error: 'Sale not found'}); return; }
  sendJSON(res, 200, sale);
  return;
}

// ---------- DASHBOARD KPIs ----------

// GET /msolpeptides-api/dashboard/kpis?period=today|month
if (req.method === 'GET' && pathname.startsWith('/msolpeptides-api/dashboard/kpis')) {
  const urlObj = new URL(req.url, 'http://localhost');
  const period = urlObj.searchParams.get('period') || 'month';
  const now = new Date();
  let periodStart;
  if (period === 'today') {
    periodStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  } else {
    periodStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  }
  const sales = loadSales().filter(s => s.created_at >= periodStart);
  const totalSales = sales.reduce((sum, s) => sum + (s.total || 0), 0);
  const productsForCost = readProducts();
  // Phase 8 (2026-09-06): 503 instead of zeros shown as data - an unreadable catalog used to make cost, stock value,
  // low-stock count and the product totals come out as 0 on the dashboard.
  if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }

  const totalCost = sales.reduce((sum, s) => {
    return sum + s.line_items.reduce((lsum, li) => {
      const p = productsForCost.find(pr => pr.id === li.product_id);
      return lsum + (p ? Number(p.cost || 0) * li.qty : 0);
    }, 0);
  }, 0);
  const profit = totalSales - totalCost;

  const products = productsForCost;   // phase 8 (review PF): one gated read; a second readProducts() could slip past the 503 gate above
  const stockValue = products.reduce((sum, p) => sum + (Number(p.cost || 0) * Number(p.stock_qty || 0)), 0);
  const lowStockCount = products.filter(p => Number(p.stock_qty || 0) <= Number(p.low_stock_threshold || 10)).length;

  const allSales = loadSales();
  const outstandingBalance = allSales.reduce((sum, s) => sum + (s.due || 0), 0);

  sendJSON(res, 200, {
    period,
    total_sales: totalSales,
    total_profit: profit,
    invoice_count: sales.length,
    stock_value: stockValue,
    low_stock_count: lowStockCount,
    outstanding_balance: outstandingBalance,
    active_products: products.filter(p => p.is_active).length,
    total_products: products.length
  });
  return;
}

// ---------- STOCK HEALTH ----------

// GET /msolpeptides-api/stock/health
if (req.method === 'GET' && pathname === '/msolpeptides-api/stock/health') {
  const products = readProducts();
  // Phase 8 (2026-09-06): 503 instead of zeros shown as data - an unreadable catalog used to answer an empty list,
  // which reads as "no stock problems".
  if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }

  const items = products.map(p => ({
    id: p.id,
    name: p.name,
    stock_qty: Number(p.stock_qty || 0),
    low_stock_threshold: Number(p.low_stock_threshold || 10),
    cost: Number(p.cost || 0),
    stock_value: Number(p.cost || 0) * Number(p.stock_qty || 0),
    status: Number(p.stock_qty || 0) <= 0 ? 'out_of_stock' : (Number(p.stock_qty || 0) <= Number(p.low_stock_threshold || 10) ? 'low' : 'ok')
  }));
  const totalValue = items.reduce((sum, i) => sum + i.stock_value, 0);
  sendJSON(res, 200, {items, total_stock_value: totalValue, low_stock_count: items.filter(i => i.status !== 'ok').length});
  return;
}

// POST /msolpeptides-api/stock/adjust - manual stock movement (in/out/adjustment)
if (req.method === 'POST' && pathname === '/msolpeptides-api/stock/adjust') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error: 'Bad request'}); return; }
    const products = readProducts();
    // Phase 7 (2026-09-06): 503 gate before the lookup (an unreadable catalog used to answer 404 Product not found).
    if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
    const product = products.find(p => p.id === data.product_id);
    if (!product) { sendJSON(res, 404, {error: 'Product not found'}); return; }
    const qty = Number(data.qty) || 0;
    const type = data.type || 'adjustment'; // in | out | adjustment
    let newQty = Number(product.stock_qty || 0);
    if (type === 'in') newQty += qty;
    else if (type === 'out') newQty -= qty;
    else newQty = qty; // adjustment sets absolute value

    if (newQty < 0) { sendJSON(res, 409, {error: 'Stock cannot go negative'}); return; }

    product.stock_qty = newQty;
    // Phase 8 (2026-09-06): documents first, catalog second, rollback on failure - same order as stock-writeoffs
    // (phase 7). The catalog used to be written before the movement, so a failed journal write left a changed stock
    // with no record of why.
    const movements = loadStockMovements();
    const movementsBefore = movements.slice();
    movements.push({
      id: genId('MOV'),
      product_id: product.id,
      type,
      qty,
      reason: data.reason || 'manual_adjustment',
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    });
    const failed = commitOrRollback([
      { name: 'stock-movements', save: saveStockMovements, after: movements, before: movementsBefore },
      { name: 'catalog', save: writeProducts, after: products }
    ]);
    if (failed) {
      console.error('[stock/adjust] adjustment of ' + product.id + ' failed and was rolled back:', failed.message);
      sendJSON(res, 500, {error: 'Could not adjust stock'}); return;
    }

    sendJSON(res, 200, {ok: true, product});
  });
  return;
}


// ============================================================
// EXTENDED SALES OPS MODULE — Quotations, Suppliers, POs,
// Expenses, Income, Representatives, Activity Log, Damaged Items
// Added Aug 5 2026
// ============================================================

const QUOTATIONS_FILE = path.join(__dirname, 'quotations.json');
const SUPPLIERS_FILE = path.join(__dirname, 'suppliers.json');
const PURCHASE_ORDERS_FILE = path.join(__dirname, 'purchase_orders.json');
const EXPENSES_FILE = path.join(__dirname, 'expenses.json');
const INCOME_FILE = path.join(__dirname, 'income.json');
const REPRESENTATIVES_FILE = path.join(__dirname, 'representatives.json');

function loadJF(file, fallback) {
  return readJsonOrFallback(file, fallback);
}
function saveJF(file, data) {
  writeJsonAtomic(file, data);
}

function logActivity(type, description, user, entity) {
  // The journal is auxiliary: it is written after the business record, so a broken activity_log.json is logged, never
  // turned into a 500 for an operation that already succeeded (phase 1, 2026-09-04).
  try {
    const log = loadJF(ACTIVITY_LOG_FILE, []);
    log.push({
      id: genId('ACT'),
      type, description, user: user || 'system',
      entity: entity || null,
      created_at: new Date().toISOString()
    });
    // Keep last 1000 entries
    if (log.length > 1000) log.splice(0, log.length - 1000);
    saveJF(ACTIVITY_LOG_FILE, log);
  } catch (e) {
    console.error('[activity-log] not written:', e.message);
  }
}

// ---------- QUOTATIONS ----------

if (req.method === 'GET' && pathname.startsWith('/msolpeptides-api/quotations') && !pathname.includes('/quotations/')) {
  const urlObj = new URL(req.url, 'http://localhost');
  let quotes = loadJF(QUOTATIONS_FILE, []);
  const customerId = urlObj.searchParams.get('customer_id');
  if (customerId) quotes = quotes.filter(q => q.customer_id === customerId);
  quotes.sort((a, b) => b.created_at.localeCompare(a.created_at));
  sendJSON(res, 200, quotes);
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/quotations') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const quotes = loadJF(QUOTATIONS_FILE, []);
    const customers = loadCustomers();
    const customer = customers.find(c => c.id === (data.customer_id || 'walkin')) || {id:'walkin',name:'Walk-in Customer'};
    const lineItems = Array.isArray(data.line_items) ? data.line_items : [];
    const total = lineItems.reduce((sum, li) => sum + (Number(li.qty) * Number(li.unit_price)), 0);
    const quote = {
      id: genId('QUO'),
      quote_number: 'Q-' + (1000 + quotes.length + 1),
      customer_id: customer.id,
      customer_name: customer.name,
      line_items: lineItems,
      total,
      currency: 'USD',
      status: 'draft',
      notes: data.notes || '',
      valid_until: data.valid_until || new Date(Date.now() + 30*86400000).toISOString().slice(0,10),
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    };
    quotes.push(quote);
    saveJF(QUOTATIONS_FILE, quotes);
    logActivity('quotation_created', `Quotation ${quote.quote_number} created for ${customer.name} ($${total.toFixed(2)})`, data.user, quote.id);
    sendJSON(res, 200, {ok:true, quotation: quote});
  });
  return;
}

if (req.method === 'PUT' && pathname.startsWith('/msolpeptides-api/quotations/')) {
  const quoteId = decodeURIComponent(pathname.split('/').pop());
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const quotes = loadJF(QUOTATIONS_FILE, []);
    const q = quotes.find(x => x.id === quoteId);
    if (!q) { sendJSON(res, 404, {error:'Quotation not found'}); return; }
    ['status','notes','valid_until'].forEach(f => { if (data[f] !== undefined) q[f] = data[f]; });
    if (Array.isArray(data.line_items)) { q.line_items = data.line_items; q.total = data.line_items.reduce((s,li)=>s+Number(li.qty)*Number(li.unit_price),0); }
    saveJF(QUOTATIONS_FILE, quotes);
    sendJSON(res, 200, {ok:true, quotation: q});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/quotations/')) {
  const quoteId = decodeURIComponent(pathname.split('/').pop());
  const quotes = loadJF(QUOTATIONS_FILE, []);
  saveJF(QUOTATIONS_FILE, quotes.filter(q => q.id !== quoteId));
  sendJSON(res, 200, {ok:true});
  return;
}

// Convert quotation to sale
if (req.method === 'POST' && /^\/msolpeptides-api\/quotations\/[^\/]+\/convert/.test(pathname)) {
  const quoteId = decodeURIComponent(pathname.split('/')[3]);
  const quotes = loadJF(QUOTATIONS_FILE, []);
  const q = quotes.find(x => x.id === quoteId);
  if (!q) { sendJSON(res, 404, {error:'Quotation not found'}); return; }
  if (q.status === 'converted') { sendJSON(res, 409, {error:'Already converted to sale'}); return; }
  
  // Create sale from quotation
  const products = readProducts();
  // Phase 7 (2026-09-06): 503 gate; without it writeProducts() below threw and the quotation stayed unconverted with a 500.
  if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
  // Validate stock
  for (const li of q.line_items) {
    const product = products.find(p => p.id === li.product_id);
    if (product && Number(product.stock_qty||0) < Number(li.qty)) {
      sendJSON(res, 409, {error:`Insufficient stock for ${product.name}. Available: ${product.stock_qty}, needed: ${li.qty}`});
      return;
    }
  }
  // Decrement stock
  q.line_items.forEach(li => {
    const product = products.find(p => p.id === li.product_id);
    if (product) product.stock_qty = Number(product.stock_qty||0) - Number(li.qty);
  });

  // Record stock movements
  const movements = loadStockMovements();
  const movementsBefore = movements.slice();
  q.line_items.forEach(li => {
    movements.push({id:genId('MOV'),product_id:li.product_id,type:'out',qty:Number(li.qty),reason:'sale_from_quote',user:q.user||'unknown',created_at:new Date().toISOString()});
  });

  // Create sale
  const invoiceNumber = nextInvoiceNumber();
  const sale = {
    id: genId('SALE'), invoice_number: invoiceNumber,
    customer_id: q.customer_id, customer_name: q.customer_name,
    line_items: q.line_items, subtotal: q.total, total: q.total,
    currency:'USD', payment_type:'Converted from Quotation',
    paid_amount:0, due:q.total, source:'quotation',
    user:q.user, quotation_id:q.id, created_at:new Date().toISOString()
  };
  const sales = loadSales(); const salesBefore = sales.slice(); sales.push(sale);

  // Create invoice
  const invoices = loadInvoices();
  const invoicesBefore = invoices.slice();
  invoices.push({id:genId('INV'),invoice_number:invoiceNumber,transaction_id:sale.id,customer_id:sale.customer_id,customer_name:sale.customer_name,line_items:sale.line_items,subtotal:q.total,total:q.total,currency:'USD',status:'issued',issued_at:new Date().toISOString()});

  // Update quotation status. The snapshot is a deep copy because q is an element of quotes and is mutated right below.
  const quotesBefore = JSON.parse(JSON.stringify(quotes));
  q.status = 'converted'; q.converted_sale_id = sale.id;

  // Phase 8 (2026-09-06): documents first, catalog second, rollback on failure - same order as stock-writeoffs
  // (phase 7). The stock used to leave the catalog before the movement, the sale, the invoice and the converted
  // quotation were written, so any failure after it lost the sale and kept the quotation open.
  const failed = commitOrRollback([
    { name: 'stock-movements', save: saveStockMovements, after: movements, before: movementsBefore },
    { name: 'sales', save: saveSales, after: sales, before: salesBefore },
    { name: 'invoices', save: saveInvoices, after: invoices, before: invoicesBefore },
    { name: 'quotations', save: d => saveJF(QUOTATIONS_FILE, d), after: quotes, before: quotesBefore },
    { name: 'catalog', save: writeProducts, after: products }
  ]);
  if (failed) {
    console.error('[quotations] convert of ' + q.id + ' failed and was rolled back:', failed.message);
    sendJSON(res, 500, {error:'Could not convert quotation'}); return;
  }
  logActivity('quotation_converted', `Quotation ${q.quote_number} converted to Sale #${invoiceNumber}`, q.user, q.id);
  sendJSON(res, 200, {ok:true, sale, quotation:q});
  return;
}

// ---------- SUPPLIERS ----------

if (req.method === 'GET' && pathname === '/msolpeptides-api/suppliers') {
  sendJSON(res, 200, loadJF(SUPPLIERS_FILE, []));
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/suppliers') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const suppliers = loadJF(SUPPLIERS_FILE, []);
    const supplier = {
      id: genId('SUP'),
      name: data.name || 'Unnamed Supplier',
      contact_person: data.contact_person || '',
      email: data.email || '',
      phone: data.phone || '',
      wechat_id: data.wechat_id || '',
      address: data.address || '',
      payment_terms: data.payment_terms || '',
      notes: data.notes || '',
      rating: Number(data.rating) || 0,
      products_supplied: data.products_supplied || [],
      created_at: new Date().toISOString()
    };
    suppliers.push(supplier);
    saveJF(SUPPLIERS_FILE, suppliers);
    logActivity('supplier_added', `Supplier ${supplier.name} added`, data.user, supplier.id);
    sendJSON(res, 200, {ok:true, supplier});
  });
  return;
}

if (req.method === 'PUT' && pathname.startsWith('/msolpeptides-api/suppliers/')) {
  const supId = decodeURIComponent(pathname.split('/').pop());
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const suppliers = loadJF(SUPPLIERS_FILE, []);
    const s = suppliers.find(x => x.id === supId);
    if (!s) { sendJSON(res, 404, {error:'Supplier not found'}); return; }
    ['name','contact_person','email','phone','wechat_id','address','payment_terms','notes','rating','products_supplied'].forEach(f => {
      if (data[f] !== undefined) s[f] = f === 'rating' ? Number(data[f]) : data[f];
    });
    saveJF(SUPPLIERS_FILE, suppliers);
    sendJSON(res, 200, {ok:true, supplier: s});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/suppliers/')) {
  const supId = decodeURIComponent(pathname.split('/').pop());
  const suppliers = loadJF(SUPPLIERS_FILE, []);
  saveJF(SUPPLIERS_FILE, suppliers.filter(s => s.id !== supId));
  sendJSON(res, 200, {ok:true});
  return;
}

// ---------- PURCHASE ORDERS ----------

if (req.method === 'GET' && pathname.startsWith('/msolpeptides-api/purchase-orders') && !pathname.includes('/purchase-orders/')) {
  const urlObj = new URL(req.url, 'http://localhost');
  let pos = loadJF(PURCHASE_ORDERS_FILE, []);
  const supplierId = urlObj.searchParams.get('supplier_id');
  if (supplierId) pos = pos.filter(p => p.supplier_id === supplierId);
  pos.sort((a, b) => b.created_at.localeCompare(a.created_at));
  sendJSON(res, 200, pos);
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/purchase-orders') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const pos = loadJF(PURCHASE_ORDERS_FILE, []);
    const suppliers = loadJF(SUPPLIERS_FILE, []);
    const supplier = suppliers.find(s => s.id === data.supplier_id) || {id:'',name:'Unknown'};
    const lineItems = Array.isArray(data.line_items) ? data.line_items : [];
    const total = lineItems.reduce((sum, li) => sum + (Number(li.qty) * Number(li.unit_cost)), 0);
    const po = {
      id: genId('PO'),
      po_number: 'PO-' + (1000 + pos.length + 1),
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      line_items: lineItems.map(li => ({
        product_id: li.product_id,
        name: li.name || '',
        qty: Number(li.qty),
        unit_cost: Number(li.unit_cost),
        total: Number(li.qty) * Number(li.unit_cost)
      })),
      total,
      currency: 'USD',
      status: 'draft',
      expected_delivery: data.expected_delivery || '',
      notes: data.notes || '',
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    };
    pos.push(po);
    saveJF(PURCHASE_ORDERS_FILE, pos);
    logActivity('po_created', `Purchase Order ${po.po_number} created for ${supplier.name} ($${total.toFixed(2)})`, data.user, po.id);
    sendJSON(res, 200, {ok:true, po});
  });
  return;
}

if (req.method === 'PUT' && pathname.startsWith('/msolpeptides-api/purchase-orders/')) {
  const poId = decodeURIComponent(pathname.split('/').pop());
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const pos = loadJF(PURCHASE_ORDERS_FILE, []);
    const po = pos.find(p => p.id === poId);
    if (!po) { sendJSON(res, 404, {error:'PO not found'}); return; }
    
    // If status changed to 'received', add stock.
    // Phase 8 (2026-09-06): documents first, catalog second, rollback on failure - same order as stock-writeoffs
    // (phase 7). Receiving used to raise the stock in the catalog before the PO itself said "received", so a failure
    // right after left the extra stock with the PO still draft and no movement recorded.
    const receiving = data.status === 'received' && po.status !== 'received';
    let products = null, movements = null, movementsBefore = null, posBefore = null;
    if (receiving) {
      products = readProducts();
      // Phase 7 (2026-09-06): 503 gate before the received-stock is applied (writeProducts() below used to throw a 500).
      if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
      movements = loadStockMovements();
      movementsBefore = movements.slice();
      posBefore = JSON.parse(JSON.stringify(pos));   // deep copy: po is an element of pos and is mutated below
      po.line_items.forEach(li => {
        const product = products.find(p => p.id === li.product_id);
        if (product) {
          product.stock_qty = Number(product.stock_qty||0) + Number(li.qty);
          movements.push({id:genId('MOV'),product_id:li.product_id,type:'in',qty:Number(li.qty),reason:'po_received',user:data.user||'unknown',created_at:new Date().toISOString()});
        }
      });
    }

    ['status','notes','expected_delivery'].forEach(f => { if (data[f] !== undefined) po[f] = data[f]; });
    po.updated_at = new Date().toISOString();
    if (receiving) {
      const failed = commitOrRollback([
        { name: 'stock-movements', save: saveStockMovements, after: movements, before: movementsBefore },
        { name: 'purchase-orders', save: d => saveJF(PURCHASE_ORDERS_FILE, d), after: pos, before: posBefore },
        { name: 'catalog', save: writeProducts, after: products }
      ]);
      if (failed) {
        console.error('[purchase-orders] receiving ' + po.id + ' failed and was rolled back:', failed.message);
        sendJSON(res, 500, {error:'Could not receive purchase order'}); return;
      }
      logActivity('po_received', `PO ${po.po_number} received - stock updated`, data.user, po.id);
    } else {
      saveJF(PURCHASE_ORDERS_FILE, pos);
    }
    sendJSON(res, 200, {ok:true, po});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/purchase-orders/')) {
  const poId = decodeURIComponent(pathname.split('/').pop());
  const pos = loadJF(PURCHASE_ORDERS_FILE, []);
  saveJF(PURCHASE_ORDERS_FILE, pos.filter(p => p.id !== poId));
  sendJSON(res, 200, {ok:true});
  return;
}

// ---------- EXPENSES ----------

if (req.method === 'GET' && pathname.startsWith('/msolpeptides-api/expenses') && !pathname.includes('/expenses/')) {
  const urlObj = new URL(req.url, 'http://localhost');
  let expenses = loadJF(EXPENSES_FILE, []);
  const from = urlObj.searchParams.get('from');
  const to = urlObj.searchParams.get('to');
  if (from) expenses = expenses.filter(e => e.date >= from);
  if (to) expenses = expenses.filter(e => e.date <= to);
  expenses.sort((a, b) => b.date.localeCompare(a.date));
  sendJSON(res, 200, expenses);
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/expenses') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const expenses = loadJF(EXPENSES_FILE, []);
    const expense = {
      id: genId('EXP'),
      date: data.date || new Date().toISOString().slice(0,10),
      category: data.category || 'Other',
      amount: Number(data.amount) || 0,
      description: data.description || '',
      payment_method: data.payment_method || 'Cash',
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    };
    expenses.push(expense);
    saveJF(EXPENSES_FILE, expenses);
    logActivity('expense_added', `Expense added: ${expense.category} $${expense.amount.toFixed(2)}`, data.user, expense.id);
    sendJSON(res, 200, {ok:true, expense});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/expenses/')) {
  const expId = decodeURIComponent(pathname.split('/').pop());
  const expenses = loadJF(EXPENSES_FILE, []);
  saveJF(EXPENSES_FILE, expenses.filter(e => e.id !== expId));
  sendJSON(res, 200, {ok:true});
  return;
}

// ---------- INCOME ----------

if (req.method === 'GET' && pathname.startsWith('/msolpeptides-api/income') && !pathname.includes('/income/')) {
  const urlObj = new URL(req.url, 'http://localhost');
  let income = loadJF(INCOME_FILE, []);
  const from = urlObj.searchParams.get('from');
  const to = urlObj.searchParams.get('to');
  if (from) income = income.filter(i => i.date >= from);
  if (to) income = income.filter(i => i.date <= to);
  income.sort((a, b) => b.date.localeCompare(a.date));
  sendJSON(res, 200, income);
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/income') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const income = loadJF(INCOME_FILE, []);
    const inc = {
      id: genId('INC'),
      date: data.date || new Date().toISOString().slice(0,10),
      source: data.source || 'Other',
      amount: Number(data.amount) || 0,
      description: data.description || '',
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    };
    income.push(inc);
    saveJF(INCOME_FILE, income);
    logActivity('income_added', `Income added: ${inc.source} $${inc.amount.toFixed(2)}`, data.user, inc.id);
    sendJSON(res, 200, {ok:true, income: inc});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/income/')) {
  const incId = decodeURIComponent(pathname.split('/').pop());
  const income = loadJF(INCOME_FILE, []);
  saveJF(INCOME_FILE, income.filter(i => i.id !== incId));
  sendJSON(res, 200, {ok:true});
  return;
}

// ---------- REPRESENTATIVES ----------

if (req.method === 'GET' && pathname === '/msolpeptides-api/representatives') {
  const reps = loadJF(REPRESENTATIVES_FILE, []);
  const sales = loadSales();
  const withStats = reps.map(r => {
    const repSales = sales.filter(s => s.user === r.name || s.rep_id === r.id);
    const totalSales = repSales.reduce((sum, s) => sum + (s.total||0), 0);
    const commission = totalSales * (Number(r.commission_rate||0) / 100);
    return Object.assign({}, r, { total_sales: totalSales, total_commission: commission, sales_count: repSales.length });
  });
  sendJSON(res, 200, withStats);
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/representatives') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const reps = loadJF(REPRESENTATIVES_FILE, []);
    const rep = {
      id: genId('REP'),
      name: data.name || 'Unnamed Rep',
      email: data.email || '',
      phone: data.phone || '',
      commission_rate: Number(data.commission_rate) || 0,
      territory: data.territory || '',
      is_active: data.is_active !== false,
      created_at: new Date().toISOString()
    };
    reps.push(rep);
    saveJF(REPRESENTATIVES_FILE, reps);
    logActivity('rep_added', `Representative ${rep.name} added (${rep.commission_rate}% commission)`, data.user, rep.id);
    sendJSON(res, 200, {ok:true, rep});
  });
  return;
}

if (req.method === 'PUT' && pathname.startsWith('/msolpeptides-api/representatives/')) {
  const repId = decodeURIComponent(pathname.split('/').pop());
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const reps = loadJF(REPRESENTATIVES_FILE, []);
    const r = reps.find(x => x.id === repId);
    if (!r) { sendJSON(res, 404, {error:'Representative not found'}); return; }
    ['name','email','phone','commission_rate','territory','is_active'].forEach(f => {
      if (data[f] !== undefined) r[f] = f === 'commission_rate' ? Number(data[f]) : data[f];
    });
    saveJF(REPRESENTATIVES_FILE, reps);
    sendJSON(res, 200, {ok:true, rep: r});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/representatives/')) {
  const repId = decodeURIComponent(pathname.split('/').pop());
  const reps = loadJF(REPRESENTATIVES_FILE, []);
  saveJF(REPRESENTATIVES_FILE, reps.filter(r => r.id !== repId));
  sendJSON(res, 200, {ok:true});
  return;
}

// ---------- ACTIVITY LOG ----------

if (req.method === 'GET' && pathname.startsWith('/msolpeptides-api/activity-log')) {
  const urlObj = new URL(req.url, 'http://localhost');
  let log = loadJF(ACTIVITY_LOG_FILE, []);
  const from = urlObj.searchParams.get('from');
  const to = urlObj.searchParams.get('to');
  const userType = urlObj.searchParams.get('user');
  const type = urlObj.searchParams.get('type');
  if (from) log = log.filter(l => l.created_at >= from);
  if (to) log = log.filter(l => l.created_at <= (to + 'T23:59:59.999Z'));
  if (userType) log = log.filter(l => l.user === userType);
  if (type) log = log.filter(l => l.type === type);
  log.sort((a, b) => b.created_at.localeCompare(a.created_at));
  sendJSON(res, 200, log.slice(0, 200));
  return;
}


// ---------- SUPPLIER PAYMENTS & STATEMENT ----------

const SUPPLIER_PAYMENTS_FILE = path.join(__dirname, 'supplier_payments.json');

if (req.method === 'GET' && /^\/msolpeptides-api\/suppliers\/[^\/]+\/statement/.test(pathname)) {
  const supplierId = decodeURIComponent(pathname.split('/')[3]);
  const suppliers = loadJF(SUPPLIERS_FILE, []);
  const supplier = suppliers.find(s => s.id === supplierId);
  if (!supplier) { sendJSON(res, 404, {error:'Supplier not found'}); return; }
  
  const pos = loadJF(PURCHASE_ORDERS_FILE, []).filter(p => p.supplier_id === supplierId);
  const payments = loadJF(SUPPLIER_PAYMENTS_FILE, []).filter(p => p.supplier_id === supplierId);
  
  // Build transaction list
  const transactions = [];
  pos.forEach(po => {
    transactions.push({
      date: po.created_at,
      type: 'purchase',
      ref: po.po_number,
      description: `Purchase Order (${po.line_items.length} items)`,
      debit: po.total,  // We owe them
      credit: 0,
      balance: 0  // Will calculate
    });
  });
  payments.forEach(pmt => {
    transactions.push({
      date: pmt.created_at,
      type: 'payment',
      ref: pmt.id,
      description: pmt.description || 'Payment',
      debit: 0,
      credit: pmt.amount,  // We paid them
      balance: 0
    });
  });
  
  // Sort by date
  transactions.sort((a, b) => a.date.localeCompare(b.date));
  
  // Calculate running balance (positive = we owe them)
  let running = 0;
  transactions.forEach(t => { running += t.debit - t.credit; t.balance = running; });
  
  const totalPurchased = pos.reduce((s, p) => s + p.total, 0);
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);
  const balance = totalPurchased - totalPaid;
  
  sendJSON(res, 200, {
    supplier,
    transactions,
    total_purchased: totalPurchased,
    total_paid: totalPaid,
    balance,
    po_count: pos.length,
    payment_count: payments.length
  });
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/supplier-payments') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    const payments = loadJF(SUPPLIER_PAYMENTS_FILE, []);
    const suppliers = loadJF(SUPPLIERS_FILE, []);
    const supplier = suppliers.find(s => s.id === data.supplier_id);
    if (!supplier) { sendJSON(res, 404, {error:'Supplier not found'}); return; }
    const payment = {
      id: genId('PMT'),
      supplier_id: supplier.id,
      supplier_name: supplier.name,
      date: data.date || new Date().toISOString().slice(0,10),
      amount: Number(data.amount) || 0,
      method: data.method || 'Bank Transfer',
      description: data.description || '',
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    };
    payments.push(payment);
    saveJF(SUPPLIER_PAYMENTS_FILE, payments);
    logActivity('supplier_payment', `Payment of $${payment.amount.toFixed(2)} to ${supplier.name}`, data.user, payment.id);
    sendJSON(res, 200, {ok:true, payment});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/supplier-payments/')) {
  const pmtId = decodeURIComponent(pathname.split('/').pop());
  const payments = loadJF(SUPPLIER_PAYMENTS_FILE, []);
  saveJF(SUPPLIER_PAYMENTS_FILE, payments.filter(p => p.id !== pmtId));
  sendJSON(res, 200, {ok:true});
  return;
}


// ---------- STOCK WRITE-OFFS (Damaged/Lost/Stolen/Expired/Sample) ----------

const WRITEOFFS_FILE = path.join(__dirname, 'stock_writeoffs.json');

if (req.method === 'GET' && pathname === '/msolpeptides-api/stock-writeoffs') {
  const writeoffs = loadJF(WRITEOFFS_FILE, []);
  sendJSON(res, 200, writeoffs.sort((a,b) => b.created_at.localeCompare(a.created_at)));
  return;
}

if (req.method === 'POST' && pathname === '/msolpeptides-api/stock-writeoffs') {
  readBody(req, (err, data) => {
    if (err) { sendJSON(res, 400, {error:'Bad request'}); return; }
    // Phase 6 (2026-09-05): the catalog goes through readProducts/writeProducts like every other writer — a broken
    // products-data.json is answered with 503 and never overwritten (loadJF/saveJF skipped that guard).
    const products = readProducts();
    if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
    const product = products.find(p => p.id === data.product_id || p.slug === data.product_id);
    if (!product) { sendJSON(res, 404, {error:'Product not found'}); return; }
    const qty = Number(data.quantity) || 0;
    if (qty <= 0) { sendJSON(res, 400, {error:'Quantity must be greater than 0'}); return; }
    const validReasons = ['damaged','expired','lost','stolen','sample'];
    const reason = validReasons.includes(data.reason) ? data.reason : 'damaged';

    const writeoff = {
      id: genId('WO'),
      product_id: product.id,
      product_name: product.name,
      product_slug: product.slug,
      quantity: qty,
      reason,
      date: data.date || new Date().toISOString().slice(0,10),
      notes: data.notes || '',
      cost_impact: (product.cost || 0) * qty,
      user: data.user || 'unknown',
      created_at: new Date().toISOString()
    };

    // Phase 7 (2026-09-06): journal first, catalog second. If the catalog write fails the journal entry is rolled
    // back; if even the rollback fails what is left is a visible writeoff record without the stock change - noticeable
    // and fixable - whereas the old order left a silently reduced stock with no record of why.
    const writeoffs = loadJF(WRITEOFFS_FILE, []);
    const before = writeoffs.slice();
    writeoffs.push(writeoff);
    saveJF(WRITEOFFS_FILE, writeoffs);

    // Decrement stock
    product.stock_qty = Math.max(0, (product.stock_qty || 0) - qty);
    try {
      writeProducts(products);
    } catch (e) {
      try { saveJF(WRITEOFFS_FILE, before); } catch (e2) { console.error('[stock-writeoffs] journal rollback failed:', e2.message); }
      console.error('[stock-writeoffs] catalog write failed, writeoff ' + writeoff.id + ' rolled back:', e.message);
      sendJSON(res, 500, {error:'Could not update stock'}); return;
    }

    logActivity('stock_writeoff', `${qty}x ${product.name} written off (${reason})`, writeoff.user, writeoff.id);
    sendJSON(res, 200, {ok:true, writeoff, new_stock_qty: product.stock_qty});
  });
  return;
}

if (req.method === 'DELETE' && pathname.startsWith('/msolpeptides-api/stock-writeoffs/')) {
  const woId = decodeURIComponent(pathname.split('/').pop());
  const writeoffs = loadJF(WRITEOFFS_FILE, []);
  const wo = writeoffs.find(w => w.id === woId);
  // Phase 7 (2026-09-06): mirror of the POST above - the journal is written first and rolled back (writeoffs is
  // never mutated here, so it is the pre-delete state) if restoring the stock fails. An unknown id still answers 200.
  let products = null, product = null;
  if (wo) {
    // Restore stock
    products = readProducts();   // phase 6: same guard as the POST above
    if (catalogUnreadable) { sendJSON(res, 503, {error:'Product catalog temporarily unavailable'}); return; }
    product = products.find(p => p.id === wo.product_id);
  }
  saveJF(WRITEOFFS_FILE, writeoffs.filter(w => w.id !== woId));
  if (product) {
    product.stock_qty = (product.stock_qty || 0) + wo.quantity;
    try {
      writeProducts(products);
    } catch (e) {
      try { saveJF(WRITEOFFS_FILE, writeoffs); } catch (e2) { console.error('[stock-writeoffs] journal rollback failed:', e2.message); }
      console.error('[stock-writeoffs] catalog write failed, deletion of ' + wo.id + ' rolled back:', e.message);
      sendJSON(res, 500, {error:'Could not update stock'}); return;
    }
  }
  sendJSON(res, 200, {ok:true});
  return;
}

    res.setHeader('Content-Type', 'application/json');
  res.writeHead(404); res.end(JSON.stringify({error:'Not found'}));
}

// ── Phase 0 (2026-09-04): single auth gate in front of every route ──
// Public storefront routes (no auth): GET products, POST notify-order (+ its GET 405 stub), POST contact.
// POST /orders is used by the old checkout on mastersol-ltd.com/MSOLPEPTIDES/ — kept public, flagged in the phase 0 report.
const PUBLIC_ROUTES = new Set([
  'GET /msolpeptides-api/products',
  'POST /msolpeptides-api/notify-order',
  'GET /msolpeptides-api/notify-order',
  'POST /msolpeptides-api/contact',
  'POST /msolpeptides-api/subscribe',
  'POST /msolpeptides-api/orders',
  'POST /msolpeptides-api/track',
  'GET /msolpeptides-api/track',
  'POST /msolpeptides-api/checkout-identify',
  'GET /msolpeptides-api/checkout-identify'
  ,'POST /msolpeptides-api/coupon-quote',
  'GET /msolpeptides-api/coupon-quote',
  'GET /msolpeptides-api/site-copy',
  'GET /msolpeptides-api/stock-status',            // restock (2026-09-30): out-of-stock list, no numbers
  'POST /msolpeptides-api/restock-subscribe',
  'GET /msolpeptides-api/restock-unsubscribe',          // the page with the button; the POST cancels
  'POST /msolpeptides-api/restock-unsubscribe'
]);
function routeKey(req) { return req.method + ' ' + String(req.url || '').split('?')[0]; }
function isPublicRoute(req) { return PUBLIC_ROUTES.has(routeKey(req)); }

// Body limits: 64 KB for JSON bodies, 1 MB for the whole-catalog save, 5 MB for image upload (multipart).
// nginx always forwards a Content-Length (it buffers request bodies), so a missing header is refused with 411.
const BODY_LIMIT_DEFAULT = 64 * 1024;
const BODY_LIMIT_CATALOG = 1024 * 1024;
const BODY_LIMIT_UPLOAD = 5 * 1024 * 1024;
function bodyLimitFor(req) {
  const url = String(req.url || '').split('?')[0];
  if (url.startsWith('/msolpeptides-api/upload-image')) return BODY_LIMIT_UPLOAD;
  if (req.method === 'POST' && url === '/msolpeptides-api/track') return TRACK_BODY_LIMIT;   // shop stage 3: a cart event is a few hundred bytes
  if (req.method === 'POST' && url === '/msolpeptides-api/checkout-identify') return CHECKOUT_ID_BODY_LIMIT;
  if (req.method === 'POST' && url === '/msolpeptides-api/coupon-quote') return QUOTE_BODY_LIMIT;
  if (req.method === 'POST' && url === '/msolpeptides-api/products') return BODY_LIMIT_CATALOG;
  return BODY_LIMIT_DEFAULT;
}
// Returns false after answering 413/411 when the body must not be read.
function enforceBodyLimit(req, res) {
  if (!['POST', 'PUT', 'PATCH'].includes(req.method)) return true;
  const declared = Number(req.headers['content-length']);
  if (!Number.isFinite(declared)) { req.resume(); jsonReply(res, 411, {error:'Content-Length required'}); return false; }
  if (declared > bodyLimitFor(req)) { req.resume(); jsonReply(res, 413, {error:'Request body too large'}); return false; }
  return true;
}

function secretMatches(header) {
  if (!ADMIN_SECRET || typeof header !== 'string') return false;
  const a = Buffer.from(header), b = Buffer.from(ADMIN_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Bearer tokens are CRM sessions issued by blitz-api; verified via GET /api/session, positive answers cached 60 s.
// Phase 5 (2026-09-05): the answer of that check is now read (not only its status), so the caller's role reaches the
// gate, and a session check that could not run at all is told apart from a session the backend rejected (503 vs 401).
const SESSION_CHECK = { host: '127.0.0.1', port: 3001, path: '/api/session' };
const SESSION_BODY_LIMIT = 16 * 1024;  // a session answer is a few hundred bytes; anything larger is a broken backend
const SESSION_CACHE_TTL_MS = 60 * 1000;
const SESSION_NEG_TTL_MS = 10 * 1000; // phase 1: a definite "no" from blitz-api is remembered briefly (errors are not)
const sessionCache = new Map(); // token -> { ok, role, until }
// Phase 5: cb(ok, role, reason). role is 'admin' | 'staff' when ok, null otherwise; any role that is not 'admin'
// (including the legacy 'user') counts as staff. reason === 'unavailable' means the check itself failed — transport
// error, timeout or an unreadable answer — which is not a rejected session and must not log the user out.
// Phase 5 (2026-09-05): opts.fresh skips *reading* the cache (the answer is still stored). Admin decisions pass it, so a
// role changed by PATCH /api/users/:email on blitz-api applies at once instead of up to a minute later; blitz-api keeps
// the session alive on a role change, and these are a few requests a day.
function isAuthorized(req, cb, opts) {
  if (secretMatches(req.headers['x-admin-secret'])) { req.crmEmail = 'x-admin-secret'; return cb(true, 'admin'); }
  const h = req.headers['authorization'];
  if (typeof h !== 'string' || !h.startsWith('Bearer ')) return cb(false, null);
  const token = h.slice(7).trim();
  if (!/^[A-Za-z0-9._~+\/=-]{16,256}$/.test(token)) return cb(false, null);
  const hit = (opts && opts.fresh) ? null : sessionCache.get(token);
  if (hit && hit.until > Date.now()) {
    if (hit.ok) req.crmEmail = hit.email || '';
    return cb(hit.ok, hit.role || null);
  }
  let done = false;
  const finish = (ok, role, reason) => { if (done) return; done = true; cb(ok, role || null, reason); };
  const remember = (ok, role, email) => {
    if (sessionCache.size > 500) {
      for (const [k, v] of sessionCache) { if (v.until <= Date.now()) sessionCache.delete(k); }
      if (sessionCache.size > 2000) sessionCache.clear(); // flood of unique tokens on the public route: start over
    }
    sessionCache.set(token, { ok, role, email: email || '', until: Date.now() + (ok ? SESSION_CACHE_TTL_MS : SESSION_NEG_TTL_MS) });
    if (ok) req.crmEmail = email || '';
  };
  const r = http.request({
    host: SESSION_CHECK.host, port: SESSION_CHECK.port, path: SESSION_CHECK.path, method: 'GET',
    headers: { 'Authorization': 'Bearer ' + token }, timeout: 3000
  }, resp => {
    // Phase 5 (2026-09-05): only 401 and 403 are a definite "no". Any other non-200 — 429 from the blitz-api rate limit
    // (every check goes out from 127.0.0.1 and shares one bucket), 5xx from a broken users.json — means the check could
    // not run: answer 503 and remember nothing, otherwise a live session would be cached as rejected for 10 s and the
    // page would log its user out.
    if (resp.statusCode !== 200) {
      resp.resume();
      if (resp.statusCode === 401 || resp.statusCode === 403) { remember(false, null); finish(false, null); return; }  // a definite "no"
      console.error('[auth] session check answered ' + resp.statusCode + ', treated as unavailable');
      finish(false, null, 'unavailable');
      return;
    }
    let body = '', tooBig = false;
    resp.setEncoding('utf8');
    resp.on('data', c => {
      if (tooBig) return;
      body += c;
      if (body.length > SESSION_BODY_LIMIT) {
        // the whole answer can arrive in one chunk, so refuse it here — 'end' would otherwise parse it anyway
        tooBig = true;
        console.error('[auth] session check answer over ' + SESSION_BODY_LIMIT + ' bytes, treated as unavailable');
        resp.destroy();
        finish(false, null, 'unavailable');
      }
    });
    resp.on('error', () => finish(false, null, 'unavailable'));
    resp.on('end', () => {
      if (tooBig) return;
      let role = null;
      let email = '';
      try {
        const json = JSON.parse(body);
        if (json && typeof json === 'object' && json.user && typeof json.user === 'object') {
          role = json.user.role === 'admin' ? 'admin' : 'staff';
          if (typeof json.user.email === 'string') email = json.user.email;
        }
      } catch (e) { /* unreadable answer — handled right below */ }
      if (!role) { console.error('[auth] session check answered 200 without a readable user'); finish(false, null, 'unavailable'); return; }
      remember(true, role, email);
      finish(true, role);
    });
  });
  r.on('timeout', () => r.destroy(new Error('session check timeout')));
  r.on('error', e => { console.error('[auth] session check failed:', e.message); finish(false, null, 'unavailable'); });
  r.end();
}

// Phase 5 (2026-09-05): STAFF_WRITES = sales-ops. A staff session runs the sales desk (orders, customers, sales,
// quotations, suppliers, purchase-orders, expenses/income, stock moves); the catalog itself is admin-only. These are
// exactly the routes that rewrite product records or drop a file into product-images/.
// 2026-09-05 (owner): STAFF_WRITES = all. The team is small and everyone is equal, so a staff session may write the
// catalog too (the Stock button in Inventory saves through PUT /products). Flip back to 'sales-ops' to make the
// catalog admin-only again; the route list below is kept for that. User management (blitz-api) stays admin-only.
const STAFF_WRITES = 'all';
function requiresAdmin(req) {
  if (STAFF_WRITES === 'all') return false;
  const url = String(req.url || '').split('?')[0];
  if (req.method === 'POST' && url === '/msolpeptides-api/products') return true;                                    // whole-catalog save
  if ((req.method === 'PUT' || req.method === 'DELETE') && url.startsWith('/msolpeptides-api/products/')) return true; // single product
  if (req.method === 'POST' && url.startsWith('/msolpeptides-api/upload-image')) return true;                        // product image
  return false;
}

function safeHandle(req, res) {
  try { handleRequest(req, res); }
  catch (e) {
    console.error('[api] unhandled error on ' + routeKey(req) + ':', e && e.stack || e);
    if (!res.headersSent) jsonReply(res, 500, {error:'Internal error'});
  }
}

// Card import (2026-09-27): approved card payments (BLR-) and price requests (QT-) from the payment module's store
// become CRM orders. The store belongs to the agents' sidecar /opt/crm-umg and is only read here. Source:
// services/card-import/ in biofirst-hosting; spec docs/superpowers/specs/2026-09-27-card-orders-into-crm-design.md.
// CARD_IMPORT_MODE (off|dry|on) and CARD_IMPORT_EVENTS_SINCE live in ENV_FILE; a change needs a restart.
// A missing module must not take the catalog down with it: the error goes to the log, ops-watch forwards it.
const CARD_IMPORT_SOURCE = '/var/lib/crm-umg/store.json';
// Review round 2, HIGH: every ref this import ever created, so a delete in CRM stays deleted across a pm2 restart
// (mergeInto's seen/deleted, card-import.cjs) — otherwise memSeen resets to empty and the next tick recreates it,
// firing order_placed again for a live payment. F2: 0600 on every write (writeSeen below), not just at deploy
// time — writeJsonAtomic on its own only ever creates a new file 0644 and keeps an existing file's mode as is.
const CARD_IMPORT_SEEN = path.join(__dirname, 'card-import-seen.json');
let cardImport = null;
try {
  const cardEnv = readEnvFile(ENV_FILE);
  // Crypto import (2026-09-30): the two things a manager's PATCH to paid does - the status event, then the letter - for an order
  // the import has just marked paid. Each in its own try like the PATCH route: a queue that is down must not undo a booking
  // that is already saved. A test order sends nothing (the import skips it too). statusChanged false = the manager was first
  // and the event went out then; only the letter is asked for again (it has its own once-per-order mark).
  const cryptoPaidNotify = (order, all, statusChanged) => {
    if (!order || order.test === true) return;
    if (statusChanged) {
      try { if (mailOutbox && order.ref) mailOutbox.enqueue('cio_order_status', order.ref, {status: 'paid'}); else cioTrackWithProfile(order.customer && order.customer.email, 'order_status_changed', {ref: mailSafe(cleanStr(order.ref, 64)), status: mailSafe('paid')}, order.ref, {orders: all, source: 'order'}); }
      catch (trackErr) { console.error('[cio-track] order_status_changed skipped: ' + ((trackErr && trackErr.message) || trackErr)); }
    }
    try { orderLettersOnStatus(order, 'paid'); } catch (letterErr) { console.error('[letters] ERROR status letter skipped: ' + ((letterErr && letterErr.message) || letterErr)); }
    tgAlertsOnStatus(order, 'paid');
  };
  cardImport = require('./card-import.cjs').createCardImport({
    mode: cardEnv.CARD_IMPORT_MODE,
    eventsSince: cardEnv.CARD_IMPORT_EVENTS_SINCE,
    intervalMs: Number(cardEnv.CARD_IMPORT_INTERVAL_MS) || 60000,
    readSource: () => fs.readFileSync(CARD_IMPORT_SOURCE, 'utf8'),
    readOrders: () => readJsonOrFallback(TRACK_ORDERS_FILE, []),
    writeOrders: (list) => writeJsonAtomic(TRACK_ORDERS_FILE, list),
    readSeen: () => readJsonOrFallback(CARD_IMPORT_SEEN, []),
    writeSeen: (list) => { writeJsonAtomic(CARD_IMPORT_SEEN, list); fs.chmodSync(CARD_IMPORT_SEEN, 0o600); },
    readProducts: () => readProducts(),
    sanitizeOrder: sanitizeOrder,
    priceCheck: priceCheck,
    discountFields: discountFields,
    isExcludedAddress: (email) => isExcludedIdentity(email),
    track: (order, all) => { tgAlertsOnCreated(order); if (mailOutbox && order.ref) { mailOutbox.enqueue('cio_order_placed', order.ref); orderLettersImported(order); } else cioTrackWithProfile(order.customer && order.customer.email, 'order_placed', orderPlacedData(order), order.ref, { orders: all, source: 'order', cartCleared: true }); },
    // Crypto import (2026-09-30): its own mode and its own start date, independent of CARD_IMPORT_*; a change needs a restart.
    cryptoMode: cardEnv.CRYPTO_IMPORT_MODE,
    cryptoSince: cardEnv.CRYPTO_IMPORT_SINCE,
    moneyDue: moneyDue,
    onCryptoPaid: (order, all, info) => cryptoPaidNotify(order, all, !!(info && info.statusChanged)),
    onCryptoCreated: (order, all) => {
      // The page never sent this order: what a card import does (order_placed and the confirmation letter), then what "paid" means.
      try { if (mailOutbox && order.ref) { mailOutbox.enqueue('cio_order_placed', order.ref); orderLettersImported(order); } else cioTrackWithProfile(order.customer && order.customer.email, 'order_placed', orderPlacedData(order), order.ref, { orders: all, source: 'order', cartCleared: true }); }
      catch (e) { console.error('[cio-track] order_placed skipped: ' + ((e && e.message) || e)); }
      tgAlertsOnCreated(order);
      cryptoPaidNotify(order, all, true);
    }
  });
  cardImport.start();
} catch (e) {
  console.error('[card-import] ERROR module not started: ' + ((e && e.message) || e));
}
// Mail outbox (2026-09-29): the order letters and the order_placed / order_status_changed events go through a queue with
// retries instead of one attempt whose result only reached the pm2 log (Customer.io refused everything from 27.09 and
// nobody noticed). The queue holds no personal data — kind and order ref; the letter or event is built from the order in
// orders.json when it is sent. Source: services/mail-outbox/ in biofirst-hosting. MAIL_OUTBOX_MODE (off|on) lives in
// ENV_FILE; a change needs a restart. off (or a module that fails to start) leaves the direct one-attempt path as it was.
const MAIL_OUTBOX_QUEUE = path.join(__dirname, 'mail-outbox.json');
const MAIL_OUTBOX_DEAD = path.join(__dirname, 'mail-outbox-dead.json');
// writeJsonAtomic creates a new file 0644 (see its comment); the queue and the dead list are 0600 from the first write.
function mailOutboxWrite(file, list) { writeJsonAtomic(file, list); fs.chmodSync(file, 0o600); }
// No empty-list fallback here (readJsonOrFallback turns a missing file into []): a missing or broken orders.json must
// read as "cannot look the order up, try again", not as "the order is gone, drop the letter".
function mailOutboxReadOrders() { return JSON.parse(fs.readFileSync(TRACK_ORDERS_FILE, 'utf8')); }
// An order the CRM has cancelled (or refunded) gets no confirmation letter; the manager's letter is not affected.
const MAIL_OUTBOX_NO_CUSTOMER_MAIL_RE = /^(cancelled|canceled|refunded|chargeback)$/;
function mailOutboxSend(item, order, cb) {
  const done = (ok, status, errorText) => cb({ ok: ok, status: status, error: errorText });
  const skipped = () => cb({ ok: true, status: 'skipped' });
  const ref = order.ref || '';
  if (item.kind === 'tg_contact') return tgContactSend(item, order, cb);   // tg-alerts: 'order' is the contact-form message here
  if (tgAlertsHandles(item.kind)) return tgAlertsSend(item, order, cb);   // tg-alerts: Telegram, not Customer.io
  if (item.kind === 'letter_restock') return restockSend(item, order, cb);   // restock: 'order' is the subscription record here
  if (orderLettersHandles(item.kind, order)) return orderLettersSend(item, order, cb);   // stage 1 RET: the four status letters and, with letters on, the confirmation
  if (item.kind === 'mail_manager') {
    if (!CIO_READY || !CIO_ORDER_MANAGER_MSG_ID || !CIO_MANAGER_TO) return skipped();
    cioSendEmail(CIO_ORDER_MANAGER_MSG_ID, CIO_MANAGER_TO, CIO_MANAGER_TO.split(',')[0], orderMessageData(order), 'manager', ref, done);
    return;
  }
  if (item.kind === 'mail_customer') {
    const to = order.customer && typeof order.customer.email === 'string' ? order.customer.email.trim() : '';
    if (!CIO_READY || !CIO_ORDER_CUSTOMER_MSG_ID || !looksLikeEmail(to)) return skipped();
    if (MAIL_OUTBOX_NO_CUSTOMER_MAIL_RE.test(String(order.status || '').trim().toLowerCase())) return skipped();
    cioSendEmail(CIO_ORDER_CUSTOMER_MSG_ID, to, to, orderMessageData(order), 'customer', ref, done);
    return;
  }
  // order_delivered (cio-events 2026-09-30): the profile was written by the status event queued just before this one.
  if (item.kind === 'cio_order_delivered') {
    const to = trackEmail(order.customer && order.customer.email);
    if (!CIO_TRACK_READY || !looksLikeEmail(to) || order.test === true) return skipped();
    cioTrackRequest('POST', '/api/v1/customers/' + encodeURIComponent(to) + '/events', { name: 'order_delivered', data: orderDeliveredData(order) },
      '[cio-track] order_delivered ' + cioTrackId(to, order.ref), undefined, done);
    return;
  }
  const isStatus = item.kind === 'cio_order_status';
  if (!isStatus && item.kind !== 'cio_order_placed') return done(false, 400, 'unknown kind');
  const addr = trackEmail(order.customer && order.customer.email);
  if (!CIO_TRACK_READY || !looksLikeEmail(addr)) return skipped();
  if (isStatus && order.test === true) return skipped();    // a sandbox card payment must not tell Customer.io about a status change
  const orders = mailOutboxReadOrders();
  // The profile first and the event second, as cioTrackWithProfile does; the outcome is the event's.
  cioTrackIdentify(addr, orderAttributesFor(addr, isStatus ? { orders: orders, source: 'order' } : { orders: orders, source: 'order', cartCleared: true }));
  const name = isStatus ? 'order_status_changed' : 'order_placed';
  const data = isStatus ? { ref: mailSafe(cleanStr(order.ref, 64)), status: mailSafe(item.data && item.data.status) } : orderPlacedData(order);
  cioTrackRequest('POST', '/api/v1/customers/' + encodeURIComponent(addr) + '/events', { name: name, data: data || {} },
    '[cio-track] ' + name + ' ' + cioTrackId(addr, order.ref), undefined, done);
}
let mailOutbox = null;
try {
  const outboxEnv = readEnvFile(ENV_FILE);
  const outboxMode = String(outboxEnv.MAIL_OUTBOX_MODE || '').trim().toLowerCase();
  if (outboxMode === 'on') {
    mailOutbox = require('./mail-outbox.cjs').createMailOutbox({
      readQueue: () => readJsonOrFallback(MAIL_OUTBOX_QUEUE, []),
      writeQueue: (list) => mailOutboxWrite(MAIL_OUTBOX_QUEUE, list),
      readDead: () => readJsonOrFallback(MAIL_OUTBOX_DEAD, []),
      writeDead: (list) => mailOutboxWrite(MAIL_OUTBOX_DEAD, list),
      readOrders: mailOutboxReadOrders,
      findRecord: (kind, ref) => kind === 'tg_contact' ? tgContactFind(ref) : restockFind(ref),   // restock (2026-09-30): the record of a letter_restock item is a subscription
      send: mailOutboxSend,
      intervalMs: Number(outboxEnv.MAIL_OUTBOX_INTERVAL_MS) || 60000
    });
    mailOutbox.start();
  } else {
    if (outboxMode && outboxMode !== 'off') console.error('[mail-outbox] ERROR unknown MAIL_OUTBOX_MODE ' + JSON.stringify(outboxMode) + ', queue is off');
    console.log('[mail-outbox] off');
  }
} catch (e) {
  mailOutbox = null;
  console.error('[mail-outbox] ERROR module not started: ' + ((e && e.message) || e));
}
// Stage 1 RET (2026-09-30): status letters to the buyer. Which letter a status means, who may get it and which fields go
// into its Customer.io template are decided in order-letters.cjs (services/order-letters/ in biofirst-hosting); the TEXT
// of every letter is a transactional template in Customer.io that the team edits from the CRM Emails page. Letters go
// through the mail queue only and are recorded on the order (order.letters.<type>.sentAt) so a status set twice, or a
// restart, cannot send one twice. ORDER_LETTERS_MODE (off|test|on), ORDER_LETTERS_SINCE and ORDER_LETTERS_TEST_TO live in
// ENV_FILE; a change needs a restart. off (or a module that fails to start) leaves everything as it was before this stage.
let orderLetters = null;
let ORDER_LETTERS_CFG = { mode: 'off' };
let ORDER_LETTERS_IDS = {};
let ORDER_CARRIER_LIST = 'FedEx, USPS, UPS, DHL, Other';   // the same list as the module's; kept here so the CRM card still saves if the module did not start
try {
  const lettersEnv = readEnvFile(ENV_FILE);
  orderLetters = require('./order-letters.cjs');
  ORDER_CARRIER_LIST = orderLetters.CARRIERS.join(', ');
  const lettersCfg = orderLetters.parseConfig(lettersEnv);
  for (const p of lettersCfg.problems) console.error('[letters] ERROR ' + p);
  if (lettersCfg.mode !== 'off' && !mailOutbox) { console.error('[letters] ERROR outbox off (MAIL_OUTBOX_MODE is not on), letters are off'); lettersCfg.mode = 'off'; }
  const lettersIds = orderLetters.templateIds(lettersEnv, process.env);
  ORDER_LETTERS_IDS = lettersIds.ids;
  if (lettersCfg.mode !== 'off') for (const t of lettersIds.missing) console.error('[letters] ERROR no template id for ' + t);
  lettersCfg.isTestOrder = isTestOrderRef;
  lettersCfg.isExcluded = (email) => isExcludedIdentity(email);
  lettersCfg.looksLikeEmail = looksLikeEmail;
  // Crypto import (2026-09-30): with the import running in mode on, the paid letter of a crypto order needs its blockchain booking;
  // with it off or in dry a manager's paid sends the letter as before.
  lettersCfg.requireCryptoProof = !!(cardImport && typeof cardImport.cryptoMode === 'function' && cardImport.cryptoMode() === 'on');
  ORDER_LETTERS_CFG = lettersCfg;
  console.log('[letters] ' + lettersCfg.mode + (lettersCfg.mode !== 'off' ? ', since ' + new Date(lettersCfg.sinceMs).toISOString() : ''));
} catch (e) {
  orderLetters = null;
  ORDER_LETTERS_CFG = { mode: 'off' };
  console.error('[letters] ERROR module not started: ' + ((e && e.message) || e));
}
function orderLettersCanonicalCarrier(v) {
  if (orderLetters) return orderLetters.canonicalCarrier(v);
  const want = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return ORDER_CARRIER_LIST.split(', ').find(c => c.toLowerCase() === want) || '';
}
function orderLettersTrackingProblem(status, update, order) { return orderLetters ? orderLetters.trackingProblem(status, update, order) : ''; }
function orderLettersHandles(kind, order) {
  if (!orderLetters) return false;
  if (orderLetters.LETTER_KINDS.includes(kind)) return true;          // queued items are answered even after a switch to off (skipped)
  if (kind !== 'mail_customer' || ORDER_LETTERS_CFG.mode === 'off') return false;
  // test mode: only the listed addresses get the new confirmation; every other buyer keeps the letter they get with letters off
  return ORDER_LETTERS_CFG.mode === 'on' || orderLetters.recipientListed(order, ORDER_LETTERS_CFG);
}
// The decision and the queueing in one place: what is not allowed leaves one log line (never an address) and no item.
function orderLettersQueue(order, type) {
  if (!orderLetters || ORDER_LETTERS_CFG.mode === 'off' || !mailOutbox || !order || !order.ref) return false;
  const verdict = orderLetters.letterAllowed(order, type, ORDER_LETTERS_CFG);
  const ref = orderLetters.safeRef(order.ref);
  if (!verdict.ok) {
    console.log('[letters] ' + (verdict.reason === 'not_test_recipient' ? 'would send ' + type + ' ' + ref : 'skip ' + type + ' ' + ref + ': ' + verdict.reason));
    return false;
  }
  if (!ORDER_LETTERS_IDS[type]) { console.log('[letters] skip ' + type + ' ' + ref + ': no template id'); return false; }
  return mailOutbox.enqueue(orderLetters.kindForType(type), order.ref);
}
// notify-order: the customer letter as before (letters off), or through the rules, and never for a card method: a card
// order reaches the CRM from the payment import, which sends its own confirmation, and a method string from a page is no proof.
function orderLettersConfirm(order) {
  // letters off, or test mode and this buyer is not on the list: the letter goes as it did before this stage (a real buyer must not lose it)
  if (!orderLetters || ORDER_LETTERS_CFG.mode === 'off' || (ORDER_LETTERS_CFG.mode === 'test' && !orderLetters.recipientListed(order, ORDER_LETTERS_CFG))) { mailOutbox.enqueue('mail_customer', order.ref); return; }
  if (/^card/i.test(String(order.paymentMethod || '').trim())) { console.log('[letters] skip confirmation ' + orderLetters.safeRef(order.ref) + ': card orders come from the payment import'); return; }
  orderLettersQueue(order, 'confirmation');
}
// card import: the order is already on file (the payment import writes it before this runs). No paid letter is queued for a card
// order at all (letterAllowed: covered_by_confirmation), so nothing has to be marked here.
function orderLettersImported(order) {
  if (!orderLetters || ORDER_LETTERS_CFG.mode === 'off') return;
  orderLettersQueue(order, 'confirmation');
}
// PATCH: a status change that means a letter. The order has been saved already, the letter is built from the file.
function orderLettersOnStatus(order, status) {
  if (!orderLetters || ORDER_LETTERS_CFG.mode === 'off') return;
  const type = orderLetters.letterTypeForStatus(status);
  if (type) orderLettersQueue(order, type);
}
// After a 2xx: note it on the order. updated_at is left alone (a manager's open edit must not turn into a conflict).
function orderLettersMark(ref, type) {
  try {
    const orders = mailOutboxReadOrders();
    const found = orders.find(o => o && o.ref === ref);
    if (!found) return;
    orderLetters.markLetter(found, type, { sentAt: new Date().toISOString() });
    writeJsonAtomic(TRACK_ORDERS_FILE, orders);
  } catch (e) { console.error('[mail-alert] LETTER NOT RECORDED ' + type + ' ' + orderLetters.safeRef(ref) + ' was sent but not marked on the order (a status set again could send it twice): ' + ((e && e.message) || e)); }
}
// The queue's sender for these kinds. The order comes from orders.json as it is now, so the rules are checked again here
// (cancelled meanwhile, already sent, letters switched off); what may not go answers skipped, never a failure to retry.
function orderLettersSend(item, order, cb) {
  const skipped = () => cb({ ok: true, status: 'skipped' });
  const type = orderLetters.typeForKind(item.kind);
  const ref = orderLetters.safeRef(order.ref);
  const verdict = orderLetters.letterAllowed(order, type, ORDER_LETTERS_CFG);
  if (!verdict.ok) {
    console.log('[letters] ' + (verdict.reason === 'not_test_recipient' ? 'would send ' + type + ' ' + ref : 'skip ' + type + ' ' + ref + ': ' + verdict.reason));
    return skipped();
  }
  const id = ORDER_LETTERS_IDS[type];
  if (!CIO_READY || !id) return skipped();
  const to = order.customer.email.trim();
  let data;
  try { data = orderLetters.letterData(order, type, { mailSafe: mailSafe }); }
  catch (e) { return cb({ ok: false, status: 'not_built', error: 'letter data: ' + ((e && e.message) || e) }); }
  cioSendEmail(id, to, to, data, 'letter-' + type, ref, (ok, status, errorText) => {
    if (ok) orderLettersMark(order.ref, type);
    cb({ ok: ok, status: status, error: errorText });
  });
}
// Telegram business alerts (2026-09-30): the team's group hears about a new order (shop, card, price request, crypto) and a
// payment received, once per order each (order.alerts.<type>.sentAt). Rules and text in tg-alerts.cjs (services/tg-alerts/
// in biofirst-hosting); sent through the mail queue, so an outage is retried and ends in the dead list with a [mail-alert] line
// that ops-watch forwards to the technical group. TG_ALERTS_MODE (off|on), TG_ALERTS_SINCE, TG_ALERTS_BOT_TOKEN,
// TG_ALERTS_CHAT_ID and TG_ALERTS_BIG_USD live in ENV_FILE; a change needs a restart. No name, address or e-mail goes out.
let tgAlerts = null;
let TG_ALERTS_CFG = { mode: 'off' };
try {
  tgAlerts = require('./tg-alerts.cjs');
  const tgCfg = tgAlerts.parseConfig(readEnvFile(ENV_FILE));
  // [mail-alert]: ops-watch forwards these to the technical group, so a broken env line cannot switch the alerts off unnoticed.
  for (const p of tgCfg.problems) console.error('[mail-alert] TG ALERTS ' + (tgCfg.mode === 'off' ? 'OFF: ' : 'CONFIG: ') + p);
  if (tgCfg.mode !== 'off' && !mailOutbox) { console.error('[mail-alert] TG ALERTS OFF: outbox off (MAIL_OUTBOX_MODE is not on)'); tgCfg.mode = 'off'; }
  tgCfg.isTestOrder = isTestOrderRef;
  tgCfg.isExcluded = (email) => isExcludedIdentity(email);
  TG_ALERTS_CFG = tgCfg;
  console.log('[tg-alerts] ' + tgCfg.mode + (tgCfg.mode !== 'off' ? ', since ' + new Date(tgCfg.sinceMs).toISOString() + ', big order from $' + tgCfg.bigUsd : ''));
} catch (e) {
  tgAlerts = null;
  TG_ALERTS_CFG = { mode: 'off' };
  console.error('[mail-alert] TG ALERTS OFF: module not started: ' + ((e && e.message) || e));
}
function tgAlertsQueue(order, type) {
  try {
    if (!tgAlerts || TG_ALERTS_CFG.mode === 'off' || !mailOutbox || !order || !order.ref) return false;
    const verdict = tgAlerts.alertAllowed(order, type, TG_ALERTS_CFG);
    if (!verdict.ok) { console.log('[tg-alerts] skip ' + type + ' ' + tgAlerts.safeRef(order.ref) + ': ' + verdict.reason); return false; }
    return mailOutbox.enqueue(tgAlerts.KIND[type], order.ref);
  } catch (e) { console.error('[tg-alerts] ERROR not queued: ' + ((e && e.message) || e)); return false; }
}
// notify-order and the card / crypto import: the order is on file already.
// A new order that is already paid (a card import) is one alert: it says "paid" and marks the payment too (option B, 30.09).
function tgAlertsOnCreated(order) { return tgAlertsQueue(order, 'order'); }
// PATCH and the crypto import: the order has been saved with its new status; only a paid status means an alert.
function tgAlertsOnStatus(order, status) {
  if (!tgAlerts || !tgAlerts.PAID_STATUSES.includes(String(status || '').trim().toLowerCase())) return false;
  return tgAlertsQueue(order, 'paid');
}
function tgAlertsHandles(kind) { return !!tgAlerts && tgAlerts.KINDS.includes(kind); }
// After a 2xx: note it on the order with where the message is (a payment replies to its order's message). updated_at is left alone.
function tgAlertsMark(ref, types, r) {
  try {
    const orders = mailOutboxReadOrders();
    const found = orders.find(o => o && o.ref === ref);
    if (!found) return;
    const rec = tgAlerts.sentRecord(r, TG_ALERTS_CFG);
    for (const t of types) tgAlerts.markAlert(found, t, rec);
    writeJsonAtomic(TRACK_ORDERS_FILE, orders);
  } catch (e) { console.error('[mail-alert] TG ALERT NOT RECORDED ' + types.join('+') + ' ' + tgAlerts.safeRef(ref) + ' was sent but not marked on the order (it could be sent again): ' + ((e && e.message) || e)); }
}
// The queue's sender for tg_* kinds. The order is orders.json as it is now, so the rules are asked again (cancelled or
// announced meanwhile, alerts switched off): what may not go answers skipped, never a failure to retry.
function tgAlertsSend(item, order, cb) {
  const skipped = () => cb({ ok: true, status: 'skipped' });
  const type = tgAlerts.typeForKind(item.kind);
  const verdict = tgAlerts.alertAllowed(order, type, TG_ALERTS_CFG);
  if (!verdict.ok) { console.log('[tg-alerts] skip ' + type + ' ' + tgAlerts.safeRef(order.ref) + ': ' + verdict.reason); return skipped(); }
  let msg;
  try { msg = tgAlerts.messageFor(order, type, { priorPaid: tgAlerts.priorPaidCount(order, mailOutboxReadOrders(), isTestOrderRef), bigUsd: TG_ALERTS_CFG.bigUsd }); }
  catch (e) { return cb({ ok: false, status: 'orders_unreadable', error: 'alert text: ' + ((e && e.message) || e) }); }
  const covered = tgAlerts.coveredTypes(order, type);
  tgAlerts.send(TG_ALERTS_CFG, msg, r => {
    if (r.ok) { tgAlertsMark(order.ref, covered, r); console.log('[tg-alerts] sent ' + covered.join('+') + ' ' + tgAlerts.safeRef(order.ref) + (msg.replyTo ? ' as a reply' : '')); }
    // The alert reached the group but not as meant: plain text (the rich layout needs fixing) or General (its topic is gone).
    if (r.ok && r.richRefused) console.error('[mail-alert] TG RICH REFUSED ' + tgAlerts.safeRef(order.ref) + ', sent as plain text: ' + r.richRefused);
    cb({ ok: r.ok, status: r.status, error: r.error });
  });
}
// Restock alerts (2026-09-30): "notify me when it is back in stock". The rules are in restock.cjs (services/restock/ in
// biofirst-hosting; spec docs/superpowers/specs/2026-09-30-restock-alerts.md). Here: the routes, the files and the letter.
// restock-subscriptions.json (0600) holds the subscriptions; restock-meta.json (0600) the random salt and the hashes of addresses
// that unsubscribed (the refusal is kept, the address is not). tg-stock.cjs (cron, hourly) writes the stock state to
// TG_STOCK_STATUS_FILE; this process only reads it. A subscription is taken only for a key that is out now. The letter goes through
// the mail queue (kind letter_restock) to a Customer.io transactional template, once per subscription (status sent + sentAt).
// RESTOCK_MODE (off|test|on), CIO_LETTER_RESTOCK_MSG_ID and ORDER_LETTERS_TEST_TO live in ENV_FILE; a change needs a restart.
// With off (or a module that fails to start) no letter is ever sent. No address goes to a log line.
let restock = null;
let RESTOCK_CFG = { mode: 'off', testTo: new Set() };
let RESTOCK_ID = '';
const RESTOCK_FILE = path.join(__dirname, 'restock-subscriptions.json');
const RESTOCK_META_FILE = path.join(__dirname, 'restock-meta.json');
const RESTOCK_STATUS_FILE = String(process.env.TG_STOCK_STATUS_FILE || readEnvFile(ENV_FILE).TG_STOCK_STATUS_FILE || '/var/lib/biolabs-ops/stock-status.json');
const restockSentIds = new Set();        // sent by this process: a record that could not be marked must not go out again
const restockWouldLogged = new Set();    // test mode: "would send" once per subscription, not every tick
const restockCapAlertAt = {};            // one [mail-alert] RESTOCK CAP per kind and hour
let restockStatusReason = '';            // why the stock file is not believed, logged when it changes
let restockTickFailed = false;
try {
  const restockEnv = readEnvFile(ENV_FILE);
  restock = require('./restock.cjs');
  const restockCfg = restock.parseConfig(restockEnv);
  for (const p of restockCfg.problems) console.error('[restock] ERROR ' + p);
  if (restockCfg.mode !== 'off' && !mailOutbox) { console.error('[restock] ERROR outbox off (MAIL_OUTBOX_MODE is not on), letters are off'); restockCfg.mode = 'off'; }
  RESTOCK_ID = restock.templateId(restockEnv, process.env);
  if (restockCfg.mode !== 'off' && !RESTOCK_ID) console.error('[restock] ERROR no template id (CIO_LETTER_RESTOCK_MSG_ID), letters wait');
  RESTOCK_CFG = restockCfg;
  console.log('[restock] ' + restockCfg.mode);
  const restockEvery = Number(restockEnv.RESTOCK_INTERVAL_MS) > 0 ? Number(restockEnv.RESTOCK_INTERVAL_MS) : 5 * 60 * 1000;
  const restockFirst = setTimeout(restockTick, Math.min(15000, restockEvery));
  const restockTimer = setInterval(restockTick, restockEvery);
  if (restockFirst.unref) restockFirst.unref();
  if (restockTimer.unref) restockTimer.unref();
} catch (e) {
  restock = null;
  RESTOCK_CFG = { mode: 'off', testTo: new Set() };
  console.error('[restock] ERROR module not started: ' + ((e && e.message) || e));
}
function restockErr(e) { return restock ? restock.safeId((e && e.message) || e) : 'error'; }
function restockContentType(req) { return String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase(); }
// nginx puts the visitor's address in X-Real-IP (and overwrites anything the visitor sent); this process listens on 127.0.0.1 only.
function restockClientIp(req) {
  const v = String(req.headers['x-real-ip'] || '').trim();
  if (/^[0-9a-fA-F:.]{3,45}$/.test(v)) return v;
  return String((req.socket && req.socket.remoteAddress) || '');
}
function restockReadList() {
  const list = readJsonOrFallback(RESTOCK_FILE, []);
  if (!Array.isArray(list)) throw new Error('restock-subscriptions.json is not an array');
  return list;
}
function restockWrite(list) { mailOutboxWrite(RESTOCK_FILE, list); }   // 0600, like the queue: the file holds addresses
function restockFind(ref) { return restockReadList().find(s => s && s.id === ref) || null; }
// The salt and the suppressed hashes. A missing file is made; a broken one throws (a new salt would silently forget every refusal).
function restockMeta() {
  const m = readJsonOrFallback(RESTOCK_META_FILE, null);
  if (m === null) {
    const made = { salt: crypto.randomBytes(16).toString('hex'), suppressed: [] };
    mailOutboxWrite(RESTOCK_META_FILE, made);
    return made;
  }
  if (!m || typeof m !== 'object' || typeof m.salt !== 'string' || !m.salt || !Array.isArray(m.suppressed)) throw new Error('restock-meta.json is malformed');
  return m;
}
function restockSuppressedCheck(meta) {
  const set = new Set(meta.suppressed);
  return (email) => set.has(restock.hashEmail(meta.salt, email));
}
function restockCapAlert(kind, text) {
  const now = Date.now();
  if (restockCapAlertAt[kind] && now - restockCapAlertAt[kind] < 3600 * 1000) return;
  restockCapAlertAt[kind] = now;
  console.error('[mail-alert] RESTOCK CAP ' + kind + ' ' + text);
}
// The stock file as it is now. Leaving a good state is logged once: with the mode on or test as an alert (no button, no letters until
// tg-stock writes a fresh file), with off as a plain line; coming back is "status fresh again".
function restockStatusNow(nowMs) {
  let raw;
  try { raw = fs.readFileSync(RESTOCK_STATUS_FILE, 'utf8'); } catch (e) { raw = undefined; }
  const st = restock.parseStatus(raw, nowMs);
  const reason = st.ok ? '' : st.reason;
  if (reason !== restockStatusReason) {
    const was = restockStatusReason;
    restockStatusReason = reason;
    if (!reason) console.log('[restock] status fresh again');
    else if (was) console.error('[restock] stock status still not usable (' + reason + ')');
    else if (RESTOCK_CFG.mode !== 'off') console.error('[mail-alert] RESTOCK STATUS STALE (' + reason + '): no button and no letters until tg-stock writes a fresh file');
    else console.error('[restock] stock status not usable (' + reason + ')');
  }
  return st;
}
function restockReplyStatus(res) {
  const out = restock ? restock.publicOut(restockStatusNow(Date.now())) : { out: [] };
  res.setHeader('Cache-Control', 'public, max-age=300');   // here, not in nginx: add_header in a location drops the server's security headers
  jsonReply(res, 200, out);
}
// Every answer to a good or a refused-quietly body is the same {ok:true}: the page never learns whether an address was known, excluded, suppressed, capped or in stock.
function restockReplySubscribe(req, res, data) {
  if (!restock) { jsonReply(res, 503, {error:'Unavailable'}); return; }
  const products = readProducts();
  if (catalogUnreadable) { jsonReply(res, 503, {error:'Unavailable'}); return; }
  try {
    const now = Date.now();
    const meta = restockMeta();
    const v = restock.validateSubscribe(data, { products: products, status: restockStatusNow(now), looksLikeEmail: looksLikeEmail, isExcluded: (email) => isExcludedIdentity(email), isSuppressed: restockSuppressedCheck(meta), cfg: RESTOCK_CFG });
    if (!v.ok) { jsonReply(res, 400, {error: v.error}); return; }
    if (v.ignore) { if (v.ignore === 'excluded') console.log('[restock] ignored an excluded address'); jsonReply(res, 200, {ok:true}); return; }
    const list = restockReadList();
    const r = restock.addSubscription(list, Object.assign({}, v.sub, { ipHash: restock.hashIp(meta.salt, restockClientIp(req)) }), now);
    if (r.result === 'created') { restockWrite(list); console.log('[restock] subscribed ' + r.sub.id + ' ' + r.sub.key); }
    else if (r.result === 'cap_email') console.error('[restock] CAP per address (' + restock.MAX_PENDING_PER_EMAIL + '), nothing written');
    else if (r.result === 'cap_ip') restockCapAlert('ip', 'one visitor made ' + restock.MAX_PER_IP_24H + ' new subscriptions in 24 h, more are not taken');
    else if (r.result === 'cap_total') restockCapAlert('total', restock.MAX_PENDING_TOTAL + ' pending subscriptions, new ones are not taken');
    jsonReply(res, 200, {ok:true});
  } catch (e) {
    console.error('[restock] ERROR subscription not saved: ' + restockErr(e));
    jsonReply(res, 500, {error:'Could not save, please try again'});
  }
}
// GET of the link in the letter: only a page with a button, nothing is cancelled (a mail scanner opens links). The token is echoed only if it has the shape of one.
function restockReplyUnsubscribePage(req, res) {
  if (!restock) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.writeHead(503); res.end('Please try again later.'); return; }
  let token = '';
  try { token = new URL(String(req.url || ''), 'http://localhost').searchParams.get('t') || ''; } catch (e) { token = ''; }
  restockHtml(res, restock.unsubscribePage(token));
}
function restockHtml(res, html) {
  // The token is in the address or the form, so nothing is cached or passed on.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.writeHead(200);
  res.end(html);
}
// POST of our own page's form (urlencoded, nothing else): the token of any record of the address cancels all its pending subscriptions and
// the address is remembered as a hash, so it cannot be subscribed again. The same page for a known, an unknown and a used token.
function restockReplyUnsubscribe(req, res) {
  if (restockContentType(req) !== 'application/x-www-form-urlencoded') { req.resume(); res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.writeHead(415); res.end('Unsupported Media Type'); return; }
  let body = '';
  req.on('data', c => { if (body.length < 4096) body += c; });
  req.on('end', () => {
    if (!restock) { res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.writeHead(503); res.end('Please try again later.'); return; }
    let token = '';
    try { token = new URLSearchParams(body).get('t') || ''; } catch (e) { token = ''; }
    try {
      const list = restockReadList();
      const hit = restock.findByToken(list, token);
      if (hit) {
        const meta = restockMeta();
        const hash = restock.hashEmail(meta.salt, hit.email);
        if (hash && !meta.suppressed.includes(hash)) { meta.suppressed.push(hash); mailOutboxWrite(RESTOCK_META_FILE, meta); }
        if (restock.unsubscribe(list, token, Date.now())) restockWrite(list);
        console.log('[restock] cancelled by the page');
      }
    } catch (e) {
      console.error('[restock] ERROR cancel not saved: ' + restockErr(e));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8'); res.writeHead(500); res.end('Please try again later.');
      return;
    }
    restockHtml(res, restock.unsubscribedPage());
  });
}
// Every 5 minutes: expire old subscriptions, drop finished ones older than 60 days, and queue the letter for each pending one whose item
// is in stock now. queuedAt is written BEFORE anything is queued (a crash in between means one letter less, never two), and a subscription
// whose item died in the queue is not queued again for 49 hours, so a refusing provider does not raise an alert every tick.
function restockTick() {
  try {
    if (!restock) return;
    const now = Date.now();
    const list = restockReadList();
    let dirty = restock.expireOld(list, now) > 0;
    if (restock.pruneFinished(list, now) > 0) dirty = true;
    let toQueue = [];
    if (RESTOCK_CFG.mode !== 'off' && mailOutbox && CIO_READY && RESTOCK_ID) {
      const st = restockStatusNow(now);
      if (st.ok) {
        const due = restock.dueForLetter(list, st.items, RESTOCK_CFG, now, { looksLikeEmail: looksLikeEmail, isExcluded: (email) => isExcludedIdentity(email), isSuppressed: restockSuppressedCheck(restockMeta()), sentIds: restockSentIds });
        for (const s of due.would) if (!restockWouldLogged.has(s.id)) { restockWouldLogged.add(s.id); console.log('[restock] would send ' + restock.safeId(s.id)); }
        toQueue = due.send.map(s => s.id);
        if (toQueue.length) { restock.markQueued(list, toQueue, now); dirty = true; }
      }
    }
    if (dirty) restockWrite(list);
    for (const id of toQueue) mailOutbox.enqueue(restock.KIND, id);
    if (restockTickFailed) { restockTickFailed = false; console.log('[restock] tick works again'); }
  } catch (e) {
    if (!restockTickFailed) { restockTickFailed = true; console.error('[mail-alert] RESTOCK TICK FAILED, no letter goes until the files are fixed: ' + restockErr(e)); }
  }
}
// After a 2xx: note it on the record. Remembered in memory first, so a failed write cannot send the same letter every tick.
function restockMark(id) {
  restockSentIds.add(id);
  try {
    const list = restockReadList();
    if (restock.markSent(list, id, Date.now())) restockWrite(list);
  } catch (e) { console.error('[mail-alert] RESTOCK NOT RECORDED ' + restock.safeId(id) + ' was sent but not marked (it is not sent again while this process runs): ' + restockErr(e)); }
}
// The queue's sender for letter_restock: sub is the record from the file as it is now, so the rules are asked again (cancelled
// meanwhile, unsubscribed, mode switched); what may not go answers skipped, never a failure to retry. A module that did not start answers skipped too.
function restockSend(item, sub, cb) {
  const skipped = () => cb({ ok: true, status: 'skipped' });
  if (!restock) return skipped();
  const id = restock.safeId(sub && sub.id);
  let suppressed;
  try { suppressed = restockSuppressedCheck(restockMeta()); }
  catch (e) { return cb({ ok: false, status: 'meta_unreadable', error: restockErr(e) }); }
  const verdict = restock.letterAllowed(sub, RESTOCK_CFG, { looksLikeEmail: looksLikeEmail, isExcluded: (email) => isExcludedIdentity(email), isSuppressed: suppressed });
  if (!verdict.ok) {
    console.log('[restock] ' + (verdict.reason === 'not_test_recipient' ? 'would send ' + id : 'skip ' + id + ': ' + verdict.reason));
    return skipped();
  }
  if (!CIO_READY || !RESTOCK_ID) return skipped();
  let data;
  try { data = restock.letterData(sub, { mailSafe: mailSafe }); }
  catch (e) { return cb({ ok: false, status: 'not_built', error: 'letter data: ' + restockErr(e) }); }
  cioSendEmail(RESTOCK_ID, sub.email, sub.email, data, 'letter-restock', id, (ok, status, errorText) => {
    if (ok) restockMark(sub.id);
    cb({ ok: ok, status: status, error: errorText });
  });
}
// Contact form -> Telegram (2026-09-30, ad readiness; services/tg-alerts/ in biofirst-hosting): POST /contact saved the message and told
// nobody, while the page promises an answer in 12 hours. Now, with TG_ALERTS_MODE on and TG_ALERTS_TOPIC_CONTACT set (no topic = nothing
// is sent), one line goes to that topic through the mail queue (kind tg_contact, ref = the message id): when, where to read it in the
// CRM. No name, e-mail, subject or text. Mark: message.alerts.contact. At most CONTACT_PER_HOUR lines an hour; the rest become one
// "+K more" line that is edited as K grows. The rules and the text are in tg-alerts.cjs.
const TG_CONTACT_FILE = path.join(__dirname, 'messages.json');
function tgContactRead() {
  const list = readJsonOrFallback(TG_CONTACT_FILE, []);
  if (!Array.isArray(list)) throw new Error('messages are not an array');
  return list;
}
function tgContactFind(ref) { return tgContactRead().find(m => m && m.id === ref) || null; }
function tgContactQueue(msg) {
  try {
    if (!tgAlerts || TG_ALERTS_CFG.mode === 'off' || !mailOutbox || !msg || !msg.id) return false;
    const verdict = tgAlerts.contactAllowed(msg, TG_ALERTS_CFG);
    if (!verdict.ok) { console.log('[tg-alerts] skip contact ' + tgAlerts.safeRef(msg.id) + ': ' + verdict.reason); return false; }
    return mailOutbox.enqueue(tgAlerts.CONTACT_KIND, msg.id);
  } catch (e) { console.error('[tg-alerts] ERROR contact not queued: ' + ((e && e.message) || e)); return false; }
}
// Notes a sent line (or a suppressed message) on the message; the file is read again: the visitor or the CRM may have written to it meanwhile.
function tgContactMark(ref, rec) {
  try {
    const list = tgContactRead();
    const found = list.find(m => m && m.id === ref);
    if (!found) return;
    tgAlerts.markAlert(found, 'contact', rec);
    writeJsonAtomic(TG_CONTACT_FILE, list);
  } catch (e) { console.error('[mail-alert] TG ALERT NOT RECORDED contact ' + tgAlerts.safeRef(ref) + ' was handled but not marked on the message (it could be sent again): ' + ((e && e.message) || e)); }
}
function tgContactSend(item, msg, cb) {
  const skipped = () => cb({ ok: true, status: 'skipped' });
  const verdict = tgAlerts.contactAllowed(msg, TG_ALERTS_CFG);
  if (!verdict.ok) { console.log('[tg-alerts] skip contact ' + tgAlerts.safeRef(msg.id) + ': ' + verdict.reason); return skipped(); }
  let all;
  try { all = tgContactRead(); } catch (e) { return cb({ ok: false, status: 'orders_unreadable', error: 'messages.json: ' + ((e && e.message) || e) }); }
  const now = Date.now();
  if (tgAlerts.contactSentLastHour(all, now) >= tgAlerts.CONTACT_PER_HOUR) {
    const holder = tgAlerts.contactOverflowHolder(all, now);
    const suppressed = () => { tgContactMark(msg.id, { suppressedAt: new Date(now).toISOString() }); console.log('[tg-alerts] contact ' + tgAlerts.safeRef(msg.id) + ' over the hourly limit, not announced'); return skipped(); };
    if (!holder) {
      // The first one over the limit: the line itself. It is marked on this message, which then carries the count.
      tgAlerts.send(TG_ALERTS_CFG, tgAlerts.contactOverflowMessage(1), r => {
        if (!r.ok) return cb({ ok: false, status: r.status, error: r.error });
        const rec = { suppressedAt: new Date(now).toISOString(), count: 1 };
        if (Number.isInteger(r.messageId)) rec.messageId = r.messageId;
        if (Number.isInteger(r.topic)) rec.topic = r.topic;
        tgContactMark(msg.id, rec);
        console.error('[mail-alert] TG CONTACT LIMIT ' + tgAlerts.CONTACT_PER_HOUR + ' per hour reached: the rest are not announced one by one (see CRM Messages)');
        skipped();
      });
      return;
    }
    // More of them: the holder's count goes up and its Telegram message is edited to the new K; a failed edit is only a log line.
    const prev = holder.alerts.contact;
    const next = Object.assign({}, prev, { count: prev.count + 1 });
    tgContactMark(holder.id, next);
    if (Number.isInteger(prev.messageId)) {
      const line = tgAlerts.contactOverflowMessage(next.count);
      tgAlerts.post(TG_ALERTS_CFG, 'editMessageText', { chat_id: TG_ALERTS_CFG.chatId, message_id: prev.messageId, rich_message: line.rich }, e => {
        if (!e.ok) console.error('[tg-alerts] contact "+K more" not edited: ' + (e.status || '') + ' ' + (e.error || ''));
      });
    }
    return suppressed();
  }
  tgAlerts.send(TG_ALERTS_CFG, tgAlerts.contactMessage(msg), r => {
    if (r.ok) { tgContactMark(msg.id, tgAlerts.sentRecord(r, TG_ALERTS_CFG)); console.log('[tg-alerts] sent contact ' + tgAlerts.safeRef(msg.id)); }
    if (r.ok && r.richRefused) console.error('[mail-alert] TG RICH REFUSED contact ' + tgAlerts.safeRef(msg.id) + ', sent not as meant: ' + r.richRefused);
    cb({ ok: r.ok, status: r.status, error: r.error });
  });
}
const server = http.createServer((req, res) => {
  applyCors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }
  if (!enforceBodyLimit(req, res)) return;
  if (isPublicRoute(req)) {
    // Phase 1 (2026-09-04): GET /products is served either way, but returns full records to an authorized CRM caller,
    // so credentials sent with that one public request are verified and flagged, never required. Other public routes
    // never touch the session check.
    // Phase 4 (2026-09-05): the same for POST /orders — a server-issued ref (MS-NNN) is only handed to an authorized
    // CRM caller (ORDERS_PUBLIC = yes keeps the route open, an anonymous caller still has to send its own ref).
    const key = routeKey(req);
    if ((key === 'GET /msolpeptides-api/products' || key === 'POST /msolpeptides-api/orders' || key === 'GET /msolpeptides-api/site-copy') && (req.headers['authorization'] || req.headers['x-admin-secret'])) {
      isAuthorized(req, (ok, role) => { req.crmAuthorized = ok; if (ok) req.crmRole = role; safeHandle(req, res); });
    } else {
      safeHandle(req, res);
    }
    return;
  }
  // Phase 5 (2026-09-05): 401 no usable session -> 503 session backend unreachable (pages used to read that 401 as an
  // expired session and logged the user out) -> 403 wrong role -> handler.
  const needsAdmin = requiresAdmin(req);
  isAuthorized(req, (ok, role, reason) => {
    if (!ok) {
      if (reason === 'unavailable') { jsonReply(res, 503, {error:'Authentication service unavailable'}); return; }
      jsonReply(res, 401, {error:'Unauthorized'}); return;
    }
    req.crmRole = role;
    if (needsAdmin && role !== 'admin') { req.resume(); jsonReply(res, 403, {error:'Admin access required'}); return; }  // drain: the refused body can be a whole catalog
    safeHandle(req, res);
  }, { fresh: needsAdmin });
});

server.listen(PORT, "127.0.0.1", function() {
  console.log('Products API running on port ' + PORT);
});
