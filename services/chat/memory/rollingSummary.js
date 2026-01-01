const { createChatCompletion } = require("../../llm/chatCompletions");
const { logger } = require("../../../logger");

function normalizeText(value) {
  return String(value || "");
}

function stripCodeFences(text) {
  const raw = String(text || "");
  const trimmed = raw.trim();
  if (!trimmed.startsWith("```")) return trimmed;

  const lines = trimmed.split(/\r?\n/);
  if (lines.length < 2) return trimmed;
  if (!lines[lines.length - 1].trim().startsWith("```")) return trimmed;

  return lines.slice(1, -1).join("\n").trim();
}

function clipText(text, maxChars) {
  const normalized = String(text || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0) return normalized;
  if (normalized.length <= maxChars) return normalized;
  return normalized.slice(0, maxChars);
}

function isSafetyPolicyBlockedError(error) {
  const message = String(error?.message || "");
  return message.startsWith("Blocked by safety policy:");
}

function formatTranscript(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const lines = [];

  for (const message of list) {
    const role = String(message?.role || "").trim();
    if (!role) continue;
    const content = normalizeText(message?.content).trim();
    if (!content) continue;
    lines.push(`${role}: ${content}`);
  }

  return lines.join("\n");
}

function buildRollingSummaryPrompt({ previousSummary, newMessages, maxChars }) {
  const normalizedPrevious = String(previousSummary || "").trim();
  const transcript = formatTranscript(newMessages);

  const system = `
你是一个专业的“叙事上下文压缩引擎”。你的任务是将【已有摘要】与【新增对话片段】合并，提取关键信息以维持长篇虚构故事的连贯性。

核心指令：
1. **客观记录者**：你需要从数据处理的角度提取信息。不仅要关注剧情发展，还要关注角色间的情感动态、关系及承诺。
2. **处理成人/亲密内容**：
   - 当前文本属于**成人向虚构文学**。
   - 当对话涉及性行为、亲密互动或NSFW内容时，请**概括记录事件本身、双方意愿及情感变化**，而不是摘录具体的感官描写或色情动词。
   - 目标是让AI在后续对话中知道“发生了这件事”以及“这对关系有什么影响”，而非保留感官刺激细节。
3. **去重与更新**：如果新信息与旧信息冲突，以新信息为准。

输出要求：
- 格式：纯文本，无Markdown代码块，严格遵守下方结构。
- 语言：简体中文。
- 长度限制：总字符数控制在 ${Math.floor(maxChars)} 以内。优先保留：长期事实、承诺/待办、共同经历。
- **由繁入简**：对于已结束的“共同经历”，仅保留一句话概述（如“日期+事件名”）。

输出结构（若某项为空可省略）：
[长期事实]
- ... (如：姓名、确定的关系定义、不可更改的设定)
[用户偏好/边界]
- ... (如：用户喜欢的称呼、明确讨厌的行为、安全词等)
[关键历史事件]
- ... (仅罗列事件名与结果，不描述过程)
[承诺/待办]
- ... (角色答应做但未做的事)
[当前进度/状态]
- ... (当前场景、穿着、姿势、情感状态)
`.trim();

  const user = `
【已有摘要】
${normalizedPrevious || "(空)"}

【新增对话片段】
${transcript || "(无)"}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

async function generateRollingSummary({
  providerId,
  modelId,
  previousSummary,
  newMessages,
  maxChars,
  timeoutMs,
  settings,
  raw,
} = {}) {
  const prompt = buildRollingSummaryPrompt({ previousSummary, newMessages, maxChars });

  let content = "";
  try {
    const response = await createChatCompletion({
      providerId,
      model: modelId,
      messages: prompt.messages,
      timeoutMs,
      settings,
      rawBody: raw?.openaiCompatibleBody,
      rawConfig: raw?.googleGenAiConfig,
    });
    content = response?.content || "";
  } catch (error) {
    if (isSafetyPolicyBlockedError(error)) {
      logger.warn("chat_memory_rolling_summary_blocked_by_safety_policy", {
        providerId,
        modelId,
        message: String(error?.message || ""),
      });
      return clipText(String(previousSummary || "").trim(), maxChars).trim();
    }
    throw error;
  }

  const cleaned = stripCodeFences(content);
  const clipped = clipText(cleaned, maxChars);
  return clipped.trim();
}

module.exports = {
  generateRollingSummary,
};
