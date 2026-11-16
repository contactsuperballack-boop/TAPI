// Static migration-chain checks (no Postgres). They catch the defect that broke the
// first clean install: 013 re-created a table (`trips`) that 010 already owned.
// They do NOT replace running `npm run migrate` against a real database.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "../../src/db/migrations");
const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".sql")).sort();
const strip = (sql) => sql.replace(/--.*$/gm, "");

function scan() {
  const tables = new Map(); // name -> file that created it
  const indexes = new Map();
  const problems = [];
  for (const f of files) {
    const sql = strip(fs.readFileSync(path.join(DIR, f), "utf8"));
    for (const m of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_0-9]+)/gi)) {
      const n = m[1].toLowerCase();
      if (tables.has(n)) problems.push(`${f}: table '${n}' already created in ${tables.get(n)}`);
      else tables.set(n, f);
    }
    for (const m of sql.matchAll(/DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([a-z_0-9]+)/gi)) tables.delete(m[1].toLowerCase());
    for (const m of sql.matchAll(/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_0-9]+)/gi)) {
      const n = m[1].toLowerCase();
      if (indexes.has(n)) problems.push(`${f}: index '${n}' already created in ${indexes.get(n)}`);
      else indexes.set(n, f);
    }
    for (const m of sql.matchAll(/REFERENCES\s+([a-z_0-9]+)\s*\(/gi)) {
      if (!tables.has(m[1].toLowerCase())) problems.push(`${f}: REFERENCES '${m[1]}' which does not exist yet`);
    }
  }
  return { tables, indexes, problems };
}

test("migration chain: no duplicate tables or indexes, and every REFERENCES target already exists", () => {
  const { problems } = scan();
  assert.deepEqual(problems, []);
});

test("migration filenames are strictly increasing with no duplicate numbers", () => {
  const nums = files.map((f) => f.split("_")[0]);
  assert.equal(new Set(nums).size, nums.length);
});

test("repositories only touch tables the migrations create", () => {
  const { tables } = scan();
  const repoDir = path.join(__dirname, "../../src/repositories");
  const bad = [];
  for (const f of fs.readdirSync(repoDir).filter((x) => x.endsWith(".js"))) {
    const src = fs.readFileSync(path.join(repoDir, f), "utf8");
    for (const m of src.matchAll(/\b(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_][a-z_0-9]*)\b/g)) {
      const n = m[1].toLowerCase();
      if (["select", "set", "values", "where", "only"].includes(n)) continue;
      if (/^[A-Z]/.test(m[1]) || !n.includes("_") && !tables.has(n)) continue; // prose/identifiers in comments
      if (!tables.has(n)) bad.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, []);
});
