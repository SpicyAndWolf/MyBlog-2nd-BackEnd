const {
  resolveMemoryProviderModel,
  resolveMemoryProviderReasoningEffort,
} = require("../../config/loadProviderConfig");
const { compileDeepSeekSchema } = require("./deepSeekSchemaCompiler");
const { compileOpencodeGoSchema } = require("./opencodeGoSchemaCompiler");

function normalizeBaseUrl(value) {
  const url = new URL(String(value || "").trim());
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

function chatCompletionsEndpoint(baseUrl) {
  return new URL("chat/completions", normalizeBaseUrl(baseUrl)).toString();
}

function messageContent(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function buildStructuredMessages({ systemPrompt, userPayload, repairContext = null } = {}) {
  const messages = [
    { role: "system", content: String(systemPrompt ?? "") },
    { role: "user", content: JSON.stringify(userPayload) },
  ];
  if (repairContext?.assistantOutput !== undefined && repairContext?.userMessage) {
    messages.push(
      { role: "assistant", content: messageContent(repairContext.assistantOutput) },
      { role: "user", content: String(repairContext.userMessage) },
    );
  }
  return messages;
}

function buildOpenAiHttpRequest(config, request, {
  compileSchema = (schema) => schema,
  extraBody = {},
} = {}) {
  const { proposer, responseSchema } = request;
  const model = resolveMemoryProviderModel(config, proposer);
  const extension = typeof extraBody === "function"
    ? extraBody({ proposer, model })
    : extraBody;
  return {
    method: "POST",
    endpoint: chatCompletionsEndpoint(config.baseUrl),
    body: {
      model,
      stream: false,
      max_tokens: config.maxOutputTokens ?? 8192,
      messages: buildStructuredMessages(request),
      response_format: {
        type: "json_schema",
        json_schema: (typeof compileSchema === "function"
          ? compileSchema
          : (schema) => schema)(responseSchema),
      },
      ...(extension || {}),
    },
  };
}

function buildDeepSeekHttpRequest(config, request) {
  const { proposer, responseSchema } = request;
  const normalizedBaseUrl = normalizeBaseUrl(config.baseUrl);
  if (normalizedBaseUrl.hostname === "api.deepseek.com" && !normalizedBaseUrl.pathname.endsWith("/beta/")) {
    throw new Error("DeepSeek strict tools require CHAT_MEMORY_V2_PROVIDER_BASE_URL=https://api.deepseek.com/beta");
  }
  const functionName = responseSchema?.name;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(functionName || ""))) {
    throw new Error("Structured output schema name is not a valid tool name");
  }
  return {
    method: "POST",
    endpoint: new URL("chat/completions", normalizedBaseUrl).toString(),
    body: {
      model: resolveMemoryProviderModel(config, proposer),
      stream: false,
      max_tokens: config.maxOutputTokens ?? 8192,
      thinking: { type: config.thinkingMode ?? "disabled" },
      messages: buildStructuredMessages(request),
      tools: [{
        type: "function",
        function: {
          name: functionName,
          description: "Return the schema-constrained Memory proposer result.",
          strict: true,
          parameters: compileDeepSeekSchema(responseSchema.schema),
        },
      }],
      tool_choice: {
        type: "function",
        function: { name: functionName },
      },
    },
  };
}

function buildStructuredHttpRequest(config, request) {
  if (config?.adapter === "openai-json-schema") {
    return buildOpenAiHttpRequest(config, request, {
      compileSchema: config.compileSchema,
      extraBody: config.extraBody,
    });
  }
  if (config?.adapter === "opencode-go-json-schema") {
    return buildOpenAiHttpRequest(config, request, {
      compileSchema: compileOpencodeGoSchema,
      extraBody: ({ proposer, model }) => ({
        reasoning_effort: resolveMemoryProviderReasoningEffort(config, proposer),
        ...(typeof config.extraBody === "function"
          ? config.extraBody({ proposer, model })
          : config.extraBody),
      }),
    });
  }
  if (config?.adapter === "deepseek-strict-tools") {
    return buildDeepSeekHttpRequest(config, request);
  }
  throw new Error(`Unsupported Memory Provider adapter: ${config?.adapter || "<missing>"}`);
}

module.exports = {
  buildDeepSeekHttpRequest,
  buildOpenAiHttpRequest,
  buildStructuredMessages,
  buildStructuredHttpRequest,
  chatCompletionsEndpoint,
  normalizeBaseUrl,
};
