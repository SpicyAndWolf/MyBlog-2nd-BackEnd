function computeThresholdMessages(updateEveryNTurns) {
  return Math.max(1, Math.floor(updateEveryNTurns)) * 2;
}

function buildRollingSummaryUsageState({
  memory,
  allowPartialRollingSummary = false,
  summarizedUntilMessageId = 0,
  rollingSummaryRaw = "",
  resolvedTargetMessageId = 0,
  strictSyncEnabled = false,
} = {}) {
  const summaryUsable =
    (memory?.dirtySinceMessageId === null || allowPartialRollingSummary) &&
    summarizedUntilMessageId > 0 &&
    Boolean(rollingSummaryRaw);
  const summarySafe = summaryUsable && summarizedUntilMessageId <= resolvedTargetMessageId;

  let rollingSummarySkipReason = null;
  if (!summaryUsable) {
    if (memory?.dirtySinceMessageId !== null) rollingSummarySkipReason = "memory_dirty";
    else if (summarizedUntilMessageId <= 0) rollingSummarySkipReason = "missing_progress";
    else if (!rollingSummaryRaw) rollingSummarySkipReason = "missing_text";
    else rollingSummarySkipReason = "unusable";
  } else if (!summarySafe) {
    rollingSummarySkipReason = "summary_beyond_target";
  }

  if (!strictSyncEnabled && !rollingSummarySkipReason) {
    rollingSummarySkipReason = "strict_sync_disabled";
  }

  return {
    summaryUsable,
    summarySafe,
    rollingSummarySkipReason,
  };
}

function attachSummaryUsage(result, usage = {}) {
  const rollingSummaryUsed = Boolean(usage.rollingSummaryUsedBootstrap || usage.rollingSummaryUsedDelta);
  return {
    ...result,
    boundaryId: usage.resolvedBoundaryId,
    strictSyncEnabled: usage.strictSyncEnabled,
    summarizedUntilMessageId: usage.summarizedUntilMessageId,
    rollingSummaryUsable: usage.summaryUsable,
    rollingSummarySafe: usage.summarySafe,
    rollingSummaryUsed,
    rollingSummaryUsedBootstrap: Boolean(usage.rollingSummaryUsedBootstrap),
    rollingSummaryUsedDelta: Boolean(usage.rollingSummaryUsedDelta),
    rollingSummaryCheckpointMessageIdUsed: usage.rollingSummaryCheckpointMessageIdUsed ?? null,
    rollingSummarySkipReason: rollingSummaryUsed ? null : usage.rollingSummarySkipReason || null,
  };
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

module.exports = {
  computeThresholdMessages,
  buildRollingSummaryUsageState,
  attachSummaryUsage,
  countEligibleMessages,
};
