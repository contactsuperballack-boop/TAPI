// Tests for API-key lifecycle management: generation, hashing, prefixes,
// expiration, revocation, last-used tracking, and listing without exposing
// the secret again.
const request = require("supertest");
const { resetDatabase, seedAgency, closeDb } = require("./setup");

let app;
let agencyA;

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;
  await resetDatabase();
  agencyA = await seedAgency("API Key Test Agency");
  app = require("../src/app");
});

afterAll(async () => {
  // Fix for a confirmed open-handle leak: nothing was closing the shared
  // connection pool app.js uses, so Jest correctly reported open handles
  // after every suite finished.
  await closeDb();
});

describe("API key creation", () => {
  test("creates a key and returns the raw secret exactly once", async () => {
    const res = await request(app)
      .post("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ label: "CI key" });

    expect(res.status).toBe(201);
    expect(res.body.apiKey).toMatch(/^tapi_live_/);
    expect(res.body.client.keyPrefix).toBe(res.body.apiKey.slice(0, res.body.client.keyPrefix.length));
    expect(res.body.client.status).toBe("active");
    expect(res.body.client.isActive).toBe(true);
    // the response must NEVER include a hash or any other recoverable form of the secret
    expect(res.body.client.keyHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("key_hash");
  });

  test("the newly created key actually authenticates", async () => {
    const created = await request(app)
      .post("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ label: "usable key" });

    const res = await request(app)
      .get("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${created.body.apiKey}`);
    expect(res.status).toBe(200);
  });

  test("a key created with expiresInDays=0-adjacent value is rejected by validation, not silently accepted", async () => {
    const res = await request(app)
      .post("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ expiresInDays: 0 });
    expect(res.status).toBe(400);
  });
});

describe("API key listing", () => {
  test("lists keys without ever exposing the secret or hash", async () => {
    await request(app).post("/v1/auth/api-keys").set("Authorization", `Bearer ${agencyA.apiKey}`).send({ label: "listed-key-1" });

    const res = await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(res.status).toBe(200);
    expect(res.body.keys.length).toBeGreaterThan(0);
    for (const key of res.body.keys) {
      expect(key).toHaveProperty("keyPrefix");
      expect(key).toHaveProperty("isActive");
      expect(key).toHaveProperty("isExpired");
      expect(key).toHaveProperty("lastUsedAt");
      expect(key).not.toHaveProperty("apiKey");
      expect(key).not.toHaveProperty("keyHash");
      expect(JSON.stringify(key)).not.toMatch(/^tapi_live_[A-Za-z0-9_-]{20,}/); // full raw key never present
    }
  });

  test("agency B cannot see agency A's keys (tenant isolation)", async () => {
    const agencyB = await seedAgency("API Key Agency B");
    const res = await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${agencyB.apiKey}`);
    const prefixesForB = res.body.keys.map((k) => k.keyPrefix);
    expect(prefixesForB).not.toContain(undefined);
    // None of agency A's earlier-created key prefixes should leak into B's list
    const agencyAKeys = await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${agencyA.apiKey}`);
    const agencyAPrefixes = agencyAKeys.body.keys.map((k) => k.keyPrefix);
    for (const prefix of agencyAPrefixes) {
      expect(prefixesForB).not.toContain(prefix);
    }
  });
});

describe("API key revocation", () => {
  test("a revoked key can no longer authenticate", async () => {
    const created = await request(app)
      .post("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ label: "to-be-revoked" });

    const revoke = await request(app)
      .post(`/v1/auth/api-keys/${created.body.client.id}/revoke`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(revoke.status).toBe(200);
    expect(revoke.body.status).toBe("revoked");

    const attemptUse = await request(app)
      .get("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${created.body.apiKey}`);
    expect(attemptUse.status).toBe(401);
  });

  test("revoking an already-revoked key 404s rather than silently no-op-ing", async () => {
    const created = await request(app)
      .post("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ label: "double-revoke-test" });
    await request(app).post(`/v1/auth/api-keys/${created.body.client.id}/revoke`).set("Authorization", `Bearer ${agencyA.apiKey}`);

    const secondRevoke = await request(app)
      .post(`/v1/auth/api-keys/${created.body.client.id}/revoke`)
      .set("Authorization", `Bearer ${agencyA.apiKey}`);
    expect(secondRevoke.status).toBe(404);
  });

  test("agency B cannot revoke agency A's key", async () => {
    const agencyB = await seedAgency("API Key Agency C");
    const created = await request(app)
      .post("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ label: "not-yours-to-revoke" });

    const res = await request(app)
      .post(`/v1/auth/api-keys/${created.body.client.id}/revoke`)
      .set("Authorization", `Bearer ${agencyB.apiKey}`);
    expect(res.status).toBe(404); // not "belongs to someone else", just not found — no cross-tenant existence leak
  });
});

describe("API key expiration", () => {
  test("a key created with a past-dated expiry (simulated via direct expiry check) reports isExpired", async () => {
    // expiresInDays must be >=1 per validation, so to exercise the expired
    // path deterministically we create with 1 day and then check the
    // isExpired flag's logic directly rather than waiting a real day.
    const { ApiKeys } = require("../src/services/apiKeys");
    const created = await ApiKeys.create({ agencyId: agencyA.agencyId, label: "expiry-check", expiresInDays: 1 });
    expect(created.client.isExpired).toBe(false); // not expired yet, 1 day out

    // Directly verify an already-past expiry is detected without needing to sleep a day:
    const db = require("../src/db");
    await db.query(`UPDATE api_clients SET expires_at = now() - interval '1 hour' WHERE id = $1`, [created.client.id]);

    const res = await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${agencyA.apiKey}`);
    const found = res.body.keys.find((k) => k.id === created.client.id);
    expect(found.isExpired).toBe(true);
    expect(found.isActive).toBe(false); // active status but expired -> not usable

    const attemptUse = await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${created.rawKey}`);
    expect(attemptUse.status).toBe(401);
  });
});

describe("Last-used tracking", () => {
  test("lastUsedAt is populated after the key is used", async () => {
    const created = await request(app)
      .post("/v1/auth/api-keys")
      .set("Authorization", `Bearer ${agencyA.apiKey}`)
      .send({ label: "last-used-test" });

    let found = (await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${agencyA.apiKey}`))
      .body.keys.find((k) => k.id === created.body.client.id);
    expect(found.lastUsedAt).toBeNull();

    // Use the new key once
    await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${created.body.apiKey}`);
    // touchLastUsed is fire-and-forget in the auth middleware; give it a tick
    await new Promise((r) => setTimeout(r, 50));

    found = (await request(app).get("/v1/auth/api-keys").set("Authorization", `Bearer ${agencyA.apiKey}`))
      .body.keys.find((k) => k.id === created.body.client.id);
    expect(found.lastUsedAt).not.toBeNull();
  });
});
