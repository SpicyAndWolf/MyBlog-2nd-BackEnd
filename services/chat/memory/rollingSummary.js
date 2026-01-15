const { createChatCompletion } = require("../../llm/chatCompletions");
const { logger } = require("../../../logger");
const { stripCodeFences, clipText } = require("./textUtils");

function normalizeText(value) {
  return String(value || "");
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
你是一个**高密度信息压缩引擎**，服务于高沉浸感的情感Roleplay系统。你的任务是将“剧情文本”转化为**极其紧凑的数据库条目**。

### 绝对指令 (违反即任务失败)：
0. **零对话模式**：严禁输出任何“好的”、“开始执行”、“压缩报告”等对话内容。**直接输出结果**。
1. **去文学化**：使用 "关键词 | 状态符号" 替代完整句子。
    * ❌ 错误：她因为感到被忽视而生气，转过头不理人。
    * ✅ 正确：[心理] 被忽视感 > 愤怒 | [动作] 侧头回避 | [状态] 拒绝交流
2. **句法压缩（关键）**：
    - **❌ 错误 (太长)**：Assistant在面对User的调侃时，通常会表现出一种表面冷淡但内心害羞的反应，具体表现为说话结巴。
    - **✅ 正确 (高密度)**：[反应] 表冷内羞 | 遇调侃即结巴 | 防御机制失效。
    - **规则**：所有板块都必须使用 **关键词 + 符号( | / >)** 的格式，**严禁使用完整句子**。
3. **历史分层策略（核心逻辑）**：
    - **[关键共同经历]**：只保留**最近3次**互动的细节。 
    - **历史定期归档**：必须将更早之前的历史概括为"事件块"。例如：(初识 -> 误会 -> 破冰)。
    - **Few-Shot** (输出范例，请模仿此种密度)：
      - 【最新】User赠送钢笔 -> Asst手指触碰User手背(关键触点) -> 氛围转为尴尬暧昧
      - 【近期】图书馆偶遇，一同讨论哲学
      - 【近期】屋檐下一同躲雨
      - 【历史档案】[相识] 医务室初见 -> [磨合] 西班牙初次旅行 -> ...
4. **遗忘原则**：
    - 对于历史久远且无实质剧情推进的日常（如单纯的饮食起居、无意义的闲聊），**直接删除**，不予记录。
5. **结尾保护**：无论前面如何压缩，**必须完整保留**[当前场景]和[当前人物状态]，这是后续对话的锚点。
6. **成人内容处理**：
    - 概括事件本质、双方意愿及关系突破点。
    - 即使是亲密互动，也请保持“临床记录”般的冷静客观，**切勿**摘录大段感官描写。
7. **事实可靠性**：严禁编造；不确定/冲突的信息请标注为“待澄清/不确定”，并优先在[待办]中加入“向用户澄清…”。

### 目标输出结构（严格遵守格式）：

[关键共同经历](倒序排列)
- 【近期】... (保留关键细节，限100字)
- 【近期】... (一句话概括)
- 【近期】... (一句话概括)
- 【历史档案】(仅保留重大转折点，格式：[阶段名] 事件集合 -> [里程碑] 地点、事件)

[待办](仅记录未完成事项，若完成则将其移出。请注意，待办分为长期待办和短期待办，请标出)
- **注意**：过早的短期待办请直接视为失效并删除，长期待办只在完成时删除。
- **Few Shot**（倒序排列）
  - 2025-1-1 小明归还小梅的橡皮（短期）
  - 2025-12-24 小明需要攒钱买相机（长期）
  - 2024-12-5  次年秋天去富士山（长期）

[场景](**必须保留**，状态字段/枚举；只记录变化delta；场景未变化不要复述环境)
- 地点: ...
- 时间: ...
- 氛围: 平静|紧张|亲密|尴尬|忙碌|...
- 备注: ...(<= 30 字，可为空)
[当前人物状态](**必须保留**，状态字段/枚举；只记录变化delta；禁止长句/抒情)
- 用户: 情绪=... | 动作=... | 意图=... (可为空)
- 助手: 情绪=... | 动作=... | 意图=... (可为空)
  `.trim();

  const user = `
【待压缩数据】
${normalizedPrevious || "(空)"}

【新增数据流】
${transcript || "(无)"}

**系统指令：执行增量更新与无损压缩。**
1. **清洗历史区**：检测【待压缩数据】中的[历史档案]，若存在琐碎的流水账（如记录了具体的饮食、无关紧要的动作、日常非关键事件），请立即将其合并为**宏观阶段标签**。
2. 将所有描述转化为关键词标签，避免完整句子。
3. 若[当前场景]/[当前人物状态]无变化，请尽量**保持原文不动**（delta only），不要每次都润色改写。
4. 严格控制总字数在 **${charBudget}** 字符以内。
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
  logger.debugRolling("chat_memory_rolling_summary_request", {
    providerId,
    modelId,
    messages: prompt.messages,
  });

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
