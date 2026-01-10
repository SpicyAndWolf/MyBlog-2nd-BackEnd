function buildRecentWindowSegment({ recent } = {}) {
  if (!recent?.messages?.length) return null;
  return { messages: recent.messages };
}

module.exports = {
  buildRecentWindowSegment,
};

