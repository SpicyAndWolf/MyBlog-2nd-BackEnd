const test = require("node:test");
const assert = require("node:assert/strict");
const { createProviderCircuitBreaker } = require("../../shared/resilience/providerCircuitBreaker");
const {
  createCircuitProtectedEmbeddingClient,
} = require("../../modules/chat/rag/infrastructure/circuitProtectedEmbeddings");

test("embedding circuit suppresses calls during backoff and manual retry arms the next real call", async () => {
  let timestamp = Date.parse("2026-01-01T00:00:00.000Z");
  let calls = 0;
  const circuit = createProviderCircuitBreaker({
    name: "embedding",
    retryDelaysMs: [60_000],
    now: () => new Date(timestamp),
  });
  const client = createCircuitProtectedEmbeddingClient({
    circuit,
    embeddingClient: {
      async createEmbeddings() {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error("offline"), { status: 503 });
        return [[1, 0]];
      },
    },
  });

  await assert.rejects(() => client.createEmbeddings({ texts: ["one"] }), /offline/);
  let deferred;
  try {
    await client.createEmbeddings({ texts: ["two"] });
  } catch (error) {
    deferred = error;
  }
  assert.equal(deferred.code, "PROVIDER_CIRCUIT_OPEN");
  assert.equal(deferred.suppressed, true);
  assert.equal(calls, 1);

  client.retryNow();
  assert.deepEqual(await client.createEmbeddings({ texts: ["three"] }), [[1, 0]]);
  assert.equal(client.getHealthSnapshot().status, "healthy");
  assert.equal(calls, 2);
  timestamp += 60_000;
});
