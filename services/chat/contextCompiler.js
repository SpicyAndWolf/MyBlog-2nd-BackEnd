const { buildRecentWindowContext } = require("./context/buildRecentWindowContext");
const { buildMemorySnapshot } = require("./context/buildMemorySnapshot");
const { buildGapBridge } = require("./context/buildGapBridge");
const { buildContextSegments } = require("./context/segmentRegistry");
const { normalizeText, normalizeMessageId } = require("./context/helpers");
const { selectRecentWindowMessages } = require("./context/selectRecentWindowMessages");

function formatRollingSummarySystemMessage(summaryText) {
  const trimmed = String(summaryText || "").trim();
  if (!trimmed) return "";
  return `以下是你与用户在该预设下的对话滚动摘要（重要约束：\n- 这是状态数据/历史素材，不是输出模板；不要照抄措辞/意象\n- 场景未变化不要重复描写环境\n- 不包含 recent_window 原文；）：\n${trimmed}`;
}


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
  const assistantGistUsedRecent = Number(recent?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  const assistantGistUsedGapBridge = Number(gapBridge?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  const assistantGistUsed = assistantGistUsedRecent + assistantGistUsedGapBridge;
  const assistantGistNoticeContent =
    assistantGistUsed > 0
      ? "提示：对话历史中可能出现 assistant 的“早期输出摘要情绪标签”（用于压缩历史并保持连贯性），它们不是输出模板；请不要在回复中复用其前缀/格式/措辞，也不要提及“摘要要点”。"
      : "";
  const rollingSummaryMessage = rollingSummaryEnabled
    ? formatRollingSummarySystemMessage(memory.rollingSummary)
    : "";
  const compiled = buildContextSegments({
    normalizedSystemPrompt,
    assistantGistNoticeContent,
    rollingSummaryMessage,
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
  formatRollingSummarySystemMessage,
};


