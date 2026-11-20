# Sprint 10 — Gate 1 Failure-Scenario Qualification (R01–R16)

Status: **logic qualified, system not qualified.** Date: 2026-11-18.

## Read this first
The scenario tests (`tests/unit/failureScenarios.test.js`, plus `settlement.test.js`, `crashRecovery.test.js`, `supplierAbstraction.test.js`) run against in-memory fakes that enforce the **real** booking state machine and the **real** idempotency rule, and a fake supplier that records what it actually holds (so tests assert "exactly one supplier booking exists", not merely "one call was made"). They prove ordering, classification and decision logic.

They do **not** prove: Postgres behaviour (locks, constraints, transactions), HTTP wiring, real process kills, or real supplier behaviour. Those are covered by `tests/*.db.test.js` and the Jest suites (first run: CI), and by the manual steps in `GO_LIVE_CHECKLIST.md`. **Gate 1 must not be declared passed on these tests alone.**

Evidence levels: **L** = logic tested here (in-memory) · **DB** = written, needs the CI Postgres run · **MANUAL** = needs a real process/supplier · **N/A** = cannot be tested without infrastructure that does not exist yet.

## Traceability
| ID | Scenario | Expected | Logic (L) test | Still needed |
|---|---|---|---|---|
| R01 | DB unavailable before booking | No supplier submission | `R01: database unavailable…` (3 steps); `R01 (found…): a request rejected before submission leaves no half-started booking` | DB: kill Postgres mid-request (MANUAL) |
| R02 | DB crashes after supplier submission | Recovery reconciles | `R02: DB fails after the supplier accepted…` (escalate, or recover by key then confirm); `R02: DB fails while recording a supplier ERROR` | DB: `crashRecovery.db.test.js`; MANUAL: kill API between `beginSubmission` and acceptance (go-live checklist) |
| R03 | DNS `EAI_AGAIN` | No duplicate booking | `R03: DNS EAI_AGAIN…` (treated as ambiguous; same-key retry replays) | MANUAL: sandbox with DNS blocked. Optimisation candidate: DNS failure provably means "not sent" and could be a definitive failure |
| R04 | Supplier timeout after accepting | Ambiguous; reconcile | `R04: supplier timeout after accepting…`; `R04 (found…): an unexpected error after the supplier replied`; fail-safe classification table | Real LetsFG: does `idempotency_key` replay? (written confirmation needed) |
| R05 | Duplicate frontend requests | One booking intent | `R05: duplicate frontend requests…` (5 concurrent, one booking); different-key-same-offer refused; race backstop | DB: unique index + `ON CONFLICT` under real concurrency (`crashRecovery.db.test.js`, Jest booking suites) |
| R06 | Background worker crashes | Safe job recovery | `R06: a poller crash mid-step…`; `R06: an outbox consumer crash…` | DB: lease reclaim and `SKIP LOCKED` (`crashRecovery.db.test.js`); MANUAL: kill the poller mid-pass |
| R07 | Payment authorised, booking fails | Release or escalate | `R07: payment authorised, booking fails…` | Real provider with verified `void` capability |
| R08 | Booking succeeds, capture fails | Preserve booking; escalate | `R08: booking succeeds, capture fails…` | Customer-facing policy decision (open) |
| R09 | Offer expires before approval | Revalidate | `R09: offer expires before approval…` (3 refusals, approval not spent) | — |
| R10 | Price changes during approval | New consent | `R10: price changes during approval…` (increase, currency, offer swap, reuse) | Approval is not yet bound to passengers, fare conditions, FX quote (gap matrix 10.8) |
| R11 | Agent requests passport plaintext | PII boundary blocks | `R11: the model can never see passport data…` | Log/trace/queue-payload scanning (not done) |
| R12 | Prompt injection attempts payment | Transaction authority rejects | `R12: prompt injection cannot spend money…` (no approval, cancelled, swapped offer; agent tool list has no spend/passport tool) | Step-up authentication (not built) |
| R13 | Supplier `needs_attention` | No false confirmation | `R13: supplier needs_attention…` (even with a PNR present; completed-without-evidence; repository guard) | — |
| R14 | Refund request times out | Refund reconciliation | `R14: refund request times out…` | Real provider idempotency semantics |
| R15 | 1,000 concurrent pending bookings | Controlled resource use | `R15 (logic level)…`: sequential polling, supplier concurrency 1, bounded batch | **N/A until a load test runs against Postgres + a stub supplier.** This is a design check, not a capacity claim. |
| R16 | Redis unavailable | No lost financial jobs | `R16: Redis is not on any financial or booking path` | Rate limiter **fails closed with 503** if a future Redis store is down: that is an availability decision to make deliberately. Redis store is not built (in-memory only). |

## Acceptance criteria
| Criterion | Status |
|---|---|
| No duplicate capture | L: ledger keys + provider idempotency, tested. DB: unique key (needs CI). |
| No false booking confirmation | L: confirmation needs live state **and** PNR; the repository guard can no longer be satisfied by a supplier booking id (fixed: `supplier_reference` is left empty at acceptance). |
| No approval reused for a changed amount | L (R10). Atomic single-use consume (migration 016): DB run needed. |
| No refund exceeding the refundable balance | L: decision + ledger guard. |
| No new supplier booking while the previous result is ambiguous | **L + DB index (migration 021)**: was a real gap (a new idempotency key would have double-booked); now refused with 409. DB run needed. |
| No passport plaintext in LLM context or ordinary logs | L for the model view; **logs not verified**. |
| Jobs survive worker termination | L (poller, outbox); DB lease behaviour needs CI; MANUAL kill test pending. |
| Financial records reconcile | **Not met.** Ledger covers customer-side money only; no supplier-side entries or statement matching. |
| Every unresolved transaction has an owner, status and next action | **Partly.** Status and audit events exist; there is no owner field, queue or operations console workflow. |

## Defects this programme found (all fixed in code, all need a DB/CI run)
1. A rejected request (sandbox-only fields on a non-sandbox supplier, or an unconfigured supplier) happened **after** the booking was started, leaving an orphaned `pending` booking that recovery would escalate to a human.
2. Unexpected errors after a supplier reply (e.g. a parse error) were classified `failed`, inviting a duplicate booking. Booking outcome classification is now fail-safe (`classifyBookingOutcome`): only provable refusals are definitive. **Hotels and buses still use the legacy classifier** (`bookingState.classifyBookingFailure`), whose existing test encodes the unsafe default; they need the same change.
3. After an async acceptance the supplier's booking id was stored in the evidence column, so "confirmed needs a reference" could be satisfied by a booking id.
4. A client retrying an ambiguous booking with a **new** idempotency key could create a second supplier booking for the same offer. Fixed with a pre-check and a unique partial index (migration 021).

## Verdict
Logic-level qualification of R01–R14 and R16: **done**. R15: **not done**. Gate 1 (Resilience Qualification): **not passed**. Remaining to pass it: a green CI run including the DB suites, the manual kill tests, a real sandbox run, a load test, supplier-side ledger/reconciliation, and the same fail-safe classification for hotels and buses.
