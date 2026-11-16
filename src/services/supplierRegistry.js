// One entry per configured supplier. MVP: LetsFG only. Structured this way
// deliberately so additional adapters (Amadeus, Travelport, Nigerian domestic)
// can register here later without touching route/domain code — see
// TAPI Master Product Document §3.1 (pending Decision Gate, not built yet).
//
// Construction is LAZY and memoized — fixes a confirmed bug: adapters used
// to be constructed eagerly at module load, unconditionally. Their
// constructors throw synchronously if required env vars are missing (e.g.
// PFS mode with no bearer token), which meant simply requiring app.js
// crashed for any test — or any request — that had nothing to do with
// suppliers at all, purely because LetsFG credentials weren't set. Now a
// supplier is only constructed the first time something actually asks for
// it, and misconfiguration surfaces as a proper 503 ApiError on that
// specific request, not a process crash on module load.
const { LetsFGAdapter } = require("./adapters/letsfgAdapter");
const { LetsFGHotelAdapter } = require("./adapters/letsfgHotelAdapter");
const { NigerianDomesticAdapter } = require("./adapters/nigerianDomesticAdapter");
const { MockBusAdapter } = require("./adapters/mockBusAdapter");
const { Errors } = require("../domain/errors");

let _letsfg = null;
let _letsfgHotel = null;
let _ngDomestic = null;
let _mockBus = null;

function getSupplier(code) {
  if (code !== "letsfg") {
    if (code === "ng_domestic" && process.env.DOMESTIC_SUPPLIER_ENABLED === "true") {
      // See nigerianDomesticAdapter.js — this flag removes the registry
      // guard only; every method on the adapter itself still throws
      // NOT_READY. There is no env var that makes this a real integration.
      _ngDomestic = _ngDomestic || new NigerianDomesticAdapter();
      return _ngDomestic;
    }
    throw Errors.SupplierNotConfigured(`Unknown flight supplier: ${code}`);
  }
  if (!_letsfg) {
    try {
      _letsfg = new LetsFGAdapter({
        authMode: process.env.LETSFG_AUTH_MODE || "pfs",
        bearerToken: process.env.LETSFG_BEARER_TOKEN,
        apiKey: process.env.LETSFG_API_KEY,
        baseUrl: process.env.LETSFG_BASE_URL,
      });
    } catch (err) {
      throw Errors.SupplierNotConfigured(`LetsFG flight adapter misconfigured: ${err.message}`);
    }
  }
  return _letsfg;
}

function getBusSupplier(code = process.env.BUS_SUPPLIER_CODE || "mock_bus") {
  if (code === "mock_bus") {
    _mockBus = _mockBus || new MockBusAdapter();
    return _mockBus;
  }
  throw Errors.SupplierNotConfigured(`Unknown bus supplier: ${code}`);
}

function getHotelSupplier(code) {
  if (code !== "letsfg") {
    throw Errors.SupplierNotConfigured(`Unknown hotel supplier: ${code}`);
  }
  if (!_letsfgHotel) {
    // Hotels are Developer-API-only per LetsFG's public docs (see
    // letsfgHotelAdapter.js header) — no PFS/free path exists for hotels,
    // unlike flights.
    if (!process.env.LETSFG_API_KEY) {
      throw Errors.SupplierNotConfigured("Hotel supplier 'letsfg' requires LETSFG_API_KEY (Developer API) to be set — no free/PFS path exists for hotels.");
    }
    try {
      _letsfgHotel = new LetsFGHotelAdapter({
        authMode: "developer",
        apiKey: process.env.LETSFG_API_KEY,
        baseUrl: process.env.LETSFG_BASE_URL,
      });
    } catch (err) {
      throw Errors.SupplierNotConfigured(`LetsFG hotel adapter misconfigured: ${err.message}`);
    }
  }
  return _letsfgHotel;
}

// Sprint 2 hardening: exposes circuit-breaker state for /readyz. Only
// reports on suppliers actually constructed so far in this process (lazy
// construction, see comment above) — a supplier nothing has called yet
// simply won't appear, which is accurate: there's no health signal for it
// yet, not a false "healthy".
function getSupplierHealth() {
  const health = {};
  if (_letsfg) health.letsfg_flights = _letsfg.client.breaker.getStatus();
  if (_letsfgHotel) health.letsfg_hotels = _letsfgHotel.client.breaker.getStatus();
  return health;
}

module.exports = { getSupplier, getHotelSupplier, getBusSupplier, getSupplierHealth };
