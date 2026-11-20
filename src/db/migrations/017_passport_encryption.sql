-- Passport numbers are encrypted at rest (AES-256-GCM, see services/fieldCrypto.js). The application no longer
-- writes the plaintext column. Existing rows are converted by `npm run passports:encrypt` (needs the key, so it
-- cannot be done in SQL). Once that reports 0 plaintext rows left, the plaintext column can be dropped in a later migration.
ALTER TABLE travelers ADD COLUMN passport_number_enc TEXT;
ALTER TABLE travelers ADD COLUMN passport_last4 TEXT;
COMMENT ON COLUMN travelers.passport_number IS 'LEGACY plaintext. Not written by the app. Run npm run passports:encrypt, then drop.';
