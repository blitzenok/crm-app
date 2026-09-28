// Rapid Fulfillment (3PL) SOAP client. rpc/encoded, namespace urn:WF, no dependencies.
// Env: RAPID_ENV=test|live, RAPID_TEST_API_USER/PASS, RAPID_TEST_TLS_INSECURE (test only), RAPID_TIMEOUT_MS.
// The live account is refused unless RAPID_LIVE_CONFIRM=yes-live (phase 1: test server only).
import https from "node:https";

export const RAPID_ENDPOINTS = {
  test: "https://biolabsresearch.test.rapidfulfillmentcrm.com/api/soap/?action",
  live: "https://biolabsresearch.rapidfulfillmentcrm.com/api/soap/?action",
};
const SOAP_ACTION = "urn:WF_Api_Soap_HandlerAction";

export const RAPID_ERROR_CODES = {
  0: "unknown_error",
  1: "access_denied",
  2: "invalid_path",
  3: "session_expired",
  4: "missing_parameter",
  5: "internal_error",
  6: "not_found",
  7: "already_exists",
  10: "client_error",
  100: "custom_error",
};

export class RapidError extends Error {
  constructor(code, message, extra = {}) {
    super(message || RAPID_ERROR_CODES[code] || "rapid_error");
    this.name = "RapidError";
    this.code = code; // numeric SOAP fault code, or a string for transport errors
    this.kind = typeof code === "number" ? RAPID_ERROR_CODES[code] || "rapid_error" : code;
    this.method = extra.method || null;
    this.retriable = Boolean(extra.retriable);
    this.httpStatus = extra.httpStatus || null;
  }
}

// ---- types (from the WSDL), field order kept -------------------------------------------------------------
const S = "string";
const I = "int";
const B = "boolean";
const ADDRESS = { customer_id: S, title: S, firstname: S, surname: S, company: S, address: S, address2: S, town: S, county: S, postcode: S, country: S, phone: S, fax: S, email: S, tax_no: S };
export const TYPES = {
  associativeEntity: { key: S, value: S },
  associativeArray: ["associativeEntity"],
  complexFilter: { key: S, value: "associativeEntity" },
  complexFilterArray: ["complexFilter"],
  filters: { filter: "associativeArray", complex_filter: "complexFilterArray" },
  ordersAddressData: ADDRESS,
  addressUpdateData: { ...ADDRESS, comments: S },
  ordersProductsData: { product_id: S, name: S, qty: I, unit_price: S, total_price: S, extra: S },
  ordersProductsDataArray: ["ordersProductsData"],
  ordersNewData: {
    order_id_prefix: I, order_id: I, source: S, order_date: S, billing_address: "ordersAddressData", shipping_address: "ordersAddressData",
    products: "ordersProductsDataArray", subtotal: S, shipping_cost: S, discount: S, nettotal: S, vat: S, vat_rate: S, total_cost: S,
    paidtodate: S, currency: S, message: S, shipping_method: S, custom_data: "associativeArray",
  },
  rmaAddData: { order_id_prefix: I, order_id: I, rma_number: S },
};
// method -> ordered [part, type]
export const METHODS = {
  login: [["username", S], ["password", S]],
  logout: [["sessionId", S]],
  couriers_list: [["sessionId", S]],
  orders_new: [["sessionId", S], ["ordersData", "ordersNewData"]],
  orders_cancel: [["sessionId", S], ["reason", S], ["order_id", I], ["order_id_prefix", I]],
  orders_search: [["sessionId", S], ["filters", "associativeArray"], ["incl_shipping_addr", B], ["incl_products_info", B]],
  rma_add: [["sessionId", S], ["rmaData", "rmaAddData"], ["getImage", B]],
  returns_list: [["sessionId", S], ["date", S]],
  orders_returns: [["sessionId", S], ["date", S]],
  orders_rejected: [["sessionId", S], ["date", S]],
  address_update: [["sessionId", S], ["addressData", "addressUpdateData"], ["order_id", I], ["order_id_prefix", I], ["force_validation", B]],
  products_stock: [["sessionId", S], ["filters", "filters"]],
};

export function xmlEscape(v) {
  return String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c])
    // XML 1.0 forbids most control characters
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function encodeValue(name, value, type) {
  if (value === undefined || value === null) return "";
  if (type === S) return `<${name} xsi:type="xsd:string">${xmlEscape(value)}</${name}>`;
  if (type === I) {
    const n = Number(value);
    if (!Number.isInteger(n)) throw new RapidError("invalid_argument", `${name} must be an integer`);
    return `<${name} xsi:type="xsd:int">${n}</${name}>`;
  }
  if (type === B) return `<${name} xsi:type="xsd:boolean">${value ? "true" : "false"}</${name}>`;
  const def = TYPES[type];
  if (!def) throw new RapidError("invalid_argument", `unknown type ${type}`);
  if (Array.isArray(def)) {
    const list = Array.isArray(value) ? value : [];
    const inner = list.map((v) => encodeValue("item", v, def[0])).join("");
    return `<${name} SOAP-ENC:arrayType="ns1:${def[0]}[${list.length}]" xsi:type="ns1:${type}">${inner}</${name}>`;
  }
  const inner = Object.entries(def).map(([k, t]) => encodeValue(k, value[k], t)).join("");
  return `<${name} xsi:type="ns1:${type}">${inner}</${name}>`;
}

export function buildEnvelope(method, args = {}) {
  const parts = METHODS[method];
  if (!parts) throw new RapidError("invalid_argument", `unknown method ${method}`);
  const body = parts.map(([p, t]) => encodeValue(p, args[p], t)).join("");
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ns1="urn:WF" ' +
    'xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
    'xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" SOAP-ENV:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<SOAP-ENV:Body><ns1:${method}>${body}</ns1:${method}></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

// ---- tiny XML reader (enough for SOAP responses) -------------------------------------------------------
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === "amp") return "&"; if (k === "lt") return "<"; if (k === "gt") return ">";
    if (k === "quot") return '"'; if (k === "apos") return "'";
    const code = k.startsWith("#x") ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

export function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) { top.text += m[1]; continue; }
    if (m[6] !== undefined) { top.text += decodeEntities(m[6]); continue; }
    if (!m[3]) continue; // PI / comment
    if (m[2] === "/") { if (stack.length > 1) stack.pop(); continue; }
    const attrs = {};
    const ar = /([\w.:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = ar.exec(m[4] || ""))) attrs[a[1]] = decodeEntities(a[2] ?? a[3]);
    const node = { name: m[3], attrs, children: [], text: "" };
    top.children.push(node);
    if (m[5] !== "/") stack.push(node);
  }
  return root;
}

const local = (n) => String(n).replace(/^.*:/, "");
function attr(node, name) {
  for (const [k, v] of Object.entries(node.attrs)) if (local(k) === name) return v;
  return undefined;
}

/** SOAP-encoded node -> JS value (arrays by arrayType / *Array type / item children; xsd types converted). */
export function nodeToValue(node) {
  if (attr(node, "nil") === "true") return null;
  const type = local(attr(node, "type") || "");
  const isArray = attr(node, "arrayType") !== undefined || /Array$/.test(type) ||
    (node.children.length > 0 && node.children.every((c) => local(c.name) === "item") && !/Data$/.test(type) && type !== "Map");
  if (isArray) return node.children.map(nodeToValue);
  if (type === "Map") {
    const o = {};
    for (const it of node.children) {
      const k = it.children.find((c) => local(c.name) === "key");
      const v = it.children.find((c) => local(c.name) === "value");
      if (k) o[k.text] = v ? nodeToValue(v) : null;
    }
    return o;
  }
  if (node.children.length) {
    const o = {};
    for (const c of node.children) o[local(c.name)] = nodeToValue(c);
    return o;
  }
  const t = node.text;
  if (type === "int" || type === "integer" || type === "long" || type === "short") return t.trim() === "" ? null : Number(t);
  if (type === "float" || type === "double" || type === "decimal") return Number(t);
  if (type === "boolean") return t.trim() === "true" || t.trim() === "1";
  return t;
}

function findLocal(node, name) {
  if (local(node.name) === name) return node;
  for (const c of node.children) { const r = findLocal(c, name); if (r) return r; }
  return null;
}

/** Parse a SOAP response: returns the first return part's value, or throws RapidError for a Fault. */
export function parseResponse(xml, method) {
  const doc = parseXml(String(xml || ""));
  const fault = findLocal(doc, "Fault");
  if (fault) {
    const fc = fault.children.find((c) => local(c.name) === "faultcode");
    const fs = fault.children.find((c) => local(c.name) === "faultstring");
    const raw = (fc?.text || "").trim().replace(/^.*:/, "");
    const code = /^\d+$/.test(raw) ? Number(raw) : raw || "fault";
    throw new RapidError(code, (fs?.text || "").trim() || RAPID_ERROR_CODES[code] || "SOAP fault", { method, retriable: code === 5 });
  }
  const body = findLocal(doc, "Body");
  const resp = body && body.children[0];
  if (!resp) throw new RapidError("bad_response", "no SOAP body", { method, retriable: true });
  const part = resp.children[0];
  return part ? nodeToValue(part) : null;
}

// ---- transport -----------------------------------------------------------------------------------------
function httpsPost(url, xml, { timeoutMs, insecure }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method: "POST", hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`,
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `"${SOAP_ACTION}"`, "Content-Length": Buffer.byteLength(xml), "User-Agent": "biolabs-crm-umg/rapid" },
      rejectUnauthorized: !insecure,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" })));
    req.on("error", reject);
    req.end(xml);
  });
}

export function rapidConfig(env = process.env) {
  const mode = String(env.RAPID_ENV || "test").toLowerCase() === "live" ? "live" : "test";
  const P = mode === "live" ? "RAPID_LIVE_" : "RAPID_TEST_";
  return {
    env: mode,
    enabled: env.RAPID_ENABLED === "true",
    autoPush: env.RAPID_AUTO_PUSH === "true",
    allowRealOrders: env.RAPID_ALLOW_REAL_ORDERS === "true",
    liveConfirmed: env.RAPID_LIVE_CONFIRM === "yes-live",
    endpoint: env.RAPID_ENDPOINT_OVERRIDE && mode === "test" ? env.RAPID_ENDPOINT_OVERRIDE : RAPID_ENDPOINTS[mode],
    username: env[`${P}API_USER`] || "",
    password: env[`${P}API_PASS`] || "",
    // The certificate bypass exists only for the test host.
    insecureTls: mode === "test" && env.RAPID_TEST_TLS_INSECURE === "true",
    timeoutMs: Number(env.RAPID_TIMEOUT_MS) > 0 ? Number(env.RAPID_TIMEOUT_MS) : 20000,
    retries: Number.isInteger(Number(env.RAPID_RETRIES)) ? Number(env.RAPID_RETRIES) : 2,
    orderPrefix: Number.isInteger(Number(env.RAPID_ORDER_PREFIX)) && env.RAPID_ORDER_PREFIX !== undefined ? Number(env.RAPID_ORDER_PREFIX) : 100,
    testOrderPrefix: Number.isInteger(Number(env.RAPID_TEST_ORDER_PREFIX)) && env.RAPID_TEST_ORDER_PREFIX !== undefined ? Number(env.RAPID_TEST_ORDER_PREFIX) : 990,
    source: env.RAPID_SOURCE || "biolabsresearch.co",
    giftMode: env.RAPID_GIFT_MODE === "neutral" ? "neutral" : "omit",
    skuMapPath: env.RAPID_SKU_MAP_PATH || "/etc/crm-umg/rapid-sku-map.json",
    shipMap: (() => { try { return JSON.parse(env.RAPID_SHIP_MAP || "null"); } catch { return null; } })(),
  };
}

/**
 * createRapidClient({ config, transport, sleep }). transport(url, xml, {timeoutMs, insecure}) -> {status, text}
 * is injectable for tests. Session: lazy login, cached, one re-login on fault 3.
 */
export function createRapidClient(opts = {}) {
  const cfg = opts.config || rapidConfig();
  const transport = opts.transport || httpsPost;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let sessionId = null;

  function guard() {
    if (cfg.env === "live" && !cfg.liveConfirmed) throw new RapidError("live_disabled", "live Rapid account is disabled in this phase");
    if (!cfg.username || !cfg.password) throw new RapidError("not_configured", "Rapid API credentials missing");
  }

  async function raw(method, args) {
    guard();
    const xml = buildEnvelope(method, args);
    let lastErr;
    for (let attempt = 0; attempt <= cfg.retries; attempt += 1) {
      if (attempt) await sleep(500 * 2 ** (attempt - 1));
      let res;
      try {
        res = await transport(cfg.endpoint, xml, { timeoutMs: cfg.timeoutMs, insecure: cfg.insecureTls });
      } catch (err) {
        lastErr = new RapidError(err?.code === "ETIMEDOUT" ? "timeout" : "network", err?.code === "ETIMEDOUT" ? "Rapid request timed out" : `network error (${err?.code || "error"})`, { method, retriable: true });
        continue;
      }
      if (res.status >= 500 && !/Fault/.test(res.text || "")) {
        lastErr = new RapidError("http_error", `HTTP ${res.status}`, { method, retriable: true, httpStatus: res.status });
        continue;
      }
      try {
        return parseResponse(res.text, method);
      } catch (err) {
        if (err instanceof RapidError && err.retriable && attempt < cfg.retries) { lastErr = err; continue; }
        throw err;
      }
    }
    throw lastErr;
  }

  async function login() {
    const id = await raw("login", { username: cfg.username, password: cfg.password });
    if (!id || typeof id !== "string") throw new RapidError("bad_response", "login returned no session", { method: "login" });
    sessionId = id;
    return id;
  }

  async function call(method, args = {}) {
    if (!sessionId) await login();
    try {
      return await raw(method, { ...args, sessionId });
    } catch (err) {
      if (err instanceof RapidError && err.code === 3) {
        await login();
        return raw(method, { ...args, sessionId });
      }
      throw err;
    }
  }

  const kv = (obj) => Object.entries(obj || {}).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([key, value]) => ({ key, value: String(value) }));
  const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  // Rapid answers an empty search with fault 6 (Not Found); list methods return [] for that.
  const listOrEmpty = async (method, args) => {
    try { return list(await call(method, args)); } catch (err) { if (err instanceof RapidError && err.code === 6) return []; throw err; }
  };

  return {
    config: cfg,
    login,
    async logout() {
      if (!sessionId) return true;
      const id = sessionId;
      sessionId = null;
      try { return Boolean(await raw("logout", { sessionId: id })); } catch { return false; }
    },
    get hasSession() { return Boolean(sessionId); },
    call,
    couriersList: async () => list(await call("couriers_list")),
    /** true on success; code 7 (already exists) is reported as { ok:true, alreadyExists:true }. */
    async ordersNew(ordersData) {
      try {
        const r = await call("orders_new", { ordersData });
        return { ok: r === true || r === "true" || r === 1, alreadyExists: false, raw: r };
      } catch (err) {
        if (err instanceof RapidError && err.code === 7) return { ok: true, alreadyExists: true };
        throw err;
      }
    },
    ordersCancel: async (orderId, prefix, reason) => Boolean(await call("orders_cancel", { reason: reason || "Cancelled", order_id: orderId, order_id_prefix: prefix })),
    ordersSearch: async (filters, { shipping = false, products = false } = {}) =>
      listOrEmpty("orders_search", { filters: kv(filters), incl_shipping_addr: shipping, incl_products_info: products }),
    rmaAdd: async (orderId, prefix, rmaNumber, getImage = false) => call("rma_add", { rmaData: { order_id_prefix: prefix, order_id: orderId, rma_number: rmaNumber }, getImage }),
    returnsList: async (date) => listOrEmpty("returns_list", { date }),
    ordersRejected: async (date) => listOrEmpty("orders_rejected", { date }),
    addressUpdate: async (orderId, prefix, address, forceValidation = false) =>
      Boolean(await call("address_update", { addressData: address, order_id: orderId, order_id_prefix: prefix, force_validation: forceValidation })),
    productsStock: async (filter = {}, complexFilter = []) =>
      listOrEmpty("products_stock", { filters: { filter: kv(filter), complex_filter: complexFilter } }),
  };
}
