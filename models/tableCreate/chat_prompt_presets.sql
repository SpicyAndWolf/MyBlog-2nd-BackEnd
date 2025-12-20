CREATE TABLE chat_prompt_presets (
    id BIGSERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    preset_id VARCHAR(64) NOT NULL,
    name VARCHAR(120) NOT NULL,
    system_prompt TEXT NOT NULL DEFAULT '',
    avatar_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, preset_id)
);

CREATE INDEX idx_chat_prompt_presets_user_id ON chat_prompt_presets(user_id);
CREATE INDEX idx_chat_prompt_presets_user_updated_at ON chat_prompt_presets(user_id, updated_at DESC);
