BEGIN;

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS chat_rag_projection_staging (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  boundary_message_id BIGINT NOT NULL,
  session_id BIGINT NOT NULL,
  first_message_id BIGINT NOT NULL,
  last_message_id BIGINT NOT NULL,
  chunk_index INTEGER NOT NULL,
  source_kind TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding_text TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding VECTOR NOT NULL,
  embedding_provider TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (
    user_id,
    preset_id,
    source_generation,
    session_id,
    first_message_id,
    last_message_id,
    chunk_index
  )
);

CREATE INDEX IF NOT EXISTS idx_chat_rag_projection_staging_build
  ON chat_rag_projection_staging(user_id, preset_id, source_generation, boundary_message_id);

COMMIT;
