const { getProviderDefinition } = require("./providers");

function normalizeProviderId(providerId) {
  return String(providerId || "").trim();
}

function normalizeModelId(modelId) {
  return String(modelId || "").trim();
}

function listModelsForProvider(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const definition = getProviderDefinition(normalizedProviderId);
  const models = Array.isArray(definition?.models) ? definition.models : [];
  return models.map((model) => ({ id: model.id, name: model.name })).filter((model) => model.id);
}

function isSupportedModel(providerId, modelId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedProviderId || !normalizedModelId) return false;

  return listModelsForProvider(normalizedProviderId).some((model) => String(model?.id || "").trim() === normalizedModelId);
}

module.exports = {
  listModelsForProvider,
  isSupportedModel,
};
