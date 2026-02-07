const {
  CHECKPOINT_KIND_ROLLING_SUMMARY,
  isCheckpointFeatureEnabled,
  writeCheckpointBestEffort,
  loadCheckpointBestEffort,
  loadLatestCheckpointBestEffort,
} = require("../checkpoints");
const { normalizeMessageId } = require("../utils");
const { shouldWriteRollingSummaryCheckpoint } = require("./policy");

async function resolveLastRollingSummaryCheckpointId({ userId, presetId, afterMessageId } = {}) {
  if (!isCheckpointFeatureEnabled() || afterMessageId <= 0) return null;

  const latest = await loadLatestCheckpointBestEffort({ userId, presetId, kind: CHECKPOINT_KIND_ROLLING_SUMMARY });
  const latestMessageId = normalizeMessageId(latest?.messageId);
  if (latestMessageId === null || latestMessageId > afterMessageId) return null;
  return latestMessageId;
}

async function restoreRollingSummaryFromCheckpoint({
  userId,
  presetId,
  isDirty,
  afterMessageId,
  rollingSummary,
  dirtySinceMessageId,
  targetUntilMessageId,
} = {}) {
  const normalizedDirtySince = normalizeMessageId(dirtySinceMessageId);
  const canRestore =
    isDirty &&
    isCheckpointFeatureEnabled() &&
    afterMessageId === 0 &&
    !rollingSummary &&
    normalizedDirtySince !== null;
  if (!canRestore) {
    return {
      restored: false,
      afterMessageId,
      rollingSummary,
      checkpointMessageId: null,
    };
  }

  const rollbackMessageId = Math.max(0, Number(dirtySinceMessageId) - 1);
  const maxCheckpointMessageId = Math.min(targetUntilMessageId, rollbackMessageId);
  const checkpoint = await loadCheckpointBestEffort({
    userId,
    presetId,
    kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
    maxMessageId: maxCheckpointMessageId,
  });

  const checkpointText = checkpoint && typeof checkpoint.payload?.text === "string" ? checkpoint.payload.text.trim() : "";
  const checkpointMessageId = normalizeMessageId(checkpoint?.messageId);
  if (checkpointMessageId === null || checkpointMessageId <= 0 || !checkpointText) {
    return {
      restored: false,
      afterMessageId,
      rollingSummary,
      checkpointMessageId: null,
    };
  }

  return {
    restored: true,
    afterMessageId: checkpointMessageId,
    rollingSummary: checkpointText,
    checkpointMessageId,
  };
}

async function writeRollingSummaryCheckpointIfNeeded({
  userId,
  presetId,
  afterMessageId,
  rollingSummary,
  protectMessageId,
  shouldInterleaveCoreMemoryEnabled,
  lastRollingSummaryCheckpointId,
  checkpointEveryNMessages,
  reason = "interval",
} = {}) {
  if (!isCheckpointFeatureEnabled() || !rollingSummary) {
    return {
      lastRollingSummaryCheckpointId,
      wroteRollingSummaryCheckpointMessageId: null,
    };
  }

  const shouldWrite = shouldWriteRollingSummaryCheckpoint({
    shouldInterleaveCoreMemoryEnabled,
    lastRollingSummaryCheckpointId,
    afterMessageId,
    checkpointEveryNMessages,
  });
  if (!shouldWrite) {
    return {
      lastRollingSummaryCheckpointId,
      wroteRollingSummaryCheckpointMessageId: null,
    };
  }

  const wrote = await writeCheckpointBestEffort({
    userId,
    presetId,
    kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
    messageId: afterMessageId,
    payload: { text: rollingSummary },
    protectMessageId,
    reason,
  });
  if (!wrote) {
    return {
      lastRollingSummaryCheckpointId,
      wroteRollingSummaryCheckpointMessageId: null,
    };
  }

  return {
    lastRollingSummaryCheckpointId: afterMessageId,
    wroteRollingSummaryCheckpointMessageId: afterMessageId,
  };
}

async function writeFinalRollingSummaryCheckpointIfNeeded({
  userId,
  presetId,
  afterMessageId,
  rollingSummary,
  protectMessageId,
  updated,
  lastRollingSummaryCheckpointId,
  wroteRollingSummaryCheckpointMessageId,
} = {}) {
  if (!isCheckpointFeatureEnabled() || !rollingSummary || afterMessageId <= 0) {
    return {
      lastRollingSummaryCheckpointId,
      wroteRollingSummaryCheckpointMessageId,
    };
  }

  const hasFinalAlignedCheckpoint = lastRollingSummaryCheckpointId !== null && lastRollingSummaryCheckpointId === afterMessageId;
  if (wroteRollingSummaryCheckpointMessageId === afterMessageId || (!updated && hasFinalAlignedCheckpoint)) {
    return {
      lastRollingSummaryCheckpointId,
      wroteRollingSummaryCheckpointMessageId,
    };
  }

  const wrote = await writeCheckpointBestEffort({
    userId,
    presetId,
    kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
    messageId: afterMessageId,
    payload: { text: rollingSummary },
    protectMessageId,
    reason: "tick_end",
  });
  if (!wrote) {
    return {
      lastRollingSummaryCheckpointId,
      wroteRollingSummaryCheckpointMessageId,
    };
  }

  return {
    lastRollingSummaryCheckpointId: afterMessageId,
    wroteRollingSummaryCheckpointMessageId: afterMessageId,
  };
}

module.exports = {
  CHECKPOINT_KIND_ROLLING_SUMMARY,
  resolveLastRollingSummaryCheckpointId,
  restoreRollingSummaryFromCheckpoint,
  writeRollingSummaryCheckpointIfNeeded,
  writeFinalRollingSummaryCheckpointIfNeeded,
};
