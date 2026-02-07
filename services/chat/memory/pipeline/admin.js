const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { logger } = require("../../../../logger");
const { deleteCheckpointsFromMessageIdBestEffort } = require("./checkpoints");

function createMemoryAdminOps({ buildKey, enqueueByKey } = {}) {
  if (typeof buildKey !== "function") throw new Error("buildKey is required");
  if (typeof enqueueByKey !== "function") throw new Error("enqueueByKey is required");

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
    return await enqueueByKey(key, async () => {
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
    return await enqueueByKey(key, async () => {
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
    return await enqueueByKey(key, async () => {
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

  return {
    getPresetMemoryStatus,
    markPresetMemoryDirty,
    releasePresetMemoryRebuildLock,
    clearPresetCoreMemory,
  };
}

module.exports = {
  createMemoryAdminOps,
};
