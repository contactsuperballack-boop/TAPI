// Authentication (T-020) + tenant context (T-021). Three kinds of caller, one tenant model:
//   1. Agency API key        Bearer tapi_<env>_...   back-office / developer access (acts as admin)
//   2. User session          Bearer tps_...          email + password sign-in: traveller, agent or admin
//   3. Internal service      Bearer svc_...          TAPI calling its own API from the server (loopback only)
//
// History: this file used to say "deliberately NOT consumer JWT/signup" (Master Spec §11). That decision was
// reversed for TAPI Agent: travellers can sign up directly (into the built-in house agency) and agency staff
// sign in with email. The tenant rule is unchanged: every request resolves to exactly ONE agencyId, taken
// from the verified credential, never from client input.
const { ApiKeys, hashKey } = require("../services/apiKeys");
const { Errors } = require("../domain/errors");
const { logAuthFailure } = require("./auditLog");
const { isSessionToken } = require("../services/tokens");
const { getAuthService } = require("../services/authContainer");
const { isServiceToken, fromLoopback } = require("../services/internalAuth");
const { travellerMayCall } = require("../domain/access");
const { Identity } = require("../repositories/identity");

const { UUID } = require("../domain/ids");

async function authenticate(req, res, next) {
  try {
    const header = req.header("Authorization") || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) {
      logAuthFailure(req, "missing_or_malformed_header");
      throw Errors.Unauthorized("Missing or malformed Authorization header. Expected: Bearer <token>");
    }

    if (isSessionToken(token)) {
      const principal = await getAuthService().authenticateSession(token);
      if (!principal) { logAuthFailure(req, "invalid_session"); throw Errors.Unauthorized("Your session has expired. Please sign in again."); }
      // Travellers are deny-by-default: only the endpoints they legitimately need. Use originalUrl so the
      // check sees the full path regardless of where the router is mounted.
      if (principal.role === "traveller" && !travellerMayCall(req.method, req.originalUrl)) {
        logAuthFailure(req, "traveller_forbidden_route", principal.agencyId);
        throw Errors.Forbidden("This action is not available for traveller accounts.");
      }
      req.principal = principal;
      req.tenant = { agencyId: principal.agencyId, apiClientId: principal.actor, userId: principal.userId };
      return next();
    }

    if (token.startsWith("svc_")) {
      const agencyId = req.header("X-Agency-Id") || "";
      if (!isServiceToken(token) || !fromLoopback(req) || !UUID.test(agencyId) || !(await Identity.agencyIsActive(agencyId))) {
        logAuthFailure(req, "invalid_service_credential");
        throw Errors.Unauthorized("Invalid credentials.");
      }
      const actor = `service:${String(req.header("X-Actor") || "agent").slice(0, 80)}`;
      req.principal = { type: "service", role: "admin", agencyId, actor };
      req.tenant = { agencyId, apiClientId: actor };
      return next();
    }

    const client = await ApiKeys.findByHash(hashKey(token));
    if (!client) {
      logAuthFailure(req, "invalid_key");
      throw Errors.Unauthorized("Invalid API key.");
    }
    if (client.status !== "active") {
      logAuthFailure(req, "revoked_key", client.agency_id);
      throw Errors.Unauthorized("This API key has been revoked.");
    }
    if (client.expires_at && new Date(client.expires_at) < new Date()) {
      logAuthFailure(req, "expired_key", client.agency_id);
      throw Errors.Unauthorized("This API key has expired.");
    }

    // Tenant context propagated on every request — every downstream query
    // must filter by req.tenant.agencyId. Never trust a client-supplied agency id.
    req.tenant = { agencyId: client.agency_id, apiClientId: client.id };
    req.principal = { type: "api_key", role: "admin", agencyId: client.agency_id, actor: client.id };

    // Throttled write (see ApiKeys.touchLastUsed) — don't block the request on it.
    ApiKeys.touchLastUsed(client.id).catch((err) => console.error("[auth] touchLastUsed failed:", err.message));

    next();
  } catch (err) {
    next(err);
  }
}

// Gate a route to certain roles (API keys and the internal service count as admin).
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.principal && req.principal.role) ? next() : next(Errors.Forbidden("Your role cannot do this."));

module.exports = { authenticate, requireRole, hashKey };
