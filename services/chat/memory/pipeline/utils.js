function sleep(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildKey(userId, presetId) {
  return `${String(userId || "").trim()}:${String(presetId || "").trim()}`;
}

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMessagesForSummary(rawMessages) {
  const list = Array.isArray(rawMessages) ? rawMessages : [];
  return list
    .map((row) => ({
      role: String(row?.role || "").trim(),
      content: String(row?.content || ""),
    }))
    .filter((message) => message.role && message.content);
}

function normalizeMessageId(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0) return null;
  return number;
}

function readCoreMemorySnapshot(rawCoreMemory) {
  if (typeof rawCoreMemory === "string") {
    return { text: rawCoreMemory, meta: {} };
  }
  if (!isPlainObject(rawCoreMemory)) {
    return { text: "", meta: {} };
  }
  const text = typeof rawCoreMemory.text === "string" ? rawCoreMemory.text : "";
  const meta = isPlainObject(rawCoreMemory.meta) ? rawCoreMemory.meta : {};
  return { text, meta };
}

module.exports = {
  sleep,
  buildKey,
  isPlainObject,
  normalizeMessagesForSummary,
  normalizeMessageId,
  readCoreMemorySnapshot,
};
