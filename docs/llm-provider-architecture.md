# Chat LLM Provider 架构规划（后端为主）

## 现状与痛点

当前聊天功能的“LLM 调用”以 **OpenAI 兼容** 的 `/chat/completions` 封装为核心，前端把一套统一的 `settings`（如 `temperature/topP/maxOutputTokens/presencePenalty/frequencyPenalty/enableWebSearch/stream`）整体发送到后端；后端再把这些参数“原样”映射到上游请求体（仅对少数 provider 做了参数屏蔽）。

这会带来几个可预见问题：

- **不同供应商接口差异**：参数名、可用范围、默认推荐值、能力（web search / tools / function calling / reasoning 等）不同。
- **冗余与错误风险**：统一 settings 很容易对某些供应商是冗余/无效甚至错误的；后续支持更多供应商会使代码越来越“到处 if/else”。
- **配置硬编码**：模型列表、默认模型/默认参数、供应商能力与参数策略散落在代码里，维护成本高。

## 总目标

1. **按供应商拆分**：把“供应商差异”集中到 `services/llm/providers/<provider>/...`，避免在业务流里散落判断。
2. **通用能力抽象**：把“通用请求流程 / OpenAI-compatible 适配 / SSE delta 解析”等放到公共模块中。
3. **后端驱动配置**：尽量让“默认值/可用参数/能力开关/模型列表”等由后端提供（或由后端配置决定），前端只做展示与选择。
4. **向前兼容**：不破坏现有 API 形状（例如 `/api/chat/meta` 的 `providers + defaults`），以便平滑迁移。

## 关键抽象（建议）

### 1) Provider Definition（供应商定义）

每个供应商一个目录，输出一个“纯数据 + 少量策略”的 definition：

- `id` / `name`
- API 访问配置（仅 env key 名、默认 baseUrl 等，不含密钥）
- `models`：模型列表（展示/校验用）
- `capabilities`：能力描述（前端用来隐藏/禁用 UI；后端用来过滤参数）
- `parameterPolicy`：参数允许/屏蔽策略（例如 grok 不支持 `presence_penalty/frequency_penalty`）
- `defaults`：推荐默认值（可由 env 覆盖；用于 meta 返回与初始化）

### 2) Adapter（协议适配层）

供应商之间可能有不同协议：

- OpenAI-compatible：`/chat/completions`（当前 grok/deepseek 都属于此类）
- Anthropic / Gemini / 自建模型 / 其他非兼容协议

建议用 `services/llm/adapters/<adapter>/...` 承载协议实现，并由 provider definition 声明自己使用哪个 adapter。

当前阶段可以仅实现 `openaiCompatible` adapter，并把：

- 请求 body 构建（temperature/top_p/max_tokens/…）
- 上游错误解析
- SSE delta 解析

集中放在 adapter 内。

### 3) Registry（注册表）

`services/llm/providers/index.js` 负责：

- 汇总所有 provider definitions
- `listSupportedProviders / listConfiguredProviders / isSupportedProvider`
- `getProviderConfig`（读取 env：API Key、Base URL）
- `listModelsForProvider / isSupportedModel`
- `getProviderDefaults / getProviderCapabilities / getParameterPolicy` 等

业务层（controller/service）只和 registry + adapter API 交互，不直接关心某个供应商的细节。

## 后端目录结构（落地版本）

```
BlogBackEnd/services/llm/
  adapters/
    openaiCompatible/              # 通用 OpenAI-compatible 协议实现（后续可迁移现有 openAiChatCompletions）
      chatCompletions.js
      sse.js
      errors.js
  providers/
    index.js                       # registry：对外导出 helper 方法
    grok/
      index.js                     # provider definition
    deepseek/
      index.js
```

> 迁移期可以保留 `services/llm/openAiChatCompletions.js` 作为兼容入口（内部转调 adapter），避免一次性改动过大。

## `/api/chat/meta` 返回策略（兼容 + 可扩展）

现有返回：

```json
{ "providers": [{ "id","name","models": [...] }], "defaults": {...} }
```

规划扩展（不破坏旧字段）：

- `providers[].capabilities`
- `providers[].defaults`（每个 provider 的推荐默认值）
- （已落地）`providers[].settingsSchema`（用于前端动态渲染/校验 slider 范围、step 等）

前端如果暂时不使用这些字段也不会受影响。

## 前端策略（分阶段）

第一阶段：仅消费现有 `providers/defaults`（不改 UI），后端先把 provider 拆分好，保证行为一致。

第二阶段：利用 `providers[].capabilities/defaults` 做 UI 优化：

- provider 切换时，根据 provider defaults 更新 `temperature/topP/...`（仅在用户未手动覆盖时）
- 对不支持的参数（如 grok 的 penalty）禁用/隐藏控件
- `enableWebSearch` 只在支持的 provider 下展示，避免“看得到但无效”

## 后续扩展点

- **Web Search**：把 `enableWebSearch` 视为内部意图，由 provider adapter 决定如何落地（不同供应商参数名/结构不同）。
- **Function/Tool Calling**：定义统一的 `tools` 表达方式与 tool 输出回写策略；在支持的 provider 上实现协议映射。
- **Per-model defaults**：在 `providers[].models[]` 上挂载推荐默认值/能力（reasoning、max tokens 等），meta 直接返回给前端。
