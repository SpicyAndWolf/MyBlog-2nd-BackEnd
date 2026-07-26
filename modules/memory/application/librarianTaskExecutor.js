const crypto = require("node:crypto");
const {
  SCHEMA_VERSION,
  LIBRARIAN_TARGET_KEY,
  LIBRARIAN_SECTIONS,
} = require("../contracts");
const { compileLibrarianProposal, reduceLibrarianProposal } = require("../domain/librarian");
const { buildLibrarianEnvelope, librarianDedupeKey } = require("./librarianRenderer");
const { mapEventToRow } = require("./eventMapper");
const { createRepairFeedback } = require("./outputRepair");

const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
const RETRYABLE_PROVIDER_ERRORS = new Set([
  "llm_call_failed",
  "safety_policy_blocked",
  "max_output_truncated",
  "provider_queue_full",
]);
function rowValue(row, snake, camel) { return row?.[snake] ?? row?.[camel]; }

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Memory Librarian ${label} must be a non-negative safe integer`);
  }
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Memory Librarian ${label} must be a positive safe integer`);
  }
}

function validateLibrarianConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Memory Librarian config is required");
  const recovery = config.providerRecovery;
  if (!recovery || typeof recovery !== "object") {
    throw new Error("Memory Librarian providerRecovery config is required");
  }
  requireNonNegativeInteger(recovery.retryMax, "providerRecovery.retryMax");
  requireNonNegativeInteger(recovery.schemaInvalidRetryMax, "providerRecovery.schemaInvalidRetryMax");
  requirePositiveInteger(recovery.backoffBaseMs, "providerRecovery.backoffBaseMs");
  requirePositiveInteger(recovery.backoffMaxMs, "providerRecovery.backoffMaxMs");
  if (!config.sectionBudgets || typeof config.sectionBudgets !== "object") {
    throw new Error("Memory Librarian sectionBudgets config is required");
  }
  for (const section of LIBRARIAN_SECTIONS) {
    const budget = config.sectionBudgets[section];
    if (!budget || typeof budget !== "object") {
      throw new Error(`Memory Librarian section budget is required for ${section}`);
    }
    requirePositiveInteger(budget.maxItems, `sectionBudgets.${section}.maxItems`);
    requirePositiveInteger(budget.maxRenderedChars, `sectionBudgets.${section}.maxRenderedChars`);
  }
}

function validateLibrarianRepositories(repositories) {
  const requiredMethods = [
    ["withTransaction", repositories?.withTransaction],
    ["state.getState", repositories?.state?.getState],
    ["state.writeState", repositories?.state?.writeState],
    ["runtime.createTask", repositories?.runtime?.createTask],
    ["runtime.getTask", repositories?.runtime?.getTask],
    ["runtime.getTaskForUpdate", repositories?.runtime?.getTaskForUpdate],
    ["runtime.updateTask", repositories?.runtime?.updateTask],
    ["runtime.appendOpsLog", repositories?.runtime?.appendOpsLog],
    ["runtime.upsertLibrarianCheckpoint", repositories?.runtime?.upsertLibrarianCheckpoint],
    ["audit.insertSnapshot", repositories?.audit?.insertSnapshot],
    ["audit.insertEventGroup", repositories?.audit?.insertEventGroup],
    ["audit.insertEvents", repositories?.audit?.insertEvents],
    ["userTimeZones.getTimeZone", repositories?.userTimeZones?.getTimeZone],
  ];
  const missing = requiredMethods
    .filter(([, value]) => typeof value !== "function")
    .map(([name]) => name);
  if (missing.length) {
    throw new Error(`Memory Librarian repository methods are required: ${missing.join(", ")}`);
  }
}

function librarianTaskRow(envelope) {
  const task = envelope.task;
  return {
    task_id: task.taskId,
    dedupe_key: librarianDedupeKey(task),
    user_id: task.userId,
    preset_id: task.presetId,
    target_key: LIBRARIAN_TARGET_KEY,
    source_generation: task.sourceGeneration,
    schema_version: task.schemaVersion,
    task_type: "maintenance",
    parent_task_id: null,
    predecessor_task_id: null,
    resume_epoch: 0,
    status: "queued",
    stage: "created",
    cursor_before: null,
    target_message_id: null,
    base_revision: task.baseRevision,
    task_payload: envelope,
    stage_payload: null,
    attempt: 0,
    context_expansion_attempt: 0,
    not_before: null,
    last_error_reason: null,
    result_revision: null,
  };
}

function createLibrarianTaskExecutor({
  repositories,
  providerAdapter,
  config,
  now = () => new Date(),
  idFactory = () => crypto.randomUUID(),
  metrics,
} = {}) {
  validateLibrarianRepositories(repositories);
  if (!providerAdapter?.propose) throw new Error("Memory Librarian provider adapter is required");
  validateLibrarianConfig(config);

  async function appendOps(envelope, outcome, attempt, detail, client) {
    metrics?.increment("memory_ops_outcomes_total", {
      targetKey: LIBRARIAN_TARGET_KEY,
      proposer: envelope.task.proposer,
      outcome,
    });
    return repositories.runtime.appendOpsLog({
      user_id: envelope.task.userId,
      preset_id: envelope.task.presetId,
      source_generation: envelope.task.sourceGeneration,
      task_id: envelope.task.taskId,
      tick_id: envelope.task.tickId,
      target_key: LIBRARIAN_TARGET_KEY,
      section: null,
      proposer: envelope.task.proposer,
      outcome,
      attempt,
      detail: detail ?? null,
    }, { client });
  }

  async function createTask(userId, presetId, {
    boundaryMessageId,
    turnOrdinal,
    triggerType,
    taskId,
    tickId,
  } = {}) {
    return repositories.withTransaction(async (client) => {
      const state = await repositories.state.getState(userId, presetId, { client, forUpdate: true });
      if (!state) throw new Error("Memory state must be initialized before creating a Librarian task");
      const userTimeZone = await repositories.userTimeZones.getTimeZone(userId, { client });
      const envelope = buildLibrarianEnvelope({
        userId,
        presetId,
        state,
        boundaryMessageId,
        turnOrdinal,
        triggerType,
        now: now(),
        userTimeZone,
        taskId,
        tickId,
      });
      let row = await repositories.runtime.createTask(librarianTaskRow(envelope), { client });
      if (String(rowValue(row, "task_id", "taskId")) !== envelope.task.taskId
        && ["failed", "cancelled"].includes(rowValue(row, "status", "status"))) {
        const retryEnvelope = buildLibrarianEnvelope({
          userId,
          presetId,
          state,
          boundaryMessageId,
          turnOrdinal,
          triggerType,
          now: now(),
          userTimeZone,
        });
        const retryRow = librarianTaskRow(retryEnvelope);
        retryRow.dedupe_key = `${retryRow.dedupe_key}:retry:${retryEnvelope.task.taskId}`;
        row = await repositories.runtime.createTask(retryRow, { client });
        return rowValue(row, "task_payload", "taskPayload") ?? retryEnvelope;
      }
      return rowValue(row, "task_payload", "taskPayload") ?? envelope;
    });
  }

  async function persistFailure(envelope, reason, detail = null) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before failure persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) {
        return { status: rowValue(task, "status", "status"), taskId: envelope.task.taskId, duplicate: true };
      }
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
      const retryMax = config.providerRecovery.retryMax;
      const retryable = RETRYABLE_PROVIDER_ERRORS.has(reason);
      const exhausted = attempt > retryMax || !retryable;
      const backoff = Math.min(
        config.providerRecovery.backoffMaxMs,
        config.providerRecovery.backoffBaseMs
          * (2 ** Math.max(0, attempt - 1)),
      );
      const notBefore = exhausted ? null : new Date(now().getTime() + backoff);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: exhausted ? "failed" : "retry_wait",
        stage: exhausted ? "failed" : "retry_wait",
        attempt,
        not_before: notBefore,
        last_error_reason: reason,
      }, { client });
      await appendOps(envelope, exhausted ? "failed" : "retry_wait", attempt, { reason, detail }, client);
      return { status: exhausted ? "failed" : "retry_wait", reason, taskId: envelope.task.taskId, notBefore };
    });
  }

  async function persistCircuitDeferral(envelope, adapterResult) {
    const providerHealth = adapterResult.providerHealth || {};
    const needsAttention = providerHealth.status === "needs_attention";
    const fallbackRetryAt = new Date(
      now().getTime() + config.providerRecovery.backoffBaseMs,
    );
    const notBefore = needsAttention ? null : (providerHealth.nextRetryAt || fallbackRetryAt);
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before circuit deferral persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) {
        return { status: rowValue(task, "status", "status"), taskId: envelope.task.taskId, duplicate: true };
      }
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: needsAttention ? "failed" : "retry_wait",
        stage: "provider_circuit_open",
        not_before: notBefore,
        last_error_reason: "provider_circuit_open",
      }, { client });
      await appendOps(envelope, "provider_circuit_open", Number(rowValue(task, "attempt", "attempt") ?? 0), {
        providerStatus: providerHealth.status || "degraded",
        nextRetryAt: notBefore,
      }, client);
      return {
        status: needsAttention ? "failed" : "retry_wait",
        reason: "provider_circuit_open",
        taskId: envelope.task.taskId,
        notBefore,
      };
    });
  }

  async function reserveSchemaInvalidRetry(envelope, adapterResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before schema retry persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) return null;
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      const used = Number(stagePayload.schemaInvalidAttempts || 0);
      const limit = config.providerRecovery.schemaInvalidRetryMax;
      if (used >= limit) return null;
      const attempt = Number(rowValue(task, "attempt", "attempt") ?? 0) + 1;
      stagePayload.schemaInvalidAttempts = used + 1;
      stagePayload.schemaRepairFeedback = createRepairFeedback(
        adapterResult.detail,
        stagePayload.schemaInvalidAttempts,
        envelope.task,
      );
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running",
        stage: "schema_invalid_retry",
        stage_payload: stagePayload,
        attempt,
        not_before: null,
        last_error_reason: "output_schema_invalid",
      }, { client });
      await appendOps(envelope, "output_schema_invalid_retry", attempt, {
        repairFeedback: stagePayload.schemaRepairFeedback,
      }, client);
      return stagePayload.schemaRepairFeedback;
    });
  }

  async function proposeWithRecovery(envelope) {
    const persisted = await repositories.runtime.getTask(envelope.task.taskId);
    let repairFeedback = rowValue(persisted, "stage_payload", "stagePayload")?.schemaRepairFeedback ?? null;
    while (true) {
      const adapterResult = await providerAdapter.propose(envelope, { repairFeedback });
      if (adapterResult.status === "deferred" && adapterResult.reason === "provider_circuit_open") {
        return { terminalResult: await persistCircuitDeferral(envelope, adapterResult) };
      }
      const retryableSchemaOutput = adapterResult.status === "error"
        && adapterResult.reason === "output_schema_invalid"
        && adapterResult.detail?.boundary === "output";
      if (!retryableSchemaOutput) return { adapterResult };
      const reservedFeedback = await reserveSchemaInvalidRetry(envelope, adapterResult);
      if (!reservedFeedback) return { adapterResult };
      repairFeedback = reservedFeedback;
    }
  }

  async function persistSemanticResult(envelope, semanticResult) {
    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before Semantic result persistence");
      if (TERMINAL.has(rowValue(task, "status", "status"))) return false;
      const stagePayload = structuredClone(rowValue(task, "stage_payload", "stagePayload") || {});
      stagePayload.semanticResult = structuredClone(semanticResult);
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running",
        stage: "semantic_result_persisted",
        stage_payload: stagePayload,
        not_before: null,
        last_error_reason: null,
      }, { client });
      return true;
    });
  }

  async function processEnvelope(envelope) {
    const persisted = await repositories.runtime.getTask(envelope.task.taskId);
    if (!persisted) throw new Error("Librarian task is not durable");
    const persistedStatus = rowValue(persisted, "status", "status");
    if (TERMINAL.has(persistedStatus)) {
      return {
        status: persistedStatus === "succeeded" ? "completed" : persistedStatus,
        taskId: envelope.task.taskId,
        revision: rowValue(persisted, "result_revision", "resultRevision") ?? null,
        duplicate: true,
      };
    }
    const persistedNotBefore = rowValue(persisted, "not_before", "notBefore");
    if (persistedStatus === "retry_wait" && persistedNotBefore && new Date(persistedNotBefore).getTime() > now().getTime()) {
      return {
        status: "retry_wait",
        reason: rowValue(persisted, "last_error_reason", "lastErrorReason") || "retry_wait",
        taskId: envelope.task.taskId,
        notBefore: persistedNotBefore,
      };
    }
    const current = await repositories.state.getState(envelope.task.userId, envelope.task.presetId);
    if (!current || current.meta.sourceGeneration !== envelope.task.sourceGeneration || current.meta.revision !== envelope.task.baseRevision) {
      await repositories.withTransaction(async (client) => {
        const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
        if (task && !TERMINAL.has(rowValue(task, "status", "status"))) {
          await repositories.runtime.updateTask(envelope.task.taskId, {
            status: "cancelled",
            stage: "stale",
            not_before: null,
            last_error_reason: "revision_mismatch",
          }, { client });
          await appendOps(envelope, "stale", Number(rowValue(task, "attempt", "attempt") ?? 0), {
            expectedRevision: envelope.task.baseRevision,
            actualRevision: current?.meta?.revision ?? null,
          }, client);
        }
      });
      return { status: "stale", reason: "revision_mismatch", taskId: envelope.task.taskId };
    }

    const durablePayload = rowValue(persisted, "stage_payload", "stagePayload");
    let semanticResult = durablePayload?.semanticResult || null;
    if (!semanticResult) {
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "running",
        stage: "proposing",
        not_before: null,
        last_error_reason: null,
      });
      const proposed = await proposeWithRecovery(envelope);
      if (proposed.terminalResult) return proposed.terminalResult;
      const { adapterResult } = proposed;
      if (adapterResult.status !== "ok") return persistFailure(envelope, adapterResult.reason || "llm_call_failed", adapterResult.detail);
      semanticResult = adapterResult.output;
      await persistSemanticResult(envelope, semanticResult);
    }

    let proposal;
    try {
      proposal = compileLibrarianProposal({
        artifact: envelope.artifact,
        semanticResult,
        baseState: current,
      });
    } catch (error) {
      return persistFailure(envelope, error.reason || "compile_invariant_failed", error.detail || { message: error.message });
    }

    return repositories.withTransaction(async (client) => {
      const task = await repositories.runtime.getTaskForUpdate(envelope.task.taskId, { client });
      if (!task) throw new Error("Librarian task disappeared before commit");
      if (TERMINAL.has(rowValue(task, "status", "status"))) {
        return {
          status: rowValue(task, "status", "status") === "succeeded" ? "completed" : rowValue(task, "status", "status"),
          taskId: envelope.task.taskId,
          duplicate: true,
        };
      }
      const state = await repositories.state.getState(envelope.task.userId, envelope.task.presetId, { client, forUpdate: true });
      if (!state || state.meta.sourceGeneration !== envelope.task.sourceGeneration || state.meta.revision !== envelope.task.baseRevision) {
        await repositories.runtime.updateTask(envelope.task.taskId, {
          status: "cancelled", stage: "stale", not_before: null, last_error_reason: "revision_mismatch",
        }, { client });
        await appendOps(envelope, "stale", Number(rowValue(task, "attempt", "attempt") ?? 0), {
          expectedRevision: envelope.task.baseRevision,
          actualRevision: state?.meta?.revision ?? null,
        }, client);
        return { status: "stale", reason: "revision_mismatch", taskId: envelope.task.taskId };
      }

      let reduction;
      try {
        reduction = reduceLibrarianProposal({ state, task: envelope.task, proposal, config, idFactory });
      } catch (error) {
        await repositories.runtime.updateTask(envelope.task.taskId, {
          status: "failed", stage: "failed", not_before: null, last_error_reason: error.reason || "compile_invariant_failed",
        }, { client });
        await appendOps(envelope, "failed", Number(rowValue(task, "attempt", "attempt") ?? 0), {
          reason: error.reason || "compile_invariant_failed",
          detail: error.detail || { message: error.message },
        }, client);
        return { status: "failed", reason: error.reason || "compile_invariant_failed", taskId: envelope.task.taskId };
      }

      if (reduction.outcome === "noop") {
        await repositories.runtime.upsertLibrarianCheckpoint(envelope.task.userId, envelope.task.presetId, {
          sourceGeneration: envelope.task.sourceGeneration,
          completedTurnOrdinal: envelope.task.turnOrdinal,
          boundaryMessageId: envelope.task.boundaryMessageId,
          lastTaskId: envelope.task.taskId,
        }, { client });
        await repositories.runtime.updateTask(envelope.task.taskId, {
          status: "succeeded", stage: "noop", result_revision: null, not_before: null, last_error_reason: null,
        }, { client });
        await appendOps(envelope, "noop", Number(rowValue(task, "attempt", "attempt") ?? 0), {
          boundaryMessageId: envelope.task.boundaryMessageId,
          turnOrdinal: envelope.task.turnOrdinal,
        }, client);
        return { status: "noop", taskId: envelope.task.taskId, revision: state.meta.revision };
      }

      await repositories.state.writeState(envelope.task.userId, envelope.task.presetId, reduction.state, { client });
      await repositories.audit.insertSnapshot(envelope.task.userId, envelope.task.presetId, {
        sourceGeneration: envelope.task.sourceGeneration,
        revision: reduction.state.meta.revision,
        schemaVersion: SCHEMA_VERSION,
        state: reduction.snapshot,
      }, { client });
      const groupId = idFactory();
      await repositories.audit.insertEventGroup({
        event_group_id: groupId,
        user_id: envelope.task.userId,
        preset_id: envelope.task.presetId,
        task_id: envelope.task.taskId,
        target_key: LIBRARIAN_TARGET_KEY,
        source_generation: envelope.task.sourceGeneration,
        schema_version: SCHEMA_VERSION,
        base_revision: state.meta.revision,
        result_revision: reduction.state.meta.revision,
        cursor_before: null,
        cursor_after: null,
        group_kind: "maintenance",
      }, { client });
      await repositories.audit.insertEvents(
        reduction.events.map((event, index) => mapEventToRow(event, envelope, groupId, index)),
        { client },
      );
      await repositories.runtime.upsertLibrarianCheckpoint(envelope.task.userId, envelope.task.presetId, {
        sourceGeneration: envelope.task.sourceGeneration,
        completedTurnOrdinal: envelope.task.turnOrdinal,
        boundaryMessageId: envelope.task.boundaryMessageId,
        lastTaskId: envelope.task.taskId,
      }, { client });
      await repositories.runtime.updateTask(envelope.task.taskId, {
        status: "succeeded",
        stage: "committed",
        result_revision: reduction.state.meta.revision,
        not_before: null,
        last_error_reason: null,
      }, { client });
      await appendOps(envelope, "committed", Number(rowValue(task, "attempt", "attempt") ?? 0), {
        revision: reduction.state.meta.revision,
        operationCount: reduction.events.length,
      }, client);
      return {
        status: "committed",
        taskId: envelope.task.taskId,
        revision: reduction.state.meta.revision,
        events: reduction.events,
      };
    });
  }

  return Object.freeze({
    createTask,
    processEnvelope,
  });
}

module.exports = {
  createLibrarianTaskExecutor,
  librarianTaskRow,
  validateLibrarianConfig,
};
