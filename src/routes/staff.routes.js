// Agency team management (admin only). Staff are people who act on behalf of the agency's clients.
const express = require("express");
const { Identity } = require("../repositories/identity");
const { getAuthService } = require("../services/authContainer");
const { ApiError, Errors } = require("../domain/errors");

const router = express.Router();

router.get("/", async (req, res, next) => {
  try {
    const rows = await Identity.listStaff(req.tenant.agencyId);
    res.json({ staff: rows.map((r) => ({ membershipId: r.membership_id, userId: r.user_id, email: r.email, fullName: r.full_name, role: r.role, status: r.status,
      emailVerified: !!r.email_verified_at, inviteAccepted: r.has_password })) });
  } catch (err) { next(err); }
});

router.post("/", async (req, res, next) => {
  try {
    const b = req.body || {};
    const out = await getAuthService().inviteStaff({ agencyId: req.tenant.agencyId, email: b.email, fullName: b.fullName, role: b.role });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

router.patch("/:membershipId", async (req, res, next) => {
  try {
    const status = req.body && req.body.status;
    if (!["active", "disabled"].includes(status)) throw new ApiError("VALIDATION_ERROR", 400, "Invalid request", "status must be active or disabled");
    if (status === "disabled") {
      if (req.principal.type === "session") {
        const mine = (await Identity.listStaff(req.tenant.agencyId)).find((r) => r.membership_id === req.params.membershipId);
        if (mine && mine.user_id === req.principal.userId) throw new ApiError("VALIDATION_ERROR", 400, "Invalid request", "You cannot disable your own access.");
      }
      const target = (await Identity.listStaff(req.tenant.agencyId)).find((r) => r.membership_id === req.params.membershipId);
      if (target && target.role === "admin" && target.status === "active" && (await Identity.countActiveAdmins(req.tenant.agencyId)) <= 1) {
        throw new ApiError("VALIDATION_ERROR", 400, "Invalid request", "An agency must keep at least one active admin.");
      }
    }
    const row = await Identity.setMembershipStatus(req.params.membershipId, req.tenant.agencyId, status);
    if (!row) throw Errors.NotFound("Team member");
    res.json({ membershipId: row.id, status });
  } catch (err) { next(err); }
});

module.exports = router;
