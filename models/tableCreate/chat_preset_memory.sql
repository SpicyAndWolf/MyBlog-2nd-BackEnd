CREATE TABLE chat_preset_memory (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id VARCHAR(64) NOT NULL,
    rolling_summary TEXT NOT NULL DEFAULT '',
    rolling_summary_updated_at TIMESTAMPTZ,
    summarized_until_message_id BIGINT NOT NULL DEFAULT 0,
    dirty_since_message_id BIGINT,
    rebuild_required BOOLEAN NOT NULL DEFAULT false,
    core_memory JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, preset_id),
    CONSTRAINT fk_chat_preset_memory_preset
        FOREIGN KEY (user_id, preset_id)
        REFERENCES chat_prompt_presets(user_id, preset_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX idx_chat_preset_memory_user_preset ON chat_preset_memory(user_id, preset_id);
CREATE INDEX idx_chat_preset_memory_user_updated_at ON chat_preset_memory(user_id, updated_at DESC);

