const test = require("node:test");
const assert = require("node:assert/strict");
const {
  flatWireToSemanticOutput,
  semanticOutputToFlatWire,
} = require("../../../modules/memory/infrastructure/providers/flatWireProtocol");

const TODO_TASK = Object.freeze({
  tickId: 42,
  proposer: "todoProposer",
  targetSections: ["todos"],
});

test("flat Todo wire output deterministically maps dates and source tokens into SemanticResult", () => {
  const output = flatWireToSemanticOutput({
    sectionStatuses: { todos: "changes" },
    changes: [
      {
        section: "todos",
        action: "add",
        text: "归还图书",
        actor: "user",
        requester: "user",
        dueMode: "relativeDays",
        dueValue: "1",
        anchorSource: "message:101",
        sources: ["message:101", "memory:WF1"],
      },
      {
        section: "todos",
        action: "update",
        target: "T1",
        dueMode: "keep",
        sources: ["message:102"],
      },
    ],
  }, TODO_TASK);

  assert.deepEqual(output, {
    tickId: 42,
    proposer: "todoProposer",
    sectionResults: {
      todos: {
        status: "changes",
        changes: [
          {
            action: "add",
            evidenceMessageIds: [101],
            supportRefs: ["WF1"],
            text: "归还图书",
            actor: "user",
            requester: "user",
            anchorMessageId: 101,
            dueAt: { mode: "relative", days: 1 },
          },
          {
            action: "update",
            evidenceMessageIds: [102],
            ref: "T1",
            dueChange: { mode: "keep" },
          },
        ],
      },
    },
  });
});

test("SemanticResult converts to the same flat shape used by provider preflight", () => {
  const semantic = {
    tickId: 42,
    proposer: "todoProposer",
    sectionResults: {
      todos: {
        status: "changes",
        changes: [{
          action: "correct",
          ref: "T1",
          text: "归还图书",
          evidenceMessageIds: [101],
          dueChange: {
            mode: "set",
            dueAt: { mode: "dayOfMonth", day: 15 },
          },
          anchorMessageId: 101,
        }],
      },
    },
  };

  assert.deepEqual(semanticOutputToFlatWire(semantic, TODO_TASK), {
    sectionStatuses: { todos: "changes" },
    changes: [{
      section: "todos",
      action: "correct",
      target: "T1",
      text: "归还图书",
      sources: ["message:101"],
      dueMode: "dayOfMonth",
      dueValue: "15",
      anchorSource: "message:101",
    }],
  });
});
