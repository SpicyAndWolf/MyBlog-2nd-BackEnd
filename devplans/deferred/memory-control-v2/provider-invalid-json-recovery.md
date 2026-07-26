# Provider 非法 JSON 的恢复与诊断（延后）

## 问题

OpenAI-compatible Provider 可能在 HTTP 请求成功后返回无法直接 `JSON.parse` 的 `message.content`。当前 transport 将其标记为 `content_invalid_json`，随后按 schema-invalid 路径立即暴露；本轮不把它归类为临时 transport failure，也不隐藏或自动吞掉错误。

## 当前策略

- 保持 `content_invalid_json` 的现有分类和可见失败行为；
- 保持一次持久化 schema repair，不增加重试次数；
- 不保存原始响应正文，避免对话和 Memory 内容进入错误表或日志；
- 先通过扁平 provider-facing Schema 提高首次输出和 repair 的成功率。

## 延后方案

### 1. 有边界的 JSON 恢复

仅对能够唯一确定、不会猜测字段语义的格式瑕疵尝试一次本地恢复，例如：

- 完整 JSON 对象外只有 Markdown code fence；
- 完整 JSON 对象前后只有空白或固定说明文字，且全文只存在一个平衡对象；
- Provider 已知的单个多余尾随闭合符。

不得补造缺失字段、猜测引号/逗号、合并多个候选对象或截断未闭合内容。恢复后仍必须依次通过 provider-facing Schema 和内部 SemanticResult 校验，否则保持原错误。

### 2. 重新评估错误分类

收集真实样本后，再决定 `content_invalid_json` 是否应成为可退避重试的临时 transport failure。需要与以下情况区分：

- 模型稳定地产生错误结构；
- Provider 截断；
- 安全策略拒绝；
- 网关返回非 JSON 错误页；
- HTTP 成功但响应字段布局变化。

### 3. 持久化脱敏诊断

只保存有限、无正文的诊断元数据：

- `finishReason`：Provider 返回的结束原因，限制长度并做允许字符过滤；
- `transportError`：内部固定枚举，例如 `content_invalid_json`、`content_missing`；
- `responseShape`：仅记录类型、顶层字段名白名单、字段是否存在、字符串/数组长度区间，不记录任何字段值或原始正文。

这些字段用于判断失败发生在截断、协议兼容、JSON 解析还是语义校验阶段，不能包含消息内容、Memory 文本、模型原始输出或凭据。

## 重新评估条件

- 扁平 Schema 上线后仍持续出现 `content_invalid_json`；
- 已积累足够的脱敏失败样本，可以证明存在稳定且安全的恢复模式；
- 能为“可恢复”和“必须即时失败”建立确定性测试夹具；
- 重试分类不会掩盖安全拒绝、截断或 Provider 协议变更。

