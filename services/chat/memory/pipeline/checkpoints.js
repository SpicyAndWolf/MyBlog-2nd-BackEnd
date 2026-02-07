const chatPresetMemoryCheckpointModel = require("@models/chatPresetMemoryCheckpointModel");
const { chatMemoryConfig } = require("../../../../config");
const { logger } = require("../../../../logger");
const { normalizeMessageId } = require("./utils");
const { CHECKPOINT_REASONS } = require("./reasons");

const CHECKPOINT_KIND_ROLLING_SUMMARY = chatPresetMemoryCheckpointModel.CHECKPOINT_KINDS.rollingSummary;
const CHECKPOINT_KIND_CORE_MEMORY = chatPresetMemoryCheckpointModel.CHECKPOINT_KINDS.coreMemory;

let checkpointTableMissingLogged = false;
let checkpointTableMissing = false;

function isCheckpointFeatureEnabled() {
  const everyNMessages = Number(chatMemoryConfig.checkpointEveryNMessages);
  const keepLastN = Number(chatMemoryConfig.checkpointKeepLastN);
  return Number.isFinite(everyNMessages) && everyNMessages > 0 && Number.isFinite(keepLastN) && keepLastN > 0;
}

function warnCheckpointTableMissingOnce({ error, operation } = {}) {
  if (checkpointTableMissingLogged) return;
  checkpointTableMissingLogged = true;
  checkpointTableMissing = true;

  logger.warn("chat_memory_checkpoint_table_missing", {
    operation,
    error,
    requiredSql: "BlogBackEnd/models/tableCreate/chat_preset_memory_checkpoints.sql",
    table: "chat_preset_memory_checkpoints",
  });
}

function markCheckpointTableAvailable() {
  checkpointTableMissing = false;
  checkpointTableMissingLogged = false;
}

function checkpointUnavailableReason() {
  if (checkpointTableMissing) return CHECKPOINT_REASONS.TABLE_MISSING;
  if (!isCheckpointFeatureEnabled()) return CHECKPOINT_REASONS.FEATURE_DISABLED;
  return null;
}

async function writeCheckpointBestEffort({ userId, presetId, kind, messageId, payload, protectMessageId, reason } = {}) {
  if (!isCheckpointFeatureEnabled()) return false;

  const checkpointMessageId = normalizeMessageId(messageId);
  if (checkpointMessageId === null || checkpointMessageId <= 0) return false;
  if (!payload || typeof payload !== "object") return false;

  const normalizedProtect = normalizeMessageId(protectMessageId);
  if (protectMessageId !== undefined && protectMessageId !== null && normalizedProtect === null) return false;

  try {
    await chatPresetMemoryCheckpointModel.upsertCheckpoint(userId, presetId, {
      kind,
      messageId: checkpointMessageId,
      payload,
    });
    markCheckpointTableAvailable();
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "write" });
      return false;
    }
    logger.error("chat_memory_checkpoint_write_failed", { error, userId, presetId, kind, messageId: checkpointMessageId });
    return false;
  }

  try {
    await chatPresetMemoryCheckpointModel.pruneKeepLastN(userId, presetId, {
      kind,
      keepLastN: chatMemoryConfig.checkpointKeepLastN,
      protectMessageId: normalizedProtect,
    });
    markCheckpointTableAvailable();
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "prune" });
      return true;
    }
    logger.error("chat_memory_checkpoint_prune_failed", {
      error,
      userId,
      presetId,
      kind,
      keepLastN: chatMemoryConfig.checkpointKeepLastN,
      protectMessageId: normalizedProtect,
    });
  }

  if (reason) {
    const base = {
      userId,
      presetId,
      kind,
      messageId: checkpointMessageId,
      reason,
      protectMessageId: normalizedProtect,
    };
    if (kind === CHECKPOINT_KIND_ROLLING_SUMMARY) {
      base.summarizedUntilMessageId = checkpointMessageId;
    }
    logger.info("chat_memory_checkpoint_written", base);
  }

  return true;
}

async function loadCheckpointBestEffort({ userId, presetId, kind, maxMessageId } = {}) {
  if (!isCheckpointFeatureEnabled()) return null;

  const normalizedMax = normalizeMessageId(maxMessageId);
  if (normalizedMax === null) return null;

  try {
    const checkpoint = await chatPresetMemoryCheckpointModel.getLatestCheckpointBeforeOrAt(userId, presetId, {
      kind,
      maxMessageId: normalizedMax,
    });
    markCheckpointTableAvailable();
    return checkpoint;
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "load" });
      return null;
    }
    logger.error("chat_memory_checkpoint_load_failed", { error, userId, presetId, kind, maxMessageId: normalizedMax });
    return null;
  }
}

async function loadLatestCheckpointBestEffort({ userId, presetId, kind } = {}) {
  if (!isCheckpointFeatureEnabled()) return null;

  try {
    const checkpoint = await chatPresetMemoryCheckpointModel.getLatestCheckpoint(userId, presetId, { kind });
    markCheckpointTableAvailable();
    return checkpoint;
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "load_latest" });
      return null;
    }
    logger.error("chat_memory_checkpoint_load_failed", { error, userId, presetId, kind });
    return null;
  }
}

async function deleteCheckpointsFromMessageIdBestEffort({ userId, presetId, fromMessageId, reason } = {}) {
  const normalizedFrom = normalizeMessageId(fromMessageId);
  if (normalizedFrom === null) return 0;

  try {
    const deletedCount = await chatPresetMemoryCheckpointModel.deleteCheckpointsFromMessageId(userId, presetId, {
      kinds: [CHECKPOINT_KIND_ROLLING_SUMMARY, CHECKPOINT_KIND_CORE_MEMORY],
      fromMessageId: normalizedFrom,
    });
    markCheckpointTableAvailable();
    return deletedCount;
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "delete" });
      return 0;
    }
    logger.error("chat_memory_checkpoint_delete_failed", { error, userId, presetId, fromMessageId: normalizedFrom, reason });
    return 0;
  }
}

async function readAlignedCheckpoint({ userId, presetId, kind, expectedMessageId } = {}) {
  const expected = normalizeMessageId(expectedMessageId);
  if (expected === null) return { ok: false, reason: CHECKPOINT_REASONS.INVALID_MESSAGE_ID };
  if (expected <= 0) return { ok: true, messageId: 0, payload: {} };

  if (!isCheckpointFeatureEnabled()) {
    return {
      ok: false,
      reason: checkpointUnavailableReason() || CHECKPOINT_REASONS.FEATURE_DISABLED,
    };
  }

  const checkpoint = await loadCheckpointBestEffort({
    userId,
    presetId,
    kind,
    maxMessageId: expected,
  });
  const checkpointMessageId = normalizeMessageId(checkpoint?.messageId);
  if (checkpointMessageId !== expected) {
    return {
      ok: false,
      reason: checkpointUnavailableReason() || CHECKPOINT_REASONS.MISSING_ALIGNED_CHECKPOINT,
      foundMessageId: checkpointMessageId,
    };
  }

  return {
    ok: true,
    messageId: checkpointMessageId,
    payload: checkpoint && typeof checkpoint.payload === "object" ? checkpoint.payload : {},
  };
}

module.exports = {
  CHECKPOINT_KIND_ROLLING_SUMMARY,
  CHECKPOINT_KIND_CORE_MEMORY,
  CHECKPOINT_REASONS,
  isCheckpointFeatureEnabled,
  writeCheckpointBestEffort,
  loadCheckpointBestEffort,
  loadLatestCheckpointBestEffort,
  deleteCheckpointsFromMessageIdBestEffort,
  readAlignedCheckpoint,
};
