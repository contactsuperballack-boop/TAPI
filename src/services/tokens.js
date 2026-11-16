const crypto = require("crypto");

const PREFIX = { session: "tps_", verify_email: "tpv_", reset_password: "tpr_", invite: "tpi_" };
const hashToken = (raw) => crypto.createHash("sha256").update(raw).digest("hex");

function generateToken(kind) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error(`unknown token kind ${kind}`);
  const raw = prefix + crypto.randomBytes(32).toString("base64url");
  return { raw, hash: hashToken(raw) };
}

const isSessionToken = (t) => typeof t === "string" && t.startsWith(PREFIX.session);
module.exports = { generateToken, hashToken, isSessionToken, PREFIX };
