BEGIN;

CREATE TABLE IF NOT EXISTS chat_memory_librarian_checkpoints (
  user_id BIGINT NOT NULL,
  preset_id TEXT NOT NULL,
  source_generation BIGINT NOT NULL,
  completed_turn_ordinal BIGINT NOT NULL,
  boundary_message_id BIGINT NOT NULL,
  last_task_id UUID,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, preset_id, source_generation),
  CONSTRAINT chk_memory_librarian_checkpoint_ordinal CHECK (completed_turn_ordinal >= 0),
  CONSTRAINT chk_memory_librarian_checkpoint_boundary CHECK (boundary_message_id >= 0)
);

COMMIT;
