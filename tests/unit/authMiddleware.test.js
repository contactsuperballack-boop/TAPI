// Exercises middleware/auth.js with stubbed repositories (no Postgres): the three credential paths,
// traveller deny-by-default, and the internal service credential's checks.
process.env.INTERNAL_SERVICE_TOKEN = "x".repeat(40);
// `pg` is only needed to construct a Pool; these tests never connect. If it is not installed (e.g. a sandbox
// without `npm install`) stub it, otherwise the real module is used.
try { require.resolve("pg"); } catch (_) {
  const Module = require("module"); const load = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "pg") return { Pool: class { query() { return Promise.resolve({ rows: [] }); } connect() { return Promise.resolve({ query: async () => ({ rows: [] }), release() {} }); } on() {} }, types: { setTypeParser() {}, builtins: { NUMERIC: 1700 } } };
    return load.call(this, request, ...rest);
  };
}
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs"); const path = require("path");
const db = require("../../src/db"); db.query = async () => ({ rows: [] });           // swallow audit writes
const { Identity } = require("../../src/repositories/identity");
const { ApiKeys, hashKey } = require("../../src/services/apiKeys");
const { hashToken } = require("../../src/services/tokens");
const { authenticate, requireRole } = require("../../src/middleware/auth");
const { getServiceToken } = require("../../src/services/internalAuth");

const AG = "11111111-1111-4111-8111-111111111111", HOUSE = "00000000-0000-4000-8000-000000000001";
const sessions = {
  staff: { id: "s1", user_id: "u-staff", expires_at: new Date(Date.now() + 1e7), revoked_at: null, last_used_at: new Date(), user_status: "active", email_verified_at: new Date(), full_name: "Sam Agent", email: "sam@acme.com", role: "agent", agency_id: AG, traveler_id: null, membership_status: "active", agency_status: "active", agency_name: "Acme", agency_kind: "agency", traveller_self_booking: true },
  trav: { id: "s2", user_id: "u-trav", expires_at: new Date(Date.now() + 1e7), revoked_at: null, last_used_at: new Date(), user_status: "active", email_verified_at: null, full_name: "Ada Obi", email: "ada@x.com", role: "traveller", agency_id: HOUSE, traveler_id: "t-1", membership_status: "active", agency_status: "active", agency_name: "TAPI Direct", agency_kind: "house", traveller_self_booking: true },
};
Identity.findSession = async (h) => (h === hashToken("tps_staff") ? sessions.staff : h === hashToken("tps_trav") ? sessions.trav : null);
Identity.touchSession = async () => {};
Identity.agencyIsActive = async (id) => id === AG;
ApiKeys.findByHash = async (h) => (h === hashKey("tapi_test_goodkey") ? { id: "key1", agency_id: AG, status: "active", expires_at: null } : null);
ApiKeys.touchLastUsed = async () => {};

function run({ token, method = "GET", url = "/v1/trips", headers = {}, remote = "127.0.0.1", scheme = "Bearer" }) {
  const req = { method, originalUrl: url, ip: "9.9.9.9", socket: { remoteAddress: remote },
    header: (n) => ({ authorization: token ? `${scheme} ${token}` : undefined, ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) })[n.toLowerCase()] };
  return new Promise((resolve) => authenticate(req, {}, (err) => resolve({ req, err })));
}

test("no header, malformed header and unknown token are all 401", async () => {
  assert.equal((await run({})).err.status, 401);
  assert.equal((await run({ token: "abc", scheme: "Basic" })).err.status, 401);
  assert.equal((await run({ token: "tps_unknown" })).err.status, 401);
  assert.equal((await run({ token: "tapi_test_wrong" })).err.status, 401);
});

test("API key keeps working and acts as admin for its agency", async () => {
  const { req, err } = await run({ token: "tapi_test_goodkey" });
  assert.equal(err, undefined);
  assert.deepEqual(req.tenant, { agencyId: AG, apiClientId: "key1" });
  assert.equal(req.principal.role, "admin"); assert.equal(req.principal.type, "api_key");
});

test("staff session: tenant comes from the verified session; staff can reach every route", async () => {
  for (const url of ["/v1/trips", "/v1/orders", "/v1/flights/bookings", "/v1/travelers"]) {
    const { req, err } = await run({ token: "tps_staff", url, method: "POST" });
    assert.equal(err, undefined, url);
    assert.equal(req.tenant.agencyId, AG); assert.equal(req.tenant.apiClientId, "user:u-staff"); assert.equal(req.principal.role, "agent");
  }
});

test("traveller session: own trips and search only. Raw bookings, orders, API keys, staff, other travellers are 403", async () => {
  for (const [method, url] of [["GET", "/v1/trips"], ["POST", "/v1/trips/abc/items/def/approve"], ["POST", "/v1/flights/search"], ["GET", "/v1/travelers/me"]]) {
    const { req, err } = await run({ token: "tps_trav", method, url });
    assert.equal(err, undefined, `${method} ${url}`); assert.equal(req.tenant.agencyId, HOUSE); assert.equal(req.principal.travelerId, "t-1");
  }
  for (const [method, url] of [["POST", "/v1/flights/bookings"], ["POST", "/v1/hotels/bookings"], ["GET", "/v1/orders"], ["POST", "/v1/auth/api-keys"], ["GET", "/v1/staff"], ["POST", "/v1/travelers"], ["GET", "/v1/travelers/00000000-0000-4000-8000-0000000000aa"], ["POST", "/v1/flights/offers/x/validate"]]) {
    const { err } = await run({ token: "tps_trav", method, url });
    assert.equal(err && err.status, 403, `${method} ${url}`);
  }
  assert.equal((await run({ token: "tps_trav", url: "/v1/trips?x=/v1/orders" })).err, undefined);   // query strings do not confuse the check
});

test("internal service credential: needs the secret, loopback socket, a valid active agency id", async () => {
  const good = { token: getServiceToken(), headers: { "X-Agency-Id": AG, "X-Actor": "user:u-trav" }, url: "/v1/flights/bookings", method: "POST" };
  const ok = await run(good);
  assert.equal(ok.err, undefined); assert.equal(ok.req.principal.type, "service"); assert.equal(ok.req.tenant.agencyId, AG); assert.equal(ok.req.tenant.apiClientId, "service:user:u-trav");
  for (const bad of [
    { ...good, token: "svc_" + "y".repeat(40) },                           // wrong secret
    { ...good, remote: "203.0.113.5" },                                   // not from this machine
    { ...good, headers: { "X-Agency-Id": "not-a-uuid" } },                // malformed tenant
    { ...good, headers: { "X-Agency-Id": "22222222-2222-4222-8222-222222222222" } }, // unknown / inactive tenant
    { ...good, headers: {} },                                             // no tenant at all
  ]) assert.equal((await run(bad)).err.status, 401);
  // spoofing X-Forwarded-For cannot fake loopback: the check uses the socket peer, not req.ip
  const spoof = await run({ ...good, remote: "203.0.113.5", headers: { ...good.headers, "X-Forwarded-For": "127.0.0.1" } });
  assert.equal(spoof.err.status, 401);
});

test("a session token is never accepted as a service credential, and the service token is never a session", async () => {
  assert.equal((await run({ token: "svc_" + "tps_staff" })).err.status, 401);
  assert.equal((await run({ token: getServiceToken(), headers: { "X-Agency-Id": AG } , remote: "10.0.0.1" })).err.status, 401);
});

test("requireRole", async () => {
  const mw = requireRole("admin"); const call = (role) => new Promise((r) => mw({ principal: { role } }, {}, (e) => r(e)));
  assert.equal(await call("admin"), undefined); assert.equal((await call("agent")).status, 403); assert.equal((await call("traveller")).status, 403);
  assert.equal((await new Promise((r) => mw({}, {}, r))).status, 403);
});

test("guard: trip routes never forward the caller's own Authorization header to TAPI's internal API", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../src/routes/trips.routes.js"), "utf8");
  assert.equal(/header\(["']Authorization["']\)/i.test(src), false);
  assert.match(src, /getServiceToken\(\)/);
});
