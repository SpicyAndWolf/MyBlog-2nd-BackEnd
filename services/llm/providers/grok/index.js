module.exports = {
  id: "grok",
  name: "Grok (xAI)",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.x.ai/v1",
  apiKeyEnv: ["XAI_API_KEY", "GROK_API_KEY"],
  baseUrlEnv: ["XAI_BASE_URL", "GROK_BASE_URL"],
  models: [
    { id: "grok-4", name: "grok-4" },
    { id: "grok-4-fast-non-reasoning", name: "grok-4-fast-non-reasoning" },
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
    webSearch: false,
    tools: false,
  },
};

