// Account logic: sign-up, login, email verification, password reset, staff invites, session lookup.
// Pure of Express and of SQL: `repo` and `mailer` are injected, so the security behaviour can be unit tested.
const { ApiError } = require("../domain/errors");
const { hashPassword, verifyPassword, passwordProblem } = require("./passwords");
const { generateToken, hashToken } = require("./tokens");

const HOUR = 3600_000;
const SESSION_TTL_MS = 7 * 24 * HOUR;
const VERIFY_TTL_MS = 24 * HOUR;
const RESET_TTL_MS = 1 * HOUR;
const INVITE_TTL_MS = 7 * 24 * HOUR;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
const TOUCH_EVERY_MS = 5 * 60_000;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
const ROLE_PRIORITY = { admin: 0, agent: 1, traveller: 2 };

const bad = (detail, code = "VALIDATION_ERROR") => new ApiError(code, 400, "Invalid request", detail);
const GENERIC_LOGIN = () => new ApiError("INVALID_CREDENTIALS", 401, "Sign-in failed", "Email or password is incorrect.");
const normEmail = (e) => String(e || "").trim().toLowerCase();

function createAuthService({ repo, mailer, baseUrl = "http://localhost:3000", now = () => new Date(), hash = hashPassword, verify = verifyPassword }) {
  const link = (path, token) => `${baseUrl}/app/#/${path}?token=${encodeURIComponent(token)}`;
  const needMailer = () => { if (!mailer) throw new ApiError("EMAIL_NOT_CONFIGURED", 503, "Email unavailable", "Email delivery is not configured for this deployment, so accounts cannot be created or verified yet."); };

  async function issueToken(userId, purpose, ttl) {
    await repo.invalidateTokens(userId, purpose);
    const t = generateToken(purpose);
    await repo.saveToken({ userId, purpose, hash: t.hash, expiresAt: new Date(now().getTime() + ttl) });
    return t.raw;
  }

  // Sending can fail (provider down, bad sender setup). Never lose the account over it and never leak why:
  //  - sign-up / password reset: the answer must stay generic, so failures are logged and swallowed;
  //  - resend / invite: the caller is told to try again.
  async function deliver(message, { critical }) {
    try { await mailer.send(message); return true; }
    catch (err) {
      console.error(`[mail] send failed (${err.code || "error"}): ${err.message}`);
      if (critical) throw new ApiError("EMAIL_SEND_FAILED", 502, "Email could not be sent", "We could not send the email just now. Please try again in a moment.");
      return false;
    }
  }

  function view(p) {
    return { userId: p.userId, fullName: p.fullName, email: p.email, role: p.role, agencyId: p.agencyId, agencyName: p.agencyName, agencyKind: p.agencyKind,
      travelerId: p.travelerId || null, emailVerified: !!p.emailVerified, travellerSelfBooking: p.travellerSelfBooking !== false };
  }

  return {
    async signupTraveller({ email, password, firstName, lastName }) {
      email = normEmail(email);
      if (!EMAIL_RE.test(email)) throw bad("Enter a valid email address.");
      if (!firstName || !lastName || String(firstName).trim().length < 1 || String(lastName).trim().length < 1) throw bad("First and last name are required.");
      const problem = passwordProblem(password, { email, fullName: `${firstName} ${lastName}` });
      if (problem) throw bad(problem, "WEAK_PASSWORD");
      needMailer();
      const passwordHash = await hash(password);
      let account;
      try { account = await repo.createTravellerAccount({ email, passwordHash, firstName: String(firstName).trim(), lastName: String(lastName).trim() }); }
      catch (err) { if (err.code === "EMAIL_TAKEN") return { status: "verification_sent" }; throw err; } // same answer either way: no account enumeration
      const raw = await issueToken(account.user.id, "verify_email", VERIFY_TTL_MS);
      await deliver({ to: email, subject: "Confirm your email for TAPI", text: `Hi ${firstName},\n\nConfirm your email to book trips:\n${link("verify", raw)}\n\nThe link works once and expires in 24 hours. If you did not sign up, ignore this email.` }, { critical: false });
      return { status: "verification_sent" };
    },

    async login({ email, password, membershipId, ip, userAgent }) {
      email = normEmail(email);
      const user = EMAIL_RE.test(email) ? await repo.findUserByEmail(email) : null;
      if (!user || !user.password_hash || user.status !== "active") { await verify(String(password || ""), "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + "A".repeat(86) + "=="); throw GENERIC_LOGIN(); } // burn comparable time
      if (user.locked_until && new Date(user.locked_until) > now()) throw new ApiError("TOO_MANY_ATTEMPTS", 429, "Too many attempts", `Too many failed sign-ins. Try again in ${LOCK_MINUTES} minutes or reset your password.`);
      const ok = await verify(String(password || ""), user.password_hash);
      if (!ok) { await repo.recordFailedLogin(user.id, { max: MAX_FAILED_LOGINS, lockMinutes: LOCK_MINUTES, now: now() }); throw GENERIC_LOGIN(); }
      await repo.resetFailedLogins(user.id);
      const memberships = (await repo.listMemberships(user.id)).sort((a, b) => ROLE_PRIORITY[a.role] - ROLE_PRIORITY[b.role]);
      if (memberships.length === 0) throw new ApiError("NO_ACCESS", 403, "No access", "This account is not linked to any agency.");
      const m = membershipId ? memberships.find((x) => x.id === membershipId) : memberships[0];
      if (!m) throw bad("That membership is not available for this account.");
      const t = generateToken("session");
      await repo.createSession({ userId: user.id, membershipId: m.id, tokenHash: t.hash, expiresAt: new Date(now().getTime() + SESSION_TTL_MS), ip, userAgent });
      const principal = { userId: user.id, fullName: user.full_name, email: user.email, role: m.role, agencyId: m.agency_id, agencyName: m.agency_name, agencyKind: m.agency_kind, travelerId: m.traveler_id, emailVerified: !!user.email_verified_at, travellerSelfBooking: m.traveller_self_booking };
      return { token: t.raw, expiresAt: new Date(now().getTime() + SESSION_TTL_MS), principal: view(principal), memberships: memberships.map((x) => ({ id: x.id, role: x.role, agencyName: x.agency_name })) };
    },

    // Resolve a bearer session token into a principal, or null. Never throws on a bad token.
    async authenticateSession(raw) {
      const row = await repo.findSession(hashToken(raw));
      if (!row || row.revoked_at || new Date(row.expires_at) <= now()) return null;
      if (row.user_status !== "active" || row.membership_status !== "active" || row.agency_status !== "active") return null;
      if (!row.last_used_at || now() - new Date(row.last_used_at) > TOUCH_EVERY_MS) repo.touchSession(row.id).catch(() => {});
      return { type: "session", sessionId: row.id, userId: row.user_id, role: row.role, agencyId: row.agency_id, travelerId: row.traveler_id || null,
        emailVerified: !!row.email_verified_at, fullName: row.full_name, email: row.email, agencyName: row.agency_name, agencyKind: row.agency_kind,
        travellerSelfBooking: row.traveller_self_booking, actor: `user:${row.user_id}` };
    },
    sessionView: view,

    async logout(raw) { await repo.revokeSession(hashToken(raw)); },

    async verifyEmail(raw) {
      const userId = await repo.consumeToken({ hash: hashToken(String(raw || "")), purposes: ["verify_email"], now: now() });
      if (!userId) throw bad("This link has expired or was already used. Request a new one from your account.", "INVALID_TOKEN");
      await repo.markEmailVerified(userId);
      return { status: "verified" };
    },

    async resendVerification(userId) {
      needMailer();
      const user = await repo.findUserById(userId);
      if (!user || user.email_verified_at) return { status: "ok" };
      const raw = await issueToken(userId, "verify_email", VERIFY_TTL_MS);
      await deliver({ to: user.email, subject: "Confirm your email for TAPI", text: `Confirm your email:\n${link("verify", raw)}\n\nThe link works once and expires in 24 hours.` }, { critical: true });
      return { status: "ok" };
    },

    async requestPasswordReset({ email }) {
      email = normEmail(email);
      needMailer();
      const user = EMAIL_RE.test(email) ? await repo.findUserByEmail(email) : null;
      if (user && user.status === "active") {
        const raw = await issueToken(user.id, "reset_password", RESET_TTL_MS);
        await deliver({ to: user.email, subject: "Reset your TAPI password", text: `Reset your password:\n${link("reset", raw)}\n\nThe link works once and expires in 1 hour. If you did not ask for this, ignore it.` }, { critical: false });
      }
      return { status: "ok" }; // identical whether or not the account exists
    },

    // Used for both password reset and accepting a staff invite.
    async setPasswordWithToken({ token, password }) {
      const hashed = hashToken(String(token || ""));
      const userId = await repo.peekToken({ hash: hashed, purposes: ["reset_password", "invite"], now: now() });
      if (!userId) throw bad("This link has expired or was already used. Ask for a new one.", "INVALID_TOKEN");
      const user = await repo.findUserById(userId);
      const problem = passwordProblem(password, { email: user.email, fullName: user.full_name });
      if (problem) throw bad(problem, "WEAK_PASSWORD");
      const consumed = await repo.consumeToken({ hash: hashed, purposes: ["reset_password", "invite"], now: now() });
      if (!consumed) throw bad("This link has expired or was already used. Ask for a new one.", "INVALID_TOKEN");
      await repo.setPassword(userId, await hash(password));
      await repo.markEmailVerified(userId); // they proved they control the inbox
      await repo.revokeAllSessions(userId);
      return { status: "password_set" };
    },

    async inviteStaff({ agencyId, email, fullName, role }) {
      email = normEmail(email);
      if (!EMAIL_RE.test(email)) throw bad("Enter a valid email address.");
      if (!fullName || fullName.trim().length < 2) throw bad("Full name is required.");
      if (!["agent", "admin"].includes(role)) throw bad("role must be agent or admin.");
      needMailer();
      let created;
      try { created = await repo.createStaffAccount({ agencyId, email, fullName: fullName.trim(), role }); }
      catch (err) {
        if (err.code !== "ALREADY_MEMBER") throw err;
        // A member who never accepted their invite (e.g. the email failed to send) can be re-invited: issue a fresh link.
        const existing = await repo.findUserByEmail(email);
        if (existing && !existing.password_hash) {
          const raw = await issueToken(existing.id, "invite", INVITE_TTL_MS);
          await deliver({ to: email, subject: "Your invitation to TAPI", text: `Set your password:\n${link("reset", raw)}\n\nThe link works once and expires in 7 days.` }, { critical: true });
          return { userId: existing.id, role, email, invited: true, resent: true };
        }
        throw new ApiError("ALREADY_MEMBER", 409, "Already a member", "This person already has access to your agency.");
      }
      const { user, membership, isNewUser } = created;
      if (isNewUser) {
        const raw = await issueToken(user.id, "invite", INVITE_TTL_MS);
        await deliver({ to: email, subject: "You have been invited to TAPI", text: `You have been added as ${role}. Set your password:\n${link("reset", raw)}\n\nThe link works once and expires in 7 days.` }, { critical: true });
      } else {
        await deliver({ to: email, subject: "You have been added to an agency on TAPI", text: `You now have ${role} access to another agency. Sign in and choose it.` }, { critical: false });
      }
      return { userId: user.id, membershipId: membership.id, role, email, invited: isNewUser };
    },
  };
}

module.exports = { createAuthService, MAX_FAILED_LOGINS, LOCK_MINUTES, SESSION_TTL_MS };
