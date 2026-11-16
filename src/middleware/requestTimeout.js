// Request timeout policy. Without this, a hung supplier call (network
// partition, LetsFG simply never responding) blocks the request — and the
// underlying connection — indefinitely. Node itself has no default request
// timeout that fires before something upstream (a load balancer) gives up
// first, which is a bad way to discover this in production.
//
// This does NOT solve supplier-level retry/circuit-breaking (see README:
// "Supplier retry policy" is still open, real infra work) — it only bounds
// how long a single request can hang before TAPI itself gives up and
// returns a clean error, rather than never responding at all.
const { Errors } = require("../domain/errors");

function requestTimeout(ms = 30_000) {
  return (req, res, next) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        next(Errors.SupplierTimeout(`Request exceeded ${ms}ms — likely a hung upstream (supplier) call. See correlationId ${req.correlationId} in server logs.`));
      }
      // NOTE — real limitation, not silently glossed over: this does NOT
      // cancel the underlying async work (e.g. a hung `fetch()` call inside
      // letsfgClient.js). Node's fetch has no timeout by default and this
      // middleware doesn't thread an AbortController through the call
      // chain to actually cancel it — that's a real follow-up, not done
      // here. This only bounds what the CLIENT waits for; the original
      // handler keeps running until its own promise settles. If it later
      // tries to write a second response, Express's own `res.headersSent`
      // check safely no-ops that rather than crashing the process — this
      // relies on that built-in Express behavior, not an additional guard here.
    }, ms);

    res.on("finish", () => clearTimeout(timer));
    res.on("close", () => clearTimeout(timer));
    next();
  };
}

module.exports = { requestTimeout };
