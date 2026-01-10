module.exports = {
  id: "deepseek",
  name: "DeepSeek",
  adapter: "openai-compatible",
  apiKeyEnv: ["DEEPSEEK_API_KEY"],
  baseUrlEnv: ["DEEPSEEK_BASE_URL"],
  openaiCompatible: {
    bodyExtensions: {},
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
      modelBlocklist: ["deepseek-reasoner"],
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
      modelBlocklist: ["deepseek-reasoner"],
    },
    {
      key: "maxOutputTokens",
      label: "Max Tokens",
      type: "number",
      min: 128,
      max: 24000,
      step: 64,
      capability: "maxTokens",
    },
    {
      key: "presencePenalty",
      label: "Presence Penalty",
      type: "range",
      min: -2,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "presencePenalty",
      modelBlocklist: ["deepseek-reasoner"],
    },
    {
      key: "frequencyPenalty",
      label: "Frequency Penalty",
      type: "range",
      min: -2,
      max: 2,
      step: 0.1,
      decimals: 1,
      capability: "frequencyPenalty",
      modelBlocklist: ["deepseek-reasoner"],
    },
    {
      key: "stream",
      label: "Streaming",
      type: "toggle",
      capability: "stream",
    },
  ],
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
    tools: false,
    thinking: true,
  },
};
