const test = require("node:test");
const assert = require("node:assert/strict");
const { validateProfileUpdate, missingForBooking } = require("../../src/domain/profile");

test("profile update: only provided keys come back, values are normalised, bad values are refused with a clear message", () => {
  assert.deepEqual(validateProfileUpdate({ passportNumber: " a12 34567 ", nationality: "ng" }).value, { passportNumber: "A1234567", nationality: "NG" });
  assert.deepEqual(validateProfileUpdate({}).value, {});
  assert.deepEqual(validateProfileUpdate({ phone: "" }).value, { phone: null });
  for (const [bad, re] of [[{ dateOfBirth: "02/01/1990" }, /YYYY-MM-DD/], [{ dateOfBirth: "2999-01-01" }, /not valid/], [{ dateOfBirth: "1800-01-01" }, /not valid/], [{ dateOfBirth: "2026-13-45" }, /YYYY-MM-DD/],
    [{ nationality: "NGA" }, /2-letter/], [{ passportNumber: "12" }, /5 to 20/], [{ passportNumber: "A1234567; DROP" }, /5 to 20/], [{ phone: "call me" }, /phone/], [{ firstName: "  " }, /First name/], [{ lastName: "x".repeat(81) }, /Last name/]]) {
    assert.match(validateProfileUpdate(bad).error, re, JSON.stringify(bad));
  }
});

test("flights need passport details; hotels only need names and email", () => {
  const full = { first_name: "Ada", last_name: "Obi", email: "a@x.com", date_of_birth: "1990-01-02", passport_number: "A1234567", nationality: "NG" };
  assert.deepEqual(missingForBooking("flight", full), []);
  assert.deepEqual(missingForBooking("flight", { first_name: "Ada", last_name: "Obi", email: "a@x.com" }), ["dateOfBirth", "passportNumber", "nationality"]);
  assert.deepEqual(missingForBooking("hotel", { first_name: "Ada", last_name: "Obi", email: "a@x.com" }), []);
  assert.deepEqual(missingForBooking("hotel", { first_name: "Ada", last_name: "Obi" }), ["email"]);
  assert.deepEqual(missingForBooking("flight", null), ["profile"]);
});
