const { chatConfig } = require("../../config");

const DEFAULT_MAX_CONTEXT_MESSAGES = chatConfig.maxContextMessages;
const DEFAULT_MAX_CONTEXT_CHARS = chatConfig.maxContextChars;

function normalizeText(value) {
  return String(value || "");
}

function buildOpenAiChatMessages({ systemPrompt, historyMessages } = {}) {
  const output = [];

  const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
  if (normalizedSystemPrompt) {
    output.push({ role: "system", content: normalizedSystemPrompt });
  }

  const normalizedMaxMessages = DEFAULT_MAX_CONTEXT_MESSAGES;
  const normalizedMaxChars = DEFAULT_MAX_CONTEXT_CHARS;

  const history = Array.isArray(historyMessages) ? historyMessages : [];

  const selected = [];
  let totalChars = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i] || {};
    const role = String(entry.role || "").trim();
    const content = normalizeText(entry.content);
    if (!role || !content) continue;
    if (selected.length >= normalizedMaxMessages) break;

    const nextChars = totalChars + content.length;
    if (nextChars > normalizedMaxChars && selected.length > 0) break;

    selected.push({ role, content });
    totalChars = nextChars;
  }

  selected.reverse();
  output.push(...selected);
  return output;
}

module.exports = {
  buildOpenAiChatMessages,
};
