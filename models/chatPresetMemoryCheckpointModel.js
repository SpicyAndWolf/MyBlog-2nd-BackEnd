const db = require("../db");

const CHECKPOINT_KINDS = Object.freeze({
  rollingSummary: "rolling_summary",
  coreMemory: "core_memory",
});

const CHECKPOINT_KIND_SET = new Set(Object.values(CHECKPOINT_KINDS));

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizePresetId(rawPresetId) {
  const normalized = String(rawPresetId || "").trim();
  return normalized || null;
}

function normalizeKind(rawKind) {
  const normalized = String(rawKind || "").trim();
  if (!normalized) return null;
  if (!CHECKPOINT_KIND_SET.has(normalized)) {
    throw new Error(`Unsupported checkpoint kind: ${normalized}`);
  }
  return normalized;
}

function normalizeMessageId(rawMessageId) {
  if (rawMessageId === null || rawMessageId === undefined) return null;
  const value = Number(rawMessageId);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function normalizePayload(rawPayload) {
  if (!isPlainObject(rawPayload)) return {};
  return rawPayload;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    presetId: row.preset_id,
    kind: row.kind,
    messageId: Number(row.message_id) || 0,
    payload: isPlainObject(row.payload) ? row.payload : {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const chatPresetMemoryCheckpointModel = {
  CHECKPOINT_KINDS,

  async upsertCheckpoint(userId, presetId, { kind, messageId, payload } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) throw new Error("kind is required");

    const normalizedMessageId = normalizeMessageId(messageId);
    if (normalizedMessageId === null) throw new Error("messageId must be a non-negative integer");

    const normalizedPayload = normalizePayload(payload);

    const query = `
      INSERT INTO chat_preset_memory_checkpoints (user_id, preset_id, kind, message_id, payload)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (user_id, preset_id, kind, message_id) DO UPDATE
      SET payload = EXCLUDED.payload,
          updated_at = NOW()
      RETURNING id, user_id, preset_id, kind, message_id, payload, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedKind, normalizedMessageId, normalizedPayload]);
    return mapRow(rows[0]) || null;
  },

  async getLatestCheckpointBeforeOrAt(userId, presetId, { kind, maxMessageId } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) throw new Error("kind is required");

    const normalizedMax = normalizeMessageId(maxMessageId);
    if (normalizedMax === null) throw new Error("maxMessageId must be a non-negative integer");

    const query = `
      SELECT id, user_id, preset_id, kind, message_id, payload, created_at, updated_at
      FROM chat_preset_memory_checkpoints
      WHERE user_id = $1 AND preset_id = $2 AND kind = $3 AND message_id <= $4
      ORDER BY message_id DESC
      LIMIT 1
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedKind, normalizedMax]);
    return mapRow(rows[0]) || null;
  },

  async getLatestCheckpoint(userId, presetId, { kind } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) throw new Error("kind is required");

    const query = `
      SELECT id, user_id, preset_id, kind, message_id, payload, created_at, updated_at
      FROM chat_preset_memory_checkpoints
      WHERE user_id = $1 AND preset_id = $2 AND kind = $3
      ORDER BY message_id DESC
      LIMIT 1
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedKind]);
    return mapRow(rows[0]) || null;
  },

  async deleteCheckpointsFromMessageId(userId, presetId, { kinds, fromMessageId } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedFrom = normalizeMessageId(fromMessageId);
    if (normalizedFrom === null) throw new Error("fromMessageId must be a non-negative integer");

    const requestedKinds = Array.isArray(kinds) ? kinds : [];
    const normalizedKinds = requestedKinds.map(normalizeKind).filter(Boolean);
    if (!normalizedKinds.length) throw new Error("kinds is required");

    const query = `
      DELETE FROM chat_preset_memory_checkpoints
      WHERE user_id = $1 AND preset_id = $2 AND kind = ANY($3) AND message_id >= $4
    `;
    const { rowCount } = await db.query(query, [userId, normalizedPresetId, normalizedKinds, normalizedFrom]);
    return rowCount || 0;
  },

  async pruneKeepLastN(userId, presetId, { kind, keepLastN, protectMessageId } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedKind = normalizeKind(kind);
    if (!normalizedKind) throw new Error("kind is required");

    const normalizedKeep = Number(keepLastN);
    if (!Number.isFinite(normalizedKeep) || !Number.isInteger(normalizedKeep) || normalizedKeep < 0) {
      throw new Error("keepLastN must be a non-negative integer");
    }

    const normalizedProtect = normalizeMessageId(protectMessageId);
    if (protectMessageId !== undefined && protectMessageId !== null && normalizedProtect === null) {
      throw new Error("protectMessageId must be a non-negative integer");
    }

    if (normalizedKeep === 0) {
      if (normalizedProtect === null) {
        const query = `
          DELETE FROM chat_preset_memory_checkpoints
          WHERE user_id = $1 AND preset_id = $2 AND kind = $3
        `;
        const { rowCount } = await db.query(query, [userId, normalizedPresetId, normalizedKind]);
        return rowCount || 0;
      }

      const query = `
        DELETE FROM chat_preset_memory_checkpoints
        WHERE user_id = $1 AND preset_id = $2 AND kind = $3 AND message_id <> $4
      `;
      const { rowCount } = await db.query(query, [userId, normalizedPresetId, normalizedKind, normalizedProtect]);
      return rowCount || 0;
    }

    const query = `
      WITH ranked AS (
        SELECT id,
               message_id,
               ROW_NUMBER() OVER (ORDER BY message_id DESC) AS rn
        FROM chat_preset_memory_checkpoints
        WHERE user_id = $1 AND preset_id = $2 AND kind = $3
      )
      DELETE FROM chat_preset_memory_checkpoints c
      USING ranked r
      WHERE c.id = r.id AND r.rn > $4 AND ($5::BIGINT IS NULL OR c.message_id <> $5)
    `;
    const { rowCount } = await db.query(query, [userId, normalizedPresetId, normalizedKind, normalizedKeep, normalizedProtect]);
    return rowCount || 0;
  },
};

module.exports = chatPresetMemoryCheckpointModel;
