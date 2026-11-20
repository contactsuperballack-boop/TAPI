const { ApiError } = require("../domain/errors");

// Client mistakes that Express/body-parser/pg raise as plain Errors: answer 4xx, never 500, never echo internals.
function clientError(err) {
  if (!err || err instanceof ApiError) return null;
  if (err.type === "entity.parse.failed") return new ApiError("INVALID_REQUEST_BODY", 400, "Invalid request body", "The request body is not valid JSON.");
  if (err.type === "entity.too.large") return new ApiError("REQUEST_TOO_LARGE", 413, "Request too large", "The request body is too large.");
  if (err.type === "encoding.unsupported" || err.type === "charset.unsupported") return new ApiError("INVALID_REQUEST_BODY", 415, "Unsupported encoding", "Unsupported request encoding.");
  if (["22P02", "22007", "22008"].includes(err.code)) return new ApiError("VALIDATION_ERROR", 400, "Invalid request", "One of the supplied values is not in a valid format.");
  return null;
}

function errorHandler(rawErr, req, res, next) {
  const err = clientError(rawErr) || rawErr;
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
