const { isPlainObject, normalizeMessageId } = require("../utils");

const CORE_MEMORY_TEMPLATE_ID = "core-memory-v1";

function buildNextCoreMeta(currentMeta, nextCoveredUntilMessageId, { nextNeedsRebuild } = {}) {
  const nextMeta = {
    ...(isPlainObject(currentMeta) ? currentMeta : {}),
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

module.exports = {
  CORE_MEMORY_TEMPLATE_ID,
  buildNextCoreMeta,
};
