# Sprint 9.3 — LetsFG sandbox validation readiness

Date: 2026-11-16

## Scope delivered

- Added `scripts/letsfg-sandbox-smoke.js`, a direct supplier-contract smoke test that targets only `https://letsfg.co/developers/api/v1/sandbox/*`.
- Added `npm run letsfg:sandbox-smoke`.
- Added instructions for deterministic success, price-change, extra, seller-failure, needs-attention and payment-refusal scenarios.
- Uses synthetic passenger details; no real traveller passport data is required.
- Booking question handling uses the supplier's returned `round`; price changes are explicitly confirmed in the harness, while optional seat/extra questions are skipped.
- `seller_failed` is checked for `needs_attention` plus `manual_booking=true`, and the harness does not create a second booking.

## Official contract reviewed

The current LetsFG sandbox reference documents synchronous flight search, simulated booking, booking polling, question answering, stop requests, deterministic scenarios and idempotency. Sandbox requests may omit the API key; if a key is supplied it must be current and valid. See:

- https://github.com/LetsFG/LetsFG/blob/main/docs/api-sandbox.md
- https://letsfg.co/developers/docs/api-booking/index.html
- https://letsfg.co/developers/docs/api-sandbox/index.html

## Verification performed here

- `node --check scripts/letsfg-sandbox-smoke.js`: passed.
- `npm run test:unit`: 100/100 passed.
- Actual HTTP attempt to the LetsFG sandbox could not run because this execution environment could not resolve `letsfg.co` (DNS/network restriction). No supplier response was received.
- No PostgreSQL-backed API integration, browser workflow, or real supplier booking was executed in this environment.

## Required operator validation

Run the smoke script from a machine with outbound HTTPS/DNS access. Start with `success`, then run each deterministic scenario separately. After direct supplier smoke tests, run the TAPI API integration suite against a disposable PostgreSQL database and verify the frontend booking/question states.

## Important safety notes

- Keep `LETSFG_ENVIRONMENT=sandbox`.
- Do not use real traveller passport data in the smoke script.
- Do not retry a `needs_attention` booking by opening a new supplier booking.
- Do not interpret sandbox fake PNRs, fake prices or synthetic passenger data as real inventory or ticketing.
- Hotel integration remains disabled in sandbox because the official docs do not document a hotel sandbox route.
