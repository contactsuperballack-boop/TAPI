#!/usr/bin/env node
/*
 * LetsFG Developer API sandbox smoke test.
 * Uses fake passenger data and the documented sandbox lane only.
 * No real airline booking or payment is possible through this script.
 *
 * Usage:
 *   LETSFG_ENVIRONMENT=sandbox node scripts/letsfg-sandbox-smoke.js
 *   LETSFG_SANDBOX_SCENARIO=price_change node scripts/letsfg-sandbox-smoke.js
 *   LETSFG_SANDBOX_SCENARIO=extra LETSFG_WANT_SEAT=true node scripts/letsfg-sandbox-smoke.js
 */
const { randomUUID } = require('node:crypto');

const BASE = (process.env.LETSFG_BASE_URL || 'https://letsfg.co').replace(/\/$/, '');
const API = `${BASE}/developers/api/v1/sandbox`;
const KEY = process.env.LETSFG_API_KEY || '';
const SCENARIO = process.env.LETSFG_SANDBOX_SCENARIO || 'success';
const SPEED = process.env.LETSFG_SANDBOX_SPEED || 'fast';
const ORIGIN = process.env.LETSFG_SMOKE_ORIGIN || 'LOS';
const DESTINATION = process.env.LETSFG_SMOKE_DESTINATION || 'LHR';
const CURRENCY = process.env.LETSFG_SMOKE_CURRENCY || 'USD';
const WANT_SEAT = process.env.LETSFG_WANT_SEAT === 'true';
const POLL_MS = Number(process.env.LETSFG_SMOKE_POLL_MS || 5000);
const MAX_WAIT_MS = Number(process.env.LETSFG_SMOKE_MAX_WAIT_MS || 180000);
const ALLOWED = new Set(['success', 'price_change', 'extra', 'seller_failed', 'needs_attention', 'payment_declined', 'payment_method_required', 'temporarily_unavailable']);
if (!ALLOWED.has(SCENARIO)) throw new Error(`Unsupported sandbox scenario: ${SCENARIO}`);

function futureDate(days = 45) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toISOString().slice(0, 10);
}
const DATE = process.env.LETSFG_SMOKE_DATE || futureDate();

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (KEY) headers['X-API-Key'] = KEY;
  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(25000),
  });
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 1000) }; }
  return { status: response.status, ok: response.ok, data };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  console.log(`LetsFG sandbox smoke test: ${ORIGIN} -> ${DESTINATION} on ${DATE}`);
  console.log(`Scenario=${SCENARIO}; speed=${SPEED}; wantSeat=${WANT_SEAT}; API key=${KEY ? 'provided' : 'omitted (allowed in sandbox)'}`);

  const search = await request('POST', '/flights/search', {
    origin: ORIGIN,
    destination: DESTINATION,
    date_from: DATE,
    adults: 1,
    currency: CURRENCY,
  });
  if (!search.ok) throw new Error(`Sandbox search failed (${search.status}): ${JSON.stringify(search.data)}`);
  const offers = Array.isArray(search.data.offers) ? search.data.offers : [];
  if (!search.data.search_id || !offers.length) throw new Error(`Sandbox search returned no usable search_id/offers: ${JSON.stringify(search.data).slice(0, 1200)}`);
  const offer = offers.find((x) => x.offer_id || x.id);
  if (!offer) throw new Error('Sandbox offers did not contain offer_id/id.');
  const offerId = offer.offer_id || offer.id;
  console.log(`SEARCH_OK search_id=${search.data.search_id} offers=${offers.length} offer_id=${offerId}`);

  const bookingBody = {
    search_id: search.data.search_id,
    offer_id: offerId,
    idempotency_key: `tapi-sandbox-${randomUUID()}`,
    contact_email: 'tapi.sandbox@example.invalid',
    passengers: [{
      given_name: 'Tapi',
      family_name: 'Sandbox',
      born_on: '1990-04-11',
      gender: 'm',
      email: 'tapi.sandbox@example.invalid',
      phone_number: '+2348012345678',
      phone_country: 'NG',
      nationality: 'NG',
      passenger_type: 'adult',
      passport_number: 'A12345678',
      passport_country: 'NG',
      passport_expiry: '2032-04-11',
      passport_issue: '2022-04-11',
    }],
    want_seat: WANT_SEAT,
    sandbox: { scenario: SCENARIO, speed: SPEED },
  };
  const started = await request('POST', '/flights/book', bookingBody);
  if (!started.ok) {
    const expected = (SCENARIO === 'payment_declined' && started.status === 402)
      || (SCENARIO === 'payment_method_required' && started.status === 402)
      || (SCENARIO === 'temporarily_unavailable' && started.status === 503);
    if (expected) {
      console.log(`EXPECTED_SCENARIO_RESPONSE status=${started.status} body=${JSON.stringify(started.data)}`);
      return;
    }
    throw new Error(`Sandbox booking start failed (${started.status}): ${JSON.stringify(started.data)}`);
  }
  const bookingId = started.data.booking_id;
  if (!bookingId) throw new Error(`Booking response omitted booking_id: ${JSON.stringify(started.data)}`);
  console.log(`BOOKING_ACCEPTED booking_id=${bookingId} state=${started.data.state || 'unknown'}`);

  const deadline = Date.now() + MAX_WAIT_MS;
  let lastState = null;
  let answered = new Set();
  while (Date.now() < deadline) {
    const poll = await request('GET', `/flights/bookings/${encodeURIComponent(bookingId)}`);
    if (!poll.ok) throw new Error(`Booking poll failed (${poll.status}): ${JSON.stringify(poll.data)}`);
    const b = poll.data;
    if (b.state !== lastState) {
      lastState = b.state;
      console.log(`BOOKING_STATE ${b.state} terminal=${Boolean(b.terminal)} manual_booking=${Boolean(b.manual_booking)}`);
    }
    if (b.question && !answered.has(b.question.round)) {
      const q = b.question;
      let answer;
      if (q.kind === 'price_change') answer = { round: q.round, confirm: true };
      else if (q.kind === 'extra' || q.kind === 'seat') answer = { round: q.round, skip: true };
      else throw new Error(`Unknown supplier question kind: ${q.kind}`);
      console.log(`ANSWERING_QUESTION kind=${q.kind} round=${q.round} action=${answer.confirm ? 'confirm' : 'skip'}`);
      const result = await request('POST', `/flights/bookings/${encodeURIComponent(bookingId)}/answer`, answer);
      if (!result.ok) throw new Error(`Question answer failed (${result.status}): ${JSON.stringify(result.data)}`);
      answered.add(q.round);
    }
    if (b.terminal === true || ['completed', 'failed', 'needs_attention'].includes(b.state)) {
      console.log(`BOOKING_TERMINAL ${JSON.stringify({ state: b.state, pnr: b.pnr || null, manual_booking: Boolean(b.manual_booking), charged_amount: b.charged_amount ?? null, currency: b.currency || null, failure_reason: b.failure_reason || null, decline_reason: b.decline_reason || null })}`);
      if (SCENARIO === 'success' && (b.state !== 'completed' || !b.pnr)) throw new Error('Success scenario did not complete with a PNR.');
      if (SCENARIO === 'seller_failed' && (b.state !== 'needs_attention' || b.manual_booking !== true)) throw new Error('seller_failed scenario did not hand off to manual fulfilment as documented.');
      if (SCENARIO === 'needs_attention' && b.state !== 'needs_attention') throw new Error('needs_attention scenario did not enter needs_attention.');
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`Timed out after ${MAX_WAIT_MS}ms waiting for booking ${bookingId}. Last state: ${lastState}`);
}

main().catch((err) => {
  console.error(`SANDBOX_SMOKE_FAILED: ${err.message}`);
  process.exitCode = 1;
});
