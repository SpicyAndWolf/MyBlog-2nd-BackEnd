INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url, created_at, updated_at)
SELECT u.id, 'default', '默认', '你是一个专业、耐心、可靠的助手。', NULL, NOW(), NOW()
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM chat_prompt_presets p
  WHERE p.user_id = u.id AND p.preset_id = 'default'
);

BEGIN;

-- 1) 先加字段（先允许 NULL，方便回填）
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS preset_id VARCHAR(64);
ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS preset_id VARCHAR(64);

-- 2) 为每个用户补齐内置 preset 行（示例为 default）
-- 建议把 name/system_prompt 改成与你的内置 preset 一致的值（见 BlogBackEnd/models/chatPresetModel.js）
INSERT INTO chat_prompt_presets (user_id, preset_id, name, system_prompt, avatar_url, created_at, updated_at)
SELECT u.id, 'default', 'Default', '', NULL, NOW(), NOW()
FROM users u
WHERE NOT EXISTS (
  SELECT 1 FROM chat_prompt_presets p
  WHERE p.user_id = u.id AND p.preset_id = 'default'
);

-- 3) 回填 session 的 preset_id（优先 settings 里的 presetId，找不到就回落 default）
UPDATE chat_sessions s
SET preset_id = COALESCE(
  (SELECT p.preset_id
   FROM chat_prompt_presets p
   WHERE p.user_id = s.user_id
     AND p.preset_id = NULLIF(s.settings->>'systemPromptPresetId', '')
   LIMIT 1),
  'default'
)
WHERE s.preset_id IS NULL;

-- 4) 可选：让 settings.systemPromptPresetId 与 preset_id 对齐
UPDATE chat_sessions
SET settings = jsonb_set(settings, '{systemPromptPresetId}', to_jsonb(preset_id::text), true)
WHERE settings->>'systemPromptPresetId' IS DISTINCT FROM preset_id;

-- 5) 回填 messages 的 preset_id
UPDATE chat_messages m
SET preset_id = s.preset_id
FROM chat_sessions s
WHERE m.session_id = s.id
  AND m.preset_id IS NULL;

-- 6) 设置 NOT NULL
ALTER TABLE chat_sessions ALTER COLUMN preset_id SET NOT NULL;
ALTER TABLE chat_messages ALTER COLUMN preset_id SET NOT NULL;

-- 7) 加外键（删除 preset 会级联删除 sessions/messages）
ALTER TABLE chat_sessions
  ADD CONSTRAINT fk_chat_sessions_preset
  FOREIGN KEY (user_id, preset_id)
  REFERENCES chat_prompt_presets(user_id, preset_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE chat_messages
  ADD CONSTRAINT fk_chat_messages_preset
  FOREIGN KEY (user_id, preset_id)
  REFERENCES chat_prompt_presets(user_id, preset_id)
  ON DELETE CASCADE
  ON UPDATE CASCADE;

COMMIT;
