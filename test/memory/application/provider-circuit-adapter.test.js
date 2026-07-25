const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderCircuitBreaker } = require("../../../shared/resilience/providerCircuitBreaker");
const {
  circuitControlledAdapter,
} = require("../../../modules/memory/application/providerCircuitAdapter");

test("memory provider circuit defers without consuming another provider call", async () => {
  let timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  let calls = 0;
  const circuit = createProviderCircuitBreaker({
    name: "memory",
    retryDelaysMs: [60_000],
    now: () => new Date(timestamp),
  });
  const adapter = circuitControlledAdapter({
    circuit,
    adapter: {
      async propose() {
        calls += 1;
        return { status: "error", reason: "llm_call_failed", detail: { status: 503 } };
      },
    },
  });

  assert.equal((await adapter.propose()).reason, "llm_call_failed");
  assert.deepEqual(await adapter.propose(), {
    status: "deferred",
    reason: "provider_circuit_open",
    providerHealth: circuit.snapshot(),
  });
  assert.equal(calls, 1);
});
