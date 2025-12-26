const { getProviderDefinition } = require("./providers");
const openaiCompatible = require("./adapters/openaiCompatible/chatCompletions");
const googleGenAi = require("./adapters/googleGenAi/chatCompletions");

function resolveAdapter(providerId) {
  const adapterId = String(getProviderDefinition(providerId)?.adapter || "openai-compatible").trim();

  if (adapterId === "openai-compatible" || adapterId === "openaiCompatible") {
    return openaiCompatible;
  }

  if (adapterId === "google-genai" || adapterId === "googleGenAi" || adapterId === "gemini") {
    return googleGenAi;
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
