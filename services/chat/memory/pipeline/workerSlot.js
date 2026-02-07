const { chatMemoryConfig } = require("../../../../config");
const { createSemaphore } = require("../taskQueue");

const workerSemaphore = createSemaphore(chatMemoryConfig.workerConcurrency);

async function runWithWorkerSlot(task) {
  const release = await workerSemaphore.acquire();
  try {
    return await task();
  } finally {
    release();
  }
}

module.exports = {
  runWithWorkerSlot,
};
