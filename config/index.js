const { readIntEnv, readStringEnv } = require("./readEnv");

const chatConfig = {
  maxContextMessages: readIntEnv("CHAT_MAX_CONTEXT_MESSAGES", 500),
  maxContextChars: readIntEnv("CHAT_MAX_CONTEXT_CHARS", 96000),
  historyLimit: readIntEnv("CHAT_HISTORY_LIMIT", 48),
  defaultProviderId: readStringEnv("CHAT_DEFAULT_PROVIDER", "deepseek"),
  defaultModelByProvider: {
    grok: readStringEnv("GROK_DEFAULT_MODEL", "grok-4"),
    deepseek: readStringEnv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat"),
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
