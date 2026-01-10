function buildGapBridgeSegment({ gapBridge } = {}) {
  if (!gapBridge?.messages?.length) return null;
  return { messages: gapBridge.messages };
}

module.exports = {
  buildGapBridgeSegment,
};

