const crypto = require("node:crypto");
const {
  LIBRARIAN_PROPOSER,
  LIBRARIAN_SECTIONS,
  LIBRARIAN_TARGET_KEY,
  validateLibrarianArtifact,
} = require("../contracts");
const { REF_PREFIX, SECTION_LABELS, sectionPath } = require("./proposerTaskRenderer");

function sectionItems(state, section) {
  const [container, key] = sectionPath(section);
  return state[container][key];
}

function renderLibrarianMemory(state) {
  const writable = {};
  const blocks = [];
  for (const section of LIBRARIAN_SECTIONS) {
    const lines = [];
    let index = 0;
    for (const item of sectionItems(state, section)) {
      index += 1;
      const ref = `${REF_PREFIX[section]}${index}`;
      writable[ref] = { section, itemId: item.id };
      lines.push(`${ref} | ${item.text}`);
    }
    blocks.push(`[${SECTION_LABELS[section]}]\n${lines.length ? lines.join("\n") : "(无)"}`);
  }
  return { memoryText: blocks.join("\n\n"), refMap: { writable, readOnly: {} } };
}

function buildLibrarianEnvelope({
  userId,
  presetId,
  state,
  boundaryMessageId,
  turnOrdinal,
  triggerType,
  now = new Date(),
  userTimeZone,
  taskId = crypto.randomUUID(),
  tickId = Date.now(),
} = {}) {
  const rendered = renderLibrarianMemory(state);
  const publicTask = {
    taskId,
    tickId,
    proposer: LIBRARIAN_PROPOSER,
    targetKey: LIBRARIAN_TARGET_KEY,
    targetSections: LIBRARIAN_SECTIONS.slice(),
    boundaryMessageId,
    turnOrdinal,
    triggerType,
    now: new Date(now).toISOString(),
    userTimeZone,
  };
  const artifact = {
    publicInput: { task: publicTask, memoryText: rendered.memoryText, messages: [] },
    refMap: rendered.refMap,
    messageMeta: {},
  };
  const validation = validateLibrarianArtifact(artifact);
  if (!validation.ok) {
    const error = new Error(`Invalid Librarian Renderer artifact: ${validation.errors.map((entry) => `${entry.path} ${entry.message}`).join("; ")}`);
    error.code = "MEMORY_LIBRARIAN_ARTIFACT_INVALID";
    error.validationErrors = validation.errors;
    throw error;
  }
  return {
    task: {
      ...publicTask,
      userId: Number(userId),
      presetId: String(presetId),
      schemaVersion: state.version,
      sourceGeneration: state.meta.sourceGeneration,
      baseRevision: state.meta.revision,
      mode: "librarian",
      observedMessageIds: [],
      trigger: { type: triggerType, boundaryMessageId, turnOrdinal },
    },
    artifact,
  };
}

function librarianDedupeKey(task) {
  return ["maintenance", "librarian", task.sourceGeneration, task.triggerType, task.turnOrdinal, task.boundaryMessageId, task.baseRevision].join(":");
}

module.exports = { renderLibrarianMemory, buildLibrarianEnvelope, librarianDedupeKey };
