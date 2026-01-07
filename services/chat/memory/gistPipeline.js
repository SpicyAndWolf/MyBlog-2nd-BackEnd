const crypto = require("crypto");
const chatMessageGistModel = require("@models/chatMessageGistModel");
const { chatGistConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { createChatCompletion } = require("../../llm/chatCompletions");

function buildKey(userId, messageId) {
  return `${String(userId || "").trim()}:${String(messageId || "").trim()}`;
}

function createSemaphore(limit) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let active = 0;
  const waiters = [];

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  async function acquire() {
    if (active < normalizedLimit) {
      active += 1;
      return release;
    }

    await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    return release;
  }

  return { acquire };
}

const workerSemaphore = createSemaphore(chatGistConfig.workerConcurrency);
const keyLocks = new Map();

function enqueueKeyTask(key, task) {
  const tail = keyLocks.get(key) || Promise.resolve();

  const run = tail
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (keyLocks.get(key) === run) keyLocks.delete(key);
    });

  keyLocks.set(key, run);
  return run;
}

function hashContent(content) {
  const normalized = String(content || "");
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function stripCodeFences(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return trimmed;
  if (!lines[lines.length - 1].trim().startsWith("```")) return trimmed;

  return lines.slice(1, -1).join("\n").trim();
}

function clipText(text, maxChars) {
  const normalized = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return normalized;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function normalizeGistText(text, maxChars) {
  const cleaned = stripCodeFences(text).trim();
  if (!cleaned) return "";
  const normalized = cleaned
    .split(/\r?\n/)
    .map((line) => line.replace(/^([-*•]|\d+\.)\s+/, "").trim())
    .filter(Boolean)
    .join("；")
    .replace(/[“”"']/g, "")
    .replace(/[。！？!?]+/g, "；")
    .replace(/[；;]+/g, "；")
    .replace(/\s+/g, " ")
    .trim();
  return clipText(normalized, maxChars).trim();
}

function buildAssistantGistPrompt({ content, maxChars }) {
  const system = `
你是“对话要点抽取器”。请将 assistant 的输出压缩为**中文要点**，去文风、去意象、去抒情，只保留事实/动作/意图变化。

绝对约束：
0. 只输出要点正文，不要解释，不要前后缀。
1. 禁止新增事实/设定；不确定就省略。
2. 输出为一句或多短语，用“；”分隔。
3. 严格控制字数不超过 ${maxChars} 字。
`.trim();

  const user = `
【assistant 原文】
${String(content || "").trim()}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

async function generateAssistantGist({ content }) {
  const providerId = chatGistConfig.workerProviderId;
  const modelId = chatGistConfig.workerModelId;
  const maxChars = chatGistConfig.maxChars;
  const workerSettings = chatGistConfig.workerSettings;
  const workerRaw = chatGistConfig.workerRaw;

  const prompt = buildAssistantGistPrompt({ content, maxChars });
  logger.debugGist("chat_message_gist_request", {
    providerId,
    modelId,
    messages: prompt.messages,
  });

  const response = await createChatCompletion({
    providerId,
    model: modelId,
    messages: prompt.messages,
    timeoutMs: chatGistConfig.workerTimeoutMs,
    settings: workerSettings,
    rawBody: workerRaw?.openaiCompatibleBody,
    rawConfig: workerRaw?.googleGenAiConfig,
  });

  const normalized = normalizeGistText(response?.content || "", maxChars);
  return normalized;
}

async function generateAndStoreGist({ userId, presetId, messageId, content }) {
  const normalizedContent = String(content || "").trim();
  if (!normalizedContent) return;

  const contentHash = hashContent(normalizedContent);

  let existing = null;
  try {
    existing = await chatMessageGistModel.getGist(userId, presetId, messageId);
  } catch (error) {
    if (error?.code === "42P01") {
      logger.warn("chat_message_gist_table_missing", { userId, presetId });
      return;
    }
    throw error;
  }

  if (existing?.contentHash && existing.contentHash === contentHash) return;

  const startedAt = Date.now();
  const gistText = await generateAssistantGist({ content: normalizedContent });
  if (!gistText) {
    logger.warn("chat_message_gist_empty", { userId, presetId, messageId });
    return;
  }

  const result = await chatMessageGistModel.upsertGist(userId, presetId, messageId, {
    gistText,
    contentHash,
    providerId: chatGistConfig.workerProviderId,
    modelId: chatGistConfig.workerModelId,
  });

  logger.debug("chat_message_gist_updated", {
    userId,
    presetId,
    messageId,
    chars: gistText.length,
    durationMs: Date.now() - startedAt,
    providerId: chatGistConfig.workerProviderId,
    modelId: chatGistConfig.workerModelId,
    updated: Boolean(result),
  });
}

function requestAssistantGistGeneration({ userId, presetId, messageId, content } = {}) {
  if (!chatGistConfig.enabled) return;
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  const normalizedMessageId = Number(messageId);
  if (!normalizedUserId || !normalizedPresetId || !Number.isFinite(normalizedMessageId)) return;

  const key = buildKey(normalizedUserId, normalizedMessageId);

  void enqueueKeyTask(key, async () => {
    const release = await workerSemaphore.acquire();
    try {
      await generateAndStoreGist({
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        messageId: normalizedMessageId,
        content,
      });
    } catch (error) {
      logger.error("chat_message_gist_generate_failed", {
        error,
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        messageId: normalizedMessageId,
        providerId: chatGistConfig.workerProviderId,
        modelId: chatGistConfig.workerModelId,
      });
    } finally {
      release();
    }
  });
}

module.exports = {
  requestAssistantGistGeneration,
};
