const chatModel = require("@models/chatModel");
const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const chatPresetMemoryCheckpointModel = require("@models/chatPresetMemoryCheckpointModel");
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

const memoryTickStateByKey = new Map();
const CORE_MEMORY_TEMPLATE_ID = "core-memory-v1";
const CHECKPOINT_KIND_ROLLING_SUMMARY = chatPresetMemoryCheckpointModel.CHECKPOINT_KINDS.rollingSummary;
const CHECKPOINT_KIND_CORE_MEMORY = chatPresetMemoryCheckpointModel.CHECKPOINT_KINDS.coreMemory;
let checkpointTableMissingLogged = false;
let checkpointTableMissing = false;

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isCheckpointFeatureEnabled() {
  const everyNMessages = Number(chatMemoryConfig.checkpointEveryNMessages);
  const keepLastN = Number(chatMemoryConfig.checkpointKeepLastN);
  return Number.isFinite(everyNMessages) && everyNMessages > 0 && Number.isFinite(keepLastN) && keepLastN > 0;
}

function warnCheckpointTableMissingOnce({ error, operation } = {}) {
  if (checkpointTableMissingLogged) return;
  checkpointTableMissingLogged = true;
  checkpointTableMissing = true;

  logger.warn("chat_memory_checkpoint_table_missing", {
    operation,
    error,
    requiredSql: "BlogBackEnd/models/tableCreate/chat_preset_memory_checkpoints.sql",
    table: "chat_preset_memory_checkpoints",
  });
}

async function writeCheckpointBestEffort({ userId, presetId, kind, messageId, payload, protectMessageId, reason } = {}) {
  if (!isCheckpointFeatureEnabled()) return false;

  const checkpointMessageId = normalizeMessageId(messageId);
  if (checkpointMessageId === null || checkpointMessageId <= 0) return false;
  if (!payload || typeof payload !== "object") return false;

  const normalizedProtect = normalizeMessageId(protectMessageId);
  if (protectMessageId !== undefined && protectMessageId !== null && normalizedProtect === null) return false;

  try {
    await chatPresetMemoryCheckpointModel.upsertCheckpoint(userId, presetId, {
      kind,
      messageId: checkpointMessageId,
      payload,
    });
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "write" });
      return false;
    }
    logger.error("chat_memory_checkpoint_write_failed", { error, userId, presetId, kind, messageId: checkpointMessageId });
    return false;
  }

  try {
    await chatPresetMemoryCheckpointModel.pruneKeepLastN(userId, presetId, {
      kind,
      keepLastN: chatMemoryConfig.checkpointKeepLastN,
      protectMessageId: normalizedProtect,
    });
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "prune" });
      return true;
    }
    logger.error("chat_memory_checkpoint_prune_failed", {
      error,
      userId,
      presetId,
      kind,
      keepLastN: chatMemoryConfig.checkpointKeepLastN,
      protectMessageId: normalizedProtect,
    });
  }

  if (reason) {
    const base = {
      userId,
      presetId,
      kind,
      messageId: checkpointMessageId,
      reason,
      protectMessageId: normalizedProtect,
    };
    if (kind === CHECKPOINT_KIND_ROLLING_SUMMARY) {
      base.summarizedUntilMessageId = checkpointMessageId;
    }
    logger.info("chat_memory_checkpoint_written", base);
  }

  return true;
}

async function loadCheckpointBestEffort({ userId, presetId, kind, maxMessageId } = {}) {
  if (!isCheckpointFeatureEnabled()) return null;

  const normalizedMax = normalizeMessageId(maxMessageId);
  if (normalizedMax === null) return null;

  try {
    return await chatPresetMemoryCheckpointModel.getLatestCheckpointBeforeOrAt(userId, presetId, {
      kind,
      maxMessageId: normalizedMax,
    });
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "load" });
      return null;
    }
    logger.error("chat_memory_checkpoint_load_failed", { error, userId, presetId, kind, maxMessageId: normalizedMax });
    return null;
  }
}

async function loadLatestCheckpointBestEffort({ userId, presetId, kind } = {}) {
  if (!isCheckpointFeatureEnabled()) return null;

  try {
    return await chatPresetMemoryCheckpointModel.getLatestCheckpoint(userId, presetId, { kind });
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "load_latest" });
      return null;
    }
    logger.error("chat_memory_checkpoint_load_failed", { error, userId, presetId, kind });
    return null;
  }
}

async function deleteCheckpointsFromMessageIdBestEffort({ userId, presetId, fromMessageId, reason } = {}) {
  const normalizedFrom = normalizeMessageId(fromMessageId);
  if (normalizedFrom === null) return 0;

  try {
    return await chatPresetMemoryCheckpointModel.deleteCheckpointsFromMessageId(userId, presetId, {
      kinds: [CHECKPOINT_KIND_ROLLING_SUMMARY, CHECKPOINT_KIND_CORE_MEMORY],
      fromMessageId: normalizedFrom,
    });
  } catch (error) {
    if (error?.code === "42P01") {
      warnCheckpointTableMissingOnce({ error, operation: "delete" });
      return 0;
    }
    logger.error("chat_memory_checkpoint_delete_failed", { error, userId, presetId, fromMessageId: normalizedFrom, reason });
    return 0;
  }
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

async function computeCoreMemoryTarget({ userId, presetId } = {}) {
  const latestRows = await chatModel.listRecentMessagesByPreset(userId, presetId, { limit: 1 });
  const latestMessageId = normalizeMessageId(latestRows[0]?.id);
  const targetMessageId = latestMessageId !== null ? latestMessageId : 0;

  return {
    targetMessageId,
  };
}

async function catchUpRollingSummaryOnce({
  userId,
  presetId,
  deadline,
  force = false,
  keepRebuildLock = false,
  interleaveCoreMemory = false,
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

  const shouldInterleaveCoreMemory = Boolean(interleaveCoreMemory) && Boolean(chatMemoryConfig.coreMemoryEnabled);
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

async function catchUpCoreMemoryOnce({
  userId,
  presetId,
  needsMemory,
  targetMessageId,
  boundaryId,
  deadline,
  force = false,
  allowDuringRollingSummaryRebuild = false,
} = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return { updated: false, reason: "missing_identifier" };
  if (!needsMemory) return { updated: false, reason: "needs_memory_false" };
  if (!chatMemoryConfig.coreMemoryEnabled) return { updated: false, reason: "disabled" };

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
    const expected = normalizeMessageId(expectedMessageId);
    if (expected === null) return { ok: false, reason: "invalid_message_id" };
    if (expected <= 0) return { ok: true, messageId: 0, text: "" };

    if (!isCheckpointFeatureEnabled()) {
      return {
        ok: false,
        reason: checkpointTableMissing ? "checkpoint_table_missing" : "checkpoint_feature_disabled",
      };
    }

    const checkpoint = await loadCheckpointBestEffort({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
      maxMessageId: expected,
    });
    const checkpointMessageId = normalizeMessageId(checkpoint?.messageId);
    if (checkpointMessageId !== expected) {
      return {
        ok: false,
        reason: checkpointTableMissing ? "checkpoint_table_missing" : "missing_aligned_checkpoint",
        foundMessageId: checkpointMessageId,
      };
    }

    const checkpointText = checkpoint && typeof checkpoint.payload?.text === "string" ? checkpoint.payload.text.trim() : "";
    const clipped = clipText(checkpointText, chatMemoryConfig.rollingSummaryMaxChars).trim();
    if (!clipped) {
      return {
        ok: false,
        reason: "missing_aligned_checkpoint",
        foundMessageId: checkpointMessageId,
      };
    }

    return { ok: true, messageId: checkpointMessageId, text: clipped };
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

async function updateCoreMemoryOnce({
  userId,
  presetId,
  needsMemory,
  targetMessageId,
  boundaryId,
  deadline,
  force = false,
  allowDuringRollingSummaryRebuild = false,
} = {}) {
  return await catchUpCoreMemoryOnce({
    userId,
    presetId,
    needsMemory,
    targetMessageId,
    boundaryId,
    deadline,
    force,
    allowDuringRollingSummaryRebuild,
  });
}

function requestMemoryTick({ userId, presetId } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId || !normalizedPresetId) return;

  const key = buildKey(normalizedUserId, normalizedPresetId);
  const state = memoryTickStateByKey.get(key) || { scheduled: false, rerun: false };

  if (state.scheduled) {
    state.rerun = true;
    memoryTickStateByKey.set(key, state);
    return;
  }

  state.scheduled = true;
  state.rerun = false;
  memoryTickStateByKey.set(key, state);

  void enqueueKeyTask(key, async () => {
    try {
      while (true) {
        let summaryResult = null;
        try {
          summaryResult = await catchUpRollingSummaryOnce({ userId: normalizedUserId, presetId: normalizedPresetId });
        } catch (error) {
          logger.error("chat_memory_rolling_summary_update_failed", {
            error,
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            providerId: chatMemoryConfig.workerProviderId,
            modelId: chatMemoryConfig.workerModelId,
          });
        }

        if (summaryResult?.updated) {
          logger.info("chat_memory_rolling_summary_updated", {
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            processedBatches: summaryResult.processedBatches,
            processedMessages: summaryResult.processedMessages,
          });
        }

        const needsMemory = summaryResult ? Boolean(summaryResult.needsMemory) : true;

        let coreResult = null;
        try {
          let coreTargetMessageId = null;
          if (needsMemory && chatMemoryConfig.coreMemoryEnabled) {
            try {
              const coreTarget = await computeCoreMemoryTarget({ userId: normalizedUserId, presetId: normalizedPresetId });
              coreTargetMessageId = normalizeMessageId(coreTarget.targetMessageId);
            } catch (error) {
              logger.error("chat_memory_core_target_compute_failed", {
                error,
                userId: normalizedUserId,
                presetId: normalizedPresetId,
              });
              coreTargetMessageId = null;
            }
          }

          coreResult = await updateCoreMemoryOnce({
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            needsMemory,
            targetMessageId: coreTargetMessageId,
            boundaryId: summaryResult?.targetUntilMessageId,
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
          logger.debug("chat_memory_core_skipped", {
            userId: normalizedUserId,
            presetId: normalizedPresetId,
            reason: coreResult.reason,
            invalidReason: coreResult.invalidReason,
            pendingMessages: coreResult.pendingMessages,
            thresholdMessages: coreResult.thresholdMessages,
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

        const current = memoryTickStateByKey.get(key);
        if (current?.rerun) {
          current.rerun = false;
          memoryTickStateByKey.set(key, current);
          continue;
        }
        break;
      }
    } catch (error) {
      logger.error("chat_memory_tick_failed", {
        error,
        userId: normalizedUserId,
        presetId: normalizedPresetId,
      });
    } finally {
      memoryTickStateByKey.delete(key);
    }
  });
}

function requestRollingSummaryCatchUp(args = {}) {
  requestMemoryTick(args);
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
      interleaveCoreMemory: true,
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
        let coreTargetMessageId = null;
        if (chatMemoryConfig.coreMemoryEnabled) {
          try {
            const coreTarget = await computeCoreMemoryTarget({ userId: normalizedUserId, presetId: normalizedPresetId });
            coreTargetMessageId = normalizeMessageId(coreTarget.targetMessageId);
          } catch (error) {
            logger.error("chat_memory_core_target_compute_failed", {
              error,
              userId: normalizedUserId,
              presetId: normalizedPresetId,
            });
            coreTargetMessageId = null;
          }
        }

        coreResult = await updateCoreMemoryOnce({
          userId: normalizedUserId,
          presetId: normalizedPresetId,
          needsMemory: true,
          targetMessageId: coreTargetMessageId,
          boundaryId: result?.targetUntilMessageId,
          deadline,
          force: true,
          allowDuringRollingSummaryRebuild: true,
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
        logger.debug("chat_memory_core_rebuild_sync_skipped", {
          userId: normalizedUserId,
          presetId: normalizedPresetId,
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

    await deleteCheckpointsFromMessageIdBestEffort({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      fromMessageId: sinceMessageId,
      reason,
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

async function releasePresetMemoryRebuildLock({ userId, presetId, reason } = {}) {
  const normalizedUserId = userId;
  const normalizedPresetId = String(presetId || "").trim();
  if (!normalizedUserId) throw new Error("Missing userId");
  if (!normalizedPresetId) throw new Error("Missing presetId");

  const normalizedReason = typeof reason === "string" && reason.trim() ? reason.trim() : null;

  const key = buildKey(normalizedUserId, normalizedPresetId);
  return await enqueueKeyTask(key, async () => {
    const updated = await chatPresetMemoryModel.setRebuildRequired(normalizedUserId, normalizedPresetId, false);
    logger.info("chat_memory_rebuild_lock_released", {
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      reason: normalizedReason,
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

    await deleteCheckpointsFromMessageIdBestEffort({
      userId: normalizedUserId,
      presetId: normalizedPresetId,
      fromMessageId: sinceMessageId,
      reason,
    });

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
  requestMemoryTick,
  requestRollingSummaryCatchUp,
  rebuildRollingSummarySync,
  getPresetMemoryStatus,
  markPresetMemoryDirty,
  releasePresetMemoryRebuildLock,
  clearPresetCoreMemory,
};
