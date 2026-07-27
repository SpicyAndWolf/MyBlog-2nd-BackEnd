const { resolveMemoryProviderReasoningEffort } = require("../../config/loadProviderConfig");
const { createOpenAiStructuredTransport } = require("./openAiStructuredTransport");
const { validateLocalJsonSchema } = require("./localJsonSchemaValidator");
const { buildOpenAiJsonObjectHttpRequest } = require("./structuredHttpRequest");

// OpenCode Go JSON mode deliberately avoids the gateway's json_schema guided
// decoding. The bound schema is rendered into the trusted system prompt and
// validated locally before the existing Semantic validator enforces domain rules.
function createOpencodeGoJsonObjectTransport({
  model,
  proposerModels = {},
  reasoningEffort = "none",
  extraBody,
  ...options
} = {}) {
  const providerConfig = { model, proposerModels, reasoningEffort };
  return createOpenAiStructuredTransport({
    model,
    proposerModels,
    ...options,
    httpRequestBuilder: buildOpenAiJsonObjectHttpRequest,
    validateOutputSchema: validateLocalJsonSchema,
    extraBody: (request) => ({
      reasoning_effort: resolveMemoryProviderReasoningEffort(providerConfig, request.proposer),
      ...(typeof extraBody === "function" ? extraBody(request) : extraBody),
    }),
  });
}

module.exports = { createOpencodeGoJsonObjectTransport };
