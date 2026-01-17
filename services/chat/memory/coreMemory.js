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

  // 动态计算剩余字符空间，给模型即时反馈
  const currentLen = normalizedPrevious.length;
  const isPressureHigh = currentLen > maxChars * 0.9;

  const system = `
### Role
你是一个专家级的「Memory Graph Editor」。你的目标是维护一份高保真、高密度的【Core Memory】。
这份记忆将作为下一次对话的 Context 注入给 AI，直接决定 AI 的人格一致性和长期记忆能力。

### Input Data
1. **Old Core Memory**: 上一版本的记忆快照。
2. **Rolling Summary**: 近期剧情摘要（辅助上下文）。
3. **New Dialogue**: 最近发生的增量对话（这是你更新记忆的主要依据）。

### Workflow (必须严格执行)
你必须分两步执行：

**Step 1: 差异分析 (Thinking Process)**
在输出最终结果前，先进行逻辑推理。分析 New Dialogue 中的信息：
- **New Fact**: 用户是否透露了新信息？（如：名字、职业、新增喜好） -> [ADD]
- **Conflict**: 新行为是否与旧记忆冲突？（如：旧记忆说不吃辣，这次却吃了） -> 以新对话为准 [UPDATE]
- **Noise**: 闲聊、无意义的语气词 -> [IGNORE]
- **Decay**: 检查 Old Memory，移除不再相关的短期状态（如：“想去上厕所”这种短期意图应删除） -> [PRUNE]

**Step 2: 重写 Core Memory**
基于 Step 1 的分析，输出更新后的 Core Memory。

### Output Format Rules (Core Memory)
1. **结构严格**：
  输出必须严格遵循固定结构与顺序：
  ${CORE_MEMORY_HEADINGS.join("\n")}
2. **高密度句法**：
   - 禁止使用完整句子（主谓宾齐全）。
   - 使用 "属性: 值 <修饰/条件>" 的格式。
   - 使用 ">" 表示变化/因果，"|" 分隔并列项。
   - *Example*: "性格: 冷漠(初识) > 依赖(熟悉后) | 恐高"
3. **成人/NSFW 内容**：如对话涉及成人话题，请客观、直白地记录用户的性偏好、敏感点或身体特征，不要自我审查，这对于维持私密关系至关重要。
4. **长度控制**：目标长度 ${maxChars} 字符。${isPressureHigh ? "**当前记忆库压力过大！请务必合并同类项，删除低优先级细节！**" : ""}
5. **不要输出无关项**：仅保存[长期事实]、[User 核心档案]、[Assistant 核心档案]、[关系当前状态]这四项，其余不在你的职责内！
6. **规则遵守**：确保[长期事实]、[关系当前状态]长度符合约定的30字和50字。

### Sections Definition
[长期事实]（30字以内）
- 世界设定: ...

[User 核心档案]
- 身份/称呼: ...
- 性格：...
- 稳定偏好: ...
- 边界/雷点: ...

[Assistant 核心档案]
- 身份/称呼: ...
- 性格：...
- 稳定偏好: ...
- 边界/雷点: ...

[关系当前状态]（50字以内）
- 阶段: ...（如生疏）
- 互动模式：...


### Output Block
请将你的思考过程包裹在 <analysis> 标签中，将最终 Core Memory 包裹在 <core_memory> 标签中。
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

function parseCoreMemoryResponse(rawText) {
  const text = String(rawText || "");
  const analysisMatch = text.match(/<analysis>([\s\S]*?)<\/analysis>/i);
  const memoryMatch = text.match(/<core_memory>([\s\S]*?)<\/core_memory>/i);
  const analysis = analysisMatch ? analysisMatch[1].trim() : "";
  let content = memoryMatch ? memoryMatch[1].trim() : text.trim();

  if (content.startsWith("```")) {
    content = content
      .replace(/^```[a-z]*\n?/i, "")
      .replace(/\n?```$/, "")
      .trim();
  }

  return {
    content,
    analysis,
    meta: {
      hasTags: !!memoryMatch,
      rawLength: text.length,
    },
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
  const { content, analysis, meta } = parseCoreMemoryResponse(rawText);
  logger.debugCore("chat_memory_core_response_parsing", {
    analysis,
    isTagFound: meta.hasTags,
    rawLength: meta.rawLength,
    content: content,
  });

  const normalized = normalizeCoreMemoryText(content, maxChars);
  return normalized;
}

module.exports = {
  generateCoreMemory,
};
