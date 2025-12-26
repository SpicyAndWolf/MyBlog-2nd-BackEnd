const chatModel = require("@models/chatModel");
const chatPresetModel = require("@models/chatPresetModel");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const { buildOpenAiChatMessages } = require("../services/chat/context");
const { chatConfig, llmConfig } = require("../config");
const { logger, withRequestContext } = require("../logger");
const {
  getProviderDefinition,
  isSupportedProvider,
  listConfiguredProviders,
  listSupportedProviders,
} = require("../services/llm/providers");
const { isSupportedModel, listModelsForProvider } = require("../services/llm/models");
const {
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
} = require("../services/llm/chatCompletions");
const { getGlobalNumericRange, getProviderNumericRange, clampNumberWithRange } = require("../services/llm/settingsSchema");

function parseSessionId(rawValue) {
  const asNumber = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

function parseMessageId(rawValue) {
  const asNumber = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

function normalizePresetId(rawValue) {
  const normalized = String(rawValue ?? "").trim();
  if (!normalized) return null;
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(normalized)) return null;
  return normalized;
}

function getSessionPresetId(session) {
  return (
    normalizePresetId(session?.preset_id || session?.presetId) ||
    normalizePresetId(session?.settings?.systemPromptPresetId) ||
    null
  );
}

function getDefaultPresetId() {
  return normalizePresetId(chatConfig.defaultSettings?.systemPromptPresetId) || "default";
}

async function resolvePresetForSession({
  userId,
  session,
  incomingSettings,
  explicitPresetId,
  enforceMatch = false,
} = {}) {
  const defaultPresetId = getDefaultPresetId();
  const sessionPresetId = session ? getSessionPresetId(session) : null;
  const hasIncomingPresetId =
    incomingSettings && Object.prototype.hasOwnProperty.call(incomingSettings, "systemPromptPresetId");
  const hasExplicitPresetId = explicitPresetId !== undefined;

  let requestedPresetId = null;
  if (hasExplicitPresetId) {
    requestedPresetId = normalizePresetId(explicitPresetId);
    if (!requestedPresetId) return { error: "Invalid preset id" };
  } else if (hasIncomingPresetId) {
    requestedPresetId = normalizePresetId(incomingSettings.systemPromptPresetId);
    if (!requestedPresetId) return { error: "Invalid preset id" };
  }

  if (enforceMatch && sessionPresetId) {
    if (requestedPresetId && requestedPresetId !== sessionPresetId) {
      return { error: "Preset mismatch" };
    }
    requestedPresetId = sessionPresetId;
  }

  const desiredPresetId = requestedPresetId || sessionPresetId || defaultPresetId;

  if (!desiredPresetId) return { error: "Invalid preset id" };

  let preset = await chatPresetModel.getPreset(userId, desiredPresetId);
  if (!preset) {
    return { error: "Preset not found" };
  }

  return { presetId: preset.id, preset, fallback: false };
}

const DEFAULT_SESSION_TITLE = "新对话";

function formatSessionTitleFromMessage(messageText) {
  const normalized = String(messageText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return DEFAULT_SESSION_TITLE;
  return normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized;
}

function sanitizeChatSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) return {};

  const sanitized = {};

  if (typeof rawSettings.providerId === "string") sanitized.providerId = rawSettings.providerId.trim();
  if (typeof rawSettings.modelId === "string") sanitized.modelId = rawSettings.modelId.trim();
  if (typeof rawSettings.systemPrompt === "string") sanitized.systemPrompt = rawSettings.systemPrompt;
  if (typeof rawSettings.systemPromptPresetId === "string")
    sanitized.systemPromptPresetId = rawSettings.systemPromptPresetId.trim();

  const temperature = Number(rawSettings.temperature);
  if (Number.isFinite(temperature)) sanitized.temperature = temperature;

  const topP = Number(rawSettings.topP);
  if (Number.isFinite(topP)) sanitized.topP = topP;

  const maxOutputTokens = Number(rawSettings.maxOutputTokens);
  if (Number.isFinite(maxOutputTokens)) sanitized.maxOutputTokens = maxOutputTokens;

  const presencePenalty = Number(rawSettings.presencePenalty);
  if (Number.isFinite(presencePenalty)) sanitized.presencePenalty = presencePenalty;

  const frequencyPenalty = Number(rawSettings.frequencyPenalty);
  if (Number.isFinite(frequencyPenalty)) sanitized.frequencyPenalty = frequencyPenalty;

  if (typeof rawSettings.enableWebSearch === "boolean") sanitized.enableWebSearch = rawSettings.enableWebSearch;
  if (typeof rawSettings.stream === "boolean") sanitized.stream = rawSettings.stream;

  const providerId = String(sanitized.providerId || "").trim();
  const providerDefinition = providerId ? getProviderDefinition(providerId) : null;
  const schema = Array.isArray(providerDefinition?.settingsSchema) ? providerDefinition.settingsSchema : [];

  for (const control of schema) {
    const key = typeof control?.key === "string" ? control.key.trim() : "";
    if (!key) continue;
    if (Object.prototype.hasOwnProperty.call(sanitized, key)) continue;

    const type = String(control?.type || "").trim();

    if (type === "toggle") {
      if (typeof rawSettings[key] === "boolean") sanitized[key] = rawSettings[key];
      continue;
    }

    if (type === "select") {
      if (typeof rawSettings[key] !== "string") continue;
      const value = rawSettings[key].trim();
      if (!value) continue;

      const options = Array.isArray(control.options) ? control.options : [];
      const allowed = new Set(
        options
          .map((option) => String(option?.value ?? "").trim())
          .filter(Boolean)
      );
      if (!allowed.has(value)) continue;

      sanitized[key] = value;
      continue;
    }

    if (type === "range" || type === "number") {
      const number = Number(rawSettings[key]);
      if (Number.isFinite(number)) sanitized[key] = number;
    }
  }

  return sanitized;
}

function normalizeChatSettingsWithSchema(settings, { providerId } = {}) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return {};

  const normalized = { ...settings };
  const keys = ["temperature", "topP", "maxOutputTokens", "presencePenalty", "frequencyPenalty"];

  for (const key of keys) {
    if (normalized[key] === undefined) continue;

    const range = providerId ? getProviderNumericRange(providerId, key) : null;
    const fallbackRange = getGlobalNumericRange(key);
    const nextValue = clampNumberWithRange(normalized[key], range || fallbackRange);

    if (!Number.isFinite(nextValue)) {
      delete normalized[key];
      continue;
    }

    if (key === "maxOutputTokens") {
      normalized[key] = Math.trunc(nextValue);
    } else {
      normalized[key] = nextValue;
    }
  }

  return normalized;
}

function mergeSettings(baseSettings, overrideSettings) {
  const base = baseSettings && typeof baseSettings === "object" && !Array.isArray(baseSettings) ? baseSettings : {};
  const override =
    overrideSettings && typeof overrideSettings === "object" && !Array.isArray(overrideSettings)
      ? overrideSettings
      : {};
  return { ...base, ...override };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function getAbortReasonMessage(signal) {
  const reason = signal?.reason;
  if (!reason) return "";
  if (reason instanceof Error) return reason.message || "";
  return String(reason);
}

async function safeUnlink(filePath) {
  if (!filePath) return;
  try {
    await fs.promises.unlink(filePath);
  } catch {
    // ignore
  }
}

async function compressAvatarImage({ inputPath, baseName }) {
  const dir = path.dirname(inputPath);
  const outputFilename = `${baseName}-compressed.webp`;
  const outputPath = path.join(dir, outputFilename);

  await sharp(inputPath)
    .rotate()
    .resize(256, 256, { fit: "cover" })
    .webp({ quality: 82 })
    .toFile(outputPath);

  await safeUnlink(inputPath);
  return { filename: outputFilename, path: outputPath };
}

const chatController = {
  async getMeta(req, res) {
    try {
      const configuredProviders = listConfiguredProviders();
      const baseProviders = configuredProviders.length ? configuredProviders : listSupportedProviders();

      function resolveDefaultModelId(providerId) {
        const configuredDefaultModelId = chatConfig.defaultModelByProvider?.[providerId];
        const fallbackModelId = listModelsForProvider(providerId)[0]?.id || "";
        const defaultModelId =
          (typeof configuredDefaultModelId === "string" && isSupportedModel(providerId, configuredDefaultModelId)
            ? configuredDefaultModelId.trim()
            : fallbackModelId) || "";
        return defaultModelId;
      }

      const providers = baseProviders
        .map((provider) => {
          const id = String(provider?.id || "").trim();
          const name = String(provider?.name || "").trim();
          const models = listModelsForProvider(id);
          const definition = getProviderDefinition(id);

          const defaults = {
            ...((chatConfig.defaultSettingsByProvider || {})[id] || chatConfig.defaultSettings || {}),
            providerId: id,
            modelId: resolveDefaultModelId(id),
          };
          if (definition?.capabilities?.webSearch === false) defaults.enableWebSearch = false;

          return {
            id,
            name,
            models,
            adapter: definition?.adapter || "unknown",
            capabilities: definition?.capabilities || {},
            settingsSchema: Array.isArray(definition?.settingsSchema) ? definition.settingsSchema : [],
            defaults,
          };
        })
        .filter((provider) => provider.id && provider.name && Array.isArray(provider.models) && provider.models.length);

      const fallbackProviderId = providers[0]?.id || "";
      const desiredProviderId = String(chatConfig.defaultProviderId || "").trim();
      const defaultProviderId =
        (desiredProviderId && providers.some((provider) => provider.id === desiredProviderId)
          ? desiredProviderId
          : fallbackProviderId) || "";

      let defaultModelId = "";
      if (defaultProviderId) {
        const desiredModelId = chatConfig.defaultModelByProvider?.[defaultProviderId];
        if (typeof desiredModelId === "string" && isSupportedModel(defaultProviderId, desiredModelId)) {
          defaultModelId = desiredModelId.trim();
        } else {
          defaultModelId = providers.find((provider) => provider.id === defaultProviderId)?.models?.[0]?.id || "";
        }
      }

      const selectedProviderDefinition = getProviderDefinition(defaultProviderId);
      const defaults = {
        ...((chatConfig.defaultSettingsByProvider || {})[defaultProviderId] || chatConfig.defaultSettings || {}),
        providerId: defaultProviderId,
        modelId: defaultModelId,
      };
      if (selectedProviderDefinition?.capabilities?.webSearch === false) defaults.enableWebSearch = false;

      res.status(200).json({ providers, defaults });
    } catch (error) {
      logger.error("chat_meta_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async listPresets(req, res) {
    try {
      const userId = req.user?.id;
      const presets = await chatPresetModel.listPresets(userId);
      res.status(200).json({ presets });
    } catch (error) {
      logger.error("chat_preset_list_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async createPreset(req, res) {
    try {
      const userId = req.user?.id;

      const presetId = normalizePresetId(req.body?.id);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset id is reserved" });
      }

      const name = String(req.body?.name ?? "").trim();
      if (!name) return res.status(400).json({ error: "Preset name cannot be empty" });

      const systemPrompt = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : "";

      const preset = await chatPresetModel.createPreset(userId, {
        id: presetId,
        name,
        systemPrompt,
        avatarUrl: null,
      });

      res.status(201).json({ preset });
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Preset id already exists" });
      }
      logger.error("chat_preset_create_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async updatePreset(req, res) {
    try {
      const userId = req.user?.id;
      const currentId = normalizePresetId(req.params.presetId);
      if (!currentId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(currentId)) {
        return res.status(400).json({ error: "Builtin preset cannot be updated" });
      }

      let nextId = undefined;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "id")) {
        nextId = normalizePresetId(req.body?.id);
        if (!nextId) return res.status(400).json({ error: "Invalid preset id" });
        if (chatPresetModel.isBuiltinPresetId(nextId)) {
          return res.status(400).json({ error: "Builtin preset id is reserved" });
        }
      }

      let nextName = undefined;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "name")) {
        nextName = String(req.body?.name ?? "").trim();
        if (!nextName) return res.status(400).json({ error: "Preset name cannot be empty" });
      }

      let nextSystemPrompt = undefined;
      if (Object.prototype.hasOwnProperty.call(req.body || {}, "systemPrompt")) {
        nextSystemPrompt = typeof req.body?.systemPrompt === "string" ? req.body.systemPrompt : "";
      }

      const preset = await chatPresetModel.updatePreset(userId, currentId, {
        id: nextId,
        name: nextName,
        systemPrompt: nextSystemPrompt,
      });
      if (!preset) return res.status(404).json({ error: "Preset not found" });

      res.status(200).json({ preset });
    } catch (error) {
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Preset id already exists" });
      }
      if (error?.code === "BUILTIN_PRESET_ID" || error?.code === "BUILTIN_PRESET_READONLY") {
        return res.status(400).json({ error: error.message });
      }
      logger.error(
        "chat_preset_update_failed",
        withRequestContext(req, { error, presetId: req.params.presetId })
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async deletePreset(req, res) {
    try {
      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset cannot be deleted" });
      }

      const result = await chatPresetModel.deletePreset(userId, presetId);
      if (!result.deleted) return res.status(404).json({ error: "Preset not found" });

      res.status(204).send();
    } catch (error) {
      logger.error(
        "chat_preset_delete_failed",
        withRequestContext(req, { error, presetId: req.params.presetId })
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async uploadPresetAvatar(req, res) {
    try {
      const userId = req.user?.id;
      const presetId = normalizePresetId(req.params.presetId);
      if (!presetId) return res.status(400).json({ error: "Invalid preset id" });
      if (chatPresetModel.isBuiltinPresetId(presetId)) {
        return res.status(400).json({ error: "Builtin preset cannot upload avatar" });
      }

      if (!req.file) return res.status(400).json({ error: "Missing avatar file" });

      const existingPreset = await chatPresetModel.getPreset(userId, presetId);
      if (!existingPreset || existingPreset.isBuiltin) {
        await safeUnlink(req.file.path);
        return res.status(404).json({ error: "Preset not found" });
      }

      const baseName = path.parse(req.file.filename).name;
      let processed;
      try {
        processed = await compressAvatarImage({ inputPath: req.file.path, baseName });
      } catch (processError) {
        await safeUnlink(req.file.path);
        return res.status(400).json({ error: "Avatar processing failed" });
      }

      const avatarUrl = `/uploads/assistant_avatars/${processed.filename}`;
      let preset;
      try {
        preset = await chatPresetModel.updatePresetAvatar(userId, presetId, avatarUrl);
      } catch (updateError) {
        await safeUnlink(processed.path);
        throw updateError;
      }
      if (!preset) {
        await safeUnlink(processed.path);
        return res.status(404).json({ error: "Preset not found" });
      }

      res.status(200).json({ preset });
    } catch (error) {
      logger.error(
        "chat_preset_avatar_upload_failed",
        withRequestContext(req, { error, presetId: req.params.presetId })
      );
      res.status(500).json({ error: error?.message || "Internal Server Error" });
    }
  },

  async listSessions(req, res) {
    try {
      const userId = req.user?.id;
      const sessions = await chatModel.listSessions(userId);
      res.status(200).json({ sessions });
    } catch (error) {
      logger.error("chat_session_list_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async createSession(req, res) {
    try {
      const userId = req.user?.id;
      const rawSettings = sanitizeChatSettings(req.body?.settings);
      const presetResolution = await resolvePresetForSession({
        userId,
        incomingSettings: rawSettings,
        explicitPresetId: req.body?.presetId,
      });
      if (presetResolution.error) return res.status(400).json({ error: presetResolution.error });

      const { presetId, preset } = presetResolution;
      const settings = {
        ...rawSettings,
        systemPromptPresetId: presetId,
        systemPrompt: preset?.systemPrompt || "",
      };
      const title = req.body?.title;
      const session = await chatModel.createSession(userId, { title, settings, presetId });
      res.status(201).json({ session });
    } catch (error) {
      logger.error("chat_session_create_failed", withRequestContext(req, { error }));
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async renameSession(req, res) {
    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const title = String(req.body?.title || "").trim();
      if (!title) return res.status(400).json({ error: "Title cannot be empty" });

      const session = await chatModel.updateSessionTitle(userId, sessionId, title);
      if (!session) return res.status(404).json({ error: "Session not found" });

      res.status(200).json({ session });
    } catch (error) {
      logger.error(
        "chat_session_rename_failed",
        withRequestContext(req, { error, sessionId: req.params.sessionId })
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async deleteSession(req, res) {
    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const deleted = await chatModel.deleteSession(userId, sessionId);
      if (!deleted) return res.status(404).json({ error: "Session not found" });

      res.status(204).send();
    } catch (error) {
      logger.error(
        "chat_session_delete_failed",
        withRequestContext(req, { error, sessionId: req.params.sessionId })
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async listMessages(req, res) {
    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const messages = await chatModel.listMessages(userId, sessionId);
      if (messages === null) return res.status(404).json({ error: "Session not found" });

      res.status(200).json({ messages });
    } catch (error) {
      logger.error(
        "chat_messages_list_failed",
        withRequestContext(req, { error, sessionId: req.params.sessionId })
      );
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async editMessage(_req, res) {
    const req = _req;

    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const messageId = parseMessageId(req.params.messageId);
      if (!messageId) return res.status(400).json({ error: "Invalid messageId" });

      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "Content cannot be empty" });

      const regenerate = Boolean(req.body?.regenerate);
      const truncate = regenerate ? true : Boolean(req.body?.truncate);

      const session = await chatModel.getSession(userId, sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });

      const message = await chatModel.getMessage(userId, sessionId, messageId);
      if (!message) return res.status(404).json({ error: "Message not found" });
      if (message.role !== "user") return res.status(400).json({ error: "Only user messages can be edited" });

      if (truncate) {
        await chatModel.deleteMessagesAfter(userId, sessionId, messageId);
      }

      const updatedUserMessage = await chatModel.updateMessageContent(userId, sessionId, messageId, content);
      if (!updatedUserMessage) return res.status(404).json({ error: "Message not found" });

      let updatedSession = session;

      const firstMessageId = await chatModel.getFirstMessageId(userId, sessionId);
      if (session.title === DEFAULT_SESSION_TITLE && firstMessageId === messageId) {
        const nextTitle = formatSessionTitleFromMessage(content);
        updatedSession = (await chatModel.updateSessionTitle(userId, sessionId, nextTitle)) || updatedSession;
      }

      const incomingSettings = sanitizeChatSettings(req.body?.settings);
      const presetResolution = await resolvePresetForSession({ userId, session, incomingSettings, enforceMatch: true });
      if (presetResolution.error) return res.status(400).json({ error: presetResolution.error });

      const { presetId, preset } = presetResolution;
      const mergedSettings = mergeSettings(session.settings, incomingSettings);
      mergedSettings.systemPromptPresetId = presetId;
      mergedSettings.systemPrompt = preset?.systemPrompt || "";
      const effectiveSettings = normalizeChatSettingsWithSchema(mergedSettings);
      updatedSession =
        (await chatModel.updateSessionSettings(userId, sessionId, effectiveSettings, presetId)) || updatedSession;

      if (!regenerate) {
        updatedSession = (await chatModel.touchSession(userId, sessionId)) || updatedSession;
        return res.status(200).json({ session: updatedSession, user_message: updatedUserMessage });
      }

      const defaultProviderId = chatConfig.defaultProviderId;
      const candidateProviderId = effectiveSettings.providerId || defaultProviderId;
      if (!isSupportedProvider(candidateProviderId)) {
        return res.status(400).json({ error: `Unsupported provider: ${candidateProviderId}` });
      }
      const providerId = String(candidateProviderId).trim();
      const providerDefinition = getProviderDefinition(providerId);

      const configuredDefaultModelId = chatConfig.defaultModelByProvider?.[providerId];
      const fallbackModelId = listModelsForProvider(providerId)[0]?.id || "";
      const defaultModelId =
        (typeof configuredDefaultModelId === "string" && isSupportedModel(providerId, configuredDefaultModelId)
          ? configuredDefaultModelId.trim()
          : fallbackModelId) || "";
      if (!defaultModelId) {
        return res.status(500).json({ error: `Missing model definitions for provider: ${providerId}` });
      }

      const modelIdCandidate = String(effectiveSettings.modelId || defaultModelId).trim();
      const modelId = isSupportedModel(providerId, modelIdCandidate) ? modelIdCandidate : defaultModelId;

      const providerSettings = normalizeChatSettingsWithSchema(effectiveSettings, { providerId });
      providerSettings.providerId = providerId;
      providerSettings.modelId = modelId;
      providerSettings.systemPromptPresetId = presetId;
      providerSettings.systemPrompt = preset?.systemPrompt || "";
      if (providerDefinition?.capabilities?.webSearch === false) {
        providerSettings.enableWebSearch = false;
      }
      updatedSession =
        (await chatModel.updateSessionSettings(userId, sessionId, providerSettings, presetId)) || updatedSession;

      const shouldStream = Boolean(providerSettings.stream);

      const history = await chatModel.listRecentMessagesUpTo(userId, sessionId, messageId, chatConfig.historyLimit);
      if (history === null) return res.status(404).json({ error: "Session not found" });

      const messages = buildOpenAiChatMessages({
        systemPrompt: providerSettings.systemPrompt,
        historyMessages: history.map((m) => ({ role: m.role, content: m.content })),
      });

      if (!shouldStream) {
        const { content: assistantContent } = await createChatCompletion({
          providerId,
          model: modelId,
          messages,
          settings: providerSettings,
        });

        const assistantMessage = await chatModel.createMessage(userId, sessionId, "assistant", assistantContent);
        updatedSession = await chatModel.touchSession(userId, sessionId);

        return res
          .status(200)
          .json({ session: updatedSession, user_message: updatedUserMessage, assistant_message: assistantMessage });
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      writeSse(res, { type: "start", session_id: sessionId, user_message: updatedUserMessage });

      const abortController = new AbortController();
      req.on("close", () => abortController.abort(new Error("Client disconnected")));
      const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), llmConfig.timeoutMs);

      let assistantContent = "";
      try {
        const upstreamResponse = await createChatCompletionStreamResponse({
          providerId,
          model: modelId,
          messages,
          settings: providerSettings,
          signal: abortController.signal,
        });

        for await (const delta of streamChatCompletionDeltas({ response: upstreamResponse })) {
          assistantContent += delta;
          writeSse(res, { type: "delta", delta });
        }
      } catch (streamError) {
        if (abortController.signal.aborted) {
          const message = getAbortReasonMessage(abortController.signal);
          if (message && message !== "Client disconnected") {
            writeSse(res, { type: "error", error: message });
          }
          res.end();
          return;
        }
        throw streamError;
      } finally {
        clearTimeout(timeout);
      }

      const normalizedAssistantContent = assistantContent.trim();
      if (!normalizedAssistantContent) {
        writeSse(res, { type: "error", error: "Empty model response" });
        res.end();
        return;
      }

      const assistantMessage = await chatModel.createMessage(userId, sessionId, "assistant", normalizedAssistantContent);
      updatedSession = await chatModel.touchSession(userId, sessionId);

      writeSse(res, {
        type: "done",
        session: updatedSession,
        user_message: updatedUserMessage,
        assistant_message: assistantMessage,
      });
      res.end();
    } catch (error) {
      const message = error?.message || "Internal Server Error";
      if (res.headersSent && res.getHeader("Content-Type")?.toString().includes("text/event-stream")) {
        try {
          writeSse(res, { type: "error", error: message });
          res.end();
        } catch {
          // ignore
        }
        return;
      }

      logger.error(
        "chat_message_edit_failed",
        withRequestContext(req, { error, sessionId: req.params.sessionId, messageId: req.params.messageId })
      );
      res.status(500).json({ error: message });
    }
  },

  async sendMessage(_req, res) {
    const req = _req;

    try {
      const userId = req.user?.id;
      const sessionId = parseSessionId(req.params.sessionId);
      if (!sessionId) return res.status(400).json({ error: "Invalid sessionId" });

      const content = String(req.body?.content || "").trim();
      if (!content) return res.status(400).json({ error: "Content cannot be empty" });

      const session = await chatModel.getSession(userId, sessionId);
      if (!session) return res.status(404).json({ error: "Session not found" });

      const incomingSettings = sanitizeChatSettings(req.body?.settings);
      const presetResolution = await resolvePresetForSession({ userId, session, incomingSettings, enforceMatch: true });
      if (presetResolution.error) return res.status(400).json({ error: presetResolution.error });

      const { presetId, preset } = presetResolution;
      const mergedSettings = mergeSettings(session.settings, incomingSettings);
      mergedSettings.systemPromptPresetId = presetId;
      mergedSettings.systemPrompt = preset?.systemPrompt || "";

      const defaultProviderId = chatConfig.defaultProviderId;
      const candidateProviderId = mergedSettings.providerId || defaultProviderId;
      if (!isSupportedProvider(candidateProviderId)) {
        return res.status(400).json({ error: `Unsupported provider: ${candidateProviderId}` });
      }
      const providerId = String(candidateProviderId).trim();
      const providerDefinition = getProviderDefinition(providerId);

      const configuredDefaultModelId = chatConfig.defaultModelByProvider?.[providerId];
      const fallbackModelId = listModelsForProvider(providerId)[0]?.id || "";
      const defaultModelId =
        (typeof configuredDefaultModelId === "string" && isSupportedModel(providerId, configuredDefaultModelId)
          ? configuredDefaultModelId.trim()
          : fallbackModelId) || "";
      if (!defaultModelId) {
        return res.status(500).json({ error: `Missing model definitions for provider: ${providerId}` });
      }

      const modelIdCandidate = String(mergedSettings.modelId || defaultModelId).trim();
      const modelId = isSupportedModel(providerId, modelIdCandidate) ? modelIdCandidate : defaultModelId;

      const effectiveSettings = normalizeChatSettingsWithSchema(mergedSettings, { providerId });
      effectiveSettings.providerId = providerId;
      effectiveSettings.modelId = modelId;
      effectiveSettings.systemPromptPresetId = presetId;
      effectiveSettings.systemPrompt = preset?.systemPrompt || "";
      if (providerDefinition?.capabilities?.webSearch === false) {
        effectiveSettings.enableWebSearch = false;
      }

      const shouldStream = Boolean(effectiveSettings.stream);

      let updatedSession =
        (await chatModel.updateSessionSettings(userId, sessionId, effectiveSettings, presetId)) || session;

      const userMessage = await chatModel.createMessage(userId, sessionId, "user", content);
      if (!userMessage) return res.status(404).json({ error: "Session not found" });

      const messageCount = await chatModel.countMessages(userId, sessionId);
      if (session.title === DEFAULT_SESSION_TITLE && messageCount === 1) {
        updatedSession =
          (await chatModel.updateSessionTitle(userId, sessionId, formatSessionTitleFromMessage(content))) ||
          updatedSession;
      }

      const history = await chatModel.listRecentMessages(userId, sessionId, chatConfig.historyLimit);
      if (history === null) return res.status(404).json({ error: "Session not found" });

      const messages = buildOpenAiChatMessages({
        systemPrompt: effectiveSettings.systemPrompt,
        historyMessages: history.map((m) => ({ role: m.role, content: m.content })),
      });

      if (!shouldStream) {
        const { content: assistantContent } = await createChatCompletion({
          providerId,
          model: modelId,
          messages,
          settings: effectiveSettings,
        });

        const assistantMessage = await chatModel.createMessage(userId, sessionId, "assistant", assistantContent);
        updatedSession = await chatModel.touchSession(userId, sessionId);

        return res
          .status(200)
          .json({ session: updatedSession, user_message: userMessage, assistant_message: assistantMessage });
      }

      res.status(200);
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      writeSse(res, { type: "start", session_id: sessionId, user_message: userMessage });

      const abortController = new AbortController();
      req.on("close", () => abortController.abort(new Error("Client disconnected")));
      const timeout = setTimeout(() => abortController.abort(new Error("LLM request timeout")), llmConfig.timeoutMs);

      let assistantContent = "";
      try {
        const upstreamResponse = await createChatCompletionStreamResponse({
          providerId,
          model: modelId,
          messages,
          settings: effectiveSettings,
          signal: abortController.signal,
        });

        for await (const delta of streamChatCompletionDeltas({ response: upstreamResponse })) {
          assistantContent += delta;
          writeSse(res, { type: "delta", delta });
        }
      } catch (streamError) {
        if (abortController.signal.aborted) {
          const message = getAbortReasonMessage(abortController.signal);
          if (message && message !== "Client disconnected") {
            writeSse(res, { type: "error", error: message });
          }
          res.end();
          return;
        }
        throw streamError;
      } finally {
        clearTimeout(timeout);
      }

      const normalizedAssistantContent = assistantContent.trim();
      if (!normalizedAssistantContent) {
        writeSse(res, { type: "error", error: "Empty model response" });
        res.end();
        return;
      }

      const assistantMessage = await chatModel.createMessage(
        userId,
        sessionId,
        "assistant",
        normalizedAssistantContent
      );
      updatedSession = await chatModel.touchSession(userId, sessionId);

      writeSse(res, {
        type: "done",
        session: updatedSession,
        user_message: userMessage,
        assistant_message: assistantMessage,
      });
      res.end();
    } catch (error) {
      const message = error?.message || "Internal Server Error";
      if (res.headersSent && res.getHeader("Content-Type")?.toString().includes("text/event-stream")) {
        try {
          writeSse(res, { type: "error", error: message });
          res.end();
        } catch {
          // ignore
        }
        return;
      }

      logger.error(
        "chat_message_send_failed",
        withRequestContext(req, { error, sessionId: req.params.sessionId })
      );
      res.status(500).json({ error: message });
    }
  },
};

module.exports = chatController;
