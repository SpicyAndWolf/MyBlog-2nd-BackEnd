const PROVIDER_DEFINITIONS = {
  grok: {
    name: "Grok (xAI)",
    defaultBaseUrl: "https://api.x.ai",
    apiKeyEnv: ["XAI_API_KEY", "GROK_API_KEY"],
    baseUrlEnv: ["XAI_BASE_URL", "GROK_BASE_URL"],
  },
  deepseek: {
    name: "DeepSeek",
    defaultBaseUrl: "https://api.deepseek.com",
    apiKeyEnv: ["DEEPSEEK_API_KEY"],
    baseUrlEnv: ["DEEPSEEK_BASE_URL"],
  },
};

function firstEnvValue(keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isSupportedProvider(providerId) {
  const normalizedId = String(providerId || "").trim();
  return Boolean(normalizedId && PROVIDER_DEFINITIONS[normalizedId]);
}

function getProviderConfig(providerId) {
  const normalizedId = String(providerId || "").trim();
  const definition = PROVIDER_DEFINITIONS[normalizedId];
  if (!definition) throw new Error(`Unsupported provider: ${normalizedId || "(empty)"}`);

  const apiKey = firstEnvValue(definition.apiKeyEnv);
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider ${normalizedId}. Please set one of: ${definition.apiKeyEnv.join(", ")}`
    );
  }

  const baseUrl = firstEnvValue(definition.baseUrlEnv) || definition.defaultBaseUrl;
  return { id: normalizedId, name: definition.name, apiKey, baseUrl };
}

module.exports = {
  isSupportedProvider,
  getProviderConfig,
};
