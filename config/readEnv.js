function readStringEnv(name, defaultValue = "") {
  const raw = process.env[name];
  if (typeof raw !== "string") return defaultValue;
  const trimmed = raw.trim();
  return trimmed ? trimmed : defaultValue;
}

function readIntEnv(name, defaultValue) {
  const raw = process.env[name];
  if (typeof raw !== "string") return defaultValue;
  const trimmed = raw.trim();
  if (!trimmed) return defaultValue;
  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

module.exports = {
  readStringEnv,
  readIntEnv,
};
