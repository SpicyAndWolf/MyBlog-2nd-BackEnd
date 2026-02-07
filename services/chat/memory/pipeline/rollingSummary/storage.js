const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");

async function clearRollingSummaryForRecentWindowOnly({ userId, presetId } = {}) {
  return await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
    rollingSummary: "",
    summarizedUntilMessageId: 0,
    rebuildRequired: false,
  });
}

async function writeRollingSummaryProgress({
  userId,
  presetId,
  rollingSummary,
  summarizedUntilMessageId,
  isDirty = false,
  dirtySinceMessageId = null,
} = {}) {
  const shouldWriteDirtyProgress =
    Boolean(isDirty) || (dirtySinceMessageId !== null && dirtySinceMessageId !== undefined);

  if (shouldWriteDirtyProgress) {
    return await chatPresetMemoryModel.writeRollingSummaryProgress(userId, presetId, {
      rollingSummary,
      summarizedUntilMessageId,
      dirtySinceMessageId,
    });
  }
  return await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
    rollingSummary,
    summarizedUntilMessageId,
    rebuildRequired: false,
  });
}

async function writeRollingSummarySnapshotProgress({
  userId,
  presetId,
  rollingSummary,
  summarizedUntilMessageId,
} = {}) {
  return await chatPresetMemoryModel.writeRollingSummaryProgress(userId, presetId, {
    rollingSummary,
    summarizedUntilMessageId,
  });
}

async function writeRollingSummaryWithRebuildLock({
  userId,
  presetId,
  rollingSummary,
  summarizedUntilMessageId,
  rebuildRequired = false,
} = {}) {
  return await chatPresetMemoryModel.writeRollingSummary(userId, presetId, {
    rollingSummary,
    summarizedUntilMessageId,
    rebuildRequired: Boolean(rebuildRequired),
  });
}

module.exports = {
  clearRollingSummaryForRecentWindowOnly,
  writeRollingSummaryProgress,
  writeRollingSummarySnapshotProgress,
  writeRollingSummaryWithRebuildLock,
};
