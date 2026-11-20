// Passport numbers: sealed on write, opened only where a booking or an agent genuinely needs the full value.
// Lists and profile views use the stored last four characters and never decrypt.
const { getFieldCrypto } = require("./fieldCrypto");

const clean = (n) => String(n).replace(/\s+/g, "").toUpperCase();
const lastFour = (n) => clean(n).slice(-4);

function sealPassport(travelerId, plain, crypto = getFieldCrypto()) {
  const v = clean(plain);
  return { enc: crypto.encrypt(v, `traveler:${travelerId}:passport`), last4: lastFour(v) };
}
// `row` needs id plus passport_number_enc and/or the legacy plaintext passport_number (rows not yet backfilled).
function openPassport(row, crypto = getFieldCrypto()) {
  if (!row) return null;
  if (row.passport_number_enc) return crypto.decrypt(row.passport_number_enc, `traveler:${row.id}:passport`);
  return row.passport_number || null;
}
const hasPassport = (row) => !!(row && (row.passport_number_enc || row.passport_number));
// "••••••678": enough to recognise, never enough to use.
function maskedPassport(row) {
  if (!hasPassport(row)) return null;
  const l4 = row.passport_last4 || (row.passport_number ? lastFour(row.passport_number) : "");
  return l4 ? `••••••${l4.slice(-3)}` : "••••";
}

module.exports = { sealPassport, openPassport, hasPassport, maskedPassport, lastFour };
