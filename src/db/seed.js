// Dev convenience only — creates one agency and one API key you can use
// immediately with the CLI or curl. Not for production seeding.
require("dotenv").config();
const db = require("./index");
const { ApiKeys } = require("../services/apiKeys");

async function main() {
  const agencyName = process.argv[2] || "Dev Test Agency";

  const { rows: agencyRows } = await db.query(`INSERT INTO agencies (name) VALUES ($1) RETURNING id`, [agencyName]);
  const agencyId = agencyRows[0].id;

  const { rawKey, client } = await ApiKeys.create({ agencyId, label: "dev seed key", env: "test" });

  console.log(`Agency:  ${agencyName} (${agencyId})`);
  console.log(`API key: ${rawKey}`);
  console.log(`Prefix:  ${client.keyPrefix}  (this is what's shown in listings — the full key is not recoverable)`);
  console.log(`\nExport it: export TAPI_API_KEY=${rawKey}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
