const { chatMemoryConfig } = require("../../../../config");

const assistantGistPrefix = String(chatMemoryConfig?.recentWindowAssistantGistPrefix || "").trim();
if (!assistantGistPrefix) {
  throw new Error("Missing required env: CHAT_RECENT_WINDOW_ASSISTANT_GIST_PREFIX");
}

const GIST_NOTICE_TEXT = `提示：对话历史中可能出现以**${assistantGistPrefix}**为起始的 assistant 的“情绪标签+对话语意概括”（用于压缩历史并保持连贯性），它们不是输出模板；请不要在回复中复用其前缀/格式/措辞。`;

function getAssistantGistUsedCount({ recent, gapBridge } = {}) {
  const recentUsed = Number(recent?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  const gapBridgeUsed = Number(gapBridge?.stats?.assistantAntiEcho?.assistantGistUsed) || 0;
  return recentUsed + gapBridgeUsed;
}

function buildAssistantGistNoticeSegment(contextState = {}) {
  const assistantGistUsed = getAssistantGistUsedCount(contextState);
  if (assistantGistUsed <= 0) return null;
  return { messages: [{ role: "system", content: GIST_NOTICE_TEXT }] };
}

module.exports = {
  buildAssistantGistNoticeSegment,
};
