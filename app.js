// app.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const path = require("path");
require("module-alias/register");

// 引入配置文件
dotenv.config();

const { chatConfig } = require("./config");
const { logger } = require("./logger");
const requestLogger = require("./middleware/requestLogger");
const errorHandler = require("./middleware/errorHandler");

// 导入所有路由
const tagsRouter = require("./routes/tags");
const articlesRouter = require("./routes/articles");
const adminArticlesRouter = require("./routes/admin/articles");
const authRouter = require("./routes/auth");
const adminTagsRouter = require("./routes/admin/tags");
const chatRouter = require("./routes/chat");
const { startChatTrashCleanup } = require("./services/chat/trashCleanup");

const app = express();
const PORT = process.env.PORT || 3000;

process.on("unhandledRejection", (reason) => {
  logger.error("unhandled_rejection", { error: reason });
});

process.on("uncaughtException", (error) => {
  logger.error("uncaught_exception", { error });
});

app.use(cors());
app.use(requestLogger);
app.use(express.json());

// 开放静态资源，如 /uploads/articles/...
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// 其余路由挂载
app.use("/api/tags", tagsRouter);
app.use("/api/admin/tags", adminTagsRouter);
app.use("/api/articles", articlesRouter);
app.use("/api/auth", authRouter);
app.use("/api/chat", chatRouter);

// 管理后台API (所有这里的路由都需要认证)
app.use("/api/admin/articles", adminArticlesRouter);

app.use(errorHandler);

startChatTrashCleanup({
  retentionDays: chatConfig.trashRetentionDays,
  intervalMs: chatConfig.trashCleanupIntervalMs,
  batchSize: chatConfig.trashPurgeBatchSize,
});

app.listen(PORT, () => {
  logger.info("server_started", { port: PORT });
});
