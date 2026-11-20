#!/usr/bin/env node
// Syntax-checks every .js/.mjs/.cjs file in the repo's own source trees (skips node_modules and built output).
// Shared by `npm run check:syntax` and CI. Exit 1 on the first batch of failures.
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOTS = ["src", "scripts", "console", "tests", "web/src", "web/test", "web/build.mjs"];
const SKIP = new Set(["node_modules", "dist", ".git"]);
const EXT = /\.(js|mjs|cjs)$/;

function* walk(p) {
  if (!fs.existsSync(p)) return;
  const st = fs.statSync(p);
  if (st.isFile()) { if (EXT.test(p)) yield p; return; }
  for (const e of fs.readdirSync(p)) if (!SKIP.has(e)) yield* walk(path.join(p, e));
}

let checked = 0;
const failures = [];
for (const root of ROOTS) {
  for (const f of walk(root)) {
    checked++;
    const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
    if (r.status !== 0) failures.push(`${f}\n${r.stderr}`);
  }
}
console.log(`syntax: checked ${checked} files, ${failures.length} failure(s)`);
if (failures.length) { console.error(failures.join("\n")); process.exit(1); }
