const DEFAULT_MAX_CONTEXT_MESSAGES = 500;
const DEFAULT_MAX_CONTEXT_CHARS = 96000;

function clampNumber(value, { min, max }) {
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function normalizeText(value) {
  return String(value || "");
}

function buildOpenAiChatMessages({
  systemPrompt,
  historyMessages,
  maxContextMessages = DEFAULT_MAX_CONTEXT_MESSAGES,
  maxContextChars = DEFAULT_MAX_CONTEXT_CHARS,
} = {}) {
  const output = [];

  const normalizedSystemPrompt = normalizeText(systemPrompt).trim();
  if (normalizedSystemPrompt) {
    output.push({ role: "system", content: normalizedSystemPrompt });
  }

  const normalizedMaxMessages = clampNumber(maxContextMessages, { min: 1, max: 200 }) ?? DEFAULT_MAX_CONTEXT_MESSAGES;
  const normalizedMaxChars = clampNumber(maxContextChars, { min: 1000, max: 200000 }) ?? DEFAULT_MAX_CONTEXT_CHARS;

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
