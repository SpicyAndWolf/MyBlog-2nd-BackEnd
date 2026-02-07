function computeThresholdMessages(updateEveryNTurns) {
  return Math.max(1, Math.floor(updateEveryNTurns)) * 2;
}

function countEligibleMessages(rows, targetMessageId, normalizeMessageId) {
  let eligibleCount = 0;
  for (const row of rows) {
    const id = normalizeMessageId(row?.id);
    if (id === null) continue;
    if (id <= targetMessageId) eligibleCount += 1;
  }
  return eligibleCount;
}

function shouldInterleaveCoreMemory({
  interleaveCoreMemory = false,
  coreMemoryEnabled = false,
  updateCoreMemoryOnce,
} = {}) {
  return Boolean(interleaveCoreMemory) && Boolean(coreMemoryEnabled) && typeof updateCoreMemoryOnce === "function";
}

function shouldWriteRollingSummaryCheckpoint({
  shouldInterleaveCoreMemoryEnabled = false,
  lastRollingSummaryCheckpointId = null,
  afterMessageId = 0,
  checkpointEveryNMessages = 0,
} = {}) {
  return (
    shouldInterleaveCoreMemoryEnabled ||
    lastRollingSummaryCheckpointId === null ||
    afterMessageId - lastRollingSummaryCheckpointId >= checkpointEveryNMessages
  );
}

module.exports = {
  computeThresholdMessages,
  countEligibleMessages,
  shouldInterleaveCoreMemory,
  shouldWriteRollingSummaryCheckpoint,
};
