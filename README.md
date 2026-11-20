# TAPI — MVP Scaffold (Sprints 0–2)

This is a working codebase for the vertical slice defined in the Engineering Backlog:
agency authenticates → resolve location → search → offer → validate → book → persist →
retrieve — for **both flights and hotels** now, via LetsFG, our first live supplier.

It intentionally does **not** include payments/orders beyond the schema shell, CLI/MCP
tooling beyond smoke tests, or the multi-supplier aggregation engine — those are Sprints
3–5 and, in the aggregation engine's case, still pending the Product Owner Decision Gate.
See `TAPI_Master_Product_Document.docx` for the full roadmap.

## What's here

```
src/
  app.js                    Express app + middleware wiring (incl. rate limiting)
  server.js                 entry point + graceful shutdown
  db/
    migrations/
      001_init.sql                                   full schema
      002_booking_state_and_idempotency_scope.sql     pre-hardening fixes
      003_hotel_booking_details.sql                   Sprint 2: pay-link/reservation-fee tracking
      004_api_keys_and_booking_race_safety.sql        API-key lifecycle + checkout_url + request_hash
      005_domestic_supplier_evaluation.sql            Sprint 3 scaffold: candidate tracking, no adapter
      006_orders_and_payments.sql                     Sprint 4: pricing breakdown, payment tenant-scoping
      007_beta_hardening_fixes.sql                    reconciliation_required + checkout_url on payments
      008_booking_state_machine.sql                   full state machine + transition audit table
    migrate.js               migration runner
    seed.js                  creates a dev agency + API key (via ApiKeys service)
  domain/
    errors.js                RFC 7807-style error contract
    bookingState.js          supplier-status -> canonical status mapper (mapBookingState, classifyBookingFailure)
    bookingStateMachine.js   explicit states, guarded transitions, terminal-state checks
    pricing.js               config-driven order markup/fee calculation
    piiRedaction.js          redacts traveler PII before persisting to audit records
  middleware/
    auth.js                  API-key -> tenant context, expiry/revocation checks, last-used tracking
    idempotency.js
    rateLimiter.js            token-bucket, per-IP and per-tenant, test-environment bypass
    auditLog.js               writes to audit_events — auth failures + mutating requests
    requestContext.js         correlation IDs + structured JSON request logs
    requestTimeout.js         bounds client wait on a hung request (does not cancel underlying work)
    errorHandler.js
  validation/schemas.js     zod request schemas (flights + hotels + api-keys + orders)
  services/
    apiKeys.js                key generation, hashing, lifecycle
    flightSupplier.interface.js
    hotelSupplier.interface.js
    paymentProvider.interface.js
    supplierRegistry.js      lazy, memoized construction; LetsFG (flights+hotels) + domestic scaffold
    paymentProviderRegistry.js
    adapters/
      letsfgClient.js         shared auth/request logic
      letsfgAdapter.js         flights
      letsfgHotelAdapter.js    hotels
      nigerianDomesticAdapter.js  scaffold only — every method throws NOT_READY
      mockPaymentProvider.js  dev/test only, not a real provider
  routes/
    auth.routes.js            API-key create/list/revoke
    flights.routes.js
    hotels.routes.js
    orders.routes.js          orders, payment initiation, refund
    payments.routes.js        provider webhook (raw body, signature-verified, not agency-authed)
  mcp/
    server.js                 MCP stdio server — unverified against a live SDK install, see Sprint 5
    tools.js                  the 8 tools from Master Spec §14
    tapiClient.js              MCP's HTTP client to TAPI's own API
  scripts/
    reconcile.js               single-pass reconciliation script — see README section above
  cli/index.js               tapi search / poll / book / hotel-* / keys-* / order-* / smoke-test
tests/
  setup.js                   resets a throwaway test DB, seeds a test agency, closeDb() for open-handle cleanup
  bookingState.test.js       pure unit tests, no DB required
  bookingStateMachine.test.js  pure unit tests, no DB required — every assertion also verified directly
  flights.test.js
  hotels.test.js
  apiKeys.test.js
  orders.test.js
  mcpTools.test.js           MCP tool logic against a mocked TAPI API, no DB or MCP SDK required
openapi.yaml                 frozen /v1 contract for everything actually implemented
RUNBOOK.md                  operational procedures for the states this codebase can actually produce
GO_LIVE_CHECKLIST.md        sequenced, risk-ordered validation steps against real LetsFG credentials
.github/workflows/ci.yml    basic CI — install, migrate, test, against a real Postgres service container
```

## Setup

```bash
npm install
cp .env.example .env        # fill in DATABASE_URL and LetsFG credentials
npm run migrate
npm run seed                # prints a dev API key — export it as TAPI_API_KEY
npm start
```

Smoke test flights end to end:
```bash
npm run cli -- smoke-test --origin LOS --destination LHR --depart 2026-11-10
```

Hotel commands (Developer API key required — see below):
```bash
npm run cli -- hotel-search --destination Lagos --check-in 2026-12-01 --check-out 2026-12-05
npm run cli -- hotel-poll <searchId>
npm run cli -- hotel-book --offer <offerId> --idempotency-key <key>
npm run cli -- hotel-booking-status <bookingId>
```

API-key management:
```bash
npm run cli -- keys-create --label "backend service" --expires-in-days 90
npm run cli -- keys-list
npm run cli -- keys-revoke <clientId>
```

Orders & payments (mock provider only — see Sprint 4 below):
```bash
npm run cli -- order-create --booking <bookingId> --idempotency-key <key>
npm run cli -- order-get <orderId>
npm run cli -- order-pay <orderId> --idempotency-key <key>
npm run cli -- order-refund <orderId> --idempotency-key <key>
```

Run tests (needs a real Postgres — `bookingState.test.js` is the one exception, pure logic,
no DB required):
```bash
TEST_DATABASE_URL=postgres://... npm test
```

## ⚠️ Before this touches a real booking

### Flights
Two things in the LetsFG flight adapter are marked **unverified** in code comments and must
be confirmed against LetsFG's sandbox before beta — this mirrors Backlog T-062/T-063/T-064
("do not proceed on screenshots or claims alone"):

1. **Auth path.** Pick one of `LETSFG_AUTH_MODE=pfs` (free, Bearer token, no unlock step)
   or `developer` (paid credits, `unlock()` required before `book()`). Don't straddle both.
2. **What `book()` actually returns.** LetsFG's own materials describe results including a
   direct airline `booking_url` ("no checkout, no concierge fee") alongside — or possibly
   instead of — a server-side booking call that returns a PNR. The adapter and routes handle
   both shapes explicitly: a PNR maps to `confirmed`, a `booking_url` with no PNR maps to
   `action_required` — but the actual behavior needs sandbox confirmation.

### Hotels (Sprint 2 — more unverified surface area than flights)
LetsFG's public docs confirm hotels are **more documented on the booking/poll side than the
search/book side**. Specifically:

- **CONFIRMED**: `GET /developers/api/v1/hotels/booking/<id>` for polling job status, pay
  link, and balance-due date. Hotels are Developer-API-only (no free/PFS path) — `LETSFG_API_KEY`
  is required. A card must be on file for search *and* booking. A rate recheck
  (`rate_type=RECHECK`) is required before booking for at least some offers.
- **UNVERIFIED**: the exact paths for destination resolution, search initiation, and the
  book() call itself. `letsfgHotelAdapter.js` follows LetsFG's established
  `/developers/api/v1/{product}/{action}` convention from the flights side, but none of these
  three have been confirmed against a live response. **Do not attempt a real hotel booking
  until these are checked against sandbox.**
- The 5%-now/95%-via-pay-link payment model is LetsFG's own (Stripe-based), separate from
  TAPI's own customer-facing payment provider (that's Sprint 4). `hotel_booking_details`
  tracks `reservation_fee_status` and `balance_due_by` specifically so this can be
  reconciled later without digging through raw JSON.

## Corrections applied (pre-hardening review, before Sprint 2)

A review before Sprint 2 flagged several issues, all now fixed:

**P0**
- Fixed a real column/value misalignment bug in the offer-insert SQL (`repositories/index.js`)
  — the `'flight'` literal was landing in the `agency_id` column slot instead of `type`.
- Booking status is no longer set to `confirmed` just because `book()` returned without
  throwing. The route now inspects what the supplier actually said (PNR present vs.
  `booking_url` handoff vs. unrecognized) and maps to an explicit status.
- Added a real `action_required` booking state (migration 002) for supplier flows that hand
  back a checkout URL instead of a synchronous confirmation, alongside
  pending/confirmed/failed/cancelled/price_changed.

**P1**
- Polling a search that already completed now returns its persisted offers
  (`Offers.listBySearchId`) instead of an empty response.
- Idempotency keys are now scoped to `(agency_id, idempotency_key)`, not globally unique —
  migration 002 changes the constraint, and the lookup/route code matches it.
- Added explicit request validation via `zod` (`src/validation/schemas.js`) on the search and
  booking endpoints, replacing ad-hoc field checks.
- Added `openapi.yaml`, frozen against what's actually implemented — extend it in the same
  commit as any route change, not after.
- Added an integration test suite (`tests/flights.test.js`) covering auth, tenant isolation,
  search, offer persistence/expiry, booking, idempotency (including the cross-tenant
  regression case), supplier failure, and booking state — including regression tests for the
  two P0 bugs above so they can't silently come back.

**Honesty note on the tests:** this sandbox has no network access and none of `jest`,
`supertest`, or a Postgres instance are installed here, so I wrote these tests carefully by
tracing the code paths but have **not** been able to execute them. Run `npm install && npm test`
against a real `TEST_DATABASE_URL` before trusting them — treat "written" and "passing" as
different claims until you've run them yourself. This applies to `tests/hotels.test.js` as well.

## Sprint 2 — Hotels

- `HotelSupplier` interface (`resolveDestination`, `search`, `pollSearch`, `getOffer`,
  `validateOffer`, `book`, `getBooking`, `cancel`) — mirrors `FlightSupplier`'s shape.
- `letsfgHotelAdapter.js` implementing it. Booking is **always async**: `book()` only starts
  a job (`booking_job_id`); the caller must poll `GET /hotels/bookings/:id` until the status
  resolves. Booking status is never set to `confirmed` without a real `confirmation_number`
  from a `succeeded` poll — same principle as the P0-2 fix on flights.
- `hotel_booking_details` table (migration `003`) tracking `pay_link`, `balance_due_by`,
  `reservation_fee_status`, and `cancellation_terms` as first-class queryable fields, not
  buried in `supplier_bookings.raw_response` — this is what T-057 (reconciliation) needs.
- Cancellation supports LetsFG's confirmed `simulate=true` mode to preview a refund without
  actually cancelling.
- Generalized `Offers.bulkInsert` and `Bookings.create` (previously flight-only in practice,
  hardcoded `'flight'` in one SQL literal) to take an explicit `type` — hotels reuse the same
  `offers`/`bookings` tables by design, not a parallel schema.
- `tests/hotels.test.js` covers search, offer persistence, the full async booking-job
  lifecycle (pending → confirmed / pending → failed / still-processing), idempotency
  (no double-booking-call on a repeated key), and cancellation (including the "can't cancel
  a non-confirmed booking" and "simulate doesn't mutate state" cases).

## Sprint 2.5 — API-key lifecycle, booking-state mapper, race-safety, rate limiting

### API-key lifecycle (`src/services/apiKeys.js`, `src/routes/auth.routes.js`)
- Secure generation: `crypto.randomBytes(32)`, format `tapi_<env>_<random>`.
- Only the SHA-256 hash is stored — the raw key is returned exactly once, at creation, and is
  not recoverable after that.
- `keyPrefix` (first 12 chars of the random portion, plus the `tapi_<env>_` prefix) is stored
  in plaintext for identification in listings — not enough entropy to reconstruct the key.
- `expiresAt`, `revokedAt`, `lastUsedAt` all tracked. `isActive` is derived (`status==='active'
  AND not expired`), so callers don't have to reimplement that logic.
- `last_used_at` writes are throttled (only updates if the previous touch was >60s ago) so a
  high-traffic key doesn't turn every request into an extra write.
- Routes: `POST /v1/auth/api-keys` (create), `GET /v1/auth/api-keys` (list — never exposes the
  hash or raw key), `POST /v1/auth/api-keys/:id/revoke`. Self-service, agency-scoped — an
  agency manages its own keys using an existing valid key. Bootstrapping the very first key
  per agency is still `seed.js` / an internal process, not a public route.

### Reusable booking-state mapper (`src/domain/bookingState.js`)
Single function, `mapBookingState({ rawStatus, reference, checkoutUrl })`, now used by **both**
flights and hotels instead of two separately-maintained if/else chains:
- A reference (PNR/confirmation number) always wins → `confirmed`, regardless of status string.
- A checkout URL with no reference → `action_required`.
- Otherwise, a synonym table: confirmed/booked/success/succeeded → `confirmed`;
  failed/error/rejected → `failed`; checkout_required/action_required → `action_required`;
  price_changed/repriced → `price_changed`; cancelled/canceled → `cancelled`.
- **Anything unrecognized → `pending`.** This is the core principle the mapper exists to
  enforce: a successful HTTP response is never itself treated as proof a booking exists.

This is the one part of this round I could actually execute and verify in this sandbox (pure
function, no DB/network) — see `tests/bookingState.test.js`, and I ran the equivalent checks
directly with `node -e` before writing the Jest version.

### Checkout URL persistence
`bookings.checkout_url` (migration 004) — previously `bookingUrl` only existed in the
immediate HTTP response object and was never stored, so a later `GET` or a reconciliation
pass had no way to recover it. Now persisted and read back through `toBookingResponse`.

### Race-safe idempotency (`Bookings.createOrGetExisting`)
The old flow was check-then-insert: look up the idempotency key, and if absent, insert. Two
concurrent requests with the same key could both pass the check before either committed,
and the loser would hit a raw unique-constraint error instead of getting the winner's booking
back. Fixed with `INSERT ... ON CONFLICT (agency_id, idempotency_key) DO NOTHING`, which makes
the insert itself the atomic decision point — whoever loses the race just re-fetches. Also
added `request_hash` (migration 004): if the same key is reused with a **materially different**
body, that's rejected with `422 IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY` instead of silently
returning a booking that doesn't match what was just sent.

### Rate limiting (`src/middleware/rateLimiter.js`)
Token-bucket, in-memory. A global per-IP limiter runs before `authenticate` (so cycling
through invalid keys can't bypass it), plus per-tenant limiters on `/v1/auth`, `/v1/flights`,
`/v1/hotels` after auth. **Honest limitation:** this is single-instance only — a
multi-instance deployment needs a shared store (Redis) or limits under-enforce across
instances. Said directly in code comments, not glossed over.

### What's still open (flagged, not fixed, in this round)
- **Supplier booking behavior is still unverified** for the reasons already documented above
  (auth mode, correct endpoints, sync vs. async, whether a PNR is always returned) — the
  mapper makes TAPI's *handling* of any of those outcomes correct, but doesn't resolve the
  underlying sandbox-verification work itself.
- **Search polling is still request-driven**, no background worker/queue. Acceptable for MVP;
  a production version needs background search jobs, retry policies, and dead-letter handling
  for supplier timeouts — not attempted here, scope creep beyond what was asked this round.

## Sprint 3 — Nigerian Domestic Supplier (scaffold only, per your instruction)

**This is not a working integration.** Per Backlog EPIC-07: *"No route is considered
supported from documentation alone."* There is no domestic supplier under contract — that's
still an open Product Owner Decision Gate item.

- `src/services/adapters/nigerianDomesticAdapter.js` — implements `FlightSupplier`, every
  method throws a clear `NOT_READY` error rather than pretending to work or returning fake
  data. Proves the interface generalizes to a second flight source without any route/domain
  code changes (the actual point of EPIC-04).
- Registered in `supplierRegistry.js` but only constructed if `DOMESTIC_SUPPLIER_ENABLED=true`
  — and even then, every call still throws. There is no env var that makes this real; that
  requires actual code once a supplier clears the Decision Gate.
- `domestic_supplier_candidates` table (migration `005`) + a `domestic_supplier_ready_for_implementation`
  view — a real place to track T-060/T-061 evaluation work (candidate suppliers, sandbox
  access, coverage tests, booking tests, commercial terms) so "are we ready to build this" is
  a query against real data, not a status update in a meeting.

## Sprint 4 — Orders & Payments

- **Pricing** (`src/domain/pricing.js`) — `supplier_cost`, `markup_amount`, `service_fee`,
  `tax_amount` are now separately represented on `orders` (migration `006`), matching Master
  Spec §13. Markup/service-fee are read from env (`ORDER_MARKUP_PERCENT`,
  `ORDER_SERVICE_FEE_FLAT`), not hardcoded — same "commercial judgment call belongs in config,
  not code" principle as market tiering. Defaults to 0 (pure cost-through) so nothing charges
  a markup nobody agreed to. Verified directly with `node -e` before wiring into routes.
- **Payment provider abstraction** (`src/services/paymentProvider.interface.js`,
  `adapters/mockPaymentProvider.js`) — no real provider (Paystack/Flutterwave/Stripe) has
  cleared the Decision Gate yet, so this follows the same pattern as the domestic supplier and
  market tiering: build the interface, plug in a real adapter later without touching route
  code. `MockPaymentProvider` is dev/test only, does not move real money, and is clearly
  labeled as such everywhere it appears. Its HMAC webhook-signature scheme is NOT any real
  provider's actual scheme — verified working with `node -e` (valid sig accepted, invalid
  rejected, missing rejected) before it went anywhere near a route.
- **Orders** (`routes/orders.routes.js`) — `POST /v1/orders` builds an order from one or more
  *confirmed* bookings only (a booking that's still `pending`/`action_required` can't be
  invoiced), rejects a booking already attached to another order, and is idempotent via the
  same atomic `createOrGetExisting` pattern used for bookings. The booking→order attachment
  itself is guarded against a concurrent-claim race (`WHERE order_id IS NULL`), though it's
  not a full transaction with rollback-on-partial-failure — a real limitation, stated rather
  than hidden.
- **Payment webhook** (`routes/payments.routes.js`) — the *only* code path that can mark a
  payment `captured`/`failed` or an order `paid`. Mounted with `express.raw()` **before** the
  global `express.json()` parser specifically so signature verification runs against the exact
  bytes the provider signed, not a re-serialized object. Rejects invalid signatures outright
  (`401`), is idempotent against duplicate deliveries, and the payment-capture + order-paid
  transition is wrapped in a real DB transaction (`db.withTransaction`) so the two writes
  can't partially land.
- **Refund** (T-076) — requires a `captured` payment; moves payment to `refunded` and order to
  `cancelled`. Does not yet cascade to cancelling the underlying hotel/flight booking with the
  supplier — that's a real gap, not addressed this round; flag it before this goes near a
  production refund.

## Second review — findings from an actual `npm test` run (58 passed, 22 failed, 4/6 suites)

This is the first review grounded in real execution rather than code inspection alone. Fixed:

- **Hotel booking 500s — found the actual cause.** `HotelBookingDetails.upsert()` was binding
  a JS *array* (`guests`) directly to a `jsonb` column parameter. `node-postgres` serializes
  arrays as native Postgres array literals, not JSON — it checks `Array.isArray()` before its
  generic-object JSON path, so this sent invalid input for a `jsonb` column and Postgres
  rejected it with a raw DB error, which isn't an `ApiError`, hence the bare 500. Fixed with an
  explicit `JSON.stringify(guests)`. **I could not execute this against a real Postgres to
  confirm it was THE cause** (no network/DB in this sandbox) — it's a high-confidence diagnosis
  based on documented `pg` serialization behavior and matches the symptom exactly, but it needs
  confirming on your next real test run, not taken on faith.
- **Fixed API-key tests crashing before running at all.** `supplierRegistry.js` constructed the
  LetsFG flight adapter *eagerly, at module load*, unconditionally — its constructor throws
  synchronously if required env vars are missing. Any test with nothing to do with suppliers
  (like `apiKeys.test.js`, which never sets LetsFG credentials) crashed on `require("../src/app")`
  before a single test ran. Construction is now lazy and memoized — a supplier is only built the
  first time something actually asks for it, and misconfiguration now surfaces as a proper `503
  SUPPLIER_NOT_CONFIGURED` on that specific request instead of a process crash on load.
- **Fixed rate limiting interfering with test assertions.** The rate-limiter's buckets are
  module-level and persist for the process lifetime; dozens of test cases hitting the same
  tenant within one suite exhausted real limits partway through, so later tests got `429`
  instead of the validation/business-logic response they were actually asserting on — a
  test-harness problem, not a product bug. `DISABLE_RATE_LIMIT=true` is now set centrally in
  `tests/setup.js` (every test file imports it before requiring `app`), plus an exported
  `resetBuckets()` for any future test that wants to verify rate-limiting behavior specifically.
- **Fixed leaked database connections ("open async handles").** `tests/setup.js`'s `seedAgency()`
  created a brand-new, never-closed connection pool on *every call* — and it's called multiple
  times per suite (once per agency needed for isolation tests). Now uses the shared `db` module
  instead of throwaway pools, and every test file now has an `afterAll` that closes the shared
  pool (`closeDb()`), which nothing was doing before.
- **Both `getSupplier()`/`getHotelSupplier()` threw plain `Error`, not `ApiError`** — any
  supplier misconfiguration became an opaque 500 instead of a diagnosable, correctly-coded
  response. Fixed alongside the lazy-construction change above.

**Independent database/environment setup per suite:** already handled by the existing
`--runInBand` (serializes test *files*, avoiding cross-file DB stomping) combined with Jest's
own per-file module registry isolation and each file's `resetDatabase()`. No further change
needed here specifically — flagging it as already-addressed rather than silently agreeing it
was a gap.

### What's still genuinely unresolved (stated, not fixed)

- **Sandbox verification for all 10 listed endpoints** (flight offer/booking/polling/cancel,
  hotel search/recheck/booking/polling/cancel/voucher) — still needs real LetsFG credentials
  and network access this sandbox has never had. See `GO_LIVE_CHECKLIST.md`.
- **Reconciliation for `reconciliation_required` bookings is entirely manual right now** — see
  the new `RUNBOOK.md` for the actual procedure. No automated worker, no supplier-status
  polling loop, no dead-letter handling, no alerting. The state is correctly detected; nothing
  automated resolves it yet.
- **Payment provider maturity** — still `MockPaymentProvider`. Real provider integration,
  provider event deduplication, and durable payment-state transitions under provider/network
  failure all remain open.
- **CI, monitoring, alerting, backup/restore verification** — a basic CI workflow
  (`.github/workflows/ci.yml`) and operational runbook (`RUNBOOK.md`) are now added; real APM,
  alerting, and a tested backup/restore procedure are not — those need infrastructure decisions
  (which provider, what budget) this sandbox can't make for you.
- **Request timeout is added but incomplete.** `middleware/requestTimeout.js` (default 30s)
  bounds what the *client* waits for, but does not actually cancel a hung outbound `fetch()` to
  LetsFG — no `AbortController` threading exists yet. Stated plainly in the file itself.

### On the "limited beta only" framing

Agreed, and worth restating as the explicit operating constraint rather than an implied one:
this system should not accept unrestricted real reservations or payments yet. A limited beta —
sandbox/test supplier accounts, no unattended production reservations, manual monitoring and
reconciliation of bookings, a non-production payment provider, adjusted rate limits, and a
deliberately restricted set of supported routes — is the right shape for a first real trial.
The biggest blockers remain exactly what was named: supplier verification, hotel booking
reliability, payment-provider maturity, and operational recovery. Nothing in this round changes
that assessment — it fixes specific bugs that were blocking even a limited beta from running
cleanly, it doesn't clear the path to unrestricted production use.

## Production-hardening roadmap (11-point review) — what was executed vs. deferred

An 11-section production-readiness review came in covering the booking state machine,
reconciliation workers, shared infrastructure, supplier contract tests, payment integrity, test
suite maturity, security/governance, observability, performance, and API/agency experience.
This is genuinely too large to execute in full — several sections need real infrastructure
(Redis, a job queue, an APM vendor, a chosen payment provider) this sandbox doesn't have.
Triaged and executed the highest-value, actually-buildable subset:

### Booking state machine (explicitly named highest-value — built in full)

`domain/bookingStateMachine.js` replaces the previous ad-hoc status strings with:
- **13 explicit states** — merged the review's proposed list with what already existed and was
  meaningful (`price_changed`, `action_required` — real LetsFG behaviors, not invented):
  `created`, `pending`, `processing`, `confirmed`, `action_required`, `price_changed`, `failed`,
  `reconciliation_required`, `cancel_requested`, `cancelled`, `refund_pending`, `refunded`,
  `refund_failed`.
- **A guarded transition table.** Every status change goes through `assertValidTransition()` —
  illegal transitions throw instead of silently happening. Backwards transitions, transitions
  out of terminal states, and transitions that skip required intermediate steps (e.g.
  `confirmed` → `refunded` directly, without `cancel_requested`/`refund_pending`) are all
  rejected. Verified with a structural self-check (every transition target is a real state,
  every non-terminal state has a way out) plus explicit positive/negative transition tests —
  ran all of this directly before trusting it, not just written and assumed correct.
- **Guard rule enforced in code, not convention:** a booking cannot reach `confirmed` without a
  real supplier reference — `requiresSupplierReference()` is checked inside the same transaction
  as the status update itself.
- **`booking_state_transitions` audit table** (migration 008) — every transition, automated or
  manual, is recorded with `actor`, `reason`, and `metadata`, atomically with the status change
  (`db.withTransaction`, row-locked with `FOR UPDATE` against concurrent transitions). This is
  what makes "manual operator intervention is recorded and auditable" actually true — see
  `RUNBOOK.md` for the operator-facing procedure using this exact mechanism.
- **Refund states now propagate to the booking, not just the payment/order** — a real gap found
  while wiring this in: the order-level refund flow updated `payments.status`/`orders.status`
  but never touched the underlying booking, which would have stayed `confirmed` forever even
  after being refunded. Fixed: `confirmed → refund_pending` (before calling the provider) →
  `refunded` or `refund_failed` depending on outcome.
- **Payment-capture guard** ("a payment cannot be captured for a failed or cancelled booking"):
  `Payments.markCapturedAndOrderPaid()` now checks every booking under the order before
  capturing, inside the same row-locked transaction — a booking that drifted to
  cancelled/refund_* between order creation and webhook delivery blocks the capture with a
  distinct `409 BOOKING_NOT_CAPTURABLE`, not a bare 500 and not silently captured anyway.
- **Provider-event dedup groundwork**: `provider_event_id` (existed since migration 007, unused
  until now) is now actually populated and uniqueness-enforced, belt-and-suspenders alongside
  the existing status-based idempotency check.
- **A real bug caught and fixed before shipping:** the first draft of the refund handler checked
  `booking.status` against a stale, once-fetched in-memory value that never updated after the DB
  transition — meaning the post-refund and refund-failure branches would never fire correctly.
  Caught this by re-reading my own diff rather than assuming it worked; fixed by tracking
  transitioned booking IDs explicitly instead of re-checking stale local state.

### Reconciliation (single-pass script, explicitly not a durable worker)

`npm run reconcile` (`src/scripts/reconcile.js`) — finds bookings stuck past a threshold
(`RECONCILE_STUCK_THRESHOLD_MINUTES`), and for `reconciliation_required` bookings with a
supplier reference, asks the supplier directly using the exact same adapter methods the API
routes use. Resolves what it can, flags what it can't, records every attempt in
`booking_state_transitions`/`audit_events`. **Its own file header states plainly what this is
NOT:** no job queue, no distributed locking, no dead-letter handling, no alerting. Meant for
external scheduling (cron/CronJob), not a background process — running two instances
concurrently could double-process. This is a real first step, not the reconciliation
architecture the full review envisions.

### What's still genuinely deferred — stated, not attempted

- **Shared/distributed infrastructure** (Redis-backed rate limiting, durable job queue, shared
  cache, distributed locks) — needs a real Redis instance and a scale-out decision this repo
  can't make. The in-memory rate limiter's single-instance limitation is unchanged.
- **Supplier contract test suite against a real sandbox** — still blocked on network/credentials,
  same as every round before this one. See `GO_LIVE_CHECKLIST.md`.
- **Circuit breakers, per-supplier health checks, supplier-specific rate limits** — not built
  this round; real scope, not attempted alongside everything else here.
- **A real payment provider**, provider-side refund idempotency, chargeback/dispute handling —
  still blocked on the Decision Gate; `MockPaymentProvider` remains dev/test only.
- **100% test pass rate as a target** — deliberately not chased. This round adds real coverage
  (state machine, refund propagation, capture guard) but "100%" isn't meaningful until the
  suite has actually been run against a real Postgres, which this sandbox still can't do.
- **Contract tests** (OpenAPI response validation, supplier response schemas, MCP tool schemas)
  and **end-to-end test scenarios** (search→book→pay→webhook, timeout→reconciliation→final
  status) — real, valuable, not built this round given everything else in scope.
- **Security/governance beyond what's already done** — SAST/dependency/secret scanning in CI,
  API-key scopes and per-agency quotas, webhook replay protection, encryption-at-rest for
  traveler PII, documented incident response — all need either a tooling/vendor decision or
  meaningfully more time than fits alongside the state machine work.
- **Observability dashboards, alerting, and performance work** — explicitly out of scope until
  correctness is proven (the review's own §10 makes this point), and dashboards/alerting need
  an APM vendor decision regardless.
- **SDKs, sandbox credentials for agencies, API versioning policy beyond `/v1`** — real product
  work, not attempted this round.

## Sprint 5 — MCP + Beta Hardening

### MCP server (`src/mcp/`)
The eight tools listed in Master Spec §14 — no more: `search_flights`, `get_flight_offer`,
`book_flight`, `search_hotels`, `get_hotel_offer`, `book_hotel`, `get_booking`,
`cancel_booking`. `cancel_booking` is hotel-only — flights have no cancellation endpoint in
the approved MVP API surface, so a tool that pretended to support it would be worse than not
offering one.

- **MCP calls TAPI's own HTTP API, never a supplier directly** (`src/mcp/tapiClient.js`) —
  per Master Spec §14 ("MCP must not contain supplier-specific business rules"). One MCP
  server process = one agency, configured via `TAPI_API_KEY` at startup, not per-call.
- **T-097 (authorization/audit) is inherited, not reimplemented.** Because every tool call is
  just an authenticated REST request, MCP automatically gets the same tenant isolation, rate
  limiting, and (new this round) audit logging as any other client — see below.
- **Search tools poll internally** (bounded, ~60s ceiling) so an LLM gets a final offers list
  in one tool call rather than needing to understand TAPI's async search/poll pattern itself.
- **Idempotency keys are auto-generated when the LLM doesn't supply one**, and the tool
  descriptions explicitly instruct reusing the same key to retry rather than generating a new
  one — this matters more here than in a typical REST client, since an LLM has no built-in
  instinct for "don't just call it again."
- **What I actually verified vs. what I couldn't:** the tool *logic* — schemas, request
  wiring, the search poll loop, idempotency-key injection, error-code passthrough — is fully
  tested (`tests/mcpTools.test.js`) against a mocked TAPI API, and I ran it directly with
  `node -e` before writing the Jest version. **What I could NOT verify:** whether
  `src/mcp/server.js` actually speaks the MCP protocol correctly over stdio.
  `@modelcontextprotocol/sdk` was never installed in this sandbox (no network), so the import
  paths and request-handler API in `server.js` match the SDK's documented pattern from
  training knowledge, not a confirmed working install. Same discipline as the LetsFG
  adapters: **run `npm install && npm run mcp` and check it actually starts before pointing a
  real MCP client at this.**

### Audit logging — a real gap found and fixed, not MCP-specific
While building MCP's T-097 story, found that `audit_events` has existed in the schema since
migration 001 but **nothing ever wrote to it** — every client, REST or MCP, was equally
un-audited. Fixed centrally, not as an MCP workaround:
- `middleware/auditLog.js` — logs every mutating request (`POST`/`PUT`/`PATCH`/`DELETE`) after
  it completes, with actual outcome (status code), plus every authentication failure
  (missing/invalid/revoked/expired key) with the reason.
- Wired into `app.js` at the same mount points as the rate limiters — MCP inherits this
  automatically since it hits the same routes.

### Correlation IDs + structured logging (Master Spec §19)
- `middleware/requestContext.js` — every request gets a correlation ID (`X-Correlation-Id`,
  generated or passed through), one structured JSON log line per request on completion, and
  error responses now include `correlationId` so a client-reported error can be traced back to
  server-side logs. This is a starting point for real log aggregation, not the full
  observability stack — no APM/log pipeline exists here to send these lines to.

### Readiness check (Master Spec §19)
- `GET /readyz` — actually checks database connectivity (`SELECT 1`), distinct from
  `/healthz` (process is up). A load balancer/orchestrator should route on `/readyz`; a process
  that's running but can't reach Postgres isn't ready to serve traffic.

## Beta-hardening review (12 findings, addressed before MCP work started)

An external review of everything built so far (12 findings) came back before Sprint 5 started.
Every claim was verified against the actual code first — all 12 were confirmed real. Fixed:

1. **Removed the phantom `letsfg` npm dependency.** `package.json` declared `letsfg@^2026.5.95`,
   which doesn't exist on the registry and blocked every clean install. It was never actually
   imported anywhere — all LetsFG calls go through raw `fetch` in `letsfgClient.js` — so it was
   dead weight that happened to also be broken. Removed.
2. **Fixed `tests/setup.js` seeding.** Migration 004 made `api_clients.key_prefix` NOT NULL;
   the test seed helper was still doing a raw `INSERT` that predated that column. This is what
   caused 50/70 tests to fail at seeding, before any route logic ran. Now goes through the
   same `ApiKeys.create()` service `seed.js` uses — so a future schema change can't silently
   desync test setup from reality again.
3. **Fixed inconsistent auth-mode paths in the flight adapter.** `getOffer()`, `getBooking()`,
   and `cancel()` were hardcoded to PFS-style paths regardless of `authMode`; `resolveLocation()`
   was hardcoded to the Developer-API path even in PFS mode (wrong auth header entirely). All
   four now branch on `authMode` like `search()`/`book()` already did.
   `resolveLocation()` in PFS mode now fails loudly with an explanation instead of silently
   hitting an endpoint that expects a different auth scheme.
4. Hotel behavior remains explicitly unverified — unchanged from before, correctly not treated
   as "fixed" since it needs a real sandbox, not code review.
5. **Ambiguous supplier timeouts no longer marked `failed`.** New `reconciliation_required`
   booking status (migration 007) + a shared `classifyBookingFailure()` classifier
   (`domain/bookingState.js`) — a `SUPPLIER_TIMEOUT`/`SUPPLIER_UNAVAILABLE` error now lands
   there instead of `failed`, so a client can't retry with a new idempotency key and risk a
   duplicate reservation for a booking the supplier may have actually accepted. Verified with
   `node -e` before wiring in; the existing flights test asserting the old (wrong) behavior was
   corrected, not just made to pass.
6. **Fixed the order idempotency retry bug.** The route checked "is this booking already
   attached to an order" *before* checking "did this idempotency key already create that exact
   order" — so a legitimate retry, which sees its own already-attached booking, got rejected
   with a 400 instead of the original order back. Idempotency is now checked first.
7. **Fixed payment initiation getting permanently stuck.** If `provider.createCheckout()` threw
   after the pending payment row was created, a retry with the same key returned the
   checkout-less stale row forever — the provider was never called again, no checkout URL could
   ever be produced. Now retries the provider call against the same payment record when
   `provider_ref` is still null.
8. **Refund idempotency and transactionality, partially fixed.** Idempotency was checked
   against `order.status`, which the refund itself changes — a retry after a successful refund
   hit "order is not paid" instead of returning the original success. Now checks
   `payment.status === 'refunded'` first. The two local writes (payment refunded, order
   cancelled) are now wrapped in `db.withTransaction`. **Still not fixed:** provider-side
   refund idempotency (the mock provider has no real idempotency semantics to test against),
   and the supplier-side cancellation cascade — both stated as open, not silently assumed solved.
9. **Webhook amount/currency are now validated**, not just parsed. A signed webhook whose
   `amount`/`currency` don't match the local payment record is rejected (`409`) instead of
   capturing the payment — signature proves the event came from the provider, it doesn't prove
   the event matches what TAPI expects for this specific payment.
10. **Fixed NUMERIC-as-string responses.** `node-postgres` returns `NUMERIC` columns as strings
    by default (documented driver behavior) — this silently broke the OpenAPI contract
    (`number`) and any test asserting `555` rather than `"555"`. Fixed once, centrally, via
    `pg.types.setTypeParser(1700, parseFloat)` in `db/index.js`, not at each call site.
11. **Order creation is now fully transactional.** The order insert and the booking-attachment
    update were two separate statements; a partial-attachment failure left an orphaned order
    with no rollback. Both now run inside `db.withTransaction` — a mismatch rolls back the
    order insert too.
12. **Supplier audit records now redact traveler PII before persisting.** Fixed centrally in
    `Bookings.recordSupplierAudit()` (`domain/piiRedaction.js`) — names, DOB, passport numbers,
    and contact details are redacted before writing to `supplier_bookings.raw_request`, so a
    future caller can't forget to redact. **What this does NOT solve, stated plainly:**
    encryption-at-rest, retention/deletion policy, database-level access control, and
    `raw_response` (the supplier's own response can echo the same PII back) are all still open —
    those are infrastructure/ops decisions, not something a redaction function can resolve alone.

### What's still genuinely deferred (from the review's "recommended order of work")

Not attempted this round — these need things this sandbox doesn't have (network, real
credentials, a second running instance, an ops pipeline), and faking them would be worse than
stating the gap:

- **A real lockfile.** Can't run `npm install` here (no network) to generate one. Generate
  `package-lock.json` in a real environment before this goes anywhere near CI or a second
  developer's machine — right now the previous deleted `letsfg` line means installs will at
  least *succeed*, but there's still no lockfile pinning exact versions.
- **LetsFG sandbox verification** (auth modes, actual flight/hotel endpoint behavior) — still
  needs real credentials and network access neither exists in this sandbox nor was ever
  claimed to.
- **A real payment provider** (Paystack/Stripe/etc.) — still blocked on the Decision Gate, same
  as always; `MockPaymentProvider` remains dev/test only.
- **Shared (Redis-backed) rate limiting** for multi-instance deployment — the current limiter
  is explicitly single-instance, stated in its own code comments since it was built.
- **Background search/reconciliation workers, retry queues, dead-letter handling, CI pipeline,
  structured logging/monitoring.** All real Sprint 5+/production-hardening scope, not
  something to bolt on partially inside a code-review response.

## Sprint 1 hardening (external readiness review, mobility module)

The mobility_operations module (migration 010) shipped functional but with three
real gaps found by an external readiness review: no test coverage, a divergent
audit trail, and an idempotency-safety hole flights/hotels/orders already closed.
Addressed here, deliberately scoped to what doesn't need live credentials/network:

- **Merged `audit_logs` into `audit_events`** (migration 011). Mobility was writing
  audit records to its own table instead of the one `middleware/auditLog.js`
  already writes to for everything else — any future "all activity for this
  agency" query would have silently missed all mobility actions. Data is copied
  forward, not dropped; the old table is removed.
- **Added mobility test coverage** (`tests/mobility.test.js`) — operators, trips,
  seat holds (including the conflicting-hold and release-then-rehold cases),
  bookings, transitions, tenant isolation, and a regression test asserting audit
  events land in `audit_events` and `audit_logs` no longer exists. Previously zero.
- **Closed an idempotency-reuse gap** (migration 012 adds `request_hash` to
  `mobility_bookings`). Bookings.createOrGetExisting already rejects a repeated
  Idempotency-Key sent with a materially different body
  (`IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_BODY`, 422) for flights/hotels/orders;
  mobility's own idempotency check didn't do this — a reused key with a different
  trip/hold/passenger would have silently returned the original booking. Now
  reuses the same `hashRequestBody` helper instead of reinventing the check.
- **Extracted `domain/mobilityBookingStateMachine.js`** — the transition rules
  (`pending -> confirmed -> boarded/cancelled`) were an inline object with the
  guard check duplicated in the route handler. Now mirrors the established
  `domain/bookingStateMachine.js` pattern: single source of truth, a dedicated
  error class, domain layer stays HTTP-agnostic (the route maps the domain error
  to a 409, same as before — behavior is unchanged, only where the rule lives).
- **Redacted `raw_response`, not just `raw_request`, in supplier audit records.**
  `piiRedaction.js` previously only redacted the request TAPI itself constructs
  (a known shape). The supplier's response can echo the same PII back — and per
  the LetsFG sandbox-verification gaps noted above, several response shapes are
  unconfirmed, so a shape-specific redactor can't be written yet. Added a
  key-name-based redactor (`redactSupplierResponsePayload`) that walks the
  response recursively and redacts by field name (name/DOB/passport/email/
  phone/card fields) regardless of where they sit in an unverified tree.

**Not done here, still open** (per the review, needs live infra this sandbox
doesn't have): AbortController threading through `letsfgClient.js`, reconciliation
script locking, Redis-backed rate limiting, real payment provider, LetsFG sandbox
verification itself. See the review's original recommendation list for priority
order.

## Sprint 2 hardening (resilience under supplier failure)

Follow-up to Sprint 1, scoped the same way — real fixes, no live credentials/network
required, and an honest list of what's still open at the bottom.

- **AbortController threading in `letsfgClient.js`.** Previously no timeout existed
  at the fetch level at all — `middleware/requestTimeout.js`'s own comments already
  flagged this: it bounds what the CLIENT waits for, but never cancelled the
  underlying `fetch()`, so a hung LetsFG connection kept running server-side
  indefinitely even after the client gave up. Now every request carries an
  `AbortController` with a configurable timeout (`LETSFG_REQUEST_TIMEOUT_MS`,
  default 20s — deliberately shorter than `REQUEST_TIMEOUT_MS`'s 30s default).
  Verified directly: a fetch mocked to hang forever is actually aborted at the
  configured timeout and throws `SUPPLIER_TIMEOUT`, not left running.
- **Circuit breaker per supplier** (`domain/circuitBreaker.js`, new). Without this,
  a down/slow LetsFG degraded every single request that touched it, each paying
  the full timeout one at a time. Now, after `LETSFG_CIRCUIT_FAILURE_THRESHOLD`
  (default 5) consecutive failures, the breaker opens and fails fast — no network
  call at all — for `LETSFG_CIRCUIT_COOLDOWN_MS` (default 30s), then allows one
  trial request through. Flights and hotels get independent breaker instances
  (different LetsFG products, not necessarily correlated outages). In-memory,
  per-process — same real limitation `rateLimiter.js` already documents for
  itself, stated here rather than glossed over. Verified with real timers
  (open → fail-fast-without-calling-fn → cooldown → trial → close).
- **Supplier health surfaced on `/readyz`.** Extended the existing readiness
  endpoint (didn't invent a new one) to include each constructed supplier's
  circuit-breaker state, via `supplierRegistry.getSupplierHealth()`. A supplier
  nothing has called yet in this process simply doesn't appear — accurate,
  since there's no health signal for it yet.
- **Reconciliation script advisory lock** (`scripts/reconcile.js`). The script's
  own header used to list "no distributed locking — two concurrent invocations
  could double-process the same booking" as a known gap. Fixed with a Postgres
  advisory lock (`pg_try_advisory_lock`): a second invocation that starts while
  one is still running now detects the lock and exits immediately instead of
  reconciling the same stuck bookings twice. Explicitly released in `finally`.

**Testability note:** `tests/circuitBreaker.test.js` is the first test file in
this repo that needs neither `TEST_DATABASE_URL` nor network access — it's pure
in-memory logic. Real jest execution still wasn't possible in the sandbox this
work was done in (no network to `npm install`), so alongside the test file, the
breaker and the AbortController timeout were both additionally sanity-run
directly with plain Node against real/fake timers and a hang-forever fetch mock
— see the two verification commands in the corresponding PR/session for exact
output. `npm test` against a real Postgres is still the one step that has to
happen outside this sandbox before merging.

**Not done here, still open:** Redis-backed rate limiting, real payment
provider, LetsFG sandbox verification. See the Sprint 1 section above and the
original review's recommendation list for priority order.

## Sprint 3 hardening (scale-out abstractions)

Planned as "rate-limiter store abstraction + search job queue abstraction." The
second half turned out not to be a real problem once checked against the actual
route code — recorded honestly below rather than building a solution for
something that doesn't exist.

- **Rate-limiter store abstraction, built and swapped in.**
  `middleware/rateLimiter.js`'s in-memory bucket `Map` was already documented as
  "single-instance only... a multi-instance deployment needs a shared store."
  That storage is now behind a `TokenBucketStore` interface
  (`services/tokenBucketStore.interface.js`), following this repo's own
  `<name>.interface.js` convention for supplier adapters. `InMemoryTokenBucketStore`
  (`services/rateLimitStores/`) is the same token-bucket logic as before, moved
  behind the interface — behavior is unchanged, this is a refactor for
  swappability, not a functional change (verified directly: burst-then-429,
  per-limiter isolation, tenant/IP keying, and `DISABLE_RATE_LIMIT` bypass all
  still work exactly as before — see `tests/rateLimiter.test.js` and
  `tests/rateLimitStore.test.js`). `RATE_LIMIT_STORE=redis` is accepted as a
  config value and **fails fast at startup with a specific, actionable error**
  rather than silently falling back to in-memory or pretending to work — no
  Redis client exists in `package.json` and there was no network in this
  sandbox to add and verify one. `/readyz`-callers and route code needed zero
  changes; the middleware's external signature (`rateLimit`, `perTenantLimiter`,
  `perIpLimiter`, `resetBuckets`) is identical to before.
- **Search "job abstraction" — corrected, not built.** The original plan assumed
  a slow supplier response could block an API request thread for up to 100
  seconds (`POLL_TIMEOUT_MS`). Checking the actual route code
  (`flights.routes.js`, `hotels.routes.js`, `buses.routes.js`) shows this isn't
  what happens: `POST /search` calls the supplier once and returns `202`
  immediately; `GET /search/:id` calls the supplier's poll endpoint exactly
  once per client request, now bounded by Sprint 2's `AbortController` timeout
  and circuit breaker. The actual 100-second blocking loop
  (`searchAndWait()`) existed in both LetsFG adapters but **had zero callers**
  anywhere — not routes, not the MCP tools (which do their own bounded polling
  loop client-side, `MAX_POLLS = 20` in `mcp/tools.js`), not tests. It was dead
  code that would silently reintroduce exactly this blocking problem if anyone
  ever wired it into a route without realizing the implications. **Removed**
  (`letsfgAdapter.js`, `letsfgHotelAdapter.js`) rather than left as a footgun —
  nothing in the codebase referenced it, so nothing broke.

**Not done here, still open:** the items unaffected by the above — real Redis
implementation, real payment provider, LetsFG sandbox verification, refund →
supplier cancellation cascade.



- Multi-supplier aggregation engine, market tiering (pending Decision Gate — see
  TAPI Master Product Document §6)
- A real Nigerian domestic supplier integration (blocked on the Decision Gate — Sprint 3
  above is a scaffold proving the interface, not a working adapter)
- A real payment provider (Paystack/Flutterwave/Stripe) — blocked on the Decision Gate;
  MockPaymentProvider is dev/test only
- Refund → supplier-side cancellation cascade (the booking now correctly reaches `refunded`
  status, but nothing automatically calls the hotel/flight supplier's own cancel endpoint)
- A durable reconciliation worker (`npm run reconcile` is now protected against concurrent
  invocations via a Postgres advisory lock — see Sprint 2 hardening below — but it's still a
  single-pass script with no job queue or dead-letter handling)
## What's deliberately not built yet

- Multi-supplier aggregation engine, market tiering (pending Decision Gate — see
  TAPI Master Product Document §6)
- A real Nigerian domestic supplier integration (blocked on the Decision Gate — Sprint 3
  above is a scaffold proving the interface, not a working adapter)
- A real payment provider (Paystack/Flutterwave/Stripe) — blocked on the Decision Gate;
  MockPaymentProvider is dev/test only
- Refund → supplier-side cancellation cascade (the booking now correctly reaches `refunded`
  status, but nothing automatically calls the hotel/flight supplier's own cancel endpoint)
- A durable reconciliation worker (`npm run reconcile` is now protected against concurrent
  invocations via a Postgres advisory lock — see Sprint 2 hardening — but it's still a
  single-pass script with no job queue or dead-letter handling)
- A real Redis `TokenBucketStore` implementation — the abstraction and selection mechanism
  now exist (Sprint 3 hardening, below) and fail loudly if `RATE_LIMIT_STORE=redis` is set
  without one; only the actual Redis-backed class still needs writing once there's
  infrastructure to test it against
- Supplier contract test suite against a real LetsFG sandbox — blocked on network/credentials,
  same as every round before this one
- Production APM, alerting, log aggregation, and a tested backup/restore procedure — a basic
  CI workflow and operational runbook now exist (`.github/workflows/ci.yml`, `RUNBOOK.md`),
  but real monitoring/alerting infrastructure needs a provider decision this repo can't make

## Bus API (Sprint 3 vertical slice)

The bus layer follows the same supplier-neutral, tenant-scoped architecture as flights and hotels. It currently uses the deterministic `mock_bus` adapter by default so the API can be exercised without live operator credentials. Set `BUS_SUPPLIER_CODE` when a production bus supplier adapter is added.

Implemented endpoints:

- `POST /v1/buses/search` — start a route/date search.
- `GET /v1/buses/search/:searchId` — poll and retrieve persisted offers.
- `GET /v1/buses/offers/:offerId` — retrieve an offer.
- `POST /v1/buses/offers/:offerId/validate` — validate seat availability and price.
- `POST /v1/buses/bookings` — create an idempotent booking using `Idempotency-Key`.
- `GET /v1/buses/bookings/:bookingId` — retrieve and reconcile booking status.
- `POST /v1/buses/bookings/:bookingId/cancel` — cancel a confirmed bus booking.

A bus booking stores common lifecycle fields in `bookings` and bus-only details in `bus_booking_details`, including passengers, seat numbers, travel date, pickup/drop-off points, and operator booking reference. Apply migration `009_bus_vertical.sql` before using the bus routes.

Example search:

```bash
curl -X POST http://localhost:8525/v1/buses/search \
  -H "Authorization: Bearer $TAPI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"origin":"Lagos","destination":"Abuja","departDate":"2026-12-01","passengers":2,"currency":"USD"}'
```

The mock supplier is intentionally a development adapter. Before real bookings, implement a production `BusSupplier` adapter and verify supplier-specific search, seat-hold, booking, cancellation, and reconciliation semantics in sandbox credentials.

## LetsFG sandbox end-to-end smoke test

The flight sandbox mirrors the documented Developer API booking lifecycle and does not hold or charge money. The smoke test uses synthetic passenger data and calls only `/developers/api/v1/sandbox/*`.

```bash
# Keep this environment explicit. The sandbox supports calls without a key.
LETSFG_ENVIRONMENT=sandbox npm run letsfg:sandbox-smoke

# Exercise deterministic supplier scenarios:
LETSFG_ENVIRONMENT=sandbox LETSFG_SANDBOX_SCENARIO=price_change npm run letsfg:sandbox-smoke
LETSFG_ENVIRONMENT=sandbox LETSFG_SANDBOX_SCENARIO=extra npm run letsfg:sandbox-smoke
LETSFG_ENVIRONMENT=sandbox LETSFG_SANDBOX_SCENARIO=seller_failed npm run letsfg:sandbox-smoke
LETSFG_ENVIRONMENT=sandbox LETSFG_SANDBOX_SCENARIO=needs_attention npm run letsfg:sandbox-smoke
LETSFG_ENVIRONMENT=sandbox LETSFG_SANDBOX_SCENARIO=payment_declined npm run letsfg:sandbox-smoke
```

Optional settings: `LETSFG_API_KEY` (must be the current valid key if supplied), `LETSFG_SANDBOX_SPEED=fast|realistic`, `LETSFG_WANT_SEAT=true`, `LETSFG_SMOKE_ORIGIN=LOS`, `LETSFG_SMOKE_DESTINATION=LHR`, `LETSFG_SMOKE_DATE=YYYY-MM-DD`, `LETSFG_SMOKE_POLL_MS=5000`, and `LETSFG_SMOKE_MAX_WAIT_MS=180000`. The default passenger is synthetic and must never be replaced with a real customer's passport data in a smoke test.

A successful `success` scenario must finish in `completed` with a sandbox PNR. `seller_failed` must finish in `needs_attention` with `manual_booking=true`; do not open another booking in that state. `payment_declined`, `payment_method_required`, and `temporarily_unavailable` are expected start-call refusals and are reported as expected outcomes. Run scenarios one at a time. This script tests the supplier contract directly; it does not replace the TAPI API + PostgreSQL + browser integration suite.
