CREATE TABLE chat_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id VARCHAR(64) NOT NULL,
    title VARCHAR(120) NOT NULL DEFAULT '新对话',
    settings JSONB NOT NULL DEFAULT '{}'::jsonb,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT fk_chat_sessions_preset
        FOREIGN KEY (user_id, preset_id)
        REFERENCES chat_prompt_presets(user_id, preset_id)
        ON DELETE CASCADE
        ON UPDATE CASCADE
);

CREATE INDEX idx_chat_sessions_user_id ON chat_sessions(user_id);
CREATE INDEX idx_chat_sessions_user_updated_at ON chat_sessions(user_id, updated_at DESC);
CREATE INDEX idx_chat_sessions_user_deleted_at ON chat_sessions(user_id, deleted_at);
