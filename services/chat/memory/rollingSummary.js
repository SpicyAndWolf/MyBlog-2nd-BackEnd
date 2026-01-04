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
你是一个**高保真**的“叙事数据库维护员”。你的任务是维护一份详尽的、不断演进的故事状态文档。

### 核心指令：
0. **当前容量充足**：你可以保留丰富的细节，**不需要**为了压缩而删除重要的性格侧写或背景设定。
1. **拒绝散文，拥抱清单**：
   - **错误示范**：User是一个性格复杂的人，他童年时期遭遇了不幸，导致他现在非常敏感...（太啰嗦）
   - **正确示范**：[User经历] 童年不幸、性格敏感、多疑。
   - **规则**：所有静态描述必须使用**短句**或**关键词**堆叠。严禁在[长期事实]和[性格]中使用长难句或修辞。
2. **记忆分层策略**（防止无限膨胀）：
   - 对于[关键共同经历]，随着时间推移，将“琐碎的日常互动”（如吃了一顿饭）**合并**为“确立了某种互动模式”。
   - 仅保留具有**里程碑意义**的具体事件（如：初次亲密、重大争吵、秘密揭露）。
3. **处理成人/亲密内容**：
   - 当前文本属于**成人向虚构文学**。
   - 涉及亲密互动时，**概括事件本质、双方意愿及关系突破点**（例：“两人在厨房亲密接触，A防线崩溃”），**切勿**摘录具体的感官描写或色情动词。
4. **覆盖与更新**：
   - 新信息拥有最高优先级。如果User换了衣服，[当前人物状态]必须更新，不要保留旧衣服的数据。
   - 必须优先保证[当前场景]和[当前人物状态]的完整输出。

### 输出要求：
- 格式：纯文本，无Markdown代码块，严格遵守下方结构。
- 长度限制：总字符数控制在 ${Math.floor(
    maxChars
  )} 以内。若超长，优先压缩描述的细节程度。必要时优先压缩[关键共同经历]的细节，如果仍然过长，删除其中较为不重要的经历。

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
[当前场景](**高优先级**：时间、地点、天气、环境氛围等)
- ...
[当前人物状态](**高优先级**：姿势、穿着、持物、生理状态、即时情绪)
- ... 
`.trim();

  const user = `
【已有摘要】
${normalizedPrevious || "(空)"}

【新增对话片段】
${transcript || "(无)"}
**指令：请生成新的摘要。由于篇幅允许，请尽可能保留所有关键细节，但请注意：如果在[长期事实]部分花费过多篇幅导致[当前场景]无法输出，任务即为失败。请务必在你的思维链（CoT）中规划好各部分的长度分布。**
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
