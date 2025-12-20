const PROVIDER_MODELS = {
  grok: [
    { id: "grok-4", name: "grok-4" },
    { id: "grok-4-fast-non-reasoning", name: "grok-4-fast-non-reasoning" },
  ],
  deepseek: [
    { id: "deepseek-chat", name: "deepseek-chat" },
    { id: "deepseek-reasoner", name: "deepseek-reasoner" },
  ],
};

function normalizeProviderId(providerId) {
  return String(providerId || "").trim();
}

function normalizeModelId(modelId) {
  return String(modelId || "").trim();
}

function listModelsForProvider(providerId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const models = PROVIDER_MODELS[normalizedProviderId];
  return Array.isArray(models) ? [...models] : [];
}

function isSupportedModel(providerId, modelId) {
  const normalizedProviderId = normalizeProviderId(providerId);
  const normalizedModelId = normalizeModelId(modelId);
  if (!normalizedProviderId || !normalizedModelId) return false;
  const models = PROVIDER_MODELS[normalizedProviderId] || [];
  return models.some((model) => String(model?.id || "").trim() === normalizedModelId);
}

module.exports = {
  listModelsForProvider,
  isSupportedModel,
};

