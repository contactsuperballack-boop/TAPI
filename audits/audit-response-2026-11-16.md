# Response to the 15 Nov 2026 audit, and what to run

The audit found three problems it fixed itself (1 to 3) and seven it left open (A to G). All ten are now handled. Three of my choices need your confirmation (section 2).

## 1. Every finding

| # | Finding | Status | What changed |
| --- | --- | --- | --- |
| 1 | Retry of a spent approval had no time limit and skipped revalidation | Fixed by the audit, **improved by me** | Retry allowed only for 15 minutes (`APPROVAL_RETRY_WINDOW_MINUTES`). After that the item goes to **Under review**, not back to re-approval. Re-approving would use a new idempotency key and could double-book if the first attempt actually reached the supplier. |
| 2 | Malformed JSON, oversize bodies and bad IDs returned 500 | Fixed by the audit | `errorHandler` now maps them to 4xx. |
| 3 | `trust proxy: true` let clients spoof IPs and dodge login limits | Fixed by the audit | Trusts a set number of proxy hops (`TRUST_PROXY`, default 1; use 0 if the app is exposed directly). |
| A | Failure while booking (after the approval is spent) became a generic 500 | **Fixed, needs your confirmation** | Failures are split into *definitive* (nothing booked) and *ambiguous* (cannot tell). Each has its own path, event and message. See 2.1. |
| B | Passport numbers stored in plaintext | **Fixed** | AES-256-GCM encryption with key rotation, bound to each traveller record. Migration 017 and a conversion script. See step 4 below. |
| C | No timeout on TAPI's internal calls | **Fixed** | 15 s default, 45 s for bookings. A timeout counts as *ambiguous*. |
| D | Internal service token weak in production | **Fixed** | The app refuses to start in production without a 32+ character `INTERNAL_SERVICE_TOKEN`. |
| E | Stale agent could finish a request another agent claimed | **Fixed** | Complete, decline, re-price and hand-back now only apply if the same agent still holds the claim. |
| F | Rate limits are per instance | **Not changed** | Matters only when you run more than one server. Use the Redis limiter before scaling out. |
| G | Loose UUID check | **Fixed** | One strict UUID check, shared. |

## 2. Decisions I made that you should confirm

### 2.1 What counts as "nothing was booked" (finding A)

I used these defaults. They are the safe direction: when unsure, we assume the booking might exist.

| Outcome | Examples | What happens |
| --- | --- | --- |
| **Definitive: nothing booked** | Supplier or TAPI answered 400, 404, 410, 422, or the codes SOLD_OUT, OFFER_EXPIRED, PRICE_CHANGED | Item returns to the traveller (or is marked failed if sold out or expired). Event logged. Traveller emailed. They may approve again. |
| **Ambiguous: cannot tell** | Timeouts, network errors, 5xx, 408, 429, any unknown code | Item becomes **Under review**. The traveller is told not to approve again. The same approval can be retried for 15 minutes (same idempotency key, so no double booking). After that, only staff can close it. |

Please check this against LetsFG's real behaviour once its sandbox is verified. If it uses other codes for "rejected", they need adding to `src/domain/bookingFailure.js`.

### 2.2 How staff close an item that is "Under review"

New staff-only action: **Resolve this booking**. Staff check with the supplier, then record either *booked* (with the supplier's reference) or *not booked*. The traveller is emailed either way. It never creates a booking itself.

### 2.3 Retry window length

15 minutes (the audit's value). Shorter is safer against stale prices; longer is kinder to a slow recovery. Your call.

## 3. What is verified, and what is not

| Verified here | Not verified |
| --- | --- |
| 94 backend unit/static tests, 9 web tests, and 22 + 14 + 13 browser steps against a mock | The audit ran migrations 001 to 016 on PostgreSQL 16. **Migration 017 has not run on a real database.** |
| Encryption tests: tampering, wrong key, wrong record, rotation, the conversion script (against an in-memory copy) | `tests/audit.test.js`, `tests/identity.test.js`, `tests/fulfilment.test.js` (written, never run) |
| Failure classification, timeouts, the production-secret checks | All route SQL at runtime, live LetsFG, live Postmark |

## 4. Step guide

Run these in order on a machine with PostgreSQL.

1. **Install.** Unzip `tapi-mvp-sprint8-slice7-audit-fixes.zip`, then `npm ci`.
2. **Create the secrets.** Generate two values and put them in `.env` (or your host's secret store):
   ```bash
   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   ```
   - `FIELD_ENCRYPTION_KEYS=k1:<first value>`
   - `INTERNAL_SERVICE_TOKEN=<second value>`

   Back the encryption key up somewhere safe and separate. **If it is lost, the stored passports cannot be recovered.**
3. **Migrate.** `npm run migrate` (applies 016 and 017).
4. **Encrypt existing passports.**
   ```bash
   npm run passports:encrypt -- --dry-run      # counts only
   npm run passports:encrypt                   # does it
   ```
   Then confirm none are left in plaintext (expect 0):
   ```sql
   SELECT count(*) FROM travelers WHERE passport_number IS NOT NULL;
   ```
   The script prints counts, never values, and is safe to run again.
5. **Run the tests.**
   ```bash
   npm run test:unit
   TEST_DATABASE_URL=postgres://... npm test
   cd web && npm test
   ```
   Send me any failures, especially from `audit`, `identity` and `fulfilment`.
6. **Prove the safety checks work.** Both of these must **fail** to start:
   ```bash
   NODE_ENV=production node -e "require('./src/app')"        # no keys set: must refuse
   NODE_ENV=production INTERNAL_SERVICE_TOKEN=short FIELD_ENCRYPTION_KEYS=k1:$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") node -e "require('./src/app')"   # token too short: must refuse
   ```
7. **Rehearse a key rotation** on a copy of the data. Add a new key in front (`FIELD_ENCRYPTION_KEYS=k2:<new>,k1:<old>`), restart, run `npm run passports:encrypt -- --rotate`, check a passport still reveals correctly, and only then remove the old key.
8. **Later, once step 4 shows 0:** drop the plaintext `travelers.passport_number` column in a new migration.

## 5. Still open

- **Rate limits per instance (F).** Fix before running more than one server.
- **Payments (step 3).** The original code already has a payment-provider interface with a mock. Paystack goes behind it.
- **LetsFG.** Not verified in sandbox. Everything about supplier failures above assumes its codes.
- **Other places passport data might be copied.** I found plaintext only in `travelers`. The original code redacts supplier audit logs. Please check any new tables you add.
