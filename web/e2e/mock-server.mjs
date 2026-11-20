// In-memory MOCK of the TAPI contract the UI uses (accounts, roles, trips, approvals). It enforces the same
// RULES as the real routes (traveller deny-by-default, own-trips-only, verified email to approve, agent consent,
// profile completeness before flights, price-change handling) so the UI can be exercised end to end without
// Postgres or suppliers. It is NOT the real server: run the real one (and tests/identity.test.js) for that.
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join } from "node:path";
import { randomUUID } from "node:crypto";

const AG = "agency-1", HOUSE = "house-1";
export function startMock({ port = 0, dist, agentAvailable = false } = {}) {
  const KEY = "good-key";
  const db = { requests: [], users: [], sessions: {}, mail: [], trips: [], items: [], approvals: [], travelers: [], events: [], searches: {}, offers: {}, memberships: [] };
  const send = (res, status, body) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(body)); };
  const problem = (res, status, code, title, detail, extra = {}) => send(res, status, { code, title, detail, ...extra });
  const ev = (tripId, type, payload = {}) => db.events.unshift({ id: randomUUID(), trip_id: tripId, type, payload, created_at: new Date().toISOString() });
  const itemView = (i) => { const a = db.approvals.find((x) => x.item_id === i.id && x.status === "active" && new Date(x.expires_at) > new Date()); const fr = db.requests.filter((x) => x.item_id === i.id).at(-1); return { ...i, approval_id: a ? a.id : null, approval_expires_at: a ? a.expires_at : null, retry_approval_id: (db.approvals.find((x) => x.item_id === i.id && x.status === "consumed" && !x.bookingId && x.retryUntil && new Date(x.retryUntil) > new Date()) || {}).id || null, request_id: fr ? fr.id : null, request_status: fr ? fr.status : null, request_agent_name: fr ? fr.claimedByName || null : null, request_agent_note: fr ? fr.agentNote || null : null, request_decline_reason: fr ? fr.declineReason || null : null }; };
  const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" };
  const mail = (to, subject, token, purpose) => db.mail.push({ to, subject, token, purpose, text: `link #/${purpose === "verify" ? "verify" : "reset"}?token=${token}` });
  const missing = (t) => [!t.dateOfBirth && "dateOfBirth", !t.passport && "passportNumber", !t.nationality && "nationality"].filter(Boolean);
  const tview = (t) => ({ id: t.id, firstName: t.firstName, lastName: t.lastName, email: t.email, phone: t.phone || null, nationality: t.nationality || null, dateOfBirth: t.dateOfBirth || null, passportMasked: t.passport ? `••••••${t.passport.slice(-3)}` : null, missingForFlights: missing(t) });
  const pview = (p) => ({ userId: p.userId, fullName: p.fullName, email: p.email, role: p.role, agencyId: p.agencyId, agencyName: p.agencyName, agencyKind: p.agencyKind, travelerId: p.travelerId || null, emailVerified: !!p.emailVerified, travellerSelfBooking: p.travellerSelfBooking !== false });
  const principalFor = (u, m) => ({ type: "session", userId: u.id, fullName: u.fullName, email: u.email, role: m.role, agencyId: m.agencyId, agencyName: m.agencyId === HOUSE ? "TAPI Direct" : "Acme Travel", agencyKind: m.agencyId === HOUSE ? "house" : "agency", travelerId: m.travelerId || null, emailVerified: !!u.verified, travellerSelfBooking: u.selfBooking !== false });
  const TRAV_OK = [[/^\/v1\/trips(\/|$)/, ["GET", "POST", "PATCH"]], [/^\/v1\/(flights|hotels)\/search(\/|$)/, ["GET", "POST"]], [/^\/v1\/travelers\/?$/, ["GET"]], [/^\/v1\/travelers\/me\/?$/, ["GET", "PATCH"]], [/^\/v1\/account\/(me|logout|resend-verification)\/?$/, ["GET", "POST"]]];
  const canSee = (p, t) => t.agency_id === p.agencyId && (p.role !== "traveller" || t.traveler_id === p.travelerId);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x"); const path = url.pathname; const m = (re) => path.match(re); let r;
    if (path.startsWith("/app")) {
      const f = join(dist, path === "/app" || path === "/app/" ? "index.html" : path.slice(5));
      if (!existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "Content-Type": mime[extname(f)] || "application/octet-stream" }); return res.end(readFileSync(f));
    }
    if (path === "/__mail") return send(res, 200, db.mail);
    let body = {}; if (req.method !== "GET") { const chunks = []; for await (const c of req) chunks.push(c); try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch (_) {} }

    // ---- public account endpoints ----
    if (path === "/v1/account/signup" && req.method === "POST") {
      if (!body.email || !body.firstName || !body.lastName) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "First and last name and email are required.");
      if (String(body.password || "").length < 10) return problem(res, 400, "WEAK_PASSWORD", "Invalid request", "Use at least 10 characters.");
      if (!db.users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())) {
        const t = { id: randomUUID(), agency: HOUSE, firstName: body.firstName, lastName: body.lastName, email: body.email };
        const u = { id: randomUUID(), email: body.email, password: body.password, fullName: `${body.firstName} ${body.lastName}`, verified: false };
        db.travelers.push(t); db.users.push(u); db.memberships.push({ userId: u.id, role: "traveller", agencyId: HOUSE, travelerId: t.id });
        mail(u.email, "Confirm your email", randomUUID(), "verify");
      }
      return send(res, 202, { status: "verification_sent" });
    }
    if (path === "/v1/account/login" && req.method === "POST") {
      const u = db.users.find((x) => x.email.toLowerCase() === String(body.email || "").toLowerCase());
      if (!u || !u.password || u.password !== body.password) return problem(res, 401, "INVALID_CREDENTIALS", "Sign-in failed", "Email or password is incorrect.");
      const ms = db.memberships.filter((x) => x.userId === u.id).sort((a, b) => ["admin", "agent", "traveller"].indexOf(a.role) - ["admin", "agent", "traveller"].indexOf(b.role));
      const token = `tps_${randomUUID()}`; const p = principalFor(u, ms[0]); db.sessions[token] = { userId: u.id, membership: ms[0] };
      return send(res, 200, { token, principal: pview(p), memberships: ms.map((x) => ({ id: x.role, role: x.role })) });
    }
    if (path === "/v1/account/verify-email" && req.method === "POST") {
      const t = db.mail.find((x) => x.token === body.token && x.purpose === "verify" && !x.used);
      if (!t) return problem(res, 400, "INVALID_TOKEN", "Invalid request", "This link has expired or was already used. Request a new one from your account.");
      t.used = true; db.users.find((u) => u.email === t.to).verified = true; return send(res, 200, { status: "verified" });
    }
    if (path === "/v1/account/password-reset/request" && req.method === "POST") {
      const u = db.users.find((x) => x.email.toLowerCase() === String(body.email || "").toLowerCase()); if (u) mail(u.email, "Reset your password", randomUUID(), "reset");
      return send(res, 202, { status: "ok" });
    }
    if (path === "/v1/account/password-reset/confirm" && req.method === "POST") {
      const t = db.mail.find((x) => x.token === body.token && ["reset", "invite"].includes(x.purpose) && !x.used);
      if (!t) return problem(res, 400, "INVALID_TOKEN", "Invalid request", "This link has expired or was already used. Ask for a new one.");
      if (String(body.password || "").length < 10) return problem(res, 400, "WEAK_PASSWORD", "Invalid request", "Use at least 10 characters.");
      t.used = true; const u = db.users.find((x) => x.email === t.to); u.password = body.password; u.verified = true;
      for (const k of Object.keys(db.sessions)) if (db.sessions[k].userId === u.id) delete db.sessions[k];
      return send(res, 200, { status: "password_set" });
    }

    // ---- authentication ----
    const tok = (req.headers.authorization || "").replace(/^Bearer\s+/i, ""); let P = null;
    if (tok === KEY) P = { type: "api_key", role: "admin", agencyId: AG, agencyName: "Acme Travel" };
    else if (db.sessions[tok]) P = principalFor(db.users.find((u) => u.id === db.sessions[tok].userId), db.sessions[tok].membership);
    if (!P) return problem(res, 401, "UNAUTHORIZED", "Unauthorized", "Invalid API key.");
    if (P.role === "traveller" && !TRAV_OK.some(([re, ms]) => re.test(path) && ms.includes(req.method))) return problem(res, 403, "FORBIDDEN", "Forbidden", "This action is not available for traveller accounts.");
    const staff = P.role === "admin" || P.role === "agent";

    if (path === "/v1/account/me") return send(res, 200, P.type === "session" ? { type: "session", ...pview(P) } : { type: "api_key", role: "admin", agencyId: AG });
    if (path === "/v1/account/logout") { delete db.sessions[tok]; return send(res, 200, { status: "signed_out" }); }
    if (path === "/v1/account/resend-verification") { const u = db.users.find((x) => x.id === P.userId); if (u && !u.verified) mail(u.email, "Confirm your email", randomUUID(), "verify"); return send(res, 202, { status: "ok" }); }

    // ---- staff (admin only) ----
    if (path === "/v1/staff") {
      if (P.role !== "admin") return problem(res, 403, "FORBIDDEN", "Forbidden", "Your role cannot do this.");
      if (req.method === "GET") return send(res, 200, { staff: db.memberships.filter((x) => x.agencyId === AG && x.role !== "traveller").map((x) => { const u = db.users.find((y) => y.id === x.userId); return { membershipId: `${x.userId}:${x.role}`, userId: u.id, email: u.email, fullName: u.fullName, role: x.role, status: x.status || "active", emailVerified: u.verified, inviteAccepted: !!u.password }; }) });
      if (!["agent", "admin"].includes(body.role) || !body.email || !body.fullName) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "Full name, email and a role are required.");
      if (db.users.some((u) => u.email.toLowerCase() === body.email.toLowerCase())) return problem(res, 409, "ALREADY_MEMBER", "Already a member", "This person already has access to your agency.");
      const u = { id: randomUUID(), email: body.email, password: null, fullName: body.fullName, verified: false }; db.users.push(u); db.memberships.push({ userId: u.id, role: body.role, agencyId: AG });
      mail(u.email, "You have been invited", randomUUID(), "invite"); return send(res, 201, { userId: u.id, role: body.role, email: u.email, invited: true });
    }
    if ((r = m(/^\/v1\/staff\/([^/]+)$/)) && req.method === "PATCH") {
      if (P.role !== "admin") return problem(res, 403, "FORBIDDEN", "Forbidden", "Your role cannot do this.");
      const [uid, role] = r[1].split(":"); const ms = db.memberships.find((x) => x.userId === uid && x.role === role && x.agencyId === AG); if (!ms) return problem(res, 404, "NOT_FOUND", "Not found", "Team member");
      ms.status = body.status; return send(res, 200, { membershipId: r[1], status: body.status });
    }

    // ---- travellers ----
    if (path === "/v1/travelers/me") { const t = db.travelers.find((x) => x.id === P.travelerId); if (!t) return problem(res, 404, "NOT_FOUND", "Not found", "Traveller profile");
      if (req.method === "PATCH") { for (const k of ["firstName", "lastName", "dateOfBirth", "nationality", "phone"]) if (body[k] !== undefined) t[k] = body[k]; if (body.passportNumber) t.passport = body.passportNumber; }
      return send(res, 200, tview(t)); }
    if (path === "/v1/travelers" && req.method === "GET") return send(res, 200, { travelers: db.travelers.filter((t) => (P.role === "traveller" ? t.id === P.travelerId : t.agency === AG)).map(tview) });
    if (path === "/v1/travelers" && req.method === "POST") {
      if (!body.firstName || !body.lastName || !body.email) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "firstName, lastName and email are required");
      const t = { id: randomUUID(), agency: AG, firstName: body.firstName, lastName: body.lastName, email: body.email, phone: body.phone, nationality: body.nationality, dateOfBirth: body.dateOfBirth, passport: body.passportNumber };
      db.travelers.unshift(t); return send(res, 201, tview(t));
    }
    if ((r = m(/^\/v1\/travelers\/([^/]+)$/)) && req.method === "PATCH") {
      const t = db.travelers.find((x) => x.id === r[1] && x.agency === AG); if (!t) return problem(res, 404, "NOT_FOUND", "Not found", "Traveller");
      for (const k of ["firstName", "lastName", "dateOfBirth", "nationality", "phone"]) if (body[k] !== undefined) t[k] = body[k]; if (body.passportNumber) t.passport = body.passportNumber; return send(res, 200, tview(t));
    }

    // ---- trips ----
    if (path === "/v1/trips" && req.method === "GET") return send(res, 200, { trips: db.trips.filter((t) => canSee(P, t)).map((t) => ({ ...t, item_count: db.items.filter((i) => i.trip_id === t.id).length, confirmed_count: db.items.filter((i) => i.trip_id === t.id && i.status === "confirmed").length })) });
    if (path === "/v1/trips" && req.method === "POST") {
      if (!body.title) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "title is required");
      const t = { id: randomUUID(), agency_id: P.agencyId, traveler_id: P.role === "traveller" ? P.travelerId : null, title: body.title, origin: body.origin || null, destination: body.destination || null, start_date: body.startDate || null, end_date: body.endDate || null, budget: body.budget ?? null, currency: body.currency || null, status: "draft", brief: {}, created_at: new Date().toISOString() };
      db.trips.unshift(t); ev(t.id, "trip_created"); return send(res, 201, t);
    }
    const tripFor = (id) => { const t = db.trips.find((x) => x.id === id); return t && canSee(P, t) ? t : null; };
    if ((r = m(/^\/v1\/trips\/([^/]+)$/))) {
      const t = tripFor(r[1]); if (!t) return problem(res, 404, "NOT_FOUND", "Not found", "Trip not found");
      if (req.method === "PATCH") { if (body.travelerId && staff) t.traveler_id = body.travelerId; if (body.title) t.title = body.title; return send(res, 200, t); }
      return send(res, 200, { ...t, items: db.items.filter((i) => i.trip_id === t.id).map(itemView) });
    }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/(events|messages|items)(\/.*)?$/))) { if (!tripFor(r[1])) return problem(res, 404, "NOT_FOUND", "Not found", "Trip not found"); }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/events$/))) return send(res, 200, { events: db.events.filter((e) => e.trip_id === r[1]) });
    if ((r = m(/^\/v1\/trips\/([^/]+)\/messages$/))) {
      if (req.method === "GET") return send(res, 200, { messages: [], agentAvailable });
      if (!agentAvailable) return problem(res, 503, "AGENT_MODEL_NOT_CONFIGURED", "Assistant unavailable", "No AI model is configured for this deployment.");
      return send(res, 200, { reply: "ok", degraded: false, tools: [] });
    }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/items$/)) && req.method === "POST") {
      const o = db.offers[body.offerId]; if (!o || o.kind !== body.kind) return problem(res, 404, "NOT_FOUND", "Not found", "Offer not found");
      const item = { id: randomUUID(), trip_id: r[1], kind: body.kind, status: "proposed", offer_id: o.offerId, booking_id: null, quoted_price: o.price, currency: o.currency, price_label: "estimated", details: o };
      db.items.push(item); const tt = db.trips.find((x) => x.id === r[1]); if (tt.status === "draft") tt.status = "researching"; ev(r[1], "item_proposed", { itemId: item.id }); return send(res, 201, item);
    }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/items\/([^/]+)\/approve$/))) {
      const t = tripFor(r[1]); const it = db.items.find((i) => i.id === r[2] && i.trip_id === r[1]); if (!it) return problem(res, 404, "NOT_FOUND", "Not found", "Trip item not found");
      if (body.confirm !== true) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "confirm must be true");
      if (body.fulfilment && !["automated", "agent_assisted"].includes(body.fulfilment)) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "fulfilment must be automated or agent_assisted");
      const mustAgent = P.role === "traveller" && P.travellerSelfBooking === false;
      if (mustAgent && body.fulfilment === "automated") return problem(res, 403, "SELF_BOOKING_DISABLED", "Your agent books for you", "This agency completes bookings for its clients.");
      const mode = mustAgent ? "agent_assisted" : body.fulfilment || "automated";
      if (P.type === "session" && !P.emailVerified) return problem(res, 403, "EMAIL_NOT_VERIFIED", "Verify your email", "Confirm your email address before approving or booking.");
      if (P.type === "session" && staff && body.clientConsent !== true) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "Confirm that your client has agreed to this price and booking (clientConsent: true).");
      if (Number(body.acknowledgedPrice) !== Number(it.quoted_price) || body.currency !== it.currency) return problem(res, 409, "PRICE_MISMATCH", "Price mismatch", "acknowledgedPrice/currency do not match the quoted price.");
      db.approvals.filter((a) => a.item_id === it.id && a.status === "active" && new Date(a.expires_at) <= new Date()).forEach((a) => (a.status = "expired"));
      if (db.approvals.some((a) => a.item_id === it.id && a.status === "active")) return problem(res, 409, "ALREADY_APPROVED", "Already approved", "This item already has an active approval.");
      const a = { id: randomUUID(), item_id: it.id, status: "active", price: it.quoted_price, expires_at: new Date(Date.now() + (mode === "agent_assisted" ? 48 * 60 : 30) * 60000).toISOString(), by_role: P.role, consent: staff && P.type === "session" };
      db.approvals.push(a); let requestId = null;
      if (mode === "agent_assisted") {
        const fr = { id: randomUUID(), trip_id: t.id, item_id: it.id, approval_id: a.id, status: "open", approvedPrice: it.quoted_price, currency: it.currency, travellerNote: body.travellerNote || null, created_at: new Date().toISOString(), agency_id: t.agency_id };
        db.requests.push(fr); requestId = fr.id; it.status = "agent_requested"; it.fulfilment_mode = "agent_assisted"; t.status = "booking"; ev(r[1], "agent_requested", { itemId: it.id });
      } else { it.status = "approved"; it.fulfilment_mode = "automated"; if (["draft", "researching", "itinerary_ready"].includes(t.status)) t.status = "awaiting_approval"; ev(r[1], "item_approved", { itemId: it.id, role: P.role }); }
      return send(res, 201, { approvalId: a.id, expiresAt: a.expires_at, fulfilment: mode, requestId });
    }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/items\/([^/]+)\/resolve$/)) && req.method === "POST") {
      if (!staff) return problem(res, 403, "FORBIDDEN", "Forbidden", "Your role cannot do this.");
      const t = tripFor(r[1]); const it = db.items.find((i) => i.id === r[2] && i.trip_id === r[1]); if (!t || !it) return problem(res, 404, "NOT_FOUND", "Not found", "Trip item not found");
      if (!["confirmed", "not_booked"].includes(body.outcome)) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "outcome must be confirmed or not_booked");
      if (body.outcome === "confirmed" && !String(body.reference || "").trim()) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "A supplier confirmation reference is required to mark this as booked (max 80 characters).");
      if (it.status !== "reconciliation_required") return problem(res, 409, "NOT_UNDER_REVIEW", "Not under review", "Only an item that is under review can be resolved.");
      it.status = body.outcome === "confirmed" ? "confirmed" : "selected"; if (body.outcome === "confirmed") { it.confirmation_ref = body.reference; it.price_label = "confirmed"; }
      const live = db.items.filter((i) => i.trip_id === t.id); t.status = live.every((i) => i.status === "confirmed") ? "booked" : live.some((i) => i.status === "confirmed") ? "partially_booked" : "itinerary_ready"; ev(t.id, "booking_resolved", { itemId: it.id, outcome: body.outcome });
      return send(res, 200, { itemId: it.id, status: it.status });
    }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/items\/([^/]+)\/cancel-request$/)) && req.method === "POST") {
      const t = tripFor(r[1]); const it = db.items.find((i) => i.id === r[2] && i.trip_id === r[1]); if (!t || !it) return problem(res, 404, "NOT_FOUND", "Not found", "Trip item not found");
      const fr = db.requests.find((x) => x.item_id === it.id && x.status === "open");
      if (!fr) return problem(res, 409, "ALREADY_STARTED", "Already started", "An agent has already started on this.");
      fr.status = "cancelled"; fr.agentNote = "Withdrawn by the requester"; db.approvals.find((x) => x.id === fr.approval_id).status = "revoked"; it.status = "selected"; it.fulfilment_mode = "automated";
      if (!db.items.some((i) => i.trip_id === t.id && ["agent_requested", "agent_working", "booking", "confirmed"].includes(i.status))) t.status = "itinerary_ready";
      return send(res, 200, { itemId: it.id, status: "selected" });
    }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/items\/([^/]+)\/book$/))) {
      const t = tripFor(r[1]); const it = db.items.find((i) => i.id === r[2] && i.trip_id === r[1]);
      if (!t || !it) return problem(res, 404, "NOT_FOUND", "Not found", "not found");
      if (it.fulfilment_mode === "agent_assisted" && ["agent_requested", "agent_working"].includes(it.status)) return problem(res, 409, "HANDLED_BY_AGENT", "An agent is handling this", "This booking was sent to an agent.");
      const a = db.approvals.find((x) => x.id === body.approvalId && x.item_id === it.id); if (!a) return problem(res, 404, "NOT_FOUND", "Not found", "Approval not found");
      if (P.type === "session" && !P.emailVerified) return problem(res, 403, "EMAIL_NOT_VERIFIED", "Verify your email", "Confirm your email address before approving or booking.");
      // A spent approval with no booking id: same-key retry inside the window only; later it stays under review (never re-approvable).
      if (a.status === "consumed" && !a.bookingId) {
        if (!(a.retryUntil && new Date(a.retryUntil) > new Date())) return problem(res, 409, "BOOKING_UNCONFIRMED", "Booking not confirmed", "We could not confirm this booking and it is now with our team. Please do not approve it again.");
        db.bookingsMade = (db.bookingsMade || 0) + 1; it.status = "booking"; it.booking_id = `bk_${it.id.slice(0, 6)}`; a.bookingId = it.booking_id; t.status = "booking"; ev(t.id, "booking_started", { itemId: it.id });
        return send(res, 202, { bookingId: it.booking_id, status: "pending" });
      }
      if (!t.traveler_id) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "Choose a traveller for this trip before booking.");
      const tr = db.travelers.find((x) => x.id === t.traveler_id);
      if (it.kind === "flight" && missing(tr).length) return problem(res, 400, "PROFILE_INCOMPLETE", "Traveller details needed", `Add ${missing(tr).map((k) => ({ dateOfBirth: "date of birth", passportNumber: "passport number", nationality: "nationality" }[k])).join(", ")} to the traveller's profile before booking.`, { missing: missing(tr) });
      if (it.details.simulate === "price_up") {
        if (t.status === "awaiting_approval") t.status = "itinerary_ready"; a.status = "revoked"; it.quoted_price = Math.round(it.quoted_price * 1.12); it.status = "selected"; it.price_label = "confirmed"; it.details.simulate = null;
        ev(t.id, "booking_blocked", { itemId: it.id, reason: "PRICE_INCREASED" });
        return send(res, 409, { code: "PRICE_INCREASED", title: "Booking not started", detail: "No booking was made.", livePrice: it.quoted_price, approvedPrice: Math.round(it.quoted_price / 1.12) });
      }
      if (it.details.simulate === "unconfirmed_once") {
        a.status = "consumed"; a.retryUntil = new Date(Date.now() + 15 * 60000).toISOString(); it.details.simulate = null; it.status = "reconciliation_required"; t.status = "needs_attention"; ev(t.id, "booking_unconfirmed", { itemId: it.id });
        return send(res, 502, { code: "BOOKING_UNCONFIRMED", title: "Booking not confirmed", detail: "We could not confirm this booking yet. Please do not approve it again: we are checking with the supplier so you are not booked twice." });
      }
      if (it.details.simulate === "rejected") { a.status = "consumed"; it.details.simulate = null; it.status = "selected"; it.price_label = "unverified"; t.status = "itinerary_ready"; ev(t.id, "booking_failed", { itemId: it.id }); return send(res, 409, { code: "BOOKING_FAILED", title: "Booking failed", detail: "The supplier did not accept this booking. Nothing was booked. Check the traveller's details and approve again." }); }
      db.bookingsMade = (db.bookingsMade || 0) + 1; a.status = "consumed"; a.bookingId = `bk_${it.id.slice(0, 6)}`; it.status = "booking"; it.price_label = "confirmed"; t.status = "booking"; it.booking_id = `bk_${it.id.slice(0, 6)}`; ev(t.id, "booking_started", { itemId: it.id });
      return send(res, 202, { bookingId: it.booking_id, status: "pending" });
    }
    if ((r = m(/^\/v1\/trips\/([^/]+)\/items\/([^/]+)\/refresh$/))) { const it = db.items.find((i) => i.id === r[2]); it.status = "confirmed"; const tr = db.trips.find((x) => x.id === r[1]); tr.status = db.items.filter((i) => i.trip_id === tr.id).every((i) => i.status === "confirmed") ? "booked" : "partially_booked"; return send(res, 200, { itemId: it.id, bookingStatus: "confirmed", itemStatus: "confirmed" }); }

    // ---- agent queue (staff only; travellers are stopped by the allow-list above) ----
    if (path.startsWith("/v1/fulfilment")) {
      if (!staff) return problem(res, 403, "FORBIDDEN", "Forbidden", "Your role cannot do this.");
      const fv = (f) => { const t = db.trips.find((x) => x.id === f.trip_id); const it = db.items.find((x) => x.id === f.item_id); const tr = db.travelers.find((x) => x.id === t.traveler_id); const ap = db.approvals.find((x) => x.id === f.approval_id);
        return { id: f.id, status: f.status, tripId: t.id, tripTitle: t.title, itemId: it.id, itemKind: it.kind, item: it.details, travellerName: tr ? `${tr.firstName} ${tr.lastName}` : null, travellerEmail: tr ? tr.email : null, travellerNote: f.travellerNote, approvedPrice: f.approvedPrice, currency: f.currency, approvalExpiresAt: ap.expires_at, approvalStatus: ap.status, claimedBy: f.claimedByName || null, claimedByUserId: f.claimedBy || null, confirmationRef: f.confirmationRef || null, finalPrice: f.finalPrice ?? null, agentNote: f.agentNote || null, declineReason: f.declineReason || null, createdAt: f.created_at }; };
      const mine = (f) => P.type !== "session" || f.claimedBy === P.userId || P.role === "admin";
      if (path === "/v1/fulfilment" && req.method === "GET") {
        const sc = url.searchParams.get("scope") || "open"; const mineId = P.userId;
        const list = db.requests.filter((f) => f.agency_id === P.agencyId && (sc === "open" ? f.status === "open" : sc === "mine" ? f.status === "claimed" && (!mineId || f.claimedBy === mineId) : ["completed", "declined", "cancelled"].includes(f.status)));
        return send(res, 200, { scope: sc, requests: list.map(fv) });
      }
      const mm = path.match(/^\/v1\/fulfilment\/([^/]+)(?:\/(claim|release|reveal|complete|decline|reprice))?$/); const f = mm && db.requests.find((x) => x.id === mm[1] && x.agency_id === P.agencyId);
      if (!f) return problem(res, 404, "NOT_FOUND", "Not found", "Request not found");
      const act = mm[2]; const it = db.items.find((x) => x.id === f.item_id); const t = db.trips.find((x) => x.id === f.trip_id); const ap = db.approvals.find((x) => x.id === f.approval_id);
      if (!act) return send(res, 200, fv(f));
      if (act === "claim") {
        if (f.status !== "open") return problem(res, 409, "ALREADY_CLAIMED", "Already taken", "Someone else already took this request.");
        f.status = "claimed"; f.claimedBy = P.userId || null; f.claimedByName = P.fullName || "API key"; it.status = "agent_working"; return send(res, 200, fv(f));
      }
      if (f.status !== "claimed") return problem(res, 409, "NOT_CLAIMED", "Not claimed", "Claim this request first.");
      if (!mine(f)) return problem(res, 403, "CLAIMED_BY_SOMEONE_ELSE", "Claimed by someone else", "Another agent is working on this request.");
      const sync = () => { const live = db.items.filter((i) => i.trip_id === t.id && i.status !== "cancelled"); if (live.some((i) => ["failed"].includes(i.status))) t.status = "needs_attention"; else if (live.length && live.every((i) => i.status === "confirmed")) t.status = "booked"; else if (live.some((i) => ["agent_requested", "agent_working"].includes(i.status))) t.status = "booking"; else if (live.some((i) => i.status === "confirmed")) t.status = "partially_booked"; else if (t.status === "booking") t.status = "itinerary_ready"; };
      if (act === "release") { f.status = "open"; f.claimedBy = null; f.claimedByName = null; it.status = "agent_requested"; return send(res, 200, fv(f)); }
      if (act === "reveal") { const tr = db.travelers.find((x) => x.id === t.traveler_id); ev(t.id, "pii_revealed", { requestId: f.id }); return send(res, 200, { firstName: tr.firstName, lastName: tr.lastName, dateOfBirth: tr.dateOfBirth || null, passportNumber: tr.passport || null, nationality: tr.nationality || null, email: tr.email, phone: tr.phone || null }); }
      if (act === "complete") {
        const price = Number(body.finalPrice);
        if (!String(body.confirmationRef || "").trim() || !(price > 0) || !/^[A-Z]{3}$/.test(body.currency || "")) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "A confirmation reference, final price and currency are required.");
        if (ap.status !== "active" || new Date(ap.expires_at) <= new Date()) return problem(res, 409, "APPROVAL_EXPIRED", "Cannot complete", "The traveller's approval has expired. Nothing was recorded as booked.");
        if (body.currency !== f.currency) return problem(res, 409, "CURRENCY_CHANGED", "Cannot complete", "The currency differs from what the traveller approved.");
        if (price > f.approvedPrice) return problem(res, 409, "PRICE_EXCEEDS_APPROVAL", "Cannot complete", `The final price is higher than the traveller approved (${f.currency} ${Number(f.approvedPrice).toFixed(2)}). Use "Price changed" so they can approve the new price. Nothing was recorded as booked.`);
        ap.status = "consumed"; f.status = "completed"; f.confirmationRef = body.confirmationRef; f.finalPrice = price; it.status = "confirmed"; it.confirmation_ref = body.confirmationRef; it.quoted_price = price; it.price_label = "confirmed";
        sync(); ev(t.id, "agent_completed", { requestId: f.id }); const tr = db.travelers.find((x) => x.id === t.traveler_id); db.mail.push({ to: tr.email, purpose: "booked", text: `Confirmation reference: ${body.confirmationRef}` }); return send(res, 200, fv(f));
      }
      if (act === "decline") {
        if (String(body.reason || "").trim().length < 3) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "Give a short reason.");
        ap.status = "revoked"; f.status = "declined"; f.declineReason = body.reason.trim(); it.status = "failed"; sync(); ev(t.id, "agent_declined", { requestId: f.id }); return send(res, 200, fv(f));
      }
      if (act === "reprice") {
        if (!(Number(body.newPrice) > 0) || String(body.note || "").trim().length < 3) return problem(res, 400, "VALIDATION_ERROR", "Invalid request", "Enter the new price and explain why.");
        ap.status = "revoked"; f.status = "cancelled"; f.agentNote = body.note.trim(); it.status = "selected"; it.fulfilment_mode = "automated"; it.quoted_price = Number(body.newPrice); it.price_label = "estimated"; sync(); ev(t.id, "agent_repriced", { requestId: f.id }); return send(res, 200, fv(f));
      }
    }

    // ---- search ----
    if ((r = m(/^\/v1\/(flights|hotels)\/search$/)) && req.method === "POST") { const id = randomUUID(); db.searches[id] = { kind: r[1] === "flights" ? "flight" : "hotel", polls: 0 }; return send(res, 202, { searchId: id, status: "processing" }); }
    if ((r = m(/^\/v1\/(flights|hotels)\/search\/([^/]+)$/))) {
      const s = db.searches[r[2]]; s.polls++; if (s.polls < 2) return send(res, 200, { searchId: r[2], status: "processing" });
      const mk = (price, extra) => { const offerId = randomUUID(); const o = { offerId, kind: s.kind, price, currency: "USD", ...extra }; db.offers[offerId] = o; return o; };
      const offers = s.kind === "flight"
        ? [mk(486, { airline: "British Airways", stops: 0, outbound: { origin: "ABV", destination: "LHR", departure: "2026-12-10T08:15:00Z", arrival: "2026-12-10T14:40:00Z", duration: 385 }, baggage: "23kg" }),
           mk(540, { airline: "Lufthansa", stops: 1, outbound: { origin: "ABV", destination: "LHR", departure: "2026-12-10T06:00:00Z", arrival: "2026-12-10T16:10:00Z", duration: 610 }, simulate: "price_up" })]
        : [mk(640, { hotelName: "Kensington Court Hotel", checkIn: "2026-12-10", checkOut: "2026-12-17", roomType: "Deluxe double", cancellationPolicy: "Free until 3 Dec" })];
      return send(res, 200, { searchId: r[2], status: "completed", offers });
    }
    return problem(res, 404, "NOT_FOUND", "Not found", path);
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port: server.address().port, db, key: KEY })));
}
