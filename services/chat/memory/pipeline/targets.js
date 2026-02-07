const chatModel = require("@models/chatModel");
const { chatConfig } = require("../../../../config");
const { buildRecentWindowContext } = require("../../context/buildRecentWindowContext");
const { normalizeMessageId } = require("./utils");

async function computeRollingSummaryTarget({ userId, presetId } = {}) {
  const maxMessages = chatConfig.recentWindowMaxMessages;
  const candidateLimit = maxMessages + 1;

  const recentWindow = await buildRecentWindowContext({ userId, presetId });
  const candidates = recentWindow.recentCandidates;
  const recent = recentWindow.recent;
  const hasOlderMessages = recentWindow.needsMemory;

  const windowStartMessageId = normalizeMessageId(recent.stats.windowStartMessageId);
  const targetUntilMessageId =
    hasOlderMessages && windowStartMessageId !== null ? Math.max(0, windowStartMessageId - 1) : 0;

  return {
    hasOlderMessages,
    targetUntilMessageId,
    windowStartMessageId,
    candidatesCount: candidates.length,
    candidateLimit,
    windowStats: recent.stats,
  };
}

async function computeCoreMemoryTarget({ userId, presetId } = {}) {
  const latestRows = await chatModel.listRecentMessagesByPreset(userId, presetId, { limit: 1 });
  const latestMessageId = normalizeMessageId(latestRows[0]?.id);
  const targetMessageId = latestMessageId !== null ? latestMessageId : 0;

  return {
    targetMessageId,
  };
}

module.exports = {
  computeRollingSummaryTarget,
  computeCoreMemoryTarget,
};
