// routes/tags.js
const express = require("express");
const router = express.Router();
const tagController = require("@controllers/tagController");

// GET /api/tags
router.get("/", tagController.getAllTags);

module.exports = router;
