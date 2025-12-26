const { GoogleGenAI } = require("@google/genai");
const { llmConfig } = require("../../../../config");
const { getProviderConfig, isBodyParamAllowed } = require("../../providers");
const { clampNumberWithRange, getGlobalNumericRange, getProviderNumericRange } = require("../../settingsSchema");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeText(value) {
  return String(value || "");
}

function readSetting(settings, key) {
  if (!isPlainObject(settings)) return undefined;
  return settings[key];
}

function clampConfigNumber(providerId, key, value, { integer } = {}) {
  const range = getProviderNumericRange(providerId, key) || getGlobalNumericRange(key);
  const nextValue = clampNumberWithRange(value, range);
  if (!Number.isFinite(nextValue)) return null;
  return integer ? Math.trunc(nextValue) : nextValue;
}

const SUPPORTED_HARM_BLOCK_THRESHOLDS = new Set([
  "HARM_BLOCK_THRESHOLD_UNSPECIFIED",
  "OFF",
  "BLOCK_NONE",
  "BLOCK_ONLY_HIGH",
  "BLOCK_MEDIUM_AND_ABOVE",
  "BLOCK_LOW_AND_ABOVE",
]);

const SAFETY_THRESHOLD_KEYS = [
  { key: "safetyHarassment", category: "HARM_CATEGORY_HARASSMENT" },
  { key: "safetyHateSpeech", category: "HARM_CATEGORY_HATE_SPEECH" },
  { key: "safetySexuallyExplicit", category: "HARM_CATEGORY_SEXUALLY_EXPLICIT" },
  { key: "safetyDangerousContent", category: "HARM_CATEGORY_DANGEROUS_CONTENT" },
];

function buildSafetySettings(settings) {
  if (!isPlainObject(settings)) return [];

  const output = [];
  for (const entry of SAFETY_THRESHOLD_KEYS) {
    const threshold = typeof settings[entry.key] === "string" ? settings[entry.key].trim() : "";
    if (!threshold) continue;
    if (!SUPPORTED_HARM_BLOCK_THRESHOLDS.has(threshold)) continue;
    if (threshold === "HARM_BLOCK_THRESHOLD_UNSPECIFIED") continue;
    output.push({ category: entry.category, threshold });
  }
  return output;
}

function buildContentsFromOpenAiMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const contents = [];
  const systemParts = [];

  for (const message of list) {
    const role = String(message?.role || "").trim();
    const content = normalizeText(message?.content).trim();
    if (!role || !content) continue;

    if (role === "system") {
      systemParts.push(content);
      continue;
    }

    const geminiRole = role === "user" ? "user" : role === "assistant" ? "model" : "";
    if (!geminiRole) continue;
    contents.push({ role: geminiRole, parts: [{ text: content }] });
  }

  const systemInstruction = systemParts.join("\n\n").trim();
  return { contents, systemInstruction };
}

function buildGenerateContentConfig({ providerId, model, baseUrl, systemInstruction, timeoutMs, signal, settings } = {}) {
  const config = {};

  if (signal) config.abortSignal = signal;

  const httpOptions = {};
  if (typeof baseUrl === "string" && baseUrl.trim()) httpOptions.baseUrl = baseUrl.trim();
  if (Number.isFinite(Number(timeoutMs))) httpOptions.timeout = Number(timeoutMs);
  if (Object.keys(httpOptions).length) config.httpOptions = httpOptions;

  if (systemInstruction) config.systemInstruction = systemInstruction;

  const temperature = readSetting(settings, "temperature");
  const topP = readSetting(settings, "topP");
  const maxOutputTokens = readSetting(settings, "maxOutputTokens");
  const presencePenalty = readSetting(settings, "presencePenalty");
  const frequencyPenalty = readSetting(settings, "frequencyPenalty");

  const normalizedTemperature = clampConfigNumber(providerId, "temperature", temperature);
  const normalizedTopP = clampConfigNumber(providerId, "topP", topP);
  const normalizedMaxTokens = clampConfigNumber(providerId, "maxOutputTokens", maxOutputTokens, { integer: true });
  const normalizedPresencePenalty = clampConfigNumber(providerId, "presencePenalty", presencePenalty);
  const normalizedFrequencyPenalty = clampConfigNumber(providerId, "frequencyPenalty", frequencyPenalty);

  if (normalizedTemperature !== null && isBodyParamAllowed(providerId, "temperature", { model, settings })) {
    config.temperature = normalizedTemperature;
  }
  if (normalizedTopP !== null && isBodyParamAllowed(providerId, "topP", { model, settings })) {
    config.topP = normalizedTopP;
  }
  if (normalizedMaxTokens !== null && isBodyParamAllowed(providerId, "maxOutputTokens", { model, settings })) {
    config.maxOutputTokens = normalizedMaxTokens;
  }
  if (normalizedPresencePenalty !== null && isBodyParamAllowed(providerId, "presencePenalty", { model, settings })) {
    config.presencePenalty = normalizedPresencePenalty;
  }
  if (normalizedFrequencyPenalty !== null && isBodyParamAllowed(providerId, "frequencyPenalty", { model, settings })) {
    config.frequencyPenalty = normalizedFrequencyPenalty;
  }

  const safetySettings = buildSafetySettings(settings);
  if (safetySettings.length) config.safetySettings = safetySettings;

  return config;
}

function ensureAbortSignal(timeoutMs, parentSignal) {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), timeoutMs);

  if (parentSignal) {
    if (parentSignal.aborted) {
      abortController.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener("abort", () => abortController.abort(parentSignal.reason), { once: true });
    }
  }

  return { signal: abortController.signal, cleanup: () => clearTimeout(timeout) };
}

function pickFunctionCallNames(functionCalls) {
  const calls = Array.isArray(functionCalls) ? functionCalls : [];
  return calls
    .map((call) => call?.name)
    .filter(Boolean)
    .slice(0, 6)
    .join(", ");
}

async function createChatCompletion({ providerId, model, messages, timeoutMs = llmConfig.timeoutMs, signal, settings } = {}) {
  const provider = getProviderConfig(providerId);
  const ai = new GoogleGenAI({ apiKey: provider.apiKey });

  const { signal: abortSignal, cleanup } = ensureAbortSignal(timeoutMs, signal);

  try {
    const { contents, systemInstruction } = buildContentsFromOpenAiMessages(messages);
    const config = buildGenerateContentConfig({
      providerId: provider.id,
      model,
      baseUrl: provider.baseUrl,
      systemInstruction,
      timeoutMs,
      signal: abortSignal,
      settings,
    });

    const response = await ai.models.generateContent({ model, contents, config });

    const functionCalls = response?.functionCalls;
    if (Array.isArray(functionCalls) && functionCalls.length) {
      const names = pickFunctionCallNames(functionCalls);
      throw new Error(
        `Model requested function calls (${names || functionCalls.length}), but tool calls are not implemented yet.`
      );
    }

    const content = normalizeText(response?.text).trim();
    if (!content) {
      const blockReason = response?.promptFeedback?.blockReason || response?.promptFeedback?.blockReasonMessage;
      if (blockReason) throw new Error(`Blocked by safety policy: ${String(blockReason)}`);
      throw new Error("Empty model response");
    }

    return { content, raw: response };
  } finally {
    cleanup();
  }
}

async function createChatCompletionStreamResponse({ providerId, model, messages, signal, settings } = {}) {
  const provider = getProviderConfig(providerId);
  const ai = new GoogleGenAI({ apiKey: provider.apiKey });

  const { contents, systemInstruction } = buildContentsFromOpenAiMessages(messages);
  const config = buildGenerateContentConfig({
    providerId: provider.id,
    model,
    baseUrl: provider.baseUrl,
    systemInstruction,
    timeoutMs: llmConfig.timeoutMs,
    signal,
    settings,
  });

  return ai.models.generateContentStream({ model, contents, config });
}

async function* streamChatCompletionDeltas({ response }) {
  let emitted = "";

  for await (const chunk of response) {
    const functionCalls = chunk?.functionCalls;
    if (Array.isArray(functionCalls) && functionCalls.length) {
      const names = pickFunctionCallNames(functionCalls);
      throw new Error(
        `Model requested function calls (${names || functionCalls.length}), but tool calls are not implemented yet.`
      );
    }

    const blockReason = chunk?.promptFeedback?.blockReason || chunk?.promptFeedback?.blockReasonMessage;
    if (blockReason) throw new Error(`Blocked by safety policy: ${String(blockReason)}`);

    const text = typeof chunk?.text === "string" ? chunk.text : "";
    if (!text) continue;

    if (text.startsWith(emitted)) {
      const delta = text.slice(emitted.length);
      emitted = text;
      if (delta) yield delta;
      continue;
    }

    emitted += text;
    yield text;
  }
}

module.exports = {
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
};
