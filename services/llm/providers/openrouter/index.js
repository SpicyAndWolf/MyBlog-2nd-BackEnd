function normalizeOptionalString(value) {
  const normalized = String(value || "").trim();
  return normalized || "";
}

function buildOptionalHeaders() {
  const headers = {};

  const siteUrl = normalizeOptionalString(process.env.OPENROUTER_SITE_URL);
  if (siteUrl) headers["HTTP-Referer"] = siteUrl;

  const appName = normalizeOptionalString(process.env.OPENROUTER_APP_NAME);
  if (appName) headers["X-Title"] = appName;

  return headers;
}

function normalizeModelId(modelId) {
  return String(modelId || "").trim();
}

function isOpenAiModel(modelId) {
  return normalizeModelId(modelId).startsWith("openai/");
}

function buildWebPluginConfig({ settings } = {}) {
  const maxResults = Number(settings?.webSearchMaxResults);

  const plugin = { id: "web", engine: "exa" };

  if (Number.isFinite(maxResults)) {
    const normalized = Math.trunc(maxResults);
    if (normalized > 0 && normalized <= 10) plugin.max_results = normalized;
  }

  return plugin;
}

function buildBodyExtensions({ settings } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};

  const enableWebSearch = Boolean(settings.enableWebSearch);
  if (!enableWebSearch) return {};

  return {
    plugins: [buildWebPluginConfig({ settings })],
  };
}

const MODELS = [
  { id: "openai/gpt-4o-mini", name: "openai/gpt-4o-mini" },
  { id: "openai/gpt-4o", name: "openai/gpt-4o" },
  { id: "anthropic/claude-sonnet-4.5", name: "anthropic/claude-sonnet-4.5" },
  { id: "anthropic/claude-haiku-4.5", name: "anthropic/claude-haiku-4.5" },
  { id: "minimax/minimax-m2.1", name: "minimax/minimax-m2.1" },
];

const NON_OPENAI_MODEL_IDS = MODELS.map((model) => model?.id).filter((id) => id && !isOpenAiModel(id));

module.exports = {
  id: "openrouter",
  name: "OpenRouter",
  adapter: "openai-compatible",
  apiKeyEnv: ["OPENROUTER_API_KEY"],
  baseUrlEnv: ["OPENROUTER_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: buildBodyExtensions,
    headers: () => buildOptionalHeaders(),
  },
  settingsSchema: [
    {
      key: "maxOutputTokens",
      label: "Max Tokens",
      type: "number",
      min: 128,
      max: 64000,
      step: 64,
      capability: "maxTokens",
    },
    {
      key: "webSearchMaxResults",
      label: "Web Search Max Results (1-10)",
      type: "number",
      min: 1,
      max: 10,
      step: 1,
      default: 5,
      capability: "webSearch",
    },
    {
      key: "temperature",
      label: "Temperature",
      type: "range",
      min: 0,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "temperature",
    },
    {
      key: "topP",
      label: "Top P",
      type: "range",
      min: 0,
      max: 1,
      step: 0.05,
      decimals: 2,
      capability: "topP",
    },
    {
      key: "presencePenalty",
      label: "Presence Penalty (OpenAI models)",
      type: "range",
      min: -2,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "presencePenalty",
      modelBlocklist: NON_OPENAI_MODEL_IDS,
    },
    {
      key: "frequencyPenalty",
      label: "Frequency Penalty (OpenAI models)",
      type: "range",
      min: -2,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "frequencyPenalty",
      modelBlocklist: NON_OPENAI_MODEL_IDS,
    },
    {
      key: "enableWebSearch",
      label: "Web Search (OpenRouter plugin: Exa)",
      type: "toggle",
      capability: "webSearch",
    },
    {
      key: "stream",
      label: "Streaming",
      type: "toggle",
      capability: "stream",
    },
  ],
  models: MODELS,
  parameterPolicy: {
    blockedBodyParams: [],
    isBodyParamAllowed: ({ model, paramName }) => {
      const normalizedModelId = normalizeModelId(model);
      if (["presence_penalty", "frequency_penalty"].includes(paramName)) {
        return isOpenAiModel(normalizedModelId);
      }

      return true;
    },
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    presencePenalty: true,
    frequencyPenalty: true,
    maxTokens: true,
    webSearch: true,
    tools: false,
    thinking: false,
  },
};
