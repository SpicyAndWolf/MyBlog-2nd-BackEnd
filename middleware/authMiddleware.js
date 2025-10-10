// middleware/authMiddleware.js
const jwt = require("jsonwebtoken");

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  // 1. 检查是否存在 Authorization 头
  if (!authHeader) {
    return res.status(403).json({ error: "需要提供Token用于认证" });
  }

  // 2. 验证头的格式是否为 'Bearer <token>'
  const tokenParts = authHeader.split(" ");
  if (tokenParts.length !== 2 || tokenParts[0] !== "Bearer") {
    return res.status(401).json({ error: 'Token格式不正确，应为 "Bearer <token>"' });
  }

  const token = tokenParts[1];

  // 3. 验证Token
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      // Token 过期或无效
      return res.status(401).json({ error: "Token无效或已过期" });
    }

    // 4. 将解码后的用户信息附加到请求对象上
    // 这样，后续的控制器就可以通过 req.user 获取到用户信息
    req.user = decoded;

    // 5. 调用 next() 将控制权交给下一个中间件或路由处理器
    next();
  });
};

module.exports = verifyToken;
