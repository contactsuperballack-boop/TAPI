// Audit logging (Master Spec §11: "Audit authentication and sensitive
// mutations"). Fixes a real gap found while building MCP's authorization
// story: audit_events has existed in the schema since migration 001, but
// nothing actually wrote to it — every route, REST or MCP, was equally
// un-audited. This isn't an MCP-specific fix; MCP inherits it automatically
// by calling the same authenticated API everything else does.
//
// Writes are fire-and-forget (never block or fail the request on a logging
// write) but errors are surfaced to console rather than silently swallowed.
const db = require("../db");

async function writeAuditEvent({ agencyId, actor, action, resourceType, resourceId, metadata }) {
  try {
    await db.query(
      `INSERT INTO audit_events (agency_id, actor, action, resource_type, resource_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [agencyId || null, actor || "unknown", action, resourceType || null, resourceId || null, metadata || {}]
    );
  } catch (err) {
    // Audit logging must never take the API down. Log to console and move on.
    console.error("[audit] failed to write audit event:", err.message);
  }
}

/** Call from auth middleware failure branches. agencyId is null when unknown (invalid key, no header). */
function logAuthFailure(req, reason, agencyId) {
  writeAuditEvent({
    agencyId: agencyId || null,
    actor: "unauthenticated",
    action: "AUTH_FAILURE",
    resourceType: "api_client",
    metadata: { reason, ip: req.ip, path: req.originalUrl, method: req.method },
  });
}

/**
 * Middleware: audits every mutating request (POST/PUT/PATCH/DELETE) after
 * it completes, capturing the actual outcome (status code), not just the
 * attempt. Mounted per-router, after `authenticate`, so req.tenant exists.
 * Read-only (GET) requests are not audited here — logging every search poll
 * would be noise, not signal; booking/payment/order mutations are what
 * Master Spec §11 actually cares about.
 */
function auditMutations(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();

  res.on("finish", () => {
    // Resource id: prefer an explicit path param (bookingId, orderId, etc.)
    // over nothing — best-effort, not a strict schema.
    const resourceId = Object.values(req.params || {})[0] || null;
    const resourceType = req.baseUrl.split("/").filter(Boolean).pop() || "unknown"; // e.g. 'flights', 'orders'

    writeAuditEvent({
      agencyId: req.tenant?.agencyId,
      actor: req.tenant?.apiClientId || "unknown",
      action: `${req.method} ${req.route ? req.baseUrl + req.route.path : req.originalUrl}`,
      resourceType,
      resourceId,
      metadata: { statusCode: res.statusCode, ip: req.ip },
    });
  });

  next();
}

module.exports = { writeAuditEvent, logAuthFailure, auditMutations };
