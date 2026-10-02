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
