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
  constructor({ authMode, bearerToken, apiKey, baseUrl = "https://letsfg.co", environment = "production", timeoutMs, breaker } = {}) {
    this.authMode = authMode; // 'pfs' | 'developer'
    this.environment = environment; // 'sandbox' | 'production'
    this.bearerToken = bearerToken;
    this.apiKey = apiKey;
    this.baseUrl = String(baseUrl).replace(/\/$/, "");
    if (!["sandbox", "production"].includes(this.environment)) {
      throw new Error("LETSFG_ENVIRONMENT must be 'sandbox' or 'production'");
    }
    if (this.environment === "sandbox" && authMode !== "developer") {
      throw new Error("LetsFG sandbox requires LETSFG_AUTH_MODE=developer");
    }

    if (authMode === "pfs" && !bearerToken) {
      throw new Error("LETSFG_BEARER_TOKEN is required when LETSFG_AUTH_MODE=pfs");
    }
    if (authMode === "developer" && !apiKey && this.environment !== "sandbox") {
      throw new Error("LETSFG_API_KEY is required for production Developer API requests");
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
    const headers = { "Content-Type": "application/json" };
    if (this.authMode === "pfs") headers.Authorization = `Bearer ${this.bearerToken}`;
    if (this.apiKey) headers["X-API-Key"] = this.apiKey;
    return headers;
  }

  developerPath(resource) {
    const clean = String(resource).replace(/^\/+/, "");
    const prefix = this.environment === "sandbox"
      ? "/developers/api/v1/sandbox/"
      : "/developers/api/v1/";
    return `${prefix}${clean}`;
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
      const bodyText = await res.text().catch(() => "");
      let supplierBody = {};
      try { supplierBody = bodyText ? JSON.parse(bodyText) : {}; } catch (_) { /* retain bounded text only */ }
      const message = supplierBody.message || supplierBody.error || bodyText.slice(0, 300) || `HTTP ${res.status}`;
      // A supplier 4xx refusal (e.g. missing_fields / payment_declined)
      // is definitive; a 5xx remains ambiguous because the supplier may
      // have accepted the mutation before failing to respond.
      if (res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429) {
        const err = new Error(`LetsFG ${res.status} on ${path}: ${String(message).slice(0, 300)}`);
        err.code = "SUPPLIER_REJECTED";
        err.httpStatus = res.status;
        err.supplierError = supplierBody;
        throw err;
      }
      throw Errors.SupplierUnavailable(`LetsFG ${res.status} on ${path}: ${String(message).slice(0, 300)}`);
    }
    return res.json();
  }
}

module.exports = { LetsFGClient };
