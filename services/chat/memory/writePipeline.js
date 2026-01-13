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

async function catchUpRollingSummaryOnce({ userId, presetId, deadline, force = false } = {}) {
  const providerId = chatMemoryConfig.workerProviderId;
  const modelId = chatMemoryConfig.workerModelId;
  const maxChars = chatMemoryConfig.rollingSummaryMaxChars;
  const workerSettings = chatMemoryConfig.workerSettings;
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
    const probeLimit = Math.min(500, thresholdMessages);

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
      if (isDirty) {
        await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
          rollingSummary,
          summarizedUntilMessageId: afterMessageId,
        });
        updated = true;
      } else {
        await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
          rollingSummary,
          summarizedUntilMessageId: afterMessageId,
        });
        updated = true;
      }
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
    });
    updated = true;
  }

  return { updated, processedBatches, processedMessages, targetUntilMessageId, needsMemory };
}

async function updateCoreMemoryOnce({ userId, presetId, needsMemory } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return { updated: false, reason: "missing_identifier" };
  if (!needsMemory) return { updated: false, reason: "needs_memory_false" };

  const providerId = chatMemoryConfig.workerProviderId;
  const modelId = chatMemoryConfig.workerModelId;
  const maxChars = chatMemoryConfig.coreMemoryMaxChars;
  const workerSettings = chatMemoryConfig.workerSettings;
  const workerRaw = chatMemoryConfig.workerRaw;
  const retryMax = chatMemoryConfig.writeRetryMax;

  const memory = await chatPresetMemoryModel.ensureMemory(normalizedUserId, normalizedPresetId);
  if (!memory) return { updated: false, reason: "memory_missing" };

  const coreMemorySnapshot = readCoreMemorySnapshot(memory.coreMemory);
  const previousCoreMemoryText = clipText(String(coreMemorySnapshot.text || "").trim(), maxChars).trim();
  const previousMeta = coreMemorySnapshot.meta;

  const rollingSummaryText = clipText(
    String(memory.rollingSummary || "").trim(),
    chatMemoryConfig.rollingSummaryMaxChars
  ).trim();

  const coveredUntilMessageId = normalizeMessageId(previousMeta?.coveredUntilMessageId) || 0;
  const updateEveryNTurns = chatMemoryConfig.coreMemoryUpdateEveryNTurns;
  const thresholdMessages = Math.max(1, Math.floor(updateEveryNTurns)) * 2;
  const probeLimit = Math.min(500, thresholdMessages);

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

  const deltaMessageLimit = Math.min(200, Math.max(thresholdMessages, chatConfig.recentWindowMaxMessages * 2));
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

  async function generateWithRetry(args) {
    let attempt = 0;
    while (true) {
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
  let generation = null;

  try {
    generation = await generateWithRetry({
      providerId,
      modelId,
      previousCoreMemoryText,
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
  const usedFallback = !finalText && Boolean(previousCoreMemoryText);
  if (usedFallback) finalText = previousCoreMemoryText;

  const nextMeta = {
    ...(isPlainObject(previousMeta) ? previousMeta : {}),
    templateId: CORE_MEMORY_TEMPLATE_ID,
    coveredUntilMessageId: nextCoveredUntilMessageId,
  };

  await chatPresetMemoryModel.writeCoreMemory(normalizedUserId, normalizedPresetId, {
    coreMemory: {
      text: finalText,
      meta: nextMeta,
    },
  });

  return {
    updated: true,
    durationMs: Date.now() - startedAt,
    coreMemoryChars: finalText.length,
    coveredUntilMessageId: nextCoveredUntilMessageId,
    usedFallback,
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
    });
    if (result?.updated) {
      logger.info("chat_memory_rolling_summary_rebuilt_sync", {
        userId: normalizedUserId,
        presetId: normalizedPresetId,
        processedBatches: result.processedBatches,
        processedMessages: result.processedMessages,
      });
    }
    return result;
  });
}

async function getPresetMemoryStatus({ userId, presetId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return null;

  return await chatPresetMemoryModel.getMemory(normalizedUserId, normalizedPresetId);
}

async function markPresetMemoryDirty({ userId, presetId, sinceMessageId, rebuildRequired = false } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const key = buildKey(normalizedUserId, normalizedPresetId);
  return await enqueueKeyTask(key, async () => {
    return await chatPresetMemoryModel.markDirtyAndClear(normalizedUserId, normalizedPresetId, {
      sinceMessageId,
      rebuildRequired,
    });
  });
}

module.exports = {
  requestRollingSummaryCatchUp,
  rebuildRollingSummarySync,
  getPresetMemoryStatus,
  markPresetMemoryDirty,
};
