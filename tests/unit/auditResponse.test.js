// Tests for the response to the Nov-2026 audit: passport encryption (B), booking-failure semantics (A + retry window),
// client timeouts (C), required service token (D), claimer binding helper inputs (E), strict UUIDs (G).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createFieldCrypto, getFieldCrypto, parseKeys } = require("../../src/services/fieldCrypto");
const { sealPassport, openPassport, hasPassport, maskedPassport } = require("../../src/services/travelerSecrets");
const { run } = require("../../scripts/encrypt-passports");
const { classifyBookingFailure, failureMessage } = require("../../src/domain/bookingFailure");
const { executeApprovedBooking } = require("../../src/agent/bookingExecutor");
const { createTapiClient } = require("../../src/agent/tapiClient");
const { getServiceToken } = require("../../src/services/internalAuth");
const { isUuid } = require("../../src/domain/ids");

const key = () => crypto.randomBytes(32);
const ring = (ids, current) => createFieldCrypto({ keys: new Map(ids.map((i) => [i, key()])), currentId: current || ids[0] });

// ---------- B: encryption ----------
test("encrypt/decrypt round-trips, uses a fresh IV every time, and never stores the plaintext in the blob", () => {
  const c = ring(["k1"]); const a = c.encrypt("A1234567", "traveler:t1:passport"), b = c.encrypt("A1234567", "traveler:t1:passport");
  assert.notEqual(a, b); assert.equal(c.decrypt(a, "traveler:t1:passport"), "A1234567");
  assert.ok(!a.includes("A1234567") && !Buffer.from(a.split(".")[4], "base64url").toString("utf8").includes("A1234567"));
  assert.match(a, /^v1\.k1\.[\w-]+\.[\w-]+\.[\w-]+$/);
});

test("a ciphertext is bound to its record: copying it to another traveller, tampering, or using a different key all fail the same opaque way", () => {
  const c = ring(["k1"]); const blob = c.encrypt("A1234567", "traveler:t1:passport");
  const expectFail = (fn) => assert.throws(fn, (e) => e.code === "DECRYPT_FAILED" && e.message === "Cannot decrypt field.");
  expectFail(() => c.decrypt(blob, "traveler:t2:passport"));                                   // moved to another row
  const parts = blob.split("."); parts[4] = Buffer.from("tampered").toString("base64url");
  expectFail(() => c.decrypt(parts.join("."), "traveler:t1:passport"));                        // modified ciphertext
  const tag = blob.split("."); tag[3] = Buffer.alloc(16).toString("base64url");
  expectFail(() => c.decrypt(tag.join("."), "traveler:t1:passport"));                          // modified auth tag
  expectFail(() => ring(["k1"]).decrypt(blob, "traveler:t1:passport"));                        // a different key under the same id
  for (const junk of [null, "", "plain", "v2.k1.a.b.c", "v1.nokey.a.b.c", "v1.k1.a.b"]) expectFail(() => c.decrypt(junk, "x"));
  assert.throws(() => c.encrypt("x", ""), (e) => e.code === "NO_CONTEXT");
});

test("key rotation: new values use the new key, old values stay readable until re-encrypted", () => {
  const old = key(), fresh = key();
  const before = createFieldCrypto({ keys: new Map([["2025", old]]), currentId: "2025" });
  const blob = before.encrypt("B7654321", "traveler:t1:passport");
  const after = createFieldCrypto({ keys: new Map([["2025", old], ["2026", fresh]]), currentId: "2026" });
  assert.equal(after.decrypt(blob, "traveler:t1:passport"), "B7654321");
  assert.equal(after.isCurrent(blob), false); assert.equal(after.keyIdOf(blob), "2025");
  const re = after.encrypt("B7654321", "traveler:t1:passport"); assert.equal(after.isCurrent(re), true);
  const retired = createFieldCrypto({ keys: new Map([["2026", fresh]]), currentId: "2026" });
  assert.throws(() => retired.decrypt(blob, "traveler:t1:passport"), (e) => e.code === "DECRYPT_FAILED");   // once the old key is retired, old rows must already be re-encrypted
});

test("key configuration is strict, and production refuses to run without one", () => {
  const good = crypto.randomBytes(32).toString("base64");
  assert.equal(parseKeys({ FIELD_ENCRYPTION_KEYS: `a1:${good},b2:${good}` }).currentId, "a1");
  assert.equal(parseKeys({ FIELD_ENCRYPTION_KEYS: `a1:${good},b2:${good}`, FIELD_ENCRYPTION_KEY_ID: "b2" }).currentId, "b2");
  assert.equal(parseKeys({ FIELD_ENCRYPTION_KEY: good }).currentId, "k1");
  for (const bad of [{ FIELD_ENCRYPTION_KEYS: "a1:short" }, { FIELD_ENCRYPTION_KEYS: `a.1:${good}` }, { FIELD_ENCRYPTION_KEYS: `a1:${good},a1:${good}` }, { FIELD_ENCRYPTION_KEYS: good }]) assert.throws(() => parseKeys(bad), (e) => e.code === "BAD_KEY_CONFIG", JSON.stringify(bad).slice(0, 40));
  assert.throws(() => getFieldCrypto({ NODE_ENV: "production" }), (e) => e.code === "NO_KEY" && /FIELD_ENCRYPTION_KEYS/.test(e.message));
  assert.throws(() => getFieldCrypto({ NODE_ENV: "development" }), (e) => e.code === "NO_KEY");
  assert.equal(getFieldCrypto({ NODE_ENV: "test" }).currentId, "test");
  assert.throws(() => getFieldCrypto({ FIELD_ENCRYPTION_KEYS: `a1:${good}`, FIELD_ENCRYPTION_KEY_ID: "zz" }), (e) => e.code === "BAD_KEY_CONFIG");
});

test("traveller secrets: sealing normalises, masks show only the end, listings never need the key, legacy plaintext rows still work until backfilled", () => {
  const c = ring(["k1"]); const s = sealPassport("t1", " a12 34567 ", c);
  assert.equal(s.last4, "4567"); assert.ok(!s.enc.includes("A1234567"));
  const row = { id: "t1", passport_number_enc: s.enc, passport_last4: s.last4, passport_number: null };
  assert.equal(openPassport(row, c), "A1234567"); assert.equal(maskedPassport(row), "••••••567"); assert.equal(hasPassport(row), true);
  assert.throws(() => openPassport({ id: "t9", passport_number_enc: s.enc }, c), (e) => e.code === "DECRYPT_FAILED"); // the same blob under another traveller id
  const legacy = { id: "t2", passport_number: "Z9999999", passport_number_enc: null, passport_last4: null };
  assert.equal(openPassport(legacy, c), "Z9999999"); assert.equal(maskedPassport(legacy), "••••••999"); assert.equal(hasPassport(legacy), true);
  assert.equal(openPassport({ id: "t3" }, c), null); assert.equal(maskedPassport({ id: "t3" }), null); assert.equal(hasPassport({ id: "t3" }), false);
});

function memRepo(rows) {
  return {
    rows,
    async fetch(mode, currentId, limit, after) {
      return rows.filter((r) => (!after || r.id > after) && (mode === "rotate" ? (r.passport_number && !r.passport_number_enc) || (r.passport_number_enc && !r.passport_number_enc.startsWith(`v1.${currentId}.`)) : r.passport_number && !r.passport_number_enc)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit).map((r) => ({ ...r }));
    },
    async save(row, enc, last4) {
      const cur = rows.find((r) => r.id === row.id);
      if (!cur || (cur.passport_number ?? null) !== (row.passport_number ?? null) || (cur.passport_number_enc ?? null) !== (row.passport_number_enc ?? null)) return false;
      cur.passport_number_enc = enc; cur.passport_last4 = last4; cur.passport_number = null; return true;
    },
  };
}
const quiet = () => {};

test("backfill: encrypts legacy rows, clears the plaintext only after a verified round-trip, and is safe to run twice", async () => {
  const c = ring(["k1"]);
  const repo = memRepo([{ id: "a", passport_number: "A1234567" }, { id: "b", passport_number: "B 7654321" }, { id: "c", passport_number: null, passport_number_enc: null }]);
  const first = await run({ repo, crypto: c, log: quiet });
  assert.deepEqual([first.done, first.failed], [2, 0]);
  for (const id of ["a", "b"]) { const r = repo.rows.find((x) => x.id === id); assert.equal(r.passport_number, null); assert.ok(r.passport_number_enc.startsWith("v1.k1.")); assert.equal(c.decrypt(r.passport_number_enc, `traveler:${id}:passport`), id === "a" ? "A1234567" : "B7654321"); }
  assert.equal(repo.rows.find((x) => x.id === "b").passport_last4, "4321");
  assert.deepEqual((({ done, failed }) => [done, failed])(await run({ repo, crypto: c, log: quiet })), [0, 0]);
});

test("backfill: dry run changes nothing; a row changed underneath is skipped, not overwritten; an unreadable row is reported and left alone", async () => {
  const c = ring(["k1"]);
  const rows = [{ id: "a", passport_number: "A1234567" }];
  const dry = await run({ repo: memRepo(rows), crypto: c, dryRun: true, log: quiet });
  assert.equal(rows[0].passport_number, "A1234567"); assert.equal(rows[0].passport_number_enc, undefined); assert.equal(dry.done, 0);
  const raced = memRepo([{ id: "a", passport_number: "A1234567" }]); const realSave = raced.save;
  raced.save = async (row, ...rest) => { raced.rows[0].passport_number = "CHANGED99"; return realSave(row, ...rest); };
  const out = await run({ repo: raced, crypto: c, log: quiet }); assert.deepEqual([out.done, out.skipped], [0, 1]); assert.equal(raced.rows[0].passport_number, "CHANGED99");
  const logs = []; const bad = memRepo([{ id: "z", passport_number: null, passport_number_enc: "v1.gone.a.b.c" }]);
  const res = await run({ repo: bad, crypto: c, mode: "rotate", log: (l) => logs.push(l) });
  assert.equal(res.failed, 1); assert.equal(bad.rows[0].passport_number_enc, "v1.gone.a.b.c"); assert.ok(logs.every((l) => !/v1\.gone/.test(l) || /row z/.test(l)));
});

test("backfill --rotate re-encrypts rows under the current key and keeps the value", async () => {
  const k1 = key(), k2 = key();
  const oldC = createFieldCrypto({ keys: new Map([["k1", k1]]), currentId: "k1" });
  const newC = createFieldCrypto({ keys: new Map([["k1", k1], ["k2", k2]]), currentId: "k2" });
  const repo = memRepo([{ id: "a", passport_number: null, passport_number_enc: oldC.encrypt("A1234567", "traveler:a:passport"), passport_last4: "4567" }]);
  assert.equal((await run({ repo, crypto: newC, log: quiet })).done, 0);                         // plain mode ignores already-encrypted rows
  assert.equal((await run({ repo, crypto: newC, mode: "rotate", log: quiet })).done, 1);
  assert.ok(repo.rows[0].passport_number_enc.startsWith("v1.k2.")); assert.equal(newC.decrypt(repo.rows[0].passport_number_enc, "traveler:a:passport"), "A1234567");
});

// ---------- A: failure semantics ----------
test("failure classification: refusals are definitive; timeouts, 5xx, rate limits and unknowns are ambiguous (never invite a re-approval)", () => {
  const e = (status, code) => Object.assign(new Error("x"), { status, code });
  for (const [err, itemStatus] of [[e(409, "SOLD_OUT"), "failed"], [e(410, "OFFER_EXPIRED"), "failed"], [e(409, "PRICE_CHANGED"), "selected"], [e(400, "VALIDATION_FAILED"), "selected"], [e(422), "selected"], [e(404, "NOT_FOUND"), "selected"]]) {
    const c = classifyBookingFailure(err); assert.equal(c.kind, "definitive", JSON.stringify(err)); assert.equal(c.itemStatus, itemStatus);
  }
  for (const err of [e(500, "INTERNAL_ERROR"), e(502, "SUPPLIER_UNAVAILABLE"), e(503), e(504, "SUPPLIER_TIMEOUT"), e(408), e(429), e(undefined, "TIMEOUT"), e(undefined, "NETWORK"), new Error("boom"), e(409, "SOMETHING_NEW"), e(401)]) {
    const c = classifyBookingFailure(err); assert.equal(c.kind, "ambiguous", `${err.status} ${err.code}`); assert.equal(c.itemStatus, "reconciliation_required");
  }
  assert.equal(classifyBookingFailure(null).kind, "ambiguous");
  assert.match(failureMessage({ kind: "ambiguous" }), /do not approve it again/); assert.match(failureMessage({ kind: "definitive", code: "SOLD_OUT" }), /Nothing was booked/);
  for (const c of [{ kind: "ambiguous" }, { kind: "definitive", code: "X" }, { kind: "definitive", code: "SOLD_OUT" }]) assert.doesNotMatch(failureMessage(c), /supplier payload|stack|http/i);
});

const NOW = new Date("2026-11-15T12:00:00Z");
const approvalRow = () => ({ id: "ap1", offer_id: "off1", approved_price: 500, currency: "USD", tolerance_pct: 0, status: "active", expires_at: new Date(NOW.getTime() + 3600_000) });
function execDeps({ bookError, attachError } = {}) {
  const log = { consumed: 0, attached: [] };
  return { log, deps: { now: () => NOW,
    approvals: { get: async () => approvalRow(), consume: async () => { log.consumed++; return {}; }, attachBooking: async (...a) => { if (attachError) throw attachError; log.attached.push(a[2]); } },
    tapi: { validateFlightOffer: async () => ({ valid: true, offer: { price: 500, currency: "USD" } }), bookFlight: async () => { if (bookError) throw bookError; return { bookingId: "bk1", status: "pending" }; } } } };
}
const exec = (d) => executeApprovedBooking({ agencyId: "a", approvalId: "ap1", kind: "flight", bookingBody: {} }, d);

test("an error while booking is flagged as happening AFTER the approval was spent; an error while validating is not", async () => {
  const { deps } = execDeps({ bookError: Object.assign(new Error("timeout"), { code: "TIMEOUT" }) });
  await assert.rejects(exec(deps), (e) => e.afterConsume === true && e.approvalId === "ap1" && e.code === "TIMEOUT");
  const v = execDeps().deps; v.tapi.validateFlightOffer = async () => { throw Object.assign(new Error("down"), { status: 503 }); };
  await assert.rejects(exec(v), (e) => e.afterConsume === undefined);
});

test("failing to note the booking id on the approval does not turn a successful booking into an error", async () => {
  const { deps, log } = execDeps({ attachError: new Error("db hiccup") }); const orig = console.error; console.error = () => {};
  try { const r = await exec(deps); assert.equal(r.ok, true); assert.equal(r.booking.bookingId, "bk1"); assert.equal(log.consumed, 1); } finally { console.error = orig; }
});

// ---------- C: timeouts ----------
test("every TAPI call has a deadline: a hung call fails with TIMEOUT, bookings get the longer one, and network errors are distinguished", async () => {
  const seen = [];
  const hang = (url, o) => { seen.push(url); return new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))); };
  const c = createTapiClient({ baseUrl: "http://t", apiKey: "k", fetchImpl: hang, timeoutMs: 30, bookingTimeoutMs: 120 });
  const t0 = Date.now(); await assert.rejects(c.validateFlightOffer("o1"), (e) => e.code === "TIMEOUT" && e.status === undefined); const quick = Date.now() - t0;
  const t1 = Date.now(); await assert.rejects(c.bookFlight({ offerId: "o1" }, "key"), (e) => e.code === "TIMEOUT"); const slow = Date.now() - t1;
  assert.ok(quick >= 25 && quick < 110, `validate took ${quick}ms`); assert.ok(slow >= 100, `booking took ${slow}ms`);
  const down = createTapiClient({ baseUrl: "http://t", apiKey: "k", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.searchFlights({ origin: "ABV", destination: "LHR", departDate: "2026-12-10" }), (e) => e.code === "NETWORK");
});

// ---------- D, G ----------
test("production refuses to start without a strong internal service token; a good one is accepted", () => {
  assert.throws(() => getServiceToken({ NODE_ENV: "production" }), /INTERNAL_SERVICE_TOKEN is required/);
  assert.throws(() => getServiceToken({ NODE_ENV: "production", INTERNAL_SERVICE_TOKEN: "short" }), /at least 32/);
  assert.match(getServiceToken({ NODE_ENV: "production", INTERNAL_SERVICE_TOKEN: "x".repeat(40) }), /^svc_x{40}$/);
});

test("UUID check is strict: right length and shape, nothing else", () => {
  assert.equal(isUuid("11111111-1111-4111-8111-111111111111"), true);
  for (const bad of ["", "----------------------------------------", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "11111111111141118111111111111111", "zzzzzzzz-1111-4111-8111-111111111111", null, undefined, 5]) assert.equal(isUuid(bad), false, String(bad));
});
