const { createKeyedTaskQueue } = require("../taskQueue");

function createTickScheduler({ buildKey, processTick, onTickFailed } = {}) {
  if (typeof buildKey !== "function") throw new Error("buildKey is required");
  if (typeof processTick !== "function") throw new Error("processTick is required");

  const { enqueue: enqueueByKey } = createKeyedTaskQueue();
  const tickStateByKey = new Map();

  function requestTick({ userId, presetId } = {}) {
    const normalizedUserId = userId;
    const normalizedPresetId = String(presetId || "").trim();
    if (!normalizedUserId || !normalizedPresetId) return;

    const key = buildKey(normalizedUserId, normalizedPresetId);
    const state = tickStateByKey.get(key) || { scheduled: false, rerun: false };

    if (state.scheduled) {
      state.rerun = true;
      tickStateByKey.set(key, state);
      return;
    }

    state.scheduled = true;
    state.rerun = false;
    tickStateByKey.set(key, state);

    void enqueueByKey(key, async () => {
      try {
        while (true) {
          await processTick({ userId: normalizedUserId, presetId: normalizedPresetId });

          const current = tickStateByKey.get(key);
          if (current?.rerun) {
            current.rerun = false;
            tickStateByKey.set(key, current);
            continue;
          }
          break;
        }
      } catch (error) {
        if (typeof onTickFailed === "function") {
          await onTickFailed({ error, userId: normalizedUserId, presetId: normalizedPresetId, key });
        }
      } finally {
        tickStateByKey.delete(key);
      }
    });
  }

  return {
    requestTick,
    enqueueByKey,
  };
}

module.exports = {
  createTickScheduler,
};
