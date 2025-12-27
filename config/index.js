const { readBoolEnv, readFloatEnv, readIntEnv, readStringEnv } = require("./readEnv");
const { getGlobalNumericRange, getProviderNumericRange, clampNumberWithRange } = require("../services/llm/settingsSchema");
const { getProviderDefinition } = require("../services/llm/providers");

function clampSchemaNumber(value, { key, range, fallback, integer } = {}) {
  const resolvedRange = range || (key ? getGlobalNumericRange(key) : null);
  const nextValue = clampNumberWithRange(value, resolvedRange, { fallback });
  if (!Number.isFinite(nextValue)) return fallback;
  return integer ? Math.trunc(nextValue) : nextValue;
}

function readProviderDefaultSettings({ providerId, envPrefix, baseDefaults } = {}) {
  const base = baseDefaults && typeof baseDefaults === "object" && !Array.isArray(baseDefaults) ? baseDefaults : {};
  const normalizedPrefix = String(envPrefix || "").trim().toUpperCase();
  if (!normalizedPrefix) return { ...base };

  const definition = getProviderDefinition(providerId);
  const capabilities = definition?.capabilities || {};
  const supportsStream = capabilities.stream !== false;
  const supportsWebSearch = capabilities.webSearch !== false;

  const next = { ...base };

  function clampProviderFloatSetting(key, envSuffix) {
    const range = getProviderNumericRange(providerId, key);
    if (!range) {
      delete next[key];
      return;
    }

    const value = clampSchemaNumber(readFloatEnv(`${normalizedPrefix}_${envSuffix}`, base[key]), {
      range,
      fallback: base[key],
    });

    if (!Number.isFinite(value)) {
      delete next[key];
      return;
    }
    next[key] = value;
  }

  function clampProviderIntSetting(key, envSuffix) {
    const range = getProviderNumericRange(providerId, key);
    if (!range) {
      delete next[key];
      return;
    }

    const value = clampSchemaNumber(readIntEnv(`${normalizedPrefix}_${envSuffix}`, base[key]), {
      range,
      fallback: base[key],
      integer: true,
    });

    if (!Number.isFinite(value)) {
      delete next[key];
      return;
    }
    next[key] = value;
  }

  clampProviderFloatSetting("temperature", "DEFAULT_TEMPERATURE");
  clampProviderFloatSetting("topP", "DEFAULT_TOP_P");
  clampProviderIntSetting("maxOutputTokens", "DEFAULT_MAX_OUTPUT_TOKENS");
  clampProviderFloatSetting("presencePenalty", "DEFAULT_PRESENCE_PENALTY");
  clampProviderFloatSetting("frequencyPenalty", "DEFAULT_FREQUENCY_PENALTY");

  next.stream = supportsStream ? readBoolEnv(`${normalizedPrefix}_DEFAULT_STREAM`, base.stream) : false;
  next.enableWebSearch = supportsWebSearch ? readBoolEnv(`${normalizedPrefix}_DEFAULT_ENABLE_WEB_SEARCH`, base.enableWebSearch) : false;
  if (!supportsWebSearch) next.enableWebSearch = false;

  return next;
}

const baseChatDefaultSettings = {
  temperature: clampSchemaNumber(readFloatEnv("CHAT_DEFAULT_TEMPERATURE", 0.7), { key: "temperature", fallback: 0.7 }),
  topP: clampSchemaNumber(readFloatEnv("CHAT_DEFAULT_TOP_P", 0.9), { key: "topP", fallback: 0.9 }),
  maxOutputTokens: clampSchemaNumber(readIntEnv("CHAT_DEFAULT_MAX_OUTPUT_TOKENS", 4096), {
    key: "maxOutputTokens",
    fallback: 4096,
    integer: true,
  }),
  presencePenalty: clampSchemaNumber(readFloatEnv("CHAT_DEFAULT_PRESENCE_PENALTY", 0), {
    key: "presencePenalty",
    fallback: 0,
  }),
  frequencyPenalty: clampSchemaNumber(readFloatEnv("CHAT_DEFAULT_FREQUENCY_PENALTY", 0), {
    key: "frequencyPenalty",
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
  trashRetentionDays: readIntEnv("CHAT_TRASH_RETENTION_DAYS", 30),
  trashCleanupIntervalMs: readIntEnv("CHAT_TRASH_CLEAN_INTERVAL_MS", 6 * 60 * 60 * 1000),
  trashPurgeBatchSize: readIntEnv("CHAT_TRASH_PURGE_BATCH_SIZE", 500),
  defaultProviderId: readStringEnv("CHAT_DEFAULT_PROVIDER", "deepseek"),
  defaultModelByProvider: {
    grok: readStringEnv("GROK_DEFAULT_MODEL", "grok-4"),
    deepseek: readStringEnv("DEEPSEEK_DEFAULT_MODEL", "deepseek-chat"),
    gemini: readStringEnv("GEMINI_DEFAULT_MODEL", "gemini-2.5-flash"),
  },
  defaultSettings: baseChatDefaultSettings,
  defaultSettingsByProvider: {
    grok: readProviderDefaultSettings({ providerId: "grok", envPrefix: "GROK", baseDefaults: baseChatDefaultSettings }),
    deepseek: readProviderDefaultSettings({
      providerId: "deepseek",
      envPrefix: "DEEPSEEK",
      baseDefaults: baseChatDefaultSettings,
    }),
    gemini: readProviderDefaultSettings({
      providerId: "gemini",
      envPrefix: "GEMINI",
      baseDefaults: baseChatDefaultSettings,
    }),
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
