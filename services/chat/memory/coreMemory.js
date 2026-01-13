const { createChatCompletion } = require("../../llm/chatCompletions");
const { logger } = require("../../../logger");
const { stripCodeFences, clipText } = require("./textUtils");

const CORE_MEMORY_HEADINGS = [
  "[长期事实/设定]",
  "[称呼/昵称]",
  "[边界/雷点]",
  "[偏好/禁忌]",
  "[关系阶段]",
  "[长期待办]",
];

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractHeadingLabel(heading) {
  const trimmed = String(heading || "").trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) return trimmed.slice(1, -1).trim();
  return trimmed;
}

const CORE_MEMORY_HEADING_DEFS = CORE_MEMORY_HEADINGS.map((canonical) => {
  const label = extractHeadingLabel(canonical);
  const escapedLabel = escapeRegExp(label);
  return {
    canonical,
    pattern: new RegExp(
      `^(?:#{1,6}\\s*)?(?:[-*]\\s*)?(?:\\[|【)?\\s*${escapedLabel}\\s*(?:\\]|】)?\\s*(?::|：)?\\s*$`
    ),
  };
});

function matchHeading(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return null;
  for (const def of CORE_MEMORY_HEADING_DEFS) {
    if (def.pattern.test(trimmed)) return def.canonical;
  }
  return null;
}

function normalizeText(value) {
  return String(value || "");
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

function stripListPrefix(line) {
  return line.replace(/^(?:[-*•]|\d+\.|[a-zA-Z]\.)\s+/, "").trim();
}

function normalizeCoreMemoryText(rawText, maxChars) {
  const cleaned = stripCodeFences(rawText).trim();
  if (!cleaned) return { text: "", valid: true };

  const lines = cleaned
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const sections = new Map();
  for (const heading of CORE_MEMORY_HEADINGS) {
    sections.set(heading, []);
  }

  let currentHeading = null;
  let sawHeading = false;

  for (const line of lines) {
    const matchedHeading = matchHeading(line);
    if (matchedHeading) {
      currentHeading = matchedHeading;
      sawHeading = true;
      continue;
    }

    if (!currentHeading) continue;
    const item = stripListPrefix(line);
    if (!item) continue;
    sections.get(currentHeading).push(item);
  }

  if (!sawHeading) {
    return { text: "", valid: false, reason: "missing_headings" };
  }

  let itemCount = 0;
  for (const items of sections.values()) itemCount += items.length;
  if (itemCount === 0) {
    return { text: "", valid: false, reason: "skeleton" };
  }

  const outputLines = [];
  for (const heading of CORE_MEMORY_HEADINGS) {
    outputLines.push(heading);
    const items = sections.get(heading) || [];
    for (const item of items) {
      outputLines.push(`- ${item}`);
    }
  }

  return { text: clipText(outputLines.join("\n"), maxChars).trim(), valid: true };
}

function buildCoreMemoryPrompt({ previousCoreMemoryText, rollingSummaryText, deltaMessages, maxChars }) {
  const normalizedPrevious = String(previousCoreMemoryText || "").trim();
  const normalizedSummary = String(rollingSummaryText || "").trim();
  const transcript = formatTranscript(deltaMessages);

  const system = `
你是「Core Memory 维护器」，负责输出长期稳定的核心记忆文本。
输出必须严格遵循固定结构与顺序：
${CORE_MEMORY_HEADINGS.join("\n")}

绝对约束：
0. 只输出正文，不要解释/前后缀/代码块。
1. 只保留长期稳定、可复用的信息；短期剧情细节不要写入。
2. 不确定或有冲突就标注“待澄清”，严禁编造。
3. 在上一版基础上增量更新，但输出必须严格归一为上述固定结构与顺序；若上一版格式不规范，请纠正。
4. 一行一条，使用短语化表达，不写长句。
5. 总长度不超过 ${maxChars} 字符。
6. 若没有任何可写内容，输出空字符串。
7. 标题独占一行；标题下每条以 "- " 开头。
`.trim();

  const user = `
【已有 core memory】
${normalizedPrevious || "(空)"}

【rolling summary（历史摘要）】
${normalizedSummary || "(空)"}

【最近增量对话】
${transcript || "(无)"}
`.trim();

  return {
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };
}

async function generateCoreMemory({
  providerId,
  modelId,
  previousCoreMemoryText,
  rollingSummaryText,
  deltaMessages,
  maxChars,
  timeoutMs,
  settings,
  raw,
} = {}) {
  const prompt = buildCoreMemoryPrompt({ previousCoreMemoryText, rollingSummaryText, deltaMessages, maxChars });
  logger.debug("chat_memory_core_request", {
    providerId,
    modelId,
    maxChars,
    deltaMessagesCount: Array.isArray(deltaMessages) ? deltaMessages.length : 0,
    messages: prompt.messages,
  });

  const response = await createChatCompletion({
    providerId,
    model: modelId,
    messages: prompt.messages,
    timeoutMs,
    settings,
    rawBody: raw?.openaiCompatibleBody,
    rawConfig: raw?.googleGenAiConfig,
  });

  const rawText = String(response?.content || "");
  const normalized = normalizeCoreMemoryText(rawText, maxChars);

  logger.debug("chat_memory_core_response", {
    providerId,
    modelId,
    rawText,
    normalized: normalized.text,
    valid: normalized.valid,
    reason: normalized.reason,
    normalizedChars: normalized.text.length,
  });

  return normalized;
}

module.exports = {
  generateCoreMemory,
};
