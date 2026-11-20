// Traveller records. Staff manage every client in their agency; a traveller sees and edits only themselves
// (the traveller allow-list in domain/access.js permits just GET / , GET+PATCH /me).
const express = require("express");
const db = require("../db");
const { ApiError, Errors } = require("../domain/errors");
const { sealPassport, hasPassport, maskedPassport } = require("../services/travelerSecrets");
const { randomUUID } = require("crypto");
const { requireRole } = require("../middleware/auth");
const { missingForBooking, validateProfileUpdate } = require("../domain/profile");
const { isUuid } = require("../domain/ids");

const router = express.Router();
const bad = (d) => new ApiError("VALIDATION_ERROR", 400, "Invalid request", d);
const COLS = `t.id, t.first_name, t.last_name, to_char(t.date_of_birth,'YYYY-MM-DD') AS date_of_birth, t.passport_number, t.passport_number_enc, t.passport_last4, t.nationality, t.created_at, c.email, c.phone`;
const view = (r) => ({ id: r.id, firstName: r.first_name, lastName: r.last_name, dateOfBirth: r.date_of_birth, nationality: r.nationality,
  passportMasked: maskedPassport(r), email: r.email || null, phone: r.phone || null, createdAt: r.created_at,
  // the list/profile view never decrypts: it only needs to know whether a passport is on file
  missingForFlights: missingForBooking("flight", { ...r, passport_number: hasPassport(r) ? "on-file" : null }) });
const isTraveller = (req) => req.principal && req.principal.role === "traveller";

async function load(travelerId, agencyId) {
  const { rows } = await db.query(`SELECT ${COLS} FROM travelers t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.id=$1 AND t.agency_id=$2`, [travelerId, agencyId]);
  return rows[0] || null;
}
async function update(travelerId, agencyId, v) {
  const sealed = v.passportNumber ? sealPassport(travelerId, v.passportNumber) : null;
  await db.withTransaction(async (q) => {
    // A new passport is stored encrypted and any legacy plaintext copy on that row is cleared in the same statement.
    await q.query(
      `UPDATE travelers SET first_name=COALESCE($3,first_name), last_name=COALESCE($4,last_name), date_of_birth=COALESCE($5::date,date_of_birth),
              passport_number_enc=COALESCE($6,passport_number_enc), passport_last4=COALESCE($7,passport_last4),
              passport_number=CASE WHEN $6::text IS NOT NULL THEN NULL ELSE passport_number END, nationality=COALESCE($8,nationality)
        WHERE id=$1 AND agency_id=$2`,
      [travelerId, agencyId, v.firstName ?? null, v.lastName ?? null, v.dateOfBirth ?? null, sealed ? sealed.enc : null, sealed ? sealed.last4 : null, v.nationality ?? null]);
    if (v.phone !== undefined) await q.query(`UPDATE customers SET phone=$3 WHERE agency_id=$2 AND id=(SELECT customer_id FROM travelers WHERE id=$1 AND agency_id=$2)`, [travelerId, agencyId, v.phone]);
  });
  return load(travelerId, agencyId);
}

router.get("/", async (req, res, next) => {
  try {
    const agencyId = req.tenant.agencyId;
    if (isTraveller(req)) { const r = await load(req.principal.travelerId, agencyId); return res.json({ travelers: r ? [view(r)] : [] }); }
    const { rows } = await db.query(`SELECT ${COLS} FROM travelers t LEFT JOIN customers c ON c.id=t.customer_id WHERE t.agency_id=$1 ORDER BY t.created_at DESC LIMIT 200`, [agencyId]);
    res.json({ travelers: rows.map(view) });
  } catch (err) { next(err); }
});

router.get("/me", async (req, res, next) => {
  try {
    if (!isTraveller(req)) throw Errors.NotFound("Traveller profile");
    const r = await load(req.principal.travelerId, req.tenant.agencyId);
    if (!r) throw Errors.NotFound("Traveller profile");
    res.json(view(r));
  } catch (err) { next(err); }
});

router.patch("/me", async (req, res, next) => {
  try {
    if (!isTraveller(req)) throw Errors.NotFound("Traveller profile");
    const { value, error } = validateProfileUpdate(req.body);
    if (error) throw bad(error);
    res.json(view(await update(req.principal.travelerId, req.tenant.agencyId, value)));
  } catch (err) { next(err); }
});

// Staff only from here down.
router.post("/", requireRole("admin", "agent"), async (req, res, next) => {
  try {
    const b = req.body || {};
    if (!b.firstName || !b.lastName) throw bad("firstName and lastName are required");
    if (!b.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(b.email)) throw bad("a valid email is required");
    const { value, error } = validateProfileUpdate({ ...b, firstName: b.firstName, lastName: b.lastName });
    if (error) throw bad(error);
    const id = randomUUID(); // chosen here so the passport can be bound to this record while it is encrypted
    const sealed = value.passportNumber ? sealPassport(id, value.passportNumber) : null;
    await db.withTransaction(async (q) => {
      const c = await q.query(`INSERT INTO customers (agency_id, full_name, email, phone) VALUES ($1,$2,$3,$4) RETURNING id`, [req.tenant.agencyId, `${value.firstName} ${value.lastName}`, b.email, value.phone || null]);
      await q.query(`INSERT INTO travelers (id, agency_id, customer_id, first_name, last_name, date_of_birth, passport_number_enc, passport_last4, nationality) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, req.tenant.agencyId, c.rows[0].id, value.firstName, value.lastName, value.dateOfBirth || null, sealed ? sealed.enc : null, sealed ? sealed.last4 : null, value.nationality || null]);
    });
    res.status(201).json(view(await load(id, req.tenant.agencyId)));
  } catch (err) { next(err); }
});

router.patch("/:id", requireRole("admin", "agent"), async (req, res, next) => {
  try {
    if (!isUuid(req.params.id)) throw Errors.NotFound("Traveller");
    if (!(await load(req.params.id, req.tenant.agencyId))) throw Errors.NotFound("Traveller");
    const { value, error } = validateProfileUpdate(req.body);
    if (error) throw bad(error);
    res.json(view(await update(req.params.id, req.tenant.agencyId, value)));
  } catch (err) { next(err); }
});

module.exports = router;
