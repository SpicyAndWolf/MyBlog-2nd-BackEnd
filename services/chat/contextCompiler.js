const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatConfig, chatMemoryConfig } = require("../../config");
const { logger } = require("../../logger");

function normalizeText(value) {
  return String(value || "");
}

function normalizeMessageId(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return null;
  return number;
}

function normalizePositiveIntLimit(value, fallback, { name } = {}) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid ${name || "limit"}: ${String(value)}`);
  }
  return Math.floor(number);
}

function selectRecentWindowMessages(historyMessages, { maxMessages, maxChars } = {}) {
  const normalizedMaxMessages = normalizePositiveIntLimit(maxMessages, chatConfig.maxContextMessages, {
    name: "maxMessages",
  });
  const normalizedMaxChars = normalizePositiveIntLimit(maxChars, chatConfig.maxContextChars, { name: "maxChars" });

  const history = Array.isArray(historyMessages) ? historyMessages : [];

  const selectedReversed = [];
  let totalChars = 0;
  let inspected = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    inspected++;
    const entry = history[i] || {};
    const id = Number(entry.id);
    const messageId = Number.isFinite(id) ? Math.floor(id) : null;
    const role = String(entry.role || "").trim();
    const content = normalizeText(entry.content);
    if (!role || !content) continue;

    if (selectedReversed.length >= normalizedMaxMessages) break;

    const nextChars = totalChars + content.length;
    if (nextChars > normalizedMaxChars && selectedReversed.length > 0) break;

    selectedReversed.push({ id: messageId, role, content });
    totalChars = nextChars;
  }

  selectedReversed.reverse();

  let droppedToUserBoundary = 0;
  while (selectedReversed.length > 1 && selectedReversed[0].role !== "user") {
    const dropped = selectedReversed.shift();
    if (dropped?.content) totalChars -= dropped.content.length;
    droppedToUserBoundary++;
  }

  const windowStartMessageId = selectedReversed.length ? selectedReversed[0]?.id : null;
  const windowEndMessageId = selectedReversed.length ? selectedReversed[selectedReversed.length - 1]?.id : null;

  return {
    messages: selectedReversed.map(({ role, content }) => ({ role, content })),
    stats: {
      maxMessages: normalizedMaxMessages,
      maxChars: normalizedMaxChars,
      inspected,
      selected: selectedReversed.length,
      selectedChars: totalChars,
      droppedToUserBoundary,
      windowStartMessageId,
      windowEndMessageId,
    },
  };
}

function formatRollingSummarySystemMessage(summaryText) {
  const trimmed = String(summaryText || "").trim();
  if (!trimmed) return "";
  return `以下是你与用户在该预设下的对话滚动摘要（不包含最近窗口内的原文消息；仅包含已确认事实/偏好/承诺/未完成事项；可能滞后；不确定请向用户澄清）：\n${trimmed}`;
}

async function safeEnsurePresetMemory(userId, presetId) {
  try {
    return await chatPresetMemoryModel.ensureMemory(userId, presetId);
  } catch (error) {
    if (error?.code === "42P01") {
      logger.warn("chat_preset_memory_table_missing", { userId, presetId });
      return null;
    }
    throw error;
  }
}

async function compileChatContextMessages({
  userId,
  presetId,
  systemPrompt,
  upToMessageId,
} = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const maxMessages = chatConfig.maxContextMessages;
  const maxChars = chatConfig.maxContextChars;
  const candidateLimit = maxMessages + 1;

  const gapBridgeMaxMessages = chatMemoryConfig.gapBridgeMaxMessages;
  const gapBridgeMaxChars = chatMemoryConfig.gapBridgeMaxChars;

  const recentCandidates = await chatModel.listRecentMessagesByPreset(normalizedUserId, normalizedPresetId, {
    limit: candidateLimit,
    upToMessageId,
  });

  const recent = selectRecentWindowMessages(recentCandidates, { maxMessages, maxChars });
  const selectedBeforeUserBoundary = recent.stats.selected + recent.stats.droppedToUserBoundary;
  const reachedCandidateLimit = recentCandidates.length === candidateLimit;
  const needsMemory = reachedCandidateLimit || recentCandidates.length > selectedBeforeUserBoundary;

  const memory = needsMemory ? await safeEnsurePresetMemory(normalizedUserId, normalizedPresetId) : null;
  const recentWindowStartMessageId = normalizeMessageId(recent.stats.windowStartMessageId);
  const summarizedUntilMessageId = memory ? normalizeMessageId(memory.summarizedUntilMessageId) : null;
  const summaryOverlapsRecentWindow =
    Boolean(memory) &&
    recentWindowStartMessageId !== null &&
    summarizedUntilMessageId !== null &&
    summarizedUntilMessageId >= recentWindowStartMessageId;

  const rollingSummaryEnabled =
    needsMemory &&
    Boolean(memory) &&
    !memory.rebuildRequired &&
    memory.dirtySinceMessageId === null &&
    !summaryOverlapsRecentWindow &&
    Boolean(String(memory.rollingSummary || "").trim());

  let gapBridge = null;
  if (
    needsMemory &&
    memory &&
    !memory.rebuildRequired &&
    recentWindowStartMessageId !== null &&
    recentWindowStartMessageId > 0 &&
    summarizedUntilMessageId !== null &&
    summarizedUntilMessageId < recentWindowStartMessageId - 1
  ) {
    const gapStartId = summarizedUntilMessageId + 1;
    const gapEndId = recentWindowStartMessageId - 1;

    const gapCandidateLimit = Math.min(500, Math.max(1, gapBridgeMaxMessages) + 50);
    const gapCandidates = await chatModel.listRecentMessagesByPreset(normalizedUserId, normalizedPresetId, {
      limit: gapCandidateLimit,
      upToMessageId: gapEndId,
    });

    const gapUnsummarized = gapCandidates.filter((row) => {
      const id = normalizeMessageId(row?.id);
      if (id === null) return false;
      return id >= gapStartId && id <= gapEndId;
    });

    const selected = selectRecentWindowMessages(gapUnsummarized, {
      maxMessages: gapBridgeMaxMessages,
      maxChars: gapBridgeMaxChars,
    });
    if (selected.messages.length) {
      gapBridge = {
        messages: selected.messages,
        stats: {
          ...selected.stats,
          candidates: gapCandidates.length,
          candidateLimit: gapCandidateLimit,
          gapStartId,
          gapEndId,
        },
      };
    } else {
      gapBridge = {
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
  }

  const compiled = [];
  const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
  if (normalizedSystemPrompt) {
    compiled.push({ role: "system", content: normalizedSystemPrompt });
  }

  if (rollingSummaryEnabled) {
    const systemSummary = formatRollingSummarySystemMessage(memory.rollingSummary);
    if (systemSummary) {
      compiled.push({ role: "system", content: systemSummary });
    }
  }

  if (gapBridge?.messages?.length) {
    compiled.push(...gapBridge.messages);
  }

  compiled.push(...recent.messages);

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
