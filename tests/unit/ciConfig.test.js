// Guards that keep the CI / container config honest against the repo it describes.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const R = (p) => path.join(__dirname, "../..", p);
const read = (p) => fs.readFileSync(R(p), "utf8");
const pkg = JSON.parse(read("package.json"));

test("every `npm run X` used in the workflows exists in package.json", () => {
  for (const f of fs.readdirSync(R(".github/workflows"))) {
    const txt = read(`.github/workflows/${f}`);
    for (const m of txt.matchAll(/npm run ([a-z:\-]+)/g)) {
      if (f === "ci.yml" && /working-directory: web/.test(txt) && m[1] === "build") continue; // web has its own package.json
      assert.ok(pkg.scripts[m[1]], `${f}: npm run ${m[1]} is not defined`);
    }
  }
});

test("CI's 'second migrate must skip everything' check matches the migration runner's log format", () => {
  const ci = read(".github/workflows/ci.yml");
  const grep = ci.match(/grep -E '\^([a-z]+) '/);
  assert.ok(grep, "ci.yml greps for the apply log prefix");
  const migrate = read("src/db/migrate.js");
  assert.match(migrate, new RegExp("console\\.log\\(`" + grep[1] + " \\$\\{file\\}`\\)"));
  assert.match(migrate, /skip {2}\$\{file\} \(already applied\)/);
});

test("integration job uses the throwaway CI database only", () => {
  const ci = read(".github/workflows/ci.yml");
  assert.match(ci, /TEST_DATABASE_URL: postgres:\/\/tapi:tapi@localhost:5432\/tapi_test/);
  assert.doesNotMatch(ci, /secrets\./); // no secrets in the PR-triggered pipeline
});

test("docker-compose workers and Dockerfile point at files that exist", () => {
  const compose = read("docker-compose.yml");
  for (const m of compose.matchAll(/"node", "([^"]+)"/g)) assert.ok(fs.existsSync(R(m[1])), `compose references missing ${m[1]}`);
  const docker = read("Dockerfile");
  for (const m of docker.matchAll(/^COPY (?!--)(\S+) /gm)) for (const src of m[1].split(" ")) assert.ok(fs.existsSync(R(src)), `Dockerfile COPY missing ${src}`);
  assert.match(docker, /USER node/);
});

test("secrets stay out of the image and the repo", () => {
  assert.match(read(".dockerignore"), /^\.env$/m);
  assert.match(read(".gitignore"), /^\.env$/m);
});
