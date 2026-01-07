const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { chatConfig, chatMemoryConfig } = require("../../../config");
const { logger } = require("../../../logger");
const { generateRollingSummary } = require("./rollingSummary");
const { selectRecentWindowMessages } = require("../contextCompiler");

function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildKey(userId, presetId) {
  return `${String(userId || "").trim()}:${String(presetId || "").trim()}`;
}

function createSemaphore(limit) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 1;
  let active = 0;
  const waiters = [];

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next) next();
  }

  async function acquire() {
    if (active < normalizedLimit) {
      active += 1;
      return release;
    }

    await new Promise((resolve) => waiters.push(resolve));
    active += 1;
    return release;
  }

  return { acquire };
}

const workerSemaphore = createSemaphore(chatMemoryConfig.workerConcurrency);

const keyLocks = new Map();
function enqueueKeyTask(key, task) {
  const tail = keyLocks.get(key) || Promise.resolve();

  const run = tail
    .catch(() => {})
    .then(task)
    .finally(() => {
      if (keyLocks.get(key) === run) keyLocks.delete(key);
    });

  keyLocks.set(key, run);
  return run;
}

const catchUpStateByKey = new Map();

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

async function computeRollingSummaryTarget({ userId, presetId } = {}) {
  const maxMessages = chatConfig.maxContextMessages;
  const maxChars = chatConfig.maxContextChars;
  const candidateLimit = maxMessages + 1;

  const candidates = await chatModel.listRecentMessagesByPreset(userId, presetId, { limit: candidateLimit });
  const recent = selectRecentWindowMessages(candidates, {
    maxMessages,
    maxChars,
    assistantGistEnabled: chatMemoryConfig.recentWindowAssistantGistEnabled,
    assistantRawLastN: chatMemoryConfig.recentWindowAssistantRawLastN,
    assistantGistPrefix: chatMemoryConfig.recentWindowAssistantGistPrefix,
  });

  const selectedBeforeUserBoundary = recent.stats.selected + recent.stats.droppedToUserBoundary;
  const reachedCandidateLimit = candidates.length === candidateLimit;
  const hasOlderMessages = reachedCandidateLimit || candidates.length > selectedBeforeUserBoundary;

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
  if (!memory) return { updated: false, reason: "memory_missing" };

  const target = await computeRollingSummaryTarget({ userId, presetId });
  const targetUntilMessageId = normalizeMessageId(target.targetUntilMessageId) || 0;

  if (!target.hasOlderMessages || targetUntilMessageId <= 0) {
    if (memory.rebuildRequired || memory.dirtySinceMessageId !== null) {
      await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
        rollingSummary: "",
        summarizedUntilMessageId: 0,
      });
      return { updated: true, reason: "recent_window_only", targetUntilMessageId };
    }
    return { updated: false, reason: "recent_window_only", targetUntilMessageId };
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

  return { updated, processedBatches, processedMessages, targetUntilMessageId };
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
