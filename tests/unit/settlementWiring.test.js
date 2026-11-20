// Source-level guards for the settlement wiring (routes/repos cannot be executed without express/pg here).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const SRC = (p) => fs.readFileSync(path.join(__dirname, "../../", p), "utf8");

test("migration 020: append-only ledger, unique idempotency keys, FX quotes, payment statuses", () => {
  const sql = SRC("src/db/migrations/020_ledger_fx_settlement.sql");
  assert.match(sql, /idempotency_key\s+TEXT NOT NULL UNIQUE/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON ledger_entries/);
  assert.match(sql, /RAISE EXCEPTION 'ledger_entries is append-only/);
  for (const k of ["authorization", "capture_requested", "capture", "capture_failed", "void", "refund_requested", "refund", "refund_failed"]) assert.match(sql, new RegExp(`'${k}'`));
  for (const s of ["authorized", "capture_failed", "voided"]) assert.match(sql, new RegExp(`'${s}'`));
  assert.match(sql, /consumed_at\s+TIMESTAMPTZ/);
  assert.match(sql, /buffer_bps BETWEEN 0 AND 1000/);
  assert.match(sql, /backfill-capture/); // historical captured payments get ledger entries
});

test("every payment status the code can write is allowed by the newest payments_status_check", () => {
  const sql = SRC("src/db/migrations/020_ledger_fx_settlement.sql");
  const allowed = sql.match(/payments_status_check\s+CHECK \(status IN \(([^)]*)\)/)[1].match(/'([a-z_]+)'/g).map((x) => x.replace(/'/g, ""));
  const repo = SRC("src/repositories/index.js");
  for (const m of repo.matchAll(/status='([a-z_]+)'/g)) if (["captured", "authorized", "capture_failed", "voided", "failed", "refunded"].includes(m[1])) assert.ok(allowed.includes(m[1]), m[1]);
  for (const s of ["pending", "authorized", "captured", "capture_failed", "voided", "failed", "refunded", "disputed"]) assert.ok(allowed.includes(s), s);
});

test("webhook: authorised events are amount-checked before they are recorded, and do not mark the order paid", () => {
  const r = SRC("src/routes/payments.routes.js");
  const auth = r.slice(r.indexOf('event.status === "authorized"'), r.indexOf('event.status === "captured"'));
  assert.match(auth, /WEBHOOK_AMOUNT_MISMATCH/);
  assert.match(auth, /markAuthorizedFromWebhook/);
  assert.doesNotMatch(auth, /OrderPaid|status='paid'/);
});

test("capture via webhook writes the ledger entry in the same transaction as the status change", () => {
  const repo = SRC("src/repositories/index.js");
  const fn = repo.slice(repo.indexOf("async markCapturedAndOrderPaid"), repo.indexOf("async markFailedFromWebhook"));
  assert.match(fn, /withTransaction/);
  assert.match(fn, /INSERT INTO ledger_entries/);
  assert.match(fn, /captured_minor=\$3/);
});

test("settlement completion is a single transaction guarded by the unique ledger key", () => {
  const repo = SRC("src/repositories/index.js");
  const fn = repo.slice(repo.indexOf("async applySettlementCompletion"), repo.indexOf("async findSettlementCandidates"));
  assert.match(fn, /withTransaction/);
  assert.match(fn, /ON CONFLICT \(idempotency_key\) DO NOTHING RETURNING id/);
  assert.match(fn, /if \(!ins\[0\]\) return \{ duplicate: true \}/);
});

test("executor order: ledger request is written BEFORE the provider call, completion AFTER", () => {
  const ex = SRC("src/services/settlementExecutor.js");
  const req = ex.indexOf("_requested`");
  const call = ex.indexOf("provider[action.type]");
  const done = ex.indexOf("applySettlementCompletion");
  assert.ok(req > 0 && call > req && done > call);
});

test("outbox handlers run settlement for booking events; the sweeper has its own advisory lock", () => {
  const d = SRC("src/scripts/dispatchOutbox.js");
  assert.match(d, /settleForBookingEvent/);
  assert.ok(d.split("await settleForBookingEvent(row)").length - 1 >= 2, "both the specific and the fallback handler settle");
  const keys = ["reconcile.js", "pollBookings.js", "dispatchOutbox.js", "settleSweep.js"].map((f) => SRC(`src/scripts/${f}`).match(/LOCK_KEY = (\d+)/)[1]);
  assert.equal(new Set(keys).size, 4);
});

test("static FX provider cannot be wired in production by accident", () => {
  assert.match(SRC("src/services/fxProvider.interface.js"), /disabled in production/);
});
