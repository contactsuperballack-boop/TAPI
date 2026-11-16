# TAPI — Go-Live Checklist

**Purpose:** get from "codebase on disk" to "confidently knowing what actually works against real
LetsFG data," in order of risk. Search first — no money involved, worst case is wrong/empty
results. Booking last — real reservations and (eventually) real charges are on the line.

Check things off as you go. Where something fails, the relevant file/line is named so you're
not hunting for it.

---

## Phase 0 — Prerequisites

- [ ] Node.js 18+ installed
- [ ] A real PostgreSQL instance (local `docker run postgres` is fine to start)
- [ ] A LetsFG account. **Decide PFS vs. Developer API mode now** — don't straddle both:
  - PFS: free, Bearer token, no `unlock()` step, but **hotels are not available on this path**
    (see `letsfgHotelAdapter.js` — it throws at construction if `authMode !== 'developer'`)
  - Developer API: paid credits, `unlock()` required before flight booking, required for hotels

---

## Phase 1 — Environment stands up

- [ ] `npm install` — this also finally generates a **real lockfile**, which never existed
      before (the phantom `letsfg` dependency was removed in the last hardening pass, so this
      should now succeed where it previously couldn't)
- [ ] `cp .env.example .env` and fill in `DATABASE_URL`
- [ ] Set `LETSFG_AUTH_MODE`, `LETSFG_BEARER_TOKEN` or `LETSFG_API_KEY` per your Phase 0 decision
- [ ] `npm run migrate` — confirm all **11 migrations** apply cleanly in order (001 through 011).
      This number has drifted before as migrations were added — if it's wrong again, check
      `src/db/migrations/` directly rather than trusting this line.
- [ ] `npm run seed` — prints a working API key; export it as `TAPI_API_KEY`
- [ ] `npm start`
- [ ] `curl localhost:3000/healthz` → `{"status":"ok"}`
- [ ] `curl localhost:3000/readyz` → `{"status":"ready","database":"connected"}` — if this
      fails, fix DB connectivity before anything else

---

## Phase 2 — Flight search (start here, lowest risk)

No money, no reservations — this is the safest place to find out what's actually true about
LetsFG's API vs. what the code assumed.

- [ ] `npm run cli -- search --origin LOS --destination LHR --depart 2026-12-01`
- [ ] Confirm you get back `{ searchId, status: "processing" }`
- [ ] `npm run cli -- poll <searchId>` — repeat until `status` leaves `"processing"`
- [ ] **Time it.** `letsfgAdapter.js` polls every 10s for up to 100s
      (`POLL_INTERVAL_MS`/`POLL_TIMEOUT_MS`). If real LetsFG search regularly takes longer,
      raise `POLL_TIMEOUT_MS` — a search that's still legitimately processing at 100s currently
      surfaces as a timeout error.
- [ ] Confirm the `offers` array has real, sane-looking data (actual airline names, plausible
      prices) — not empty, not garbage. If empty: check `normalizeOffer()` in
      `letsfgAdapter.js` against the actual raw response shape; field names there were
      best-effort from public docs, not confirmed.
- [ ] If using PFS mode: confirm `/api/search` + `/api/results/<id>` are the right paths
- [ ] If using Developer mode: confirm `/developers/api/v1/flights/search/async` +
      `/developers/api/v1/flights/search/<id>` are right, **and** try `resolveLocation()`
      (`/flights/parse-query`) — this only works in Developer mode by design (see the adapter's
      module header) and was never confirmed against a live response

---

## Phase 3 — Hotel search

Requires `LETSFG_AUTH_MODE=developer` and `LETSFG_API_KEY` set (Phase 0).

- [ ] `npm run cli -- hotel-search --destination Lagos --check-in 2026-12-01 --check-out 2026-12-05`
- [ ] `npm run cli -- hotel-poll <searchId>` until it resolves
- [ ] **This is the least-confirmed part of the whole codebase.** Per `letsfgHotelAdapter.js`'s
      header, only the booking-status *poll* endpoint was confirmed from LetsFG's own docs —
      destination resolution, search initiation, and the offer shape are best-effort guesses at
      LetsFG's `/developers/api/v1/{product}/{action}` convention. If this 404s or returns
      something unexpected, that's expected-to-need-fixing, not a sign something else is wrong.
- [ ] Once you find the real paths/shapes, they only need updating in one file:
      `src/services/adapters/letsfgHotelAdapter.js`

---

## Phase 4 — Offer detail & validation (still no money)

- [ ] `GET /v1/flights/offers/{offerId}` — matches what search returned?
- [ ] `POST /v1/flights/offers/{offerId}/validate` — in PFS mode this just re-fetches the offer;
      in Developer mode it calls `unlock()` (rate-limited 20/min per LetsFG's SDK notes) — watch
      for rate-limit errors if you validate offers in a tight loop while testing
- [ ] Same two checks for hotels — `validate` here calls the "rate recheck" endpoint, which
      LetsFG's docs say is required when `rate_type=RECHECK`. The adapter currently calls it
      unconditionally since offer payloads don't yet reliably expose rate type — confirm
      whether that's actually necessary for every offer or only some.

---

## Phase 5 — Booking (only after Phases 2–4 look right — this is where real reservations happen)

**Use LetsFG's sandbox mode if at all possible before a real booking.** Developer API docs
mention `/developers/api/v1/sandbox/flights/*` (free, fake data, same schema) — confirm whether
an equivalent exists for hotels before testing hotel booking.

- [ ] `npm run cli -- book --offer <offerId> --idempotency-key test-1`
- [ ] **The single most important thing to check:** what does the response actually contain?
  - A real PNR → `mapBookingState()` correctly returns `confirmed`
  - A `booking_url` with no PNR → correctly returns `action_required` — confirm your frontend/agent
    actually knows what to do with that URL
  - Neither → stays `pending`, which is correct per the mapper, but means you've found a real
    supplier response shape the code doesn't recognize yet — update `letsfgAdapter.js`'s `book()`
    field mapping
- [ ] Deliberately trigger a timeout (e.g. temporarily point `LETSFG_BASE_URL` at something
      that hangs) and confirm the booking lands in `reconciliation_required`, not `failed` —
      this is the fix from the last hardening round; worth confirming it actually behaves that
      way against a real slow/hanging response, not just the mocked tests.
- [ ] `npm run cli -- keys-list` style retrieval: `GET /v1/flights/bookings/{id}` — confirm
      reconciliation against the supplier (`getBooking()`) actually resolves a `pending` booking
      once LetsFG's side is done
- [ ] Hotels: confirm the async job lifecycle end to end —
      `npm run cli -- hotel-booking-status <bookingId>` should eventually show
      `confirmationNumber`, `payLink`, and `balanceDueBy` once LetsFG's job succeeds
- [ ] **Do not test cancellation against a real paid booking.** Use `?simulate=true` first
      (`POST /v1/hotels/bookings/{id}/cancel?simulate=true`) to preview the refund without
      committing.

---

## Phase 6 — Orders & payments (logic-only until a real provider exists)

The order/pricing/webhook *logic* is fully testable right now against `MockPaymentProvider` —
this validates TAPI's own state machine, not real money movement. Don't confuse "this works"
here with "this is production-ready for real payments."

- [ ] `npm run cli -- order-create --booking <bookingId> --idempotency-key order-1` — only works
      on a `confirmed` booking
- [ ] `npm run cli -- order-pay <orderId> --idempotency-key pay-1` — returns a mock checkout URL
- [ ] Manually POST a signed webhook (see `tests/orders.test.js`'s `signWebhook()` helper for the
      HMAC scheme) and confirm the order flips to `paid`
- [ ] Do **not** point this at a real payment provider without treating that as its own
      integration project — `MockPaymentProvider`'s webhook scheme is not any real provider's
      actual scheme (stated in its own file header)

---

## Phase 7 — Run the test suite for real

None of `tests/*.test.js` were ever executed against a real database — only pure-logic pieces
(`bookingState.test.js`, the rate limiter, the pricing math) were verified standalone.

- [ ] `TEST_DATABASE_URL=postgres://... npm test`
- [ ] Expect some failures on first run — that's the point of running it. Fix forward.
- [ ] Once passing, this becomes your regression net for everything above

---

## Phase 8 — Before any real customer traffic

- [ ] Rotate `TAPI_TOKEN_SECRET` and `MOCK_PAYMENT_WEBHOOK_SECRET` to real random values —
      the `.env.example` defaults are dev-only and say so
- [ ] Set `ALLOWED_ORIGINS` to your actual frontend domain(s)
- [ ] Remember: rate limiting (`middleware/rateLimiter.js`) is **in-memory, single-instance
      only** — fine for one server, will under-enforce the moment you run more than one
- [ ] Check `audit_events` is actually populating as you test (`SELECT * FROM audit_events
      ORDER BY created_at DESC LIMIT 20`) — confirms the audit logging added in the last round
      is wired correctly against real traffic, not just the mocked tests
- [ ] Generate `package-lock.json` for real now that `npm install` can succeed, and commit it —
      no other developer or CI runner can reliably install this until that exists

---

## What to report back

For each phase, the useful signal is: **exact request/response, not just pass/fail.** If hotel
search 404s, the actual response body tells us whether it's a wrong path (easy fix) or a wrong
auth scheme (bigger fix). Bring back real payloads, not summaries — that's what turns the
`UNVERIFIED` comments throughout the adapters into confirmed, correct code.
