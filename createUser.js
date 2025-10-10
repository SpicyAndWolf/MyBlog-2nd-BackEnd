const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
const readline = require("readline");
const db = require("./db.js");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

rl.question("请输入管理员用户名: ", (username) => {
  rl.question("请输入管理员密码: ", async (password) => {
    try {
      if (!username || !password) {
        console.error("用户名和密码不能为空！");
        return;
      }
      // 哈希密码，10 是 salt 的轮次，越高越安全但越慢
      const hashedPassword = await bcrypt.hash(password, 10);

      // 插入数据库
      const query = "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username";
      const { rows } = await db.query(query, [username, hashedPassword]);

      console.log("✅ 管理员用户创建成功:");
      console.log(rows[0]);
    } catch (error) {
      console.error("❌ 创建用户时出错:", error.message);
    } finally {
      db.end();
      rl.close();
    }
  });
});
