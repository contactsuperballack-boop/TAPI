# Sprint 8 progress — slices 1 to 4 (agent core + web UI)

## Slice 3 (fix after first external run)
Migration 013 failed on a clean database: `010_mobility_operations.sql` already owns a `trips` table. Cause: I checked only 001_init for existing names. Fix: all agent tables now carry an `agent_` prefix (agent_trips, agent_trip_items, agent_trip_approvals, agent_trip_messages, agent_trip_events); repos, tests and docs updated.
Added tests/unit/migrations.test.js (static: duplicate tables/indexes, REFERENCES order, repository SQL vs created tables). Confirmed it fails on the old naming with the exact error reported, passes on the new.
Jest now ignores tests/unit (those are node:test files; run them with `npm run test:unit`).

## Slice 4: web UI (web/, served by TAPI at /app)
React 19 + esbuild, no Tailwind/Vite/lucide (not installable offline; none needed). Screens: connect, trips, trip workspace (Plan / Find / Assistant / Activity),
approve sheet, travellers. Phone-first with desktop sidebar; light and dark themes.
New backend routes: GET/PATCH /v1/trips, POST /v1/trips/:id/items (price taken from the stored offer, not the request), GET events,
POST items/:id/refresh (booking status sync), GET/POST messages (503 AGENT_MODEL_NOT_CONFIGURED until a model adapter exists), GET/POST /v1/travelers (passport masked).
Verified: web unit tests 8/8; UI e2e 18/18 in headless Chromium (phone 390px + desktop 1280px) against a MOCK of the contract (web/e2e/mock-server.mjs), including a horizontal-overflow assertion.
NOT verified: the UI against the real server (needs Postgres), the new routes' SQL, tests/trips.test.js additions.
Bugs found and fixed while building it:
- booking route sent date_of_birth as a JS Date (pg DATE) -> would fail TAPI's YYYY-MM-DD schema; DATE columns now cast to text in the agent/traveller queries.
- an expired approval blocked re-approval (unique index counted it) -> stale approvals are expired before a new one is created.
- after a price increase there was no way forward -> item reopens at the confirmed new price with approval revoked; expired/sold-out offers mark the item failed.
- trip status never left 'draft' -> forward-only progression (researching -> awaiting_approval -> booking) with unit tests.
- booked items still said 'Estimated price' -> price becomes 'confirmed' after the booking-time revalidation.
- approve sheet claimed "does not charge you": reworded to what is verified (approve alone books/pays nothing).

## Verified (node:test, no DB, no network): 28/28
tripStateMachine, approval gate, price provenance, PII allowlist, booking executor (fakes), TAPI client (fake fetch),
agent loop (fake model: caps, timeouts, fallback, error containment), model tools (no money-moving tool exists; propose only accepts offers the conversation saw).
Run: `npm run test:unit`

## Written but NOT run (needs Postgres / jest / npm install — none available where this was built)
- migrations/013_trip_agent.sql  (renamed tables; static check passes, but a real `npm run migrate` on an empty DB is still the proof)
- repositories/tripApprovals.js, repositories/trips.js, routes/trips.routes.js (mounted at /v1/trips): syntax-checked only
- tests/trips.test.js: jest + supertest integration tests (approval price match, tenant isolation, wrong-item approval, 5-way concurrent consume). Written, never run.
- Known gap: errors thrown by the TAPI client inside the book route are plain Errors with .status/.code; check errorHandler maps them to RFC 7807 rather than 500.

## Not started
POST /v1/trips/:id/messages (runs runAgentTurn, persists messages), a real model adapter (none chosen; loop takes model.generate),
background jobs + polling of booking status into trip items, UI rewiring, port of security.ts vault (hard-coded fallback secret must go), removal of agent's fake /api/mcp.

## Findings from reading the code (changes to the Sprint 8 doc)
1. Migrations already run to 012; the agent tables are 013, not 010. The runner is forward-only, so "migrate up and down" is not a valid acceptance test.
2. Agent talks to TAPI over HTTP, same as mcp/tapiClient.js (documented MVP rule: no logic bypassing tenant/rate-limit/audit/idempotency). This replaces decision D1 ("direct service calls").
3. TAPI auth is agency API key, "NOT consumer JWT" (middleware/auth.js). The agent's end-user model needs an explicit decision: travellers belong to an agency; the existing `customers`/`travelers` tables are the profile.
4. Agent's own 3-state booking model (AWAITING_APPROVAL...) duplicates TAPI's 13-state machine. Resolved by mapping, not porting (mapBookingStatusToItemStatus).
5. Agent prototype defects to remove: orchestrate_trip_plan auto-picks flights[0]/hotels[0] without user choice; hard-coded defaults (Lisbon, 2026-12-10, $5200); fixed 3-day itinerary regardless of dates; model name 'gemini-4-hydrogen' unverified; no auth on any /api route incl. /api/profile/reveal-pii; its fake /api/mcp logs the raw rejected API key; PiiVault falls back to a hard-coded secret.
6. Pre-existing in the MVP: travelers.passport_number is stored plaintext.
7. Agent prototype has no test runner script (tests use node:test, never wired to package.json).

## Step 1 of the access model: accounts, roles, sessions (migration 014)
Decisions (from the product owner): travellers sign up directly; agencies and their agents act for clients; fulfilment later via automated or agent-assisted modes, escrow via a licensed provider. This REVERSES the old "no consumer sign-up" rule in middleware/auth.js (Master Spec §11); the file header now says so.
- Direct sign-ups belong to a built-in house agency ("TAPI Direct", fixed id 00000000-0000-4000-8000-000000000001), so every request still resolves to exactly one agencyId.
- Roles: traveller / agent / admin (memberships). Sessions are opaque tokens (tps_...), only their SHA-256 is stored. Passwords: scrypt (N=32768). Email verify / reset / invite tokens are single use and hashed.
- Three credentials in middleware/auth.js: agency API key (acts as admin), user session, internal service token (svc_..., loopback only, tenant from the verified caller). Trip routes no longer forward the caller's token to TAPI's own API.
- Travellers are deny-by-default (domain/access.js): own trips, search, own profile only. Raw bookings/orders/staff/API keys are 403. API-key management (/v1/auth) is now admin-only.
- Approvals record who approved, in what role, and whether an agent attested client consent. Unverified emails cannot approve or book. Per-agency traveller_self_booking switch (enforced, no UI toggle yet).
- Flights need DOB + passport + nationality on the traveller before booking (PROFILE_INCOMPLETE, checked BEFORE the single-use approval is consumed).
New endpoints: /v1/account/{signup,login,verify-email,password-reset/request,password-reset/confirm,me,logout,resend-verification}, /v1/staff (admin), /v1/travelers/me, PATCH /v1/travelers/:id.
UI: sign in / create account, verify and reset pages, role-aware navigation, My details, Clients, Team, consent checkbox for agents.
Verified here: backend unit/static 54/54 (incl. 8 middleware tests with stubbed repos, 17 account-logic tests with an in-memory repo, lockout, single-use tokens, no account enumeration), web unit 8/8, browser e2e 18/18 + 14/14 against the contract MOCK.
NOT verified: migration 014 and every new SQL statement; tests/identity.test.js (written, never run); email delivery (no provider chosen: in production, sign-up/verify/reset answer 503 EMAIL_NOT_CONFIGURED until MAIL_TRANSPORT is set); the existing jest suite after the auth.js rewrite (any test asserting the old 401 wording needs a look).
Found by the browser tests: login responded without principal.type so the UI would have hidden the verify banner and the agent consent box (fixed); verify-link refresh message was misleading (reworded).
Known limits: session token lives in sessionStorage (XSS risk vs httpOnly cookie); per-IP limiter uses req.ip (trust proxy is on); lockout lets an attacker lock a known email for 15 min; no SMS/2FA; no UI for the self-booking switch; no way yet to move a trip between travellers' accounts.

## Postmark mail adapter + Step 2: fulfilment modes and the agent queue (migration 015)
Mail: MAIL_TRANSPORT=postmark with POSTMARK_SERVER_TOKEN and MAIL_FROM. Written from knowledge of Postmark's HTTP API (POST https://api.postmarkapp.com/email, X-Postmark-Server-Token header); NOT verified against a live Postmark server (no network here). Tested with a fake fetch: request shape, error messages exclude the token and one-time links, 200-with-error-code counts as failure, 10s timeout, CR/LF header-injection refused, fails closed when misconfigured.
Send failures: sign-up and password reset still answer generically (failure logged); resend-verification and staff invites tell the caller to retry (502); a failed invite can be re-sent by inviting the same address again.
Fulfilment: each item is booked 'automated' (supplier API, as before) or 'agent_assisted'. Approving with fulfilment=agent_assisted creates a request in the agent queue and keeps the traveller's approval valid 48h (AGENT_APPROVAL_TTL_HOURS). Agencies with traveller_self_booking=false route their travellers to agents automatically.
- Agent queue (/v1/fulfilment, staff only): open / mine / done; atomic claim; hand back; complete; cannot-book; price-changed.
- Same price safety as automated: an agent can record a booking only at or below the approved price, in the approved currency, using the traveller's single-use approval (consumed in the same transaction that confirms the item). Higher price -> 409 PRICE_EXCEEDS_APPROVAL; the agent uses "Price changed", the traveller approves the new price.
- Full passport details are revealed only to the agent who claimed the request (or an admin), never cached, every reveal logged as a trip event.
- Travellers get emails on completion, decline and re-price (best effort; failures never undo anything). They can withdraw a request until an agent starts.
- Trip status: waiting-for-agent counts as booking in progress; it steps back to itinerary_ready when nothing is in progress.
Verified here: backend unit/static 72/72, web unit 9/9, browser e2e 18/18 (original flow) + 14/14 (accounts) + 13/13 (agent bookings) against the contract MOCK.
NOT verified: migration 015 and all new SQL (claim race, transactional completion); tests/fulfilment.test.js (written, never run); Postmark with a real token; the full Jest suite since the auth rewrite.
Bugs found while building: stuck "Booking" trip status after a re-price or withdrawal (added a legal regression); a missing React import that crashed the approval sheet (caught only by the browser test); fake repo allowed duplicate memberships unlike the real unique constraint.
Not built: payment collection/escrow (step 3: the UI says payment is arranged with the agent), messaging between traveller and agent, agent notifications for new requests (queue refreshes every 20s while open), automatic assignment/matching across agencies, SLA timers, an admin toggle screen for self-booking.
