const { buildSystemPromptSegment } = require("./segments/systemPrompt");
const { buildAssistantGistNoticeSegment } = require("./segments/assistantGistNotice");
const { buildRollingSummarySegment } = require("./segments/rollingSummary");
const { buildGapBridgeSegment } = require("./segments/gapBridge");
const { buildRecentWindowSegment } = require("./segments/recentWindow");
const { assertContextState, assertSegmentResult } = require("./validateContextState");

/**
 * @typedef {Object} ChatMessage
 * @property {string} role
 * @property {string} content
 */

/**
 * @typedef {Object} ContextState
 * @property {string} systemPrompt
 * @property {boolean} rollingSummaryEnabled
 * @property {Object|null} memory
 * @property {{messages: ChatMessage[], stats?: any}|null} gapBridge
 * @property {{messages: ChatMessage[], stats?: any}} recent
 */

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

/**
 * @param {ContextState} contextState
 * @returns {ChatMessage[]}
 */
function buildContextSegments(contextState = {}) {
  assertContextState(contextState);
  const messages = [];

  for (const key of segmentOrder) {
    const builder = segmentBuilders[key];
    if (!builder) throw new Error(`Missing segment builder: ${key}`);
    const segment = builder(contextState);
    assertSegmentResult(segment, { name: `contextState.segment.${key}` });
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
