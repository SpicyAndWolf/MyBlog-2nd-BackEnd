-- Active: 1767016084715@@127.0.0.1@5432@blog
CREATE TABLE IF NOT EXISTS chat_message_gists (
  message_id BIGINT PRIMARY KEY,
  user_id BIGINT NOT NULL,
  preset_id VARCHAR(64) NOT NULL,
  gist_text TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provider_id VARCHAR(32) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_chat_message_gists_message
    FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_message_gists_user_preset_id
  ON chat_message_gists (user_id, preset_id, message_id DESC);
