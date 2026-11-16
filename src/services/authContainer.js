// One shared auth service wired to the SQL repository and the configured mailer.
const { createAuthService } = require("./authService");
const { Identity } = require("../repositories/identity");
const { getMailer } = require("./mailer");

let svc;
function getAuthService() {
  if (!svc) svc = createAuthService({ repo: Identity, mailer: getMailer(), baseUrl: process.env.PUBLIC_APP_URL || `http://localhost:${process.env.PORT || 3000}` });
  return svc;
}
module.exports = { getAuthService };
