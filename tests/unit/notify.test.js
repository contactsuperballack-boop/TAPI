const test = require("node:test");
const assert = require("node:assert/strict");
const { createNotifier } = require("../../src/services/notify");
const { createMailer } = require("../../src/services/mailer");

const base = { to: "ada@example.com", tripTitle: "London conference", tripId: "t-1", itemKind: "flight" };

test("confirmation email carries the reference, final price and a link, and nothing secret", async () => {
  const m = createMailer("memory"); const n = createNotifier({ getMailer: () => m, baseUrl: "https://tapi.test" });
  assert.equal(await n.bookingConfirmed({ ...base, ref: "ABC123", finalPrice: 480.5, currency: "USD" }), true);
  const { to, subject, text } = m.outbox[0];
  assert.equal(to, "ada@example.com"); assert.match(subject, /flight is booked/); assert.match(text, /ABC123/); assert.match(text, /USD 480\.50/); assert.match(text, /https:\/\/tapi\.test\/app\/#\/trips\/t-1/);
  assert.doesNotMatch(text, /passport|token=/i);
});

test("decline and reprice emails say nothing was booked", async () => {
  const m = createMailer("memory"); const n = createNotifier({ getMailer: () => m });
  await n.bookingDeclined({ ...base, reason: "Sold out" }); await n.repriced({ ...base, newPrice: 612, currency: "USD", note: "Fare class sold out" });
  assert.match(m.outbox[0].text, /Nothing was booked/); assert.match(m.outbox[0].text, /Sold out/);
  assert.match(m.outbox[1].text, /USD 612\.00/); assert.match(m.outbox[1].text, /Nothing was booked/);
});

test("user-controlled trip titles cannot inject headers or break the subject", async () => {
  const m = createMailer("memory"); const n = createNotifier({ getMailer: () => m });
  await n.bookingConfirmed({ ...base, tripTitle: "Nice\r\nBcc: evil@x.com", ref: "R", finalPrice: 1, currency: "USD" });
  assert.doesNotMatch(m.outbox[0].subject, /[\r\n]/);
});

test("failures are swallowed and logged without the message body; no mailer or recipient is a quiet no-op", async () => {
  const logs = [];
  const boom = createNotifier({ getMailer: () => ({ async send() { throw Object.assign(new Error("provider down"), { code: "MAIL_UNREACHABLE" }); } }), log: (l) => logs.push(l) });
  assert.equal(await boom.bookingConfirmed({ ...base, ref: "SECRETREF", finalPrice: 1, currency: "USD" }), false);
  assert.equal(logs.length, 1); assert.doesNotMatch(logs[0], /SECRETREF|ada@example/);
  assert.equal(await createNotifier({ getMailer: () => null }).bookingDeclined({ ...base, reason: "x" }), false);
  assert.equal(await createNotifier({ getMailer: () => createMailer("memory") }).bookingDeclined({ ...base, to: null, reason: "x" }), false);
});
