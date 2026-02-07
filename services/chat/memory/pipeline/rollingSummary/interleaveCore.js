const { logger } = require("../../../../../logger");
const { normalizeMessageId } = require("../utils");

async function maybeInterleaveCoreMemoryUpdate({
  shouldInterleaveCoreMemory,
  needsMemory,
  afterMessageId,
  rollingSummary,
  userId,
  presetId,
  targetUntilMessageId,
  deadline,
  providerId,
  modelId,
  updateCoreMemoryOnce,
  protectMessageId,
} = {}) {
  if (!shouldInterleaveCoreMemory) {
    return { coreResult: null, protectMessageId };
  }
  if (!needsMemory || afterMessageId <= 0 || !rollingSummary) {
    return { coreResult: null, protectMessageId };
  }

  let coreResult = null;
  try {
    coreResult = await updateCoreMemoryOnce({
      userId,
      presetId,
      needsMemory,
      boundaryId: targetUntilMessageId,
      deadline,
      force: true,
      allowDuringRollingSummaryRebuild: true,
    });
  } catch (error) {
    logger.error("chat_memory_core_interleave_failed", {
      error,
      userId,
      presetId,
      providerId,
      modelId,
    });
    return { coreResult: null, protectMessageId };
  }

  if (coreResult?.updated) {
    logger.info("chat_memory_core_interleaved", {
      userId,
      presetId,
      coveredUntilMessageId: coreResult.coveredUntilMessageId,
      targetMessageId: coreResult.targetMessageId,
      boundaryId: coreResult.boundaryId,
      strictSyncEnabled: coreResult.strictSyncEnabled,
      usedFallback: coreResult.usedFallback,
      processedBatches: coreResult.processedBatches,
      processedMessages: coreResult.processedMessages,
      reason: coreResult.reason,
      summarizedUntilMessageId: coreResult.summarizedUntilMessageId,
      rollingSummaryUsed: coreResult.rollingSummaryUsed,
      rollingSummaryUsedBootstrap: coreResult.rollingSummaryUsedBootstrap,
      rollingSummaryUsedDelta: coreResult.rollingSummaryUsedDelta,
      rollingSummaryCheckpointMessageIdUsed: coreResult.rollingSummaryCheckpointMessageIdUsed,
      rollingSummarySkipReason: coreResult.rollingSummarySkipReason,
    });
  } else if (coreResult) {
    logger.debug("chat_memory_core_interleave_skipped", {
      userId,
      presetId,
      reason: coreResult.reason,
      invalidReason: coreResult.invalidReason,
      pendingMessages: coreResult.pendingMessages,
      thresholdMessages: coreResult.thresholdMessages,
      processedBatches: coreResult.processedBatches,
      processedMessages: coreResult.processedMessages,
      targetMessageId: coreResult.targetMessageId,
      boundaryId: coreResult.boundaryId,
      strictSyncEnabled: coreResult.strictSyncEnabled,
      summarizedUntilMessageId: coreResult.summarizedUntilMessageId,
      rollingSummaryUsed: coreResult.rollingSummaryUsed,
      rollingSummaryUsedBootstrap: coreResult.rollingSummaryUsedBootstrap,
      rollingSummaryUsedDelta: coreResult.rollingSummaryUsedDelta,
      rollingSummaryCheckpointMessageIdUsed: coreResult.rollingSummaryCheckpointMessageIdUsed,
      rollingSummarySkipReason: coreResult.rollingSummarySkipReason,
    });
  }

  const nextProtectMessageId = normalizeMessageId(coreResult?.coveredUntilMessageId);
  return {
    coreResult,
    protectMessageId: nextProtectMessageId !== null && nextProtectMessageId > 0 ? nextProtectMessageId : protectMessageId,
  };
}

module.exports = {
  maybeInterleaveCoreMemoryUpdate,
};
