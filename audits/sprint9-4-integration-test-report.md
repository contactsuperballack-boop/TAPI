# Sprint 9.4 — Full TAPI Integration Testing Report

Date: 2026-11-16
Source: `tapi-mvp-sprint9-3-sandbox-validation.zip`

## Executive result

**Status: PARTIALLY EXECUTED — external integration gates blocked by this execution environment.**

This cycle ran all checks that could be executed without installing dependencies, accessing a PostgreSQL instance, or reaching LetsFG. It did not establish end-to-end production readiness.

## Checks actually executed

| Check | Result | Evidence / limitation |
|---|---|---|
| Frontend API and formatting tests | PASS — 9/9 | `node --test web/test/*.test.js` |
| JavaScript syntax checks | PASS — 95 files | `node --check` over `.js` and `.mjs` in `src`, `scripts`, `console`, `web` |
| LetsFG sandbox smoke test | BLOCKED | `node scripts/letsfg-sandbox-smoke.js` failed before receiving an HTTP response; DNS lookup returned `EAI_AGAIN` for `letsfg.co` |
| Backend Jest integration suite | BLOCKED | `npm ci --ignore-scripts --no-audit --no-fund` timed out; Jest/Supertest dependencies are not installed in this environment |
| PostgreSQL migrations / API integration | BLOCKED | No PostgreSQL server/client is available; localhost:5432 is not listening. Existing integration suite explicitly requires a disposable real PostgreSQL database via `TEST_DATABASE_URL` |
| Frontend production rebuild | BLOCKED | `npm run build` failed because `esbuild` is not installed; dependency installation timed out |
| Browser E2E | NOT RUN | Requires Playwright and Chromium; neither was installed/available. Existing E2E uses a contract mock, not a live DB or supplier |

## Integration boundaries verified by source inspection

- The Express app mounts `/healthz` and `/readyz`; `/readyz` queries PostgreSQL and reports supplier circuit-breaker health.
- Flight search, offer persistence, booking, asynchronous booking polling, supplier question answering and stop-request routes are present.
- Database integration tests reset and apply all SQL migrations to a real PostgreSQL database. They are not mock-DB tests.
- The LetsFG sandbox smoke script uses synthetic passenger data and the sandbox API path. No successful supplier response was received in this run.
- Hotel sandbox calls remain disabled by design because the current supplier contract evidence does not establish a safe hotel sandbox endpoint.
- `web/dist` exists in the source archive, but this run did not regenerate it from the current React source and logo assets.

## Commands to complete on a connected test host

1. Provision an empty, disposable PostgreSQL database and set `TEST_DATABASE_URL` to it.
2. Install backend dependencies from the lockfile: `npm ci`.
3. Run backend integration tests: `TEST_DATABASE_URL=postgres://... npm test`.
4. Run the frontend tests: `cd web && npm ci && npm test`.
5. Rebuild the production frontend: `cd web && npm run build`.
6. Run browser E2E against the rebuilt frontend: install Playwright + Chromium, then `node e2e/run.mjs` from `web`.
7. From a network-enabled host, configure `LETSFG_ENVIRONMENT=sandbox` and run the supplier scenarios separately: `success`, `price_change`, `extra`, `seller_failed`, `needs_attention`, `payment_declined`, `payment_method_required`, and `temporarily_unavailable`.
8. Only after direct supplier smoke tests pass, run the API-to-supplier workflow tests against the disposable PostgreSQL-backed TAPI API. Verify persisted search/offer/booking state, tenant isolation, idempotency, and reconciliation after ambiguous outcomes.

## Release decision

**Do not promote this build to production.** The evidence currently supports frontend unit-level API/formatting behavior and JavaScript syntax only. PostgreSQL integration, backend Jest tests, browser E2E, fresh production build, and real LetsFG sandbox connectivity remain unverified.

Do not run the integration suite against a production database: `tests/setup.js` drops and recreates the `public` schema before applying migrations.
