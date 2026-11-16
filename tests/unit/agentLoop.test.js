const test = require("node:test");
const assert = require("node:assert/strict");
const { runAgentTurn, FALLBACK_TEXT } = require("../../src/agent/agentLoop");
const { TOOL_SPECS, toolNames, createToolHandlers } = require("../../src/agent/tools");
const { assertNoSecrets } = require("../../src/agent/piiBoundary");

const traveller = { id: "t1", firstName: "Ada", lastName: "Obi", passportNumber: "A12345678", email: "ada@example.com", homeAirport: "ABV", preferences: { cabinClass: "economy" } };
const NOW = new Date("2026-11-13T10:00:00Z");
function mk({ searchResult } = {}) {
  const added = [];
  const deps = {
    now: () => NOW,
    tapi: {
      searchFlights: async () => searchResult || { status: "completed", offers: Array.from({ length: 12 }, (_, i) => ({ offerId: `o${i}`, price: 400 + i, currency: "USD" })) },
      searchHotels: async () => ({ status: "completed", offers: [{ offerId: "h1", price: 900, currency: "USD" }] }),
    },
    trips: { addProposedItem: async (x) => { added.push(x); return { id: "item1" }; } },
  };
  return { added, handlers: createToolHandlers({ agencyId: "ag1", tripId: "tr1", traveller }, deps) };
}
const scripted = (steps) => { let i = 0; const seen = []; return { seen, generate: async (req) => { seen.push(JSON.parse(JSON.stringify(req))); return steps[i++] || { text: "done" }; } }; };

test("model-facing tools cannot spend money: no approve/book/cancel/pay tool exists", () => {
  for (const n of toolNames()) assert.doesNotMatch(n, /book|approve|pay|cancel|refund|authorize|charge/i, n);
});

test("search -> propose flow: results are labelled estimated, capped, and proposals are not bookings", async () => {
  const { handlers, added } = mk();
  const model = scripted([
    { toolCalls: [{ id: "c1", name: "search_flights", args: { origin: "ABV", destination: "LHR", departDate: "2026-12-10" } }] },
    { toolCalls: [{ id: "c2", name: "propose_item", args: { kind: "flight", offerId: "o3" } }] },
    { text: "I proposed one flight (estimated price)." },
  ]);
  const r = await runAgentTurn({ model, toolSpecs: TOOL_SPECS, handlers, userMessage: "ABV to LHR 10 Dec" });
  assert.equal(r.degraded, false);
  assert.deepEqual(r.traces.map((t) => t.status), ["ok", "ok"]);
  const searchMsg = JSON.parse(r.messages.find((m) => m.role === "tool" && m.name === "search_flights").content);
  assert.equal(searchMsg.offers.length, 8);
  assert.ok(searchMsg.offers.every((o) => o.priceLabel === "estimated"));
  assert.equal(added.length, 1);
  assert.equal(added[0].offerId, "o3");
  assert.equal(added[0].quotedPrice, 403);
});

test("propose_item rejects offers the conversation never saw, and wrong kind", async () => {
  const { handlers, added } = mk();
  await assert.rejects(handlers.propose_item({ kind: "flight", offerId: "made-up" }), /not returned/);
  await handlers.search_hotels({ destination: "London", checkIn: "2026-12-10", checkOut: "2026-12-12" });
  await assert.rejects(handlers.propose_item({ kind: "flight", offerId: "h1" }), /not returned/);
  assert.equal(added.length, 0);
});

test("argument validation: bad IATA, bad dates, return before departure", async () => {
  const { handlers } = mk();
  await assert.rejects(handlers.search_flights({ origin: "Abuja", destination: "LHR", departDate: "2026-12-10" }), /IATA/);
  await assert.rejects(handlers.search_flights({ origin: "ABV", destination: "LHR", departDate: "10 Dec" }), /YYYY-MM-DD/);
  await assert.rejects(handlers.search_flights({ origin: "ABV", destination: "LHR", departDate: "2026-12-10", returnDate: "2026-12-01" }), /on or after/);
  await assert.rejects(handlers.search_hotels({ destination: "London", checkIn: "2026-12-10", checkOut: "2026-12-10" }), /after checkIn/);
});

test("a still-processing search is reported, not turned into fake offers", async () => {
  const { handlers } = mk({ searchResult: { status: "processing", offers: [] } });
  const r = await handlers.search_flights({ origin: "ABV", destination: "LHR", departDate: "2026-12-10" });
  assert.equal(r.status, "processing");
  assert.equal(r.offers.length, 0);
});

test("tool errors are contained and shown to the model; unknown tools are refused", async () => {
  const { handlers } = mk();
  const model = scripted([
    { toolCalls: [{ id: "c1", name: "search_flights", args: { origin: "bad" } }, { id: "c2", name: "book_flight", args: {} }] },
    { text: "Which airports?" },
  ]);
  const r = await runAgentTurn({ model, toolSpecs: TOOL_SPECS, handlers, userMessage: "fly me somewhere" });
  assert.deepEqual(r.traces.map((t) => t.status), ["error", "error"]);
  assert.equal(r.text, "Which airports?");
});

test("model failure, timeout and runaway loops end in a safe fallback", async () => {
  const { handlers } = mk();
  let r = await runAgentTurn({ model: { generate: async () => { throw new Error("503"); } }, toolSpecs: TOOL_SPECS, handlers, userMessage: "hi" });
  assert.equal(r.text, FALLBACK_TEXT); assert.equal(r.degraded, true);
  r = await runAgentTurn({ model: { generate: () => new Promise(() => {}) }, toolSpecs: TOOL_SPECS, handlers, userMessage: "hi", modelTimeoutMs: 20 });
  assert.equal(r.reason, "TIMEOUT");
  const loop = { generate: async () => ({ toolCalls: [{ id: "x", name: "get_traveller_profile", args: {} }] }) };
  r = await runAgentTurn({ model: loop, toolSpecs: TOOL_SPECS, handlers, userMessage: "hi", maxRounds: 3 });
  assert.equal(r.reason, "MAX_ROUNDS"); assert.equal(r.traces.length, 3);
});

test("nothing the model sees contains passport, email or surname", async () => {
  const { handlers } = mk();
  const model = scripted([{ toolCalls: [{ id: "c1", name: "get_traveller_profile", args: {} }] }, { text: "ok" }]);
  await runAgentTurn({ model, toolSpecs: TOOL_SPECS, handlers, userMessage: "plan a trip" });
  for (const req of model.seen) assertNoSecrets(req, ["A12345678", "ada@example.com", "Obi"]);
});
