// Shared HTTP client for LetsFG. Both the flight and hotel adapters extend
// this rather than duplicating auth/error-mapping logic.
//
// CONFIRMED from LetsFG's own docs/README as of this writing:
//   - PFS path: Bearer token (90-day, from a zero-amount Stripe card setup).
//   - Developer API path: X-API-Key header, prepaid credits.
//   - Developer API base: https://letsfg.co/developers/api/v1
const { Errors } = require("../../domain/errors");
const { CircuitBreaker } = require("../../domain/circuitBreaker");

class LetsFGClient {
  constructor({ authMode, bearerToken, apiKey, baseUrl = "https://letsfg.co", timeoutMs, breaker } = {}) {
    this.authMode = authMode; // 'pfs' | 'developer'
    this.bearerToken = bearerToken;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;

    if (authMode === "pfs" && !bearerToken) {
      throw new Error("LETSFG_BEARER_TOKEN is required when LETSFG_AUTH_MODE=pfs");
    }
    if (authMode === "developer" && !apiKey) {
      throw new Error("LETSFG_API_KEY is required when LETSFG_AUTH_MODE=developer");
    }

    // Sprint 2 hardening: previously no timeout at all — a hung LetsFG
    // connection kept the outbound fetch alive indefinitely, even after
    // middleware/requestTimeout.js gave up waiting on the CLIENT side (that
    // middleware's own comments flagged this exact gap when it was built).
    // Deliberately shorter than REQUEST_TIMEOUT_MS's 30s default so this
    // client-level abort fires and actually cancels the connection before
    // (or close to when) the outer middleware would have given up anyway.
    this.timeoutMs = timeoutMs || Number(process.env.LETSFG_REQUEST_TIMEOUT_MS) || 20_000;

    // Sprint 2 hardening: fail fast after repeated failures instead of
    // making every request pay the full timeout against a supplier that's
    // already down. One breaker per client instance — flights and hotels
    // get independent breakers (see supplierRegistry.js) since they're
    // different LetsFG products, not necessarily correlated outages.
    this.breaker =
      breaker ||
      new CircuitBreaker({
        name: `letsfg:${authMode}`,
        failureThreshold: Number(process.env.LETSFG_CIRCUIT_FAILURE_THRESHOLD) || 5,
        cooldownMs: Number(process.env.LETSFG_CIRCUIT_COOLDOWN_MS) || 30_000,
      });
  }

  _headers() {
    return this.authMode === "pfs"
      ? { Authorization: `Bearer ${this.bearerToken}`, "Content-Type": "application/json" }
      : { "X-API-Key": this.apiKey, "Content-Type": "application/json" };
  }

  async request(method, path, body) {
    return this.breaker.execute(() => this._doRequest(method, path, body));
  }

  async _doRequest(method, path, body) {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: this._headers(),
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      if (err.name === "AbortError") {
        throw Errors.SupplierTimeout(`LetsFG request to ${path} exceeded ${this.timeoutMs}ms and was cancelled.`);
      }
      throw Errors.SupplierUnavailable(`LetsFG request failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status === 504 || res.status === 408) {
      throw Errors.SupplierTimeout(`LetsFG timed out on ${path}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw Errors.SupplierUnavailable(`LetsFG ${res.status} on ${path}: ${text.slice(0, 300)}`);
    }
    return res.json();
  }
}

module.exports = { LetsFGClient };
