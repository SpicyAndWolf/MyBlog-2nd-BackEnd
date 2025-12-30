const db = require("../db");

function normalizePresetId(rawPresetId) {
  const normalized = String(rawPresetId || "").trim();
  return normalized || null;
}

function normalizeMessageId(rawMessageId) {
  if (rawMessageId === null || rawMessageId === undefined) return null;
  const value = Number(rawMessageId);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) return null;
  return value;
}

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    presetId: row.preset_id,
    rollingSummary: row.rolling_summary || "",
    rollingSummaryUpdatedAt: row.rolling_summary_updated_at || null,
    summarizedUntilMessageId: Number(row.summarized_until_message_id) || 0,
    dirtySinceMessageId: row.dirty_since_message_id === null ? null : Number(row.dirty_since_message_id),
    rebuildRequired: Boolean(row.rebuild_required),
    coreMemory: row.core_memory || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const chatPresetMemoryModel = {
  async getMemory(userId, presetId) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const query = `
      SELECT id, user_id, preset_id, rolling_summary, rolling_summary_updated_at,
             summarized_until_message_id, dirty_since_message_id, rebuild_required,
             core_memory, created_at, updated_at
      FROM chat_preset_memory
      WHERE user_id = $1 AND preset_id = $2
      LIMIT 1
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId]);
    return mapRow(rows[0]) || null;
  },

  async ensureMemory(userId, presetId) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const query = `
      INSERT INTO chat_preset_memory (user_id, preset_id)
      VALUES ($1, $2)
      ON CONFLICT (user_id, preset_id) DO NOTHING
    `;
    await db.query(query, [userId, normalizedPresetId]);
    return await this.getMemory(userId, normalizedPresetId);
  },

  async markDirtyAndClear(userId, presetId, { sinceMessageId, rebuildRequired = false } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedSinceId = normalizeMessageId(sinceMessageId);

    const query = `
      INSERT INTO chat_preset_memory (user_id, preset_id, rolling_summary, summarized_until_message_id, dirty_since_message_id, rebuild_required)
      VALUES ($1, $2, '', 0, $3, $4)
      ON CONFLICT (user_id, preset_id) DO UPDATE
      SET rolling_summary = '',
          rolling_summary_updated_at = NULL,
          summarized_until_message_id = 0,
          dirty_since_message_id = EXCLUDED.dirty_since_message_id,
          rebuild_required = EXCLUDED.rebuild_required,
          updated_at = NOW()
      RETURNING id, user_id, preset_id, rolling_summary, rolling_summary_updated_at,
                summarized_until_message_id, dirty_since_message_id, rebuild_required,
                core_memory, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedSinceId, Boolean(rebuildRequired)]);
    return mapRow(rows[0]) || null;
  },

  async writeRollingSummary(userId, presetId, { rollingSummary, summarizedUntilMessageId } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedSummary = String(rollingSummary || "").trim();
    const normalizedUntil = normalizeMessageId(summarizedUntilMessageId);
    if (normalizedUntil === null) throw new Error("summarizedUntilMessageId must be a non-negative integer");

    const query = `
      INSERT INTO chat_preset_memory (user_id, preset_id, rolling_summary, rolling_summary_updated_at, summarized_until_message_id, dirty_since_message_id, rebuild_required)
      VALUES ($1, $2, $3, NOW(), $4, NULL, false)
      ON CONFLICT (user_id, preset_id) DO UPDATE
      SET rolling_summary = EXCLUDED.rolling_summary,
          rolling_summary_updated_at = NOW(),
          summarized_until_message_id = EXCLUDED.summarized_until_message_id,
          dirty_since_message_id = NULL,
          rebuild_required = false,
          updated_at = NOW()
      RETURNING id, user_id, preset_id, rolling_summary, rolling_summary_updated_at,
                summarized_until_message_id, dirty_since_message_id, rebuild_required,
                core_memory, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedSummary, normalizedUntil]);
    return mapRow(rows[0]) || null;
  },

  async writeRollingSummaryProgress(userId, presetId, { rollingSummary, summarizedUntilMessageId } = {}) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const normalizedSummary = String(rollingSummary || "").trim();
    const normalizedUntil = normalizeMessageId(summarizedUntilMessageId);
    if (normalizedUntil === null) throw new Error("summarizedUntilMessageId must be a non-negative integer");

    const query = `
      INSERT INTO chat_preset_memory (user_id, preset_id, rolling_summary, rolling_summary_updated_at, summarized_until_message_id)
      VALUES ($1, $2, $3, NOW(), $4)
      ON CONFLICT (user_id, preset_id) DO UPDATE
      SET rolling_summary = EXCLUDED.rolling_summary,
          rolling_summary_updated_at = NOW(),
          summarized_until_message_id = EXCLUDED.summarized_until_message_id,
          updated_at = NOW()
      RETURNING id, user_id, preset_id, rolling_summary, rolling_summary_updated_at,
                summarized_until_message_id, dirty_since_message_id, rebuild_required,
                core_memory, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, normalizedSummary, normalizedUntil]);
    return mapRow(rows[0]) || null;
  },

  async setRebuildRequired(userId, presetId, rebuildRequired) {
    const normalizedPresetId = normalizePresetId(presetId);
    if (!normalizedPresetId) throw new Error("Preset id is required");

    const query = `
      UPDATE chat_preset_memory
      SET rebuild_required = $3,
          updated_at = NOW()
      WHERE user_id = $1 AND preset_id = $2
      RETURNING id, user_id, preset_id, rolling_summary, rolling_summary_updated_at,
                summarized_until_message_id, dirty_since_message_id, rebuild_required,
                core_memory, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, normalizedPresetId, Boolean(rebuildRequired)]);
    return mapRow(rows[0]) || null;
  },
};

module.exports = chatPresetMemoryModel;
