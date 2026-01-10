const chatModel = require("@models/chatModel");
const chatMessageGistModel = require("@models/chatMessageGistModel");
const { chatConfig, chatMemoryConfig, chatGistConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { requestAssistantGistGeneration } = require("../memory/gistPipeline");
const { normalizeMessageId, getAssistantGistFromMap } = require("./helpers");
const { selectRecentWindowMessages } = require("./selectRecentWindowMessages");

async function safeLoadAssistantGistMap({ userId, presetId, candidates } = {}) {
  if (!chatGistConfig?.enabled) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  const assistantIds = list
    .map((row) => {
      if (String(row?.role || "").trim() !== "assistant") return null;
      const id = normalizeMessageId(row?.id);
      return id === null ? null : id;
    })
    .filter((id) => id !== null);

  if (!assistantIds.length) return null;

  try {
    const rows = await chatMessageGistModel.listGistsByMessageIds(userId, presetId, assistantIds);
    if (!rows?.length) return null;
    const map = new Map();
    for (const row of rows) {
      const messageId = normalizeMessageId(row?.messageId);
      const gistText = String(row?.gistText || "").trim();
      if (messageId === null || !gistText) continue;
      map.set(messageId, gistText);
    }
    return map;
  } catch (error) {
    if (error?.code === "42P01") {
      logger.warn("chat_message_gist_table_missing", { userId, presetId });
      return null;
    }
    throw error;
  }
}

function scheduleRecentWindowAssistantGistBackfill({ userId, presetId, recentWindow, assistantGistMap } = {}) {
  if (!chatGistConfig?.enabled) return { scheduled: 0, reason: "gist_disabled" };
  if (!chatMemoryConfig?.recentWindowAssistantGistEnabled)
    return { scheduled: 0, reason: "recent_window_gist_disabled" };

  const candidates = Array.isArray(recentWindow?.assistantGistCandidates) ? recentWindow.assistantGistCandidates : [];
  if (!candidates.length) return { scheduled: 0, reason: "no_candidates" };

  const workerConcurrency = Number(chatGistConfig.workerConcurrency) || 1;
  const maxPerRequest = Math.max(1, Math.min(30, Math.floor(workerConcurrency) * 5));

  let scheduled = 0;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i] || {};
    const messageId = normalizeMessageId(candidate.messageId);
    if (messageId === null) continue;

    const content = String(candidate.content || "").trim();
    if (!content) continue;

    const cachedGistBody = getAssistantGistFromMap(assistantGistMap, messageId);
    if (cachedGistBody) continue;

    requestAssistantGistGeneration({ userId, presetId, messageId, content });
    scheduled += 1;
    if (scheduled >= maxPerRequest) break;
  }

  return { scheduled, maxPerRequest, candidatesCount: candidates.length };
}

async function buildRecentWindowContext({ userId, presetId, upToMessageId } = {}) {
  const maxMessages = chatConfig.maxContextMessages;
  const maxChars = chatConfig.maxContextChars;
  const candidateLimit = maxMessages + 1;

  const recentCandidates = await chatModel.listRecentMessagesByPreset(userId, presetId, {
    limit: candidateLimit,
    upToMessageId,
  });

  const assistantGistMap = await safeLoadAssistantGistMap({
    userId,
    presetId,
    candidates: recentCandidates,
  });

  const recent = selectRecentWindowMessages(recentCandidates, {
    maxMessages,
    maxChars,
    assistantGistEnabled: chatMemoryConfig.recentWindowAssistantGistEnabled,
    assistantRawLastN: chatMemoryConfig.recentWindowAssistantRawLastN,
    assistantGistPrefix: chatMemoryConfig.recentWindowAssistantGistPrefix,
    assistantGistMap,
  });

  const gistBackfill = scheduleRecentWindowAssistantGistBackfill({
    userId,
    presetId,
    recentWindow: recent,
    assistantGistMap,
  });
  if (recent?.stats?.assistantAntiEcho) {
    recent.stats.assistantAntiEcho.gistBackfill = gistBackfill;
  }

  const selectedBeforeUserBoundary = recent.stats.selected + recent.stats.droppedToUserBoundary;
  const reachedCandidateLimit = recentCandidates.length === candidateLimit;
  const needsMemory = reachedCandidateLimit || recentCandidates.length > selectedBeforeUserBoundary;

  return {
    recent,
    recentCandidates,
    selectedBeforeUserBoundary,
    needsMemory,
  };
}

module.exports = {
  buildRecentWindowContext,
};
