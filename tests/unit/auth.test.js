const test = require("node:test");
const assert = require("node:assert/strict");
const { createAuthService, MAX_FAILED_LOGINS } = require("../../src/services/authService");
const { createMailer } = require("../../src/services/mailer");
const { hashPassword, verifyPassword, passwordProblem } = require("../../src/services/passwords");
const { hashToken } = require("../../src/services/tokens");
const { travellerMayCall, canAccessTrip, checkApprover } = require("../../src/domain/access");

// In-memory repo with the same semantics the SQL repo must have (esp. single-use tokens, lockout, revocation).
function fakeRepo() {
  const s = { users: [], memberships: [], tokens: [], sessions: [], seq: 0 };
  const id = () => `id${++s.seq}`;
  const agencies = { house: { id: "house", name: "TAPI Direct", kind: "house", status: "active", traveller_self_booking: true }, a1: { id: "a1", name: "Acme Travel", kind: "agency", status: "active", traveller_self_booking: true } };
  const repo = {
    s, agencies,
    async findUserByEmail(e) { return s.users.find((u) => u.email.toLowerCase() === e.toLowerCase()) || null; },
    async findUserById(i) { return s.users.find((u) => u.id === i) || null; },
    async createTravellerAccount({ email, passwordHash, firstName, lastName }) {
      if (s.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) throw Object.assign(new Error("dup"), { code: "EMAIL_TAKEN" });
      const user = { id: id(), email, password_hash: passwordHash, full_name: `${firstName} ${lastName}`, email_verified_at: null, status: "active", failed_logins: 0, locked_until: null };
      s.users.push(user);
      const m = { id: id(), user_id: user.id, agency_id: "house", role: "traveller", traveler_id: id(), status: "active" };
      s.memberships.push(m); return { user, membership: m };
    },
    async createStaffAccount({ agencyId, email, fullName, role }) {
      let user = s.users.find((u) => u.email.toLowerCase() === email.toLowerCase()); let isNewUser = false;
      if (!user) { user = { id: id(), email, password_hash: null, full_name: fullName, email_verified_at: null, status: "active", failed_logins: 0, locked_until: null }; s.users.push(user); isNewUser = true; }
      if (s.memberships.some((x) => x.user_id === user.id && x.agency_id === agencyId)) throw Object.assign(new Error("already a member"), { code: "ALREADY_MEMBER" }); // UNIQUE (user_id, agency_id)
      const m = { id: id(), user_id: user.id, agency_id: agencyId, role, traveler_id: null, status: "active" }; s.memberships.push(m);
      return { user, membership: m, isNewUser };
    },
    async listMemberships(uid) { return s.memberships.filter((m) => m.user_id === uid && m.status === "active").map((m) => ({ ...m, agency_name: agencies[m.agency_id].name, agency_kind: agencies[m.agency_id].kind, traveller_self_booking: agencies[m.agency_id].traveller_self_booking })); },
    async invalidateTokens(uid, purpose) { s.tokens.filter((t) => t.user_id === uid && t.purpose === purpose && !t.used_at).forEach((t) => (t.used_at = new Date())); },
    async saveToken({ userId, purpose, hash, expiresAt }) { s.tokens.push({ user_id: userId, purpose, token_hash: hash, expires_at: expiresAt, used_at: null }); },
    async peekToken({ hash, purposes, now }) { const t = s.tokens.find((x) => x.token_hash === hash && purposes.includes(x.purpose) && !x.used_at && x.expires_at > now); return t ? t.user_id : null; },
    async consumeToken({ hash, purposes, now }) { const t = s.tokens.find((x) => x.token_hash === hash && purposes.includes(x.purpose) && !x.used_at && x.expires_at > now); if (!t) return null; t.used_at = now; return t.user_id; },
    async markEmailVerified(uid) { const u = s.users.find((x) => x.id === uid); u.email_verified_at = u.email_verified_at || new Date(); },
    async setPassword(uid, h) { const u = s.users.find((x) => x.id === uid); u.password_hash = h; u.failed_logins = 0; u.locked_until = null; },
    async revokeAllSessions(uid) { s.sessions.filter((x) => x.user_id === uid && !x.revoked_at).forEach((x) => (x.revoked_at = new Date())); },
    async recordFailedLogin(uid, { max, lockMinutes, now }) { const u = s.users.find((x) => x.id === uid); u.failed_logins++; if (u.failed_logins >= max) u.locked_until = new Date(now.getTime() + lockMinutes * 60000); },
    async resetFailedLogins(uid) { const u = s.users.find((x) => x.id === uid); u.failed_logins = 0; u.locked_until = null; },
    async createSession(x) { s.sessions.push({ id: id(), user_id: x.userId, membership_id: x.membershipId, token_hash: x.tokenHash, expires_at: x.expiresAt, revoked_at: null, last_used_at: null }); },
    async findSession(h) {
      const x = s.sessions.find((q) => q.token_hash === h); if (!x) return null;
      const u = s.users.find((q) => q.id === x.user_id), m = s.memberships.find((q) => q.id === x.membership_id), a = agencies[m.agency_id];
      return { ...x, user_status: u.status, email_verified_at: u.email_verified_at, full_name: u.full_name, email: u.email, role: m.role, agency_id: m.agency_id, traveler_id: m.traveler_id, membership_status: m.status, agency_status: a.status, agency_name: a.name, agency_kind: a.kind, traveller_self_booking: a.traveller_self_booking };
    },
    async touchSession() {}, async revokeSession(h) { const x = s.sessions.find((q) => q.token_hash === h); if (x) x.revoked_at = new Date(); },
  };
  return repo;
}
const fastHash = async (p) => `H(${p})`;
const fastVerify = async (p, h) => h === `H(${p})`;
function setup({ mailer = createMailer("memory"), clock } = {}) {
  const repo = fakeRepo(); let t = clock || new Date("2026-11-14T10:00:00Z");
  const svc = createAuthService({ repo, mailer, now: () => t, hash: fastHash, verify: fastVerify, baseUrl: "https://tapi.test" });
  return { repo, svc, mailer, advance: (ms) => { t = new Date(t.getTime() + ms); }, setNow: (d) => { t = d; } };
}
const GOOD = { email: "Ada@Example.com", password: "kettle-orbit-lantern", firstName: "Ada", lastName: "Obi" };
const tokenFrom = (mail) => decodeURIComponent(mail.text.match(/token=([^\s]+)/)[1]);

test("signup: creates a house-agency traveller, stores only a password HASH, emails a one-time verify link", async () => {
  const { svc, repo, mailer } = setup();
  assert.deepEqual(await svc.signupTraveller(GOOD), { status: "verification_sent" });
  const u = repo.s.users[0];
  assert.equal(u.password_hash, "H(kettle-orbit-lantern)"); assert.notEqual(u.password_hash, GOOD.password);
  assert.equal(repo.s.memberships[0].agency_id, "house"); assert.equal(repo.s.memberships[0].role, "traveller");
  assert.equal(mailer.outbox.length, 1); assert.match(mailer.outbox[0].text, /^.*https:\/\/tapi\.test\/app\/#\/verify\?token=tpv_/s);
  const raw = tokenFrom(mailer.outbox[0]);
  assert.ok(repo.s.tokens.every((x) => x.token_hash !== raw), "raw token must not be stored");
  assert.equal(repo.s.tokens[0].token_hash, hashToken(raw));
});

test("signup: existing email gets the SAME response and no second account or email (no account enumeration)", async () => {
  const { svc, repo, mailer } = setup();
  await svc.signupTraveller(GOOD);
  const again = await svc.signupTraveller({ ...GOOD, email: "ada@example.com", password: "another-long-phrase-1" });
  assert.deepEqual(again, { status: "verification_sent" });
  assert.equal(repo.s.users.length, 1); assert.equal(mailer.outbox.length, 1);
});

test("signup: rejects bad email, missing names and weak passwords; refuses to create anything when email cannot be sent", async () => {
  const { svc, repo } = setup();
  await assert.rejects(svc.signupTraveller({ ...GOOD, email: "nope" }), (e) => e.status === 400);
  await assert.rejects(svc.signupTraveller({ ...GOOD, lastName: "" }), (e) => e.status === 400);
  for (const p of ["short", "password123", "aaaaaaaaaaaa"]) await assert.rejects(svc.signupTraveller({ ...GOOD, password: p }), (e) => e.code === "WEAK_PASSWORD", p);
  const noMail = setup({ mailer: null });
  await assert.rejects(noMail.svc.signupTraveller(GOOD), (e) => e.status === 503 && e.code === "EMAIL_NOT_CONFIGURED");
  assert.equal(noMail.repo.s.users.length, 0); assert.equal(repo.s.users.length, 0);
});

test("verify email: works once; replay, expiry and garbage all fail", async () => {
  const { svc, repo, mailer, advance } = setup();
  await svc.signupTraveller(GOOD);
  const raw = tokenFrom(mailer.outbox[0]);
  await assert.rejects(svc.verifyEmail("tpv_garbage"), (e) => e.code === "INVALID_TOKEN");
  assert.deepEqual(await svc.verifyEmail(raw), { status: "verified" });
  assert.ok(repo.s.users[0].email_verified_at);
  await assert.rejects(svc.verifyEmail(raw), (e) => e.code === "INVALID_TOKEN");
  const b = setup(); await b.svc.signupTraveller(GOOD); const r2 = tokenFrom(b.mailer.outbox[0]); b.advance(25 * 3600_000);
  await assert.rejects(b.svc.verifyEmail(r2), (e) => e.code === "INVALID_TOKEN");
});

test("login: returns an opaque session token whose hash (not the token) is stored; unverified users can still sign in", async () => {
  const { svc, repo } = setup(); await svc.signupTraveller(GOOD);
  const r = await svc.login({ email: "ada@example.com", password: GOOD.password });
  assert.match(r.token, /^tps_/); assert.equal(r.principal.role, "traveller"); assert.equal(r.principal.emailVerified, false); assert.equal(r.principal.agencyKind, "house");
  assert.ok(repo.s.sessions.every((x) => x.token_hash !== r.token)); assert.equal(repo.s.sessions[0].token_hash, hashToken(r.token));
  assert.equal(JSON.stringify(r).includes("password"), false);
});

test("login failures are indistinguishable: unknown email, wrong password, invited-but-no-password, disabled", async () => {
  const { svc, repo } = setup(); await svc.signupTraveller(GOOD);
  await svc.inviteStaff({ agencyId: "a1", email: "new@acme.com", fullName: "New Agent", role: "agent" });
  const dis = { ...GOOD, email: "off@example.com" }; await svc.signupTraveller(dis); repo.s.users.find((u) => u.email === "off@example.com").status = "disabled";
  const errs = [];
  for (const [email, password] of [["nobody@example.com", "whatever-long-1"], ["ada@example.com", "wrong-password-1"], ["new@acme.com", "anything-long-1"], ["off@example.com", GOOD.password]]) {
    try { await svc.login({ email, password }); assert.fail("should reject"); } catch (e) { errs.push([e.status, e.code, e.message]); }
  }
  assert.equal(new Set(errs.map((e) => JSON.stringify(e))).size, 1, JSON.stringify(errs));
  assert.equal(errs[0][0], 401);
});

test("lockout: 5 wrong passwords lock the account for 15 minutes, even for the right password; success resets the counter", async () => {
  const { svc, repo, advance } = setup(); await svc.signupTraveller(GOOD);
  for (let i = 0; i < MAX_FAILED_LOGINS - 1; i++) await assert.rejects(svc.login({ email: GOOD.email, password: "wrong-wrong-1" }), (e) => e.status === 401);
  await svc.login({ email: GOOD.email, password: GOOD.password }); assert.equal(repo.s.users[0].failed_logins, 0);
  for (let i = 0; i < MAX_FAILED_LOGINS; i++) await assert.rejects(svc.login({ email: GOOD.email, password: "wrong-wrong-1" }));
  await assert.rejects(svc.login({ email: GOOD.email, password: GOOD.password }), (e) => e.status === 429 && e.code === "TOO_MANY_ATTEMPTS");
  advance(16 * 60_000);
  assert.ok((await svc.login({ email: GOOD.email, password: GOOD.password })).token);
});

test("sessions: valid token resolves to a principal; expired, revoked (logout), disabled user/membership/agency and unknown tokens do not", async () => {
  const { svc, repo, advance } = setup(); await svc.signupTraveller(GOOD);
  const { token } = await svc.login({ email: GOOD.email, password: GOOD.password });
  const p = await svc.authenticateSession(token);
  assert.equal(p.type, "session"); assert.equal(p.role, "traveller"); assert.equal(p.agencyId, "house"); assert.ok(p.travelerId); assert.equal(p.actor, `user:${p.userId}`);
  assert.equal(await svc.authenticateSession("tps_unknown"), null);
  repo.s.users[0].status = "disabled"; assert.equal(await svc.authenticateSession(token), null); repo.s.users[0].status = "active";
  repo.s.memberships[0].status = "disabled"; assert.equal(await svc.authenticateSession(token), null); repo.s.memberships[0].status = "active";
  repo.agencies.house.status = "suspended"; assert.equal(await svc.authenticateSession(token), null); repo.agencies.house.status = "active";
  assert.ok(await svc.authenticateSession(token));
  await svc.logout(token); assert.equal(await svc.authenticateSession(token), null);
  const again = (await svc.login({ email: GOOD.email, password: GOOD.password })).token; advance(8 * 24 * 3600_000);
  assert.equal(await svc.authenticateSession(again), null);
});

test("password reset: same answer for unknown emails; link is single-use, 1 hour, weak passwords do not burn it, success revokes all sessions", async () => {
  const { svc, repo, mailer, advance } = setup(); await svc.signupTraveller(GOOD);
  const { token } = await svc.login({ email: GOOD.email, password: GOOD.password });
  mailer.outbox.length = 0;
  assert.deepEqual(await svc.requestPasswordReset({ email: "ghost@example.com" }), { status: "ok" }); assert.equal(mailer.outbox.length, 0);
  assert.deepEqual(await svc.requestPasswordReset({ email: "ADA@example.com" }), { status: "ok" }); assert.equal(mailer.outbox.length, 1);
  const raw = tokenFrom(mailer.outbox[0]);
  await assert.rejects(svc.setPasswordWithToken({ token: raw, password: "short" }), (e) => e.code === "WEAK_PASSWORD");
  assert.deepEqual(await svc.setPasswordWithToken({ token: raw, password: "a brand new passphrase" }), { status: "password_set" });
  assert.equal(await svc.authenticateSession(token), null, "old sessions must die");
  assert.ok(repo.s.users[0].email_verified_at);
  await assert.rejects(svc.setPasswordWithToken({ token: raw, password: "yet another passphrase" }), (e) => e.code === "INVALID_TOKEN");
  assert.ok((await svc.login({ email: GOOD.email, password: "a brand new passphrase" })).token);
  await svc.requestPasswordReset({ email: GOOD.email }); const r2 = tokenFrom(mailer.outbox.at(-1)); advance(61 * 60_000);
  await assert.rejects(svc.setPasswordWithToken({ token: r2, password: "a brand new passphrase 2" }), (e) => e.code === "INVALID_TOKEN");
});

test("staff invite: new user gets a set-password link and cannot sign in until they use it; existing user is added; bad role rejected", async () => {
  const { svc, repo, mailer } = setup();
  const r = await svc.inviteStaff({ agencyId: "a1", email: "Sam@Acme.com", fullName: "Sam Agent", role: "agent" });
  assert.equal(r.invited, true); assert.match(mailer.outbox[0].text, /#\/reset\?token=tpi_/);
  await assert.rejects(svc.login({ email: "sam@acme.com", password: "anything-long-1" }), (e) => e.status === 401);
  await svc.setPasswordWithToken({ token: tokenFrom(mailer.outbox[0]), password: "purple-harbour-engine" });
  const login = await svc.login({ email: "sam@acme.com", password: "purple-harbour-engine" });
  assert.equal(login.principal.role, "agent"); assert.equal(login.principal.agencyId, "a1"); assert.equal(login.principal.emailVerified, true);
  const again = await svc.inviteStaff({ agencyId: "a1", email: "ada2@x.com", fullName: "Ada Two", role: "admin" }); assert.equal(again.invited, true);
  await assert.rejects(svc.inviteStaff({ agencyId: "a1", email: "x@y.com", fullName: "X Y", role: "traveller" }), (e) => e.status === 400);
});

test("a user with several memberships gets the highest role by default and can pick another", async () => {
  const { svc, repo } = setup(); await svc.signupTraveller(GOOD);
  await svc.inviteStaff({ agencyId: "a1", email: GOOD.email, fullName: "Ada Obi", role: "agent" });
  const def = await svc.login({ email: GOOD.email, password: GOOD.password }); assert.equal(def.principal.role, "agent"); assert.equal(def.memberships.length, 2);
  const trav = repo.s.memberships.find((m) => m.role === "traveller");
  assert.equal((await svc.login({ email: GOOD.email, password: GOOD.password, membershipId: trav.id })).principal.role, "traveller");
  await assert.rejects(svc.login({ email: GOOD.email, password: GOOD.password, membershipId: "nope" }), (e) => e.status === 400);
});

test("real scrypt: hashes verify, salts differ, malformed hashes fail closed", async () => {
  const h1 = await hashPassword("correct horse battery"), h2 = await hashPassword("correct horse battery");
  assert.notEqual(h1, h2); assert.ok(await verifyPassword("correct horse battery", h1)); assert.equal(await verifyPassword("wrong", h1), false);
  for (const bad of [null, "", "scrypt$1$2", "bcrypt$x$y$z$a$b"]) assert.equal(await verifyPassword("x", bad), false);
  assert.equal(passwordProblem("correct horse battery"), null);
});

test("password policy: length first, then obvious personal info", () => {
  assert.match(passwordProblem("my-johnson-secret-9", { fullName: "Mary Johnson" }), /name/);
  assert.match(passwordProblem("chinedu.okafor!1x", { email: "chinedu.okafor@x.com" }), /email/);
  assert.equal(passwordProblem("x".repeat(129)), "Use 128 characters or fewer.");
  assert.equal(passwordProblem("short"), "Use at least 10 characters.");
  assert.equal(passwordProblem("purple-harbour-engine", { email: "ada@x.com", fullName: "Ada Obi" }), null);
});

test("traveller route allow-list is deny-by-default: no raw bookings, orders, staff or other travellers", () => {
  const ok = [["GET", "/v1/trips"], ["POST", "/v1/trips/abc/items/x/approve"], ["PATCH", "/v1/trips/abc"], ["POST", "/v1/flights/search"], ["GET", "/v1/hotels/search/xyz"], ["GET", "/v1/travelers"], ["GET", "/v1/travelers/me"], ["PATCH", "/v1/travelers/me"], ["GET", "/v1/account/me"], ["POST", "/v1/account/logout"], ["POST", "/v1/account/resend-verification"]];
  const no = [["POST", "/v1/flights/bookings"], ["POST", "/v1/hotels/bookings"], ["GET", "/v1/orders"], ["POST", "/v1/orders"], ["GET", "/v1/staff"], ["POST", "/v1/auth/api-keys"], ["GET", "/v1/auth/api-keys"], ["POST", "/v1/account/login"], ["POST", "/v1/staff"], ["POST", "/v1/travelers"], ["GET", "/v1/mobility/operators"], ["POST", "/v1/buses/bookings"], ["DELETE", "/v1/trips/abc"], ["GET", "/v1/flights/offers/abc"], ["POST", "/v1/flights/offers/abc/validate"], ["GET", "/v1/tripsXYZ"], ["GET", "/v1/trips/../orders"], ["GET", "/v1/trips//x"], ["GET", "/v1/trips/%2e%2e/orders"], ["GET", "/v1/trips/./"], ["POST", "/v1/flights/search/../bookings"]];
  for (const [m, p] of ok) assert.equal(travellerMayCall(m, p), true, `${m} ${p}`);
  for (const [m, p] of no) assert.equal(travellerMayCall(m, p), false, `${m} ${p}`);
});

test("trip access: travellers see only their own trips; staff see the agency; nobody crosses agencies", () => {
  const trip = { agency_id: "a1", traveler_id: "t1" };
  assert.equal(canAccessTrip({ role: "traveller", agencyId: "a1", travelerId: "t1" }, trip), true);
  assert.equal(canAccessTrip({ role: "traveller", agencyId: "a1", travelerId: "t2" }, trip), false);
  assert.equal(canAccessTrip({ role: "traveller", agencyId: "a1", travelerId: null }, { agency_id: "a1", traveler_id: null }), false);
  assert.equal(canAccessTrip({ role: "agent", agencyId: "a1" }, trip), true);
  assert.equal(canAccessTrip({ role: "admin", agencyId: "a2" }, trip), false);
  assert.equal(canAccessTrip({ type: "api_key", role: "admin", agencyId: "a1" }, trip), true);
});

test("approval authority: verified email, self-booking policy, and agent consent attestation", () => {
  const trip = { agency_id: "a1", traveler_id: "t1" };
  const trav = { type: "session", role: "traveller", agencyId: "a1", travelerId: "t1", emailVerified: true };
  assert.deepEqual(checkApprover(trav, trip), { ok: true, role: "traveller", consentAttested: false });
  assert.equal(checkApprover({ ...trav, emailVerified: false }, trip).reason, "EMAIL_NOT_VERIFIED");
  assert.equal(checkApprover(trav, trip, { agencySelfBooking: false }).reason, "SELF_BOOKING_DISABLED");
  assert.equal(checkApprover({ ...trav, travelerId: "t2" }, trip).reason, "NOT_FOUND");
  const agent = { type: "session", role: "agent", agencyId: "a1", emailVerified: true };
  assert.equal(checkApprover(agent, trip).reason, "CONSENT_REQUIRED");
  assert.deepEqual(checkApprover(agent, trip, { clientConsent: true }), { ok: true, role: "agent", consentAttested: true });
  assert.equal(checkApprover({ ...agent, emailVerified: false }, trip, { clientConsent: true }).reason, "EMAIL_NOT_VERIFIED");
  assert.equal(checkApprover({ type: "api_key", role: "admin", agencyId: "a1" }, trip).ok, true);
});

// ---- mail delivery: failures must not lose accounts or leak information ----
const { createPostmarkMailer, createMailer: mk } = require("../../src/services/mailer");
const failingMailer = { async send() { throw Object.assign(new Error("provider down"), { code: "MAIL_UNREACHABLE" }); } };

test("sign-up still creates the account and answers generically when the email provider is down", async () => {
  const { svc, repo } = setup({ mailer: failingMailer });
  assert.deepEqual(await svc.signupTraveller(GOOD), { status: "verification_sent" });
  assert.equal(repo.s.users.length, 1);                                        // can sign in and ask for a new link
  assert.ok((await svc.login({ email: GOOD.email, password: GOOD.password })).token);
});

test("password reset answers the same when sending fails; resend-verification and invites tell the caller to retry", async () => {
  const { svc, repo } = setup(); await svc.signupTraveller(GOOD); const uid = repo.s.users[0].id;
  const down = createAuthService({ repo, mailer: failingMailer, now: () => new Date("2026-11-14T10:00:00Z"), hash: fastHash, verify: fastVerify });
  assert.deepEqual(await down.requestPasswordReset({ email: GOOD.email }), { status: "ok" });
  await assert.rejects(down.resendVerification(uid), (e) => e.status === 502 && e.code === "EMAIL_SEND_FAILED");
  await assert.rejects(down.inviteStaff({ agencyId: "a1", email: "late@acme.com", fullName: "Late Agent", role: "agent" }), (e) => e.status === 502);
});

test("a failed invite can be re-sent: inviting the same pending address again issues a fresh link instead of a 409", async () => {
  const { repo } = setup();
  const down = createAuthService({ repo, mailer: failingMailer, now: () => new Date("2026-11-14T10:00:00Z"), hash: fastHash, verify: fastVerify });
  await assert.rejects(down.inviteStaff({ agencyId: "a1", email: "late@acme.com", fullName: "Late Agent", role: "agent" }), (e) => e.status === 502);
  const mailer = createMailer("memory");
  const up = createAuthService({ repo, mailer, now: () => new Date("2026-11-14T10:00:00Z"), hash: fastHash, verify: fastVerify, baseUrl: "https://tapi.test" });
  const again = await up.inviteStaff({ agencyId: "a1", email: "late@acme.com", fullName: "Late Agent", role: "agent" });
  assert.equal(again.resent, true); assert.match(mailer.outbox[0].text, /#\/reset\?token=tpi_/);
  await up.setPasswordWithToken({ token: tokenFrom(mailer.outbox[0]), password: "purple-harbour-engine" });
  await assert.rejects(up.inviteStaff({ agencyId: "a1", email: "late@acme.com", fullName: "Late Agent", role: "agent" }), (e) => e.status === 409);   // accepted members still conflict
});

test("postmark transport: correct request, no token or body in errors, timeouts and header injection handled", async () => {
  const calls = [];
  const ok = createPostmarkMailer({ token: "tok-secret", from: "TAPI <no-reply@tapi.test>", fetchImpl: async (url, o) => { calls.push({ url, o }); return { ok: true, status: 200, json: async () => ({ ErrorCode: 0, Message: "OK" }) }; } });
  await ok.send({ to: "ada@example.com", subject: "Hi", text: "link https://x/#/verify?token=tpv_SECRET" });
  assert.equal(calls[0].url, "https://api.postmarkapp.com/email");
  assert.equal(calls[0].o.headers["X-Postmark-Server-Token"], "tok-secret");
  const sent = JSON.parse(calls[0].o.body); assert.deepEqual([sent.From, sent.To, sent.Subject, sent.MessageStream], ["TAPI <no-reply@tapi.test>", "ada@example.com", "Hi", "outbound"]);
  const rejected = createPostmarkMailer({ token: "tok-secret", from: "a@b.co", fetchImpl: async () => ({ ok: false, status: 422, json: async () => ({ ErrorCode: 300, Message: "Invalid email request: tpv_SECRET" }) }) });
  await assert.rejects(rejected.send({ to: "a@b.co", subject: "s", text: "tpv_SECRET" }), (e) => e.code === "MAIL_REJECTED" && !/tok-secret|tpv_SECRET/.test(e.message) && /422/.test(e.message));
  const soft = createPostmarkMailer({ token: "t", from: "a@b.co", fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ErrorCode: 406 }) }) });
  await assert.rejects(soft.send({ to: "a@b.co", subject: "s", text: "t" }), (e) => e.code === "MAIL_REJECTED");            // 200 with an error code is still a failure
  const slow = createPostmarkMailer({ token: "t", from: "a@b.co", timeoutMs: 20, fetchImpl: (u, o) => new Promise((_, rej) => o.signal.addEventListener("abort", () => rej(new Error("aborted")))) });
  await assert.rejects(slow.send({ to: "a@b.co", subject: "s", text: "t" }), (e) => e.code === "MAIL_UNREACHABLE");
  await assert.rejects(ok.send({ to: "a@b.co\r\nBcc: evil@x.com", subject: "s", text: "t" }), (e) => e.code === "MAIL_INVALID");
  await assert.rejects(ok.send({ to: "a@b.co", subject: "s\nBcc: x", text: "t" }), (e) => e.code === "MAIL_INVALID");
});

test("mail configuration fails closed: postmark without a token or sender is unavailable; production never defaults to console", () => {
  const { getMailer } = require("../../src/services/mailer");
  assert.equal(mk("postmark", { token: "t" }), null); assert.equal(mk("postmark", { from: "a@b.co" }), null); assert.equal(mk("sendmail"), null);
  assert.equal(getMailer({ NODE_ENV: "production" }), null);
  assert.equal(getMailer({ NODE_ENV: "production", MAIL_TRANSPORT: "postmark" }), null);
  assert.equal(getMailer({ NODE_ENV: "production", MAIL_TRANSPORT: "postmark", POSTMARK_SERVER_TOKEN: "t", MAIL_FROM: "a@b.co" }).kind, "postmark");
  assert.equal(getMailer({ NODE_ENV: "development" }).kind, "log");
});
