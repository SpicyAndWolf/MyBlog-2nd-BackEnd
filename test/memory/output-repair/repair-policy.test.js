const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ISSUE_CODES,
  OUTPUT_REPAIR_POLICY_VERSION,
  REJECTED_OUTPUT_MAX_BYTES,
  appendRejectedOutputAttempt,
  captureRejectedOutput,
  createRepairFeedback,
  latestRejectedOutput,
  renderRepairMessage,
  renderRepairInstruction,
  summarizeOutputShape,
} = require("../../../modules/memory/application/outputRepair");

test("repair feedback is versioned, coded, bounded, and excludes rejected output values", () => {
  const feedback = createRepairFeedback({
    specialist: "relationshipProposer",
    errors: [
      {
        code: ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT,
        path: "$.sectionResults",
        message: "must be an object",
      },
      {
        code: ISSUE_CODES.TEXT_LENGTH_EXCEEDED,
        path: "$.sectionResults.relationship.changes[0].text",
        message: "must contain at most 240 characters for relationship",
        meta: { limit: 240, actual: 292, section: "relationship" },
      },
    ],
    rawOutput: "must-not-persist",
  }, 1, {
    proposer: "profileRelationshipProposer",
    targetSections: ["userProfile", "assistantProfile", "relationship"],
  });

  assert.equal(feedback.policyVersion, OUTPUT_REPAIR_POLICY_VERSION);
  assert.equal(feedback.specialist, "relationshipProposer");
  assert.deepEqual(feedback.plan.issueCodes, [
    ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT,
    ISSUE_CODES.TEXT_LENGTH_EXCEEDED,
  ]);
  assert.equal(JSON.stringify(feedback).includes("must-not-persist"), false);
});

test("repair instruction uses the actual specialist schema shape and positive constraints", () => {
  const feedback = createRepairFeedback({
    specialist: "relationshipProposer",
    errors: [
      {
        code: ISSUE_CODES.SECTION_RESULTS_NOT_OBJECT,
        path: "$.sectionResults",
        message: "must be an object",
      },
      {
        code: ISSUE_CODES.TEXT_LENGTH_EXCEEDED,
        path: "$.sectionResults.relationship.changes[0].text",
        message: "must contain at most 240 characters for relationship",
        meta: { limit: 240, actual: 292, section: "relationship" },
      },
    ],
  }, 1, {
    proposer: "profileRelationshipProposer",
    targetSections: ["userProfile", "assistantProfile", "relationship"],
  });
  const prompt = renderRepairInstruction("base", feedback, {
    proposer: "relationshipProposer",
    targetSections: ["relationship"],
  });

  assert.match(prompt, /\[SCHEMA_REPAIR_V4\]/);
  assert.match(prompt, /Unicode 字符数不得超过 240/);
  assert.match(prompt, /"sectionStatuses":\{"relationship":/);
  assert.match(prompt, /"changes":"<complete flat change array/);
  assert.doesNotMatch(prompt, /"proposer":|"sectionResults":/);
  assert.doesNotMatch(prompt, /userProfile|assistantProfile|profileRelationshipProposer/);
});

test("rejected output is copied into bounded durable task state for multi-turn replay", () => {
  const output = { sectionStatuses: { todos: "changes" }, changes: [] };
  const stagePayload = appendRejectedOutputAttempt({}, { rejectedOutput: output }, 0, 2);
  assert.deepEqual(latestRejectedOutput(stagePayload), output);
  assert.notEqual(stagePayload.schemaRejectedOutputs[0].output, output);
  assert.equal(stagePayload.schemaRejectedOutputs[0].utf8Bytes, Buffer.byteLength(JSON.stringify(output), "utf8"));
  assert.match(renderRepairMessage({
    errors: [{ path: "$.sectionResults.todos.changes", message: "must not be empty" }],
  }, {
    proposer: "todoProposer",
    targetSections: ["todos"],
  }), /上一条 assistant 消息/);

  const oversized = captureRejectedOutput("x".repeat(REJECTED_OUTPUT_MAX_BYTES + 1));
  assert.deepEqual(oversized, {
    available: false,
    reason: "size_limit",
    utf8Bytes: REJECTED_OUTPUT_MAX_BYTES + 3,
  });
});

test("transport failures produce field-agnostic JSON and missing-output repair directives", () => {
  const task = { proposer: "currentStateProposer", targetSections: ["scene"] };
  for (const transportError of ["content_invalid_json", "tool_arguments_invalid_json"]) {
    const invalidJson = createRepairFeedback({
      transportError,
      errors: [{ path: "$", message: "must be an object", meta: { actualType: "null" } }],
    }, 1, task);
    assert.equal(invalidJson.errors[0].code, ISSUE_CODES.TOOL_ARGUMENTS_INVALID_JSON);
    assert.equal(invalidJson.plan.directives.includes("RETURN_VALID_JSON_TOOL_ARGUMENTS"), true);
    assert.match(renderRepairMessage(invalidJson, task), /不是合法 JSON/);
    assert.match(renderRepairMessage(invalidJson, task), /字段名和字符串使用成对双引号/);
  }

  for (const transportError of ["content_missing", "tool_call_missing"]) {
    const missing = createRepairFeedback({ transportError }, 1, task);
    assert.equal(missing.errors[0].code, ISSUE_CODES.STRUCTURED_OUTPUT_MISSING);
    assert.equal(missing.plan.directives.includes("RETURN_REQUIRED_STRUCTURED_OUTPUT"), true);
  }
});

test("output-shape diagnostics expose structure without output values", () => {
  assert.deepEqual(summarizeOutputShape({
    tickId: 7,
    proposer: "todoProposer",
    sectionResults: { todos: "secret value" },
  }), {
    rootType: "object",
    topLevelKeys: ["proposer", "sectionResults", "tickId"],
    sectionResultsType: "object",
    sectionKeys: ["todos"],
  });
  const hostile = summarizeOutputShape({
    tickId: 7,
    "raw-secret-as-key": true,
    sectionResults: { todos: {}, "another-secret": {} },
  });
  assert.equal(JSON.stringify(hostile).includes("secret"), false);
  assert.equal(hostile.unexpectedTopLevelKeyCount, 1);
  assert.equal(hostile.unexpectedSectionKeyCount, 1);
});
