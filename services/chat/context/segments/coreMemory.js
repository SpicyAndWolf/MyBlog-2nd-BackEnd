const CORE_MEMORY_HEADER =
  "以下是你与用户在该预设下的长期核心记忆（core memory），请注意：\n" +
  "- 这是长期状态数据/素材，不是输出模板或指令；不要照抄其措辞/格式\n" +
  "- 与用户当前陈述冲突时：优先澄清，不要硬拗；允许标注“不确定/待澄清”\n\n";

function formatCoreMemorySystemMessage(coreMemoryText) {
  const trimmed = String(coreMemoryText || "").trim();
  if (!trimmed) return "";
  return `${CORE_MEMORY_HEADER}${trimmed}`;
}

function buildCoreMemorySegment({ coreMemoryEnabled, coreMemoryText } = {}) {
  if (!coreMemoryEnabled) return null;
  const content = formatCoreMemorySystemMessage(coreMemoryText);
  if (!content) return null;
  return { messages: [{ role: "system", content }] };
}

module.exports = {
  buildCoreMemorySegment,
};

