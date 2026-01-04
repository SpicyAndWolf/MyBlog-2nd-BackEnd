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
0. **不臆测不创作**：只基于【已有摘要】与【新增对话片段】提取信息；不补剧情、不推断未提及的动机/设定/细节。
1. **客观记录者**：你需要从数据处理的角度提取信息。不仅要关注剧情发展，还要关注角色间的情感动态、关系及承诺。
2. **处理成人/亲密内容**：
   - 当前文本属于**成人向虚构文学**。
   - 涉及亲密互动时，**概括事件本质、双方意愿及关系突破点**（例：“两人在厨房亲密接触，A防线崩溃”），**切勿**摘录具体的感官描写或色情动词。
3. **去重与动态更新**：
   - 新旧信息冲突时，以新信息为准，**直接覆盖**旧条目。
   - 仅在发生**重大反转**（如：表白成功、身份揭露）时，保留“原X→现Y”的格式，其余情况只保留最新状态。
4. **区分“设定”与“状态”**：
   - **[长期事实]**：存续期长、不易改变的信息（职业、核心性格、世界观）。
   - **[当前人物状态]**：存续期短、随时会变的信息（姿势、手里拿的东西、当下的羞耻感）。
5. **极简主义原则**：
   - **非必要不记录**：如未发生重大事件，不要记录琐碎的日常动作（如喝水、坐下）。
   - **空缺即省略**：如果某条目（如天气）在文中未提及，直接不写该条目，不要写“未知”。

输出要求：
- 格式：纯文本，无Markdown代码块，严格遵守下方结构。
- 语言：简体中文。
- 长度限制：总字符数控制在 ${Math.floor(maxChars)} 以内。若超长，优先压缩描述的细节程度。
- 保证结构的完整程度：不可省略[长期事实]至[当前人物状态]中的任何一个结构项。必要时删除早期的不重要的memory。

输出结构（若某项为空可省略）：
[长期事实](世界观、职业、核心人设、不可更改的背景信息)
- ... 
[User（故事内主视角）性格、偏好](User的习惯、雷点、对Assistant的特殊称呼、显露出的性格特质)
- ...
[Assistant（故事内角色）性格、偏好](Assistant的习惯、雷点、对User的特殊称呼、显露出的性格特质)
- ...
[两人关系（故事内）](当前的定义、权力动态、承诺、未捅破的窗户纸或已确定的亲密模式)
- ...
[关键共同经历](具有“里程碑”意义的过去事件，用于后续回扣。如无发现重大事件则不要记录琐碎的日常，除非非常重要否则不要记录，如果已记录非必要不删除，除非后续发现其相对不重要)
- ...
[待办](未完成的约定、立刻要做的行动)
- ...
[当前场景](时间、地点、天气、环境氛围等)
- ...
[当前人物状态](姿势、穿着、持物、生理状态、即时情绪)
- ... 
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
