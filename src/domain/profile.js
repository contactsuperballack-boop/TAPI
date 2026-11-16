// What a traveller record must contain before TAPI can send a booking to a supplier.
// Flights need passport details (international travel is the common case; a domestic-only exemption can
// be added once routes carry a country). Hotels need names and a contact email only.
function missingForBooking(kind, party) {
  const miss = [];
  if (!party) return ["profile"];
  if (!party.first_name) miss.push("firstName");
  if (!party.last_name) miss.push("lastName");
  if (!party.email) miss.push("email");
  if (kind === "flight") {
    if (!party.date_of_birth) miss.push("dateOfBirth");
    if (!party.passport_number) miss.push("passportNumber");
    if (!party.nationality) miss.push("nationality");
  }
  return miss;
}
module.exports = { missingForBooking };

// Validate a profile edit. Only keys that are present are returned, so a PATCH never wipes other fields.
function validateProfileUpdate(b = {}) {
  const out = {}; const err = (m) => ({ error: m });
  const text = (k, max, label) => { if (b[k] === undefined) return null; const v = String(b[k]).trim(); if (!v || v.length > max) return `${label} is required (max ${max} characters).`; out[k] = v; return null; };
  for (const e of [text("firstName", 80, "First name"), text("lastName", 80, "Last name")]) if (e) return err(e);
  if (b.dateOfBirth !== undefined) {
    const v = String(b.dateOfBirth);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v) || isNaN(new Date(`${v}T00:00:00Z`))) return err("Date of birth must be YYYY-MM-DD.");
    if (v < "1900-01-01" || v > new Date().toISOString().slice(0, 10)) return err("Date of birth is not valid.");
    out.dateOfBirth = v;
  }
  if (b.nationality !== undefined) { const v = String(b.nationality).trim().toUpperCase(); if (!/^[A-Z]{2}$/.test(v)) return err("Nationality must be a 2-letter country code, e.g. NG."); out.nationality = v; }
  if (b.passportNumber !== undefined) { const v = String(b.passportNumber).replace(/\s+/g, "").toUpperCase(); if (!/^[A-Z0-9]{5,20}$/.test(v)) return err("Passport number should be 5 to 20 letters or digits."); out.passportNumber = v; }
  if (b.phone !== undefined) { const v = String(b.phone).trim(); if (v && !/^\+?[0-9 ()-]{6,30}$/.test(v)) return err("Enter a valid phone number."); out.phone = v || null; }
  return { value: out };
}
module.exports.validateProfileUpdate = validateProfileUpdate;
