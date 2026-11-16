// End-to-end UI check against the contract mock. Usage: node e2e/run.mjs [screenshotDir]
// Needs `playwright` + a Chromium (npm i -D playwright && npx playwright install chromium).
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { startMock } from "./mock-server.mjs";
const pw = await import("playwright").catch(() => import("/opt/npm-tools/node_modules/playwright/index.mjs"));
const shots = process.argv[2] || "e2e/shots"; mkdirSync(shots, { recursive: true });

const { server, port, db } = await startMock({ dist: new URL("../dist", import.meta.url).pathname });
const base = `http://127.0.0.1:${port}/app/`;
const browser = await pw.chromium.launch();
const results = [];
let current = null;
const step = async (name, fn) => { try { await fn(); results.push(["ok", name]); console.log("ok  ", name); } catch (e) { results.push(["FAIL", name]); console.log("FAIL", name, "\n     ", e.message.split("\n")[0]); if (current) await current.screenshot({ path: `${shots}/FAIL-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 50)}.png` }).catch(() => {}); } };

async function session(viewport, tag) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 2 });
  const page = await ctx.newPage(); current = page; page.setDefaultTimeout(8000); const errors = [];
  page.on("pageerror", (e) => errors.push(e.message)); // the browser logs every non-2xx response; 401 (bad key) and 409 (blocked booking) are triggered on purpose
  page.on("console", (m) => m.type() === "error" && !/status of (401|409)/.test(m.text()) && errors.push(m.text()));
  await page.goto(base);

  await step(`${tag}: rejects a bad key, accepts a good one`, async () => {
    await page.getByText("Developer access with an agency API key").click();
    await page.getByLabel("Agency API key").fill("nope"); await page.getByRole("button", { name: "Use API key" }).click();
    await page.getByText("That API key was not accepted.").waitFor();
    await page.screenshot({ path: `${shots}/${tag}-1-connect-error.png` });
    await page.getByLabel("Agency API key").fill("good-key"); await page.getByRole("button", { name: "Use API key" }).click();
    await page.getByRole("heading", { name: "Your trips" }).waitFor();
  });
  await step(`${tag}: empty state, then create a trip`, async () => {
    await page.getByText("No trips yet").waitFor(); await page.screenshot({ path: `${shots}/${tag}-2-empty.png` });
    await page.getByRole("button", { name: "Plan your first trip" }).click();
    await page.getByLabel("Trip name").fill("London conference"); await page.getByLabel("From (airport code)").fill("abv");
    await page.getByLabel("To (city or airport)").fill("London"); await page.getByLabel("Start").fill("2026-12-10"); await page.getByLabel("End").fill("2026-12-17");
    await page.getByLabel("Budget (optional)").fill("1500"); await page.screenshot({ path: `${shots}/${tag}-3-new-trip.png` });
    await page.getByRole("button", { name: "Create trip" }).click();
    await page.getByRole("heading", { name: "London conference" }).waitFor();
  });
  await step(`${tag}: empty plan -> Find: search flights, add both, search hotels, add one`, async () => {
    await page.getByRole("button", { name: "Find flights and hotels" }).click();
    assert.equal(await page.getByLabel("From (airport code)").inputValue(), "ABV");      // prefilled from the trip
    assert.equal(await page.getByLabel("To (airport code)").inputValue(), "");           // "London" is not an IATA code: not guessed
    await page.getByLabel("To (airport code)").fill("lhr");
    await page.getByRole("button", { name: /Search flights/ }).click();
    await page.getByText("British Airways flight").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `page is ${overflow}px wider than the screen (horizontal scroll)`);
    const spill = await page.evaluate(() => [...document.querySelectorAll(".card input, .card select")].filter((el) => { const c = el.closest(".card").getBoundingClientRect(), r = el.getBoundingClientRect(); return r.right > c.right - 1 || r.left < c.left + 1; }).map((el) => el.id));
    assert.deepEqual(spill, [], `inputs overflow their card: ${spill}`);
    await page.screenshot({ path: `${shots}/${tag}-4-flight-results.png` });
    for (const b of await page.getByRole("button", { name: "Add to trip" }).all()) await b.click();
    await page.getByText("Added to trip").first().waitFor();
    await page.getByRole("tab", { name: "Hotels" }).click();
    await page.getByRole("button", { name: /Search hotels/ }).click();
    await page.getByText("Kensington Court Hotel").waitFor();
    await page.getByRole("button", { name: "Add to trip" }).click();
  });
  await step(`${tag}: plan shows items, totals and budget; estimates are labelled`, async () => {
    await page.getByRole("tab", { name: "Plan" }).click();
    await page.getByText("British Airways flight").waitFor();
    await page.getByText("$1,666").waitFor();                                            // 486 + 540 + 640
    await page.getByText(/Over budget by \$166/).waitFor();
    assert.ok((await page.getByText("Estimated price").count()) >= 3);
    await page.screenshot({ path: `${shots}/${tag}-5-plan.png`, fullPage: true });
  });
  await step(`${tag}: approve sheet shows the exact price; approving does not book`, async () => {
    await page.getByRole("article", { name: "British Airways flight" }).getByRole("button", { name: "Review and approve" }).click();
    await page.getByRole("dialog").getByText("$486").first().waitFor();
    await page.screenshot({ path: `${shots}/${tag}-6-approve.png` });
    await page.getByRole("button", { name: "Approve $486" }).click();
    await page.getByText(/Approved\. You can now book/).waitFor();
    assert.equal(db.items.filter((i) => i.status === "booking").length, 0);
  });
  await step(`${tag}: cannot book without a traveller; add one, choose it, then book`, async () => {
    const card = page.getByRole("article", { name: "British Airways flight" });
    await card.getByText("Choose a traveller above to book.").waitFor();
    assert.equal(await card.getByRole("button", { name: "Book now" }).isDisabled(), true);
    await page.getByRole("link", { name: "Add a client" }).click();
    await page.getByRole("button", { name: "Add a client" }).click();
    await page.getByLabel("First name").fill("Ada"); await page.getByLabel("Last name").fill("Obi"); await page.getByLabel("Email").fill("ada@example.com");
    await page.getByLabel("Passport number").fill("A12345678"); await page.getByLabel("Date of birth").fill("1990-01-02"); await page.getByLabel("Nationality (2-letter)").fill("NG");
    await page.getByRole("button", { name: "Save client" }).click();
    await page.getByText("Ada Obi").waitFor();
    assert.equal(await page.getByText("A12345678").count(), 0);                          // never shown in full
    await page.getByText(/678$/).first().waitFor();
    await page.screenshot({ path: `${shots}/${tag}-7-travellers.png` });
    await page.goBack(); await page.getByRole("heading", { name: "London conference" }).waitFor();
    await page.getByLabel("Traveller").selectOption({ label: "Ada Obi" });
    await card.getByRole("button", { name: "Book now" }).click();
    await page.getByText(/Booking started/).waitFor();
    await card.getByText(/Booking reference: bk_/).waitFor();
    await page.getByText("Booking", { exact: true }).first().waitFor();                  // trip chip moved on from Draft
    assert.equal(await card.getByText("Confirmed price").count(), 1);                    // price was rechecked at booking time
    await card.getByRole("button", { name: "Check status" }).click();
    await card.getByText("Confirmed", { exact: true }).waitFor();
    await page.getByText("Partly booked").waitFor();
    await page.screenshot({ path: `${shots}/${tag}-8-booked.png`, fullPage: true });
  });
  await step(`${tag}: a price increase stops the booking, explains it, and offers re-approval at the new price`, async () => {
    const card = page.getByRole("article", { name: "Lufthansa flight" });
    await card.getByRole("button", { name: "Review and approve" }).click(); await page.getByRole("button", { name: "Approve $540" }).click();
    await page.getByText(/Approved\. You can now book/).waitFor();
    await card.getByRole("button", { name: "Book now" }).click();
    await page.getByText(/The price went up to \$605\. Nothing was booked/).waitFor();
    await page.screenshot({ path: `${shots}/${tag}-9-price-up.png`, fullPage: true });
    await card.getByText("Needs new approval").waitFor();
    await card.getByRole("button", { name: "Review and approve" }).click();
    await page.getByRole("dialog").getByText("$605").first().waitFor();
    await page.getByRole("button", { name: "Close" }).click();
  });
  await step(`${tag}: assistant tab explains when no model is configured; activity lists events`, async () => {
    await page.getByRole("tab", { name: "Assistant" }).click();
    await page.getByText(/not switched on for this deployment/).waitFor();
    assert.equal(await page.getByLabel("Message").isDisabled(), true);
    await page.screenshot({ path: `${shots}/${tag}-10-assistant.png` });
    await page.getByRole("tab", { name: "Activity" }).click();
    await page.getByText("Booking stopped before any charge").waitFor();
    await page.screenshot({ path: `${shots}/${tag}-11-activity.png` });
  });
  await step(`${tag}: no page or console errors`, async () => { if (errors.length) console.log("     ", JSON.stringify(errors)); assert.deepEqual(errors, []); });
  await ctx.close();
}

await session({ width: 390, height: 844 }, "phone");
db.trips.length = 0; db.items.length = 0; db.approvals.length = 0; db.travelers.length = 0; db.events.length = 0;
await session({ width: 1280, height: 860 }, "desktop");
await browser.close(); server.close();
const failed = results.filter((r) => r[0] === "FAIL").length;
console.log(`\n${results.length - failed}/${results.length} UI steps passed`);
process.exit(failed ? 1 : 0);
