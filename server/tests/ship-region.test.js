// infra 2026-10-01 ship48: lower-48 rule unit tests (node --test tests/ship-region.test.js)
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkShipRegion, shipRegionErrorBody } from "../lib/ship-region.js";
import { countryCode } from "../lib/card.js";
import { country2 } from "../lib/cleffo.js";
const NY = { country: "US", state: "NY", zip: "10001", address: "350 5th Ave", city: "New York" };
const cases = [
  ["Canada", { ...NY, country: "CA", state: "ON", zip: "M5V 2T6" }, "country_not_us"],
  ["Alaska AK", { ...NY, state: "AK", zip: "99501" }, "state_not_lower48"],
  ["Hawaii HI", { ...NY, state: "HI", zip: "96813" }, "state_not_lower48"],
  ["Puerto Rico PR", { ...NY, state: "PR", zip: "00901" }, "state_not_lower48"],
  ["Guam GU", { ...NY, state: "GU", zip: "96910" }, "state_not_lower48"],
  ["Armed Forces AE", { ...NY, state: "AE", zip: "09001" }, "state_not_lower48"],
  ["APO line, state NY", { ...NY, address: "Unit 2050 Box 4190", city: "APO" }, "military_address"],
  ["ZIP 996xx with state WA", { ...NY, state: "WA", zip: "99603" }, "zip_not_lower48"],
  ["ZIP 967xx with state CA", { ...NY, state: "CA", zip: "96701" }, "zip_not_lower48"],
  ["ZIP 006xx with state FL", { ...NY, state: "FL", zip: "00601" }, "zip_not_lower48"],
  ["ZIP 969xx with state OR", { ...NY, state: "OR", zip: "96910" }, "zip_not_lower48"],
  ["blank country", { ...NY, country: "" }, "country_missing"],
  ["country 'Other'", { ...NY, country: "Other" }, "country_not_us"],
  ["bad ZIP 1234", { ...NY, zip: "1234" }, "zip_invalid"],
  ["unknown state XX", { ...NY, state: "XX" }, "state_unknown"],
];
for (const [name, addr, reason] of cases) {
  test(`refuses ${name}`, () => { const r = checkShipRegion(addr); assert.equal(r.ok, false); assert.equal(r.reason, reason); });
}
const passes = [
  ["NY 5-digit ZIP", NY, "NY"],
  ["ZIP+4", { ...NY, zip: "10001-1234" }, "NY"],
  ["DC", { country: "USA", state: "DC", zip: "20500", address: "1600 Pennsylvania Ave NW", city: "Washington" }, "DC"],
  ["full names + case variants", { country: "united states of america", state: "new york", zip: "10001" }, "NY"],
  ["District of Columbia full name", { country: "United States", state: "District of Columbia", zip: "20001" }, "DC"],
];
for (const [name, addr, st] of passes) {
  test(`passes ${name}`, () => { const r = checkShipRegion(addr); assert.equal(r.ok, true); assert.equal(r.state, st); });
}
test("error body is the storefront contract", () => {
  assert.deepEqual(shipRegionErrorBody(), { ok: false, error: "ship_region_unsupported", charged: false, message: "We ship to the contiguous US (lower 48) only." });
});
test("processors never get an invented country", () => {
  assert.equal(countryCode(""), ""); assert.equal(countryCode("Other"), ""); assert.equal(countryCode("US"), "USA"); assert.equal(countryCode("United States"), "USA");
  assert.equal(country2(""), ""); assert.equal(country2("OTHER"), ""); assert.equal(country2("USA"), "US"); assert.equal(country2("United States"), "US");
});
