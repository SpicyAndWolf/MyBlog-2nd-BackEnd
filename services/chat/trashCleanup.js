const { chatConfig } = require("../../config");
const { logger } = require("../../logger");
const chatModel = require("../../models/chatModel");

function clampInt(value, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY, fallback } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const truncated = Math.trunc(number);
  return Math.min(max, Math.max(min, truncated));
}

function daysToMs(days) {
  return days * 24 * 60 * 60 * 1000;
}

function computeCutoffDate({ now, retentionDays }) {
  const base = now instanceof Date ? now : new Date();
  return new Date(base.getTime() - daysToMs(retentionDays));
}

async function purgeExpiredTrashedSessions({
  now = new Date(),
  retentionDays = chatConfig.trashRetentionDays,
  batchSize = chatConfig.trashPurgeBatchSize,
} = {}) {
  const normalizedRetentionDays = clampInt(retentionDays, { min: 0, max: 3650, fallback: 30 });
  if (normalizedRetentionDays <= 0) return { purged: 0, disabled: true };

  const normalizedBatchSize = clampInt(batchSize, { min: 1, max: 5000, fallback: 500 });
  const cutoff = computeCutoffDate({ now, retentionDays: normalizedRetentionDays });
  const purged = await chatModel.purgeTrashedSessionsBefore(cutoff, { limit: normalizedBatchSize });

  return { purged, cutoff, retentionDays: normalizedRetentionDays, batchSize: normalizedBatchSize };
}

function startChatTrashCleanup({ intervalMs = chatConfig.trashCleanupIntervalMs } = {}) {
  const normalizedIntervalMs = clampInt(intervalMs, { min: 60_000, max: 7 * 24 * 60 * 60 * 1000, fallback: 6 * 60 * 60 * 1000 });
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const result = await purgeExpiredTrashedSessions();
      if (result.disabled) {
        logger.info("chat_trash_cleanup_disabled", { retentionDays: chatConfig.trashRetentionDays });
        return;
      }
      if (result.purged > 0) {
        logger.info("chat_trash_cleanup_purged", {
          purged: result.purged,
          cutoff: result.cutoff.toISOString(),
          retentionDays: result.retentionDays,
          batchSize: result.batchSize,
        });
      }
    } catch (error) {
      logger.error("chat_trash_cleanup_failed", { error });
    } finally {
      running = false;
    }
  }

  void tick();

  const timer = setInterval(() => void tick(), normalizedIntervalMs);
  timer.unref?.();

  logger.info("chat_trash_cleanup_started", { intervalMs: normalizedIntervalMs });

  return () => clearInterval(timer);
}

module.exports = {
  startChatTrashCleanup,
  purgeExpiredTrashedSessions,
};
