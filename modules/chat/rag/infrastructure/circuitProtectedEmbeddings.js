const {
  classifyProviderFailure,
  createProviderCircuitBreaker,
} = require("../../../../shared/resilience/providerCircuitBreaker");

function createCircuitProtectedEmbeddingClient({
  embeddingClient,
  circuit = createProviderCircuitBreaker({ name: "embedding" }),
} = {}) {
  if (typeof embeddingClient?.createEmbeddings !== "function") {
    throw new Error("Embedding client is required");
  }

  async function createEmbeddings(options = {}) {
    const permit = circuit.acquire();
    if (!permit.allowed) throw permit.error;
    try {
      const embeddings = await embeddingClient.createEmbeddings(options);
      circuit.recordSuccess();
      return embeddings;
    } catch (error) {
      if (options.signal?.aborted) {
        circuit.release(permit);
        throw error;
      }
      circuit.recordFailure(error, classifyProviderFailure(error));
      throw error;
    }
  }

  return Object.freeze({
    createEmbeddings,
    getHealthSnapshot: () => circuit.snapshot(),
    retryNow: () => circuit.retryNow(),
  });
}

module.exports = { createCircuitProtectedEmbeddingClient };
