const FLAT_WIRE_STATUSES = Object.freeze(["changes", "noop", "unable_to_decide"]);

const FLAT_WIRE_PROPOSER_SECTIONS = Object.freeze({
  currentStateProposer: Object.freeze(["scene"]),
  todoProposer: Object.freeze(["todos"]),
  agreementProposer: Object.freeze(["standingAgreements"]),
  episodeProposer: Object.freeze(["recentEpisodes", "milestones"]),
  profileRelationshipProposer: Object.freeze(["userProfile", "assistantProfile", "relationship"]),
  userProfileProposer: Object.freeze(["userProfile"]),
  assistantProfileProposer: Object.freeze(["assistantProfile"]),
  relationshipProposer: Object.freeze(["relationship"]),
  worldFactProposer: Object.freeze(["worldFacts"]),
});

function isFlatWireProposer(proposer) {
  return Object.prototype.hasOwnProperty.call(FLAT_WIRE_PROPOSER_SECTIONS, proposer);
}

function flatWireSections(proposer, targetSections) {
  const configured = FLAT_WIRE_PROPOSER_SECTIONS[proposer];
  if (!configured) throw new Error(`Flat Memory wire protocol is not implemented for proposer: ${proposer}`);
  const selected = Array.isArray(targetSections) && targetSections.length
    ? targetSections.map(String)
    : configured.slice();
  if (!selected.length || selected.some((section) => !configured.includes(section))) {
    throw new Error(`Invalid flat Memory wire sections for proposer: ${proposer}`);
  }
  return selected;
}

function flatWirePromptContract(proposer) {
  const sections = flatWireSections(proposer);
  return [
    "## 扁平输出协议",
    "",
    "只输出 JSON Schema 约束的对象。不要输出 `tickId`、`proposer` 或 `sectionResults`；调用方会从 task 自动补齐这些元数据。",
    `根对象固定为 \`sectionStatuses\` 与 \`changes\`。sectionStatuses 必须且只能包含：${sections.map((section) => `\`${section}\``).join("、")}。`,
    "`sectionStatuses` 的值使用 `changes | noop | unable_to_decide`；`changes` 始终是数组。某 section 为 changes 时至少有一条对应 change，否则不得有该 section 的 change。",
    "每条 change 固定使用 `section`、`action`、`sources`，并按动作需要使用 `target`、`text` 或 todo 专属字段。",
    "`sources` 是唯一来源字段且至少一项：消息使用 schema 中显示的 `message:<ID>`，辅助 Memory 使用 `memory:<REF>`。不要输出 evidenceMessageIds 或 supportRefs。",
    "`target` 只从 schema 提供的可修改短引用中选择；add 不使用 target，其他需要修改现有条目的动作必须使用 target。",
    "",
    "最小 noop 形状：",
    "",
    "```json",
    JSON.stringify({
      sectionStatuses: Object.fromEntries(sections.map((section) => [section, "noop"])),
      changes: [],
    }),
    "```",
  ].join("\n");
}

module.exports = {
  FLAT_WIRE_PROPOSER_SECTIONS,
  FLAT_WIRE_STATUSES,
  flatWirePromptContract,
  flatWireSections,
  isFlatWireProposer,
};
