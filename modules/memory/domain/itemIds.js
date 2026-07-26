const { ITEM_SECTIONS } = require("../contracts");

const ITEM_ID_ALLOCATION_ATTEMPTS = 10;
const ITEM_ID_ALLOCATION_ERROR_CODE = "MEMORY_ITEM_ID_ALLOCATION_FAILED";
const SECTION_ITEM_ID_PREFIX = Object.freeze({
  todos: "todo",
  standingAgreements: "agreement",
  recentEpisodes: "episode",
  milestones: "milestone",
  worldFacts: "worldFact",
  userProfile: "userProfile",
  assistantProfile: "assistantProfile",
  relationship: "relationship",
});

function sectionItems(state, section) {
  if (!ITEM_SECTIONS.includes(section)) throw new Error(`Unknown Memory item section: ${section}`);
  return ["todos", "standingAgreements", "recentEpisodes"].includes(section)
    ? state.working[section]
    : state.longTerm[section];
}

function allMemoryItemIds(state) {
  return ITEM_SECTIONS.flatMap((section) => sectionItems(state, section)).map((item) => item.id);
}

function allocateMemoryItemId(state, section, idFactory) {
  if (typeof idFactory !== "function") throw new Error("Memory item id factory is required");
  const prefix = SECTION_ITEM_ID_PREFIX[section];
  if (!prefix) throw new Error(`Memory item id prefix is unavailable for section: ${section}`);
  const existing = new Set(allMemoryItemIds(state));
  for (let attempt = 0; attempt < ITEM_ID_ALLOCATION_ATTEMPTS; attempt += 1) {
    const id = `${prefix}:${idFactory()}`;
    if (!existing.has(id)) return id;
  }
  const error = new Error("Unable to allocate a unique Memory item id");
  error.code = ITEM_ID_ALLOCATION_ERROR_CODE;
  throw error;
}

module.exports = {
  ITEM_ID_ALLOCATION_ATTEMPTS,
  ITEM_ID_ALLOCATION_ERROR_CODE,
  SECTION_ITEM_ID_PREFIX,
  allocateMemoryItemId,
};
