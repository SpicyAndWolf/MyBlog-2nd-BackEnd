const { getProviderDefinition, listSupportedProviders } = require("./providers");

function isPlainObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeKey(value) {
  return String(value || "").trim();
}

function getProviderSettingsSchema(providerId) {
  const id = normalizeKey(providerId);
  const schema = getProviderDefinition(id)?.settingsSchema;
  return Array.isArray(schema) ? schema : [];
}

function findSchemaControl(schema, key) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return null;
  const list = Array.isArray(schema) ? schema : [];
  return (
    list.find((control) => control && typeof control === "object" && normalizeKey(control.key) === normalizedKey) || null
  );
}

function getNumericRangeFromControl(control) {
  if (!isPlainObject(control)) return null;
  const type = normalizeKey(control.type);
  if (type !== "range" && type !== "number") return null;

  const min = Number(control.min);
  const max = Number(control.max);
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return { min, max, type };
}

function getProviderNumericRange(providerId, key) {
  const schema = getProviderSettingsSchema(providerId);
  const control = findSchemaControl(schema, key);
  return getNumericRangeFromControl(control);
}

let globalNumericRangeCache = null;

function buildGlobalNumericRanges() {
  const ranges = new Map();
  for (const provider of listSupportedProviders()) {
    const providerId = normalizeKey(provider?.id);
    if (!providerId) continue;

    const schema = getProviderSettingsSchema(providerId);
    for (const control of schema) {
      const key = normalizeKey(control?.key);
      if (!key) continue;

      const range = getNumericRangeFromControl(control);
      if (!range) continue;

      const existing = ranges.get(key);
      if (!existing) {
        ranges.set(key, { min: range.min, max: range.max });
        continue;
      }

      ranges.set(key, {
        min: Math.min(existing.min, range.min),
        max: Math.max(existing.max, range.max),
      });
    }
  }

  globalNumericRangeCache = ranges;
}

function getGlobalNumericRange(key) {
  const normalizedKey = normalizeKey(key);
  if (!normalizedKey) return null;
  if (!globalNumericRangeCache) buildGlobalNumericRanges();
  return globalNumericRangeCache.get(normalizedKey) || null;
}

function clampNumber(value, { min, max, fallback } = {}) {
  if (!Number.isFinite(value)) return fallback;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return value;
  return Math.min(max, Math.max(min, value));
}

function clampNumberWithRange(value, range, { fallback } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  if (!range || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return number;
  return Math.min(range.max, Math.max(range.min, number));
}

module.exports = {
  getProviderSettingsSchema,
  getProviderNumericRange,
  getGlobalNumericRange,
  clampNumber,
  clampNumberWithRange,
};

