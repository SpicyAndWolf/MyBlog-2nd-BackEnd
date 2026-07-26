const crypto = require("node:crypto");
const { normalDedupeKey } = require("./envelope");

function phaseId(taskId, phase = "normal_commit") {
  const hex = crypto
    .createHash("sha256")
    .update(`${taskId}:${phase}`)
    .digest("hex")
    .slice(0, 32)
    .split("");
  hex[12] = "5";
  hex[16] = ((parseInt(hex[16], 16) & 3) | 8).toString(16);
  const value = hex.join("");
  return [
    value.slice(0, 8),
    value.slice(8, 12),
    value.slice(12, 16),
    value.slice(16, 20),
    value.slice(20),
  ].join("-");
}

function taskRow(envelope, overrides = {}) {
  const task = envelope.task;
  return {
    task_id: task.taskId,
    dedupe_key: normalDedupeKey(task),
    user_id: task.userId,
    preset_id: task.presetId,
    target_key: task.targetKey,
    source_generation: task.sourceGeneration,
    task_type: "normal",
    schema_version: task.schemaVersion,
    parent_task_id: null,
    predecessor_task_id: null,
    resume_epoch: 0,
    status: "queued",
    stage: "proposing",
    cursor_before: task.cursorBefore,
    target_message_id: task.targetMessageId,
    base_revision: task.baseRevision,
    task_payload: envelope,
    stage_payload: null,
    attempt: 0,
    context_expansion_attempt: 0,
    not_before: null,
    last_error_reason: null,
    result_revision: null,
    ...overrides,
  };
}

async function recordSuccessfulTarget(repositories, envelope, client) {
  const args = {
    targetKey: envelope.task.targetKey,
    sourceGeneration: envelope.task.sourceGeneration,
    taskId: envelope.task.taskId,
  };
  if (repositories.runtime.recordSuccessfulTargetTask) {
    return repositories.runtime.recordSuccessfulTargetTask(
      envelope.task.userId,
      envelope.task.presetId,
      args,
      { client },
    );
  }
  return repositories.runtime.upsertTargetStatus(
    envelope.task.userId,
    envelope.task.presetId,
    {
      ...args,
      lastTaskId: args.taskId,
      status: "healthy",
      consecutiveErrors: 0,
      lastErrorReason: null,
      nextRetryAt: null,
    },
    { client },
  );
}

module.exports = { phaseId, taskRow, recordSuccessfulTarget };
