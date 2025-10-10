// app.js
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
require("module-alias/register");

// 引入配置文件
dotenv.config();

// 导入所有路由
const tagsRouter = require("./routes/tags");
const articlesRouter = require("./routes/articles");
const adminArticlesRouter = require("./routes/admin/articles");
const authRouter = require("./routes/auth");
const adminTagsRouter = require("./routes/admin/tags");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 路由挂载
app.use("/api/tags", tagsRouter);
app.use("/api/admin/tags", adminTagsRouter);
app.use("/api/articles", articlesRouter);
app.use("/api/auth", authRouter);

// 管理后台API (所有这里的路由都需要认证)
app.use("/api/admin/articles", adminArticlesRouter);

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
