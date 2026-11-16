const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const { errorHandler } = require("./middleware/errorHandler");
const { requireRole, authenticate } = require("./middleware/auth");
const { perIpLimiter, perTenantLimiter } = require("./middleware/rateLimiter");
const { auditMutations } = require("./middleware/auditLog");
const { requestContext } = require("./middleware/requestContext");
const { requestTimeout } = require("./middleware/requestTimeout");
const flightRoutes = require("./routes/flights.routes");
const hotelRoutes = require("./routes/hotels.routes");
const busRoutes = require("./routes/buses.routes");
const mobilityRoutes = require("./routes/mobility.routes");
const authRoutes = require("./routes/auth.routes");
const orderRoutes = require("./routes/orders.routes");
const tripRoutes = require("./routes/trips.routes");
const accountRoutes = require("./routes/account.routes");
const staffRoutes = require("./routes/staff.routes");
const fulfilmentRoutes = require("./routes/fulfilment.routes");
const travelerRoutes = require("./routes/travelers.routes");
const paymentWebhookRoutes = require("./routes/payments.routes");
const db = require("./db");
const path = require("path");
const { getSupplierHealth } = require("./services/supplierRegistry");

const app = express();
app.set("trust proxy", true); // req.ip reflects the real client behind a load balancer, not the LB itself
app.use(helmet());
app.use(cors({ origin: (process.env.ALLOWED_ORIGINS || "").split(",").filter(Boolean) }));
app.use(requestContext); // correlation ID + structured request logging (Master Spec §19), before anything else
app.use(requestTimeout(Number(process.env.REQUEST_TIMEOUT_MS) || 30_000));

app.get("/healthz", (req, res) => res.json({ status: "ok" }));
app.use("/console", express.static(path.join(__dirname, "../console")));
// TAPI Agent web UI (built with `cd web && npm run build`). Hash-routed single page, so no catch-all route needed.
app.use("/app", express.static(path.join(__dirname, "../web/dist")));

// Real readiness check (Master Spec §19: "Health/readiness endpoints") —
// distinct from /healthz (process is up) vs /readyz (dependencies are up).
// A load balancer or orchestrator should route traffic based on THIS, not
// /healthz — a process that's running but can't reach its database isn't
// ready to serve requests.
app.get("/readyz", async (req, res) => {
  try {
    await db.query("SELECT 1");
    // Sprint 2 hardening: surfaces per-supplier circuit-breaker state
    // alongside the DB check — a supplier stuck "open" is exactly the kind
    // of degraded-but-not-fully-down condition a readiness check should
    // report, even though it doesn't fail the check outright (TAPI itself
    // is still up and can still serve requests for other suppliers/verticals).
    res.json({ status: "ready", database: "connected", suppliers: getSupplierHealth() });
  } catch (err) {
    res.status(503).json({ status: "not_ready", database: "unreachable", detail: err.message });
  }
});

// Payment webhook MUST be mounted with express.raw() and BEFORE the global
// express.json() parser below — signature verification needs the exact raw
// bytes the provider signed, not a re-serialized JSON object. Not behind
// `authenticate`: the provider calls this, not an agency; it's protected by
// signature verification instead (see routes/payments.routes.js).
app.use("/v1/payments", express.raw({ type: "application/json" }), paymentWebhookRoutes);

app.use(express.json());

// Global per-IP guard against brute-forcing API keys or hammering
// unauthenticated endpoints — runs BEFORE `authenticate`, so cycling through
// invalid keys doesn't bypass it. Generous limit; the tenant-scoped limiters
// below are the ones that actually protect expensive operations.
app.use("/v1", perIpLimiter({ name: "global-ip", capacity: 60, refillPerSecond: 2 }));

// Every /v1 route below requires agency/API-key auth + tenant scoping
// (T-020, T-021), then audits mutating requests (T-097 / Master Spec §11) —
// this applies identically whether the caller is a REST client or the MCP
// server, since MCP calls these same authenticated endpoints rather than
// reimplementing its own auth/audit story. See mcp/ directory.
// Sign-up / sign-in / verify / reset. Public (rate limited per IP inside the router); /me, /logout, /resend authenticate themselves.
app.use("/v1/account", accountRoutes);
// API-key management is admin-only: agents (non-admin staff) and travellers must not mint or revoke keys.
app.use("/v1/auth", authenticate, requireRole("admin"), perTenantLimiter({ name: "auth-keys", capacity: 10, refillPerSecond: 0.2 }), auditMutations, authRoutes);
app.use("/v1/fulfilment", authenticate, requireRole("admin", "agent"), perTenantLimiter({ name: "fulfilment", capacity: 60, refillPerSecond: 2 }), auditMutations, fulfilmentRoutes);
app.use("/v1/staff", authenticate, requireRole("admin"), perTenantLimiter({ name: "staff", capacity: 20, refillPerSecond: 1 }), auditMutations, staffRoutes);
app.use("/v1/flights", authenticate, perTenantLimiter({ name: "flights", capacity: 30, refillPerSecond: 3 }), auditMutations, flightRoutes);
app.use("/v1/hotels", authenticate, perTenantLimiter({ name: "hotels", capacity: 30, refillPerSecond: 3 }), auditMutations, hotelRoutes);
app.use("/v1/buses", authenticate, perTenantLimiter({ name: "buses", capacity: 30, refillPerSecond: 3 }), auditMutations, busRoutes);
app.use("/v1/mobility", authenticate, perTenantLimiter({ name: "mobility", capacity: 60, refillPerSecond: 5 }), auditMutations, mobilityRoutes);
app.use("/v1/travelers", authenticate, perTenantLimiter({ name: "travelers", capacity: 30, refillPerSecond: 3 }), auditMutations, travelerRoutes);
app.use("/v1/trips", authenticate, perTenantLimiter({ name: "trips", capacity: 30, refillPerSecond: 3 }), auditMutations, tripRoutes);
app.use("/v1/orders", authenticate, perTenantLimiter({ name: "orders", capacity: 20, refillPerSecond: 2 }), auditMutations, orderRoutes);

app.use(errorHandler); // must be last

module.exports = app;
