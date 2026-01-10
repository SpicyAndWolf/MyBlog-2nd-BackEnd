const { buildRecentWindowContext } = require("./context/buildRecentWindowContext");
const { buildMemorySnapshot } = require("./context/buildMemorySnapshot");
const { buildGapBridge } = require("./context/buildGapBridge");
const { buildContextSegments } = require("./context/segmentRegistry");
const { normalizeText, normalizeMessageId } = require("./context/helpers");
const { selectRecentWindowMessages } = require("./context/selectRecentWindowMessages");

async function compileChatContextMessages({ userId, presetId, systemPrompt, upToMessageId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const recentWindow = await buildRecentWindowContext({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    upToMessageId,
  });

  const recentCandidates = recentWindow.recentCandidates;
  const recent = recentWindow.recent;
  const selectedBeforeUserBoundary = recentWindow.selectedBeforeUserBoundary;
  const needsMemory = recentWindow.needsMemory;

  const recentWindowStartMessageId = normalizeMessageId(recent.stats.windowStartMessageId);

  const memorySnapshot = await buildMemorySnapshot({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    needsMemory,
    recentWindowStartMessageId,
  });
  const memory = memorySnapshot.memory;
  const summarizedUntilMessageId = memorySnapshot.summarizedUntilMessageId;
  const rollingSummaryEnabled = memorySnapshot.rollingSummaryEnabled;

  const gapBridge = await buildGapBridge({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    needsMemory,
    memory,
    recentWindowStartMessageId,
    summarizedUntilMessageId,
  });

  const normalizedSystemPrompt = normalizeText(systemPrompt).trim();

  const compiled = buildContextSegments({
    systemPrompt: normalizedSystemPrompt,
    rollingSummaryEnabled,
    memory,
    gapBridge,
    recent,
  });

  return {
    messages: compiled,
    needsMemory,
    segments: {
      systemPromptChars: normalizedSystemPrompt.length,
      rollingSummaryChars: rollingSummaryEnabled ? String(memory.rollingSummary || "").length : 0,
      gapBridge: gapBridge ? gapBridge.stats : null,
      recentWindow: {
        ...recent.stats,
        candidates: recentCandidates.length,
        selectedBeforeUserBoundary,
        needsMemory,
      },
    },
    memory: memory
      ? {
          summarizedUntilMessageId: memory.summarizedUntilMessageId,
          dirtySinceMessageId: memory.dirtySinceMessageId,
          rebuildRequired: memory.rebuildRequired,
        }
      : null,
  };
}

module.exports = {
  compileChatContextMessages,
  selectRecentWindowMessages,
};

