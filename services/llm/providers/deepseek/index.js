module.exports = {
  id: "deepseek",
  name: "DeepSeek",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.deepseek.com",
  apiKeyEnv: ["DEEPSEEK_API_KEY"],
  baseUrlEnv: ["DEEPSEEK_BASE_URL"],
  models: [
    { id: "deepseek-chat", name: "deepseek-chat" },
    { id: "deepseek-reasoner", name: "deepseek-reasoner" },
  ],
  parameterPolicy: {
    blockedBodyParams: [],
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: true,
    frequencyPenalty: true,
    webSearch: false,
    tools: false,
  },
};

