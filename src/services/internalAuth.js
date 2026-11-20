// Server-only credential for TAPI calling its own HTTP API (so tenant scoping, rate limits, audit and
// idempotency still apply to agent bookings). It is never sent to a browser. The tenant is taken from the
// caller's already-verified session or API key, so a traveller's token never reaches the booking endpoints.
const crypto = require("crypto");

let token;
function getServiceToken(env = process.env) {
  if (token && env === process.env) return token;
  const fromEnv = env.INTERNAL_SERVICE_TOKEN;
  if (fromEnv && fromEnv.length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must be at least 32 characters");
  // In production a random per-process token breaks multi-instance deploys, and the token is the ONLY real control
  // (the loopback check cannot tell a same-host reverse proxy from a local caller). Refuse to start without it.
  if (!fromEnv && env.NODE_ENV === "production") throw new Error("INTERNAL_SERVICE_TOKEN is required in production (32+ random characters)");
  const made = `svc_${fromEnv || crypto.randomBytes(32).toString("base64url")}`;
  if (env === process.env) token = made;
  return made;
}
function isServiceToken(candidate) {
  const real = Buffer.from(getServiceToken());
  const given = Buffer.from(String(candidate || ""));
  return given.length === real.length && crypto.timingSafeEqual(given, real);
}
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
// socket peer, not req.ip: req.ip honours X-Forwarded-For and can be spoofed by a client.
const fromLoopback = (req) => LOOPBACK.has(req.socket && req.socket.remoteAddress);
module.exports = { getServiceToken, isServiceToken, fromLoopback };
