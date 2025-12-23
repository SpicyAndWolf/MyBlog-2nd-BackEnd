const crypto = require("crypto");
const { logger } = require("../logger");

const IGNORED_PREFIXES = ["/uploads"];

function generateRequestId() {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return crypto.randomBytes(16).toString("hex");
}

function shouldIgnoreRequest(req) {
  const url = req.originalUrl || "";
  return IGNORED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

function requestLogger(req, res, next) {
  const incomingId = req.headers["x-request-id"];
  const requestId =
    typeof incomingId === "string" && incomingId.trim() ? incomingId.trim() : generateRequestId();

  req.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const start = process.hrtime.bigint();

  res.on("finish", () => {
    if (shouldIgnoreRequest(req)) return;

    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    const roundedDuration = Math.round(durationMs * 100) / 100;
    const statusCode = res.statusCode || 0;
    const level = statusCode >= 500 ? "error" : statusCode >= 400 ? "warn" : "info";

    logger[level]("http_request", {
      requestId,
      method: req.method,
      path: req.originalUrl,
      statusCode,
      durationMs: roundedDuration,
      ip: req.ip,
      userId: req.user?.id || null,
    });
  });

  next();
}

module.exports = requestLogger;
