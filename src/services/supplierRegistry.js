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
const { TiqwaAdapter } = require("./adapters/tiqwaAdapter");
const { assertFlightSupplier } = require("./flightSupplier.interface");
const { MockBusAdapter } = require("./adapters/mockBusAdapter");
const { Errors } = require("../domain/errors");

let _letsfg = null;
let _letsfgHotel = null;
let _ngDomestic = null;
let _tiqwa = null;
let _mockBus = null;

// Flight supplier codes this build knows about. A code being known does not make
// it usable: scaffolds are gated behind explicit env flags below.
const KNOWN_FLIGHT_SUPPLIERS = ["letsfg", "ng_domestic", "tiqwa"];

/** The supplier new flight searches run against. Override with FLIGHT_SUPPLIER_CODE. */
function defaultFlightSupplierCode() {
  const code = process.env.FLIGHT_SUPPLIER_CODE || "letsfg";
  if (!KNOWN_FLIGHT_SUPPLIERS.includes(code)) {
    throw Errors.SupplierNotConfigured(`FLIGHT_SUPPLIER_CODE '${code}' is not a known flight supplier (${KNOWN_FLIGHT_SUPPLIERS.join(", ")}).`);
  }
  return code;
}

/** Validated accessor: every adapter handed out is checked against the FlightSupplier contract once. */
function getSupplier(code) {
  const adapter = _getSupplierUnchecked(code);
  if (!adapter.__contractChecked) {
    try { assertFlightSupplier(adapter, `flight supplier '${code}'`); } catch (err) { throw Errors.SupplierNotConfigured(err.message); }
    Object.defineProperty(adapter, "__contractChecked", { value: true });
  }
  return adapter;
}

function _getSupplierUnchecked(code) {
  if (code !== "letsfg") {
    if (code === "tiqwa" && process.env.TIQWA_ENABLED === "true") {
      // Scaffold: every method throws until Tiqwa's API is verified and contracted. See tiqwaAdapter.js.
      _tiqwa = _tiqwa || new TiqwaAdapter({ baseUrl: process.env.TIQWA_BASE_URL });
      return _tiqwa;
    }
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
        authMode: process.env.LETSFG_AUTH_MODE || "developer",
        bearerToken: process.env.LETSFG_BEARER_TOKEN,
        apiKey: process.env.LETSFG_API_KEY,
        baseUrl: process.env.LETSFG_BASE_URL,
        environment: process.env.LETSFG_ENVIRONMENT || "production",
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
    if ((process.env.LETSFG_ENVIRONMENT || "production") === "sandbox") {
      throw Errors.SupplierNotConfigured("LetsFG hotel search is disabled in sandbox: LetsFG does not document a hotel sandbox, and this configuration blocks live hotel calls.");
    }
    if (!process.env.LETSFG_API_KEY) {
      throw Errors.SupplierNotConfigured("Hotel supplier 'letsfg' requires LETSFG_API_KEY (Developer API) to be set — no free/PFS path exists for hotels.");
    }
    try {
      _letsfgHotel = new LetsFGHotelAdapter({
        authMode: "developer",
        apiKey: process.env.LETSFG_API_KEY,
        baseUrl: process.env.LETSFG_BASE_URL,
        environment: process.env.LETSFG_ENVIRONMENT || "production",
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

module.exports = { KNOWN_FLIGHT_SUPPLIERS, defaultFlightSupplierCode, getSupplier, getHotelSupplier, getBusSupplier, getSupplierHealth };
