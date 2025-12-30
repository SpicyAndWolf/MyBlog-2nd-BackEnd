-- Active: 1767016084715@@127.0.0.1@5432@blog
-- Speeds up recent_window queries (Phase 1+)
CREATE INDEX IF NOT EXISTS idx_chat_messages_user_preset_id_desc
  ON chat_messages (user_id, preset_id, id DESC);

