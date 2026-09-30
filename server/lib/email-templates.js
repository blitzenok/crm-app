// Transactional customer order emails: rendering (table-based inline-CSS HTML + plain text), catalog-name resolution,
// totals, carrier links, delivery windows and the compliance guard. No marketing content, no use instructions.
import { readFileSync, existsSync } from "node:fs";
import { COMPOUND_TERMS, compoundTermsFor, findCompoundLeaks, isGiftLine } from "./rapid-orders.js";
import { descriptorFor } from "./cleffo-checkout.js";

export const SUPPORT_EMAIL = "support@biolabsresearch.co";
export const RESPONSE_HOURS = "8:00 AM – 9:00 PM ET";
export const RUO_FOOTER = "For research use only. Not for human or veterinary use. Not a drug, food, or cosmetic.";
export const MANUAL_CONFIRM_LINE = "We confirm your order manually within one business day.";
export const FOLLOWUP_QUESTION = "Did your order arrive complete and intact?";
// Header logo (blue helix + black "BIO LABS", transparent PNG, 400x167 = 2x for a 200px display width). Must be an
// absolute https URL in real emails; ORDER_EMAIL_LOGO_URL may override it (https only). Previews may pass a data: URI.
export const EMAIL_LOGO_URL = "https://biolabsresearch.co/media/email/biolabs-logo-email.png";
export const EMAIL_LOGO = { alt: "BioLabs Research", width: 200, height: 84 };
export function logoSrc(override, env = process.env) {
  if (override && (/^https:\/\/[^\s"'<>]+$/.test(override) || /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(override))) return override;
  const fromEnv = env.ORDER_EMAIL_LOGO_URL;
  return fromEnv && /^https:\/\/[^\s"'<>]+$/.test(fromEnv) ? fromEnv : EMAIL_LOGO_URL;
}
const C = { black: "#000000", gold: "#B08D57", cream: "#F5F2EC", white: "#FFFFFF", text: "#111111", muted: "#555555", rule: "#E6E0D4" };
const HEAD = "Archivo, Arial, Helvetica, sans-serif";
const BODY = "'DM Sans', Arial, Helvetica, sans-serif";

// Words the emails must never contain beyond the compound / street-name list: use or dosing language, lot COA wording,
// the gift. Customer-supplied text (name, address) is not scanned.
export const EMAIL_EXTRA_TERMS = [
  "dose", "doses", "dosage", "dosing", "inject", "injection", "injectable", "reconstitute", "reconstitution", "reconstituted",
  "lot coa", "bac water", "bacteriostatic", "gift", "free vial", "administer", "administration", "subcutaneous", "intramuscular",
];

// ---- catalog names ------------------------------------------------------------------------------------------
const DEFAULT_NAME_MAP = new URL("../config/rapid-sku-map.draft.json", import.meta.url).pathname;
let nameMapCache = null;
/** storefront sku -> { name (catalog / stealth name), stealth, gift }. Source: the SKU map (internal_id). */
export function loadNameMap(path = process.env.ORDER_EMAIL_NAME_MAP || DEFAULT_NAME_MAP) {
  if (nameMapCache && nameMapCache.path === path) return nameMapCache.map;
  let raw = {};
  try { if (existsSync(path)) raw = JSON.parse(readFileSync(path, "utf8")); } catch { raw = {}; }
  const map = {};
  for (const [k, v] of Object.entries(raw || {})) if (v) map[String(k).toLowerCase()] = v;
  nameMapCache = { path, map };
  return map;
}

export function strengthOf(item) {
  const mg = String(item?.mg || "").replace(/\s+/g, "");
  if (mg) return mg;
  const m = String(item?.sku || "").match(/-(\d+(?:\.\d+)?)(mg|mcg|ml|g|iu)$/i);
  return m ? `${m[1]}${m[2].toLowerCase() === "ml" ? "mL" : m[2].toLowerCase()}` : "";
}

/** Catalog name for an order line: stealth -> stealth name only; mapped -> catalog id (RC-nn); else the order's name. */
export function catalogName(item, map = loadNameMap()) {
  const m = map[String(item?.sku || "").toLowerCase()];
  if (m && m.internal_id) return m.internal_id;
  if (m && m.name) return String(m.name).replace(/\s+\d+(\.\d+)?\s*(mg|mcg|ml|g|iu)\b.*$/i, "");
  return String(item?.name || item?.sku || "Item").replace(/\s+\d+(\.\d+)?\s*(mg|mcg|ml|g|iu)\b.*$/i, "").trim() || "Item";
}

// ---- money / totals -----------------------------------------------------------------------------------------
const cents = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 100) : null; };
export const money = (c) => `$${(c / 100).toFixed(2)}`;

/**
 * Line items (gift excluded) and totals that equal the order total to the cent:
 * subtotal (undiscounted) - volume discount + shipping = order.amount. If the stored figures do not reconcile, per-line
 * prices / subtotal are left out and only shipping + total are shown (reconciled:false).
 */
export function orderTotals(order, map = loadNameMap()) {
  const pc = order.priceCheck || {};
  const priceLines = Array.isArray(pc.lines) ? pc.lines : [];
  const lines = [];
  for (const it of order.items || []) {
    const m = map[String(it.sku || "").toLowerCase()];
    if (isGiftLine(it, m)) continue;
    const qty = Math.max(1, parseInt(it.qty ?? it.quantity, 10) || 1);
    const pl = priceLines.find((l) => String(l.sku || "").toLowerCase() === String(it.sku || "").toLowerCase());
    let lineC = pl ? cents(pl.line) : null;
    if (lineC === null) {
      const a = cents(it.amount ?? it.price);
      // crypto orders store the line total, card orders the unit price
      lineC = a === null ? null : order.paymentMethod === "crypto" ? a : a * qty;
    }
    lines.push({ name: catalogName(it, map), strength: strengthOf(it), qty, lineCents: lineC, stealth: Boolean(m?.stealth) });
  }
  const totalC = cents(order.amount) ?? 0;
  const subtotalC = lines.every((l) => l.lineCents !== null) ? lines.reduce((s, l) => s + l.lineCents, 0) : null;
  const vd = pc.volumeDiscount;
  // infra 2026-09-29 honest-charge: coupon discount (priceCheck.discount, source "coupon:CODE") reconciles like the ladder one
  const cd = !vd && pc.discount && String(pc.discount.source || "").startsWith("coupon:") ? pc.discount : null;
  const discountC = vd ? cents(vd.discount) || 0 : cd ? cents(cd.amount) || 0 : 0;
  let shippingC = pc.shipping != null ? cents(pc.shipping) : null;
  if (shippingC === null && subtotalC !== null) shippingC = Math.max(0, totalC - (subtotalC - discountC));
  const reconciled = subtotalC !== null && shippingC !== null && subtotalC - discountC + shippingC === totalC;
  return {
    lines,
    reconciled,
    subtotalCents: reconciled ? subtotalC : null,
    discount: reconciled && discountC ? { pct: vd ? vd.pct : cd.pct, cents: discountC, label: cd ? `Coupon ${String(cd.source).slice(7)} (${cd.pct}%)` : `Volume discount (${vd.pct}%)` } : null,
    shippingCents: shippingC,
    shipMethod: String(pc.shipMethod || order.shipMethod || "").toLowerCase() || null,
    totalCents: totalC,
  };
}

// ---- carriers ---------------------------------------------------------------------------------------------
export const CARRIER_URLS = {
  USPS: "https://tools.usps.com/go/TrackConfirmAction?tLabels=",
  UPS: "https://www.ups.com/track?tracknum=",
  FedEx: "https://www.fedex.com/fedextrack/?trknbr=",
  DHL: "https://www.dhl.com/us-en/home/tracking/tracking-ecommerce.html?tracking-id=",
  OnTrac: "https://www.ontrac.com/tracking/?number=",
  Other: "https://t.17track.net/en#nums=",
};
/** Carrier from a Rapid courier code, a carrier label, or the tracking number format. */
export function carrierFor(carrierOrCode, trackingNumber = "") {
  const s = String(carrierOrCode || "").toLowerCase();
  if (s.startsWith("ups_surepost_usps")) return "USPS";
  if (/^usps|usps|postal/.test(s)) return "USPS";
  if (/^ups|\bups\b/.test(s)) return "UPS";
  if (/^fedex|fedex/.test(s)) return "FedEx";
  if (/^dhl|dhl/.test(s)) return "DHL";
  if (/^ontrac|ontrac/.test(s)) return "OnTrac";
  if (/^rrd/.test(s)) return "Other";
  const t = String(trackingNumber || "").replace(/\s+/g, "");
  if (/^1Z[0-9A-Z]{16}$/i.test(t)) return "UPS";
  if (/^(9[1-5]\d{18,20}|[A-Z]{2}\d{9}US)$/i.test(t)) return "USPS";
  if (/^(\d{12}|\d{15})$/.test(t)) return "FedEx";
  if (/^(D\d{14}|C\d{14})$/i.test(t)) return "OnTrac";
  return "Other";
}
export function trackingUrl(carrier, trackingNumber) {
  const base = CARRIER_URLS[carrier] || CARRIER_URLS.Other;
  return `${base}${encodeURIComponent(String(trackingNumber || "").replace(/\s+/g, ""))}`;
}

/** Business-day delivery window from the ship date: express/priority 1–3, ground/other 2–5 (Rapid services). */
export function deliveryWindow(shippedAt, { shipMethod = "", courierCode = "" } = {}) {
  const fast = /express|priority|2d|expedited|exp\b/i.test(`${shipMethod} ${courierCode}`);
  const [lo, hi] = fast ? [1, 3] : [2, 5];
  const start = new Date(shippedAt || Date.now());
  const add = (n) => {
    const d = new Date(start);
    let left = n;
    while (left > 0) { d.setUTCDate(d.getUTCDate() + 1); const w = d.getUTCDay(); if (w !== 0 && w !== 6) left -= 1; }
    return d;
  };
  const fmt = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return { from: add(lo), to: add(hi), text: `${fmt(add(lo))} – ${fmt(add(hi))}`, businessDays: `${lo}–${hi} business days` };
}

// ---- building blocks --------------------------------------------------------------------------------------
export const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Order numbers (BLR-1099, CR-R9N3N3MR) never wrap at the hyphen in HTML. A nowrap span is used rather than a
// non-breaking-hyphen character so that copying the number still gives a plain "-". The text part is untouched.
export const ORDER_NO_RE = /\b(?:BLR|CR)-[A-Z0-9]+\b/g;
export const escNb = (v) => esc(v).replace(ORDER_NO_RE, (m) => `<span style="white-space:nowrap;">${m}</span>`);

/** Blocks return { html, text }. Templates compose them; renderLayout wraps them in the brand shell + footer. */
export const h = {
  heading: (t) => ({ html: `<h1 style="margin:0 0 16px;font-family:${HEAD};font-size:22px;line-height:1.3;font-weight:700;color:${C.black};">${escNb(t)}</h1>`, text: `${t}\n${"=".repeat(Math.min(60, t.length))}` }),
  p: (t) => ({ html: `<p style="margin:0 0 14px;font-family:${BODY};font-size:15px;line-height:1.6;color:${C.text};">${escNb(t)}</p>`, text: t }),
  strong: (t) => ({ html: `<p style="margin:0 0 14px;font-family:${BODY};font-size:15px;line-height:1.6;color:${C.text};font-weight:700;">${escNb(t)}</p>`, text: t }),
  kv: (rows) => ({
    html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;border-collapse:collapse;">${rows.map(([k, v]) => `<tr><td style="padding:4px 0;font-family:${BODY};font-size:14px;color:${C.muted};width:40%;vertical-align:top;">${esc(k)}</td><td style="padding:4px 0;font-family:${BODY};font-size:14px;color:${C.text};text-align:right;vertical-align:top;">${escNb(v)}</td></tr>`).join("")}</table>`,
    text: rows.map(([k, v]) => `${k}: ${v}`).join("\n"),
  }),
  section: (t) => ({ html: `<p style="margin:20px 0 8px;font-family:${HEAD};font-size:13px;letter-spacing:1px;text-transform:uppercase;font-weight:700;color:${C.gold};">${esc(t)}</p>`, text: `\n${t.toUpperCase()}` }),
  lines: (texts) => ({ html: `<p style="margin:0 0 14px;font-family:${BODY};font-size:14px;line-height:1.6;color:${C.text};">${texts.map(escNb).join("<br>")}</p>`, text: texts.join("\n") }),
  button: (label, href) => ({
    html: `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:6px 0 18px;"><tr><td style="background:${C.black};border:1px solid ${C.gold};"><a href="${esc(href)}" style="display:inline-block;padding:12px 22px;font-family:${HEAD};font-size:14px;font-weight:700;color:${C.white};text-decoration:none;">${esc(label)}</a></td></tr></table>`,
    text: `${label}: ${href}`,
  }),
  rule: () => ({ html: `<div style="height:1px;background:${C.rule};margin:12px 0 16px;line-height:1px;font-size:1px;">&nbsp;</div>`, text: "" }),
  items: (totals) => {
    const priced = totals.reconciled;
    const rows = totals.lines.map((l) => `<tr><td style="padding:10px 0;border-bottom:1px solid ${C.rule};font-family:${BODY};font-size:14px;color:${C.text};vertical-align:top;"><strong style="font-family:${HEAD};">${esc(l.name)}</strong>${l.strength ? `<br><span style="color:${C.muted};font-size:13px;">Strength: ${esc(l.strength)}</span>` : ""}</td><td style="padding:10px 8px;border-bottom:1px solid ${C.rule};font-family:${BODY};font-size:14px;color:${C.text};text-align:center;vertical-align:top;white-space:nowrap;">× ${l.qty}</td><td style="padding:10px 0;border-bottom:1px solid ${C.rule};font-family:${BODY};font-size:14px;color:${C.text};text-align:right;vertical-align:top;white-space:nowrap;">${priced ? money(l.lineCents) : ""}</td></tr>`).join("");
    const sum = [];
    if (priced) sum.push(["Subtotal", money(totals.subtotalCents)]);
    if (totals.discount) sum.push([totals.discount.label, `−${money(totals.discount.cents)}`]);
    if (totals.shippingCents !== null) sum.push([`Shipping${totals.shipMethod ? ` (${totals.shipMethod === "express" ? "Express" : "Ground"})` : ""}`, totals.shippingCents === 0 ? "$0.00" : money(totals.shippingCents)]);
    const sumRows = sum.map(([k, v]) => `<tr><td colspan="2" style="padding:6px 0 0;font-family:${BODY};font-size:14px;color:${C.muted};">${esc(k)}</td><td style="padding:6px 0 0;font-family:${BODY};font-size:14px;color:${C.text};text-align:right;white-space:nowrap;">${esc(v)}</td></tr>`).join("");
    const totalRow = `<tr><td colspan="2" style="padding:12px 0 0;border-top:2px solid ${C.gold};font-family:${HEAD};font-size:16px;font-weight:700;color:${C.black};">Total (incl. shipping)</td><td style="padding:12px 0 0;border-top:2px solid ${C.gold};font-family:${HEAD};font-size:16px;font-weight:700;color:${C.black};text-align:right;white-space:nowrap;">${money(totals.totalCents)}</td></tr>`;
    const text = [
      ...totals.lines.map((l) => `- ${l.name}${l.strength ? ` (Strength: ${l.strength})` : ""} x ${l.qty}${priced ? `  ${money(l.lineCents)}` : ""}`),
      "",
      ...sum.map(([k, v]) => `${k}: ${v}`),
      `Total (incl. shipping): ${money(totals.totalCents)}`,
    ].join("\n");
    return { html: `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 8px;">${rows}${sumRows}<tr><td colspan="3" style="height:4px;"></td></tr>${totalRow}</table>`, text };
  },
};

export function renderLayout({ title, preheader = "", blocks, logoUrl }) {
  const bodyHtml = blocks.map((b) => b.html).join("\n");
  const bodyText = blocks.map((b) => b.text).join("\n\n").replace(/\n{3,}/g, "\n\n");
  const footerHtml = `<p style="margin:0 0 8px;font-family:${BODY};font-size:13px;line-height:1.6;color:${C.text};">Questions? Email <a href="mailto:${SUPPORT_EMAIL}" style="color:${C.black};text-decoration:underline;">${SUPPORT_EMAIL}</a><br>Response hours: ${esc(RESPONSE_HOURS)}</p><p style="margin:0 0 8px;font-family:${BODY};font-size:12px;line-height:1.6;color:${C.muted};">${esc(RUO_FOOTER)}</p><p style="margin:0;font-family:${BODY};font-size:12px;line-height:1.6;color:${C.muted};">BioLabs Research · biolabsresearch.co<br>This is a transactional email about your order.</p>`;
  const footerText = `--\nQuestions? Email ${SUPPORT_EMAIL}\nResponse hours: ${RESPONSE_HOURS}\n\n${RUO_FOOTER}\n\nBioLabs Research · biolabsresearch.co\nThis is a transactional email about your order.`;
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><meta name="color-scheme" content="light only"><title>${esc(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700&family=DM+Sans:wght@400;700&display=swap" rel="stylesheet">
<style>body{margin:0;padding:0;}@media (max-width:620px){.wrap{width:100%!important;}.pad{padding:22px 18px!important;}}</style></head>
<body style="margin:0;padding:0;background:${C.cream};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.cream};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" class="wrap" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;background:${C.white};border:1px solid ${C.gold};">
<tr><td align="left" style="background:${C.white};padding:22px 28px 18px;border-bottom:3px solid ${C.gold};"><img src="${esc(logoSrc(logoUrl))}" width="${EMAIL_LOGO.width}" height="${EMAIL_LOGO.height}" alt="${EMAIL_LOGO.alt}" style="display:block;width:${EMAIL_LOGO.width}px;max-width:${EMAIL_LOGO.width}px;height:auto;border:0;outline:none;text-decoration:none;font-family:${HEAD};font-size:20px;font-weight:700;color:${C.black};"></td></tr>
<tr><td class="pad" style="padding:30px 28px 10px;">
${bodyHtml}
</td></tr>
<tr><td class="pad" style="padding:18px 28px 26px;border-top:1px solid ${C.rule};background:${C.white};">${footerHtml}</td></tr>
</table></td></tr></table></body></html>`;
  return { html, text: `${bodyText}\n\n${footerText}\n` };
}

// ---- templates ---------------------------------------------------------------------------------------------
const orderNo = (o) => String(o.orderRef && o.paymentMethod === "crypto" ? `${o.id} (${o.orderRef})` : o.id);
function addressLines(c = {}) {
  return [[c.first_name, c.last_name].filter(Boolean).join(" "), c.address, [c.city, c.state, c.zip].filter(Boolean).join(", ").replace(/, (\d)/, " $1"), c.country].filter(Boolean);
}
/** Asset + network the customer actually paid with, from the order's crypto payment record: "USDC (ERC20)". */
export function cryptoPaidWith(o) {
  const cp = o.cryptoPayment || {};
  const paid = (cp.transfers || []).filter((t) => t && t.success !== false && t.token && !t.wrongNetwork);
  const tokens = [...new Set(paid.map((t) => String(t.token).toUpperCase()))];
  const nets = [...new Set(paid.map((t) => t.network).filter(Boolean))];
  const token = tokens.length === 1 ? tokens[0] : String(cp.token || o.payAsset || "USDT").toUpperCase();
  const network = nets.length === 1 ? nets[0] : cp.network || o.crypto?.network || "";
  return `${token}${network ? ` (${String(network).toUpperCase()})` : ""}`;
}
function paymentLines(o, ctx = {}) {
  if (o.paymentMethod === "crypto") return [["Paid with", cryptoPaidWith(o)]];
  const proc = o.winningProcessor === "cleffo" ? "cleffo" : "umg";
  const d = descriptorFor(proc);
  // The descriptor is set by the processor (e.g. PEPTIDESS SHOP); it is shown verbatim and not guard-scanned.
  return [["Payment", "Card"], ...(d.statementDescriptor ? [["Card statement shows", ctx.redact ? "[statement descriptor]" : d.statementDescriptor]] : [])];
}

export const TEMPLATES = {
  confirmation: {
    subject: (o) => `Order ${o.id} received – BioLabs Research`,
    preheader: () => MANUAL_CONFIRM_LINE,
    blocks: (o, ctx) => {
      const t = orderTotals(o, ctx.nameMap);
      return [
        h.heading("Thank you for your order"),
        h.p(`We have received payment for order ${orderNo(o)}.`),
        h.strong(MANUAL_CONFIRM_LINE),
        h.section("Order summary"),
        h.items(t),
        h.section("Ship to"),
        { ...h.lines(ctx.redact ? ["[shipping address]"] : addressLines(o.customer)), customer: true },
        h.section("Payment"),
        h.kv(paymentLines(o, ctx)),
        h.p(`If anything looks wrong, reply to this email or write to ${SUPPORT_EMAIL}.`),
      ];
    },
  },
  shipping: {
    subject: (o) => `Order ${o.id} has shipped`,
    preheader: (o) => `Tracking ${o.fulfillment?.trackingNumber || ""}`,
    blocks: (o) => {
      const f = o.fulfillment || {};
      const carrier = carrierFor(o.rapid?.shipMethod || f.carrier, f.trackingNumber);
      const url = f.trackingUrl && /^https:\/\//.test(f.trackingUrl) && carrier === "Other" ? f.trackingUrl : trackingUrl(carrier, f.trackingNumber);
      const win = deliveryWindow(f.shippedAt, { shipMethod: o.priceCheck?.shipMethod, courierCode: o.rapid?.shipMethod });
      return [
        h.heading("Your order is on its way"),
        h.p(`Order ${orderNo(o)} has shipped.`),
        h.kv([["Carrier", carrier === "Other" ? (f.carrier || "Carrier") : carrier], ["Tracking number", f.trackingNumber || ""], ["Estimated delivery", `${win.text} (${win.businessDays})`]]),
        h.button("Track your package", url),
        h.p("Tracking can take up to 24 hours to show the first scan. Delivery estimates are set by the carrier and are not guaranteed."),
      ];
    },
  },
  followup: {
    subject: () => FOLLOWUP_QUESTION,
    preheader: (o) => `Order ${o.id}`,
    blocks: (o) => {
      const mailto = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`Order ${o.id}`)}`;
      const shipped = o.fulfillment?.shippedAt ? new Date(o.fulfillment.shippedAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" }) : null;
      return [
        h.heading(FOLLOWUP_QUESTION),
        h.p(`Order ${orderNo(o)}${shipped ? ` shipped on ${shipped}` : " has shipped"}. ${FOLLOWUP_QUESTION}`),
        h.p(`If anything is missing or damaged, email us at ${SUPPORT_EMAIL} with your order number and we will take care of it.`),
        h.button(`Email ${SUPPORT_EMAIL}`, mailto),
      ];
    },
  },
};

/** Compliance guard over the rendered subject + text (customer name / address redacted). Returns blocked terms. */
export function emailGuard({ subject, text }, nameMap = loadNameMap()) {
  const terms = [...new Set([...COMPOUND_TERMS, ...compoundTermsFor(nameMap), ...EMAIL_EXTRA_TERMS])];
  return findCompoundLeaks({ products: [], message: `${subject}\n${text}` }, terms);
}

/** Render one email. templates: registry (built-ins + registered types). ctx.data is passed through to templates. */
export function renderEmail(type, order, { templates = TEMPLATES, nameMap = loadNameMap(), data = {}, logoUrl } = {}) {
  const tpl = templates[type];
  if (!tpl) throw new Error(`unknown email type ${type}`);
  const ctx = { nameMap, data };
  const out = renderLayout({ title: tpl.subject(order, ctx), preheader: tpl.preheader ? tpl.preheader(order, ctx) : "", blocks: tpl.blocks(order, ctx), logoUrl });
  const redacted = renderLayout({ title: "", blocks: tpl.blocks(order, { ...ctx, redact: true }) });
  const subject = tpl.subject(order, ctx);
  return { subject, html: out.html, text: out.text, guard: emailGuard({ subject, text: redacted.text }, nameMap) };
}
