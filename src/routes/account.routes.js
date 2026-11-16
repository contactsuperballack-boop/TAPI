// Public sign-up / sign-in endpoints, plus the signed-in user's own account calls.
// Mounted at /v1/account. Public routes are rate limited per IP and answer identically whether or not an
// address is already registered (see services/authService.js).
const express = require("express");
const { authenticate } = require("../middleware/auth");
const { perIpLimiter } = require("../middleware/rateLimiter");
const { getAuthService } = require("../services/authContainer");
const { ApiError } = require("../domain/errors");

const router = express.Router();
const bad = (d) => new ApiError("VALIDATION_ERROR", 400, "Invalid request", d);
const str = (v, max = 200) => (typeof v === "string" && v.length <= max ? v : "");
const rawToken = (req) => (req.header("Authorization") || "").replace(/^Bearer\s+/i, "");

router.post("/signup", perIpLimiter({ name: "acct-signup", capacity: 5, refillPerSecond: 0.02 }), async (req, res, next) => {
  try {
    const b = req.body || {};
    res.status(202).json(await getAuthService().signupTraveller({ email: str(b.email), password: str(b.password, 128), firstName: str(b.firstName, 80), lastName: str(b.lastName, 80) }));
  } catch (err) { next(err); }
});

router.post("/login", perIpLimiter({ name: "acct-login", capacity: 10, refillPerSecond: 0.1 }), async (req, res, next) => {
  try {
    const b = req.body || {};
    res.json(await getAuthService().login({ email: str(b.email), password: str(b.password, 128), membershipId: str(b.membershipId, 64) || undefined, ip: req.ip, userAgent: req.header("User-Agent") }));
  } catch (err) { next(err); }
});

router.post("/verify-email", perIpLimiter({ name: "acct-verify", capacity: 10, refillPerSecond: 0.1 }), async (req, res, next) => {
  try { res.json(await getAuthService().verifyEmail(str(req.body && req.body.token, 200))); } catch (err) { next(err); }
});

router.post("/password-reset/request", perIpLimiter({ name: "acct-reset-req", capacity: 5, refillPerSecond: 0.02 }), async (req, res, next) => {
  try { res.status(202).json(await getAuthService().requestPasswordReset({ email: str(req.body && req.body.email) })); } catch (err) { next(err); }
});

router.post("/password-reset/confirm", perIpLimiter({ name: "acct-reset-confirm", capacity: 10, refillPerSecond: 0.1 }), async (req, res, next) => {
  try { const b = req.body || {}; res.json(await getAuthService().setPasswordWithToken({ token: str(b.token, 200), password: str(b.password, 128) })); } catch (err) { next(err); }
});

// --- signed-in ---
router.get("/me", authenticate, (req, res) => {
  const p = req.principal;
  if (p.type !== "session") return res.json({ type: p.type, role: p.role, agencyId: p.agencyId });
  res.json({ type: "session", ...getAuthService().sessionView(p) });
});

router.post("/logout", authenticate, async (req, res, next) => {
  try {
    if (req.principal.type !== "session") throw bad("Only signed-in users have a session to end.");
    await getAuthService().logout(rawToken(req));
    res.json({ status: "signed_out" });
  } catch (err) { next(err); }
});

router.post("/resend-verification", authenticate, perIpLimiter({ name: "acct-resend", capacity: 3, refillPerSecond: 0.01 }), async (req, res, next) => {
  try {
    if (req.principal.type !== "session") throw bad("Only signed-in users can verify an email.");
    res.status(202).json(await getAuthService().resendVerification(req.principal.userId));
  } catch (err) { next(err); }
});

module.exports = router;
