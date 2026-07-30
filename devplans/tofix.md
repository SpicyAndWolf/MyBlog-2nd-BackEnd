# Memory v2 待修复问题：Librarian、WorldFact 与 provenance

## 背景

2026-07-27 对服务器 `user_id=1`、`preset_id=Lina-Weil` 的 Memory v2 数据进行了只读检查。检查时该 scope 仍处于 rebuild 中，源消息边界为 `8195`，各 target 仅处理到约 `4550`，因此观察到的是重建过程中的中间状态，不是最终 Memory。

即便如此，现有数据已经暴露出结构性问题：

- `worldFacts` 收录了大量人物互动、关系规则和具体事件；
- 单个 item 不断吸收彼此独立的事件，形成超长复合条目；
- `sourceRefs` 随每次 update 不断做历史并集，逐渐失去“当前文本直接证据”的含义；
- 多个 section 存在重复、近重复、复合断言和 provenance 膨胀；
- Librarian 的周期调度在这批历史数据上没有运行。

## 线上观察

### WorldFact 异常样本

检查时最大的 `worldFacts` item：

- 当前长度：923 个 Unicode 字符；
- 当前 `sourceRefs`：112 条；
- 初始写入：66 字、4 条 `sourceRefs`；
- 此后由 `worldFactProposer` 多次以 `updateItem` 扩张；
- 历史上最长达到 1078 字；
- 内容主要由人物亲密互动、关系约定、场景事件和角色反应组成，不符合 WorldFact 的存续测试。

该 item 并非由 Librarian 或 compaction 创建，而是普通 `worldFactProposer` 对同一 target 的连续 update 造成的。

### Librarian 实际尚未运行

检查时：

- `chat_memory_tasks` 中不存在 `target_key=librarian` 的 task；
- `chat_memory_librarian_checkpoints` 中不存在该 scope 的 checkpoint；
- 5126 条源消息的 `turn_id` 和 `parent_user_message_id` 全部为空；
- `listCompleteTurnBoundaries` 因此返回 0 个完整 turn；
- 当前 rebuild 尚未完成，最终的 `runFinal` 也尚未发生。

所以当前问题不能简单归因于“Librarian 判断错误”。更准确的结论是：

1. 上游 proposer 正在持续制造错误和膨胀；
2. 周期 Librarian 在 turn-less 历史数据上没有获得执行机会；
3. 即使最终 Librarian 被调用，现有操作语义也不足以完整、准确地修复这些数据。

## 根因

### 1. 普通 proposer 缺少写入端硬约束

当前 section 只有总 item 数和总渲染字符预算，没有普遍适用的单 item 字符上限。只要 section 尚未超过总预算，单条 WorldFact 即使接近 1000 字仍可被接受。

Prompt 虽然要求 WorldFact 原子化并排除人物经历，但确定性校验层无法判断一次 `update` 是否仍在重写原 target 的同一个 canon 维度。模型可以把新事件不断追加到已有 item。

### 2. 当前 `sourceRefs` 同时承担直接证据与历史 lineage

`updateItem` 会把旧 item 的全部 `sourceRefs` 与本次 patch 的 `sourceRefs` 做并集。长期运行后：

- item 的来源数量只增不减；
- 一个短文本可能挂载数百条历史消息；
- 无法判断哪条消息直接支持当前文本中的哪个断言；
- split、merge、dedupe 会进一步传播膨胀的来源集合。

完整历史其实已经存在于 event log，不应继续复制到当前 item 的直接支持字段中。

### 3. Librarian 的操作能力不足

现有 Librarian 首期只维护：

- `standingAgreements`
- `worldFacts`
- `userProfile`
- `assistantProfile`
- `relationship`

存在以下缺口：

- 无法把误写入长期 section 的事件移动到 `recentEpisodes` 或 `milestones`；
- `splitMove` 要求至少一个 part 改变 section，不能对分类正确但包含多个独立断言的 item 做纯同 section 拆分；
- `splitMove` 会把原 item 的全部 `sourceRefs` 复制给每一个 part；
- 缺少明确的原子化重写操作；
- 缺少对“不属于任何长期 section、也不应恢复为近期事件”的错误内容进行可审计淘汰的操作；
- 只读 Memory 文本不足以让模型为拆分后的每个断言准确选择证据子集。

### 4. turn-less 历史数据使周期调度失效

Librarian 周期调度以完整对话 turn ordinal 为水位。旧数据没有 `turn_id` 和 `parent_user_message_id`，导致完整 turn 数恒为 0。

重建完成后仍会执行一次 final Librarian，但整个长 rebuild 过程中没有周期清理，错误 item 可以持续膨胀到最后才被一次性处理。

## Episode 与 Milestone 识别分离

当前 `episodeProposer` 同时维护 `recentEpisodes` 和 `milestones`，要求模型在同一个短消息窗口中既识别近期互动弧，又判断其是否改变长期关系或剧情基线。两种判断的时间尺度不同，容易把强烈情绪、普通和解、单次温馨互动或尚未稳定的事件过早升级为 milestone。

将该职责拆分为两个 proposer：

- `episodeProposer` 高频运行，只维护 `recentEpisodes`，负责从新消息中识别具有稳定结果、重要未决问题或后续连续性价值的完整互动弧；
- `milestoneProposer` 低频运行，只维护 `milestones`，负责判断近期事件是否真正改变长期关系、角色身份、信任与边界基线或主剧情状态。

### Milestone 输入范围

`milestoneProposer` 的 writable Memory 只包含全部现有 `milestones`。只读输入限定为：

- 最近 N 个完整 turn 范围内形成或发生实质更新的 `recentEpisodes`；
- `userProfile`；
- `assistantProfile`；
- `relationship`；
- `standingAgreements`。

默认不提供 `scene`、`todos` 和 `worldFacts`，避免把短期状态、任务或外部设定误判为长期转折。N 应为显式配置，并以完整 turn boundary 定义窗口，而不是简单截取最后 N 条 episode item；task 必须保存窗口起止 boundary，保证 retry、恢复和 rehearsal 使用相同输入。

Profile、relationship 和 agreements 只用于比较事件前后的长期基线，不能独立触发 milestone。每个 milestone 的 `add | update | correct | forget` 必须至少引用一个本轮授权的 `recentEpisodes` ref；没有近期 episode 承载明确转折时应保持 noop。

### 调度与一致性

`milestoneProposer` 应在相关普通 target 到达同一消息 boundary 后运行：

```text
普通消息处理
  -> episode / profileRelationship / agreement 推进
  -> 建立一致 boundary barrier
  -> milestoneProposer 读取已提交结果
  -> 提交 milestone
```

当前 `profileRelationshipProposer` 会读取 milestones，因此不能要求同一 boundary 内双向反复运行直至收敛。新 milestone 从下一处理周期起供 `profileRelationshipProposer` 使用，允许一个周期的确定性延迟，以避免依赖环、重复调用和 revision churn。

Milestone 是对 episode 长期意义的独立表达，不是把 episode 移入长期 section。原 `recentEpisodes` item 继续保留并按既有滑动窗口淘汰；milestone 只概括发生了什么长期基线变化，不复制完整事件过程，也不把多个普通 episode 合并成一个虚假转折。

### Evidence 与写入约束

模型通过近期 episode ref 选择候选证据，Compiler 只展开并校验被授权 episode 所对应、且直接支持 milestone 文本的 raw evidence 子集。不得把 episode、Profile、relationship 或 agreement 的全部历史 `sourceRefs` 无条件并入 milestone。

在 provenance 分层完成前，需要明确记录这是过渡约束，避免继续扩大来源并集；完成分层后，milestone 当前直接支持只保留其转折断言所需 evidence，完整演变历史留在 event log。

现有 milestone 不得因为没有出现在最近 N 轮事件中而被删除。只有近期 episode 明确提供新发展、纠正或否定证据时，才允许对已有 milestone 执行 `update`、`correct` 或 `forget`。

### 分离后的验收标准

- `episodeProposer` 不再产生或修改 `milestones`；
- `milestoneProposer` 不直接读取未沉淀为 episode 的原始短期事件来创建 milestone；
- 静态 Profile、relationship 或 agreement 不能单独生成 milestone；
- 每个 milestone change 至少引用一个本轮窗口内授权的 episode；
- 同一事件可同时保留近期叙事和长期意义，但两者文本粒度与生命周期明确不同；
- barrier、retry、rebuild 和恢复后使用相同的窗口边界与 Memory revision；
- `profileRelationshipProposer` 与 `milestoneProposer` 之间不存在同 boundary 的循环调度。

## 新 Librarian：三轮固定对话

将低频 Librarian 实现为持久化的三轮固定格式 agent。

### 第一轮：审计

输入：

- 不可变的 Memory revision；
- 每个 section 的准入、排除、原子性、粒度和时效标准；
- item 短引用；
- 确定性预检产生的长度、来源数量、重复候选等指标。

要求模型逐 section 说明：

- 哪些 item 分类错误；
- 哪些 item 混合多个独立断言；
- 哪些 item 是具体事件而非长期记忆；
- 哪些 item 重复或被其他 item 覆盖；
- 哪些 item 过长或 provenance 异常；
- 哪些问题无法仅根据当前 Memory 判断。

本轮不得产生持久化操作，也不绑定最终写入 JSON schema。

### 第二轮：规划与自我质疑

把第一轮审计结论作为“待复核工作笔记”而非事实重新提供给模型，要求它：

- 逐项质疑第一轮结论；
- 为确认的问题提出处理方案；
- 指明涉及的 ref、目标 section 和预期结果；
- 说明选择 move、rewrite、split、merge、dedupe 或 archive 的理由；
- 明确哪些项目应保持 noop；
- 检查计划是否丢失原文中的实质信息；
- 检查计划是否把事件、偏好、约定和世界设定再次混淆。

对于需要拆分或重新归类的 item，本轮可按需加载该 item 对应的原始消息摘录，以便建立 claim 与 evidence 的映射；不得把整个历史对话无差别放入上下文。

本轮仍不提交数据库操作，也不绑定最终写入 JSON schema。

### 第三轮：执行

输入：

- 与前两轮相同的不可变 Memory 快照和 refMap；
- 经第二轮复核后的计划；
- 允许操作的严格定义；
- 本轮可用的 evidence 短引用。

仅本轮要求输出严格 JSON。输出必须经过：

1. schema 校验；
2. ref 与 evidence 权限校验；
3. section 和操作状态机校验；
4. 容量及单 item 限制校验；
5. base revision 乐观锁校验；
6. 原子事务提交。

## 持久化状态机

三轮对话不能仅在内存中连续调用三次 provider。Librarian task 应具有可恢复阶段：

```text
created
  -> auditing
  -> audit_persisted
  -> planning
  -> plan_persisted
  -> executing
  -> semantic_result_persisted
  -> validating
  -> committed | noop | failed | stale
```

`stage_payload` 至少保存：

- `baseRevision`
- `sourceGeneration`
- `boundaryMessageId`
- `turnOrdinal`
- prompt/schema 版本；
- 第一轮审计输出；
- 第二轮计划输出；
- 第三轮 structured output；
- 每轮 model、usage、finish reason 和调用次数；
- repair 记录和失败原因。

三轮必须共享同一不可变 refMap。任一轮结束后若权威 state revision 已变化，则当前 task 标记为 `stale`，基于新 revision 从第一轮重新开始，不能继续使用旧 ref。

Provider transport 需要支持通用的多轮 message history。不能把审计和规划阶段伪装成 schema repair，也不能依赖仅存在于进程内的会话状态。

## 需要扩充的操作

### `move`

保持 item 文本与当前直接证据不变，移动到正确 section。

### `rewriteAtomic`

在同一 section 内将复合或冗长 item 重写为一个原子语义维度。必须明确当前文本的直接 evidence，历史 lineage 留在 event log。

### `split`

- 允许拆分后所有 parts 留在原 section；
- 也允许 parts 分别进入不同 section；
- 每个 part 必须分别提供 text、target section 和 evidence 子集；
- evidence 必须是源 item evidence 或本 task 显式加载证据的子集；
- 不得默认把源 item 的全部 `sourceRefs` 复制给每个 part。

### `merge`

只允许合并语义兼容且属于同一原子维度的 item。结果必须提供最小直接 evidence，不得把所有历史 lineage 无条件并入当前 item。

### `dropDuplicate`

keeper 已完整覆盖 duplicate 时删除 duplicate。历史来源关系写入 audit event；keeper 的当前直接 evidence 只保留支持 keeper 当前文本所必需的部分。

### `archiveMisclassified`

处理确认不属于任何长期 section、且已不适合重新进入近期事件窗口的内容。操作必须：

- 给出明确原因代码；
- 保留完整 audit event；
- 不允许删除存在语义不确定性或冲突的 item；
- 不得成为模型随意“清理不喜欢内容”的通道。

是否把 `recentEpisodes` 和 `milestones` 纳入 Librarian 的可写范围，需要单独设计其滑动窗口、淘汰和时间语义；在此之前可以把它们作为有限目标或使用审计式 archive。

## 写入端防线

Librarian 是低频纠偏层，不能代替普通 proposer 的正确性。需要同时增加：

### 单 item 限制

- 为每个自然语言 section 配置 `maxItemChars`；
- WorldFact 建议采用远低于 section 总预算的限制；
- 对句子数或独立断言数设置保守上限；
- 超限结果必须在 reducer 提交前被拒绝。

### update 增长保护

对 `update | correct` 检查：

- 新文本相对旧文本的长度增长；
- 独立句子或主题数量是否异常增加；
- 是否明显把多个事件序列追加到原 target；
- target 的原语义维度是否仍能被新文本完整覆盖。

机械指标只负责拦截明显异常，不应伪装成完整语义判定。被拦截的候选记录专用 reason 和指标，供 prompt eval 与运维检查。

### WorldFact 额外约束

- 具体人物在具体时间地点发生的行为默认不是 WorldFact；
- 人物偏好、人格、关系、承诺和共同经历不得进入 WorldFact；
- 一次 update 只能维护原 target 的同一个世界 canon 维度；
- 不允许通过 update 把多个相互独立的世界规则或事件串成一条；
- 对模型输出执行专门的 WorldFact post-check。

### provenance 分层

将概念区分为：

- 当前直接支持：支持 item 当前文本的最小 evidence；
- 历史 lineage：item 经 add/update/correct/merge/split 演变的完整历史。

当前直接支持留在权威 state；历史 lineage 由 event group、event 和 snapshot 保存。不得继续用无限并集的 `sourceRefs` 同时表达两种语义。

## 调度修复

需要明确支持 turn-less 历史数据，候选方案：

1. 对能够可靠配对的旧消息做一次性 turn metadata backfill；
2. rebuild 时建立独立、确定性的 legacy complete-turn boundary；
3. 当 scope 明确为 legacy source 时，以已处理消息边界或已处理批次数作为 Librarian 的后备周期水位。

不能直接根据简单的 user/assistant 交替盲目回填。必须考虑：

- session 边界；
- 缺失或重复的 assistant 回复；
- regenerate/branch；
- 删除消息；
- 非交替历史；
- idempotency 与重复执行；
- rebuild source generation。

任何数据 backfill 或带 `--apply` 的迁移都必须先 rehearsal、输出报告并单独确认，不能作为普通代码修改顺带执行。

## 上线顺序

### P0：阻止继续恶化

- 增加单 item 字符限制；
- 增加 WorldFact update 增长保护；
- 为异常 item 长度和 `sourceRefs` 数量增加指标与 inspect 输出；
- 为 legacy rebuild 的 Librarian 调度增加明确诊断。

### P1：修复调度

- 设计并测试 turn-less 历史数据策略；
- 保证长 rebuild 中可周期执行 Librarian；
- 保证 rebuild final Librarian 可恢复、可去重。

### P2：修复 provenance 与操作模型

- 分离当前直接支持和历史 lineage；
- 增加 `rewriteAtomic`、通用 `split`、有限 archive；
- 为每个 split part 支持 evidence 子集；
- 保证 event replay、snapshot、retention 和 source rebuild 一致。

### P3：实现三轮 Librarian

- 新增 durable stages；
- 扩展 provider 多轮消息；
- 三轮共享同一 revision/refMap；
- 仅第三轮绑定最终 JSON schema；
- 支持逐轮恢复、retry、stale rebase 和审计。

### P4：rehearsal 与评估

- 使用 `Lina-Weil` 的快照进行 shadow/rehearsal；
- 输出逐 section before/after diff；
- 检查分类、原子性、信息保留、evidence 映射和容量；
- 对 noop、正常 changes、错误 schema、截断、provider retry、revision churn 建立测试；
- 人工验收后才允许对生产 scope 应用。

## 验收标准

- turn-less 历史 rebuild 不再导致周期 Librarian 永久为 0 次；
- Librarian task 的三轮状态可持久化恢复；
- revision 变化后不会使用旧 ref 提交；
- 单个 WorldFact 不再吸收多个独立事件或人物互动；
- 分类错误的事件能够被移动或审计式归档；
- 同 section 的复合 item 可以拆分；
- split 后每个 part 只持有支持自身文本的 evidence；
- 当前 item 的 evidence 数量不会因历史 update 无界增长；
- event replay 可以从 snapshot 和 events 精确恢复相同权威 state；
- Librarian 的每次修改都有可解释的 audit event；
- 所有 section 的最短 noop 和正常 changes 测试均保留；
- 不修改 `modules/memory/prompts/*.md` 中受保护的 JSON 示例，除非 schema 变化确实使其失效且已获得用户明确同意。

## 当前操作边界

本文件仅记录问题与实施建议。此次检查没有：

- 修改服务器文件；
- 修改生产数据库；
- 运行 Librarian；
- 中断正在执行的 rebuild；
- 执行任何 migration 或 `--apply` 操作。
