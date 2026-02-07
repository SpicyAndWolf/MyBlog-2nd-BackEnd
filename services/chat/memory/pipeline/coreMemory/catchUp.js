const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatMemoryConfig } = require("../../../../../config");
const { logger } = require("../../../../../logger");
const { clipText } = require("../../textUtils");
const { computeRollingSummaryTarget, computeCoreMemoryTarget } = require("../targets");
const { CHECKPOINT_KIND_CORE_MEMORY } = require("../checkpoints");
const {
  sleep,
  normalizeMessagesForSummary,
  normalizeMessageId,
  readCoreMemorySnapshot,
} = require("../utils");
const {
  computeThresholdMessages,
  buildRollingSummaryUsageState,
  attachSummaryUsage: attachSummaryUsagePolicy,
  countEligibleMessages,
} = require("./policy");
const { writeCoreMemoryProgress } = require("./storage");
const { generateCoreMemoryWithRetry } = require("./generation");
const {
  resolveLastCoreCheckpointId,
  restoreCoreMemoryFromCheckpoint,
  maybeWriteCoreMemoryCheckpoint,
} = require("./checkpointOps");
const {
  determineStrictSyncBlockReason,
  recordAlignedCheckpoint,
  recordMissingAlignedCheckpoint,
  readStrictSyncCounters,
  loadAlignedRollingSummaryCheckpointText,
} = require("./strictSync");

async function catchUpCoreMemoryOnce({
  userId,
  presetId,
  needsMemory,
  targetMessageId,
  boundaryId,
  deadline,
  force = false,
  allowDuringRollingSummaryRebuild = false,
  runWithWorkerSlot,
} = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return { updated: false, reason: "missing_identifier" };
  if (!needsMemory) return { updated: false, reason: "needs_memory_false" };
  if (!chatMemoryConfig.coreMemoryEnabled) return { updated: false, reason: "disabled" };
  if (typeof runWithWorkerSlot !== "function") {
    const error = new Error("runWithWorkerSlot is required");
    error.code = "CHAT_MEMORY_WORKER_SLOT_MISSING";
    throw error;
  }

  const providerId = chatMemoryConfig.workerProviderId;
  const modelId = chatMemoryConfig.workerModelId;
  const maxChars = chatMemoryConfig.coreMemoryMaxChars;
  const workerSettings = chatMemoryConfig.coreMemoryWorkerSettings;
  const workerRaw = chatMemoryConfig.workerRaw;
  const retryMax = chatMemoryConfig.writeRetryMax;
  const deltaMessageLimit = chatMemoryConfig.coreMemoryDeltaBatchMessages;

  const thresholdMessages = computeThresholdMessages(chatMemoryConfig.coreMemoryUpdateEveryNTurns);
  const probeLimit = thresholdMessages;

  const memory = await chatPresetMemoryModel.ensureMemory(normalizedUserId, normalizedPresetId);
  if (!memory) return { updated: false, reason: "memory_missing" };

  const strictSyncEnabled = Boolean(chatMemoryConfig.coreMemoryStrictSyncWithRsCheckpointEnabled);

  const coreMemorySnapshot = readCoreMemorySnapshot(memory.coreMemory);
  let coreMemoryText = clipText(String(coreMemorySnapshot.text || "").trim(), maxChars).trim();
  let coreMeta = coreMemorySnapshot.meta;

  let coveredUntilMessageId = normalizeMessageId(coreMeta?.coveredUntilMessageId) || 0;
  let needsRebuild = Boolean(coreMeta?.needsRebuild);
  const coreDirtySinceMessageId = normalizeMessageId(coreMeta?.dirtySinceMessageId);
  let rebuildStateDirty = false;

  const summarizedUntilMessageId = normalizeMessageId(memory.summarizedUntilMessageId) || 0;
  const rollingSummaryDirtySinceMessageId = normalizeMessageId(memory.dirtySinceMessageId);
  const rollingSummaryProgressClean =
    rollingSummaryDirtySinceMessageId !== null &&
    summarizedUntilMessageId > 0 &&
    rollingSummaryDirtySinceMessageId > summarizedUntilMessageId;

  let resolvedBoundaryId = normalizeMessageId(boundaryId);
  if (strictSyncEnabled && resolvedBoundaryId === null) {
    const rollingTarget = await computeRollingSummaryTarget({ userId: normalizedUserId, presetId: normalizedPresetId });
    resolvedBoundaryId = normalizeMessageId(rollingTarget.targetUntilMessageId) || 0;
  }

  let resolvedTargetMessageId = null;
  if (strictSyncEnabled) {
    resolvedTargetMessageId = Math.min(resolvedBoundaryId || 0, summarizedUntilMessageId);
  } else {
    resolvedTargetMessageId = normalizeMessageId(targetMessageId);
    if (resolvedTargetMessageId === null) {
      const target = await computeCoreMemoryTarget({ userId: normalizedUserId, presetId: normalizedPresetId });
      resolvedTargetMessageId = normalizeMessageId(target.targetMessageId) || 0;
    }
  }

  if (!needsRebuild && coveredUntilMessageId > resolvedTargetMessageId) {
    needsRebuild = true;
    coveredUntilMessageId = 0;
    coreMemoryText = "";
    rebuildStateDirty = true;
  }

  const rollingSummaryRaw = clipText(
    String(memory.rollingSummary || "").trim(),
    chatMemoryConfig.rollingSummaryMaxChars
  ).trim();
  const allowPartialRollingSummary = Boolean(allowDuringRollingSummaryRebuild) && rollingSummaryProgressClean;
  const rollingSummaryUsageState = buildRollingSummaryUsageState({
    memory,
    allowPartialRollingSummary,
    summarizedUntilMessageId,
    rollingSummaryRaw,
    resolvedTargetMessageId,
    strictSyncEnabled,
  });
  const summaryUsable = rollingSummaryUsageState.summaryUsable;
  const summarySafe = rollingSummaryUsageState.summarySafe;
  let rollingSummarySkipReason = rollingSummaryUsageState.rollingSummarySkipReason;

  let rollingSummaryUsedBootstrap = false;
  let rollingSummaryUsedDelta = false;
  let rollingSummaryCheckpointMessageIdUsed = null;

  function attachSummaryUsage(result) {
    return attachSummaryUsagePolicy(result, {
      resolvedBoundaryId,
      strictSyncEnabled,
      summarizedUntilMessageId,
      summaryUsable,
      summarySafe,
      rollingSummaryUsedBootstrap,
      rollingSummaryUsedDelta,
      rollingSummaryCheckpointMessageIdUsed,
      rollingSummarySkipReason,
    });
  }

  async function writeProgress(nextCoreMemoryText, nextCoveredUntilMessageId, { nextNeedsRebuild } = {}) {
    coreMeta = await writeCoreMemoryProgress({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      coreMemoryText: nextCoreMemoryText,
      coveredUntilMessageId: nextCoveredUntilMessageId,
      nextNeedsRebuild,
      coreMeta,
    });
  }

  const startedAt = Date.now();
  let updated = false;
  let processedBatches = 0;
  let processedMessages = 0;
  let usedFallback = false;
  const checkpointEveryNMessages = Number(chatMemoryConfig.checkpointEveryNMessages);
  let lastCoreCheckpointId = await resolveLastCoreCheckpointId({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    coveredUntilMessageId,
  });

  const restored = await restoreCoreMemoryFromCheckpoint({
    userId: normalizedUserId,
    presetId: normalizedPresetId,
    maxChars,
    needsRebuild,
    coreMemoryText,
    coveredUntilMessageId,
    coreDirtySinceMessageId,
    resolvedTargetMessageId,
  });
  if (restored.restored) {
    coreMemoryText = restored.coreMemoryText;
    coveredUntilMessageId = restored.coveredUntilMessageId;
    needsRebuild = true;
    lastCoreCheckpointId = restored.checkpointMessageId;

    await writeProgress(coreMemoryText, coveredUntilMessageId, {
      nextNeedsRebuild: coveredUntilMessageId < resolvedTargetMessageId,
    });
    updated = true;

    logger.info("chat_memory_checkpoint_restored", {
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      kind: CHECKPOINT_KIND_CORE_MEMORY,
      messageId: restored.checkpointMessageId,
      dirtySinceMessageId: coreDirtySinceMessageId,
    });
  }

  if (strictSyncEnabled) {
    const strictSyncBlockReason = determineStrictSyncBlockReason({
      memory,
      allowDuringRollingSummaryRebuild,
      allowPartialRollingSummary,
      summarizedUntilMessageId,
      resolvedBoundaryId,
    });

    if (!strictSyncBlockReason && summarizedUntilMessageId <= 0 && (resolvedBoundaryId || 0) <= 0) {
      return attachSummaryUsage({
        updated,
        reason: "recent_window_only",
        thresholdMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    if (strictSyncBlockReason) {
      rollingSummarySkipReason = strictSyncBlockReason;
      const shouldPersistRebuildState =
        rebuildStateDirty || !needsRebuild || !Boolean(coreMeta?.needsRebuild);
      if (shouldPersistRebuildState) {
        needsRebuild = true;
        await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: true });
        updated = true;
        rebuildStateDirty = false;
      }

      return attachSummaryUsage({
        updated,
        reason: strictSyncBlockReason,
        thresholdMessages,
        coveredUntilMessageId,
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }
  }

  if (
    needsRebuild &&
    !coreMemoryText &&
    coveredUntilMessageId === 0 &&
    summarySafe
  ) {
    let bootstrap = null;
    let bootstrapRollingSummaryText = strictSyncEnabled ? rollingSummaryRaw : "";
    let bootstrapCheckpointId = null;
    if (strictSyncEnabled) {
      const aligned = await loadAlignedRollingSummaryCheckpointText({
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        expectedMessageId: summarizedUntilMessageId,
        rollingSummaryMaxChars: chatMemoryConfig.rollingSummaryMaxChars,
      });
      if (aligned.ok) {
        bootstrapRollingSummaryText = aligned.text;
        bootstrapCheckpointId = aligned.messageId;
      } else {
        bootstrapRollingSummaryText = "";
      }
    }

    if (bootstrapRollingSummaryText) {
      try {
        rollingSummaryUsedBootstrap = true;
        rollingSummaryCheckpointMessageIdUsed = bootstrapCheckpointId;
        if (strictSyncEnabled && bootstrapCheckpointId !== null) {
          coreMeta = recordAlignedCheckpoint(coreMeta, bootstrapCheckpointId);
        }
        bootstrap = await generateCoreMemoryWithRetry({
          runWithWorkerSlot,
          deadline,
          retryMax,
          args: {
            providerId,
            modelId,
            previousCoreMemoryText: "",
            rollingSummaryText: bootstrapRollingSummaryText,
            deltaMessages: [],
            maxChars,
            timeoutMs: chatMemoryConfig.syncRebuildTimeoutMs,
            settings: workerSettings,
            raw: workerRaw,
          },
        });
      } catch (error) {
        if (error?.code === "CHAT_MEMORY_REBUILD_TIMEOUT") {
          logger.warn("chat_memory_core_rebuild_timeout", {
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            providerId,
            modelId,
          });
          return attachSummaryUsage({
            updated,
            reason: "timeout",
            thresholdMessages,
            coveredUntilMessageId,
            processedBatches,
            processedMessages,
            targetMessageId: resolvedTargetMessageId,
          });
        }
        logger.error("chat_memory_core_generate_failed", {
          error,
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          providerId,
          modelId,
        });
      }
    }

    if (bootstrap && bootstrap.valid) {
      coreMemoryText = String(bootstrap.text || "").trim();
      coveredUntilMessageId = summarizedUntilMessageId;
      processedBatches += 1;

      await writeProgress(coreMemoryText, coveredUntilMessageId, {
        nextNeedsRebuild: coveredUntilMessageId < resolvedTargetMessageId,
      });
      updated = true;
      needsRebuild = coveredUntilMessageId < resolvedTargetMessageId;

      lastCoreCheckpointId = await maybeWriteCoreMemoryCheckpoint({
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        coreMemoryText,
        coveredUntilMessageId,
        lastCoreCheckpointId,
        checkpointEveryNMessages,
      });
    } else if (bootstrap && !bootstrap.valid) {
      logger.warn("chat_memory_core_invalid_output", {
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        providerId,
        modelId,
        reason: bootstrap?.reason,
      });
    }
  }

  if (coveredUntilMessageId >= resolvedTargetMessageId) {
    if (Boolean(coreMeta?.needsRebuild)) {
      await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: false });
      updated = true;
      return attachSummaryUsage({
        updated,
        reason: "caught_up",
        durationMs: Date.now() - startedAt,
        coreMemoryChars: coreMemoryText.length,
        coveredUntilMessageId,
        usedFallback,
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    if (updated) {
      return attachSummaryUsage({
        updated,
        reason: "caught_up",
        durationMs: Date.now() - startedAt,
        coreMemoryChars: coreMemoryText.length,
        coveredUntilMessageId,
        usedFallback,
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    return attachSummaryUsage({
      updated,
      reason: "no_new_messages",
      thresholdMessages,
      targetMessageId: resolvedTargetMessageId,
    });
  }

  if (!force && !needsRebuild) {
    const probeRows = await chatModel.listMessagesByPresetAfter(normalizedUserId, normalizedPresetId, {
      afterMessageId: coveredUntilMessageId,
      limit: probeLimit,
    });

    if (!probeRows.length) {
      return attachSummaryUsage({
        updated: false,
        reason: "no_new_messages",
        thresholdMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    const eligibleCount = countEligibleMessages(probeRows, resolvedTargetMessageId, normalizeMessageId);

    if (eligibleCount < probeLimit) {
      return attachSummaryUsage({
        updated: false,
        reason: "throttled",
        pendingMessages: eligibleCount,
        thresholdMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }
  }

  while (coveredUntilMessageId < resolvedTargetMessageId) {
    if (deadline && Date.now() > deadline) {
      return attachSummaryUsage({
        updated,
        reason: "timeout",
        thresholdMessages,
        coveredUntilMessageId,
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    let rollingSummaryText = "";
    let rollingSummaryCheckpointIdForBatch = null;
    if (strictSyncEnabled) {
      const aligned = await loadAlignedRollingSummaryCheckpointText({
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        expectedMessageId: coveredUntilMessageId,
        rollingSummaryMaxChars: chatMemoryConfig.rollingSummaryMaxChars,
      });
      if (!aligned.ok) {
        coreMeta = recordMissingAlignedCheckpoint(coreMeta, coveredUntilMessageId);
        rollingSummarySkipReason = aligned.reason;
        needsRebuild = true;
        await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: true });
        updated = true;

        const strictCounters = readStrictSyncCounters(coreMeta);
        logger.warn("chat_memory_core_missing_aligned_checkpoint", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          reason: aligned.reason,
          coveredUntilMessageId,
          foundCheckpointMessageId: aligned.foundMessageId,
          boundaryId: resolvedBoundaryId,
          summarizedUntilMessageId,
          targetMessageId: resolvedTargetMessageId,
          missingAlignedCheckpointTotal: strictCounters.missingAlignedCheckpointTotal,
          missingAlignedCheckpointConsecutive: strictCounters.missingAlignedCheckpointConsecutive,
        });

        return attachSummaryUsage({
          updated,
          reason: aligned.reason,
          thresholdMessages,
          coveredUntilMessageId,
          processedBatches,
          processedMessages,
          targetMessageId: resolvedTargetMessageId,
        });
      }

      rollingSummaryText = aligned.text;
      rollingSummaryCheckpointIdForBatch = aligned.messageId;
      rollingSummaryCheckpointMessageIdUsed = aligned.messageId;
      rollingSummaryUsedDelta = true;
      logger.debug("chat_memory_core_checkpoint_used", {
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        messageId: coveredUntilMessageId,
      });
    }

    const rows = await chatModel.listMessagesByPresetAfter(normalizedUserId, normalizedPresetId, {
      afterMessageId: coveredUntilMessageId,
      limit: deltaMessageLimit,
    });

    if (!rows.length) {
      return attachSummaryUsage({
        updated,
        reason: "no_new_messages",
        thresholdMessages,
        coveredUntilMessageId,
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    const withinTarget = rows.filter((row) => {
      const id = normalizeMessageId(row?.id);
      return id !== null && id <= resolvedTargetMessageId;
    });

    if (!withinTarget.length) {
      coveredUntilMessageId = resolvedTargetMessageId;
      await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: false });
      updated = true;
      break;
    }

    const lastMessageId = normalizeMessageId(withinTarget[withinTarget.length - 1]?.id);
    const nextCoveredUntilMessageId = lastMessageId !== null ? lastMessageId : coveredUntilMessageId;
    if (nextCoveredUntilMessageId <= coveredUntilMessageId) {
      return attachSummaryUsage({
        updated,
        reason: "no_progress",
        thresholdMessages,
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    const deltaMessages = normalizeMessagesForSummary(withinTarget);

    if (!deltaMessages.length) {
      coveredUntilMessageId = nextCoveredUntilMessageId;
      await writeProgress(coreMemoryText, coveredUntilMessageId, {
        nextNeedsRebuild: coveredUntilMessageId < resolvedTargetMessageId,
      });
      updated = true;
      continue;
    }

    let generation = null;
    try {
      generation = await generateCoreMemoryWithRetry({
        runWithWorkerSlot,
        deadline,
        retryMax,
        args: {
          providerId,
          modelId,
          previousCoreMemoryText: coreMemoryText,
          rollingSummaryText,
          deltaMessages,
          maxChars,
          timeoutMs: chatMemoryConfig.syncRebuildTimeoutMs,
          settings: workerSettings,
          raw: workerRaw,
        },
      });
    } catch (error) {
      if (error?.code === "CHAT_MEMORY_REBUILD_TIMEOUT") {
        logger.warn("chat_memory_core_rebuild_timeout", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          providerId,
          modelId,
        });
        return attachSummaryUsage({
          updated,
          reason: "timeout",
          thresholdMessages,
          coveredUntilMessageId,
          processedBatches,
          processedMessages,
          targetMessageId: resolvedTargetMessageId,
        });
      }
      logger.error("chat_memory_core_generate_failed", {
        error,
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        providerId,
        modelId,
      });
      return attachSummaryUsage({
        updated,
        reason: "generate_failed",
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    if (!generation?.valid) {
      logger.warn("chat_memory_core_invalid_output", {
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        providerId,
        modelId,
        reason: generation?.reason,
      });
      return attachSummaryUsage({
        updated,
        reason: "invalid_output",
        invalidReason: generation?.reason,
        thresholdMessages,
        processedBatches,
        processedMessages,
        targetMessageId: resolvedTargetMessageId,
      });
    }

    processedBatches += 1;
    processedMessages += deltaMessages.length;

    let nextText = String(generation.text || "").trim();
    const batchUsedFallback = !nextText && Boolean(coreMemoryText);
    if (batchUsedFallback) {
      usedFallback = true;
      nextText = coreMemoryText;
    }

    coreMemoryText = nextText;
    coveredUntilMessageId = nextCoveredUntilMessageId;

    if (strictSyncEnabled) {
      coreMeta = recordAlignedCheckpoint(coreMeta, rollingSummaryCheckpointIdForBatch);
    }

    await writeProgress(coreMemoryText, coveredUntilMessageId, {
      nextNeedsRebuild: coveredUntilMessageId < resolvedTargetMessageId,
    });
    updated = true;

    lastCoreCheckpointId = await maybeWriteCoreMemoryCheckpoint({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      coreMemoryText,
      coveredUntilMessageId,
      lastCoreCheckpointId,
      checkpointEveryNMessages,
    });

    if (coveredUntilMessageId >= resolvedTargetMessageId) break;
    if (withinTarget.length < rows.length) break;
    if (rows.length < deltaMessageLimit) break;
    await sleep(chatMemoryConfig.backfillCooldownMs);
  }

  return attachSummaryUsage({
    updated,
    reason: coveredUntilMessageId >= resolvedTargetMessageId ? "caught_up" : "partial",
    durationMs: Date.now() - startedAt,
    coreMemoryChars: coreMemoryText.length,
    coveredUntilMessageId,
    usedFallback,
    processedBatches,
    processedMessages,
    thresholdMessages,
    targetMessageId: resolvedTargetMessageId,
  });
}

module.exports = {
  catchUpCoreMemoryOnce,
};
