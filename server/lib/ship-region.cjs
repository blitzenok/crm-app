/**
 * infra 2026-10-01 ship48 (Yehuda approved): we ship to the contiguous US (lower 48) + DC only.
 * Shared rule for crm-umg (card / crypto / quote / Rapid push) and products-api (public notify-order, anonymous /orders).
 * CommonJS so both the ESM sidecar (lib/ship-region.js re-exports this) and products-api.cjs use the same file.
 *
 * checkShipRegion(addr) -> { ok:true, country:"US", state:"NY", zip:"10001" } | { ok:false, reason }
 *   addr: { country, state, zip|postal_code|postalCode|postcode, address|address1|address2|city } (any of these names)
 */
"use strict";

const STATES = {
  AL: "ALABAMA", AZ: "ARIZONA", AR: "ARKANSAS", CA: "CALIFORNIA", CO: "COLORADO", CT: "CONNECTICUT", DE: "DELAWARE",
  DC: "DISTRICT OF COLUMBIA", FL: "FLORIDA", GA: "GEORGIA", ID: "IDAHO", IL: "ILLINOIS", IN: "INDIANA", IA: "IOWA",
  KS: "KANSAS", KY: "KENTUCKY", LA: "LOUISIANA", ME: "MAINE", MD: "MARYLAND", MA: "MASSACHUSETTS", MI: "MICHIGAN",
  MN: "MINNESOTA", MS: "MISSISSIPPI", MO: "MISSOURI", MT: "MONTANA", NE: "NEBRASKA", NV: "NEVADA", NH: "NEW HAMPSHIRE",
  NJ: "NEW JERSEY", NM: "NEW MEXICO", NY: "NEW YORK", NC: "NORTH CAROLINA", ND: "NORTH DAKOTA", OH: "OHIO",
  OK: "OKLAHOMA", OR: "OREGON", PA: "PENNSYLVANIA", RI: "RHODE ISLAND", SC: "SOUTH CAROLINA", SD: "SOUTH DAKOTA",
  TN: "TENNESSEE", TX: "TEXAS", UT: "UTAH", VT: "VERMONT", VA: "VIRGINIA", WA: "WASHINGTON", WV: "WEST VIRGINIA",
  WI: "WISCONSIN", WY: "WYOMING",
};
const BY_NAME = Object.fromEntries(Object.entries(STATES).map(([k, v]) => [v, k]));
BY_NAME["WASHINGTON DC"] = "DC"; BY_NAME["WASHINGTON D C"] = "DC";
const REFUSED_STATES = new Set(["AK", "HI", "PR", "GU", "VI", "AS", "MP", "AA", "AE", "AP", "ALASKA", "HAWAII", "PUERTO RICO",
  "GUAM", "VIRGIN ISLANDS", "US VIRGIN ISLANDS", "AMERICAN SAMOA", "NORTHERN MARIANA ISLANDS", "ARMED FORCES AMERICAS",
  "ARMED FORCES EUROPE", "ARMED FORCES PACIFIC"]);
const US_NAMES = new Set(["US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"]);
const REFUSED_ZIP3 = /^(99[5-9]|96[78]|00[6-9]|969)/; // AK, HI, PR/VI, Guam/AS/MP
const MILITARY = /\b(?:APO|FPO|DPO|PSC)\b/i;

const MESSAGE = "We ship to the contiguous US (lower 48) only.";

function norm(v) {
  return String(v == null ? "" : v).toUpperCase().replace(/\./g, "").replace(/[\s_-]+/g, " ").trim();
}

function checkShipRegion(addr) {
  const a = addr && typeof addr === "object" ? addr : {};
  const country = norm(a.country);
  if (!country) return { ok: false, reason: "country_missing" };
  if (!US_NAMES.has(country)) return { ok: false, reason: "country_not_us" };
  const st = norm(a.state);
  if (!st) return { ok: false, reason: "state_missing" };
  if (REFUSED_STATES.has(st)) return { ok: false, reason: "state_not_lower48" };
  const state = STATES[st] ? st : BY_NAME[st];
  if (!state) return { ok: false, reason: "state_unknown" };
  const zipRaw = String(a.zip ?? a.postal_code ?? a.postalCode ?? a.postcode ?? "").trim();
  if (!/^\d{5}(?:-\d{4})?$/.test(zipRaw)) return { ok: false, reason: "zip_invalid" };
  if (REFUSED_ZIP3.test(zipRaw)) return { ok: false, reason: "zip_not_lower48" };
  const lines = [a.address, a.address1, a.address2, a.line1, a.line2, a.city].map((x) => String(x == null ? "" : x)).join(" ");
  if (MILITARY.test(lines)) return { ok: false, reason: "military_address" };
  return { ok: true, country: "US", state, zip: zipRaw };
}

function shipRegionErrorBody() {
  return { ok: false, error: "ship_region_unsupported", charged: false, message: MESSAGE };
}

module.exports = { checkShipRegion, shipRegionErrorBody, SHIP_REGION_MESSAGE: MESSAGE, LOWER48_STATES: Object.keys(STATES) };
