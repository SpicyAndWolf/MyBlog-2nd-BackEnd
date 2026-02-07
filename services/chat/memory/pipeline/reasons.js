const CHECKPOINT_REASONS = Object.freeze({
  FEATURE_DISABLED: "checkpoint_feature_disabled",
  TABLE_MISSING: "checkpoint_table_missing",
  MISSING_ALIGNED_CHECKPOINT: "missing_aligned_checkpoint",
  INVALID_MESSAGE_ID: "invalid_message_id",
});

module.exports = {
  CHECKPOINT_REASONS,
};
