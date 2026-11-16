const { ApiError } = require("../domain/errors");

function errorHandler(err, req, res, next) {
  const isKnown = err instanceof ApiError;
  const status = isKnown ? err.status : 500;

  if (!isKnown) {
    // Never leak internal stack traces or raw supplier payloads to clients.
    console.error("[unhandled]", req.correlationId, err);
  }

  res.status(status).type("application/problem+json").json({
    type: `https://tapi.dev/errors/${isKnown ? err.code.toLowerCase() : "internal-error"}`,
    title: isKnown ? err.message : "Internal Server Error",
    status,
    detail: isKnown ? err.detail : "An unexpected error occurred.",
    instance: req.originalUrl,
    timestamp: new Date().toISOString(),
    code: isKnown ? err.code : "INTERNAL_ERROR",
    correlationId: req.correlationId, // ties a client-reported error back to server-side structured logs
  });
}

module.exports = { errorHandler };
