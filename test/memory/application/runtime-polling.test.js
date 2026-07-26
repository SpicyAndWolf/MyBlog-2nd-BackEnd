const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryRuntime } = require("../../../modules/memory/application/runtime");
const { createInitialMemoryState, TARGET_KEYS } = require("../../../modules/memory/contracts");
const {
  createMemoryTestConfig,
  withLibrarianRepositoryStubs,
} = require("../support/memory-builders");

test("durable task polling continuously scans queued and due retry tasks", async () => {
  let scans = 0;
  const state = createInitialMemoryState();
  const targets = Object.fromEntries(TARGET_KEYS.map((key) => [key, { lagThreshold: 2, contextWindow: 6 }]));
  const repositories = {
    state: { async getState() { return state; }, async initializeRevisionZero() { return state; } },
    source: { async countAfter() { return 0; } },
    runtime: { async getTargetStatuses() { return []; }, async listRecoverableTasks() { scans += 1; return []; } },
    audit: {}, sidecars: {}, async withTransaction(work) { return work({}); },
  };
  const runtime = createMemoryRuntime({
    config: createMemoryTestConfig({
      enabled: true,
      targets,
      tasks: { pollIntervalMs: 250 },
      projections: { pollIntervalMs: 1000 },
    }),
    repositories: withLibrarianRepositoryStubs(repositories),
    providerAdapter: { async propose() { return { status: "ok", output: {} }; } },
  });
  const stop = runtime.startTaskPolling();
  await new Promise((resolve) => setTimeout(resolve, 320));
  stop();
  assert.ok(scans >= 1);
});
