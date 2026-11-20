# TAPI MVP (Sprint 8, slice 6) — Security & Quality Audit
Date: 2026-11-15 · Scope: money-moving path (approvals, booking executor, fulfilment queue), auth, error handling, migrations.
Method: full read of those files; all 16 migrations applied on a clean PostgreSQL 16; 80 node:test unit tests; regression tests written first and seen failing.

## Verified (not assumed)
- Syntax check clean on every .js/.mjs file.
- Migrations 001–015 apply cleanly on an empty DB (closes the "013/015 never run" gap). 016 (added in this audit) applies too.
- Unit suite: 72/72 before, 80/80 after.
- NOT verified here (no node_modules, no network): Jest/supertest suite (tests/trips.test.js, tests/fulfilment.test.js, all route SQL at runtime), UI e2e, live LetsFG supplier, Postmark.

## Fixed in this audit
| # | Sev | Finding | Evidence | Fix |
|---|-----|---------|----------|-----|
| 1 | High | Retry path for a consumed approval had no time bound and skips revalidation. If the first attempt never reached TAPI, a retry days later booked at whatever the live price was (reproduced: 3-day-old approval booked, 0 validations). Breaks "revalidate before booking". | agent/bookingExecutor.js (isRetry) | New `consumed_at` column (migration 016); retry allowed only within 15 min (`APPROVAL_RETRY_WINDOW_MINUTES`); unknown age fails closed; route reopens the item for re-approval. |
| 2 | Medium | Malformed JSON, oversized bodies and invalid UUIDs returned 500 "Internal Server Error" and logged stack traces (errorHandler only understood ApiError). | middleware/errorHandler.js | Mapped to 400/413/415 with generic messages; unknown errors stay 500 and never echo internals. |
| 3 | Medium | `trust proxy: true` trusts any X-Forwarded-For, so clients can spoof IPs and bypass the per-IP limiters (login brute-force guard). | app.js:27, rateLimiter.js:79 | Trust exactly `TRUST_PROXY` hops (default 1; 0 if directly exposed). |

## Open — recommended next (not changed; need a product decision or more work)
| # | Sev | Finding | Evidence | Recommendation |
|---|-----|---------|----------|----------------|
| A | High | Supplier booking failure after the approval is consumed surfaces as a generic 500: no `booking_failed` event, item stays "approved", traveller not notified. PRD acceptance test D (record failure, notify, never show confirmed) is not met. TAPI client errors are plain Errors. | routes/trips.routes.js:207 → errorHandler; agent/tapiClient.js:17-21 | Catch around executor: 4xx = definitive → item `failed` + event + notification + allow re-approval; 5xx/timeout = ambiguous → keep retry path (now bounded). Needs your call on which supplier codes are definitive. |
| B | High | Passport numbers stored in plaintext; also returned by /fulfilment/:id/reveal. PRD §8.1 requires encryption of passport data. (Already noted in your sprint notes.) | db/migrations/001_init.sql:43 | AES-256-GCM field encryption with a key from a secret manager, store last-4 separately for display, backfill migration, key rotation plan. |
| C | Medium | TAPI client `fetch` has no timeout/AbortSignal; requestTimeout only stops the client waiting. A hung supplier call after approval consumption holds the request and leaves state ambiguous. | agent/tapiClient.js:15 | `AbortSignal.timeout(...)` per request, distinct from search polling. |
| D | Medium | Internal `svc_` token + `X-Agency-Id` grants admin on any tenant. The loopback check is ineffective behind a same-host reverse proxy (socket is always loopback), so the token is the only control. Random per-process token breaks multi-instance deploys. | middleware/auth.js:44-54, services/internalAuth.js | Require INTERNAL_SERVICE_TOKEN (≥32 chars) in production, fail startup if missing; or call services directly instead of HTTP. |
| E | Low | complete/decline/reprice update on `status='claimed'` but not on the claimer. If agent A's claim is released and agent B claims it between A's load and A's write, A can finish B's request. | repositories/fulfilment.js:99-128 | Add `AND claimed_by_user_id IS NOT DISTINCT FROM $n`. |
| F | Low | Rate-limit buckets are in-process; limits multiply per instance. | services/rateLimitStores | Use the Redis store behind the existing factory before scaling out. |
| G | Low | Fulfilment id check `^[0-9a-f-]{36}$` is looser than a UUID. Now returns 400 via fix 2 instead of 500. | routes/fulfilment.routes.js:19 | Reuse the strict UUID regex from middleware/auth.js. |

## Checked and fine
Single-use approval consume is atomic (`UPDATE … WHERE status='active' AND expires_at > now()`); one active approval per item (partial unique index); idempotency key derived from approval id; claim race is atomic; approval TTL and price ceiling enforced; traveller deny-by-default; tenant id taken from verified credential; svc token compared in constant time; PII reveal is logged and `no-store`.

## Next steps
1. Decide A (failure semantics), then implement + test.
2. Implement B (passport encryption).
3. Run `npm ci && npm test` with Postgres in CI/locally to prove the never-run Jest suites; send me failures.
