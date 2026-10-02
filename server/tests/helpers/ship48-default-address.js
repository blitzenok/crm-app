// infra 2026-10-01 ship48 (test data only): checkout now refuses anything outside the contiguous US (lower 48).
// Many older fixtures post a customer with no address at all. This gives such a customer a default NY address
// on the checkout POSTs (charge / crypto / quote / route) so those tests keep testing what they were written for.
// A customer that sends ANY of country / state / zip is left exactly as written (refusal tests stay honest).
export const DEFAULT_SHIP_ADDRESS = Object.freeze({ address: "350 5th Ave", city: "New York", state: "NY", zip: "10118", country: "US" });
const CHECKOUT_POST = /\/api\/checkout\/(charge|crypto|quote|route)(\?|$)/;
export function withDefaultShipAddress(body) {
  if (!body || typeof body !== "object" || !body.customer || typeof body.customer !== "object") return body;
  const c = body.customer;
  if (c.country != null || c.state != null || c.zip != null) return body;
  return { ...body, customer: { ...c, ...DEFAULT_SHIP_ADDRESS } };
}
if (!globalThis.__ship48DefaultAddress) {
  globalThis.__ship48DefaultAddress = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, init) => {
    try {
      const u = typeof url === "string" ? url : String(url?.url ?? url);
      if (init && String(init.method || "GET").toUpperCase() === "POST" && typeof init.body === "string" && CHECKOUT_POST.test(new URL(u).pathname)) {
        const b = JSON.parse(init.body);
        const nb = withDefaultShipAddress(b);
        if (nb !== b) init = { ...init, body: JSON.stringify(nb) };
      }
    } catch { /* not JSON: send as is */ }
    return realFetch(url, init);
  };
}
