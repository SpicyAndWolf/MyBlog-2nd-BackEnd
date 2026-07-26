const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createInitialMemoryState,
  LIBRARIAN_BARRIER_TARGETS,
  LIBRARIAN_INTERVAL_TURNS,
} = require("../../../modules/memory/contracts");
const { createMemoryLibrarian } = require("../../../modules/memory/application/librarian");
const { createMemoryTestConfig, sha256, sequence } = require("../support/memory-builders");

function item(id, text, messageId) {
  return {
    id,
    text,
    sourceRefs: [{ messageId, contentHash: sha256(`${id}:${messageId}`) }],
    createdAtMessageId: messageId,
    updatedAtMessageId: messageId,
  };
}

const PERIODIC_BOUNDARY_MESSAGE_ID = LIBRARIAN_INTERVAL_TURNS * 2;

function store({ completeTurnCount = LIBRARIAN_INTERVAL_TURNS } = {}) {
  let state = createInitialMemoryState();
  state.longTerm.worldFacts.push(item("worldFact:1", "用户偏好简洁回答。", 1));
  state.longTerm.userProfile.push(item("userProfile:1", "用户偏好简洁回答。", 2));
  const tasks = new Map();
  const snapshots = [];
  const groups = [];
  const events = [];
  const ops = [];
  let checkpoint = null;
  const runtime = {
    async createTask(row) {
      const duplicate = [...tasks.values()].find((task) => task.dedupe_key === row.dedupe_key);
      if (duplicate) return duplicate;
      tasks.set(row.task_id, structuredClone(row));
      return tasks.get(row.task_id);
    },
    async getTask(id) { return tasks.get(id) || null; },
    async getTaskForUpdate(id) { return tasks.get(id) || null; },
    async updateTask(id, changes) {
      Object.assign(tasks.get(id), structuredClone(changes));
      return tasks.get(id);
    },
    async appendOpsLog(entry) { ops.push(structuredClone(entry)); return entry; },
    async getLibrarianCheckpoint() { return checkpoint; },
    async upsertLibrarianCheckpoint(_u, _p, value) {
      checkpoint = {
        source_generation: value.sourceGeneration,
        completed_turn_ordinal: value.completedTurnOrdinal,
        boundary_message_id: value.boundaryMessageId,
        last_task_id: value.lastTaskId,
      };
      return checkpoint;
    },
  };
  return {
    repositories: {
      withTransaction: async (work) => work({}),
      state: {
        async getState() { return structuredClone(state); },
        async writeState(_u, _p, next) { state = structuredClone(next); },
      },
      runtime,
      audit: {
        async insertSnapshot(_u, _p, row) { snapshots.push(structuredClone(row)); },
        async insertEventGroup(row) { groups.push(structuredClone(row)); },
        async insertEvents(rows) { events.push(...structuredClone(rows)); },
      },
      source: {
        async getBoundary() { return completeTurnCount * 2; },
        async listCompleteTurnBoundaries() {
          return Array.from({ length: completeTurnCount }, (_, index) => ({
            turnOrdinal: index + 1,
            boundaryMessageId: (index + 1) * 2,
          }));
        },
      },
      userTimeZones: { async getTimeZone() { return "Asia/Shanghai"; } },
    },
    inspect: {
      get state() { return state; },
      get checkpoint() { return checkpoint; },
      tasks,
      snapshots,
      groups,
      events,
      ops,
    },
  };
}

async function alignBarrier(data, boundaryMessageId) {
  const state = await data.repositories.state.getState();
  for (const targetKey of LIBRARIAN_BARRIER_TARGETS) {
    state.meta.targetCursors[targetKey] = boundaryMessageId;
  }
  await data.repositories.state.writeState(1, "default", state);
}

function config() {
  return {
    ...createMemoryTestConfig(),
    providerRecovery: {
      retryMax: 1,
      transportInvalidRetryMax: 1,
      schemaInvalidRetryMax: 1,
      backoffBaseMs: 10,
      backoffMaxMs: 100,
    },
  };
}

test("Librarian fails fast when required config or time-zone access is missing", () => {
  const data = store();
  const providerAdapter = { async propose() { return { status: "ok" }; } };
  const missingRecovery = config();
  delete missingRecovery.providerRecovery;
  assert.throws(
    () => createMemoryLibrarian({
      repositories: data.repositories,
      providerAdapter,
      config: missingRecovery,
    }),
    /providerRecovery config is required/,
  );
  const missingTransportRetry = config();
  delete missingTransportRetry.providerRecovery.transportInvalidRetryMax;
  assert.throws(
    () => createMemoryLibrarian({
      repositories: data.repositories,
      providerAdapter,
      config: missingTransportRetry,
    }),
    /providerRecovery\.transportInvalidRetryMax/,
  );
  assert.throws(
    () => createMemoryLibrarian({
      repositories: { ...data.repositories, userTimeZones: undefined },
      providerAdapter,
      config: config(),
    }),
    /userTimeZones\.getTimeZone/,
  );
});

test("Librarian commits state, global event group, snapshot, task, and checkpoint atomically", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    idFactory: sequence("merged", "group"),
    providerAdapter: {
      async propose(envelope) {
        return {
          status: "ok",
          output: {
            tickId: envelope.task.tickId,
            proposer: "librarianProposer",
            status: "changes",
            operations: [{
              action: "merge",
              refs: ["W1", "UP1"],
              toSection: "userProfile",
              text: "用户偏好简洁回答。",
            }],
          },
        };
      },
    },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    turnOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
    skipBarrier: true,
  });

  assert.equal(result.status, "committed");
  assert.equal(data.inspect.state.meta.revision, 1);
  assert.equal(data.inspect.state.longTerm.worldFacts.length, 0);
  assert.equal(data.inspect.state.longTerm.userProfile[0].id, "userProfile:merged");
  assert.equal(data.inspect.groups[0].target_key, "librarian");
  assert.equal(data.inspect.groups[0].group_kind, "maintenance");
  assert.equal(data.inspect.events.length, 1);
  assert.equal(data.inspect.snapshots.length, 1);
  assert.equal(data.inspect.checkpoint.completed_turn_ordinal, LIBRARIAN_INTERVAL_TURNS);
  assert.equal([...data.inspect.tasks.values()][0].status, "succeeded");
});

test("periodic scheduling uses only complete-turn ordinals and noop advances no state revision", async () => {
  const data = store();
  let calls = 0;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope) {
        calls += 1;
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
    drainBarrier: async (_u, _p, options) => {
      assert.deepEqual(options.targetKeys, LIBRARIAN_BARRIER_TARGETS);
      const state = await data.repositories.state.getState();
      for (const targetKey of options.targetKeys) state.meta.targetCursors[targetKey] = options.boundaryMessageId;
      await data.repositories.state.writeState(1, "default", state);
      return { status: "completed" };
    },
  });
  const result = await librarian.runScheduled(1, "default");
  assert.equal(result.status, "completed");
  assert.equal(calls, 1);
  assert.equal(data.inspect.state.meta.revision, 0);
  assert.equal(data.inspect.snapshots.length, 0);
  assert.equal(data.inspect.groups.length, 0);
  assert.equal(data.inspect.checkpoint.completed_turn_ordinal, LIBRARIAN_INTERVAL_TURNS);
  assert.equal(data.inspect.checkpoint.boundary_message_id, PERIODIC_BOUNDARY_MESSAGE_ID);
});

test("periodic scheduling rebases an empty checkpoint beyond already-processed target cursors", async () => {
  const completeTurnCount = LIBRARIAN_INTERVAL_TURNS + 24;
  const data = store({ completeTurnCount });
  const alreadyProcessedBoundary = PERIODIC_BOUNDARY_MESSAGE_ID + 8;
  await alignBarrier(data, alreadyProcessedBoundary);
  let observedTask = null;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope) {
        observedTask = envelope.task;
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
    drainBarrier: async (_u, _p, options) => {
      await alignBarrier(data, options.boundaryMessageId);
      return { status: "completed" };
    },
  });

  const result = await librarian.runScheduled(1, "default");

  assert.equal(result.status, "completed");
  assert.equal(observedTask.turnOrdinal, LIBRARIAN_INTERVAL_TURNS + 4);
  assert.equal(observedTask.boundaryMessageId, alreadyProcessedBoundary);
  assert.equal(data.inspect.checkpoint.completed_turn_ordinal, LIBRARIAN_INTERVAL_TURNS + 4);
});

test("skipBarrier skips draining but still rejects misaligned Librarian input", async () => {
  const data = store();
  let calls = 0;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: { async propose() { calls += 1; throw new Error("must not be called"); } },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    turnOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "rebuild",
    skipBarrier: true,
  });

  assert.equal(result.status, "incomplete");
  assert.equal(result.reason, "barrier_misaligned");
  assert.equal(calls, 0);
});

test("schema repair allowance is persisted before the Librarian retry", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const repairFeedback = [];
  const rejectedOutputs = [];
  const rejectedOutput = { tickId: "invalid", proposer: "librarianProposer", operations: "invalid" };
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope, options) {
        repairFeedback.push(options?.repairFeedback ?? null);
        rejectedOutputs.push(options?.rejectedOutput);
        if (repairFeedback.length === 1) {
          return {
            status: "error",
            reason: "output_schema_invalid",
            rejectedOutput,
            detail: {
              boundary: "output",
              errors: [{ path: "$.operations", message: "must be an array" }],
            },
          };
        }
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    turnOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
    skipBarrier: true,
  });

  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "noop");
  assert.equal(repairFeedback.length, 2);
  assert.equal(repairFeedback[0], null);
  assert.equal(repairFeedback[1].attempt, 1);
  assert.deepEqual(rejectedOutputs[1], rejectedOutput);
  assert.equal(task.stage_payload.schemaInvalidAttempts, 1);
  assert.deepEqual(task.stage_payload.schemaRejectedOutputs[0].output, rejectedOutput);
  assert.doesNotMatch(JSON.stringify(data.inspect.ops), /"operations":"invalid"/);
  assert.equal(task.attempt, 1);
  assert.equal(data.inspect.ops.some((entry) => entry.outcome === "output_schema_invalid_retry"), true);
});

test("schema repair allowance survives an interrupted Librarian process", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const repairFeedback = [];
  const rejectedOutputs = [];
  const rejectedOutput = { malformed: "restart-safe" };
  let calls = 0;
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose(envelope, options) {
          calls += 1;
          repairFeedback.push(options?.repairFeedback ?? null);
          rejectedOutputs.push(options?.rejectedOutput);
          if (calls === 1) {
            return {
              status: "error",
              reason: "output_schema_invalid",
              rejectedOutput,
            detail: {
              boundary: "output",
              errors: [{ path: "$.operations", message: "must be an array" }],
            },
          };
        }
        if (calls === 2) throw new Error("simulated process interruption");
        return {
          status: "ok",
          output: { tickId: envelope.task.tickId, proposer: "librarianProposer", status: "noop", operations: [] },
        };
      },
    },
  });
  const envelope = await librarian.createTask(1, "default", {
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    turnOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
  });

  await assert.rejects(
    librarian.processEnvelope(envelope),
    /simulated process interruption/,
  );
  const interrupted = data.inspect.tasks.get(envelope.task.taskId);
  assert.equal(interrupted.stage, "schema_invalid_retry");
  assert.equal(interrupted.stage_payload.schemaInvalidAttempts, 1);

  const result = await librarian.processEnvelope(envelope);

  assert.equal(result.status, "noop");
  assert.equal(repairFeedback[2].attempt, 1);
  assert.deepEqual(rejectedOutputs[1], rejectedOutput);
  assert.deepEqual(rejectedOutputs[2], rejectedOutput);
  assert.equal(data.inspect.tasks.get(envelope.task.taskId).attempt, 1);
});

test("an open Provider circuit durably defers Librarian work", async () => {
  const data = store();
  await alignBarrier(data, PERIODIC_BOUNDARY_MESSAGE_ID);
  const retryAt = new Date("2026-07-26T00:01:00.000Z");
  const librarian = createMemoryLibrarian({
    repositories: data.repositories,
    config: config(),
    providerAdapter: {
      async propose() {
        return {
          status: "deferred",
          reason: "provider_circuit_open",
          providerHealth: { status: "degraded", nextRetryAt: retryAt },
        };
      },
    },
  });

  const result = await librarian.runAt(1, "default", {
    sourceGeneration: 0,
    boundaryMessageId: PERIODIC_BOUNDARY_MESSAGE_ID,
    turnOrdinal: LIBRARIAN_INTERVAL_TURNS,
    triggerType: "periodic",
    skipBarrier: true,
  });

  const task = [...data.inspect.tasks.values()][0];
  assert.equal(result.status, "retry_wait");
  assert.equal(task.status, "retry_wait");
  assert.equal(task.stage, "provider_circuit_open");
  assert.equal(new Date(task.not_before).getTime(), retryAt.getTime());
});
