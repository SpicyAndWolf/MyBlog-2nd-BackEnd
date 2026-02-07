const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatMemoryConfig } = require("../../../../../config");
const { logger } = require("../../../../../logger");
const { generateCoreMemory } = require("../../coreMemory");
const { clipText } = require("../../textUtils");
const { computeRollingSummaryTarget, computeCoreMemoryTarget } = require("../targets");
const {
  CHECKPOINT_KIND_CORE_MEMORY,
  CHECKPOINT_KIND_ROLLING_SUMMARY,
  CHECKPOINT_REASONS,
  isCheckpointFeatureEnabled,
  writeCheckpointBestEffort,
  loadCheckpointBestEffort,
  loadLatestCheckpointBestEffort,
  readAlignedCheckpoint,
} = require("../checkpoints");
const {
  sleep,
  isPlainObject,
  normalizeMessagesForSummary,
  normalizeMessageId,
  readCoreMemorySnapshot,
} = require("../utils");

const CORE_MEMORY_TEMPLATE_ID = "core-memory-v1";

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

  const updateEveryNTurns = chatMemoryConfig.coreMemoryUpdateEveryNTurns;
  const thresholdMessages = Math.max(1, Math.floor(updateEveryNTurns)) * 2;
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
  }

  const rollingSummaryRaw = clipText(
    String(memory.rollingSummary || "").trim(),
    chatMemoryConfig.rollingSummaryMaxChars
  ).trim();
  const allowPartialRollingSummary = Boolean(allowDuringRollingSummaryRebuild) && rollingSummaryProgressClean;
  const summaryUsable =
    (memory.dirtySinceMessageId === null || allowPartialRollingSummary) &&
    summarizedUntilMessageId > 0 &&
    Boolean(rollingSummaryRaw);
  const summarySafe = summaryUsable && summarizedUntilMessageId <= resolvedTargetMessageId;

  let rollingSummarySkipReason = null;
  if (!summaryUsable) {
    if (memory.dirtySinceMessageId !== null) rollingSummarySkipReason = "memory_dirty";
    else if (summarizedUntilMessageId <= 0) rollingSummarySkipReason = "missing_progress";
    else if (!rollingSummaryRaw) rollingSummarySkipReason = "missing_text";
    else rollingSummarySkipReason = "unusable";
  } else if (!summarySafe) {
    rollingSummarySkipReason = "summary_beyond_target";
  }

  if (!strictSyncEnabled && !rollingSummarySkipReason) {
    rollingSummarySkipReason = "strict_sync_disabled";
  }

  let rollingSummaryUsedBootstrap = false;
  let rollingSummaryUsedDelta = false;
  let rollingSummaryCheckpointMessageIdUsed = null;

  function attachSummaryUsage(result) {
    const rollingSummaryUsed = rollingSummaryUsedBootstrap || rollingSummaryUsedDelta;
    return {
      ...result,
      boundaryId: resolvedBoundaryId,
      strictSyncEnabled,
      summarizedUntilMessageId,
      rollingSummaryUsable: summaryUsable,
      rollingSummarySafe: summarySafe,
      rollingSummaryUsed,
      rollingSummaryUsedBootstrap,
      rollingSummaryUsedDelta,
      rollingSummaryCheckpointMessageIdUsed,
      rollingSummarySkipReason: rollingSummaryUsed ? null : rollingSummarySkipReason,
    };
  }

  function buildNextMeta(nextCoveredUntilMessageId, { nextNeedsRebuild } = {}) {
    const nextMeta = {
      ...(isPlainObject(coreMeta) ? coreMeta : {}),
      templateId: CORE_MEMORY_TEMPLATE_ID,
      coveredUntilMessageId: nextCoveredUntilMessageId,
      needsRebuild: Boolean(nextNeedsRebuild),
    };

    if (nextMeta.needsRebuild) {
      const dirtySince = normalizeMessageId(nextMeta.dirtySinceMessageId);
      if (dirtySince !== null && nextCoveredUntilMessageId + 1 > dirtySince) {
        nextMeta.dirtySinceMessageId = nextCoveredUntilMessageId + 1;
      }
    }

    if (!nextMeta.needsRebuild && "dirtySinceMessageId" in nextMeta) {
      delete nextMeta.dirtySinceMessageId;
    }

    return nextMeta;
  }

  async function writeProgress(nextCoreMemoryText, nextCoveredUntilMessageId, { nextNeedsRebuild } = {}) {
    const nextMeta = buildNextMeta(nextCoveredUntilMessageId, { nextNeedsRebuild });

    await chatPresetMemoryModel.writeCoreMemory(normalizedUserId, normalizedPresetId, {
      coreMemory: {
        text: nextCoreMemoryText,
        meta: nextMeta,
      },
    });

    coreMeta = nextMeta;
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
        return await runWithWorkerSlot(() => generateCoreMemory(args));
      } catch (error) {
        if (!Number.isFinite(retryMax) || retryMax <= 0 || attempt >= retryMax) throw error;
        attempt += 1;
        const backoffMs = Math.min(8000, 400 * 2 ** attempt);
        await sleep(backoffMs);
      }
    }
  }

  function readNonNegativeInt(value) {
    const number = Number(value);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return 0;
    return number;
  }

  function recordStrictSyncAlignedCheckpoint(expectedMessageId) {
    if (!strictSyncEnabled) return;
    const baseMeta = isPlainObject(coreMeta) ? coreMeta : {};
    const strictMeta = isPlainObject(baseMeta.strictSync) ? baseMeta.strictSync : {};
    coreMeta = {
      ...baseMeta,
      strictSync: {
        ...strictMeta,
        missingAlignedCheckpointTotal: readNonNegativeInt(strictMeta.missingAlignedCheckpointTotal),
        missingAlignedCheckpointConsecutive: 0,
        lastAlignedCheckpointMessageId: expectedMessageId,
      },
    };
  }

  function recordStrictSyncMissingAlignedCheckpoint(expectedMessageId) {
    if (!strictSyncEnabled) return;
    const baseMeta = isPlainObject(coreMeta) ? coreMeta : {};
    const strictMeta = isPlainObject(baseMeta.strictSync) ? baseMeta.strictSync : {};
    coreMeta = {
      ...baseMeta,
      strictSync: {
        ...strictMeta,
        missingAlignedCheckpointTotal: readNonNegativeInt(strictMeta.missingAlignedCheckpointTotal) + 1,
        missingAlignedCheckpointConsecutive: readNonNegativeInt(strictMeta.missingAlignedCheckpointConsecutive) + 1,
        lastMissingAlignedCheckpointMessageId: expectedMessageId,
      },
    };
  }

  async function loadAlignedRollingSummaryCheckpointText(expectedMessageId) {
    const aligned = await readAlignedCheckpoint({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
      expectedMessageId,
    });
    if (!aligned.ok) return aligned;

    const checkpointText = typeof aligned.payload?.text === "string" ? aligned.payload.text.trim() : "";
    const clipped = clipText(checkpointText, chatMemoryConfig.rollingSummaryMaxChars).trim();
    if (!clipped && aligned.messageId > 0) {
      return {
        ok: false,
        reason: CHECKPOINT_REASONS.MISSING_ALIGNED_CHECKPOINT,
        foundMessageId: aligned.messageId,
      };
    }

    return { ok: true, messageId: aligned.messageId, text: clipped };
  }

  const startedAt = Date.now();
  let updated = false;
  let processedBatches = 0;
  let processedMessages = 0;
  let usedFallback = false;
  const checkpointEveryNMessages = Number(chatMemoryConfig.checkpointEveryNMessages);
  let lastCoreCheckpointId = null;

  if (isCheckpointFeatureEnabled() && coveredUntilMessageId > 0) {
    const latest = await loadLatestCheckpointBestEffort({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      kind: CHECKPOINT_KIND_CORE_MEMORY,
    });
    const latestMessageId = normalizeMessageId(latest?.messageId);
    if (latestMessageId !== null && latestMessageId <= coveredUntilMessageId) {
      lastCoreCheckpointId = latestMessageId;
    }
  }

  if (
    needsRebuild &&
    isCheckpointFeatureEnabled() &&
    !coreMemoryText &&
    coveredUntilMessageId === 0 &&
    coreDirtySinceMessageId !== null &&
    coreDirtySinceMessageId > 0
  ) {
    const rollbackMessageId = Math.max(0, coreDirtySinceMessageId - 1);
    const maxCheckpointMessageId = Math.min(resolvedTargetMessageId, rollbackMessageId);

    const checkpoint = await loadCheckpointBestEffort({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      kind: CHECKPOINT_KIND_CORE_MEMORY,
      maxMessageId: maxCheckpointMessageId,
    });

    const checkpointText =
      checkpoint && typeof checkpoint.payload?.text === "string" ? checkpoint.payload.text.trim() : "";
    const checkpointMessageId = normalizeMessageId(checkpoint?.messageId);

    if (checkpointMessageId !== null && checkpointMessageId > 0 && checkpointText) {
      coreMemoryText = clipText(checkpointText, maxChars).trim();
      coveredUntilMessageId = checkpointMessageId;
      needsRebuild = true;
      lastCoreCheckpointId = checkpointMessageId;

      await writeProgress(coreMemoryText, coveredUntilMessageId, {
        nextNeedsRebuild: coveredUntilMessageId < resolvedTargetMessageId,
      });
      updated = true;

      logger.info("chat_memory_checkpoint_restored", {
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        kind: CHECKPOINT_KIND_CORE_MEMORY,
        messageId: checkpointMessageId,
        dirtySinceMessageId: coreDirtySinceMessageId,
      });
    }
  }

  if (strictSyncEnabled) {
    let strictSyncBlockReason = null;
    if (memory.rebuildRequired && !allowDuringRollingSummaryRebuild) strictSyncBlockReason = "rolling_summary_rebuild_required";
    else if (memory.dirtySinceMessageId !== null && !allowPartialRollingSummary) strictSyncBlockReason = "rolling_summary_dirty";
    else if (summarizedUntilMessageId <= 0) {
      if ((resolvedBoundaryId || 0) <= 0) {
        return attachSummaryUsage({
          updated,
          reason: "recent_window_only",
          thresholdMessages,
          targetMessageId: resolvedTargetMessageId,
        });
      }
      strictSyncBlockReason = "rolling_summary_missing_progress";
    }

    if (strictSyncBlockReason) {
      rollingSummarySkipReason = strictSyncBlockReason;
      if (!needsRebuild) {
        needsRebuild = true;
        await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: true });
        updated = true;
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
      const aligned = await loadAlignedRollingSummaryCheckpointText(summarizedUntilMessageId);
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
        if (strictSyncEnabled && bootstrapCheckpointId !== null) recordStrictSyncAlignedCheckpoint(bootstrapCheckpointId);
        bootstrap = await generateWithRetry({
          providerId,
          modelId,
          previousCoreMemoryText: "",
          rollingSummaryText: bootstrapRollingSummaryText,
          deltaMessages: [],
          maxChars,
          timeoutMs: chatMemoryConfig.syncRebuildTimeoutMs,
          settings: workerSettings,
          raw: workerRaw,
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

      if (isCheckpointFeatureEnabled() && coreMemoryText) {
        const shouldWriteCheckpoint =
          lastCoreCheckpointId === null || coveredUntilMessageId - lastCoreCheckpointId >= checkpointEveryNMessages;
        if (shouldWriteCheckpoint) {
          const wrote = await writeCheckpointBestEffort({
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            kind: CHECKPOINT_KIND_CORE_MEMORY,
            messageId: coveredUntilMessageId,
            payload: { text: coreMemoryText },
          });
          if (wrote) lastCoreCheckpointId = coveredUntilMessageId;
        }
      }
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
      return attachSummaryUsage({
        updated: true,
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
      updated: false,
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

    let eligibleCount = 0;
    for (const row of probeRows) {
      const id = normalizeMessageId(row?.id);
      if (id === null) continue;
      if (id <= resolvedTargetMessageId) eligibleCount += 1;
    }

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
      const aligned = await loadAlignedRollingSummaryCheckpointText(coveredUntilMessageId);
      if (!aligned.ok) {
        recordStrictSyncMissingAlignedCheckpoint(coveredUntilMessageId);
        rollingSummarySkipReason = aligned.reason;
        needsRebuild = true;
        await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: true });
        updated = true;

        const strictMeta = isPlainObject(coreMeta?.strictSync) ? coreMeta.strictSync : {};
        logger.warn("chat_memory_core_missing_aligned_checkpoint", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          reason: aligned.reason,
          coveredUntilMessageId,
          foundCheckpointMessageId: aligned.foundMessageId,
          boundaryId: resolvedBoundaryId,
          summarizedUntilMessageId,
          targetMessageId: resolvedTargetMessageId,
          missingAlignedCheckpointTotal: readNonNegativeInt(strictMeta.missingAlignedCheckpointTotal),
          missingAlignedCheckpointConsecutive: readNonNegativeInt(strictMeta.missingAlignedCheckpointConsecutive),
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
      generation = await generateWithRetry({
        providerId,
        modelId,
        previousCoreMemoryText: coreMemoryText,
        rollingSummaryText,
        deltaMessages,
        maxChars,
        timeoutMs: chatMemoryConfig.syncRebuildTimeoutMs,
        settings: workerSettings,
        raw: workerRaw,
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
      recordStrictSyncAlignedCheckpoint(rollingSummaryCheckpointIdForBatch);
    }

    await writeProgress(coreMemoryText, coveredUntilMessageId, {
      nextNeedsRebuild: coveredUntilMessageId < resolvedTargetMessageId,
    });
    updated = true;

    if (isCheckpointFeatureEnabled() && coreMemoryText) {
      const shouldWriteCheckpoint =
        lastCoreCheckpointId === null || coveredUntilMessageId - lastCoreCheckpointId >= checkpointEveryNMessages;
      if (shouldWriteCheckpoint) {
        const wrote = await writeCheckpointBestEffort({
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          kind: CHECKPOINT_KIND_CORE_MEMORY,
          messageId: coveredUntilMessageId,
          payload: { text: coreMemoryText },
        });
        if (wrote) lastCoreCheckpointId = coveredUntilMessageId;
      }
    }

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
