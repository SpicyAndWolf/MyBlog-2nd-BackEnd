const { createChatCompletion } = require("../llm/chatCompletions");

function normalizeForSimilarity(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[\p{P}\p{S}]+/gu, "");
}

function requireNonNegativeInt(value, { name } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) {
    throw new Error(`Invalid ${name || "number"}: ${String(value)}`);
  }
  return number;
}

function requirePositiveInt(value, { name } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number <= 0) {
    throw new Error(`Invalid ${name || "number"}: ${String(value)}`);
  }
  return number;
}

function requireRatio(value, { name } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new Error(`Invalid ${name || "ratio"}: ${String(value)}`);
  }
  return number;
}

function buildTrigramSet(text) {
  const normalized = normalizeForSimilarity(text);
  if (!normalized) return new Set();
  if (normalized.length < 3) return new Set([normalized]);

  const set = new Set();
  for (let index = 0; index <= normalized.length - 3; index += 1) {
    set.add(normalized.slice(index, index + 3));
  }
  return set;
}

function jaccardSimilarity(setA, setB) {
  const sizeA = setA?.size || 0;
  const sizeB = setB?.size || 0;
  if (!sizeA || !sizeB) return 0;

  const [small, large] = sizeA <= sizeB ? [setA, setB] : [setB, setA];
  let intersection = 0;
  for (const token of small) {
    if (large.has(token)) intersection += 1;
  }

  const union = sizeA + sizeB - intersection;
  if (!union) return 0;
  return intersection / union;
}

function clipText(text, maxChars) {
  const normalized = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return normalized;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function evaluateRewriteGate({
  draftText,
  recentAssistantMessages,
  recentK,
  threshold,
  minChars,
} = {}) {
  const draft = String(draftText || "").trim();
  const draftChars = draft.length;

  const normalizedRecentK = requireNonNegativeInt(recentK, { name: "recentK" });
  const normalizedMinChars = requireNonNegativeInt(minChars, { name: "minChars" });
  const normalizedThreshold = requireRatio(threshold, { name: "threshold" });

  const candidates = Array.isArray(recentAssistantMessages) ? recentAssistantMessages : [];
  const assistantCandidates = candidates
    .map((row) => ({
      id: row?.id === undefined || row?.id === null ? null : Number(row.id),
      role: String(row?.role || "").trim(),
      content: String(row?.content || "").trim(),
    }))
    .filter((row) => row.role === "assistant" && row.content);

  const comparedCandidates =
    normalizedRecentK > 0 ? assistantCandidates.slice(Math.max(0, assistantCandidates.length - normalizedRecentK)) : [];

  if (!draft || draftChars < normalizedMinChars || comparedCandidates.length === 0) {
    return {
      shouldRewrite: false,
      draftChars,
      compared: comparedCandidates.length,
      maxSimilarity: 0,
      matchedMessageId: null,
      threshold: normalizedThreshold,
      recentK: normalizedRecentK,
      minChars: normalizedMinChars,
    };
  }

  const draftTrigrams = buildTrigramSet(draft);
  let bestSimilarity = 0;
  let bestMessageId = null;

  for (const candidate of comparedCandidates) {
    const similarity = jaccardSimilarity(draftTrigrams, buildTrigramSet(candidate.content));
    if (similarity > bestSimilarity) {
      bestSimilarity = similarity;
      bestMessageId = Number.isFinite(candidate.id) ? candidate.id : null;
    }
  }

  return {
    shouldRewrite: bestSimilarity >= normalizedThreshold && normalizedThreshold > 0,
    draftChars,
    compared: comparedCandidates.length,
    maxSimilarity: bestSimilarity,
    matchedMessageId: bestMessageId,
    threshold: normalizedThreshold,
    recentK: normalizedRecentK,
    minChars: normalizedMinChars,
  };
}

function buildRewritePrompt({
  userMessageText,
  assistantDraftText,
  avoidAssistantSamples,
  sampleMaxChars,
} = {}) {
  const system = `
你是“去模板化改写器”。你的任务：在不改变语义/事实/意图的前提下，将 assistant 草稿改写为**表达更自然多样、避免自回声**的版本。

绝对约束：
0. 只输出改写后的正文，不要解释，不要加前言/后记。
1. 严禁新增事实/设定；不确定就删掉或改成提问澄清。
2. 删除重复的环境/意象复述与高频口头禅，避免与最近输出出现明显相似句式。
3. 更短更直接，推动当前任务/话题继续向前。
`.trim();

  const normalizedUser = String(userMessageText || "").trim();
  const normalizedDraft = String(assistantDraftText || "").trim();

  const samples = Array.isArray(avoidAssistantSamples) ? avoidAssistantSamples : [];
  const clippedSamples = samples
    .map((row) => ({
      id: row?.id === undefined || row?.id === null ? null : Number(row.id),
      content: clipText(String(row?.content || "").trim(), sampleMaxChars),
    }))
    .filter((row) => row.content);

  const samplesText = clippedSamples.length
    ? clippedSamples
        .map((row, index) => `(${index + 1})${Number.isFinite(row.id) ? `#${row.id}` : ""} ${row.content}`)
        .join("\n")
    : "(无)";

  const user = `
【用户本轮输入】
${normalizedUser || "(空)"}

【assistant 草稿】
${normalizedDraft || "(空)"}

【最近 assistant 输出（避免相似措辞；仅供参考）】
${samplesText}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

function buildRewriteFallback(text, maxChars) {
  const normalized = String(text || "").trim();
  if (!normalized) return "我先简短回应一下：你希望我接下来更聚焦哪一点？";
  const clipped = clipText(normalized, maxChars).trim();
  const suffix = clipped.length < normalized.length ? "…" : "";
  return `${clipped}${suffix}\n\n你希望我接下来更聚焦哪一点？`;
}

async function runOutputRewriteGate({
  enabled,
  providerId,
  modelId,
  userMessageText,
  assistantDraftText,
  recentAssistantMessages,
  settings,
  threshold,
  recentK,
  minChars,
  timeoutMs,
  sampleMaxChars,
  fallbackMaxChars,
} = {}) {
  const gateEnabled = Boolean(enabled);
  if (!gateEnabled) {
    return {
      content: String(assistantDraftText || "").trim(),
      action: "pass",
      metrics: { enabled: false },
    };
  }

  const normalizedTimeoutMs = requirePositiveInt(timeoutMs, { name: "timeoutMs" });
  const normalizedSampleMaxChars = requirePositiveInt(sampleMaxChars, { name: "sampleMaxChars" });
  const normalizedFallbackMaxChars = requirePositiveInt(fallbackMaxChars, { name: "fallbackMaxChars" });

  const evaluation = evaluateRewriteGate({
    draftText: assistantDraftText,
    recentAssistantMessages,
    recentK,
    threshold,
    minChars,
  });

  const baseMetrics = {
    enabled: true,
    ...evaluation,
  };

  if (!evaluation.shouldRewrite) {
    return {
      content: String(assistantDraftText || "").trim(),
      action: "pass",
      metrics: baseMetrics,
    };
  }

  const sortedCandidates = Array.isArray(recentAssistantMessages) ? recentAssistantMessages : [];
  const assistantCandidates = sortedCandidates
    .filter((row) => String(row?.role || "").trim() === "assistant")
    .map((row) => ({ id: row?.id ?? null, content: String(row?.content || "").trim() }))
    .filter((row) => row.content);
  const normalizedRecentK = requireNonNegativeInt(recentK, { name: "recentK" });
  const avoidSamples = normalizedRecentK > 0 ? assistantCandidates.slice(Math.max(0, assistantCandidates.length - normalizedRecentK)) : [];

  const prompt = buildRewritePrompt({
    userMessageText,
    assistantDraftText,
    avoidAssistantSamples: avoidSamples,
    sampleMaxChars: normalizedSampleMaxChars,
  });

  if (!settings || typeof settings !== "object") throw new Error("Missing rewrite settings");
  const rewriteSettings = { ...settings };
  rewriteSettings.stream = false;
  rewriteSettings.enableWebSearch = false;

  const startedAt = Date.now();
  try {
    const { content } = await createChatCompletion({
      providerId,
      model: modelId,
      messages: prompt.messages,
      timeoutMs: normalizedTimeoutMs,
      settings: rewriteSettings,
    });

    const rewritten = String(content || "").trim();
    if (!rewritten) {
      return {
        content: buildRewriteFallback(assistantDraftText, normalizedFallbackMaxChars),
        action: "fallback",
        metrics: { ...baseMetrics, rewriteDurationMs: Date.now() - startedAt, rewriteEmpty: true },
      };
    }

    return {
      content: rewritten,
      action: "rewrite",
      metrics: { ...baseMetrics, rewriteDurationMs: Date.now() - startedAt, rewrittenChars: rewritten.length },
    };
  } catch (error) {
    return {
      content: buildRewriteFallback(assistantDraftText, normalizedFallbackMaxChars),
      action: "fallback",
      metrics: { ...baseMetrics, rewriteDurationMs: Date.now() - startedAt, rewriteError: String(error?.message || error) },
    };
  }
}

module.exports = {
  evaluateRewriteGate,
  runOutputRewriteGate,
  buildRewriteFallback,
};
