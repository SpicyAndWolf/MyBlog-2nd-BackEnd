const db = require("../db");

const BUILT_IN_PRESETS = [
  {
    id: "default",
    name: "默认",
    systemPrompt: "你是一个专业、耐心、可靠的助手。",
    avatarUrl: null,
    isBuiltin: true,
  },
];

function mapRow(row) {
  if (!row) return null;
  return {
    id: row.preset_id,
    name: row.name,
    systemPrompt: row.system_prompt,
    avatarUrl: row.avatar_url || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    isBuiltin: false,
  };
}

const BUILT_IN_PRESET_IDS = new Set(BUILT_IN_PRESETS.map((preset) => preset.id));

function isBuiltinPresetId(presetId) {
  const normalizedId = String(presetId || "").trim();
  return BUILT_IN_PRESET_IDS.has(normalizedId);
}

function findBuiltinPreset(presetId) {
  const normalizedId = String(presetId || "").trim();
  return BUILT_IN_PRESETS.find((preset) => preset.id === normalizedId) || null;
}

function withBuiltinMetadata(preset) {
  if (!preset) return null;
  return {
    id: preset.id,
    name: preset.name,
    systemPrompt: preset.systemPrompt || "",
    avatarUrl: preset.avatarUrl || null,
    createdAt: null,
    updatedAt: null,
    isBuiltin: true,
  };
}

async function ensureBuiltinPresets(userId, presetIds = null) {
  if (!userId) return;
  const ids = Array.isArray(presetIds) ? presetIds.map((id) => String(id || "").trim()) : null;
  const targets = ids ? BUILT_IN_PRESETS.filter((preset) => ids.includes(preset.id)) : BUILT_IN_PRESETS;
  if (!targets.length) return;

  const query = `
    INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (user_id, preset_id) DO NOTHING
  `;

  for (const preset of targets) {
    await db.query(query, [
      userId,
      preset.id,
      preset.name,
      preset.systemPrompt || "",
      preset.avatarUrl || null,
    ]);
  }
}

const chatPresetModel = {
  BUILT_IN_PRESETS: BUILT_IN_PRESETS.map(withBuiltinMetadata).filter(Boolean),
  isBuiltinPresetId,
  ensureBuiltinPresets,

  async listPresets(userId) {
    await ensureBuiltinPresets(userId);
    const builtins = chatPresetModel.BUILT_IN_PRESETS;
    const builtinIds = [...BUILT_IN_PRESET_IDS];

    const query = `
      SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at
      FROM chat_prompt_presets
      WHERE user_id = $1 AND NOT (preset_id = ANY($2::text[]))
      ORDER BY updated_at DESC, preset_id ASC
    `;
    const { rows } = await db.query(query, [userId, builtinIds]);
    const customs = rows.map(mapRow).filter(Boolean);

    return [...builtins, ...customs];
  },

  async getPreset(userId, presetId) {
    if (isBuiltinPresetId(presetId)) {
      await ensureBuiltinPresets(userId, [presetId]);
      return withBuiltinMetadata(findBuiltinPreset(presetId));
    }

    const query = `
      SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at
      FROM chat_prompt_presets
      WHERE user_id = $1 AND preset_id = $2
    `;
    const { rows } = await db.query(query, [userId, presetId]);
    return mapRow(rows[0]) || null;
  },

  async createPreset(userId, { id, name, systemPrompt, avatarUrl } = {}) {
    if (isBuiltinPresetId(id)) {
      const error = new Error("Builtin preset id is reserved");
      error.code = "BUILTIN_PRESET_ID";
      throw error;
    }

    const query = `
      INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, id, name, systemPrompt || "", avatarUrl || null]);
    return mapRow(rows[0]) || null;
  },

  async updatePreset(userId, presetId, { id, name, systemPrompt, avatarUrl } = {}) {
    if (isBuiltinPresetId(presetId)) {
      const error = new Error("Builtin preset cannot be updated");
      error.code = "BUILTIN_PRESET_READONLY";
      throw error;
    }

    const nextId = id ?? presetId;
    if (isBuiltinPresetId(nextId)) {
      const error = new Error("Builtin preset id is reserved");
      error.code = "BUILTIN_PRESET_ID";
      throw error;
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const { rows: existingRows } = await client.query(
        `
          SELECT preset_id, system_prompt
          FROM chat_prompt_presets
          WHERE user_id = $1 AND preset_id = $2
          LIMIT 1
          FOR UPDATE
        `,
        [userId, presetId]
      );
      if (existingRows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const previousSystemPrompt = String(existingRows[0]?.system_prompt ?? "");
      const nextSystemPrompt = typeof systemPrompt === "string" ? systemPrompt : previousSystemPrompt;

      const { rows } = await client.query(
        `
          UPDATE chat_prompt_presets
          SET preset_id = $1,
              name = COALESCE($2, name),
              system_prompt = $3,
              avatar_url = COALESCE($4, avatar_url),
              updated_at = NOW()
          WHERE user_id = $5 AND preset_id = $6
          RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at
        `,
        [nextId, name ?? null, nextSystemPrompt, avatarUrl ?? null, userId, presetId]
      );

      const updated = mapRow(rows[0]) || null;

      const shouldUpdateSessions =
        Boolean(updated) &&
        (nextId !== presetId || (typeof systemPrompt === "string" && nextSystemPrompt !== previousSystemPrompt));

      if (shouldUpdateSessions) {
        await client.query(
          `
            UPDATE chat_sessions
            SET settings = jsonb_set(
                  jsonb_set(settings, '{systemPromptPresetId}', to_jsonb($1::text), true),
                  '{systemPrompt}', to_jsonb($2::text), true
                ),
                updated_at = NOW()
            WHERE user_id = $3 AND preset_id = $4
          `,
          [nextId, updated.systemPrompt || "", userId, presetId]
        );
      }

      await client.query("COMMIT");
      return updated;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
    }
  },

  async updatePresetAvatar(userId, presetId, avatarUrl) {
    if (isBuiltinPresetId(presetId)) return null;

    const query = `
      UPDATE chat_prompt_presets
      SET avatar_url = $1, updated_at = NOW()
      WHERE user_id = $2 AND preset_id = $3
      RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at
    `;
    const { rows } = await db.query(query, [avatarUrl, userId, presetId]);
    return mapRow(rows[0]) || null;
  },

  async deletePreset(userId, presetId) {
    if (isBuiltinPresetId(presetId)) {
      const error = new Error("Builtin preset cannot be deleted");
      error.code = "BUILTIN_PRESET_READONLY";
      throw error;
    }

    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const { rowCount } = await client.query(
        `
          DELETE FROM chat_prompt_presets
          WHERE user_id = $1 AND preset_id = $2
        `,
        [userId, presetId]
      );

      if (rowCount === 0) {
        await client.query("ROLLBACK");
        return { deleted: false, fallbackPresetId: null };
      }

      await client.query("COMMIT");
      return { deleted: true, fallbackPresetId: null };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore
      }
      throw error;
    } finally {
      client.release();
    }
  },
};

module.exports = chatPresetModel;
