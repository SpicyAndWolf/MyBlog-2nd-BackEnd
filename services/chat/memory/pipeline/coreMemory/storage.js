const chatPresetMemoryModel = require("@models/chatPresetMemoryModel");
const { buildNextCoreMeta } = require("./meta");

async function writeCoreMemoryProgress({
  userId,
  presetId,
  coreMemoryText,
  coveredUntilMessageId,
  nextNeedsRebuild,
  coreMeta,
} = {}) {
  const nextMeta = buildNextCoreMeta(coreMeta, coveredUntilMessageId, { nextNeedsRebuild });

  await chatPresetMemoryModel.writeCoreMemory(userId, presetId, {
    coreMemory: {
      text: coreMemoryText,
      meta: nextMeta,
    },
  });

  return nextMeta;
}

module.exports = {
  writeCoreMemoryProgress,
};
