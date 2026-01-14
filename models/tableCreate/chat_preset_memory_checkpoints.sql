CREATE TABLE IF NOT EXISTS chat_preset_memory_checkpoints (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id VARCHAR(64) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    message_id BIGINT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, preset_id, kind, message_id),
    CONSTRAINT fk_chat_preset_memory_checkpoints_preset
        FOREIGN KEY (user_id, preset_id)
        REFERENCES chat_prompt_presets(user_id, preset_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_chat_preset_memory_checkpoints_lookup
    ON chat_preset_memory_checkpoints(user_id, preset_id, kind, message_id DESC);
