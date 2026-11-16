import test from "node:test";
import assert from "node:assert/strict";
import { createApi, ApiError } from "../src/api.js";
import { formatMoney, totalsByCurrency, budgetState, describeLeg, describeItem, priceLabelMeta, itemStatusMeta, minutesLeft, dateRange } from "../src/format.js";

function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    const key = `${opts.method} ${url}`;
    const r = typeof routes[key] === "function" ? routes[key](calls.filter((c) => c.url === url).length) : routes[key];
    if (!r) return { ok: false, status: 404, json: async () => ({ code: "NOT_FOUND", title: "Not found" }) };
    return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
  };
  return { f, calls };
}

test("api: bearer key on every call; non-2xx becomes ApiError with TAPI's code and detail", async () => {
  const { f, calls } = fakeFetch({ "GET /v1/trips": { body: { trips: [{ id: "t1" }] } }, "POST /v1/trips": { status: 400, body: { code: "VALIDATION_ERROR", title: "Invalid request", detail: "title is required" } } });
  const api = createApi({ apiKey: "k1", fetchImpl: f });
  assert.deepEqual(await api.listTrips(), [{ id: "t1" }]);
  assert.equal(calls[0].opts.headers.Authorization, "Bearer k1");
  await assert.rejects(api.createTrip({}), (e) => e instanceof ApiError && e.status === 400 && e.code === "VALIDATION_ERROR" && /title is required/.test(e.message));
});

test("api: network failure is a friendly error, not a raw TypeError", async () => {
  const api = createApi({ apiKey: "k", fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(api.listTrips(), (e) => e.code === "NETWORK" && /Could not reach/.test(e.message));
});

test("api: approve sends exactly the price on screen; book carries a stable idempotency key per approval", async () => {
  const { f, calls } = fakeFetch({ "POST /v1/trips/t1/items/i1/approve": { status: 201, body: { approvalId: "a1" } }, "POST /v1/trips/t1/items/i1/book": { status: 202, body: { bookingId: "b1" } } });
  const api = createApi({ apiKey: "k", fetchImpl: f });
  await api.approve("t1", { id: "i1", quoted_price: "500.00", currency: "USD" });
  assert.deepEqual(JSON.parse(calls[0].opts.body), { confirm: true, acknowledgedPrice: 500, currency: "USD" });
  await api.book("t1", "i1", "a1"); await api.book("t1", "i1", "a1");
  assert.equal(calls[1].opts.headers["Idempotency-Key"], "ui-book-a1");
  assert.equal(calls[2].opts.headers["Idempotency-Key"], "ui-book-a1");
});

test("api: search polls until completed; failed and timeout surface clear errors", async () => {
  const mk = (statuses) => { let n = 0; return fakeFetch({ "POST /v1/flights/search": { status: 202, body: { searchId: "s1" } }, "GET /v1/flights/search/s1": () => ({ body: { status: statuses[Math.min(n++, statuses.length - 1)], offers: [{ offerId: "o1" }] } }) }); };
  const p = { origin: "abv", destination: "lhr", departDate: "2026-12-10", adults: 1 };
  let { f, calls } = mk(["processing", "processing", "completed"]);
  const r = await createApi({ apiKey: "k", fetchImpl: f, sleep: async () => {} }).searchFlights(p);
  assert.equal(r.offers[0].offerId, "o1");
  assert.equal(JSON.parse(calls[0].opts.body).origin, "ABV");
  ({ f } = mk(["processing", "failed"]));
  await assert.rejects(createApi({ apiKey: "k", fetchImpl: f, sleep: async () => {} }).searchFlights(p), (e) => e.code === "SEARCH_FAILED");
  ({ f } = mk(["processing"]));
  await assert.rejects(createApi({ apiKey: "k", fetchImpl: f, sleep: async () => {}, maxPolls: 3 }).searchFlights(p), (e) => e.code === "SEARCH_TIMEOUT");
});

test("totals never mix currencies and skip cancelled/failed items", () => {
  const t = totalsByCurrency([{ quoted_price: "500", currency: "USD", status: "approved" }, { quoted_price: "200", currency: "USD", status: "proposed" }, { quoted_price: "999", currency: "USD", status: "cancelled" }, { quoted_price: "100", currency: "EUR", status: "proposed" }]);
  assert.deepEqual(t, { USD: 700, EUR: 100 });
  const b = budgetState({ budget: "600", currency: "USD" }, t);
  assert.equal(b.over, true); assert.equal(b.mixedCurrency, true); assert.equal(b.left, -100);
  assert.equal(budgetState({ budget: null, currency: null }, t), null);
});

test("unknown price labels and statuses fail safe (unverified / neutral), never 'confirmed'", () => {
  assert.equal(priceLabelMeta("made-up").text, "Unverified price");
  assert.equal(priceLabelMeta(undefined).tone, "muted");
  assert.equal(itemStatusMeta("weird").text, "weird");
  assert.notEqual(itemStatusMeta("reconciliation_required").tone, "ok");
});

test("describeLeg copes with unknown supplier shapes without throwing", () => {
  assert.equal(describeLeg(null), null);
  assert.equal(describeLeg({ foo: 1 }), null);
  assert.match(describeLeg({ origin: "ABV", destination: "LHR", departure: "2026-12-10T08:00:00Z", duration: 405 }).summary, /ABV → LHR.*6h 45m/);
  assert.match(describeLeg([{ from: "ABV", to: "CDG" }, { from: "CDG", to: "LHR" }]).summary, /ABV → LHR/);
  assert.equal(describeLeg("ABV-LHR 08:00").summary, "ABV-LHR 08:00");
  const it = describeItem({ kind: "flight", details: { airline: "BA", stops: 0, outbound: 12 } });
  assert.equal(it.title, "BA flight"); assert.ok(it.lines.includes("Direct"));
});

test("formatting helpers", () => {
  assert.equal(formatMoney(500, "USD"), "$500");
  assert.equal(formatMoney(499.5, "USD"), "$499.50");
  assert.equal(formatMoney("x", "USD"), "—");
  assert.equal(dateRange("2026-12-10", "2026-12-17"), "10 Dec – 17 Dec 2026");
  assert.equal(minutesLeft("2026-11-13T10:30:00Z", new Date("2026-11-13T10:00:00Z")), 30);
  assert.equal(minutesLeft("2026-11-13T09:00:00Z", new Date("2026-11-13T10:00:00Z")), 0);
});

import { approvalLeft, timeAgo } from "../src/format.js";
test("agent statuses read clearly, and approval/age helpers never show negative or misleading times", () => {
  assert.equal(itemStatusMeta("agent_requested").text, "Waiting for an agent"); assert.equal(itemStatusMeta("agent_working").text, "Agent is booking");
  const now = new Date("2026-11-14T10:00:00Z");
  assert.deepEqual(approvalLeft("2026-11-14T09:59:00Z", now), { text: "Approval expired", expired: true });
  assert.equal(approvalLeft("2026-11-14T10:30:00Z", now).text, "30 min left"); assert.equal(approvalLeft("2026-11-14T11:20:00Z", now).text, "1h 20m left"); assert.equal(approvalLeft("2026-11-16T10:00:00Z", now).text, "48h left");
  assert.equal(approvalLeft(null, now), null);
  assert.equal(timeAgo("2026-11-14T10:00:00Z", now), "just now"); assert.equal(timeAgo("2026-11-14T08:00:00Z", now), "2h ago"); assert.equal(timeAgo("2026-11-10T10:00:00Z", now), "4d ago"); assert.equal(timeAgo("2026-11-14T10:05:00Z", now), "just now");
});
