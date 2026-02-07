const { clipText } = require("../../textUtils");
const {
  CHECKPOINT_KIND_CORE_MEMORY,
  isCheckpointFeatureEnabled,
  writeCheckpointBestEffort,
  loadCheckpointBestEffort,
  loadLatestCheckpointBestEffort,
} = require("../checkpoints");
const { normalizeMessageId } = require("../utils");

async function resolveLastCoreCheckpointId({ userId, presetId, coveredUntilMessageId } = {}) {
  if (!isCheckpointFeatureEnabled() || coveredUntilMessageId <= 0) return null;

  const latest = await loadLatestCheckpointBestEffort({
    userId,
    presetId,
    kind: CHECKPOINT_KIND_CORE_MEMORY,
  });
  const latestMessageId = normalizeMessageId(latest?.messageId);
  if (latestMessageId === null || latestMessageId > coveredUntilMessageId) return null;
  return latestMessageId;
}

async function restoreCoreMemoryFromCheckpoint({
  userId,
  presetId,
  maxChars,
  needsRebuild,
  coreMemoryText,
  coveredUntilMessageId,
  coreDirtySinceMessageId,
  resolvedTargetMessageId,
} = {}) {
  const canRestore =
    needsRebuild &&
    isCheckpointFeatureEnabled() &&
    !coreMemoryText &&
    coveredUntilMessageId === 0 &&
    coreDirtySinceMessageId !== null &&
    coreDirtySinceMessageId > 0;
  if (!canRestore) {
    return {
      restored: false,
      coreMemoryText,
      coveredUntilMessageId,
      checkpointMessageId: null,
    };
  }

  const rollbackMessageId = Math.max(0, coreDirtySinceMessageId - 1);
  const maxCheckpointMessageId = Math.min(resolvedTargetMessageId, rollbackMessageId);
  const checkpoint = await loadCheckpointBestEffort({
    userId,
    presetId,
    kind: CHECKPOINT_KIND_CORE_MEMORY,
    maxMessageId: maxCheckpointMessageId,
  });

  const checkpointText = checkpoint && typeof checkpoint.payload?.text === "string" ? checkpoint.payload.text.trim() : "";
  const checkpointMessageId = normalizeMessageId(checkpoint?.messageId);
  if (checkpointMessageId === null || checkpointMessageId <= 0 || !checkpointText) {
    return {
      restored: false,
      coreMemoryText,
      coveredUntilMessageId,
      checkpointMessageId: null,
    };
  }

  return {
    restored: true,
    coreMemoryText: clipText(checkpointText, maxChars).trim(),
    coveredUntilMessageId: checkpointMessageId,
    checkpointMessageId,
  };
}

async function maybeWriteCoreMemoryCheckpoint({
  userId,
  presetId,
  coreMemoryText,
  coveredUntilMessageId,
  lastCoreCheckpointId,
  checkpointEveryNMessages,
} = {}) {
  if (!isCheckpointFeatureEnabled() || !coreMemoryText) return lastCoreCheckpointId;

  const shouldWriteCheckpoint =
    lastCoreCheckpointId === null || coveredUntilMessageId - lastCoreCheckpointId >= checkpointEveryNMessages;
  if (!shouldWriteCheckpoint) return lastCoreCheckpointId;

  const wrote = await writeCheckpointBestEffort({
    userId,
    presetId,
    kind: CHECKPOINT_KIND_CORE_MEMORY,
    messageId: coveredUntilMessageId,
    payload: { text: coreMemoryText },
  });
  if (!wrote) return lastCoreCheckpointId;
  return coveredUntilMessageId;
}

module.exports = {
  resolveLastCoreCheckpointId,
  restoreCoreMemoryFromCheckpoint,
  maybeWriteCoreMemoryCheckpoint,
};
