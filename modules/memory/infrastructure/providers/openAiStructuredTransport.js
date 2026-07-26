const { assertStructuredRequestLimits, isSafetySignal } = require("./providerProtocol");
const { buildOpenAiHttpRequest } = require("./structuredHttpRequest");

function createOpenAiStructuredTransport({ baseUrl, apiKey, model, proposerModels = {}, timeoutMs, maxInputTokens, maxOutputTokens = 8192, fetchImpl = globalThis.fetch, extraHeaders = {}, extraBody = {}, compileSchema = (schema) => schema } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  if (!String(apiKey || "").trim()) throw new Error("Memory Provider apiKey is required");
  if (!String(model || "").trim()) throw new Error("Memory Provider model is required");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("Memory Provider timeoutMs must be a positive integer");
  const providerConfig = { baseUrl, model, proposerModels, maxOutputTokens };
  return async function invokeStructured(request) {
    const { endpoint, body } = buildOpenAiHttpRequest(providerConfig, request, {
      compileSchema,
      extraBody,
    });
    assertStructuredRequestLimits({ messages: body.messages, maxInputTokens, maxOutputTokens });
    const requestedModel = body.model;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Memory Provider request timeout")), timeoutMs);
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}`, ...extraHeaders },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        if (isSafetySignal(data?.error?.code, data?.error?.type, data?.error?.message)) {
          return { safetyBlocked: true, finishReason: data?.error?.code ?? "input_rejected", model: data?.model ?? requestedModel, usage: data?.usage ?? null };
        }
        const error = new Error(data?.error?.message || `Memory Provider HTTP ${response.status}`);
        error.status = response.status;
        throw error;
      }
      const choice = data?.choices?.[0];
      const message = choice?.message;
      const finishReason = choice?.finish_reason ?? choice?.stop_reason;
      if (message?.refusal || isSafetySignal(finishReason)) return { refusal: true, finishReason, model: data?.model ?? requestedModel, usage: data?.usage };
      const content = message?.parsed ?? message?.content;
      const rawOutput = message?.content ?? message?.parsed;
      let output = content;
      let transportError = null;
      if (content == null) {
        output = null;
        transportError = "content_missing";
      } else if (typeof content === "string") {
        try { output = JSON.parse(content); }
        catch { output = null; transportError = "content_invalid_json"; }
      }
      return { output, rawOutput, finishReason, model: data?.model ?? requestedModel, usage: data?.usage ?? null, transportError, transportRecovery: null };
    } finally {
      clearTimeout(timeout);
    }
  };
}

module.exports = { createOpenAiStructuredTransport };
