const { generateCoreMemory } = require("../../coreMemory");
const { sleep } = require("../utils");

async function generateCoreMemoryWithRetry({
  runWithWorkerSlot,
  deadline,
  retryMax,
  args,
} = {}) {
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

module.exports = {
  generateCoreMemoryWithRetry,
};
