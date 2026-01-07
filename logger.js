const fs = require("fs");
const path = require("path");
const { readBoolEnv, readStringEnv } = require("./config/readEnv");

const LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const DEFAULT_LEVEL = "info";
const configuredLevel = readStringEnv("LOG_LEVEL", DEFAULT_LEVEL).toLowerCase();
const activeLevel = Object.prototype.hasOwnProperty.call(LEVELS, configuredLevel) ? configuredLevel : DEFAULT_LEVEL;

const LOG_TO_CONSOLE = readBoolEnv("LOG_TO_CONSOLE", true);
const LOG_TO_FILE = readBoolEnv("LOG_TO_FILE", true);
const LOG_DIR = readStringEnv("LOG_DIR", "logs");
const LOG_ERROR_FILE = readStringEnv("LOG_ERROR_FILE", "error.log");
const LOG_WARN_FILE = readStringEnv("LOG_WARN_FILE", "warn.log");
const LOG_INFO_FILE = readStringEnv("LOG_INFO_FILE", "info.log");
const LOG_DEBUG_FILE = readStringEnv("LOG_DEBUG_FILE", "debug.log");
const LOG_CHAT_FILE = readStringEnv("LOG_CHAT_FILE", "");

function resolveLogPath(logDir, rawPath) {
  const normalized = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!normalized) return "";
  return path.isAbsolute(normalized) ? normalized : path.join(logDir, normalized);
}

const logDir = path.isAbsolute(LOG_DIR) ? LOG_DIR : path.join(__dirname, LOG_DIR);
const levelLogFilePaths = {
  error: resolveLogPath(logDir, LOG_ERROR_FILE),
  warn: resolveLogPath(logDir, LOG_WARN_FILE),
  info: resolveLogPath(logDir, LOG_INFO_FILE),
  debug: resolveLogPath(logDir, LOG_DEBUG_FILE),
};
const chatLogFilePath = resolveLogPath(logDir, LOG_CHAT_FILE);

if (LOG_TO_FILE) {
  fs.mkdirSync(logDir, { recursive: true });
}

function shouldLog(level) {
  return LEVELS[level] <= LEVELS[activeLevel];
}

function serializeError(error) {
  if (!error) return undefined;
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return { message: String(error) };
}

function normalizeMeta(meta) {
  if (!meta) return undefined;
  if (meta instanceof Error) return { error: serializeError(meta) };
  if (typeof meta !== "object") return { value: meta };

  const normalized = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value instanceof Error) {
      normalized[key] = serializeError(value);
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function safeJsonStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "\"[unserializable]\"";
  }
}

function emitConsole(level, entry, meta) {
  const metaText = meta ? ` ${safeJsonStringify(meta)}` : "";
  const line = `${entry.timestamp} ${level.toUpperCase()} ${entry.message}${metaText}`;

  switch (level) {
    case "error":
      console.error(line);
      break;
    case "warn":
      console.warn(line);
      break;
    case "debug":
      if (console.debug) {
        console.debug(line);
      } else {
        console.log(line);
      }
      break;
    default:
      console.log(line);
      break;
  }
}

function emitLevelFile(level, entry) {
  const filePath = levelLogFilePaths[level];
  if (!filePath) return;
  const line = safeJsonStringify(entry);
  fs.appendFile(filePath, `${line}\n`, () => {});
}

function emitChatFile(entry) {
  if (!chatLogFilePath) return;
  const line = safeJsonStringify(entry);
  fs.appendFile(chatLogFilePath, `${line}\n`, () => {});
}

function log(level, message, meta) {
  if (!shouldLog(level)) return;
  const normalizedMeta = normalizeMeta(meta);
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
  };
  if (normalizedMeta && Object.keys(normalizedMeta).length > 0) {
    entry.meta = normalizedMeta;
  }

  if (LOG_TO_CONSOLE) {
    emitConsole(level, entry, normalizedMeta);
  }
  if (LOG_TO_FILE) {
    emitLevelFile(level, entry);
  }
}

const logger = {
  log,
  error: (message, meta) => log("error", message, meta),
  warn: (message, meta) => log("warn", message, meta),
  info: (message, meta) => log("info", message, meta),
  chat: (message, meta) => {
    const normalizedMeta = normalizeMeta(meta);
    const entry = {
      timestamp: new Date().toISOString(),
      level: "chat",
      message,
    };
    if (normalizedMeta && Object.keys(normalizedMeta).length > 0) {
      entry.meta = normalizedMeta;
    }

    if (LOG_TO_CONSOLE && shouldLog("info")) {
      emitConsole("info", entry, normalizedMeta);
    }
    if (LOG_TO_FILE) {
      emitChatFile(entry);
    }
  },
  debug: (message, meta) => log("debug", message, meta),
};

function withRequestContext(req, meta = {}) {
  const context = {};
  if (req) {
    if (req.requestId) context.requestId = req.requestId;
    if (req.method) context.method = req.method;
    if (req.originalUrl) context.path = req.originalUrl;
    if (req.ip) context.ip = req.ip;
    if (req.user && req.user.id) context.userId = req.user.id;
  }
  return { ...context, ...meta };
}

module.exports = {
  logger,
  withRequestContext,
};
