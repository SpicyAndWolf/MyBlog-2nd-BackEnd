const { clipText } = require("../../textUtils");
const { CHECKPOINT_KIND_ROLLING_SUMMARY, CHECKPOINT_REASONS, readAlignedCheckpoint } = require("../checkpoints");
const { isPlainObject } = require("../utils");

function determineStrictSyncBlockReason({
  memory,
  allowDuringRollingSummaryRebuild = false,
  allowPartialRollingSummary = false,
  summarizedUntilMessageId = 0,
  resolvedBoundaryId = 0,
} = {}) {
  if (memory?.rebuildRequired && !allowDuringRollingSummaryRebuild) {
    return "rolling_summary_rebuild_required";
  }
  if (memory?.dirtySinceMessageId !== null && !allowPartialRollingSummary) {
    return "rolling_summary_dirty";
  }
  if (summarizedUntilMessageId <= 0 && (resolvedBoundaryId || 0) > 0) {
    return "rolling_summary_missing_progress";
  }
  return null;
}

function readNonNegativeInt(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return 0;
  return number;
}

function recordAlignedCheckpoint(coreMeta, expectedMessageId) {
  const baseMeta = isPlainObject(coreMeta) ? coreMeta : {};
  const strictMeta = isPlainObject(baseMeta.strictSync) ? baseMeta.strictSync : {};
  return {
    ...baseMeta,
    strictSync: {
      ...strictMeta,
      missingAlignedCheckpointTotal: readNonNegativeInt(strictMeta.missingAlignedCheckpointTotal),
      missingAlignedCheckpointConsecutive: 0,
      lastAlignedCheckpointMessageId: expectedMessageId,
    },
  };
}

function recordMissingAlignedCheckpoint(coreMeta, expectedMessageId) {
  const baseMeta = isPlainObject(coreMeta) ? coreMeta : {};
  const strictMeta = isPlainObject(baseMeta.strictSync) ? baseMeta.strictSync : {};
  return {
    ...baseMeta,
    strictSync: {
      ...strictMeta,
      missingAlignedCheckpointTotal: readNonNegativeInt(strictMeta.missingAlignedCheckpointTotal) + 1,
      missingAlignedCheckpointConsecutive: readNonNegativeInt(strictMeta.missingAlignedCheckpointConsecutive) + 1,
      lastMissingAlignedCheckpointMessageId: expectedMessageId,
    },
  };
}

function readStrictSyncCounters(coreMeta) {
  const strictMeta = isPlainObject(coreMeta?.strictSync) ? coreMeta.strictSync : {};
  return {
    missingAlignedCheckpointTotal: readNonNegativeInt(strictMeta.missingAlignedCheckpointTotal),
    missingAlignedCheckpointConsecutive: readNonNegativeInt(strictMeta.missingAlignedCheckpointConsecutive),
  };
}

async function loadAlignedRollingSummaryCheckpointText({
  userId,
  presetId,
  expectedMessageId,
  rollingSummaryMaxChars,
} = {}) {
  const aligned = await readAlignedCheckpoint({
    userId,
    presetId,
    kind: CHECKPOINT_KIND_ROLLING_SUMMARY,
    expectedMessageId,
  });
  if (!aligned.ok) return aligned;

  const checkpointText = typeof aligned.payload?.text === "string" ? aligned.payload.text.trim() : "";
  const clipped = clipText(checkpointText, rollingSummaryMaxChars).trim();
  if (!clipped && aligned.messageId > 0) {
    return {
      ok: false,
      reason: CHECKPOINT_REASONS.MISSING_ALIGNED_CHECKPOINT,
      foundMessageId: aligned.messageId,
    };
  }

  return { ok: true, messageId: aligned.messageId, text: clipped };
}

module.exports = {
  determineStrictSyncBlockReason,
  recordAlignedCheckpoint,
  recordMissingAlignedCheckpoint,
  readStrictSyncCounters,
  loadAlignedRollingSummaryCheckpointText,
};
