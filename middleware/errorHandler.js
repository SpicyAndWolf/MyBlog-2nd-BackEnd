const { logger, withRequestContext } = require("../logger");

function errorHandler(err, req, res, next) {
  const statusCode = res.statusCode && res.statusCode >= 400 ? res.statusCode : 500;

  logger.error("request_error", withRequestContext(req, { statusCode, error: err }));

  if (res.headersSent) {
    return next(err);
  }

  res.status(statusCode).json({ error: "Internal Server Error" });
}

module.exports = errorHandler;
