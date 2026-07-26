const test = require("node:test");
const assert = require("node:assert/strict");
const { FILES, loadProposerPrompt } = require("../../../modules/memory/prompts");
const { TARGETS } = require("../../../modules/memory/contracts");

const PROMPT_SECTIONS = Object.freeze({
  currentStateProposer: TARGETS.scene.sections,
  todoProposer: TARGETS.todos.sections,
  agreementProposer: TARGETS.standingAgreements.sections,
  episodeProposer: TARGETS.episodes.sections,
  userProfileProposer: ["userProfile"],
  assistantProfileProposer: ["assistantProfile"],
  relationshipProposer: ["relationship"],
  worldFactProposer: TARGETS.worldFacts.sections,
});

const NORMAL_PROPOSERS = Object.freeze(Object.keys(PROMPT_SECTIONS));
const SHARED_PROTOCOL_TERMS = Object.freeze(["tickId", "proposer", "sectionResults"]);
const NORMAL_PROTOCOL_TERMS = Object.freeze([
  "noop",
  "unable_to_decide",
  "evidenceMessageIds",
  "supportRefs",
]);

function assertIncludesTerms(prompt, proposer, terms) {
  for (const term of terms) {
    assert.equal(prompt.includes(term), true, `${proposer} must document the ${term} protocol field`);
  }
}

test("registered Proposer prompts load as non-empty text", async () => {
  assert.ok(Object.keys(FILES).length > 0);
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assert.ok(prompt.trim().length > 0, `${proposer} prompt must not be empty`);
  }
  await assert.rejects(loadProposerPrompt("unknownProposer"), /Unknown Memory proposer prompt/);
});

test("normal Proposer prompts document their schema-owned sections", async () => {
  for (const [proposer, sections] of Object.entries(PROMPT_SECTIONS)) {
    assert.equal(typeof FILES[proposer], "string", `${proposer} must have a registered prompt`);
    const prompt = await loadProposerPrompt(proposer);
    assertIncludesTerms(prompt, proposer, sections);
  }
});

test("prompts retain the machine protocol without freezing editorial wording", async () => {
  for (const proposer of Object.keys(FILES)) {
    const prompt = await loadProposerPrompt(proposer);
    assertIncludesTerms(prompt, proposer, SHARED_PROTOCOL_TERMS);
  }
  for (const proposer of NORMAL_PROPOSERS) {
    const prompt = await loadProposerPrompt(proposer);
    assertIncludesTerms(prompt, proposer, NORMAL_PROTOCOL_TERMS);
  }
});

test("normal prompts mark payload text as data and exclude persistence metadata", async () => {
  for (const proposer of NORMAL_PROPOSERS) {
    const prompt = await loadProposerPrompt(proposer);
    assert.match(prompt, /待分析数据/, `${proposer} must treat payload text as data`);
    assert.match(
      prompt,
      /不要生成.*evidenceKind|不输出.*evidenceKind|不生成.*evidenceKind/s,
      `${proposer} must leave persistence metadata to the Compiler`,
    );
  }
});

test("compaction prompt retains its distinct maintenance protocol", async () => {
  const prompt = await loadProposerPrompt("compactionProposer");
  assertIncludesTerms(prompt, "compactionProposer", ["unable_to_compact", "merge", "refs"]);
});
