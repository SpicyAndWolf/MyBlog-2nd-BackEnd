const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const chatMessageGistModel = require("@models/chatMessageGistModel");
const { chatConfig, chatMemoryConfig, chatGistConfig } = require("../../config");
const { logger } = require("../../logger");
const { requestAssistantGistGeneration } = require("./memory/gistPipeline");

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

function normalizePositiveIntRequired(value, { name } = {}) {
  if (value === undefined || value === null) {
    throw new Error(`Missing required ${name || "limit"}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid ${name || "limit"}: ${String(value)}`);
  }
  return Math.floor(number);
}

function normalizeNonNegativeIntRequired(value, { name } = {}) {
  if (value === undefined || value === null) {
    throw new Error(`Missing required ${name || "limit"}`);
  }
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`Invalid ${name || "limit"}: ${String(value)}`);
  }
  return Math.floor(number);
}

function clipText(text, maxChars) {
  const normalized = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return normalized;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function stripMarkdownForGist(rawText) {
  let text = String(rawText || "");

  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/!\[[^\]]*\]\([^)]+\)/g, " ");
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
  text = text.replace(/`([^`]+)`/g, "$1");

  text = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s+/, "")
        .trim()
    )
    .filter(Boolean)
    .join("\n");

  text = text.replace(/[ \t]+/g, " ").trim();
  return text;
}

function buildAssistantGistBody(rawText, { maxChars } = {}) {
  const normalizedRaw = String(rawText || "").trim();
  if (!normalizedRaw) return "";

  const cleaned = stripMarkdownForGist(normalizedRaw);
  const sourceText = cleaned || normalizedRaw;

  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const bulletLines = lines
    .filter((line) => /^([-*•]|\d+\.)\s+/.test(line))
    .map((line) => line.replace(/^([-*•]|\d+\.)\s+/, "").trim())
    .filter(Boolean);

  let gist = "";
  if (bulletLines.length) {
    gist = bulletLines.join("；");
  } else {
    gist = lines.join(" ");
  }

  gist = gist
    .replace(/[“”"']/g, "")
    .replace(/[。！？!?]+/g, "；")
    .replace(/[；;]+/g, "；")
    .replace(/\s+/g, " ")
    .trim();

  return clipText(gist, maxChars).trim();
}

function buildAssistantGistMessageFromBody(gistBody, { prefix, maxBodyChars } = {}) {
  const header = String(prefix || "").trim();
  if (!header) throw new Error("Missing assistantGistPrefix");
  const prefixText = `${header}\n- `;

  const maxChars = normalizePositiveIntRequired(maxBodyChars, { name: "assistantGistMaxChars" });

  const normalizedBody = clipText(String(gistBody || "").trim(), maxChars).trim();
  if (!normalizedBody) return "";
  return `${prefixText}${normalizedBody}`;
}

function buildAssistantGistMessage(rawText, { prefix, maxBodyChars } = {}) {
  const maxChars = normalizePositiveIntRequired(maxBodyChars, { name: "assistantGistMaxChars" });
  const body = buildAssistantGistBody(rawText, { maxChars });
  if (!body) return "";
  return buildAssistantGistMessageFromBody(body, { prefix, maxBodyChars: maxChars });
}

function getAssistantGistFromMap(assistantGistMap, messageId) {
  if (!assistantGistMap || messageId === null || messageId === undefined) return "";
  if (assistantGistMap instanceof Map) {
    return String(assistantGistMap.get(messageId) || "");
  }
  if (typeof assistantGistMap === "object") {
    return String(assistantGistMap[messageId] || "");
  }
  return "";
}

function selectRecentWindowMessages(
  historyMessages,
  {
    maxMessages,
    maxChars,
    assistantGistEnabled,
    assistantRawLastN,
    assistantGistMaxChars,
    assistantGistPrefix,
    assistantGistMap,
  } = {}
) {
  const normalizedMaxMessages = normalizePositiveIntLimit(maxMessages, chatConfig.maxContextMessages, {
    name: "maxMessages",
  });
  const normalizedMaxChars = normalizePositiveIntLimit(maxChars, chatConfig.maxContextChars, { name: "maxChars" });

  const normalizedAssistantGistEnabled = Boolean(assistantGistEnabled);
  const normalizedAssistantRawLastN = normalizedAssistantGistEnabled
    ? normalizeNonNegativeIntRequired(assistantRawLastN, { name: "assistantRawLastN" })
    : 0;
  const normalizedAssistantGistMaxChars = normalizedAssistantGistEnabled
    ? normalizePositiveIntRequired(assistantGistMaxChars, { name: "assistantGistMaxChars" })
    : 0;
  const normalizedAssistantGistPrefix = normalizedAssistantGistEnabled ? String(assistantGistPrefix || "").trim() : "";
  if (normalizedAssistantGistEnabled && !normalizedAssistantGistPrefix) {
    throw new Error("Missing assistantGistPrefix");
  }

  const history = Array.isArray(historyMessages) ? historyMessages : [];

  const selectedReversed = [];
  let totalChars = 0;
  let inspected = 0;
  let assistantMessagesSelected = 0;
  let assistantGistFromCache = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    inspected++;
    const entry = history[i] || {};
    const id = Number(entry.id);
    const messageId = Number.isFinite(id) ? Math.floor(id) : null;
    const role = String(entry.role || "").trim();
    const content = normalizeText(entry.content);
    if (!role || !content) continue;

    if (selectedReversed.length >= normalizedMaxMessages) break;

    let effectiveContent = content;
    let assistantGist = false;
    let assistantShouldGist = false;
    let assistantGistCacheHit = false;

    if (normalizedAssistantGistEnabled && role === "assistant") {
      const shouldKeepRaw = assistantMessagesSelected < normalizedAssistantRawLastN;
      assistantShouldGist = !shouldKeepRaw;
      let cachedGistBody = "";
      if (assistantShouldGist) {
        cachedGistBody = getAssistantGistFromMap(assistantGistMap, messageId);
        let gistMessage = "";
        if (cachedGistBody) {
          gistMessage = buildAssistantGistMessageFromBody(cachedGistBody, {
            prefix: normalizedAssistantGistPrefix,
            maxBodyChars: normalizedAssistantGistMaxChars,
          });
          if (gistMessage) {
            assistantGistFromCache += 1;
            assistantGistCacheHit = true;
          }
        }
        if (gistMessage) {
          effectiveContent = gistMessage;
          assistantGist = true;
        }
      }
    }

    let nextChars = totalChars + effectiveContent.length;
    if (nextChars > normalizedMaxChars && selectedReversed.length > 0) {
      break;
    }

    selectedReversed.push({
      id: messageId,
      role,
      content: effectiveContent,
      assistantGist,
      assistantShouldGist,
      assistantGistCacheHit,
      originalContent: role === "assistant" ? content : "",
      originalContentLength: content.length,
    });
    totalChars = nextChars;

    if (role === "assistant") {
      assistantMessagesSelected += 1;
    }
  }

  selectedReversed.reverse();

  let droppedToUserBoundary = 0;
  while (selectedReversed.length > 1 && selectedReversed[0].role !== "user") {
    const dropped = selectedReversed.shift();
    if (dropped?.content) totalChars -= dropped.content.length;
    droppedToUserBoundary++;
  }

  const assistantGistCandidates = [];
  for (let i = selectedReversed.length - 1; i >= 0; i--) {
    const row = selectedReversed[i];
    if (!row || row.role !== "assistant" || !row.assistantShouldGist) continue;
    const messageId = normalizeMessageId(row.id);
    if (messageId === null) continue;
    const originalContent = String(row.originalContent || "").trim();
    if (!originalContent) continue;
    assistantGistCandidates.push({ messageId, content: originalContent });
  }

  const windowStartMessageId = selectedReversed.length ? selectedReversed[0]?.id : null;
  const windowEndMessageId = selectedReversed.length ? selectedReversed[selectedReversed.length - 1]?.id : null;

  const assistantGistUsed = selectedReversed.filter((row) => row?.role === "assistant" && row?.assistantGist).length;
  const assistantTotal = selectedReversed.filter((row) => row?.role === "assistant").length;
  const assistantGistCharsSaved = selectedReversed.reduce((total, row) => {
    if (!row || row.role !== "assistant" || !row.assistantGist) return total;
    const originalLength = Number(row.originalContentLength) || 0;
    const currentLength = String(row.content || "").length;
    return total + Math.max(0, originalLength - currentLength);
  }, 0);

  return {
    messages: selectedReversed.map(({ role, content }) => ({ role, content })),
    assistantGistCandidates,
    stats: {
      maxMessages: normalizedMaxMessages,
      maxChars: normalizedMaxChars,
      inspected,
      selected: selectedReversed.length,
      selectedChars: totalChars,
      droppedToUserBoundary,
      windowStartMessageId,
      windowEndMessageId,
      assistantAntiEcho: normalizedAssistantGistEnabled
        ? {
            assistantRawLastN: normalizedAssistantRawLastN,
            assistantGistMaxChars: normalizedAssistantGistMaxChars,
            assistantTotal,
            assistantGistUsed,
            assistantGistFromCache,
            assistantGistCharsSaved,
          }
        : null,
    },
  };
}

function formatRollingSummarySystemMessage(summaryText) {
  const trimmed = String(summaryText || "").trim();
  if (!trimmed) return "";
  return `以下是你与用户在该预设下的对话滚动摘要（重要约束：\n- 这是状态数据/历史素材，不是输出模板；不要照抄措辞/意象\n- 场景未变化不要重复描写环境\n- 不包含 recent_window 原文；）：\n${trimmed}`;
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
  if (!chatMemoryConfig?.recentWindowAssistantGistEnabled) return { scheduled: 0, reason: "recent_window_gist_disabled" };

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

async function compileChatContextMessages({ userId, presetId, systemPrompt, upToMessageId } = {}) {
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

  const assistantGistMap = await safeLoadAssistantGistMap({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    candidates: recentCandidates,
  });

  const recent = selectRecentWindowMessages(recentCandidates, {
    maxMessages,
    maxChars,
    assistantGistEnabled: chatMemoryConfig.recentWindowAssistantGistEnabled,
    assistantRawLastN: chatMemoryConfig.recentWindowAssistantRawLastN,
    assistantGistMaxChars: chatMemoryConfig.recentWindowAssistantGistMaxChars,
    assistantGistPrefix: chatMemoryConfig.recentWindowAssistantGistPrefix,
    assistantGistMap,
  });

  const gistBackfill = scheduleRecentWindowAssistantGistBackfill({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    recentWindow: recent,
    assistantGistMap,
  });
  if (recent?.stats?.assistantAntiEcho) {
    recent.stats.assistantAntiEcho.gistBackfill = gistBackfill;
  }
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
