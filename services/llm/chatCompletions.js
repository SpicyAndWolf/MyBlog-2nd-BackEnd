const { getProviderDefinition } = require("./providers");
const openaiCompatible = require("./adapters/openaiCompatible/chatCompletions");

function resolveAdapter(providerId) {
  const adapterId = String(getProviderDefinition(providerId)?.adapter || "openai-compatible").trim();

  if (adapterId === "openai-compatible" || adapterId === "openaiCompatible") {
    return openaiCompatible;
  }

  throw new Error(`Unsupported LLM adapter: ${adapterId || "(empty)"}`);
}

async function createChatCompletion(options = {}) {
  return resolveAdapter(options.providerId).createChatCompletion(options);
}

async function createChatCompletionStreamResponse(options = {}) {
  return resolveAdapter(options.providerId).createChatCompletionStreamResponse(options);
}

function streamChatCompletionDeltas(options = {}) {
  return resolveAdapter(options.providerId).streamChatCompletionDeltas(options);
}

module.exports = {
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
};

