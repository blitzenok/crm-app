import { formatAmount } from "./card.js";
import { orderAttribution } from "./order-attribution.js"; // infra 2026-09-30 order-attribution
import { stripSecrets } from "./sanitize.js";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function nowIso() {
  return new Date().toISOString();
}

function hasCardPayload(input) {
  if (!input || typeof input !== "object") return false;
  if (input.card && typeof input.card === "object") return true;
  const card = input.cardData || input.card_data;
  if (card && typeof card === "object") return true;
  const number = input.number || input.pan || input.card_number || input.cardNumber;
  if (number && String(number).replace(/\D/g, "").length >= 13) return true;
  return false;
}

function readCustomer(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  return stripSecrets({
    first_name: c.first_name || c.firstName || "",
    last_name: c.last_name || c.lastName || "",
    email: String(c.email || "").trim(),
    phone: c.phone || "",
    address: c.address || "",
    city: c.city || "",
    state: c.state || "",
    zip: c.zip || c.postal_code || c.postalCode || "",
    country: c.country || "",
  });
}

function readItems(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((it) => {
    const row = it && typeof it === "object" ? it : {};
    const qty = Number(row.qty ?? row.quantity);
    return {
      sku: String(row.sku || "").trim(),
      name: String(row.name || "").trim(),
      qty: Number.isFinite(qty) && qty > 0 ? qty : 0,
      amount: formatAmount(row.amount),
    };
  });
}

export function validateQuoteRequest(input) {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "invalid_body", status: 400 };
  }
  if (hasCardPayload(input)) {
    return { ok: false, error: "card_not_accepted", status: 400 };
  }

  const idempotencyKey = String(input.idempotencyKey || input.extOrderId || "").trim();
  if (!idempotencyKey) {
    return { ok: false, error: "idempotency_key_required", status: 400 };
  }

  const amountNum = Number(input.amount);
  if (!Number.isFinite(amountNum) || amountNum <= 0) {
    return { ok: false, error: "invalid_amount", status: 400 };
  }

  const customer = readCustomer(input.customer);
  if (!customer.email) {
    return { ok: false, error: "email_required", status: 400 };
  }
  if (!EMAIL_RE.test(customer.email)) {
    return { ok: false, error: "invalid_email", status: 400 };
  }
  if (!customer.first_name && !customer.last_name) {
    return { ok: false, error: "name_required", status: 400 };
  }

  const items = readItems(input.items);
  if (!items.length) {
    return { ok: false, error: "items_required", status: 400 };
  }
  for (const it of items) {
    if (!it.sku && !it.name) {
      return { ok: false, error: "invalid_item", status: 400 };
    }
    if (it.qty < 1) {
      return { ok: false, error: "invalid_item_qty", status: 400 };
    }
  }

  return {
    ok: true,
    value: {
      idempotencyKey,
      amount: formatAmount(input.amount),
      currency: String(input.currency || "USD").trim().toUpperCase() || "USD",
      customer,
      items,
      notes: String(input.notes || "").slice(0, 2000),
    },
  };
}

export const QUOTE_OK_MESSAGE = "We'll send your quote within one business day.";

export async function createQuote(input, deps) {
  const store = deps.store;
  const sendQuoteEmail = deps.sendQuoteEmail;
  const parsed = validateQuoteRequest(input);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, status: parsed.status };
  }

  const existing = store.getQuoteByIdempotency(parsed.value.idempotencyKey);
  if (existing) {
    return {
      ok: true,
      reused: true,
      status: 200,
      quoteId: existing.id,
      quote: existing,
      message: QUOTE_OK_MESSAGE,
    };
  }

  const quote = {
    id: store.nextQuoteId(),
    type: "lead",
    status: "quote_requested",
    crmStatus: "Not Contacted",
    idempotencyKey: parsed.value.idempotencyKey,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    amount: parsed.value.amount,
    currency: parsed.value.currency,
    customer: parsed.value.customer,
    items: parsed.value.items,
    notes: parsed.value.notes,
    session_id: String(input.session_id || input.sessionId || "").trim(),
    ...orderAttribution(input), // infra 2026-09-30 order-attribution: price requests become CRM orders through card-import
    emailSent: false,
    emailError: null,
  };

  store.upsertQuote(quote);

  if (typeof sendQuoteEmail === "function") {
    try {
      await sendQuoteEmail(quote);
      quote.emailSent = true;
      quote.updatedAt = nowIso();
      store.upsertQuote(quote);
    } catch (err) {
      quote.emailSent = false;
      quote.emailError = err?.message === "mail_webhook_failed" ? "mail_webhook_failed" : "mail_failed";
      quote.updatedAt = nowIso();
      store.upsertQuote(quote);
    }
  }

  return {
    ok: true,
    reused: false,
    status: 200,
    quoteId: quote.id,
    quote: store.getQuote(quote.id),
    message: QUOTE_OK_MESSAGE,
  };
}
