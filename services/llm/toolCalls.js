function normalizeTools(rawTools) {
  const tools = Array.isArray(rawTools) ? rawTools : [];

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) return null;
      if (tool.type !== "function") return null;
      const fn = tool.function;
      if (!fn || typeof fn !== "object" || Array.isArray(fn)) return null;
      const name = String(fn.name || "").trim();
      if (!name) return null;

      return {
        type: "function",
        function: {
          name,
          description: typeof fn.description === "string" ? fn.description : "",
          parameters: fn.parameters && typeof fn.parameters === "object" ? fn.parameters : { type: "object", properties: {} },
        },
      };
    })
    .filter(Boolean);
}

function isToolCallingEnabled() {
  return false;
}

async function runToolCallingLoop() {
  throw new Error(
    "Tool calls are not implemented yet. Stub is at BlogBackEnd/services/llm/toolCalls.js; implement a tool execution loop before enabling."
  );
}

module.exports = {
  normalizeTools,
  isToolCallingEnabled,
  runToolCallingLoop,
};

