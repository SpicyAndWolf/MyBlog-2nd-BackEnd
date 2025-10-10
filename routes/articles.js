// routes/articles.js
const express = require("express");
const router = express.Router();
const articleController = require("@controllers/articleController");

// 路由
router.get("/", articleController.getAllPublishedArticles);
router.get("/:id", articleController.getPublishedArticleById);

module.exports = router;
