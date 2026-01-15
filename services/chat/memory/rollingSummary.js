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
3. **去档案化（本迭代重点）**：
    - 本滚动摘要**不维护长期档案**，严禁输出以下板块：[长期事实]、[User核心档案]、[Assistant核心档案]、[关系当前状态]、[关键共同经历]、[历史档案]。
    - 长期档案/偏好/边界/称呼/关系阶段/长期事实 等交由 core_memory；这里仅保留与“剧情推进/当前状态/未闭环事项”直接相关的信息。
4. **剧情分层策略（核心逻辑）**：
    - **[近期关键事件]**：只保留**最近3条**关键事件的细节（倒序；每条<=100字）。
    - **[剧情进展]**：更早之前的历史压缩为"阶段/里程碑链条"（例如：[初识] -> [误会] -> [破冰] -> ...），不写流水账。
    - **Few-Shot** (输出范例，请模仿此种密度)：
      - [剧情进展] [相识] 医务室初见 -> [磨合] 西班牙初次旅行 -> [破冰] ...
      - [近期关键事件] 【最新】User赠送钢笔 -> Asst手指触碰User手背(关键触点) -> 氛围=尴尬暧昧
      - [近期关键事件] 【近期】图书馆偶遇 | 一同讨论哲学
5. **遗忘原则**：
    - 对于历史久远且无实质剧情推进的日常（如单纯的饮食起居、无意义的闲聊），**直接删除**，不予记录。
6. **状态中性化（反模板/反自回声）**：
    - **必须保留**[当前场景]与[当前人物状态]，但只能写成**状态字段/枚举 + 短语**，禁止长句/比喻/固定意象。
    - **只记录变化（delta）**：若与【待压缩数据】相比无变化，保持原样，不要反复改写与复述环境。
    - 这些字段是“状态数据”，不是输出模板；避免任何可直接照抄成下一轮回复的文案。
7. **成人内容处理**：
    - 概括事件本质、双方意愿及关系突破点。
    - 即使是亲密互动，也请保持“临床记录”般的冷静客观，**切勿**摘录大段感官描写。
8. **事实可靠性**：严禁编造；不确定/冲突的信息请标注为“待澄清/不确定”，并优先在[open loops]中加入“向用户澄清…”。

### 目标输出结构（严格遵守格式）：

[剧情进展](按阶段/里程碑概括；仅剧情相关；非流水账)
- ...
[近期关键事件](倒序；保留最近3条；每条<=100字)
- 【最新】...
- 【近期】...
- 【近期】...

[open loops](未闭环/待澄清/未完成承诺；可标注：进行中/已解决/待确认)
- ...
[当前场景](**必须保留**，状态字段/枚举；只记录变化delta；场景未变化不要复述环境)
- 地点: ...
- 时间: ...
- 私密性: 公开|半私密|私密
- 氛围: 平静|紧张|亲密|尴尬|忙碌|...
- 备注: ...(<= 30字，可为空)
[当前人物状态](**必须保留**，状态字段/枚举；只记录变化delta；禁止长句/抒情)
- 用户: 情绪=... | 动作=... | 意图=... | 边界=...(可为空)
- 助手: 情绪=... | 动作=... | 意图=... | 边界=...(可为空)
  `.trim();

  const user = `
【待压缩数据】
${normalizedPrevious || "(空)"}

【新增数据流】
${transcript || "(无)"}

**系统指令：执行增量更新与无损压缩。**
1. **去档案化**：若【待压缩数据】包含旧结构（如 [长期事实]/[User核心档案]/[Assistant核心档案]/[关系当前状态]/[关键共同经历]/[历史档案]/[待办]），请不要延续这些板块；按“目标输出结构”重写。
2. **清洗历史区**：将更早历史合并为**阶段/里程碑链条**，删除琐碎流水账（如具体饮食、无关紧要动作、日常非关键事件）。
3. 将所有描述转化为关键词标签，避免完整句子。
4. 若[当前场景]/[当前人物状态]无变化，请尽量**保持原文不动**（delta only），不要每次都润色改写。
5. 严格控制总字数在 **${charBudget}** 字符以内。
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
