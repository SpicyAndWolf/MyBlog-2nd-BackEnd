const test = require("node:test");
const assert = require("node:assert/strict");
const {
  classifyProviderFailure,
  createProviderCircuitBreaker,
} = require("../../shared/resilience/providerCircuitBreaker");

test("provider circuit uses real-call backoff and eventually requires manual attention", () => {
  let timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  const circuit = createProviderCircuitBreaker({
    name: "embedding",
    retryDelaysMs: [60_000, 300_000],
    now: () => new Date(timestamp),
  });

  assert.equal(circuit.snapshot().status, "unknown");
  assert.equal(circuit.acquire().allowed, true);
  circuit.recordFailure(new Error("offline"), { retryable: true, reason: "network" });
  assert.equal(circuit.snapshot().status, "degraded");
  assert.equal(circuit.acquire().allowed, false);

  timestamp += 60_000;
  assert.equal(circuit.acquire().allowed, true);
  circuit.recordFailure(new Error("offline"), { retryable: true, reason: "network" });
  timestamp += 300_000;
  assert.equal(circuit.acquire().allowed, true);
  circuit.recordFailure(new Error("offline"), { retryable: true, reason: "network" });
  assert.equal(circuit.snapshot().status, "needs_attention");
  assert.equal(circuit.acquire().allowed, false);

  circuit.retryNow();
  assert.equal(circuit.acquire().allowed, true);
  circuit.recordSuccess();
  assert.equal(circuit.snapshot().status, "healthy");
});

test("provider circuit treats authentication failures as manual-attention errors", () => {
  assert.equal(classifyProviderFailure({ status: 401 }).retryable, false);
  const circuit = createProviderCircuitBreaker({ name: "memory" });
  assert.equal(circuit.acquire().allowed, true);
  circuit.recordFailure({ status: 401 }, classifyProviderFailure({ status: 401 }));
  assert.equal(circuit.snapshot().status, "needs_attention");
});

test("provider circuit preserves normal concurrency until it enters backoff", () => {
  const circuit = createProviderCircuitBreaker({ name: "memory" });
  const first = circuit.acquire();
  const second = circuit.acquire();

  assert.equal(first.allowed, true);
  assert.equal(first.exclusiveProbe, false);
  assert.equal(second.allowed, true);
  assert.equal(second.exclusiveProbe, false);

  circuit.recordFailure(new Error("offline"), { retryable: true, reason: "network" });
  assert.equal(circuit.acquire().allowed, false);
});
