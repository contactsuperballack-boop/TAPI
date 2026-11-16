require("dotenv").config();
const app = require("./app");
const db = require("./db");

const port = process.env.PORT || 3000;
const server = app.listen(port, () => {
  console.log(`TAPI listening on :${port}`);
});

// Clean shutdown (Master Spec §19 territory — "operational recovery"). An
// orchestrator (Kubernetes, ECS, etc.) sends SIGTERM before killing a
// process during a deploy/scale-down. Without handling it, in-flight
// requests get dropped mid-booking and the DB pool's connections aren't
// released cleanly. Order matters: stop accepting NEW connections first,
// let in-flight ones finish, THEN close the DB pool, THEN exit.
const SHUTDOWN_TIMEOUT_MS = 15_000;

function shutdown(signal) {
  console.log(`[shutdown] received ${signal}, closing gracefully...`);

  const forceExitTimer = setTimeout(() => {
    console.error(`[shutdown] did not close within ${SHUTDOWN_TIMEOUT_MS}ms, forcing exit`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExitTimer.unref(); // don't let this timer itself keep the process alive if shutdown succeeds first

  server.close(async (err) => {
    if (err) {
      console.error("[shutdown] error closing HTTP server:", err);
    }
    try {
      await db.pool.end();
      console.log("[shutdown] database pool closed");
    } catch (dbErr) {
      console.error("[shutdown] error closing database pool:", dbErr);
    }
    clearTimeout(forceExitTimer);
    process.exit(err ? 1 : 0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

module.exports = server;
