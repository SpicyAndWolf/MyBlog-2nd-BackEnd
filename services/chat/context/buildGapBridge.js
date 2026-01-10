const chatModel = require("@models/chatModel");
const { chatMemoryConfig } = require("../../../config");
const { loadAssistantGistMap, scheduleAssistantGistBackfill } = require("./assistantGist");
const { normalizeMessageId } = require("./helpers");
const { selectRecentWindowMessages } = require("./selectRecentWindowMessages");

async function buildGapBridge({
  userId,
  presetId,
  needsMemory,
  memory,
  recentWindowStartMessageId,
  summarizedUntilMessageId,
} = {}) {
  if (
    !needsMemory ||
    !memory ||
    memory.rebuildRequired ||
    recentWindowStartMessageId === null ||
    recentWindowStartMessageId <= 0 ||
    summarizedUntilMessageId === null ||
    summarizedUntilMessageId >= recentWindowStartMessageId - 1
  ) {
    return null;
  }

  const gapBridgeMaxMessages = chatMemoryConfig.gapBridgeMaxMessages;
  const gapBridgeMaxChars = chatMemoryConfig.gapBridgeMaxChars;

  const gapStartId = summarizedUntilMessageId + 1;
  const gapEndId = recentWindowStartMessageId - 1;

  const gapCandidateLimit = Math.min(500, Math.max(1, gapBridgeMaxMessages) + 50);
  const gapCandidates = await chatModel.listRecentMessagesByPreset(userId, presetId, {
    limit: gapCandidateLimit,
    upToMessageId: gapEndId,
  });

  const gapUnsummarized = gapCandidates.filter((row) => {
    const id = normalizeMessageId(row?.id);
    if (id === null) return false;
    return id >= gapStartId && id <= gapEndId;
  });

  const assistantGistEnabled = Boolean(chatMemoryConfig.recentWindowAssistantGistEnabled);
  const assistantGistMap = assistantGistEnabled
    ? await loadAssistantGistMap({ userId, presetId, candidates: gapUnsummarized })
    : null;

  const selected = selectRecentWindowMessages(gapUnsummarized, {
    maxMessages: gapBridgeMaxMessages,
    maxChars: gapBridgeMaxChars,
    assistantGistEnabled,
    assistantRawLastN: 0,
    assistantGistPrefix: chatMemoryConfig.recentWindowAssistantGistPrefix,
    assistantGistMap,
  });

  const gistBackfill = scheduleAssistantGistBackfill({
    userId,
    presetId,
    assistantGistCandidates: selected.assistantGistCandidates,
    assistantGistMap,
  });
  if (selected?.stats?.assistantAntiEcho) {
    selected.stats.assistantAntiEcho.gistBackfill = gistBackfill;
  }

  if (selected.messages.length) {
    return {
      messages: selected.messages,
      stats: {
        ...selected.stats,
        candidates: gapCandidates.length,
        candidateLimit: gapCandidateLimit,
        gapStartId,
        gapEndId,
      },
    };
  }

  return {
    messages: [],
    stats: {
      candidates: gapCandidates.length,
      candidateLimit: gapCandidateLimit,
      gapStartId,
      gapEndId,
      selected: 0,
      selectedChars: 0,
    },
  };
}

module.exports = {
  buildGapBridge,
};
