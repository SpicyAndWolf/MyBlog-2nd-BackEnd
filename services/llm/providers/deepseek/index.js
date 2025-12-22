module.exports = {
  id: "deepseek",
  name: "DeepSeek",
  adapter: "openai-compatible",
  defaultBaseUrl: "https://api.deepseek.com",
  apiKeyEnv: ["DEEPSEEK_API_KEY"],
  baseUrlEnv: ["DEEPSEEK_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: ({ model, settings }) => {
      const normalizedModel = String(model || "").trim();
      const normalizedSettings = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};

      const extensions = {};

      if (normalizedModel !== "deepseek-reasoner") {
        const thinking = normalizedSettings.thinking;
        if (thinking && typeof thinking === "object" && !Array.isArray(thinking)) {
          const type = String(thinking.type || "").trim();
          if (type === "enabled" || type === "disabled") {
            extensions.thinking = { type };
          }
        }
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
    isBodyParamAllowed: ({ model, paramName }) => {
      const normalizedModel = String(model || "").trim();
      if (normalizedModel !== "deepseek-reasoner") return true;

      // deepseek-reasoner: 文档说明以下参数不会生效或会报错；为避免冗余与潜在错误，这里直接不发送。
      if (["temperature", "top_p", "presence_penalty", "frequency_penalty"].includes(paramName)) return false;
      if (["logprobs", "top_logprobs"].includes(paramName)) return false;
      return true;
    },
  },
  capabilities: {
    stream: true,
    temperature: true,
    topP: true,
    maxTokens: true,
    presencePenalty: true,
    frequencyPenalty: true,
    webSearch: false,
    tools: true,
    thinking: true,
  },
};
