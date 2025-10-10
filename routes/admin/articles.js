// routes/admin/articles.js
const express = require("express");
const path = require("path");
const router = express.Router();
const authMiddleware = require("@middleware/authMiddleware");
const articleController = require("@controllers/articleController");

// GET /api/admin/articles - 获取所有文章
// 在控制器函数之前插入 authMiddleware，这个路由就被保护起来了！
router.get("/", authMiddleware, articleController.getAllArticlesAdmin);
router.post("/", authMiddleware, articleController.createArticle);
router.get("/:id", authMiddleware, articleController.getArticleByIdAdmin);
router.put("/:id", authMiddleware, articleController.updateArticle);
router.delete("/:id", authMiddleware, articleController.deleteArticle);

module.exports = router;
