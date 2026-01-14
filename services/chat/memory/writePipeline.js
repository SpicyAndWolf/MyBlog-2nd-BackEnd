const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatConfig, chatMemoryConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { generateRollingSummary } = require("./rollingSummary");
const { generateCoreMemory } = require("./coreMemory");
const { buildRecentWindowContext } = require("../context/buildRecentWindowContext");
const { createSemaphore, createKeyedTaskQueue } = require("./taskQueue");
const { clipText } = require("./textUtils");

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildKey(userId, presetId) {
  return `${String(userId || "").trim()}:${String(presetId || "").trim()}`;
}

const workerSemaphore = createSemaphore(chatMemoryConfig.workerConcurrency);

const { enqueue: enqueueKeyTask } = createKeyedTaskQueue();

const catchUpStateByKey = new Map();
const CORE_MEMORY_TEMPLATE_ID = "core-memory-v1";

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function runWithWorkerSlot(task) {
  const release = await workerSemaphore.acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

function normalizeMessagesForSummary(rawMessages) {
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  return list
    .map((row) => ({
      role: String(row?.role || "").trim(),
      content: String(row?.content || ""),
    }))
    .filter((m) => m.role && m.content);
}

function normalizeMessageId(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return null;
  return number;
}

function readCoreMemorySnapshot(rawCoreMemory) {
  if (typeof rawCoreMemory === "string") {
    return { text: rawCoreMemory, meta: {} };
  }
  if (!isPlainObject(rawCoreMemory)) {
    return { text: "", meta: {} };
  }
  const text = typeof rawCoreMemory.text === "string" ? rawCoreMemory.text : "";
  const meta = isPlainObject(rawCoreMemory.meta) ? rawCoreMemory.meta : {};
  return { text, meta };
}

async function computeRollingSummaryTarget({ userId, presetId } = {}) {
  const maxMessages = chatConfig.recentWindowMaxMessages;
  const candidateLimit = maxMessages + 1;

  const recentWindow = await buildRecentWindowContext({ userId, presetId });
  const candidates = recentWindow.recentCandidates;
  const recent = recentWindow.recent;
  const hasOlderMessages = recentWindow.needsMemory;

  const windowStartMessageId = normalizeMessageId(recent.stats.windowStartMessageId);
  const targetUntilMessageId =
    hasOlderMessages && windowStartMessageId !== null ? Math.max(0, windowStartMessageId - 1) : 0;

  return {
    hasOlderMessages,
    targetUntilMessageId,
    windowStartMessageId,
    candidatesCount: candidates.length,
    candidateLimit,
    windowStats: recent.stats,
  };
}

async function catchUpRollingSummaryOnce({ userId, presetId, deadline, force = false, keepRebuildLock = false } = {}) {
  const providerId = chatMemoryConfig.workerProviderId;
  const modelId = chatMemoryConfig.workerModelId;
  const maxChars = chatMemoryConfig.rollingSummaryMaxChars;
  const workerSettings = chatMemoryConfig.rollingSummaryWorkerSettings;
  const workerRaw = chatMemoryConfig.workerRaw;
  const batchSize = chatMemoryConfig.backfillBatchMessages;
  const retryMax = chatMemoryConfig.writeRetryMax;

  const memory = await chatPresetMemoryModel.ensureMemory(userId, presetId);
  if (!memory) return { updated: false, reason: "memory_missing", needsMemory: false };

  const target = await computeRollingSummaryTarget({ userId, presetId });
  const targetUntilMessageId = normalizeMessageId(target.targetUntilMessageId) || 0;
  const needsMemory = Boolean(target.hasOlderMessages);

  if (!target.hasOlderMessages || targetUntilMessageId <= 0) {
    if (memory.rebuildRequired || memory.dirtySinceMessageId !== null) {
      await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
        rollingSummary: "",
        summarizedUntilMessageId: 0,
        rebuildRequired: false,
      });
      return { updated: true, reason: "recent_window_only", targetUntilMessageId, needsMemory };
    }
    return { updated: false, reason: "recent_window_only", targetUntilMessageId, needsMemory };
  }

  const isDirty = memory.dirtySinceMessageId !== null;
  let afterMessageId = isDirty ? 0 : Number(memory.summarizedUntilMessageId) || 0;
  let rollingSummary = isDirty ? "" : String(memory.rollingSummary || "").trim();

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
      };
    }
  }

  let updated = false;
  let processedBatches = 0;
  let processedMessages = 0;

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
      await chatPresetMemoryModel.writeRollingSummaryProgress(userId, presetId, {
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
      });
    } else {
      await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
        rollingSummary,
        summarizedUntilMessageId: afterMessageId,
        rebuildRequired: false,
      });
    }

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
  }

  return { updated, processedBatches, processedMessages, targetUntilMessageId, needsMemory };
}

async function updateCoreMemoryOnce({ userId, presetId, needsMemory, targetUntilMessageId, deadline } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return { updated: false, reason: "missing_identifier" };
  if (!needsMemory) return { updated: false, reason: "needs_memory_false" };

  const providerId = chatMemoryConfig.workerProviderId;
  const modelId = chatMemoryConfig.workerModelId;
  const maxChars = chatMemoryConfig.coreMemoryMaxChars;
  const workerSettings = chatMemoryConfig.coreMemoryWorkerSettings;
  const workerRaw = chatMemoryConfig.workerRaw;
  const retryMax = chatMemoryConfig.writeRetryMax;

  const memory = await chatPresetMemoryModel.ensureMemory(normalizedUserId, normalizedPresetId);
  if (!memory) return { updated: false, reason: "memory_missing" };

  const coreMemorySnapshot = readCoreMemorySnapshot(memory.coreMemory);
  let coreMemoryText = clipText(String(coreMemorySnapshot.text || "").trim(), maxChars).trim();
  let coreMeta = coreMemorySnapshot.meta;

  const rollingSummaryText = clipText(
    String(memory.rollingSummary || "").trim(),
    chatMemoryConfig.rollingSummaryMaxChars
  ).trim();

  let coveredUntilMessageId = normalizeMessageId(coreMeta?.coveredUntilMessageId) || 0;
  const updateEveryNTurns = chatMemoryConfig.coreMemoryUpdateEveryNTurns;
  const thresholdMessages = Math.max(1, Math.floor(updateEveryNTurns)) * 2;
  const probeLimit = thresholdMessages;
  const deltaMessageLimit = chatMemoryConfig.coreMemoryDeltaBatchMessages;
  const needsRebuild = Boolean(coreMeta?.needsRebuild);
  let rebuildTargetMessageId = normalizeMessageId(targetUntilMessageId);

  function buildNextMeta(nextCoveredUntilMessageId, { nextNeedsRebuild } = {}) {
    const nextMeta = {
      ...(isPlainObject(coreMeta) ? coreMeta : {}),
      templateId: CORE_MEMORY_TEMPLATE_ID,
      coveredUntilMessageId: nextCoveredUntilMessageId,
      needsRebuild: Boolean(nextNeedsRebuild),
    };

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

  if (!needsRebuild) {
    const probeRows = await chatModel.listMessagesByPresetAfter(normalizedUserId, normalizedPresetId, {
      afterMessageId: coveredUntilMessageId,
      limit: probeLimit,
    });

    if (!probeRows.length) {
      return { updated: false, reason: "no_new_messages", thresholdMessages };
    }
    if (probeRows.length < thresholdMessages) {
      return {
        updated: false,
        reason: "throttled",
        pendingMessages: probeRows.length,
        thresholdMessages,
      };
    }
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

  const startedAt = Date.now();
  let updated = false;
  let processedBatches = 0;
  let processedMessages = 0;
  let usedFallback = false;

  if (needsRebuild) {
    if (rebuildTargetMessageId === null) {
      const latestRows = await chatModel.listRecentMessagesByPreset(normalizedUserId, normalizedPresetId, { limit: 1 });
      const latestMessageId = normalizeMessageId(latestRows[0]?.id);
      rebuildTargetMessageId = latestMessageId !== null ? latestMessageId : coveredUntilMessageId;
    }
    if (coveredUntilMessageId >= rebuildTargetMessageId) {
      await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: false });
      return {
        updated: true,
        reason: "caught_up",
        durationMs: Date.now() - startedAt,
        coreMemoryChars: coreMemoryText.length,
        coveredUntilMessageId,
        usedFallback,
        processedBatches,
        processedMessages,
      };
    }

    while (coveredUntilMessageId < rebuildTargetMessageId) {
      if (deadline && Date.now() > deadline) {
        return {
          updated,
          reason: "timeout",
          thresholdMessages,
          coveredUntilMessageId,
          processedBatches,
          processedMessages,
        };
      }
      const rows = await chatModel.listMessagesByPresetAfter(normalizedUserId, normalizedPresetId, {
        afterMessageId: coveredUntilMessageId,
        limit: deltaMessageLimit,
      });

      if (!rows.length) {
        return {
          updated,
          reason: "no_new_messages",
          thresholdMessages,
          coveredUntilMessageId,
          processedBatches,
          processedMessages,
        };
      }

      const withinTarget = rows.filter((row) => {
        const id = normalizeMessageId(row?.id);
        return id !== null && id <= rebuildTargetMessageId;
      });

      if (!withinTarget.length) {
        coveredUntilMessageId = rebuildTargetMessageId;
        await writeProgress(coreMemoryText, coveredUntilMessageId, { nextNeedsRebuild: false });
        updated = true;
        break;
      }

      const lastMessageId = normalizeMessageId(withinTarget[withinTarget.length - 1]?.id);
      const nextCoveredUntilMessageId = lastMessageId !== null ? lastMessageId : coveredUntilMessageId;
      if (nextCoveredUntilMessageId <= coveredUntilMessageId) {
        return { updated, reason: "no_progress", thresholdMessages, processedBatches, processedMessages };
      }

      const deltaMessages = normalizeMessagesForSummary(withinTarget);

      if (!deltaMessages.length) {
        coveredUntilMessageId = nextCoveredUntilMessageId;
        await writeProgress(coreMemoryText, coveredUntilMessageId, {
          nextNeedsRebuild: coveredUntilMessageId < rebuildTargetMessageId,
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
          return {
            updated,
            reason: "timeout",
            thresholdMessages,
            coveredUntilMessageId,
            processedBatches,
            processedMessages,
          };
        }
        logger.error("chat_memory_core_generate_failed", {
          error,
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          providerId,
          modelId,
        });
        return { updated, reason: "generate_failed", processedBatches, processedMessages };
      }

      if (!generation?.valid) {
        logger.warn("chat_memory_core_invalid_output", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          providerId,
          modelId,
          reason: generation?.reason,
        });
        return {
          updated,
          reason: "invalid_output",
          invalidReason: generation?.reason,
          thresholdMessages,
          processedBatches,
          processedMessages,
        };
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

      await writeProgress(coreMemoryText, coveredUntilMessageId, {
        nextNeedsRebuild: coveredUntilMessageId < rebuildTargetMessageId,
      });
      updated = true;

      if (coveredUntilMessageId >= rebuildTargetMessageId) break;
      if (withinTarget.length < rows.length) break;
      if (rows.length < deltaMessageLimit) break;
      await sleep(chatMemoryConfig.backfillCooldownMs);
    }

    return {
      updated,
      durationMs: Date.now() - startedAt,
      coreMemoryChars: coreMemoryText.length,
      coveredUntilMessageId,
      usedFallback,
      processedBatches,
      processedMessages,
    };
  }

  const deltaRows = await chatModel.listMessagesByPresetAfter(normalizedUserId, normalizedPresetId, {
    afterMessageId: coveredUntilMessageId,
    limit: deltaMessageLimit,
  });

  const deltaMessages = normalizeMessagesForSummary(deltaRows);
  if (!deltaMessages.length) return { updated: false, reason: "no_delta_messages" };

  const lastMessageId = normalizeMessageId(deltaRows[deltaRows.length - 1]?.id);
  const nextCoveredUntilMessageId = lastMessageId !== null ? lastMessageId : coveredUntilMessageId;
  if (nextCoveredUntilMessageId <= coveredUntilMessageId) {
    return { updated: false, reason: "no_progress" };
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
    logger.error("chat_memory_core_generate_failed", {
      error,
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      providerId,
      modelId,
    });
    return { updated: false, reason: "generate_failed" };
  }

  if (!generation?.valid) {
    logger.warn("chat_memory_core_invalid_output", {
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      providerId,
      modelId,
      reason: generation?.reason,
    });
    return { updated: false, reason: "invalid_output", invalidReason: generation?.reason, thresholdMessages };
  }

  let finalText = String(generation.text || "").trim();
  const singleUsedFallback = !finalText && Boolean(coreMemoryText);
  if (singleUsedFallback) finalText = coreMemoryText;

  await writeProgress(finalText, nextCoveredUntilMessageId, { nextNeedsRebuild: false });

  return {
    updated: true,
    durationMs: Date.now() - startedAt,
    coreMemoryChars: finalText.length,
    coveredUntilMessageId: nextCoveredUntilMessageId,
    usedFallback: singleUsedFallback,
  };
}

function requestRollingSummaryCatchUp({ userId, presetId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return;

  const key = buildKey(normalizedUserId, normalizedPresetId);
  const state = catchUpStateByKey.get(key) || { scheduled: false, rerun: false };

  if (state.scheduled) {
    state.rerun = true;
    catchUpStateByKey.set(key, state);
    return;
  }

  state.scheduled = true;
  state.rerun = false;
  catchUpStateByKey.set(key, state);

  void enqueueKeyTask(key, async () => {
    try {
      while (true) {
        const result = await catchUpRollingSummaryOnce({ userId: normalizedUserId, presetId: normalizedPresetId });
        if (result?.updated) {
          logger.info("chat_memory_rolling_summary_updated", {
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            processedBatches: result.processedBatches,
            processedMessages: result.processedMessages,
          });
        }

        let coreResult = null;
        try {
          coreResult = await updateCoreMemoryOnce({
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            needsMemory: result?.needsMemory,
          });
        } catch (error) {
          logger.error("chat_memory_core_update_failed", {
            error,
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            providerId: chatMemoryConfig.workerProviderId,
            modelId: chatMemoryConfig.workerModelId,
          });
        }

        if (coreResult?.updated) {
          logger.info("chat_memory_core_updated", {
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            coreMemoryChars: coreResult.coreMemoryChars,
            durationMs: coreResult.durationMs,
            coveredUntilMessageId: coreResult.coveredUntilMessageId,
            usedFallback: coreResult.usedFallback,
            processedBatches: coreResult.processedBatches,
            processedMessages: coreResult.processedMessages,
            reason: coreResult.reason,
          });
        } else if (coreResult) {
          logger.debug("chat_memory_core_skipped", {
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            reason: coreResult.reason,
            invalidReason: coreResult.invalidReason,
            pendingMessages: coreResult.pendingMessages,
            thresholdMessages: coreResult.thresholdMessages,
          });
        }

        const current = catchUpStateByKey.get(key);
        if (current?.rerun) {
          current.rerun = false;
          catchUpStateByKey.set(key, current);
          continue;
        }
        break;
      }
    } catch (error) {
      logger.error("chat_memory_rolling_summary_update_failed", {
        error,
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        providerId: chatMemoryConfig.workerProviderId,
        modelId: chatMemoryConfig.workerModelId,
      });
    } finally {
      catchUpStateByKey.delete(key);
    }
  });
}

async function rebuildRollingSummarySync({ userId, presetId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const key = buildKey(normalizedUserId, normalizedPresetId);
  const totalTimeoutMs = Number(chatMemoryConfig.syncRebuildTotalTimeoutMs) || 0;
  const deadline = totalTimeoutMs > 0 ? Date.now() + totalTimeoutMs : null;

  return await enqueueKeyTask(key, async () => {
    const result = await catchUpRollingSummaryOnce({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      deadline,
      force: true,
      keepRebuildLock: true,
    });
    if (result?.updated) {
      logger.info("chat_memory_rolling_summary_rebuilt_sync", {
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        processedBatches: result.processedBatches,
        processedMessages: result.processedMessages,
      });
    }

    let coreResult = null;
    if (result?.needsMemory) {
      try {
        coreResult = await updateCoreMemoryOnce({
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          needsMemory: true,
          deadline,
        });
      } catch (error) {
        logger.error("chat_memory_core_rebuild_sync_failed", {
          error,
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          providerId: chatMemoryConfig.workerProviderId,
          modelId: chatMemoryConfig.workerModelId,
        });
      }

      if (coreResult?.updated) {
        logger.info("chat_memory_core_rebuilt_sync", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          coreMemoryChars: coreResult.coreMemoryChars,
          durationMs: coreResult.durationMs,
          coveredUntilMessageId: coreResult.coveredUntilMessageId,
          usedFallback: coreResult.usedFallback,
          processedBatches: coreResult.processedBatches,
          processedMessages: coreResult.processedMessages,
          reason: coreResult.reason,
        });
      } else if (coreResult) {
        logger.debug("chat_memory_core_rebuild_sync_skipped", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          reason: coreResult.reason,
          invalidReason: coreResult.invalidReason,
          pendingMessages: coreResult.pendingMessages,
          thresholdMessages: coreResult.thresholdMessages,
          processedBatches: coreResult.processedBatches,
          processedMessages: coreResult.processedMessages,
        });
      }
    }

    try {
      await chatPresetMemoryModel.setRebuildRequired(normalizedUserId, normalizedPresetId, false);
    } catch (unlockError) {
      logger.error("chat_memory_rebuild_unlock_failed", { error: unlockError, userId: normalizedUserId, presetId: normalizedPresetId });
      throw unlockError;
    }

    return { ...result, coreResult };
  });
}

async function getPresetMemoryStatus({ userId, presetId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return null;

  return await chatPresetMemoryModel.getMemory(normalizedUserId, normalizedPresetId);
}

async function markPresetMemoryDirty({ userId, presetId, sinceMessageId, rebuildRequired = false, reason } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const key = buildKey(normalizedUserId, normalizedPresetId);
  return await enqueueKeyTask(key, async () => {
    const updated = await chatPresetMemoryModel.markDirtyAndClear(normalizedUserId, normalizedPresetId, {
      sinceMessageId,
      rebuildRequired,
    });

    logger.info("chat_memory_cleared_for_consistency", {
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      sinceMessageId,
      rebuildRequired: Boolean(rebuildRequired),
      reason,
    });

    return updated;
  });
}

async function clearPresetCoreMemory({ userId, presetId, sinceMessageId, reason } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const key = buildKey(normalizedUserId, normalizedPresetId);
  return await enqueueKeyTask(key, async () => {
    const updated = await chatPresetMemoryModel.clearCoreMemory(normalizedUserId, normalizedPresetId, { sinceMessageId });
    logger.info("chat_memory_core_cleared_for_consistency", {
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      sinceMessageId,
      reason,
    });
    return updated;
  });
}

module.exports = {
  requestRollingSummaryCatchUp,
  rebuildRollingSummarySync,
  getPresetMemoryStatus,
  markPresetMemoryDirty,
  clearPresetCoreMemory,
};
