// routes/admin/tags.js
const express = require("express");
const router = express.Router();
const tagController = require("@controllers/tagController");
const authMiddleware = require("@middleware/authMiddleware");

// 所有标签管理路由都需要认证
router.use(authMiddleware);

// POST /api/admin/tags - 创建一个新标签
router.post("/", tagController.createTag);
router.put("/:id", tagController.updateTag);
router.delete("/:id", tagController.deleteTag);

module.exports = router;
