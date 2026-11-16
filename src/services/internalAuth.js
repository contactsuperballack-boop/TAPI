// Server-only credential for TAPI calling its own HTTP API (so tenant scoping, rate limits, audit and
// idempotency still apply to agent bookings). It is never sent to a browser. The tenant is taken from the
// caller's already-verified session or API key, so a traveller's token never reaches the booking endpoints.
const crypto = require("crypto");

let token;
function getServiceToken(env = process.env) {
  if (token) return token;
  const fromEnv = env.INTERNAL_SERVICE_TOKEN;
  if (fromEnv && fromEnv.length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must be at least 32 characters");
  if (!fromEnv && env.NODE_ENV === "production") console.warn("[auth] INTERNAL_SERVICE_TOKEN is not set; using a random per-process token. Set it if you run more than one instance.");
  token = `svc_${fromEnv || crypto.randomBytes(32).toString("base64url")}`;
  return token;
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
