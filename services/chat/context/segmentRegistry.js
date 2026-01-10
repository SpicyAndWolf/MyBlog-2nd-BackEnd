function buildSystemPromptSegment({ normalizedSystemPrompt } = {}) {
  if (!normalizedSystemPrompt) return null;
  return { messages: [{ role: "system", content: normalizedSystemPrompt }] };
}

function buildAssistantGistNoticeSegment({ assistantGistNoticeContent } = {}) {
  if (!assistantGistNoticeContent) return null;
  return { messages: [{ role: "system", content: assistantGistNoticeContent }] };
}

function buildRollingSummarySegment({ rollingSummaryMessage } = {}) {
  if (!rollingSummaryMessage) return null;
  return { messages: [{ role: "system", content: rollingSummaryMessage }] };
}

function buildGapBridgeSegment({ gapBridge } = {}) {
  if (!gapBridge?.messages?.length) return null;
  return { messages: gapBridge.messages };
}

function buildRecentWindowSegment({ recent } = {}) {
  if (!recent?.messages?.length) return null;
  return { messages: recent.messages };
}

const segmentOrder = [
  "systemPrompt",
  "assistantGistNotice",
  "rollingSummary",
  "gapBridge",
  "recentWindow",
];

const segmentBuilders = {
  systemPrompt: buildSystemPromptSegment,
  assistantGistNotice: buildAssistantGistNoticeSegment,
  rollingSummary: buildRollingSummarySegment,
  gapBridge: buildGapBridgeSegment,
  recentWindow: buildRecentWindowSegment,
};

function buildContextSegments(contextState = {}) {
  const messages = [];

  for (const key of segmentOrder) {
    const builder = segmentBuilders[key];
    if (!builder) throw new Error(`Missing segment builder: ${key}`);
    const segment = builder(contextState);
    if (!segment?.messages?.length) continue;
    messages.push(...segment.messages);
  }

  return messages;
}

module.exports = {
  segmentOrder,
  segmentBuilders,
  buildContextSegments,
};
