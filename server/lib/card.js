export function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

export function detectCardType(number) {
  const n = digitsOnly(number);
  if (n.startsWith("34") || n.startsWith("37")) return "1";
  if (n.startsWith("4")) return "2";
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return "3";
  if (n.startsWith("6011") || n.startsWith("65") || n.startsWith("64") || n.startsWith("622")) return "4";
  return "2";
}

export function expiryYear2(year) {
  const y = String(year || "").replace(/\D/g, "");
  return y.length >= 2 ? y.slice(-2) : y;
}

export function expiryMonth(month) {
  const m = String(month || "").replace(/\D/g, "");
  if (!m) return "";
  return String(parseInt(m, 10));
}

export function formatAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

const COUNTRY3 = {
  US: "USA",
  GB: "GBR",
  CA: "CAN",
  AU: "AUS",
  DE: "DEU",
  FR: "FRA",
  IL: "ISR",
  NL: "NLD",
  ES: "ESP",
  IT: "ITA",
};

export function countryCode(country) {
  const raw = String(country || "").trim().toUpperCase();
  // infra 2026-10-01 ship48 (Legal): never invent a country. Blank or unmappable -> "" (the ship48 check refuses it before any charge).
  if (!raw) return "";
  if (raw.length === 3) return raw;
  if (raw.length === 2) return COUNTRY3[raw] || raw;
  if (raw === "UNITED STATES" || raw === "UNITED STATES OF AMERICA") return "USA";
  return "";
}

export function phoneDigits(phone) {
  const d = digitsOnly(phone);
  if (d.length >= 5 && d.length <= 15) return d;
  if (d.length > 15) return d.slice(0, 15);
  return d.padStart(5, "0");
}

/** Luhn check over the digits of a card number (spaces / dashes ignored). */
export function luhnValid(number) {
  const d = digitsOnly(number);
  if (!d) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i += 1) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}

/**
 * audit 2026-10-02 (#79): FORMAT check of the card before anything is sent to a bank: 12-19 digits that pass Luhn, an expiry month
 * that is not in the past, a CVV of 3-4 digits. Returns null when fine, else "number" | "expiry" | "cvv". It never says whether the
 * bank would accept the card.
 */
export function cardFormatProblem(card, now = new Date()) {
  const c = card && typeof card === "object" ? card : {};
  const n = digitsOnly(c.number);
  if (n.length < 12 || n.length > 19 || !luhnValid(n)) return "number"; // 12-19 digits like the storefront page and hasCard()
  const month = parseInt(digitsOnly(c.month), 10);
  const y = digitsOnly(c.year);
  const year = y.length === 2 ? 2000 + Number(y) : y.length === 4 ? Number(y) : NaN;
  if (!(month >= 1 && month <= 12) || !Number.isFinite(year)) return "expiry";
  // a card is good through the last day of its month in the buyer's timezone: compare with "a day ago" so a US buyer is never refused in the first hours of UTC next month
  const ref = new Date(now.getTime() - 24 * 3600e3);
  if (year * 12 + month < ref.getUTCFullYear() * 12 + (ref.getUTCMonth() + 1)) return "expiry";
  const cvv = String(c.cvv || c.cvc || "");
  if (!/^\d{3,4}$/.test(cvv)) return "cvv";
  return null;
}
