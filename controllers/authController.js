const userModel = require("@models/userModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

const authController = {
  async login(req, res) {
    try {
      const { username, password } = req.body;

      // 1. 检查请求体
      if (!username || !password) {
        return res.status(400).json({ error: "用户名和密码不能为空" });
      }

      // 2. 查找用户
      const user = await userModel.findByUsername(username);
      if (!user) {
        return res.status(401).json({ error: "认证失败：用户名或密码错误" });
      }

      // 3. 比对密码
      const isPasswordMatch = await bcrypt.compare(password, user.password_hash);
      if (!isPasswordMatch) {
        return res.status(401).json({ error: "认证失败：用户名或密码错误" });
      }

      // 4. 生成 JWT
      const payload = {
        id: user.id,
        username: user.username,
      };

      const token = jwt.sign(
        payload,
        process.env.JWT_SECRET, // 从 .env 文件读取密钥
        { expiresIn: "7d" } // Token 有效期，例如 7 天
      );

      // 5. 响应
      res.status(200).json({
        message: "登录成功",
        token: token,
      });
    } catch (error) {
      console.error("Error in authController.login:", error);
      res.status(500).json({ error: "服务器内部错误" });
    }
  },
};

module.exports = authController;
