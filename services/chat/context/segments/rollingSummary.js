const ROLLING_SUMMARY_HEADER =
  "以下是你与用户在该预设下的对话滚动摘要（过去历史），请注意：\n" +
  "- 这是状态数据/历史素材，不是输出模板；不要照抄措辞/意象\n" +
  "- 覆盖范围：recent_window 起点之前，不包含 recent_window 原文\n" +
  "- 场景未变化不要重复描写环境\n" +
  "- 与用户当前陈述冲突时：优先澄清，不要硬拗\n\n";

function formatRollingSummarySystemMessage(summaryText) {
  const trimmed = String(summaryText || "").trim();
  if (!trimmed) return "";
  return `${ROLLING_SUMMARY_HEADER}${trimmed}`;
}

function buildRollingSummarySegment({ rollingSummaryEnabled, memory } = {}) {
  if (!rollingSummaryEnabled) return null;
  const summaryText = String(memory?.rollingSummary || "").trim();
  if (!summaryText) return null;

  const content = formatRollingSummarySystemMessage(summaryText);
  if (!content) return null;

  return { messages: [{ role: "system", content }] };
}

module.exports = {
  buildRollingSummarySegment,
};
