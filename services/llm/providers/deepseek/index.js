module.exports = {
  id: "deepseek",
  name: "DeepSeek",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.deepseek.com",
  apiKeyEnv: ["DEEPSEEK_API_KEY"],
  baseUrlEnv: ["DEEPSEEK_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: ({ settings }) => {
      const extensions = {};
      const webSearchParam = String(process.env.DEEPSEEK_WEB_SEARCH_BODY_PARAM || "").trim();
      const enableWebSearch = settings?.enableWebSearch;
      if (webSearchParam && typeof enableWebSearch === "boolean") {
        extensions[webSearchParam] = enableWebSearch;
      }
      return extensions;
    },
  },
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
    webSearch: Boolean(String(process.env.DEEPSEEK_WEB_SEARCH_BODY_PARAM || "").trim()),
    tools: false,
  },
};
