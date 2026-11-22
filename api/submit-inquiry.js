const maxRequestBytes = 48_000;
const encoder = new TextEncoder();
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const unavailable = "Online enquiries are temporarily unavailable. You can send your enquiry by email instead.";

/** @param {unknown} value */
function getText(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** @param {Request} request */
export async function submitInquiry(request) {
  const origin = request.headers.get("origin");
  const allowedOrigins = (Deno.env.get("INQUIRY_ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (origin && !allowedOrigins.includes(origin)) {
    return Response.json({ error: "Send your enquiry from the Contact page." }, {
      status: 403,
      headers: { "Cache-Control": "no-store", Vary: "Origin" }
    });
  }

  const headers = new Headers({ "Cache-Control": "no-store", Vary: "Origin" });
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "authorization, apikey, content-type, x-client-info");
  }

  /** @param {number} status @param {{error?: string, success?: boolean}} body */
  const reply = (status, body) => Response.json(body, { status, headers });

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") {
    headers.set("Allow", "POST, OPTIONS");
    return reply(405, { error: "Use the Contact page to send an enquiry." });
  }
  if (request.headers.get("sec-fetch-site") === "cross-site" && !origin) {
    return reply(403, { error: "Send your enquiry from the Contact page." });
  }
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    return reply(415, { error: "Use the Contact form to send your enquiry." });
  }
  if (Number(request.headers.get("content-length")) > maxRequestBytes) {
    return reply(413, { error: "Your enquiry is too long. Please shorten your project details." });
  }

  let submission;
  try {
    const body = await request.text();
    if (encoder.encode(body).byteLength > maxRequestBytes) {
      return reply(413, { error: "Your enquiry is too long. Please shorten your project details." });
    }
    submission = JSON.parse(body);
  } catch {
    return reply(400, { error: "We couldn’t read your enquiry. Please try again." });
  }

  const name = getText(submission?.name);
  const email = getText(submission?.email);
  const service = getText(submission?.service);
  const message = getText(submission?.message);

  if (getText(submission?.website)) {
    return reply(400, { error: "We couldn’t accept your enquiry. Reload the Contact page and try again." });
  }
  if (!name || name.length > 120 || email.length > 254 || !emailPattern.test(email)) {
    return reply(400, { error: "Enter your name and a valid email address." });
  }
  if (!message || message.length > 8000 || service.length > 120) {
    return reply(400, { error: "Enter project details of up to 8,000 characters." });
  }

  const token = Deno.env.get("AIRTABLE_TOKEN")?.trim();
  const baseId = Deno.env.get("AIRTABLE_BASE_ID")?.trim();
  const tableId = Deno.env.get("AIRTABLE_TABLE_ID")?.trim();
  if (!token || !baseId || !tableId) return reply(503, { error: unavailable });

  const fields = { Name: name, Email: email, Service: service, Message: message };
  const url = `https://api.airtable.com/v0/${encodeURIComponent(baseId)}/${encodeURIComponent(tableId)}`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ records: [{ fields }] }),
      redirect: "error",
      signal: AbortSignal.timeout(10_000)
    });

    if (!response.ok) {
      console.error("Airtable rejected an enquiry", response.status);
      return reply(503, { error: unavailable });
    }
    return reply(201, { success: true });
  } catch (error) {
    console.error("Airtable enquiry could not be submitted", error instanceof Error ? error.name : "UnknownError");
    return reply(503, { error: unavailable });
  }
}
