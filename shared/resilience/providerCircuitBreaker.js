const DEFAULT_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000]);
const PERMANENT_HTTP_STATUSES = new Set([400, 401, 403, 404, 405, 409, 410, 422]);

function normalizeStatus(value) {
  const status = Number(value);
  return Number.isSafeInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function classifyProviderFailure(error = {}) {
  const status = normalizeStatus(error.status ?? error.detail?.status);
  const code = String(error.code ?? error.detail?.code ?? "").trim().toUpperCase();
  const permanent = (status !== null && PERMANENT_HTTP_STATUSES.has(status))
    || [
      "MODEL_NOT_FOUND",
      "INVALID_API_KEY",
      "UNSUPPORTED_MODEL",
      "UNSUPPORTED_PROVIDER",
      "INVALID_REQUEST",
    ].includes(code);
  return {
    retryable: !permanent,
    reason: String(error.reason || code || (status ? `http_${status}` : error.name || "provider_unavailable"))
      .trim()
      .toLowerCase(),
    status,
  };
}

function createCircuitOpenError(snapshot) {
  const error = new Error(`${snapshot.name} provider call deferred while the circuit is ${snapshot.status}`);
  error.code = "PROVIDER_CIRCUIT_OPEN";
  error.provider = snapshot.name;
  error.retryable = snapshot.status !== "needs_attention";
  error.suppressed = true;
  error.nextRetryAt = snapshot.nextRetryAt;
  error.providerHealth = snapshot;
  return error;
}

function createProviderCircuitBreaker({
  name,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  now = () => new Date(),
  onTransition,
} = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) throw new Error("Provider circuit name is required");
  if (!Array.isArray(retryDelaysMs) || retryDelaysMs.some((value) => !Number.isSafeInteger(value) || value < 1_000)) {
    throw new Error("Provider circuit retry delays must be integers >= 1000");
  }

  let status = "unknown";
  let failureCount = 0;
  let reason = null;
  let lastFailureAt = null;
  let lastSuccessAt = null;
  let nextRetryAt = null;
  let probeInFlight = false;
  let manualRetryArmed = false;

  function snapshot() {
    return Object.freeze({
      name: normalizedName,
      status,
      available: status === "healthy" || status === "unknown",
      failureCount,
      reason,
      lastFailureAt,
      lastSuccessAt,
      nextRetryAt,
      retryMode: status === "needs_attention" ? "manual" : nextRetryAt ? "automatic" : null,
    });
  }

  function transition(previous, detail = {}) {
    if (previous === status) return;
    onTransition?.({ previous, current: status, snapshot: snapshot(), ...detail });
  }

  function acquire() {
    const current = now();
    const timestamp = current.getTime();
    const requiresExclusiveProbe = status === "degraded" || status === "needs_attention";
    if (requiresExclusiveProbe && probeInFlight) {
      return { allowed: false, error: createCircuitOpenError(snapshot()) };
    }
    if (status === "needs_attention" && !manualRetryArmed) {
      return { allowed: false, error: createCircuitOpenError(snapshot()) };
    }
    if (status === "degraded" && !manualRetryArmed && nextRetryAt && timestamp < new Date(nextRetryAt).getTime()) {
      return { allowed: false, error: createCircuitOpenError(snapshot()) };
    }
    if (requiresExclusiveProbe) {
      probeInFlight = true;
      manualRetryArmed = false;
    }
    return { allowed: true, exclusiveProbe: requiresExclusiveProbe };
  }

  function recordSuccess() {
    const previous = status;
    status = "healthy";
    failureCount = 0;
    reason = null;
    lastSuccessAt = now().toISOString();
    nextRetryAt = null;
    probeInFlight = false;
    manualRetryArmed = false;
    transition(previous);
    return snapshot();
  }

  function recordFailure(error, classification = classifyProviderFailure(error)) {
    const previous = status;
    failureCount += 1;
    reason = String(classification?.reason || "provider_unavailable").slice(0, 200);
    lastFailureAt = now().toISOString();
    probeInFlight = false;
    manualRetryArmed = false;
    const retryable = classification?.retryable !== false;
    const delay = retryable ? retryDelaysMs[failureCount - 1] : null;
    if (delay === undefined || delay === null) {
      status = "needs_attention";
      nextRetryAt = null;
    } else {
      status = "degraded";
      nextRetryAt = new Date(now().getTime() + delay).toISOString();
    }
    transition(previous, { error, classification });
    return snapshot();
  }

  function release(permit) {
    if (permit?.exclusiveProbe) probeInFlight = false;
  }

  function retryNow() {
    const previous = status;
    if (status === "healthy" || status === "unknown") return snapshot();
    status = "degraded";
    nextRetryAt = now().toISOString();
    manualRetryArmed = true;
    probeInFlight = false;
    transition(previous, { manual: true });
    return snapshot();
  }

  return Object.freeze({
    acquire,
    recordSuccess,
    recordFailure,
    release,
    retryNow,
    snapshot,
  });
}

module.exports = {
  DEFAULT_RETRY_DELAYS_MS,
  classifyProviderFailure,
  createProviderCircuitBreaker,
  createCircuitOpenError,
};
