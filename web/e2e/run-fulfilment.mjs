// Browser e2e for agent-assisted bookings against the contract mock. Usage: node e2e/run-fulfilment.mjs [dir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { startMock } from "./mock-server.mjs";
const pw = await import("playwright").catch(() => import("/opt/npm-tools/node_modules/playwright/index.mjs"));
const shots = process.argv[2] || "e2e/shots"; mkdirSync(shots, { recursive: true });
const { server, port, db } = await startMock({ dist: new URL("../dist", import.meta.url).pathname });
const base = `http://127.0.0.1:${port}`; const app = `${base}/app/`; const HOUSE = "house-1";

// Seed verified accounts directly (account creation is covered by run-accounts.mjs).
const PW = "purple-harbour-engine";
function seedTraveller(first, last, email, extra = {}) {
  const t = { id: randomUUID(), agency: HOUSE, firstName: first, lastName: last, email, phone: "+2348000000000", nationality: "NG", dateOfBirth: "1990-03-04", passport: "A1234567" };
  const u = { id: randomUUID(), email, password: PW, fullName: `${first} ${last}`, verified: true, ...extra };
  db.travelers.push(t); db.users.push(u); db.memberships.push({ userId: u.id, role: "traveller", agencyId: HOUSE, travelerId: t.id });
}
seedTraveller("Tola", "Ade", "tola@example.com"); seedTraveller("Pat", "Self", "pat@example.com", { selfBooking: false });
const agentUser = { id: randomUUID(), email: "house.agent@tapi.test", password: PW, fullName: "Sam Agent", verified: true };
db.users.push(agentUser); db.memberships.push({ userId: agentUser.id, role: "agent", agencyId: HOUSE });

const browser = await pw.chromium.launch(); const results = []; let current = null;
const step = async (name, fn) => { try { await fn(); results.push(["ok", name]); console.log("ok  ", name); } catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n     ", e.message.split("\n")[0]); if (current) await current.screenshot({ path: `${shots}/FAIL-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png` }).catch(() => {}); } };
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 }); const page = await ctx.newPage(); page.setDefaultTimeout(8000); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message)); page.on("console", (m) => m.type() === "error" && !/status of (401|403|409|400)/.test(m.text()) && errors.push(m.text()));
  await page.goto(app); return { ctx, page, errors };
}
async function signIn(page, email) {
  await page.getByLabel("Email").fill(email); await page.getByLabel("Password", { exact: true }).fill(PW);
  await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("heading", { name: /Your trips|Requests/ }).first().waitFor();
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const card = (page, name) => page.getByRole("article", { name });
async function planTrip(page, title) {
  await page.getByRole("button", { name: "New trip" }).click(); await page.getByLabel("Trip name").fill(title); await page.getByRole("button", { name: "Create trip" }).click();
  await page.getByRole("heading", { name: title }).waitFor();
  await page.getByRole("tab", { name: "Find" }).click(); await page.getByLabel("From (airport code)").fill("LOS"); await page.getByLabel("To (airport code)").fill("LHR"); await page.getByLabel("Depart").fill("2026-12-10");
  await page.getByRole("button", { name: /Search flights/ }).click(); await page.getByText("British Airways flight").waitFor();
  // One at a time, waiting for each add to register (the list re-renders after every add).
  for (let n = 1; n <= 2; n++) { await page.getByRole("button", { name: "Add to trip", exact: true }).first().click(); await page.getByRole("button", { name: "Added to trip" }).nth(n - 1).waitFor(); }
  await page.getByRole("tab", { name: "Hotels" }).click(); await page.getByLabel("Destination").fill("London"); await page.getByLabel("Check in").fill("2026-12-10"); await page.getByLabel("Check out").fill("2026-12-17");
  await page.getByRole("button", { name: /Search hotels/ }).click(); await page.getByText("Kensington Court Hotel").waitFor(); await page.getByRole("button", { name: "Add to trip" }).click(); await page.getByText("Added to trip").waitFor();
  await page.getByRole("tab", { name: "Plan" }).click();
}
async function approveWithAgent(page, name, note) {
  await card(page, name).getByRole("button", { name: /Review and approve|Approve again/ }).click();
  await page.getByRole("radio", { name: /Have an agent book it/ }).check();
  if (note) await page.getByLabel("Anything the agent should know? (optional)").fill(note);
  await page.getByRole("button", { name: /Approve and send to an agent/ }).click(); await page.getByText(/Sent to an agent/).waitFor();
}

const T = await open({ width: 390, height: 844 }); const A = await open({ width: 1280, height: 860 });

current = T.page;
await step("traveller: signs in, plans a trip, approve sheet offers both ways to book", async () => {
  await signIn(T.page, "tola@example.com"); await planTrip(T.page, "Lagos to London");
  await card(T.page, "British Airways flight").getByRole("button", { name: "Review and approve" }).click();
  await T.page.getByRole("radio", { name: /Book it automatically/ }).waitFor(); await T.page.getByRole("radio", { name: /Have an agent book it/ }).check();
  await T.page.getByText(/Payment is arranged with your agent/).waitFor(); await T.page.getByText(/only at this price or lower/).waitFor();
  assert.ok((await overflow(T.page)) <= 0);
  await T.page.screenshot({ path: `${shots}/ful-1-approve-choice.png` });
  await T.page.getByLabel("Anything the agent should know? (optional)").fill("Window seat please");
  await T.page.getByRole("button", { name: /Approve and send to an agent/ }).click(); await T.page.getByText(/Sent to an agent/).waitFor();
});
await step("traveller: item shows it is waiting for an agent, the trip moves to Booking, and automated booking is not offered", async () => {
  const c = card(T.page, "British Airways flight");
  await c.getByText("Waiting for an agent", { exact: true }).waitFor(); await c.getByText(/Waiting for an agent to pick this up/).waitFor();
  assert.equal(await c.getByRole("button", { name: "Book now" }).count(), 0); await c.getByRole("button", { name: "Withdraw request" }).waitFor();
  await T.page.getByText("Booking", { exact: true }).first().waitFor();
  await T.page.screenshot({ path: `${shots}/ful-2-waiting.png`, fullPage: true });
});
await step("traveller: can withdraw a request nobody has started on", async () => {
  await approveWithAgent(T.page, "Kensington Court Hotel");
  await card(T.page, "Kensington Court Hotel").getByRole("button", { name: "Withdraw request" }).click();
  await T.page.getByText(/Request withdrawn/).waitFor(); await card(T.page, "Kensington Court Hotel").getByText("Proposed", { exact: true }).or(card(T.page, "Kensington Court Hotel").getByText("Needs new approval")).waitFor();
  assert.equal(db.requests.filter((r) => r.status === "cancelled").length, 1);
});

current = A.page;
await step("agent: sees the request with the traveller's note and the approved ceiling", async () => {
  await signIn(A.page, "house.agent@tapi.test");
  const nav = A.page.locator(".sidebar"); await nav.getByRole("button", { name: "Requests" }).click(); await A.page.getByRole("heading", { name: "Requests" }).waitFor();
  const c = card(A.page, /British Airways/); await c.waitFor();
  await c.getByText("Window seat please").waitFor(); await c.getByText("$486").waitFor(); await c.getByText("approved ceiling").waitFor(); await c.getByText(/h left/).waitFor();
  assert.equal(await A.page.getByRole("article").count(), 1);                                       // the withdrawn hotel request is not in the open list
  await A.page.screenshot({ path: `${shots}/ful-3-queue.png` });
});
await step("agent: claims it, and it moves to Mine; traveller sees who is booking", async () => {
  await card(A.page, /British Airways/).getByRole("button", { name: "Claim" }).click(); await A.page.getByText(/Claimed\. It is now under Mine/).waitFor();
  await A.page.getByRole("tab", { name: "Mine" }).click(); await card(A.page, /British Airways/).getByText(/Claimed by Sam Agent/).waitFor();
  await T.page.reload(); await card(T.page, "British Airways flight").getByText(/Sam Agent is booking this now/).waitFor();
});
await step("agent: passport details are shown only on request, with a note that the view is logged", async () => {
  const c = card(A.page, /British Airways/);
  assert.equal(await A.page.getByText("A1234567").count(), 0);
  await c.getByRole("button", { name: "Show traveller details" }).click(); await A.page.getByRole("region", { name: "Traveller details" }).getByText("A1234567").waitFor(); await A.page.getByText("This view is logged.").waitFor();
  assert.ok(db.events.some((e) => e.type === "pii_revealed"));
  await A.page.screenshot({ path: `${shots}/ful-4-details.png` });
  await c.getByRole("button", { name: "Hide" }).click(); assert.equal(await A.page.getByText("A1234567").count(), 0);
});
await step("agent: cannot record a price above what the traveller approved; at or below it works", async () => {
  await card(A.page, /British Airways/).getByRole("button", { name: "Record booking" }).click();
  await A.page.getByLabel("Confirmation reference (PNR or booking number)").fill("ABC123");
  await A.page.getByLabel("Final price paid (USD)").fill("500");
  await A.page.getByText(/higher than the traveller approved/).waitFor(); assert.equal(await A.page.getByRole("button", { name: "Mark as booked" }).isDisabled(), true);
  await A.page.screenshot({ path: `${shots}/ful-5-over-price.png` });
  await A.page.getByLabel("Final price paid (USD)").fill("480");
  await A.page.getByRole("button", { name: "Mark as booked" }).click(); await A.page.getByText(/Marked as booked/).waitFor();
  await A.page.getByRole("tab", { name: "Done" }).click(); await card(A.page, /British Airways/).getByText(/Confirmation .*ABC123/).waitFor();
  assert.ok(db.mail.some((m) => m.purpose === "booked" && /ABC123/.test(m.text)));
});

current = T.page;
await step("traveller: sees the confirmation reference and the real price; trip is partly booked", async () => {
  await T.page.reload(); const c = card(T.page, "British Airways flight");
  await c.getByText("Confirmed", { exact: true }).waitFor(); await c.getByText(/Confirmation:/).waitFor(); await c.getByText("ABC123").waitFor(); await c.getByText("$480").waitFor(); await c.getByText("Confirmed price").waitFor();
  await T.page.getByText("Partly booked").waitFor(); assert.ok((await overflow(T.page)) <= 0);
  await T.page.screenshot({ path: `${shots}/ful-6-confirmed.png`, fullPage: true });
});
await step("price changed: agent sends it back; traveller sees the agent's note and the new price, and approves again", async () => {
  await approveWithAgent(T.page, "Lufthansa flight");
  current = A.page; await A.page.getByRole("tab", { name: "Open" }).click(); await A.page.reload(); await A.page.getByRole("tab", { name: "Open" }).click();
  await card(A.page, /Lufthansa/).getByRole("button", { name: "Claim" }).click(); await A.page.getByRole("tab", { name: "Mine" }).click();
  await card(A.page, /Lufthansa/).getByRole("button", { name: "Price changed" }).click();
  await A.page.getByLabel("New price (USD)").fill("560"); await A.page.getByLabel("Why did the price change?").fill("Fare class sold out; next fare is higher");
  await A.page.screenshot({ path: `${shots}/ful-7-reprice.png` });
  await A.page.getByRole("button", { name: "Send back for approval" }).click(); await A.page.getByText(/Sent back to the traveller/).waitFor();
  current = T.page; await T.page.reload(); const c = card(T.page, "Lufthansa flight");
  await c.getByText("Needs new approval").waitFor(); await c.getByText("$560").waitFor(); await c.getByText(/Your agent says: Fare class sold out/).waitFor();
  await approveWithAgent(T.page, "Lufthansa flight"); await c.getByText("Waiting for an agent", { exact: true }).waitFor();
  await T.page.screenshot({ path: `${shots}/ful-8-repriced.png`, fullPage: true });
});
await step("cannot book: agent declines with a reason; traveller is told nothing was booked", async () => {
  current = A.page; await A.page.reload(); await A.page.getByRole("tab", { name: "Open" }).click();
  await card(A.page, /Lufthansa/).getByRole("button", { name: "Claim" }).click(); await A.page.getByRole("tab", { name: "Mine" }).click();
  await card(A.page, /Lufthansa/).getByRole("button", { name: "Cannot book" }).click(); await A.page.getByLabel("What should the traveller know?").fill("Sold out on those dates");
  await A.page.getByRole("button", { name: "Tell the traveller" }).click(); await A.page.getByText(/The traveller has been told/).waitFor();
  current = T.page; await T.page.reload(); const c = card(T.page, "Lufthansa flight");
  await c.getByText("Failed", { exact: true }).waitFor(); await c.getByText(/Your agent could not book this: Sold out on those dates\. Nothing was booked\./).waitFor();
  await T.page.getByRole("tab", { name: "Activity" }).click(); await T.page.getByText("An agent could not book this").waitFor();
});
await step("agency books for its clients: the traveller is offered only the agent route", async () => {
  const P = await open({ width: 390, height: 844 }); current = P.page;
  await signIn(P.page, "pat@example.com"); await planTrip(P.page, "Pat's trip");
  await card(P.page, "British Airways flight").getByRole("button", { name: "Review and approve" }).click();
  await P.page.getByText(/This agency books for its clients/).waitFor(); assert.equal(await P.page.getByRole("radio").count(), 0);
  await P.page.getByRole("button", { name: /Approve and send to an agent/ }).waitFor();
  await P.page.screenshot({ path: `${shots}/ful-9-forced-agent.png` });
  await P.page.getByRole("button", { name: /Approve and send to an agent/ }).click(); await P.page.getByText(/Sent to an agent/).waitFor();
  assert.equal(db.requests.filter((r) => r.status === "open").length, 1);
  await P.ctx.close();
});
await step("traveller: no Requests tab, and the API refuses the queue for a traveller session", async () => {
  current = T.page; assert.equal(await T.page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "Requests" }).count(), 0);
  const tok = JSON.parse(await T.page.evaluate(() => sessionStorage.getItem("tapi.auth"))).token;
  assert.equal((await fetch(`${base}/v1/fulfilment`, { headers: { Authorization: `Bearer ${tok}` } })).status, 403);
  await T.page.goto(`${app}#/requests`); await T.page.reload(); await T.page.getByText("That page is not available for your account.").waitFor();
});
await step("no page or console errors for either person", async () => { for (const x of [T, A]) { if (x.errors.length) console.log("     ", JSON.stringify(x.errors)); assert.deepEqual(x.errors, []); } });

await browser.close(); server.close();
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} agent-booking UI steps passed`);
process.exit(failed ? 1 : 0);
