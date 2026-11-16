const { Pool, types } = require("pg");

// node-postgres returns NUMERIC columns (price, total_price, markup_amount,
// etc.) as strings by default — this is documented driver behavior, not a
// bug in postgres itself, but it silently breaks the OpenAPI contract
// (which declares these fields as `number`) and any test asserting
// `res.body.totalPrice === 555` rather than `"555"`. Fixed once, centrally,
// here — NOT at each call site, so a new NUMERIC column added later doesn't
// require remembering to convert it everywhere it's read.
// OID 1700 = NUMERIC. parseFloat is fine for money at this scale; if TAPI
// ever needs exact decimal arithmetic beyond what float64 safely represents
// (very large totals, many currencies with odd minor-unit rules), revisit
// with a proper decimal library instead of parseFloat.
types.setTypeParser(1700, (val) => (val === null ? null : parseFloat(val)));

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

/**
 * Runs fn inside a BEGIN/COMMIT transaction, passing a client whose .query
 * has the same (text, params) signature as the module-level query() below.
 * Rolls back on any thrown error. Used where "Internal order state changes
 * must be transactional where possible" (Master Spec §12) — e.g. marking a
 * payment captured and the order paid must not be two independent writes
 * that could partially succeed.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn({ query: (text, params) => client.query(text, params) });
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  query: (text, params) => pool.query(text, params),
  withTransaction,
  pool,
};
