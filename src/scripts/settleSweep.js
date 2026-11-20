#!/usr/bin/env node
// Settlement sweep (Sprint 10.6): re-drives in-doubt captures/voids/refunds (same idempotency keys, so safe) and watches
// authorisations that are about to lapse while bookings are unresolved. `--once` for cron. Lock key 875309004.
require("dotenv").config();
const db = require("../db");
const { Payments } = require("../repositories");
const { getPaymentProvider } = require("../services/paymentProviderRegistry");
const { settleOrder } = require("../services/settlementService");

const LOCK_KEY = 875309004;
const INTERVAL_MS = Number(process.env.SETTLE_INTERVAL_MS) || 60_000;
const once = process.argv.includes("--once");
let stopping = false;

async function main() {
  const lock = await db.pool.connect();
  const { rows } = await lock.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
  if (!rows[0].ok) { console.log("[settle] another sweeper holds the lock — exiting"); lock.release(); await db.pool.end(); return; }
  process.on("SIGTERM", () => { stopping = true; });
  process.on("SIGINT", () => { stopping = true; });
  try {
    do {
      const candidates = await Payments.findSettlementCandidates(50);
      const summary = {};
      for (const p of candidates) {
        if (stopping) break;
        try { const r = await settleOrder(p.order_id, { provider: getPaymentProvider() }); summary[r.state] = (summary[r.state] || 0) + 1; }
        catch (err) { summary.error = (summary.error || 0) + 1; console.error(JSON.stringify({ event: "settle_error", paymentId: p.id, error: err.message })); }
      }
      console.log(JSON.stringify({ event: "settle_pass", candidates: candidates.length, summary }));
      if (once || stopping) break;
      await new Promise((r) => setTimeout(r, INTERVAL_MS));
    } while (!stopping);
  } finally {
    await lock.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    lock.release(); await db.pool.end();
  }
}
main().catch((e) => { console.error("[settle] fatal:", e); process.exit(1); });
