const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatMemoryConfig } = require("../../../../../config");
const { logger } = require("../../../../../logger");
const { generateRollingSummary } = require("../../rollingSummary");
const { computeRollingSummaryTarget } = require("../targets");
const {
  CHECKPOINT_KIND_ROLLING_SUMMARY,
  isCheckpointFeatureEnabled,
  writeCheckpointBestEffort,
  loadCheckpointBestEffort,
  loadLatestCheckpointBestEffort,
} = require("../checkpoints");
const {
  sleep,
  normalizeMessagesForSummary,
  normalizeMessageId,
  readCoreMemorySnapshot,
} = require("../utils");

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

  const memory = await chatPresetMemoryModel.ensureMemory(userId, presetId);
  if (!memory) return { updated: false, reason: "memory_missing", needsMemory: false, summarizedUntilMessageId: 0 };

  const target = await computeRollingSummaryTarget({ userId, presetId });
  const targetUntilMessageId = normalizeMessageId(target.targetUntilMessageId) || 0;
  const needsMemory = Boolean(target.hasOlderMessages);

  const coreSnapshotForCheckpointProtect = readCoreMemorySnapshot(memory.coreMemory);
  let protectMessageId = normalizeMessageId(coreSnapshotForCheckpointProtect.meta?.coveredUntilMessageId);

  if (!target.hasOlderMessages || targetUntilMessageId <= 0) {
    if (memory.rebuildRequired || memory.dirtySinceMessageId !== null) {
      await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
        rollingSummary: "",
        summarizedUntilMessageId: 0,
        rebuildRequired: false,
      });
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
  let lastRollingSummaryCheckpointId = null;
  let wroteRollingSummaryCheckpointMessageId = null;

  if (isCheckpointFeatureEnabled() && afterMessageId > 0) {
    const latest = await loadLatestCheckpointBestEffort({ userId, presetId, kind: CHECKPOINT_KIND_ROLLING_SUMMARY });
    const latestMessageId = normalizeMessageId(latest?.messageId);
    if (latestMessageId !== null && latestMessageId <= afterMessageId) {
      lastRollingSummaryCheckpointId = latestMessageId;
    }
  }

  if (
    isDirty &&
    isCheckpointFeatureEnabled() &&
    afterMessageId === 0 &&
    !rollingSummary &&
    normalizeMessageId(memory.dirtySinceMessageId) !== null
  ) {
    const rollbackMessageId = Math.max(0, Number(memory.dirtySinceMessageId) - 1);
    const maxCheckpointMessageId = Math.min(targetUntilMessageId, rollbackMessageId);

    const checkpoint = await loadCheckpointBestEffort({
      userId,
      presetId,
      kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
      maxMessageId: maxCheckpointMessageId,
    });

    const checkpointText =
      checkpoint && typeof checkpoint.payload?.text === "string" ? checkpoint.payload.text.trim() : "";
    const checkpointMessageId = normalizeMessageId(checkpoint?.messageId);

    if (checkpointMessageId !== null && checkpointMessageId > 0 && checkpointText) {
      afterMessageId = checkpointMessageId;
      rollingSummary = checkpointText;
      lastRollingSummaryCheckpointId = checkpointMessageId;

      try {
        await chatPresetMemoryModel.writeRollingSummaryProgress(userId, presetId, {
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
        messageId: checkpointMessageId,
        dirtySinceMessageId: memory.dirtySinceMessageId,
      });
    }
  }

  if (!isDirty && afterMessageId > targetUntilMessageId) {
    afterMessageId = 0;
    rollingSummary = "";
  }

  if (!force && !isDirty && afterMessageId < targetUntilMessageId) {
    const updateEveryNTurns = chatMemoryConfig.rollingSummaryUpdateEveryNTurns;
    const thresholdMessages = Math.max(1, Math.floor(updateEveryNTurns)) * 2;
    const probeLimit = thresholdMessages;

    const probeRows = await chatModel.listMessagesByPresetAfter(userId, presetId, {
      afterMessageId,
      limit: probeLimit,
    });

    let eligibleCount = 0;
    for (const row of probeRows) {
      const id = normalizeMessageId(row?.id);
      if (id === null) continue;
      if (id <= targetUntilMessageId) eligibleCount += 1;
    }

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

  const shouldInterleaveCoreMemory =
    Boolean(interleaveCoreMemory) &&
    Boolean(chatMemoryConfig.coreMemoryEnabled) &&
    typeof updateCoreMemoryOnce === "function";

  async function maybeInterleaveCoreMemoryUpdate() {
    if (!shouldInterleaveCoreMemory) return null;
    if (!needsMemory) return null;
    if (afterMessageId <= 0) return null;
    if (!rollingSummary) return null;

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
      return null;
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
    if (nextProtectMessageId !== null && nextProtectMessageId > 0) {
      protectMessageId = nextProtectMessageId;
    }

    return coreResult;
  }

  async function generateWithRetry(args) {
    let attempt = 0;
    while (true) {
      if (deadline && Date.now() > deadline) {
        const error = new Error("Memory rebuild timeout");
        error.code = "CHAT_MEMORY_REBUILD_TIMEOUT";
        throw error;
      }

      try {
        return await runWithWorkerSlot(() => generateRollingSummary(args));
      } catch (error) {
        if (!Number.isFinite(retryMax) || retryMax <= 0 || attempt >= retryMax) throw error;
        attempt += 1;
        const backoffMs = Math.min(8000, 400 * 2 ** attempt);
        await sleep(backoffMs);
      }
    }
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
      await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
        rebuildRequired: isDirty ? keepRebuildLock : false,
      });
      updated = true;
      break;
    }

    const batchEndId = Number(withinTarget[withinTarget.length - 1].id) || afterMessageId;
    const normalizedMessages = normalizeMessagesForSummary(withinTarget);

    const nextSummary = await generateWithRetry({
      providerId,
      modelId,
      previousSummary: rollingSummary,
      newMessages: normalizedMessages,
      maxChars,
      timeoutMs: chatMemoryConfig.syncRebuildTimeoutMs,
      settings: workerSettings,
      raw: workerRaw,
    });

    processedBatches += 1;
    processedMessages += normalizedMessages.length;
    afterMessageId = batchEndId;
    rollingSummary = nextSummary;

    if (isDirty) {
      if (dirtySinceMessageId !== null && afterMessageId + 1 > dirtySinceMessageId) {
        dirtySinceMessageId = afterMessageId + 1;
      }
      await chatPresetMemoryModel.writeRollingSummaryProgress(userId, presetId, {
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
        dirtySinceMessageId,
      });
    } else {
      await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
        rebuildRequired: false,
      });
    }

    if (isCheckpointFeatureEnabled() && rollingSummary) {
      const shouldWriteCheckpoint =
        shouldInterleaveCoreMemory ||
        lastRollingSummaryCheckpointId === null ||
        afterMessageId - lastRollingSummaryCheckpointId >= checkpointEveryNMessages;

      if (shouldWriteCheckpoint) {
        const wrote = await writeCheckpointBestEffort({
          userId,
          presetId,
          kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
          messageId: afterMessageId,
          payload: { text: rollingSummary },
          protectMessageId,
          reason: "interval",
        });
        if (wrote) {
          lastRollingSummaryCheckpointId = afterMessageId;
          wroteRollingSummaryCheckpointMessageId = afterMessageId;
        }
      }
    }

    await maybeInterleaveCoreMemoryUpdate();

    updated = true;

    if (afterMessageId >= targetUntilMessageId) break;
    if (withinTarget.length < rows.length) break;
    if (rows.length < batchSize) break;
    await sleep(chatMemoryConfig.backfillCooldownMs);
  }

  if (isDirty) {
    await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
      rollingSummary,
      summarizedUntilMessageId: afterMessageId,
      rebuildRequired: keepRebuildLock,
    });
    updated = true;

    if (isCheckpointFeatureEnabled() && rollingSummary) {
      const shouldWriteCheckpoint =
        shouldInterleaveCoreMemory ||
        lastRollingSummaryCheckpointId === null ||
        afterMessageId - lastRollingSummaryCheckpointId >= checkpointEveryNMessages;
      if (shouldWriteCheckpoint) {
        const wrote = await writeCheckpointBestEffort({
          userId,
          presetId,
          kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
          messageId: afterMessageId,
          payload: { text: rollingSummary },
          protectMessageId,
          reason: "interval",
        });
        if (wrote) {
          lastRollingSummaryCheckpointId = afterMessageId;
          wroteRollingSummaryCheckpointMessageId = afterMessageId;
        }
      }
    }
  }

  if (isCheckpointFeatureEnabled() && rollingSummary && afterMessageId > 0) {
    const hasFinalAlignedCheckpoint = lastRollingSummaryCheckpointId !== null && lastRollingSummaryCheckpointId === afterMessageId;
    if (wroteRollingSummaryCheckpointMessageId !== afterMessageId && (updated || !hasFinalAlignedCheckpoint)) {
      const wrote = await writeCheckpointBestEffort({
        userId,
        presetId,
        kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
        messageId: afterMessageId,
        payload: { text: rollingSummary },
        protectMessageId,
        reason: "tick_end",
      });
      if (wrote) {
        lastRollingSummaryCheckpointId = afterMessageId;
        wroteRollingSummaryCheckpointMessageId = afterMessageId;
      }
    }
  }

  return { updated, processedBatches, processedMessages, targetUntilMessageId, needsMemory, summarizedUntilMessageId: afterMessageId };
}

module.exports = {
  catchUpRollingSummaryOnce,
};
