const chatModel = require("@models/chatModel");
const { buildOpenAiChatMessages } = require("../services/chat/context");
const {
  createChatCompletion,
  createChatCompletionStreamResponse,
  streamChatCompletionDeltas,
} = require("../services/llm/openAiChatCompletions");

function parseSessionId(rawValue) {
  const asNumber = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(asNumber) || asNumber <= 0) return null;
  return asNumber;
}

const DEFAULT_SESSION_TITLE = "新对话";

function formatSessionTitleFromMessage(messageText) {
  const normalized = String(messageText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return DEFAULT_SESSION_TITLE;
  return normalized.length > 22 ? `${normalized.slice(0, 22)}…` : normalized;
}

function clampNumber(value, { min, max }) {
  if (!Number.isFinite(value)) return null;
  return Math.min(max, Math.max(min, value));
}

function sanitizeChatSettings(rawSettings) {
  if (!rawSettings || typeof rawSettings !== "object" || Array.isArray(rawSettings)) return {};

  const sanitized = {};

  if (typeof rawSettings.providerId === "string") sanitized.providerId = rawSettings.providerId.trim();
  if (typeof rawSettings.modelId === "string") sanitized.modelId = rawSettings.modelId.trim();
  if (typeof rawSettings.systemPrompt === "string") sanitized.systemPrompt = rawSettings.systemPrompt;
  if (typeof rawSettings.systemPromptPresetId === "string")
    sanitized.systemPromptPresetId = rawSettings.systemPromptPresetId.trim();

  const temperature = clampNumber(Number(rawSettings.temperature), { min: 0, max: 2 });
  if (temperature !== null) sanitized.temperature = temperature;

  const topP = clampNumber(Number(rawSettings.topP), { min: 0, max: 1 });
  if (topP !== null) sanitized.topP = topP;

  const maxOutputTokens = clampNumber(Number(rawSettings.maxOutputTokens), { min: 1, max: 200000 });
  if (maxOutputTokens !== null) sanitized.maxOutputTokens = maxOutputTokens;

  const presencePenalty = clampNumber(Number(rawSettings.presencePenalty), { min: -2, max: 2 });
  if (presencePenalty !== null) sanitized.presencePenalty = presencePenalty;

  const frequencyPenalty = clampNumber(Number(rawSettings.frequencyPenalty), { min: -2, max: 2 });
  if (frequencyPenalty !== null) sanitized.frequencyPenalty = frequencyPenalty;

  if (typeof rawSettings.enableWebSearch === "boolean") sanitized.enableWebSearch = rawSettings.enableWebSearch;
  if (typeof rawSettings.stream === "boolean") sanitized.stream = rawSettings.stream;

  return sanitized;
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

const chatController = {
  async listSessions(req, res) {
    try {
      const userId = req.user?.id;
      const sessions = await chatModel.listSessions(userId);
      res.status(200).json({ sessions });
    } catch (error) {
      console.error("Error in chatController.listSessions:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  },

  async createSession(req, res) {
    try {
      const userId = req.user?.id;
      const { title, settings } = req.body || {};
      const session = await chatModel.createSession(userId, { title, settings });
      res.status(201).json({ session });
    } catch (error) {
      console.error("Error in chatController.createSession:", error);
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
      console.error("Error in chatController.renameSession:", error);
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
      console.error("Error in chatController.deleteSession:", error);
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
      console.error("Error in chatController.listMessages:", error);
      res.status(500).json({ error: "Internal Server Error" });
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
      const effectiveSettings = mergeSettings(session.settings, incomingSettings);

      const providerId = effectiveSettings.providerId;
      const modelId = effectiveSettings.modelId;

      const shouldStream = Boolean(effectiveSettings.stream);

      const userMessage = await chatModel.createMessage(userId, sessionId, "user", content);
      if (!userMessage) return res.status(404).json({ error: "Session not found" });

      let updatedSession = session;

      const messageCount = await chatModel.countMessages(userId, sessionId);
      if (session.title === DEFAULT_SESSION_TITLE && messageCount === 1) {
        updatedSession = await chatModel.updateSessionTitle(userId, sessionId, formatSessionTitleFromMessage(content));
      }

      updatedSession = await chatModel.updateSessionSettings(userId, sessionId, effectiveSettings);

      const history = await chatModel.listRecentMessages(userId, sessionId, 48);
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
          temperature: effectiveSettings.temperature,
          topP: effectiveSettings.topP,
          maxTokens: effectiveSettings.maxOutputTokens,
          presencePenalty: effectiveSettings.presencePenalty,
          frequencyPenalty: effectiveSettings.frequencyPenalty,
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

      const upstreamResponse = await createChatCompletionStreamResponse({
        providerId,
        model: modelId,
        messages,
        temperature: effectiveSettings.temperature,
        topP: effectiveSettings.topP,
        maxTokens: effectiveSettings.maxOutputTokens,
        presencePenalty: effectiveSettings.presencePenalty,
        frequencyPenalty: effectiveSettings.frequencyPenalty,
        signal: abortController.signal,
      });

      let assistantContent = "";
      try {
        for await (const delta of streamChatCompletionDeltas({ response: upstreamResponse })) {
          assistantContent += delta;
          writeSse(res, { type: "delta", delta });
        }
      } catch (streamError) {
        if (abortController.signal.aborted) {
          res.end();
          return;
        }
        throw streamError;
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

      console.error("Error in chatController.sendMessage:", error);
      res.status(500).json({ error: message });
    }
  },
};

module.exports = chatController;
