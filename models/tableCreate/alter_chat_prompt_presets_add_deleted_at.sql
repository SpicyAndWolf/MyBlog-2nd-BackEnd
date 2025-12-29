ALTER TABLE chat_prompt_presets
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_prompt_presets_user_deleted_at
  ON chat_prompt_presets(user_id, deleted_at);

