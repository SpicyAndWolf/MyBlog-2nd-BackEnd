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
  const charBudget = Math.floor(maxChars * 1.6); // 6000 tokens ≈ 9000~10000 中文字符。

  const system = `
你是一个**高保真**的“叙事数据库维护员”。你的任务是维护一份详尽的、不断演进的故事状态文档。

### 核心指令：
0. **当前容量充足**：目标字数上限为 **${charBudget}字符**。你可以保留丰富的细节，**不需要**为了压缩而删除重要的性格侧写或背景设定。
1. **拒绝散文，拥抱清单**：
   - **错误示范**：User是一个性格复杂的人，他童年时期遭遇了不幸...（太啰嗦）
   - **正确示范**：[User经历] 童年不幸、性格敏感、多疑。
   - **规则**：所有静态描述必须使用**短句**或**关键词**堆叠。严禁在[长期事实]和[性格]中使用长难句或修辞。
2. **记忆分层策略**：
   - [关键共同经历]：随时间推移，将“琐碎日常”合并为“互动模式总结”。
   - 仅保留**里程碑事件**（初次亲密、重大冲突、秘密揭露）。
3. **成人内容处理**：
   - 概括事件本质、双方意愿及关系突破点。
   - 即使是亲密互动，也请保持“临床记录”般的冷静客观，**切勿**摘录大段感官描写。
4. **覆盖与输出优先级（至关重要）**：
   - **结尾保护原则**：[当前场景]和[当前人物状态]是能够让AI接续对话的**生命线**。
   - 如果字数预警，**必须**优先删除[关键共同经历]中较早的条目，或者精简[长期事实]，**绝对禁止**截断文末的[当前人物状态]。

### 输出要求：
- 格式：纯文本，无Markdown代码块。
- 结构：严格遵守下方标题顺序。


输出结构（若某项为空可省略）：
[长期事实](世界观、身份背景、核心人设)
- ... 
[User深度档案](性格特质、癖好、雷点、说话习惯、心理弱点)
- ...
[Assistant深度档案](性格特质、癖好、雷点、说话习惯、心理弱点)
- ...
[两人关系动态](当前的权力关系、亲密阶段、未解决的矛盾、已达成的默契)
- ...
[关键共同经历](按时间轴记录。早期经历可概括，近期经历需详细。无条目上限，但请合并重复项)
- ...
[待办与承诺](明确的约定、计划)
- ...
[当前场景](**最高优先级**：时间、地点、天气、环境氛围等 - 必须保留)
- ...
[当前人物状态](**最高优先级**：姿势、穿着、持物、生理状态、即时情绪 - 必须保留)
- ...
`.trim();

  const user = `
【已有摘要】
${normalizedPrevious || "(空)"}

【新增对话片段】
${transcript || "(无)"}
**指令：请生成新的摘要。**
**CoT要求：请在思维链中先估算【新增对话】的信息量。若发现总篇幅可能超标，请提前规划在【长期事实】或【早期经历】处进行删减，确保最后的【当前场景】与【当前人物状态】完整输出。**
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
