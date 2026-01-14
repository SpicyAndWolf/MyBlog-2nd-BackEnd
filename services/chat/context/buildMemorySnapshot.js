const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatMemoryConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { normalizeMessageId } = require("./helpers");
const { clipText } = require("../memory/textUtils");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readCoreMemoryText(rawMemory) {
  const coreMemory = rawMemory?.coreMemory;
  if (typeof coreMemory === "string") return coreMemory;
  if (!isPlainObject(coreMemory)) return "";
  if (typeof coreMemory.text !== "string") return "";
  return coreMemory.text;
}

function readCoreMemoryMeta(rawMemory) {
  const coreMemory = rawMemory?.coreMemory;
  if (!isPlainObject(coreMemory)) return {};
  return isPlainObject(coreMemory.meta) ? coreMemory.meta : {};
}

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

  const coreFeatureEnabled = Boolean(chatMemoryConfig.coreMemoryEnabled);
  const coreMeta = coreFeatureEnabled && needsMemory && memory ? readCoreMemoryMeta(memory) : {};
  const coreNeedsRebuild = Boolean(coreMeta?.needsRebuild);
  const coreMemoryAllowed =
    coreFeatureEnabled &&
    needsMemory &&
    Boolean(memory) &&
    !memory.rebuildRequired &&
    memory.dirtySinceMessageId === null &&
    !coreNeedsRebuild;

  const coreMemoryText = coreMemoryAllowed
    ? clipText(String(readCoreMemoryText(memory) || "").trim(), chatMemoryConfig.coreMemoryMaxChars).trim()
    : "";
  const coreMemoryChars = coreMemoryText.length;
  const coreMemoryEnabled = coreMemoryAllowed && coreMemoryChars > 0;

  return {
    memory,
    summarizedUntilMessageId,
    rollingSummaryEnabled,
    coreMemoryEnabled,
    coreMemoryText,
    coreMemoryChars,
  };
}

module.exports = {
  buildMemorySnapshot,
};
