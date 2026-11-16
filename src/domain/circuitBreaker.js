// Sprint 2 hardening: without this, a down/slow supplier degrades every
// single request that touches it — each one pays the full timeout (see
// letsfgClient.js's AbortController fix) before failing, one at a time,
// with no memory of "this has been failing repeatedly, stop trying for a
// bit." A circuit breaker gives the app that memory: after enough
// consecutive failures, it fails fast (no network call at all) for a
// cooldown window, then allows a single trial request through to see if
// the supplier has recovered.
//
// Deliberately simple — no half-open request counting, no sliding window,
// no persistence across process restarts. This is in-memory and
// per-process, which is the right scope for "does the app doing the API
// call itself have a foggy day, or a clean signal" today. If this ever
// runs as multiple instances behind a load balancer, each instance tracks
// its own circuit state independently — that's a real limitation (the same
// one rateLimiter.js already documents for itself), not silently glossed
// over here.
const { Errors } = require("./errors");

class CircuitBreaker {
  constructor({ name = "supplier", failureThreshold = 5, cooldownMs = 30_000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = "closed"; // 'closed' (normal) | 'open' (failing fast)
    this.consecutiveFailures = 0;
    this.openedAt = null;
  }

  _shouldAttempt() {
    if (this.state === "closed") return true;
    // Cooldown elapsed — allow exactly one trial request through. If it
    // fails, _onFailure() re-opens the circuit and resets the cooldown
    // clock; if it succeeds, _onSuccess() closes the circuit.
    return Date.now() - this.openedAt >= this.cooldownMs;
  }

  /** Runs fn() through the breaker. Throws SupplierUnavailable WITHOUT calling
   * fn() at all if the circuit is open and still cooling down. */
  async execute(fn) {
    if (!this._shouldAttempt()) {
      const remainingMs = this.cooldownMs - (Date.now() - this.openedAt);
      throw Errors.SupplierUnavailable(
        `${this.name} circuit is open after ${this.consecutiveFailures} consecutive failures — failing fast without calling the supplier. Will allow a trial request again in ~${Math.ceil(remainingMs / 1000)}s.`
      );
    }
    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    if (this.state !== "closed") {
      console.log(`[circuit-breaker] ${this.name} closed (recovered)`);
    }
    this.consecutiveFailures = 0;
    this.state = "closed";
    this.openedAt = null;
  }

  _onFailure() {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold && this.state !== "open") {
      this.state = "open";
      this.openedAt = Date.now();
      console.error(`[circuit-breaker] ${this.name} opened after ${this.consecutiveFailures} consecutive failures — failing fast for ${this.cooldownMs}ms`);
    } else if (this.state === "open") {
      // The one trial request during cooldown failed too — stay open, restart the clock.
      this.openedAt = Date.now();
    }
  }

  /** Read-only snapshot for health/readiness reporting. */
  getStatus() {
    return { name: this.name, state: this.state, consecutiveFailures: this.consecutiveFailures };
  }
}

module.exports = { CircuitBreaker };
