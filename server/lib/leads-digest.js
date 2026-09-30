/**
 * Marketing leads digest.
 *
 * Joins UMG quotes and abandoned checkouts by Jerusalem calendar day.
 * Does not join on track_token. Does not send email.
 *
 * Soft-QA flags stay on each row (they are not dropped) so Marketing can
 * count real leads separately from probes. See docs/MARKETING-LEADS-DIGEST.md.
 */

export const DIGEST_TIMEZONE = "Asia/Jerusalem";

const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "guerrillamail.info",
  "guerrillamail.biz",
  "sharklasers.com",
  "grr.la",
  "yopmail.com",
  "yopmail.fr",
  "tempmail.com",
  "temp-mail.org",
  "10minutemail.com",
  "trashmail.com",
  "getnada.com",
  "dispostable.com",
  "maildrop.cc",
  "fakeinbox.com",
  "mailnesia.com",
  "throwaway.email",
]);

const EXAMPLE_DOMAINS = new Set(["example.com", "example.org", "example.net"]);

const CLICK_ID_KEYS = new Set([
  "gclid",
  "fbclid",
  "click_id", // infra 2026-09-30 order-attribution
  "ttclid",
  "msclkid",
  "wbraid",
  "gbraid",
  "dclid",
  "li_fat_id",
]);

const QA_LOCAL = /^(qa|test|probe|soft-?qa|bot|noreply|no-reply)(\+|\.|$)/i;

export function jerusalemDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function isValidDay(day) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day || ""))) return false;
  const [y, m, d] = String(day).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function onJerusalemDay(iso, day) {
  if (!iso) return false;
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return false;
  return jerusalemDay(dt) === day;
}

function isGibberish(token) {
  const t = String(token || "").toLowerCase().replace(/[^a-z]/g, "");
  if (t.length < 6) return false;
  if (/(.)\1{3,}/.test(t)) return true;
  const vowels = (t.match(/[aeiou]/g) || []).length;
  return vowels / t.length < 0.15;
}

export function scoreLead({ email, firstName, lastName } = {}) {
  const raw = String(email || "").trim().toLowerCase();
  const at = raw.lastIndexOf("@");
  const local = at === -1 ? raw : raw.slice(0, at);
  const domain = at === -1 ? "" : raw.slice(at + 1);
  const localBase = local.split("+")[0];
  const disposable = DISPOSABLE_DOMAINS.has(domain)
    || EXAMPLE_DOMAINS.has(domain)
    || domain.endsWith(".test");
  const qaLike = QA_LOCAL.test(local) || local.startsWith("qa+") || local.includes("+qa");
  const gibberishEmail = isGibberish(localBase);
  const gibberishName = isGibberish(`${firstName || ""}${lastName || ""}`.replace(/\s+/g, ""));
  let spam_score = 0;
  if (disposable) spam_score += 50;
  if (qaLike) spam_score += 40;
  if (gibberishEmail) spam_score += 30;
  if (gibberishName) spam_score += 20;
  const gibberish = gibberishEmail || gibberishName;
  const soft_qa = disposable || qaLike || gibberishEmail || spam_score >= 30;
  return { spam_score, disposable, gibberish, soft_qa };
}

/**
 * Write-path helper imported by live quote.js and abandon.js.
 * Keeps utm_*, landing, and pages_before_submit. Click-id keys stay;
 * their values are replaced so the raw id is never stored.
 * publicAttribution is the same function (digest read path).
 */
export function sanitizeAttribution(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, value] of Object.entries(raw)) {
    if (/token|secret|track_token/i.test(key)) continue;
    const lower = String(key).toLowerCase();
    if (CLICK_ID_KEYS.has(lower)) {
      if (value) out[key] = "[present]";
      continue;
    }
    if (lower === "pages_before_submit") {
      if (Array.isArray(value)) {
        out[key] = value
          .filter((item) => item != null && (typeof item === "string" || typeof item === "number"))
          .map((item) => String(item).slice(0, 300))
          .slice(0, 30);
      } else if (typeof value === "string" || typeof value === "number") {
        out[key] = String(value).slice(0, 2000);
      }
      continue;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = String(value).slice(0, 300);
    }
  }
  return out;
}

export const publicAttribution = sanitizeAttribution;

export function cartContents(items) {
  if (!Array.isArray(items) || items.length === 0) return "";
  return items.map((it) => {
    const row = it && typeof it === "object" ? it : {};
    const qty = row.qty ?? row.quantity ?? 1;
    const name = row.name || row.title || row.sku || "item";
    const sku = row.sku ? ` (${row.sku})` : "";
    return `${qty}× ${name}${sku}`;
  }).join("; ");
}

function consentText(record) {
  const value = record?.consent_text ?? record?.customer?.consent_text;
  return typeof value === "string" ? value.slice(0, 500) : "";
}

function spamFields(email, customer) {
  const c = customer && typeof customer === "object" ? customer : {};
  return scoreLead({
    email,
    firstName: c.first_name || c.firstName || "",
    lastName: c.last_name || c.lastName || "",
  });
}

function quoteRow(quote) {
  const customer = quote?.customer && typeof quote.customer === "object" ? quote.customer : {};
  const email = String(customer.email || quote.email || "").trim();
  return {
    email,
    form_page: "checkout_quote",
    attribution: publicAttribution(quote.attribution),
    cart_contents: cartContents(quote.items),
    quote_number: String(quote.id || ""),
    amount: quote.amount != null ? String(quote.amount) : "",
    crm_status: String(quote.crmStatus || quote.crm_status || quote.status || ""),
    session_id: String(quote.session_id || quote.sessionId || ""),
    consent_text: consentText(quote),
    ...spamFields(email, customer),
  };
}

function abandonRow(row) {
  const customer = row?.customer && typeof row.customer === "object" ? row.customer : {};
  const email = String(customer.email || row.email || "").trim();
  const stage = String(row.stage || "unknown").trim() || "unknown";
  const quoteNumber = row.converted_via === "quote" && row.converted_id ? String(row.converted_id) : "";
  return {
    email,
    form_page: `checkout_abandon:${stage}`,
    attribution: publicAttribution(row.attribution),
    cart_contents: cartContents(row.items),
    quote_number: quoteNumber,
    amount: row.subtotal != null ? String(row.subtotal) : (row.amount != null ? String(row.amount) : ""),
    crm_status: String(row.status || "open"),
    session_id: String(row.session_id || ""),
    consent_text: consentText(row),
    ...spamFields(email, customer),
  };
}

export function buildLeadsDigest(store, opts = {}) {
  const day = opts.day != null && String(opts.day).trim() !== ""
    ? String(opts.day).trim()
    : jerusalemDay(opts.now ? new Date(opts.now) : new Date());
  if (!isValidDay(day)) {
    return { ok: false, error: "invalid_day", status: 400 };
  }

  const quotes = typeof store?.listQuotes === "function" ? store.listQuotes() : [];
  const abandons = typeof store?.listAbandonedCheckouts === "function" ? store.listAbandonedCheckouts() : [];

  const rows = [];
  for (const quote of quotes) {
    const stamp = quote?.createdAt || quote?.updatedAt;
    if (!onJerusalemDay(stamp, day)) continue;
    rows.push(quoteRow(quote));
  }
  for (const row of abandons) {
    const stamp = row?.last_seen || row?.seen_at || row?.first_seen;
    if (!onJerusalemDay(stamp, day)) continue;
    rows.push(abandonRow(row));
  }

  rows.sort((a, b) => `${a.email}|${a.form_page}|${a.session_id}`.localeCompare(`${b.email}|${b.form_page}|${b.session_id}`));

  const softQa = rows.filter((r) => r.soft_qa).length;
  return {
    ok: true,
    day,
    timezone: DIGEST_TIMEZONE,
    counts: {
      total: rows.length,
      soft_qa: softQa,
      real: rows.length - softQa,
    },
    rows,
  };
}
