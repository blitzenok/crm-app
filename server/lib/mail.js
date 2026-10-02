/**
 * Transactional mail hook for quote notifications.
 *
 * No in-repo SMTP/CIO credentials. Configure one of:
 *   MAIL_WEBHOOK_URL + optional MAIL_WEBHOOK_TOKEN
 *   CIO_TRANSACTIONAL_URL + CIO_API_KEY
 *
 * If neither is set the send fails with "no_transport" (quote.js then stores emailSent:false); the quote still persists.
 * Never log tokens, Authorization headers, or card data.
 */

export const QUOTE_NOTIFY_TO = "admin@biolabsresearch.co";

export function formatQuoteEmail(quote) {
  const customer = quote.customer || {};
  const items = Array.isArray(quote.items) ? quote.items : [];
  const lines = items.map((it) => {
    const qty = it.qty ?? it.quantity ?? 1;
    const sku = it.sku || "—";
    const name = it.name || sku;
    return `  - ${qty}× ${name} (${sku}) @ ${it.amount ?? ""}`;
  });
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "—";
  const text = [
    "New storefront quote request (RUO / inquiry — not a payment).",
    "",
    `Quote ID: ${quote.id}`,
    `Idempotency: ${quote.idempotencyKey}`,
    `Amount: ${quote.amount} ${quote.currency || "USD"}`,
    "",
    "Contact:",
    `  Name: ${name}`,
    `  Email: ${customer.email || ""}`,
    `  Phone: ${customer.phone || ""}`,
    `  Address: ${[customer.address, customer.city, customer.state, customer.zip, customer.country].filter(Boolean).join(", ")}`,
    "",
    "Line items:",
    ...(lines.length ? lines : ["  (none)"]),
    "",
    `Notes: ${quote.notes || "(none)"}`,
    "",
    "CRM status: quote_requested / Not Contacted.",
    "Reply to the requester within one business day.",
  ].join("\n");

  return {
    to: QUOTE_NOTIFY_TO,
    subject: `Quote request ${quote.id} — ${quote.amount} ${quote.currency || "USD"}`,
    text,
  };
}

async function defaultTransport(message) {
  const url = process.env.MAIL_WEBHOOK_URL || process.env.CIO_TRANSACTIONAL_URL || "";
  const token = process.env.MAIL_WEBHOOK_TOKEN || process.env.CIO_API_KEY || "";
  // audit 2026-10-02 (r2-sec-outbound-injection-10 / pay-rest-18): with no transport the notification used to be reported as sent
  // (quote.js then stored emailSent:true although nothing left the host). Now it fails like a transport error: emailSent:false.
  if (!url) {
    throw new Error("no_transport");
  }
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // audit 2026-10-02 (concurrency-data-27): a webhook that never answers held the buyer's quote request open for minutes.
  const timeoutMs = Number(process.env.MAIL_WEBHOOK_TIMEOUT_MS) > 0 ? Number(process.env.MAIL_WEBHOOK_TIMEOUT_MS) : 8000;
  const res = await fetch(url, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      to: message.to,
      subject: message.subject,
      text: message.text,
      transactional: true,
    }),
  });
  if (!res.ok) {
    const err = new Error("mail_webhook_failed");
    err.status = res.status;
    throw err;
  }
  return { ok: true, queued: false, transport: "webhook" };
}

export async function sendQuoteNotification(quote, transport = defaultTransport) {
  const message = formatQuoteEmail(quote);
  return transport(message);
}
