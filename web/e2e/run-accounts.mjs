// Browser e2e for accounts and roles against the contract mock: traveller sign-up -> verify -> profile -> book,
// and agency staff invite -> accept -> consent -> book, plus role scoping. Usage: node e2e/run-accounts.mjs [dir]
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { startMock } from "./mock-server.mjs";
const pw = await import("playwright").catch(() => import("/opt/npm-tools/node_modules/playwright/index.mjs"));
const shots = process.argv[2] || "e2e/shots"; mkdirSync(shots, { recursive: true });
const { server, port, db } = await startMock({ dist: new URL("../dist", import.meta.url).pathname });
const base = `http://127.0.0.1:${port}`; const app = `${base}/app/`;
const browser = await pw.chromium.launch(); const results = [];
let current = null;
const step = async (name, fn) => { try { await fn(); results.push(["ok", name]); console.log("ok  ", name); } catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n     ", e.message.split("\n")[0]); if (current) await current.screenshot({ path: `${shots}/FAIL-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png` }).catch(() => {}); } };
const mail = async (to, purpose) => (await (await fetch(`${base}/__mail`)).json()).filter((m) => m.to === to && m.purpose === purpose && !m.used).at(-1);
async function open(viewport) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 }); const page = await ctx.newPage(); current = page; page.setDefaultTimeout(8000); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/status of (401|403|409|400)/.test(m.text()) && errors.push(m.text()));
  await page.goto(app); return { ctx, page, errors };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
async function addFirstFlight(page) {
  await page.getByRole("tab", { name: "Find" }).click();
  await page.getByLabel("From (airport code)").fill("ABV"); await page.getByLabel("To (airport code)").fill("LHR"); await page.getByLabel("Depart").fill("2026-12-10");
  await page.getByRole("button", { name: /Search flights/ }).click(); await page.getByText("British Airways flight").waitFor();
  await page.getByRole("button", { name: "Add to trip" }).first().click(); await page.getByText("Added to trip").first().waitFor();
  await page.getByRole("tab", { name: "Plan" }).click();
}

// ---------------- traveller, on a phone ----------------
{
  const { ctx, page, errors } = await open({ width: 390, height: 844 });
  await step("traveller: create account signs in, shows verify banner, and only traveller navigation", async () => {
    await page.getByRole("tab", { name: "Create account" }).click();
    await page.screenshot({ path: `${shots}/acct-1-signup.png` });
    await page.getByLabel("First name").fill("Ada"); await page.getByLabel("Last name").fill("Obi"); await page.getByLabel("Email").fill("ada@example.com"); await page.getByLabel("Password", { exact: true }).fill("kettle-orbit-lantern");
    assert.equal(await overflow(page) <= 0, true);
    await page.getByRole("button", { name: "Create account" }).click();
    await page.getByRole("heading", { name: "Your trips" }).waitFor();
    await page.getByText(/Confirm your email to approve and book trips/).waitFor();
    await page.getByText(/Account created/).waitFor();
    const nav = page.getByRole("navigation", { name: "Main" });
    await nav.getByRole("button", { name: "My trips" }).waitFor(); await nav.getByRole("button", { name: "My details" }).waitFor();
    assert.equal(await nav.getByRole("button", { name: "Clients" }).count(), 0); assert.equal(await nav.getByRole("button", { name: "Team" }).count(), 0);
    await page.screenshot({ path: `${shots}/acct-2-traveller-home.png` });
  });
  await step("traveller: weak password and duplicate email are handled without leaking", async () => {
    const p2 = await ctx.newPage(); await p2.goto(app);
    await p2.getByRole("tab", { name: "Create account" }).click();
    await p2.getByLabel("First name").fill("X"); await p2.getByLabel("Last name").fill("Y"); await p2.getByLabel("Email").fill("x@example.com"); await p2.getByLabel("Password", { exact: true }).fill("short");
    await p2.getByRole("button", { name: "Create account" }).click(); await p2.getByText("Use at least 10 characters.").waitFor();
    await p2.getByLabel("Email").fill("ada@example.com"); await p2.getByLabel("Password", { exact: true }).fill("a-different-long-pass");
    await p2.getByRole("button", { name: "Create account" }).click();
    await p2.getByText(/If this email is new, we have sent a confirmation link/).waitFor();      // same message as a new address; no "already registered"
    assert.equal(await p2.getByText(/already (registered|exists)/i).count(), 0);
    await p2.close();
  });
  await step("traveller: plans a trip with no traveller picker; approving is blocked until the email is confirmed", async () => {
    await page.getByRole("button", { name: "New trip" }).click(); await page.getByLabel("Trip name").fill("London conference");
    await page.getByRole("button", { name: "Create trip" }).click(); await page.getByRole("heading", { name: "London conference" }).waitFor();
    await page.getByText("Travelling").waitFor(); assert.equal(await page.getByLabel("Traveller", { exact: true }).count(), 0);
    await addFirstFlight(page);
    const card = page.getByRole("article", { name: "British Airways flight" });
    assert.equal(await card.getByRole("button", { name: "Review and approve" }).isDisabled(), true);
    await card.getByText("Confirm your email to approve.").waitFor();
    await page.screenshot({ path: `${shots}/acct-3-unverified.png`, fullPage: true });
  });
  await step("traveller: email link verifies once; banner disappears; approve works", async () => {
    const m = await mail("ada@example.com", "verify"); assert.ok(m, "verification mail exists");
    await page.goto(`${app}#/verify?token=${m.token}`);
    await page.getByRole("heading", { name: "Email confirmed" }).waitFor();
    await page.getByRole("button", { name: "Continue" }).click(); await page.getByRole("heading", { name: "Your trips" }).waitFor();
    assert.equal(await page.getByText(/Confirm your email to approve and book trips/).count(), 0);
    const p2 = await ctx.newPage(); await p2.goto(`${app}#/verify?token=${m.token}`);                       // replaying the link fails
    await p2.getByText(/expired or was already used/).waitFor(); await p2.getByText(/If you already confirmed your email/).waitFor(); await p2.close();
    await page.getByRole("button", { name: /London conference/ }).click();
    const card = page.getByRole("article", { name: "British Airways flight" });
    await card.getByRole("button", { name: "Review and approve" }).click();
    assert.equal(await page.getByRole("dialog").getByRole("checkbox").count(), 0);                          // travellers attest nothing
    await page.getByRole("button", { name: "Approve $486" }).click(); await page.getByText(/Approved\. You can now book/).waitFor();
  });
  await step("traveller: booking stops with a clear message until passport details are added, then succeeds", async () => {
    const card = page.getByRole("article", { name: "British Airways flight" });
    await card.getByRole("button", { name: "Book now" }).click();
    await page.getByText(/Add date of birth, passport number, nationality/).waitFor();
    assert.equal(db.items.filter((i) => i.status === "booking").length, 0);
    await page.screenshot({ path: `${shots}/acct-4-profile-incomplete.png`, fullPage: true });
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "My details" }).click();
    await page.getByText(/we still need your date of birth, passport number, nationality/).waitFor();
    await page.getByLabel("Date of birth").fill("1990-01-02"); await page.getByLabel("Nationality (2 letters)").fill("ng"); await page.getByLabel("Passport number").fill("A1234567");
    await page.getByRole("button", { name: "Save details" }).click(); await page.getByText("Saved.").waitFor();
    await page.getByText("Ready to book flights").waitFor();
    assert.equal(await page.getByText("A1234567").count(), 0);                                              // never echoed back
    await page.screenshot({ path: `${shots}/acct-5-my-details.png` });
    await page.getByRole("navigation", { name: "Main" }).getByRole("button", { name: "My trips" }).click();
    await page.getByRole("button", { name: /London conference/ }).click();
    await card.getByRole("button", { name: "Book now" }).click(); await page.getByText(/Booking started/).waitFor();
  });
  await step("traveller: staff-only pages are refused, and the API refuses staff calls with the same session", async () => {
    for (const h of ["#/team", "#/clients"]) { await page.goto(`${app}${h}`); await page.reload(); await page.getByText("That page is not available for your account.").waitFor(); }
    const tok = JSON.parse(await page.evaluate(() => sessionStorage.getItem("tapi.auth"))).token;
    for (const [m, u] of [["GET", "/v1/staff"], ["POST", "/v1/flights/bookings"], ["GET", "/v1/orders"]]) assert.equal((await fetch(base + u, { method: m, headers: { Authorization: `Bearer ${tok}` } })).status, 403, u);
  });
  await step("traveller: sign out, wrong password is a generic error, password reset link sets a new password", async () => {
    await page.goto(`${app}#/trips`); await page.reload();
    await page.getByRole("navigation", { name: "Main" }).waitFor(); await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.getByRole("tab", { name: "Sign in" }).waitFor();
    await page.getByLabel("Email").fill("ada@example.com"); await page.getByLabel("Password", { exact: true }).fill("not-the-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByText("Email or password is incorrect.").waitFor();
    await page.getByRole("button", { name: "Forgot your password?" }).click(); await page.getByLabel("Email").fill("ada@example.com");
    await page.getByRole("button", { name: "Send reset link" }).click(); await page.getByText(/If that email has an account/).waitFor();
    const m = await mail("ada@example.com", "reset");
    await page.goto(`${app}#/reset?token=${m.token}`); await page.reload();
    await page.getByLabel("New password", { exact: true }).fill("brand-new-passphrase"); await page.getByLabel("Repeat new password").fill("brand-new-passphrase");
    await page.screenshot({ path: `${shots}/acct-6-reset.png` });
    await page.getByRole("button", { name: "Save password" }).click(); await page.getByRole("heading", { name: "Password saved" }).waitFor();
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("Email").fill("ada@example.com"); await page.getByLabel("Password", { exact: true }).fill("brand-new-passphrase");
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("heading", { name: "Your trips" }).waitFor();
  });
  await step("traveller: no page or console errors", async () => { if (errors.length) console.log("     ", JSON.stringify(errors)); assert.deepEqual(errors, []); });
  await ctx.close();
}

// ---------------- agency admin + agent, on desktop ----------------
{
  const { ctx, page, errors } = await open({ width: 1280, height: 860 });
  await step("admin (API key): invites an agent from Team", async () => {
    await page.getByText("Developer access with an agency API key").click();
    await page.getByLabel("Agency API key").fill("good-key"); await page.getByRole("button", { name: "Use API key" }).click();
    await page.getByRole("button", { name: "Team" }).first().click(); await page.getByRole("heading", { name: "Team" }).waitFor();
    await page.getByRole("button", { name: "Invite", exact: true }).click(); await page.getByLabel("Full name").fill("Sam Agent"); await page.getByLabel("Email").fill("sam@acme.test");
    await page.screenshot({ path: `${shots}/acct-7-invite.png` });
    await page.getByRole("button", { name: "Send invite" }).click(); await page.getByText("Sam Agent").waitFor(); await page.getByText("Invite pending").waitFor();
    await page.screenshot({ path: `${shots}/acct-8-team.png` });
    await page.getByRole("button", { name: "Sign out" }).first().click();
  });
  await step("agent: accepts the invite, sets a password, signs in; sees Trips and Clients but not Team", async () => {
    const m = await mail("sam@acme.test", "invite");
    await page.goto(`${app}#/reset?token=${m.token}`); await page.reload();
    await page.getByLabel("New password", { exact: true }).fill("purple-harbour-engine"); await page.getByLabel("Repeat new password").fill("purple-harbour-engine");
    await page.getByRole("button", { name: "Save password" }).click(); await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByLabel("Email").fill("sam@acme.test"); await page.getByLabel("Password", { exact: true }).fill("purple-harbour-engine");
    await page.getByRole("button", { name: "Sign in", exact: true }).click(); await page.getByRole("heading", { name: "Your trips" }).waitFor();
    const side = page.locator(".sidebar");
    await side.getByRole("button", { name: "Clients" }).waitFor(); assert.equal(await side.getByRole("button", { name: "Team" }).count(), 0);
    await side.getByText("Sam Agent").waitFor(); await side.getByText(/Agent · Acme Travel/).waitFor();
    assert.equal(await page.getByText(/Confirm your email/).count(), 0);                                    // invite acceptance verified the email
  });
  await step("agent: sees only their agency's trips, not the direct traveller's", async () => {
    await page.getByText("No trips yet").waitFor();                                                         // Ada's trip lives in the house agency
    assert.ok(db.trips.some((t) => t.title === "London conference"));
  });
  await step("agent: adds a client, plans a trip for them, and must tick consent before approving", async () => {
    await page.locator(".sidebar").getByRole("button", { name: "Clients" }).click();
    await page.getByRole("button", { name: "Add a client" }).click();
    await page.getByLabel("First name").fill("Chi"); await page.getByLabel("Last name").fill("Eze"); await page.getByLabel("Email").fill("chi@example.com");
    await page.getByLabel("Passport number").fill("B7654321"); await page.getByLabel("Date of birth").fill("1985-05-05"); await page.getByLabel("Nationality (2-letter)").fill("NG");
    await page.getByRole("button", { name: "Save client" }).click(); await page.getByText("Chi Eze").waitFor();
    await page.screenshot({ path: `${shots}/acct-9-clients.png` });
    await page.locator(".sidebar").getByRole("button", { name: "Trips" }).click(); await page.getByRole("button", { name: "New trip" }).click();
    await page.getByLabel("Trip name").fill("For Chi"); await page.getByRole("button", { name: "Create trip" }).click();
    await page.getByLabel("Traveller", { exact: true }).selectOption({ label: "Chi Eze" });
    await addFirstFlight(page);
    const card = page.getByRole("article", { name: "British Airways flight" });
    await card.getByRole("button", { name: "Review and approve" }).click();
    const approve = page.getByRole("button", { name: "Approve $486" });
    assert.equal(await approve.isDisabled(), true);
    await page.getByRole("checkbox", { name: /My client has agreed/ }).check();
    await page.screenshot({ path: `${shots}/acct-10-consent.png` });
    assert.equal(await approve.isDisabled(), false); await approve.click();
    await page.getByText(/Approved\. You can now book/).waitFor();
    assert.equal(db.approvals.at(-1).consent, true); assert.equal(db.approvals.at(-1).by_role, "agent");
    await card.getByRole("button", { name: "Book now" }).click(); await page.getByText(/Booking started/).waitFor();
  });
  await step("agent: refused on team pages (UI and API)", async () => {
    await page.goto(`${app}#/team`); await page.reload(); await page.getByText("That page is not available for your account.").waitFor();
    const tok = JSON.parse(await page.evaluate(() => sessionStorage.getItem("tapi.auth"))).token;
    assert.equal((await fetch(`${base}/v1/staff`, { headers: { Authorization: `Bearer ${tok}` } })).status, 403);
  });
  await step("admin and agent: no page or console errors", async () => { if (errors.length) console.log("     ", JSON.stringify(errors)); assert.deepEqual(errors, []); });
  await ctx.close();
}
await browser.close(); server.close();
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} account UI steps passed`);
process.exit(failed ? 1 : 0);
