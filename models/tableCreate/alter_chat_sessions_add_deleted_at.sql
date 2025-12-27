ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_deleted_at
  ON chat_sessions(user_id, deleted_at);
