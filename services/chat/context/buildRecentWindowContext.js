const chatModel = require("@models/chatModel");
const { chatConfig, chatMemoryConfig } = require("../../../config");
const { loadAssistantGistMap, scheduleAssistantGistBackfill } = require("./assistantGist");
const { selectRecentWindowMessages } = require("./selectRecentWindowMessages");

async function buildRecentWindowContext({ userId, presetId, upToMessageId } = {}) {
  const maxMessages = chatConfig.recentWindowMaxMessages;
  const maxChars = chatConfig.recentWindowMaxChars;
  const candidateLimit = maxMessages + 1;

  const recentCandidates = await chatModel.listRecentMessagesByPreset(userId, presetId, {
    limit: candidateLimit,
    upToMessageId,
  });

  const assistantGistMap = await loadAssistantGistMap({
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

  const gistBackfill = scheduleAssistantGistBackfill({
    userId,
    presetId,
    assistantGistCandidates: recent.assistantGistCandidates,
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
