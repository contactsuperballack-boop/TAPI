// Test setup shared by the suite. Requires TEST_DATABASE_URL pointing at a
// real (throwaway) Postgres — these are integration tests against the
// actual schema/constraints, not mocks of the DB layer, since the P0 bug
// this review caught was in raw SQL and a mocked DB would never have found it.
require("dotenv").config();

// Fix for a confirmed test-environment problem: dozens of test cases
// hitting the same tenant within one suite exhausted real rate limits
// partway through, so later tests got 429 instead of the response they
// were actually asserting on. Set once, here, before any test file
// requires app.js — every test file imports this module first.
process.env.DISABLE_RATE_LIMIT = "true";

const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

const TEST_DB_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

async function resetDatabase() {
  const pool = new Pool({ connectionString: TEST_DB_URL });
  const client = await pool.connect();
  try {
    await client.query(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
    const dir = path.join(__dirname, "../src/db/migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      await client.query(fs.readFileSync(path.join(dir, file), "utf8"));
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function seedAgency(agencyName = "Test Agency") {
  // Fix for a confirmed open-handle leak: this used to do
  // `new Pool({...}).query(...)` — a brand-new, never-closed connection
  // pool on every single call. seedAgency is called multiple times per
  // test file (once per agency needed for isolation tests), so this leaked
  // a growing number of open TCP connections that Jest correctly flagged as
  // open handles after the suite finished. Uses the shared db module (the
  // same one the app itself uses) instead of creating throwaway pools.
  const db = require("../src/db");
  const { rows } = await db.query(`INSERT INTO agencies (name) VALUES ($1) RETURNING id`, [agencyName]);
  const agencyId = rows[0].id;

  // Goes through the real ApiKeys service rather than a raw INSERT — this is
  // exactly what broke last round: migration 004 made key_prefix NOT NULL,
  // but this raw insert didn't know that and 50 tests failed at seeding,
  // before any actual route logic ran. Using the same code path production
  // uses means a future schema change can't silently desync test setup
  // from reality again.
  const { ApiKeys } = require("../src/services/apiKeys");
  const { rawKey } = await ApiKeys.create({ agencyId, label: "test seed", env: "test" });

  return { agencyId, apiKey: rawKey };
}

/**
 * Closes the shared app-wide connection pool (src/db/index.js). This is
 * the pool the app itself uses for every query during a test run — nothing
 * else ever closes it, which is the other half of the open-handles issue
 * (the first half was the leaked per-call pools in seedAgency, fixed above).
 * Call this in each test file's afterAll.
 */
async function closeDb() {
  const db = require("../src/db");
  await db.pool.end();
}

module.exports = { resetDatabase, seedAgency, closeDb, TEST_DB_URL };
