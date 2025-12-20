// routes/chat.js
const express = require("express");
const router = express.Router();
const authMiddleware = require("@middleware/authMiddleware");
const chatController = require("@controllers/chatController");
const uploadChatPresetAvatar = require("@middleware/uploadChatPresetAvatar");

router.use(authMiddleware);

router.get("/presets", chatController.listPresets);
router.post("/presets", chatController.createPreset);
router.patch("/presets/:presetId", chatController.updatePreset);
router.delete("/presets/:presetId", chatController.deletePreset);
router.post("/presets/:presetId/avatar", uploadChatPresetAvatar.single("avatar"), chatController.uploadPresetAvatar);

router.get("/sessions", chatController.listSessions);
router.post("/sessions", chatController.createSession);
router.patch("/sessions/:sessionId", chatController.renameSession);
router.delete("/sessions/:sessionId", chatController.deleteSession);
router.get("/sessions/:sessionId/messages", chatController.listMessages);
router.patch("/sessions/:sessionId/messages/:messageId", chatController.editMessage);
router.post("/sessions/:sessionId/messages", chatController.sendMessage);

module.exports = router;
