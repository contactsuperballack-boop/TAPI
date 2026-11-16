// API-key lifecycle management (T-020 extended). Self-service: an agency
// manages its own keys using an existing valid key — there's no separate
// admin/bootstrap auth here in MVP scope (bootstrapping the first key per
// agency is done via seed.js / an internal-only process, not a public route).
const express = require("express");
const { ApiKeys } = require("../services/apiKeys");
const { Errors } = require("../domain/errors");
const { z } = require("zod");
const { validateBody } = require("../validation/schemas");

const router = express.Router();

const createKeySchema = z.object({
  label: z.string().min(1).max(200).optional(),
  expiresInDays: z.number().int().min(1).max(3650).optional(),
  env: z.enum(["live", "test"]).optional(),
});

// POST /v1/auth/api-keys — create a new key for the authenticated agency.
// The raw key is returned exactly once, here. It is never retrievable again.
router.post("/api-keys", validateBody(createKeySchema), async (req, res, next) => {
  try {
    const { label, expiresInDays, env } = req.body;
    const { rawKey, client } = await ApiKeys.create({
      agencyId: req.tenant.agencyId,
      label,
      expiresInDays,
      env,
    });
    res.status(201).json({
      apiKey: rawKey,
      client: {
        id: client.id,
        keyPrefix: client.keyPrefix,
        label: client.label,
        status: client.status,
        isActive: client.isActive,
        isExpired: client.isExpired,
        expiresAt: client.expiresAt,
        lastUsedAt: client.lastUsedAt,
        createdAt: client.createdAt,
      },
    });
  } catch (err) {
    next(err);
  }
});

// GET /v1/auth/api-keys — list keys for the authenticated agency. Never
// exposes key_hash or any form of the raw secret.
router.get("/api-keys", async (req, res, next) => {
  try {
    const keys = await ApiKeys.listForAgency(req.tenant.agencyId);
    res.json({
      keys: keys.map((k) => ({
        id: k.id,
        keyPrefix: k.keyPrefix,
        label: k.label,
        status: k.status,
        isActive: k.isActive,
        isExpired: k.isExpired,
        expiresAt: k.expiresAt,
        lastUsedAt: k.lastUsedAt,
        createdAt: k.createdAt,
        revokedAt: k.revokedAt,
      })),
    });
  } catch (err) {
    next(err);
  }
});

// POST /v1/auth/api-keys/:id/revoke — revoke a key. Idempotent-ish: revoking
// an already-revoked key 404s rather than silently no-op-ing, so a caller
// knows their revoke didn't land on an active key.
router.post("/api-keys/:id/revoke", async (req, res, next) => {
  try {
    const revoked = await ApiKeys.revoke(req.tenant.agencyId, req.params.id);
    if (!revoked) throw Errors.NotFound("Active API key");
    res.json({
      id: revoked.id,
      keyPrefix: revoked.keyPrefix,
      status: revoked.status,
      revokedAt: revoked.revokedAt,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
