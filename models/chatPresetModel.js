const db = require("../db");

const DEFAULT_PRESETS = [
  {
    id: "default",
    name: "默认",
    systemPrompt: "你是一个专业、耐心、可靠的助手。请用中文回答，必要时给出清晰步骤与示例。",
    avatarUrl: null,
  },
  {
    id: "neko",
    name: "Neko",
    systemPrompt: "你是一位猫娘女仆。",
    avatarUrl: null,
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
  };
}

async function ensureSeedPresets(client, userId) {
  const { rows: existing } = await client.query(
    "SELECT preset_id FROM chat_prompt_presets WHERE user_id = $1 LIMIT 1",
    [userId]
  );
  if (existing.length > 0) return;

  const values = [];
  const placeholders = [];
  let index = 1;
  for (const preset of DEFAULT_PRESETS) {
    placeholders.push(`($${index++}, $${index++}, $${index++}, $${index++}, $${index++})`);
    values.push(userId, preset.id, preset.name, preset.systemPrompt, preset.avatarUrl);
  }

  await client.query(
    `
      INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url)
      VALUES ${placeholders.join(", ")}
    `,
    values
  );
}

const chatPresetModel = {
  async listPresets(userId) {
    const client = await db.getClient();
    try {
      await client.query("BEGIN");
      await ensureSeedPresets(client, userId);

      const { rows } = await client.query(
        `
          SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at
          FROM chat_prompt_presets
          WHERE user_id = $1
          ORDER BY updated_at DESC, preset_id ASC
        `,
        [userId]
      );

      await client.query("COMMIT");
      return rows.map(mapRow).filter(Boolean);
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

  async getPreset(userId, presetId) {
    const query = `
      SELECT preset_id, name, system_prompt, avatar_url, created_at, updated_at
      FROM chat_prompt_presets
      WHERE user_id = $1 AND preset_id = $2
    `;
    const { rows } = await db.query(query, [userId, presetId]);
    return mapRow(rows[0]) || null;
  },

  async createPreset(userId, { id, name, systemPrompt, avatarUrl } = {}) {
    const query = `
      INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at
    `;
    const { rows } = await db.query(query, [userId, id, name, systemPrompt || "", avatarUrl || null]);
    return mapRow(rows[0]) || null;
  },

  async updatePreset(userId, presetId, { id, name, systemPrompt, avatarUrl } = {}) {
    const client = await db.getClient();
    try {
      await client.query("BEGIN");

      const { rows: existingRows } = await client.query(
        `
          SELECT preset_id
          FROM chat_prompt_presets
          WHERE user_id = $1 AND preset_id = $2
          LIMIT 1
        `,
        [userId, presetId]
      );
      if (existingRows.length === 0) {
        await client.query("ROLLBACK");
        return null;
      }

      const nextId = id ?? presetId;

      const { rows } = await client.query(
        `
          UPDATE chat_prompt_presets
          SET preset_id = $1,
              name = COALESCE($2, name),
              system_prompt = COALESCE($3, system_prompt),
              avatar_url = COALESCE($4, avatar_url),
              updated_at = NOW()
          WHERE user_id = $5 AND preset_id = $6
          RETURNING preset_id, name, system_prompt, avatar_url, created_at, updated_at
        `,
        [nextId, name ?? null, systemPrompt ?? null, avatarUrl ?? null, userId, presetId]
      );

      const updated = mapRow(rows[0]) || null;

      if (updated && nextId !== presetId) {
        await client.query(
          `
            UPDATE chat_sessions
            SET settings = jsonb_set(settings, '{systemPromptPresetId}', to_jsonb($1::text), true),
                updated_at = NOW()
            WHERE user_id = $2 AND settings->>'systemPromptPresetId' = $3
          `,
          [nextId, userId, presetId]
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

      await ensureSeedPresets(client, userId);

      const { rows: fallbackRows } = await client.query(
        `
          SELECT preset_id
          FROM chat_prompt_presets
          WHERE user_id = $1
          ORDER BY (preset_id = 'default') DESC, updated_at DESC, preset_id ASC
          LIMIT 1
        `,
        [userId]
      );
      const fallbackPresetId = fallbackRows[0]?.preset_id || null;

      if (fallbackPresetId) {
        await client.query(
          `
            UPDATE chat_sessions
            SET settings = jsonb_set(settings, '{systemPromptPresetId}', to_jsonb($1::text), true),
                updated_at = NOW()
            WHERE user_id = $2 AND settings->>'systemPromptPresetId' = $3
          `,
          [fallbackPresetId, userId, presetId]
        );
      }

      await client.query("COMMIT");
      return { deleted: true, fallbackPresetId };
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

