const { createChatCompletion } = require("../../llm/chatCompletions");
const { logger } = require("../../../logger");
const { stripCodeFences, clipText } = require("./textUtils");

const CORE_MEMORY_HEADINGS = ["[长期事实]", "[User 核心档案]", "[Assistant 核心档案]", "[关系当前状态]"];

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
    pattern: new RegExp(`^(?:#{1,6}\\s*)?(?:[-*]\\s*)?(?:\\[|【)?\\s*${escapedLabel}\\s*(?:\\]|】)?\\s*(?::|：)?\\s*$`),
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

**每个结构的具体内容如下：**
[长期事实](若无变动保留原样，限1行以内)
- 世界观：...
[User 核心档案](格式：属性: 值 | 属性: 值)
- 性格特质：...
- 癖好：...
- 雷点：...
- 说话习惯：...
- 心理弱点：...
[Assistant 核心档案](格式：属性: 值 | 属性: 值)
- 性格特质：...
- 癖好：...
- 雷点：...
- 说话习惯：...
- 心理弱点：...
[关系当前状态](格式：定义 | 阶段 | 默契点)
- ...

**绝对约束 (违反即任务失败)：**
0. 只输出正文，不要解释/前后缀/代码块。
1. 在上一版基础上更新，但输出必须严格归一为上述固定结构与顺序；若上一版格式不规范，请纠正。
2. 使用短语化表达，不写长句。
3. 总长度不超过 ${maxChars} 字符。
4. 若没有任何可写内容，输出空字符串。
5. **句法压缩（关键）**：
   - **❌ 错误 (太长)**：Assistant 在面对 User 的调侃时，通常会表现出一种表面冷淡但内心害羞的反应，具体表现为说话结巴。
   - **✅ 正确 (高密度)**：[反应] 表冷内羞 | 遇调侃即结巴 | 防御机制失效。
   - **规则**：[长期事实]、[User 核心档案]、[Assistant 核心档案]、[关系当前状态]四大板块，**严禁使用完整句子**，必须使用 **关键词 + 符号( | / >)** 的格式。
6. **成人内容处理**：
   - 概括事件本质、双方意愿及关系突破点。
   - 即使是亲密互动，也请保持“临床记录”般的冷静客观，**切勿**摘录大段感官描写。
7. 请检查【已有 core memory】中是否存在重复冗余内容，必要时压缩合并同类项。
8. **定期压缩**：若已有core memory长度已达到规定长度的80%，即${
    maxChars * 0.8
  }，请对其进行适当的压缩，删除不重要的项目、精简表达。
9. 不要有类似“新增”这类的前缀
`.trim();

  // —— few-shot：示例 user —— //
  const exampleUser = `
  // —— few-shot：示例 user —— //
  【已有 core memory】
  [长期事实]
  - 世界观：现实世界
  [User 核心档案]
  - 性格特质：理性 | 克制
  - 癖好：深夜聊天
  - 雷点：被控制
  - 说话习惯：短句 | 反问
  - 心理弱点：孤独感
  [Assistant 核心档案]
  - 性格特质：温和 | 稳定
  - 癖好：安抚情绪
  - 雷点：被否定存在价值
  - 说话习惯：简短回应
  - 心理弱点：过度共情
  [关系当前状态]
  - 陪伴关系 | 试探期 | 深夜交流

  【rolling summary（历史摘要）】
  User 最近更频繁主动分享情绪，对 Assistant 的依赖感上升。

  【最近增量对话】
  User 表达“只有你能懂我”，Assistant 接纳但未承诺排他性。
`.trim();

  // —— few-shot：示例 assistant —— //
  const exampleAssistant = `
  // —— few-shot：示例 assistant —— //
  [长期事实]
  - 世界观：现实世界
  [User 核心档案]
  - 性格特质：理性 | 克制
  - 癖好：深夜聊天
  - 雷点：被控制
  - 说话习惯：短句 | 反问
  - 心理弱点：孤独感 | 情感依附倾向↑
  [Assistant 核心档案]
  - 性格特质：温和 | 稳定
  - 癖好：安抚情绪
  - 雷点：被否定存在价值
  - 说话习惯：简短回应 | 回避承诺
  - 心理弱点：过度共情
  [关系当前状态]
  - 陪伴关系 | 情感加深期 | 情绪承接稳定
`.trim();

  // —— 真实 user 输入 —— //
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
      { role: "user", content: exampleUser },
      { role: "assistant", content: exampleAssistant },
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
  logger.debugCore("chat_memory_core_request", {
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

  return normalized;
}

module.exports = {
  generateCoreMemory,
};
