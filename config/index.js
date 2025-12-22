const { readBoolEnv, readFloatEnv, readIntEnv, readStringEnv } = require("./readEnv");

function clampNumber(value, { min, max, fallback }) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function readProviderDefaultSettings(prefix, baseDefaults) {
  const base = baseDefaults && typeof baseDefaults === "object" && !Array.isArray(baseDefaults) ? baseDefaults : {};
  const normalizedPrefix = String(prefix || "").trim().toUpperCase();
  if (!normalizedPrefix) return { ...base };

  return {
    ...base,
    temperature: clampNumber(readFloatEnv(`${normalizedPrefix}_DEFAULT_TEMPERATURE`, base.temperature), {
      min: 0,
      max: 2,
      fallback: base.temperature,
    }),
    topP: clampNumber(readFloatEnv(`${normalizedPrefix}_DEFAULT_TOP_P`, base.topP), { min: 0, max: 1, fallback: base.topP }),
    maxOutputTokens: clampNumber(readIntEnv(`${normalizedPrefix}_DEFAULT_MAX_OUTPUT_TOKENS`, base.maxOutputTokens), {
      min: 1,
      max: 200000,
      fallback: base.maxOutputTokens,
    }),
    presencePenalty: clampNumber(readFloatEnv(`${normalizedPrefix}_DEFAULT_PRESENCE_PENALTY`, base.presencePenalty), {
      min: -2,
      max: 2,
      fallback: base.presencePenalty,
    }),
    frequencyPenalty: clampNumber(readFloatEnv(`${normalizedPrefix}_DEFAULT_FREQUENCY_PENALTY`, base.frequencyPenalty), {
      min: -2,
      max: 2,
      fallback: base.frequencyPenalty,
    }),
    stream: readBoolEnv(`${normalizedPrefix}_DEFAULT_STREAM`, base.stream),
    enableWebSearch: readBoolEnv(`${normalizedPrefix}_DEFAULT_ENABLE_WEB_SEARCH`, base.enableWebSearch),
  };
}

const baseChatDefaultSettings = {
  temperature: clampNumber(readFloatEnv("CHAT_DEFAULT_TEMPERATURE", 0.7), { min: 0, max: 2, fallback: 0.7 }),
  topP: clampNumber(readFloatEnv("CHAT_DEFAULT_TOP_P", 0.9), { min: 0, max: 1, fallback: 0.9 }),
  maxOutputTokens: clampNumber(readIntEnv("CHAT_DEFAULT_MAX_OUTPUT_TOKENS", 4096), {
    min: 1,
    max: 200000,
    fallback: 4096,
  }),
  presencePenalty: clampNumber(readFloatEnv("CHAT_DEFAULT_PRESENCE_PENALTY", 0), { min: -2, max: 2, fallback: 0 }),
  frequencyPenalty: clampNumber(readFloatEnv("CHAT_DEFAULT_FREQUENCY_PENALTY", 0), {
    min: -2,
    max: 2,
    fallback: 0,
  }),
  stream: readBoolEnv("CHAT_DEFAULT_STREAM", true),
  enableWebSearch: readBoolEnv("CHAT_DEFAULT_ENABLE_WEB_SEARCH", true),
  systemPromptPresetId: readStringEnv("CHAT_DEFAULT_SYSTEM_PROMPT_PRESET_ID", "default"),
};

const chatConfig = {
  maxContextMessages: readIntEnv("CHAT_MAX_CONTEXT_MESSAGES", 2000),
  maxContextChars: readIntEnv("CHAT_MAX_CONTEXT_CHARS", 128000),
  historyLimit: readIntEnv("CHAT_HISTORY_LIMIT", 48),
  defaultProviderId: readStringEnv("CHAT_DEFAULT_PROVIDER", "deepseek"),
  defaultModelByProvider: {
    grok: readStringEnv("GROK_DEFAULT_MODEL", "grok-4"),
    deepseek: readStringEnv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat"),
  },
  defaultSettings: baseChatDefaultSettings,
  defaultSettingsByProvider: {
    grok: readProviderDefaultSettings("GROK", baseChatDefaultSettings),
    deepseek: readProviderDefaultSettings("DEEPSEEK", baseChatDefaultSettings),
  },
};

const llmConfig = {
  timeoutMs: readIntEnv("LLM_TIMEOUT_MS", 60000),
};

const articleConfig = {
  tempImageTtlMs: readIntEnv("ARTICLE_TEMP_IMAGE_TTL_MS", 24 * 60 * 60 * 1000),
  cleanupIntervalMs: readIntEnv("ARTICLE_CLEAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
};

module.exports = {
  chatConfig,
  llmConfig,
  articleConfig,
};
