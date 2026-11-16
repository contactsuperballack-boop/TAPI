// MCP calls TAPI's own HTTP API — it never talks to LetsFG or any other
// supplier directly, and never reimplements auth/tenant-scoping/idempotency
// logic. This is deliberate: Master Spec §14 — "MCP must not contain
// supplier-specific business rules" and "MCP must enforce the same
// authorization and audit controls as other clients." By routing every
// tool call through the same authenticated REST API everything else uses,
// MCP automatically inherits tenant isolation, rate limiting, audit
// logging (see middleware/auditLog.js), and idempotency — none of that had
// to be reimplemented here.
//
// One MCP server process = one agency. The API key is configured once at
// startup (TAPI_API_KEY env var), not per-tool-call — there is no concept
// of "switch agency mid-conversation" in this MVP. If that's ever needed,
// it's a new decision, not an assumption to bake in silently.
const { randomUUID } = require("crypto");

const BASE_URL = process.env.TAPI_BASE_URL || "http://localhost:3000";
const API_KEY = process.env.TAPI_API_KEY;

if (!API_KEY) {
  // Fail at startup, loudly — not on the first tool call, where the error
  // would be confusing to whatever LLM/agent is driving the MCP client.
  throw new Error("TAPI_API_KEY is required to start the TAPI MCP server. Create one with `npm run cli -- keys-create`.");
}

async function tapiRequest(method, path, { body, idempotencyKey } = {}) {
  const headers = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Surface TAPI's own RFC 7807 error shape rather than a generic HTTP
    // error — the caller (an LLM) benefits from the same machine-readable
    // `code`/`detail` a REST client would get.
    const err = new Error(data.detail || data.title || `TAPI request failed: ${res.status}`);
    err.status = res.status;
    err.code = data.code;
    throw err;
  }
  return data;
}

/** Generates an idempotency key when the caller (an LLM) doesn't supply one — booking/order mutations require one. */
function newIdempotencyKey() {
  return randomUUID();
}

module.exports = { tapiRequest, newIdempotencyKey };
