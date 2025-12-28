const { readBoolEnv, readFloatEnv, readIntEnv, readStringEnv } = require("./readEnv");
const { getGlobalNumericRange, getProviderNumericRange } = require("../services/llm/settingsSchema");
const { getProviderDefinition } = require("../services/llm/providers");

function normalizeKey(value) {
  return String(value || "").trim();
}

function readOptionalStringEnv(name) {
  return readStringEnv(name, undefined);
}

function ensureValidTimeZone(timeZone, { name } = {}) {
  const normalized = normalizeKey(timeZone);
  if (!normalized) throw new Error(`Env ${name || "unknown"} cannot be empty`);

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: normalized }).format(new Date());
  } catch {
    throw new Error(`Env ${name || "unknown"} has invalid IANA time zone: ${normalized}`);
  }

  return normalized;
}

function resolveChatDayTimeZone() {
  const raw = readOptionalStringEnv("CHAT_DAY_TIME_ZONE");
  const desired = raw;

  try {
    return ensureValidTimeZone(desired, { name: "CHAT_DAY_TIME_ZONE" });
  } catch (error) {
    if (raw) throw error;
    return "UTC";
  }
}

const chatDayTimeZone = resolveChatDayTimeZone();

function readRequiredStringEnv(name) {
  const value = readOptionalStringEnv(name);
  if (!value) throw new Error(`Missing required env: ${name}`);
  return value;
}

function readOptionalBoolEnv(name) {
  return readBoolEnv(name, undefined);
}

function readRequiredBoolEnv(name) {
  const value = readOptionalBoolEnv(name);
  if (typeof value !== "boolean") throw new Error(`Missing/invalid required env: ${name}`);
  return value;
}

function readRequiredIntEnv(name) {
  const value = readIntEnv(name);
  if (!Number.isFinite(value) || !Number.isInteger(value)) throw new Error(`Missing/invalid required env: ${name}`);
  return value;
}

function readOptionalFloatEnvStrict(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parsed = readFloatEnv(name);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid env: ${name}`);
  return parsed;
}

function readOptionalIntEnvStrict(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  const parsed = readIntEnv(name);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) throw new Error(`Invalid env: ${name}`);
  return parsed;
}

function readOptionalBoolEnvStrict(name) {
  const raw = process.env[name];
  if (typeof raw !== "string") return undefined;
  if (!raw.trim()) return undefined;

  const parsed = readBoolEnv(name, undefined);
  if (typeof parsed !== "boolean") throw new Error(`Invalid env: ${name}`);
  return parsed;
}

function readRequiredFloatEnv(name) {
  const value = readFloatEnv(name);
  if (!Number.isFinite(value)) throw new Error(`Missing/invalid required env: ${name}`);
  return value;
}

function ensureNumberInRange(value, range, { name } = {}) {
  if (!Number.isFinite(value)) throw new Error(`Invalid env: ${name || "unknown"}`);
  if (!range) return value;
  if (Number.isFinite(range.min) && value < range.min)
    throw new Error(`Env ${name} out of range (min ${range.min}). Got: ${value}`);
  if (Number.isFinite(range.max) && value > range.max)
    throw new Error(`Env ${name} out of range (max ${range.max}). Got: ${value}`);
  return value;
}

function readRequiredSettingNumber(name, { key, providerId, integer } = {}) {
  const resolvedKey = normalizeKey(key);
  const resolvedProviderId = normalizeKey(providerId);
  const range =
    resolvedProviderId && resolvedKey
      ? getProviderNumericRange(resolvedProviderId, resolvedKey) || getGlobalNumericRange(resolvedKey)
      : resolvedKey
      ? getGlobalNumericRange(resolvedKey)
      : null;

  const value = integer ? readRequiredIntEnv(name) : readRequiredFloatEnv(name);
  return ensureNumberInRange(value, range, { name });
}

function ensurePositiveInt(value, { name } = {}) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`Env ${name} must be a positive integer. Got: ${String(value)}`);
  }
  return value;
}

function ensureNonNegativeInt(value, { name } = {}) {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`Env ${name} must be a non-negative integer. Got: ${String(value)}`);
  }
  return value;
}

function ensureSupportedProvider(providerId, { name } = {}) {
  const normalizedProviderId = normalizeKey(providerId);
  if (!normalizedProviderId) throw new Error(`Env ${name} cannot be empty`);
  const definition = getProviderDefinition(normalizedProviderId);
  if (!definition) throw new Error(`Env ${name} has unsupported provider: ${normalizedProviderId}`);
  return normalizedProviderId;
}

function ensureSupportedModel(providerId, modelId, { name } = {}) {
  const normalizedProviderId = normalizeKey(providerId);
  const normalizedModelId = normalizeKey(modelId);
  if (!normalizedModelId) throw new Error(`Env ${name} cannot be empty`);

  const definition = getProviderDefinition(normalizedProviderId);
  const models = Array.isArray(definition?.models) ? definition.models : [];
  const supported = models.some((model) => normalizeKey(model?.id) === normalizedModelId);
  if (!supported) {
    throw new Error(`Env ${name} has unsupported model for provider ${normalizedProviderId}: ${normalizedModelId}`);
  }

  return normalizedModelId;
}

function readProviderDefaultSettings({ providerId, envPrefix, baseDefaults } = {}) {
  const base = baseDefaults && typeof baseDefaults === "object" && !Array.isArray(baseDefaults) ? baseDefaults : {};
  const normalizedProviderId = ensureSupportedProvider(providerId, { name: "providerId" });
  const normalizedPrefix = String(envPrefix || "")
    .trim()
    .toUpperCase();
  if (!normalizedPrefix) return { ...base };

  const definition = getProviderDefinition(normalizedProviderId);
  const capabilities = definition?.capabilities || {};
  const supportsStream = capabilities.stream !== false;
  const supportsWebSearch = capabilities.webSearch !== false;

  const next = { ...base };

  function clampProviderFloatSetting(key, envSuffix) {
    const envKey = `${normalizedPrefix}_${envSuffix}`;
    const range = getProviderNumericRange(normalizedProviderId, key);

    if (!range) {
      if (readOptionalFloatEnvStrict(envKey) !== undefined) {
        throw new Error(`Env ${envKey} is not supported by provider: ${normalizedProviderId}`);
      }
      delete next[key];
      return;
    }

    const override = readOptionalFloatEnvStrict(envKey);
    const value = override === undefined ? base[key] : override;
    next[key] = ensureNumberInRange(value, range, { name: envKey });
  }

  function clampProviderIntSetting(key, envSuffix) {
    const envKey = `${normalizedPrefix}_${envSuffix}`;
    const range = getProviderNumericRange(normalizedProviderId, key);

    if (!range) {
      if (readOptionalIntEnvStrict(envKey) !== undefined) {
        throw new Error(`Env ${envKey} is not supported by provider: ${normalizedProviderId}`);
      }
      delete next[key];
      return;
    }

    const override = readOptionalIntEnvStrict(envKey);
    const value = override === undefined ? base[key] : override;
    next[key] = ensureNumberInRange(value, range, { name: envKey });
  }

  clampProviderFloatSetting("temperature", "DEFAULT_TEMPERATURE");
  clampProviderFloatSetting("topP", "DEFAULT_TOP_P");
  clampProviderIntSetting("maxOutputTokens", "DEFAULT_MAX_OUTPUT_TOKENS");
  clampProviderFloatSetting("presencePenalty", "DEFAULT_PRESENCE_PENALTY");
  clampProviderFloatSetting("frequencyPenalty", "DEFAULT_FREQUENCY_PENALTY");

  const streamOverride = readOptionalBoolEnvStrict(`${normalizedPrefix}_DEFAULT_STREAM`);
  if (!supportsStream) {
    if (streamOverride === true) {
      throw new Error(`Env ${normalizedPrefix}_DEFAULT_STREAM is not supported by provider: ${normalizedProviderId}`);
    }
    next.stream = false;
  } else {
    next.stream = streamOverride === undefined ? base.stream : streamOverride;
  }

  const webSearchOverride = readOptionalBoolEnvStrict(`${normalizedPrefix}_DEFAULT_ENABLE_WEB_SEARCH`);
  if (!supportsWebSearch) {
    if (webSearchOverride === true) {
      throw new Error(
        `Env ${normalizedPrefix}_DEFAULT_ENABLE_WEB_SEARCH is not supported by provider: ${normalizedProviderId}`
      );
    }
    next.enableWebSearch = false;
  } else {
    next.enableWebSearch = webSearchOverride === undefined ? base.enableWebSearch : webSearchOverride;
  }
  if (!supportsWebSearch) next.enableWebSearch = false;

  return next;
}

const baseChatDefaultSettings = {
  temperature: readRequiredSettingNumber("CHAT_DEFAULT_TEMPERATURE", { key: "temperature" }),
  topP: readRequiredSettingNumber("CHAT_DEFAULT_TOP_P", { key: "topP" }),
  maxOutputTokens: readRequiredSettingNumber("CHAT_DEFAULT_MAX_OUTPUT_TOKENS", {
    key: "maxOutputTokens",
    integer: true,
  }),
  presencePenalty: readRequiredSettingNumber("CHAT_DEFAULT_PRESENCE_PENALTY", { key: "presencePenalty" }),
  frequencyPenalty: readRequiredSettingNumber("CHAT_DEFAULT_FREQUENCY_PENALTY", { key: "frequencyPenalty" }),
  stream: readRequiredBoolEnv("CHAT_DEFAULT_STREAM"),
  enableWebSearch: readRequiredBoolEnv("CHAT_DEFAULT_ENABLE_WEB_SEARCH"),
  systemPromptPresetId: readRequiredStringEnv("CHAT_DEFAULT_SYSTEM_PROMPT_PRESET_ID"),
};

const chatConfig = {
  dayTimeZone: chatDayTimeZone,
  maxContextMessages: ensurePositiveInt(readRequiredIntEnv("CHAT_MAX_CONTEXT_MESSAGES"), {
    name: "CHAT_MAX_CONTEXT_MESSAGES",
  }),
  maxContextChars: ensurePositiveInt(readRequiredIntEnv("CHAT_MAX_CONTEXT_CHARS"), { name: "CHAT_MAX_CONTEXT_CHARS" }),
  historyLimit: ensurePositiveInt(readRequiredIntEnv("CHAT_HISTORY_LIMIT"), { name: "CHAT_HISTORY_LIMIT" }),
  trashRetentionDays: ensureNonNegativeInt(readRequiredIntEnv("CHAT_TRASH_RETENTION_DAYS"), {
    name: "CHAT_TRASH_RETENTION_DAYS",
  }),
  trashCleanupIntervalMs: ensurePositiveInt(readRequiredIntEnv("CHAT_TRASH_CLEAN_INTERVAL_MS"), {
    name: "CHAT_TRASH_CLEAN_INTERVAL_MS",
  }),
  trashPurgeBatchSize: ensurePositiveInt(readRequiredIntEnv("CHAT_TRASH_PURGE_BATCH_SIZE"), {
    name: "CHAT_TRASH_PURGE_BATCH_SIZE",
  }),
  defaultProviderId: ensureSupportedProvider(readRequiredStringEnv("CHAT_DEFAULT_PROVIDER"), {
    name: "CHAT_DEFAULT_PROVIDER",
  }),
  defaultModelByProvider: {
    grok: ensureSupportedModel("grok", readRequiredStringEnv("GROK_DEFAULT_MODEL"), { name: "GROK_DEFAULT_MODEL" }),
    deepseek: ensureSupportedModel("deepseek", readRequiredStringEnv("DEEPSEEK_DEFAULT_MODEL"), {
      name: "DEEPSEEK_DEFAULT_MODEL",
    }),
    gemini: ensureSupportedModel("gemini", readRequiredStringEnv("GEMINI_DEFAULT_MODEL"), {
      name: "GEMINI_DEFAULT_MODEL",
    }),
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
  timeoutMs: ensurePositiveInt(readRequiredIntEnv("LLM_TIMEOUT_MS"), { name: "LLM_TIMEOUT_MS" }),
};

const articleConfig = {
  tempImageTtlMs: ensurePositiveInt(readRequiredIntEnv("ARTICLE_TEMP_IMAGE_TTL_MS"), {
    name: "ARTICLE_TEMP_IMAGE_TTL_MS",
  }),
  cleanupIntervalMs: ensurePositiveInt(readRequiredIntEnv("ARTICLE_CLEAN_INTERVAL_MS"), {
    name: "ARTICLE_CLEAN_INTERVAL_MS",
  }),
};

module.exports = {
  chatConfig,
  llmConfig,
  articleConfig,
};
