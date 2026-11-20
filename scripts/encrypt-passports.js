#!/usr/bin/env node
// Encrypts legacy plaintext passport numbers, or re-encrypts rows under the current key after a key rotation.
//   npm run passports:encrypt                 encrypt rows that still have plaintext
//   npm run passports:encrypt -- --rotate     also re-encrypt rows sealed with an older key
//   npm run passports:encrypt -- --dry-run    count only, change nothing
// Safe to run repeatedly and while the app is running. Prints counts only, never values. Exit code 1 if any row failed.
const BATCH = 200;

// repo: { fetch(mode, currentKeyId, limit, afterId) -> rows, save(row, enc, last4, mode) -> bool }
async function run({ repo, crypto, mode = "encrypt", dryRun = false, log = console.log }) {
  let done = 0, failed = 0, skipped = 0, after = null;
  for (;;) {
    const rows = await repo.fetch(mode, crypto.currentId, BATCH, after);
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.id;
      try {
        const plain = row.passport_number_enc ? crypto.decrypt(row.passport_number_enc, `traveler:${row.id}:passport`) : String(row.passport_number).replace(/\s+/g, "").toUpperCase();
        const enc = crypto.encrypt(plain, `traveler:${row.id}:passport`);
        if (crypto.decrypt(enc, `traveler:${row.id}:passport`) !== plain) throw new Error("round-trip mismatch"); // never null the plaintext unless we can read it back
        if (dryRun) { skipped++; continue; }
        if (await repo.save(row, enc, plain.slice(-4), mode)) done++; else skipped++; // changed underneath us: leave for the next run
      } catch (e) { failed++; log(`row ${row.id}: ${e.code || e.message}`); }
    }
    if (rows.length < BATCH) break;
  }
  log(`${dryRun ? "dry run: would process" : "processed"} ${dryRun ? skipped : done}, skipped ${dryRun ? 0 : skipped}, failed ${failed}`);
  return { done, failed, skipped };
}

function sqlRepo(db) {
  return {
    async fetch(mode, currentKeyId, limit, afterId) {
      const where = mode === "rotate"
        ? `(passport_number IS NOT NULL AND passport_number_enc IS NULL) OR (passport_number_enc IS NOT NULL AND passport_number_enc NOT LIKE $3)`
        : `passport_number IS NOT NULL AND passport_number_enc IS NULL`;
      const params = mode === "rotate" ? [afterId, limit, `v1.${currentKeyId}.%`] : [afterId, limit];
      const { rows } = await db.query(`SELECT id, passport_number, passport_number_enc FROM travelers WHERE ($1::uuid IS NULL OR id > $1::uuid) AND (${where}) ORDER BY id LIMIT $2`, params);
      return rows;
    },
    // Guarded: only writes if the row still looks the way we read it, so a concurrent edit is never overwritten.
    async save(row, enc, last4) {
      const { rowCount } = await db.query(
        `UPDATE travelers SET passport_number_enc=$2, passport_last4=$3, passport_number=NULL WHERE id=$1 AND passport_number IS NOT DISTINCT FROM $4 AND passport_number_enc IS NOT DISTINCT FROM $5`,
        [row.id, enc, last4, row.passport_number ?? null, row.passport_number_enc ?? null]);
      return rowCount === 1;
    },
  };
}

if (require.main === module) {
  require("dotenv").config?.();
  const db = require("../src/db"); const { getFieldCrypto } = require("../src/services/fieldCrypto");
  const args = process.argv.slice(2);
  run({ repo: sqlRepo(db), crypto: getFieldCrypto(), mode: args.includes("--rotate") ? "rotate" : "encrypt", dryRun: args.includes("--dry-run") })
    .then((r) => db.pool.end().then(() => process.exit(r.failed ? 1 : 0)))
    .catch((e) => { console.error(e.code || e.message); process.exit(1); });
}
module.exports = { run, sqlRepo };
