const { getProviderConfig, getProviderDefinition, isBodyParamAllowed } = require("../../providers");
const { llmConfig } = require("../../../../config");

function normalizeBaseUrl(baseUrl) {
  const url = new URL(String(baseUrl || "").trim());
  url.hash = "";
  url.search = "";
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url.toString();
}

function buildUrl(baseUrl, path) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const normalizedPath = String(path || "")
    .trim()
    .replace(/^\/+/, "");
  return new URL(normalizedPath, normalizedBaseUrl).toString();
}

function clampNumber(value, { min, max }) {
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  return String(value || "");
}

async function readJsonSafe(response) {
  const text = await response.text();
  if (!text) return { json: null, text: "" };
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

function pickErrorMessage({ status, json, text }) {
  if (json && typeof json === "object") {
    const message =
      json?.error?.message ||
      json?.error ||
      json?.message ||
      json?.msg ||
      (typeof json?.detail === "string" ? json.detail : null);
    if (message) return String(message);
  }
  if (text) return text.slice(0, 800);
  return `Upstream LLM request failed (HTTP ${status})`;
}

function readSetting(settings, key) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  return settings[key];
}

function buildBodyExtensions({ providerId, settings }) {
  const definition = getProviderDefinition(providerId);
  const extensions = definition?.openaiCompatible?.bodyExtensions;

  if (typeof extensions === "function") {
    const value = extensions({ settings: settings || {} });
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
    return {};
  }

  if (extensions && typeof extensions === "object" && !Array.isArray(extensions)) {
    return extensions;
  }

  return {};
}

function buildBody({
  providerId,
  model,
  messages,
  temperature,
  topP,
  maxTokens,
  presencePenalty,
  frequencyPenalty,
  stream,
  settings,
}) {
  const resolvedTemperature = readSetting(settings, "temperature") ?? temperature;
  const resolvedTopP = readSetting(settings, "topP") ?? topP;
  const resolvedMaxTokens = readSetting(settings, "maxOutputTokens") ?? readSetting(settings, "maxTokens") ?? maxTokens;
  const resolvedPresencePenalty = readSetting(settings, "presencePenalty") ?? presencePenalty;
  const resolvedFrequencyPenalty = readSetting(settings, "frequencyPenalty") ?? frequencyPenalty;
  const resolvedStream = typeof stream === "boolean" ? stream : Boolean(readSetting(settings, "stream"));

  const body = {
    model,
    messages,
    stream: resolvedStream,
  };

  const normalizedTemperature = clampNumber(resolvedTemperature, { min: 0, max: 2 });
  const normalizedTopP = clampNumber(resolvedTopP, { min: 0, max: 1 });
  const normalizedMaxTokens = clampNumber(resolvedMaxTokens, { min: 1, max: 200000 });
  const normalizedPresencePenalty = clampNumber(resolvedPresencePenalty, { min: -2, max: 2 });
  const normalizedFrequencyPenalty = clampNumber(resolvedFrequencyPenalty, { min: -2, max: 2 });

  if (normalizedTemperature !== null && isBodyParamAllowed(providerId, "temperature"))
    body.temperature = normalizedTemperature;
  if (normalizedTopP !== null && isBodyParamAllowed(providerId, "top_p")) body.top_p = normalizedTopP;
  if (normalizedMaxTokens !== null && isBodyParamAllowed(providerId, "max_tokens")) body.max_tokens = normalizedMaxTokens;
  if (normalizedPresencePenalty !== null && isBodyParamAllowed(providerId, "presence_penalty"))
    body.presence_penalty = normalizedPresencePenalty;
  if (normalizedFrequencyPenalty !== null && isBodyParamAllowed(providerId, "frequency_penalty"))
    body.frequency_penalty = normalizedFrequencyPenalty;

  const extensions = buildBodyExtensions({ providerId, settings });
  for (const [key, value] of Object.entries(extensions)) {
    if (value === undefined) continue;
    if (!isBodyParamAllowed(providerId, key)) continue;
    body[key] = value;
  }

  return body;
}

async function createChatCompletion({ providerId, model, messages, timeoutMs = llmConfig.timeoutMs, ...rest } = {}) {
  const provider = getProviderConfig(providerId);
  const url = buildUrl(provider.baseUrl, "chat/completions");

  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), timeoutMs);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.apiKey}`,
      },
      body: JSON.stringify(
        buildBody({
          providerId: provider.id,
          model,
          messages,
          stream: false,
          ...rest,
        })
      ),
      signal: abortController.signal,
    });

    if (!response.ok) {
      const { json, text } = await readJsonSafe(response);
      throw new Error(pickErrorMessage({ status: response.status, json, text }));
    }

    const data = await response.json();
    const content = normalizeText(data?.choices?.[0]?.message?.content).trim();
    if (!content) throw new Error("Empty model response");
    return { content, raw: data };
  } finally {
    clearTimeout(timeout);
  }
}

async function createChatCompletionStreamResponse({ providerId, model, messages, signal, ...rest } = {}) {
  const provider = getProviderConfig(providerId);
  const url = buildUrl(provider.baseUrl, "chat/completions");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(
      buildBody({
        providerId: provider.id,
        model,
        messages,
        stream: true,
        ...rest,
      })
    ),
    signal,
  });

  if (!response.ok) {
    const { json, text } = await readJsonSafe(response);
    throw new Error(pickErrorMessage({ status: response.status, json, text }));
  }

  if (!response.body) {
    throw new Error("Upstream stream body is empty");
  }

  return response;
}

async function* streamChatCompletionDeltas({ response }) {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });

    while (true) {
      const boundaryIndex = buffer.indexOf("\n\n");
      if (boundaryIndex === -1) break;

      const frame = buffer.slice(0, boundaryIndex);
      buffer = buffer.slice(boundaryIndex + 2);

      const lines = frame.split(/\r?\n/);
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const dataPart = trimmed.slice("data:".length).trim();
        if (!dataPart) continue;
        if (dataPart === "[DONE]") return;

        let parsed;
        try {
          parsed = JSON.parse(dataPart);
        } catch {
          continue;
        }

        const delta = parsed?.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta.length) {
          yield delta;
        }
      }
    }
  }
}

module.exports = {
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
};

