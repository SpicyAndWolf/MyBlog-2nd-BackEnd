const express = require("express");
const app = express();

// 定义端口
const PORT = process.env.PORT || 3000;

// 路由
app.get("/", (req, res) => {
  res.send("Hello, Blog Backend!");
});

// 启动服务器，并监听指定的端口
app.listen(PORT, () => {
  console.log(`服务器正在 http://localhost:${PORT} 上运行`);
});
