# Sprint 10.0 — Code-Level Gap Matrix (work package 10.1/10.2 baseline)

Date: 2026-11-18 · Baseline: `tapi-mvp-sprint9-4-integration-testing.zip` (diffed against `…sprint8-slice7-audit-fixes.zip`)

## How to read this

Evidence levels, strongest first:
- **RAN** — executed in this audit and passed (100 → now 196 backend unit tests, 9 frontend tests, syntax of every `.js`).
- **READ** — source inspected, behaviour not executed.
- **CLAIMED** — stated in a report, not confirmed here.
- **NOT RUN** — needs PostgreSQL / network / browser that this environment lacks.

Classification: ✅ Implemented & verified · 🟡 Implemented, unit-tested only · 🟠 Implemented, untested · 🔴 Missing · ⚫ Architecturally unsuitable.

**Environment finding:** the shipped `node_modules/` folders are empty shells (express, pg, zod, uuid, jest, supertest all fail to `require`). That, not only the network, is why Sprint 9.4 could not run the backend suite. `npm ci` on a connected host is step one. The 16 DB-backed Jest suites (`tests/*.test.js`) have not been executed by anyone in this chain.

## Matrix by Sprint 10 work package

| WP | Area | Class | Evidence | Gap / action |
|---|---|---|---|---|
| 10.2 | Booking state machine | 🟡 | RAN: transition table tests. Added `ticketing_pending` this sprint; test asserts the newest DB CHECK matches `STATES`. | DB constraint never executed against real Postgres. Run migrations on a disposable DB. |
| 10.2 | Async booking lifecycle (LetsFG) | 🟡→🟠 | READ+RAN (pure logic). Route returns 202 and `processing`; confirm needs PNR. | End-to-end vs sandbox unverified (DNS blocked). Route handlers not executed (no express). |
| 10.2 | Payment state machine / authorise-capture | 🟡 (Sprint 10.6) | RAN (logic): provider interface gains `capabilities`, `capture`, `void` (idempotent by key, `error.definitive` convention); statuses `authorized`, `capture_failed`, `voided`; pure `decideSettlement` (hold while any booking is unresolved; capture only confirmed; void/refund the rest; escalate when the provider can't do a partial outcome or an authorisation is about to lapse); executor writes a ledger *request* before the provider call and the *completion* in one transaction with the counters. Covers R07, R08, R14 at logic level. | Needs a Postgres run (`tests/ledger.db.test.js`). **Only a mock provider exists; no real provider chosen.** The order-ready gate (does "authorised" count as secured for fulfilment?) is deliberately NOT changed: authorised webhooks do not mark the order paid. Payment `capture_failed` has no automatic retry: a human owns it (audit event `SETTLEMENT_ESCALATION`). |
| 10.2 | Cancel / refund / partial fulfilment | 🟠 | READ: states exist (`cancel_requested…refund_failed`); `tripStateMachine.js` exists. | No refund-balance ceiling check found; no trip-level compensation when flight succeeds and hotel fails. |
| 10.3 | FX / quote validity | 🟡 (Sprint 10.6) | RAN: exact BigInt maths on minor units, buffer (max 10%), TTL (max 15 min), stale-rate refusal, round-up, single-use quotes (`fx_quotes`, atomic consume), static dev provider refused in production. Property tests for allocation. | **Not yet wired into order creation or approval**: orders are still single-currency (`computeOrderPricing`), and approvals are not bound to a quote id. No real FX provider, buffer percentage or margin policy decided. `normalizeOffer` still invents a 5-minute offer expiry when the supplier gives none. |
| 10.4 | Idempotency | 🟡 | READ: unique `(agency_id, idempotency_key)` + request hash, atomic insert; agent path derives key from approval id. | Key is **client-owned**, not a server booking intent. |
| 10.4 | Crash window: supplier accepts, TAPI dies before saving the supplier id | 🟡 (Sprint 10.4) | RAN (logic): submission intent (`submission_key`, `submission_started_at`) is saved in the same transaction as `created→pending`, BEFORE the supplier call; supplier id + `processing` now saved in ONE transaction; `submissionRecovery` handles interrupted submissions and never re-submits. Migration 019. | Needs a Postgres run. **LetsFG has no verified lookup-by-key** (`lookupByKey=false`), so today every interrupted submission escalates to `reconciliation_required` with the key recorded for a human. Ask LetsFG whether `idempotency_key` replays/looks up. |
| 10.4 | Transactional outbox | 🟡 (Sprint 10.4) | RAN (logic): events inserted in the same transaction as the state change (`transition`), unique `dedupe_key`, lease-based claim with `FOR UPDATE SKIP LOCKED`, retry/backoff, dead-letter. `npm run outbox:dispatch`. | Only audit-event handlers exist; traveller email/ops alerting/webhook handlers are not wired. Hotel and bus routes still use the old `transition(…,'pending')` path (no submission intent yet). Handlers must be idempotent (at-least-once). |
| 10.5 | Durable background processing | 🟠 (new) | `pollBookings.js` added: advisory lock, backoff, escalation. Unit-tested logic; script not run (no DB). | No queue; Redis only backs rate limiting. Poller is DB-polling, adequate for MVP volumes. |
| 10.6 | PII boundary for the LLM | 🟡 | READ+RAN: allowlist `piiBoundary.js`, `assertNoSecrets` helper, agent tests. | Log/trace/queue-payload scanning not verified. |
| 10.7 | Traveller document vault | 🟡 | READ: AES-256-GCM, key ids, rotation script, AAD **required** (`ctx()` throws without it). | Keys from env, **no KMS/HSM**. AAD is whatever caller passes; binding to tenant+traveller+document+field not confirmed. No consent/retention/deletion workflow. |
| 10.8 | Transaction approval | 🟡 | READ: single-use, expiry, price ceiling, currency, offer match, atomic consume (migration 016), 15‑min retry window. | Not bound to passengers, fare conditions, document-use consent or payment authorisation. **No step-up authentication.** |
| 10.9 | Reconciliation / ledger | 🟡 (Sprint 10.6) | `ledger_entries`: append-only (DB trigger rejects UPDATE/DELETE), unique idempotency keys, balances derived from completed entries, backfill of historical captures; `npm run settle:sweep` re-drives in-doubt actions. Flight reconciliation fixed earlier (shared sync). | Ledger covers customer-side money only: **no supplier-side charges, FX gain/loss, fees or commission entries, and no statement matching** ("who owes whom" is half answered). Hotel reconciliation path unchanged. |
| 10.10 | Failure injection / concurrency | 🟡 (Sprint 10.7) | RAN (logic): R01–R14 and R16 have scenario tests against in-memory fakes with fault injection (`tests/unit/failureScenarios.test.js`); booking flow extracted to `services/flightBookingExecutor.js` so it can be fault-injected. See `audits/sprint10-r01-r16-qualification.md`. | **Gate 1 not passed.** No test has run against Postgres, real process kills, or a real supplier; R15 (load) not done. Four defects found and fixed (listed in the qualification report). Hotels and buses still use the unsafe legacy failure classifier. |
| 10.11 | External hand-off & fulfilment | 🟠 | READ: migration 015, `domain/fulfilment.js`, unit tests. | DB path unexecuted. |
| 10.12 | Release / CI | 🟠 (Sprint 10.5) | READ+RAN (config guards): `.github/workflows/ci.yml` (unit+syntax on Node 20/22; Postgres 16 job: migrate from zero, migrate again must skip, full Jest; web build+tests), manual `sandbox-smoke.yml`, Dependabot, `Dockerfile`, `docker-compose.yml` (api, poller, outbox, migrate), `.gitignore`/`.dockerignore`. `tests/unit/ciConfig.test.js` checks the config against the repo. | **No workflow has ever run.** First CI run is expected to surface real failures in the 16 untested Jest suites and in migrations 018/019, including the new `tests/crashRecovery.db.test.js`. `web/` has no lockfile (CI falls back to `npm install`); `web/dist` is stale. Branch protection, required checks and secret storage must be configured in the repository settings. |

## Defects found in the 9.4 baseline and their status

| # | Defect | Status |
|---|---|---|
| 1 | Booking outcome only resolved if a client called `GET` | **Fixed**: `pollBookings.js` + shared `bookingSync`. |
| 2 | Route hard-wired to LetsFG (search, offers, async branch, answer, stop) | **Fixed**: capability-driven; supplier recorded on search/offer/booking. |
| 3 | `FlightSupplier` interface out of sync (`book` 4th arg, `answer`, `stop`) | **Fixed** + contract validator on every registry hand-out. |
| 4 | Reconcile script mapped `completed` as ambiguous; flagged `processing` | **Fixed** (flights). |
| 5 | Confirming overwrote the supplier booking id with the PNR | **Fixed**: `supplier_booking_id` column (migration 018). Needs DB run. |
| 6 | Search results never recorded which supplier ran them; offers inserted with a constant `letsfg` | **Fixed**: `searches.supplier_code`. |
| 7 | Sandbox search snapshot stored unbounded in `supplier_search_ref` | **Fixed**: capped at 200k chars by trimming offers. |
| 8 | Production `validateOffer` threw a bare Error (HTTP 500) | **Fixed**: `501 NOT_SUPPORTED`. **Production booking still blocked** until revalidation is designed. |
| 9 | Sandbox controls silently ignored outside sandbox | **Fixed**: 400 when sent to a non-sandbox supplier. |
| 10 | Booking always 202 | **Fixed**: 202 only for async-accepted, 201 otherwise; OpenAPI updated. |
| 11 | A supplier outage during `GET` booking would 500 | **Fixed**: returns stored state with `refreshFailed: true`. |
| 12 | Hotel sandbox disabled | Unchanged by design. |

## Found by the R01–R16 programme (Sprint 10.7)
See `audits/sprint10-r01-r16-qualification.md`: orphaned booking on pre-submission rejection; fail-open error classification; booking id satisfying the confirmation guard; duplicate booking via a new idempotency key (migration 021).

## Added in Sprint 10.4 (crash window + outbox)
See `SPRINT10_0_SUPPLIER_ABSTRACTION.md` §Crash-window design.

## Not fixed — Sprint 10 critical path (in order)

1. Push to a repository so CI runs: migrations 001–019 and every DB Jest suite on a disposable Postgres. Everything marked 🟡 stays unproven until the first green run, and a red run is expected to teach us something.
2. Run migration 019 and exercise crash recovery against a real DB; extend submission intent to hotels and buses; wire outbox handlers (traveller notification, ops alerts).
3. Wire FX quotes into order creation and approval binding; choose payment provider, FX source and buffer policy; add supplier-side ledger entries and statement matching.
4. Step-up approval and expanded approval binding.
5. R01–R16 failure tests (CI now exists to run them).
