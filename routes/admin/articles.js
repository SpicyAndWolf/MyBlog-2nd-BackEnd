// routes/admin/articles.js
const express = require("express");
const path = require("path");
const router = express.Router();
const authMiddleware = require("@middleware/authMiddleware");
const articleController = require("@controllers/articleController");
const uploadArticleCover = require("@middleware/uploadArticleCover");
const uploadArticleContentImage = require("@middleware/uploadArticleContentImage");

// GET /api/admin/articles - 获取所有文章
// 在控制器函数之前插入 authMiddleware，这个路由就被保护起来了！
router.get("/", authMiddleware, articleController.getAllArticlesAdmin);
router.post("/", authMiddleware, uploadArticleCover.single("headerImage"), articleController.createArticle);
router.get("/:id", authMiddleware, articleController.getArticleByIdAdmin);
router.put("/:id", authMiddleware, uploadArticleCover.single("headerImage"), articleController.updateArticle);
router.delete("/:id", authMiddleware, articleController.deleteArticle);
router.post(
  "/upload-image",
  authMiddleware,
  uploadArticleContentImage.single("image"),
  articleController.uploadContentImage
);

module.exports = router;
