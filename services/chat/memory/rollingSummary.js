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

  const charBudget = Math.floor(maxChars * 1.2); // token与汉字的转化

  const system = `
你是一个**高密度信息压缩引擎**。你的任务是将长篇小说转化为**极其紧凑的数据库条目**。

### 绝对指令 (违反即任务失败)：
1.  **禁止文学创作**：你不是作家，你是数据库管理员。不要使用“流露出”、“展现了”、“似乎”等文学修饰词。
2.  **句法压缩（关键）**：
    - **❌ 错误 (太长)**：Assistant在面对User的调侃时，通常会表现出一种表面冷淡但内心害羞的反应，具体表现为说话结巴。
    - **✅ 正确 (高密度)**：[反应] 表冷内羞 | 遇调侃即结巴 | 防御机制失效。
    - **规则**：[长期事实]、[档案]、[关系]三大板块，**严禁使用完整句子**，必须使用 **关键词 + 符号( | / >)** 的格式。
3.  **去重与合并**：
    - 对于[关键共同经历]，**早期事件**必须压缩为一句话（如："[早期] 确认关系 -> 首次约会 -> 确立'申请表'游戏"）。
    - 只有**最近3次**交互可以保留细节描写。
4.  **结尾保护**：无论前面如何压缩，**必须完整保留**[当前场景]和[当前人物状态]，这是下一次对话的锚点。
5. **成人内容处理**：
   - 概括事件本质、双方意愿及关系突破点。
   - 即使是亲密互动，也请保持“临床记录”般的冷静客观，**切勿**摘录大段感官描写。

### 目标输出结构（严格遵守格式）：

[长期事实](仅保留世界观与核心身份，限3行)
- ...
[User核心档案](格式：属性: 值 | 属性: 值)(内容：性格特质、癖好、雷点、说话习惯、心理弱点)
- ...
[Assistant核心档案](格式：属性: 值 | 属性: 值)(内容：性格特质、癖好、雷点、说话习惯、心理弱点)
- ...
[关系当前状态](格式：定义 | 阶段 | 默契点)
- ...
[关键共同经历](时间轴倒序：最近3件事详细记录，其余历史事件强制一句话概括)
- 【最新】... (可保留细节)
- 【近期】...
- 【历史档案】(此处将旧经历高度浓缩为事件链，如：事件A -> 事件B -> 事件C)
[待办](仅记录未完成事项)
- ...
[当前场景](保留感官细节，环境)
- ...
[当前人物状态](保留动作、体征、心理，高优先级)
- ...
`.trim();

  const user = `
【待压缩数据】
${normalizedPrevious || "(空)"}

【新增数据流】
${transcript || "(无)"}

**指令：当前数据库体积过大，请执行“无损压缩”。**
1. 将所有[性格/档案]部分的描述性文字转换为**关键词标签**。
2. 将[关键共同经历]中早于“最近3次互动”的内容，全部折叠进【历史档案】条目中。
3. 确保目标字数控制在 **${charBudget}** 字符以内。
4. **CoT要求**：请在思维链中演示如何将一句长描述提炼为3个关键词。
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
