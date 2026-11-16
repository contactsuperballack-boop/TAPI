// Correlation IDs + structured logging (Master Spec §19). A real gap until
// now: error responses already had a `timestamp` field but no request
// identifier tying a client-reported error back to server-side logs — and
// there was no structured request logging at all, just ad-hoc
// console.error calls scattered through a few files.
const { v4: uuid } = require("uuid");

function requestContext(req, res, next) {
  req.correlationId = req.header("X-Correlation-Id") || uuid();
  res.setHeader("X-Correlation-Id", req.correlationId);

  const startedAt = Date.now();
  res.on("finish", () => {
    // One structured JSON line per request. Deliberately minimal fields —
    // this is a starting point for real log aggregation (Master Spec §19:
    // "Error tracking... Metrics for search latency, supplier errors,
    // booking success and payment failures"), not the full observability
    // stack itself, which needs a real APM/log pipeline this sandbox can't
    // stand up.
    console.log(JSON.stringify({
      level: "info",
      correlationId: req.correlationId,
      method: req.method,
      path: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      agencyId: req.tenant?.agencyId || null,
      timestamp: new Date().toISOString(),
    }));
  });

  next();
}

module.exports = { requestContext };
