const {
  classifyProviderFailure,
  createProviderCircuitBreaker,
} = require("../../../shared/resilience/providerCircuitBreaker");

function failureFromAdapterResult(result) {
  return {
    reason: result?.reason || "llm_call_failed",
    status: result?.detail?.status,
    code: result?.detail?.code,
    detail: result?.detail,
  };
}

function circuitControlledAdapter({
  adapter,
  circuit = createProviderCircuitBreaker({ name: "memory" }),
} = {}) {
  if (typeof adapter?.propose !== "function") throw new Error("Memory provider adapter is required");

  return Object.freeze({
    async propose(...args) {
      const permit = circuit.acquire();
      if (!permit.allowed) {
        return {
          status: "deferred",
          reason: "provider_circuit_open",
          providerHealth: permit.error.providerHealth,
        };
      }
      try {
        const result = await adapter.propose(...args);
        if (result?.status === "error" && result.reason === "llm_call_failed") {
          const failure = failureFromAdapterResult(result);
          circuit.recordFailure(failure, classifyProviderFailure(failure));
        } else {
          circuit.recordSuccess();
        }
        return result;
      } catch (error) {
        circuit.recordFailure(error, classifyProviderFailure(error));
        throw error;
      }
    },
  });
}

module.exports = { circuitControlledAdapter, failureFromAdapterResult };
