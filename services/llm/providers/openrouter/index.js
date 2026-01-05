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

module.exports = {
  id: "openrouter",
  name: "OpenRouter",
  adapter: "openai-compatible",
  apiKeyEnv: ["OPENROUTER_API_KEY"],
  baseUrlEnv: ["OPENROUTER_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: {},
    headers: () => buildOptionalHeaders(),
  },
  settingsSchema: [
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
      key: "maxOutputTokens",
      label: "Max Tokens",
      type: "number",
      min: 128,
      max: 64000,
      step: 64,
      capability: "maxTokens",
    },
    {
      key: "enableWebSearch",
      label: "Web Search",
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
  models: [
    { id: "openai/gpt-4o-mini", name: "openai/gpt-4o-mini" },
    { id: "openai/gpt-4o", name: "openai/gpt-4o" },
    { id: "anthropic/claude-sonnet-4.5", name: "anthropic/claude-sonnet-4.5" },
    { id: "anthropic/claude-4.5-haiku", name: "anthropic/claude-4.5-haiku" },
    { id: "minimax/minimax-m2.1", name: "minimax/minimax-m2.1" },
  ],
  parameterPolicy: {
    blockedBodyParams: ["presence_penalty", "frequency_penalty"],
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: false,
    frequencyPenalty: false,
    webSearch: true,
    tools: false,
    thinking: false,
  },
};
