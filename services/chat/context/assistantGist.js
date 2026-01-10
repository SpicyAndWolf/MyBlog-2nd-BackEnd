const chatMessageGistModel = require("@models/chatMessageGistModel");
const { chatGistConfig, chatMemoryConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { requestAssistantGistGeneration } = require("../memory/gistPipeline");
const { normalizeMessageId, getAssistantGistFromMap } = require("./helpers");

async function loadAssistantGistMap({ userId, presetId, candidates } = {}) {
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

function scheduleAssistantGistBackfill({ userId, presetId, assistantGistCandidates, assistantGistMap } = {}) {
  if (!chatGistConfig?.enabled) return { scheduled: 0, reason: "gist_disabled" };
  if (!chatMemoryConfig?.recentWindowAssistantGistEnabled) return { scheduled: 0, reason: "assistant_gist_disabled" };

  const candidates = Array.isArray(assistantGistCandidates) ? assistantGistCandidates : [];
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

module.exports = {
  loadAssistantGistMap,
  scheduleAssistantGistBackfill,
};

