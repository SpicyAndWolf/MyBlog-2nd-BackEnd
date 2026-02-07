const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatMemoryConfig } = require("../../../../../config");
const { logger } = require("../../../../../logger");
const { computeRollingSummaryTarget } = require("../targets");
const {
  sleep,
  normalizeMessageId,
  readCoreMemorySnapshot,
  normalizeMessagesForSummary,
} = require("../utils");
const {
  computeThresholdMessages,
  countEligibleMessages,
  shouldInterleaveCoreMemory,
} = require("./policy");
const { generateRollingSummaryWithRetry } = require("./generation");
const {
  clearRollingSummaryForRecentWindowOnly,
  writeRollingSummaryProgress,
  writeRollingSummarySnapshotProgress,
  writeRollingSummaryWithRebuildLock,
} = require("./storage");
const {
  CHECKPOINT_KIND_ROLLING_SUMMARY,
  resolveLastRollingSummaryCheckpointId,
  restoreRollingSummaryFromCheckpoint,
  writeRollingSummaryCheckpointIfNeeded,
  writeFinalRollingSummaryCheckpointIfNeeded,
} = require("./checkpointRestore");
const { maybeInterleaveCoreMemoryUpdate } = require("./interleaveCore");

async function catchUpRollingSummaryOnce({
  userId,
  presetId,
  deadline,
  force = false,
  keepRebuildLock = false,
  interleaveCoreMemory = false,
  runWithWorkerSlot,
  updateCoreMemoryOnce,
} = {}) {
  const providerId = chatMemoryConfig.workerProviderId;
  const modelId = chatMemoryConfig.workerModelId;
  const maxChars = chatMemoryConfig.rollingSummaryMaxChars;
  const workerSettings = chatMemoryConfig.rollingSummaryWorkerSettings;
  const workerRaw = chatMemoryConfig.workerRaw;
  const batchSize = chatMemoryConfig.backfillBatchMessages;
  const retryMax = chatMemoryConfig.writeRetryMax;
  if (typeof runWithWorkerSlot !== "function") {
    const error = new Error("runWithWorkerSlot is required");
    error.code = "CHAT_MEMORY_WORKER_SLOT_MISSING";
    throw error;
  }
  if (
    interleaveCoreMemory &&
    chatMemoryConfig.coreMemoryEnabled &&
    typeof updateCoreMemoryOnce !== "function"
  ) {
    logger.error("chat_memory_core_interleave_dependency_missing", {
      userId,
      presetId,
      interleaveCoreMemory: true,
      coreMemoryEnabled: true,
    });
    const error = new Error("updateCoreMemoryOnce is required when interleaveCoreMemory=true");
    error.code = "CHAT_MEMORY_INTERLEAVE_CALLBACK_MISSING";
    throw error;
  }

  const memory = await chatPresetMemoryModel.ensureMemory(userId, presetId);
  if (!memory) return { updated: false, reason: "memory_missing", needsMemory: false, summarizedUntilMessageId: 0 };

  const target = await computeRollingSummaryTarget({ userId, presetId });
  const targetUntilMessageId = normalizeMessageId(target.targetUntilMessageId) || 0;
  const needsMemory = Boolean(target.hasOlderMessages);

  const coreSnapshotForCheckpointProtect = readCoreMemorySnapshot(memory.coreMemory);
  let protectMessageId = normalizeMessageId(coreSnapshotForCheckpointProtect.meta?.coveredUntilMessageId);

  if (!target.hasOlderMessages || targetUntilMessageId <= 0) {
    if (memory.rebuildRequired || memory.dirtySinceMessageId !== null) {
      await clearRollingSummaryForRecentWindowOnly({ userId, presetId });
      return { updated: true, reason: "recent_window_only", targetUntilMessageId, needsMemory, summarizedUntilMessageId: 0 };
    }
    return { updated: false, reason: "recent_window_only", targetUntilMessageId, needsMemory, summarizedUntilMessageId: 0 };
  }

  const isDirty = memory.dirtySinceMessageId !== null;
  let dirtySinceMessageId = isDirty ? normalizeMessageId(memory.dirtySinceMessageId) : null;
  if (isDirty && dirtySinceMessageId === null) dirtySinceMessageId = 0;
  let afterMessageId = Number(memory.summarizedUntilMessageId) || 0;
  let rollingSummary = String(memory.rollingSummary || "").trim();
  if (afterMessageId <= 0) {
    afterMessageId = 0;
    rollingSummary = "";
  }

  const checkpointEveryNMessages = Number(chatMemoryConfig.checkpointEveryNMessages);
  let lastRollingSummaryCheckpointId = await resolveLastRollingSummaryCheckpointId({
    userId,
    presetId,
    afterMessageId,
  });
  let wroteRollingSummaryCheckpointMessageId = null;

  const restored = await restoreRollingSummaryFromCheckpoint({
    userId,
    presetId,
    isDirty,
    afterMessageId,
    rollingSummary,
    dirtySinceMessageId: memory.dirtySinceMessageId,
    targetUntilMessageId,
  });
  if (restored.restored) {
    afterMessageId = restored.afterMessageId;
    rollingSummary = restored.rollingSummary;
    lastRollingSummaryCheckpointId = restored.checkpointMessageId;

    try {
      await writeRollingSummarySnapshotProgress({
        userId,
        presetId,
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
      });
    } catch (error) {
      if (error?.code !== "42P01") throw error;
    }

    logger.info("chat_memory_checkpoint_restored", {
      userId,
      presetId,
      kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
      messageId: restored.checkpointMessageId,
      dirtySinceMessageId: memory.dirtySinceMessageId,
    });
  }

  if (!isDirty && afterMessageId > targetUntilMessageId) {
    afterMessageId = 0;
    rollingSummary = "";
  }

  if (!force && !isDirty && afterMessageId < targetUntilMessageId) {
    const thresholdMessages = computeThresholdMessages(chatMemoryConfig.rollingSummaryUpdateEveryNTurns);
    const probeLimit = thresholdMessages;

    const probeRows = await chatModel.listMessagesByPresetAfter(userId, presetId, {
      afterMessageId,
      limit: probeLimit,
    });

    const eligibleCount = countEligibleMessages(probeRows, targetUntilMessageId, normalizeMessageId);

    if (eligibleCount < probeLimit) {
      return {
        updated: false,
        reason: "throttled",
        targetUntilMessageId,
        pendingMessages: eligibleCount,
        thresholdMessages,
        needsMemory,
        summarizedUntilMessageId: afterMessageId,
      };
    }
  }

  let updated = false;
  let processedBatches = 0;
  let processedMessages = 0;

  const shouldInterleaveCoreMemoryEnabled = shouldInterleaveCoreMemory({
    interleaveCoreMemory,
    coreMemoryEnabled: chatMemoryConfig.coreMemoryEnabled,
    updateCoreMemoryOnce,
  });

  async function runInterleaveCoreMemoryUpdate() {
    const interleaveResult = await maybeInterleaveCoreMemoryUpdate({
      shouldInterleaveCoreMemory: shouldInterleaveCoreMemoryEnabled,
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
    });
    protectMessageId = interleaveResult.protectMessageId;
    return interleaveResult.coreResult;
  }

  while (afterMessageId < targetUntilMessageId) {
    if (deadline && Date.now() > deadline) {
      const error = new Error("Memory rebuild timeout");
      error.code = "CHAT_MEMORY_REBUILD_TIMEOUT";
      throw error;
    }

    const rows = await chatModel.listMessagesByPresetAfter(userId, presetId, {
      afterMessageId,
      limit: batchSize,
    });

    if (!rows.length) break;

    const withinTarget = rows.filter((row) => {
      const id = normalizeMessageId(row?.id);
      return id !== null && id <= targetUntilMessageId;
    });

    if (!withinTarget.length) {
      afterMessageId = targetUntilMessageId;
      await writeRollingSummaryWithRebuildLock({
        userId,
        presetId,
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
        rebuildRequired: isDirty ? keepRebuildLock : false,
      });
      updated = true;
      break;
    }

    const batchEndId = Number(withinTarget[withinTarget.length - 1].id) || afterMessageId;
    const normalizedMessages = normalizeMessagesForSummary(withinTarget);

    const nextSummary = await generateRollingSummaryWithRetry({
      runWithWorkerSlot,
      deadline,
      retryMax,
      args: {
        providerId,
        modelId,
        previousSummary: rollingSummary,
        newMessages: normalizedMessages,
        maxChars,
        timeoutMs: chatMemoryConfig.syncRebuildTimeoutMs,
        settings: workerSettings,
        raw: workerRaw,
      },
    });

    processedBatches += 1;
    processedMessages += normalizedMessages.length;
    afterMessageId = batchEndId;
    rollingSummary = nextSummary;

    if (isDirty) {
      if (dirtySinceMessageId !== null && afterMessageId + 1 > dirtySinceMessageId) {
        dirtySinceMessageId = afterMessageId + 1;
      }
      await writeRollingSummaryProgress({
        userId,
        presetId,
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
        isDirty: true,
        dirtySinceMessageId,
      });
    } else {
      await writeRollingSummaryProgress({
        userId,
        presetId,
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
      });
    }

    const checkpointWrite = await writeRollingSummaryCheckpointIfNeeded({
      userId,
      presetId,
      afterMessageId,
      rollingSummary,
      protectMessageId,
      shouldInterleaveCoreMemoryEnabled,
      lastRollingSummaryCheckpointId,
      checkpointEveryNMessages,
      reason: "interval",
    });
    lastRollingSummaryCheckpointId = checkpointWrite.lastRollingSummaryCheckpointId;
    if (checkpointWrite.wroteRollingSummaryCheckpointMessageId !== null) {
      wroteRollingSummaryCheckpointMessageId = checkpointWrite.wroteRollingSummaryCheckpointMessageId;
    }

    await runInterleaveCoreMemoryUpdate();

    updated = true;

    if (afterMessageId >= targetUntilMessageId) break;
    if (withinTarget.length < rows.length) break;
    if (rows.length < batchSize) break;
    await sleep(chatMemoryConfig.backfillCooldownMs);
  }

  if (isDirty) {
    await writeRollingSummaryWithRebuildLock({
      userId,
      presetId,
      rollingSummary,
      summarizedUntilMessageId: afterMessageId,
      rebuildRequired: keepRebuildLock,
    });
    updated = true;

    const checkpointWrite = await writeRollingSummaryCheckpointIfNeeded({
      userId,
      presetId,
      afterMessageId,
      rollingSummary,
      protectMessageId,
      shouldInterleaveCoreMemoryEnabled,
      lastRollingSummaryCheckpointId,
      checkpointEveryNMessages,
      reason: "interval",
    });
    lastRollingSummaryCheckpointId = checkpointWrite.lastRollingSummaryCheckpointId;
    if (checkpointWrite.wroteRollingSummaryCheckpointMessageId !== null) {
      wroteRollingSummaryCheckpointMessageId = checkpointWrite.wroteRollingSummaryCheckpointMessageId;
    }
  }

  const finalCheckpoint = await writeFinalRollingSummaryCheckpointIfNeeded({
    userId,
    presetId,
    afterMessageId,
    rollingSummary,
    protectMessageId,
    updated,
    lastRollingSummaryCheckpointId,
    wroteRollingSummaryCheckpointMessageId,
  });
  lastRollingSummaryCheckpointId = finalCheckpoint.lastRollingSummaryCheckpointId;
  wroteRollingSummaryCheckpointMessageId = finalCheckpoint.wroteRollingSummaryCheckpointMessageId;

  return { updated, processedBatches, processedMessages, targetUntilMessageId, needsMemory, summarizedUntilMessageId: afterMessageId };
}

module.exports = {
  catchUpRollingSummaryOnce,
};
