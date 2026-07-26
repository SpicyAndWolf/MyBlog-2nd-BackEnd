const { buildOutputSchema } = require("./outputSchema");
const {
  buildProposerUserPayload,
  schemaRepairPrompt,
} = require("./memoryProviderAdapter");
const {
  bindOutputSchema,
  bindSpecialistSchema,
} = require("./bindOutputSchema");
const { buildStructuredHttpRequest } = require("./structuredHttpRequest");

const PROFILE_SPECIALISTS = Object.freeze([
  Object.freeze({ proposer: "userProfileProposer", section: "userProfile" }),
  Object.freeze({ proposer: "assistantProfileProposer", section: "assistantProfile" }),
  Object.freeze({ proposer: "relationshipProposer", section: "relationship" }),
]);

function specialistPayload(userPayload, specialist) {
  const payload = structuredClone(userPayload);
  payload.task = {
    ...payload.task,
    proposer: specialist.proposer,
    targetSections: [specialist.section],
  };
  return payload;
}

function specialistArtifact(artifact, specialist) {
  const next = structuredClone(artifact);
  next.publicInput.task = {
    ...next.publicInput.task,
    proposer: specialist.proposer,
    targetSections: [specialist.section],
  };
  return next;
}

function previewEntry(providerConfig, semanticRequest, { phase, section = null } = {}) {
  const httpRequest = buildStructuredHttpRequest(providerConfig, semanticRequest);
  return {
    phase,
    proposer: semanticRequest.proposer,
    section,
    method: httpRequest.method,
    endpoint: httpRequest.endpoint,
    body: httpRequest.body,
  };
}

async function buildProviderRequestPreviews({
  envelope,
  repairFeedback = null,
  providerConfig,
  promptLoader,
} = {}) {
  if (!envelope?.task || !envelope?.artifact) throw new Error("Effective provider envelope is required");
  if (!providerConfig) throw new Error("Current Memory Provider configuration is unavailable");
  if (typeof promptLoader !== "function") throw new Error("Prompt loader is required");

  const userPayload = buildProposerUserPayload(envelope);
  if (envelope.task.proposer !== "profileRelationshipProposer") {
    const responseSchema = bindOutputSchema(
      buildOutputSchema(envelope.task.proposer, envelope.task.targetSections),
      envelope.artifact,
      envelope.task.targetSections,
    );
    const systemPrompt = schemaRepairPrompt(
      await promptLoader(envelope.task.proposer),
      repairFeedback,
      userPayload.task,
    );
    return [previewEntry(providerConfig, {
      proposer: envelope.task.proposer,
      systemPrompt,
      userPayload,
      responseSchema,
    }, {
      phase: repairFeedback ? "schema-repair" : "initial",
    })];
  }

  const retrySpecialist = PROFILE_SPECIALISTS.find(
    (entry) => entry.proposer === repairFeedback?.specialist,
  );
  const selected = retrySpecialist ? [retrySpecialist] : PROFILE_SPECIALISTS;
  return Promise.all(selected.map(async (specialist) => {
    const payload = specialistPayload(userPayload, specialist);
    const artifact = specialistArtifact(envelope.artifact, specialist);
    const feedback = retrySpecialist?.proposer === specialist.proposer
      ? repairFeedback
      : null;
    const responseSchema = bindSpecialistSchema(
      buildOutputSchema(specialist.proposer, [specialist.section]),
      artifact,
      specialist.section,
    );
    const systemPrompt = schemaRepairPrompt(
      await promptLoader(specialist.proposer),
      feedback,
      payload.task,
    );
    return previewEntry(providerConfig, {
      proposer: specialist.proposer,
      systemPrompt,
      userPayload: payload,
      responseSchema,
    }, {
      phase: feedback ? "schema-repair" : "initial",
      section: specialist.section,
    });
  }));
}

module.exports = {
  PROFILE_SPECIALISTS,
  buildProviderRequestPreviews,
};
