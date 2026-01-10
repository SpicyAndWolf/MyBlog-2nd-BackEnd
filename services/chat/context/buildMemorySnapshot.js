const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { logger } = require("../../../logger");
const { normalizeMessageId } = require("./helpers");

async function ensurePresetMemory(userId, presetId) {
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

async function buildMemorySnapshot({ userId, presetId, needsMemory, recentWindowStartMessageId } = {}) {
  const memory = needsMemory ? await ensurePresetMemory(userId, presetId) : null;
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

  return {
    memory,
    summarizedUntilMessageId,
    rollingSummaryEnabled,
  };
}

module.exports = {
  buildMemorySnapshot,
};
