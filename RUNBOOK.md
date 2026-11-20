# TAPI — Operational Runbook

Scoped to the specific states this codebase can actually produce and needs a human to resolve.
Not a general SRE handbook — see "Deferred" in the README for what infrastructure (paging,
dashboards, log aggregation) needs to exist before this becomes a full on-call runbook.

---

## A booking is stuck in `reconciliation_required`

**What it means:** a supplier call timed out or was unreachable during booking creation. The
supplier may have accepted the reservation and simply failed to respond — this is NOT the same
as a confirmed failure, and the booking must not be retried with a new idempotency key (that
risks a duplicate reservation).

**As of this round, there's a real (if narrowly-scoped) automated first pass:**

```bash
npm run reconcile
```

This finds bookings stuck in an intermediate state past a threshold (`RECONCILE_STUCK_THRESHOLD_MINUTES`,
default 15) and, for `reconciliation_required` bookings with a supplier reference, asks the
supplier directly using the same adapter methods the API itself uses. It resolves what it can
and flags what it can't — every attempt, successful or not, is recorded in
`booking_state_transitions` and `audit_events`.

**What this script genuinely is NOT** — read `src/scripts/reconcile.js`'s own header before
treating this as "the reconciliation system": it's a single-pass script meant for external
scheduling (cron, a Kubernetes CronJob), not a durable worker. No job queue, no distributed
locking (running two instances concurrently could double-process), no dead-letter queue, no
alerting — it prints to stdout and writes audit rows; nothing pages anyone.

**For anything the script can't resolve, the manual procedure is still:**

1. Find the booking: `SELECT * FROM bookings WHERE status = 'reconciliation_required';`
2. Check its full transition history, not just current status:
   `SELECT * FROM booking_state_transitions WHERE booking_id = '<id>' ORDER BY created_at;`
3. Check `supplier_bookings` for the correlation ID and raw response captured:
   `SELECT * FROM supplier_bookings WHERE booking_id = '<id>' ORDER BY created_at DESC;`
4. Call the supplier directly (outside TAPI) using the offer/booking reference to check whether
   a reservation actually exists.
5. Use the state machine's own transition function to resolve it correctly, rather than a raw
   `UPDATE` — this enforces the same guards (e.g. can't reach `confirmed` without a real
   reference) a script or the API itself would have to honor:
   ```js
   const { Bookings } = require('./src/repositories');
   await Bookings.transition(bookingId, 'confirmed', {
     supplierReference: 'PNR_FOUND_MANUALLY',
     actor: 'operator:<your-name>',
     reason: 'confirmed via manual call to supplier support line',
   });
   ```
6. If it does not exist: `transition(bookingId, 'failed', { actor: 'operator:<name>', reason: '...' })`.
   Only now is it safe to tell the agency to retry — with a *new* idempotency key.

**Known gap:** there's no agency-facing way to see `reconciliation_required` and know what it
means yet — `GET /v1/flights/bookings/{id}` returns the status as-is with no explanation. If
this comes up in the beta, add that context to the API response before anything else.

---

## A payment is stuck `pending` with no `checkoutUrl`

Fixed in the last hardening round (retrying `POST /orders/{id}/pay` with the same idempotency
key now retries the provider call) — but if you see this in practice anyway:

1. `SELECT * FROM payments WHERE status = 'pending' AND provider_ref IS NULL;`
2. Re-issue `POST /v1/orders/{orderId}/pay` with the **same** `Idempotency-Key` the client
   originally used — check `payments.idempotency_key` for what that was.
3. If it keeps failing, the payment provider itself is down — check `MockPaymentProvider`'s
   logs (or, once a real provider is integrated, its status page).

---

## A hotel booking returns 500

As of this round, the most likely cause (a `guests` array being sent as invalid input to a
`jsonb` column) is fixed in `repositories/index.js`. If this recurs:

1. Check server logs for the correlation ID in the error response
      (`correlationId` field) — structured JSON logs are now emitted per request
      (`middleware/requestContext.js`).
2. Check whether the error is a raw Postgres error (unhandled, `code: "INTERNAL_ERROR"`) vs. a
   proper `ApiError` — the former means something is throwing outside the `ApiError` system and
   needs a code fix, not an operational workaround.
3. `supplier_bookings.raw_response` for the booking (if a row exists) shows what LetsFG
   actually returned — compare against what `letsfgHotelAdapter.js`'s `book()`/`getBooking()`
   expect.

---

## An agency's API key stopped working

1. `SELECT * FROM api_clients WHERE key_hash = <hash of the key they're using>;` — you can't
   look it up by the raw key (that's the point), but you can check `expires_at`/`status` for
   all of an agency's keys: `SELECT id, key_prefix, status, expires_at FROM api_clients WHERE
   agency_id = '<id>';`
2. Expired → they need a new key (`POST /v1/auth/api-keys`), the old one is not recoverable.
3. Revoked → check `audit_events` for who/why (`action = 'AUTH_FAILURE'` won't show this — a
   revocation itself would only be in the audit log if it went through
   `POST /v1/auth/api-keys/{id}/revoke`, which auto-audits via `auditMutations`).
4. Repeated `AUTH_FAILURE` events from one IP for one agency in a short window is worth a look
   — could be a misconfigured client retry loop, or could be a credential-stuffing attempt
   (`SELECT * FROM audit_events WHERE action = 'AUTH_FAILURE' AND metadata->>'ip' = '<ip>'
   ORDER BY created_at DESC;`).

---

## Server won't shut down cleanly / hangs on deploy

Should be fixed — `server.js` now handles `SIGTERM`/`SIGINT`, drains in-flight requests, and
closes the DB pool before exiting, with a 15s force-exit fallback. If a deploy still hangs past
that:

1. Check for requests that outlived the 30s default request timeout
   (`middleware/requestTimeout.js`) — the timeout bounds what the *client* waits for, but does
   NOT cancel the underlying async work (e.g., a hung `fetch()` to LetsFG). A genuinely stuck
   outbound call can still hold a DB connection or event-loop slot past the HTTP timeout.
2. If this becomes a recurring problem, the real fix is threading an `AbortController` through
   `letsfgClient.js` so a timeout actually cancels the outbound request — not done yet, noted
   as a real follow-up.

---

## Rate limiting seems wrong (too strict, or not limiting at all)

- In-memory, single-instance — if you're running more than one TAPI process, each has its own
  independent limit. This is a known, stated limitation, not a bug to chase.
- `DISABLE_RATE_LIMIT=true` turns it off entirely — **this should never be set in production**,
  only in test/CI environments. If you find it set in production, that's an incident, not a
  config choice.

---

## What this runbook does NOT cover (yet)

Genuinely missing operational capability, not just missing documentation:

- Automated reconciliation (currently 100% manual, see above)
- Alerting of any kind — nothing pages anyone; someone has to think to query these tables
- Log aggregation — structured JSON lines go to stdout, nowhere else, unless you wire up
  something to collect them
- Backup/restore verification — has never been tested against this schema
- A dashboard of any kind for booking/payment health

These need real infrastructure decisions (which APM, which log pipeline, backup cadence) before
a runbook entry for them means anything.

## Booking poller (Sprint 10.0)

Asynchronous suppliers (LetsFG now, Tiqwa later) only *accept* a booking; the outcome arrives later.

```
npm run poll:bookings              # loops every BOOKING_POLL_INTERVAL_MS (default 15s)
node src/scripts/pollBookings.js --once   # single pass (cron / scheduled job)
```

- One poller at a time (Postgres advisory lock `875309002`); a second instance exits immediately.
- A failed supplier call (timeout, DNS) changes nothing: the booking is retried with backoff (15s → 15min cap).
- Only a supplier-completed state **with a PNR/ticket reference** becomes `confirmed`. "Completed" with no reference goes to `reconciliation_required`.
- After `BOOKING_MAX_POLL_ATTEMPTS` (default 40) without a terminal state the booking is escalated to `reconciliation_required` and an audit event is written. A human owns it from there.
- `ticketing_pending` = reservation held, ticket not issued. Never tell a traveller it is booked.
- `npm run reconcile` now resolves flight bookings through the same shared sync.

## Interrupted submissions and the outbox (Sprint 10.4)

- A booking in `reconciliation_required` whose latest transition reason says "submission outcome unknown" was interrupted around the supplier call. Its `submission_key` (`tapi-bk-<id>`, also in the transition metadata) is what the supplier saw. Check the supplier for that key **before** anything else. If a booking exists, attach its id; if not, mark `failed` and let the customer retry. Never re-submit while unsure.
- `npm run outbox:dispatch` (or `-- --once`). Dead-lettered events: `SELECT * FROM booking_outbox WHERE dead_at IS NOT NULL;`. Fix the cause, then clear `dead_at` and set `available_at = now()` to retry.
- Advisory locks: reconcile `875309001`, poller `875309002`, outbox `875309003`.

## Money: ledger and settlement (Sprint 10.6)

- `npm run settle:sweep` (or `-- --once`). Re-drives in-doubt captures/voids/refunds with the SAME idempotency key (safe) and flags authorisations about to lapse while bookings are unresolved (audit action `SETTLEMENT_ESCALATION`).
- Who owes whom for a payment: `SELECT kind, amount_minor, created_at FROM ledger_entries WHERE payment_id = '<id>' ORDER BY created_at;` Completed money movement is `authorization`, `capture`, `void`, `refund`. `*_requested` without a matching completion means in doubt.
- The ledger cannot be edited (trigger). Corrections are new entries, never updates.
- `capture_failed`: the booking stays confirmed. Contact the customer/provider; once resolved, a human re-drives the capture or refunds. Never re-capture without checking the provider for the idempotency key first.
- Advisory locks: reconcile `875309001`, poller `875309002`, outbox `875309003`, settlement `875309004`.
