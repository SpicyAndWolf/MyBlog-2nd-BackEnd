# Memory Librarian Proposer 顶层设计

## 背景

当前各类 Memory proposer 分别维护自己的 section。每个 proposer 只能基于局部职责作出判断，因此即使单次写入看起来合理，长期运行后仍可能出现全局组织问题：

- 相同或高度重叠的内容分散在多个条目中；
- 条目被写入不合适的 section，例如关系描述进入 `worldFacts`；
- 不同 proposer 从各自角度重复记录同一事实；
- 条目不断累积，但缺少定期的全局整理；
- 局部压缩只能减少容量，无法纠正跨 section 的归属问题。

本方案增加一个类似“图书管理员”的全局维护型 proposer，定期检查已经形成的 Memory，并对条目进行保守的整理。

## 定位

图书管理员不负责从对话中发现新记忆，也不负责重新解释原始对话。它只处理已经存在的 Memory 条目，解决多个 proposer 独立工作后产生的全局重复和分类不一致。

整体流程为：

```text
普通 Memory proposer
  → 生成和更新各自负责的条目
  → 图书管理员定期查看全局 Memory
  → 合并重复内容并调整错误归属
  → 得到更整洁的 Memory
```

图书管理员属于维护层，而不是新的事实来源。

它是独立的全局维护任务，不挂靠某个普通 Memory target，也不借用任何普通 proposer 的 cursor。它基于单个权威 Memory revision 读取所有首期可维护 section，并以一次全局 event group 原子提交整理结果。

## 核心职责

### 1. 合并重叠内容

识别表达相同事实或同一语义维度的多个条目，将其合并为一条完整、简洁且不丢失有效信息的记忆。

合并既可以发生在同一 section 内，也可以处理散落在不同 section、但实际属于同一类别的内容。

### 2. 移动错误归属的条目

根据各 section 的职责边界，将明显放错位置的条目移动到更合适的 section。

移动以条目的核心语义为依据，不因文本中偶然出现某个实体或关键词而机械分类。

### 3. 删除重复项

当多个条目语义等价，且其中一条已经完整覆盖其他条目时，保留信息更完整、表达更清楚的一项，并删除冗余项。

### 4. 拆分并移动混合条目

当一个条目本身混合了多个可以独立成立、且应归入不同 section 的事实时，允许将其拆成多个原子条目并分别放入正确 section。

拆分只能展开原条目中已经明确存在的实质信息，不得借拆分补充因果、背景、标签或其他新事实。拆分后的所有部分必须共同覆盖原条目的全部实质信息，不能选择性遗漏。

### 5. 维持全局整洁

定期发现不同 proposer 独立写入后形成的重复、错位和不必要膨胀，使 Memory 在长期运行和 rebuild 后仍保持清晰。

## 约束原则

### 1. 不创造新事实

图书管理员只能整理输入中已经存在的信息，不得凭空新增记忆、补充对话中未确认的因果，或将推测写成事实。

### 2. 不承担事实纠正

图书管理员不重新判断 Memory 是否忠实于原始对话，也不负责修复上游总结遗漏或实体识别错误。事实的新增、发展和纠正仍由普通 proposer 处理。

### 3. 保守操作

只有在重复或归属错误足够明确时才执行整理。无法确定时返回 `noop`，避免为了追求整洁而错误合并独立事实，或让条目在不同 section 之间反复移动。

### 4. 保留来源

移动条目时继承原有 evidence；合并或删除重复项时合并来源；拆分后的每个子条目继承原条目的全部来源。LLM 不需要重新选择 message evidence，也不能为整理后的条目创造新来源。

### 5. 不推进消息处理进度

图书管理员只维护现有 Memory，不消费新的对话，也不改变普通 proposer 的消息 cursor。

用于“每 96 个完整对话 turn”调度的 durable checkpoint 只是维护调度水位，不是消息消费 cursor，也不参与普通 proposer 的 lag、rebuild 进度或 source evidence 判定。

## 操作范围

首期只处理以下自然语言 item section：

- `standingAgreements`；
- `worldFacts`；
- `userProfile`；
- `assistantProfile`；
- `relationship`。

`standingAgreements` 中的条目表示当前仍有效的长期约定。图书管理员可以整理、拆分或移动当前仍存在的约定，但不能恢复已经被 `cancel` 删除的约定，也不重新判断一项约定是否已经失效。

### 分类边界

Librarian 使用与普通 proposer 一致的 section 语义，并以条目的核心断言而不是关键词分类：

- `standingAgreements`：未来反复适用的互动规则、共享边界、操作流程或具有明确对象与行为含义的长期承诺；
- `worldFacts`：独立于某个参与者的偏好、关系或记忆，即使当前人物离开，后来者进入该世界时仍需遵守的客观世界设定；
- `userProfile`：跨场景持续影响未来回应的 User 自身属性、背景、长期偏好、能力或稳定处境；
- `assistantProfile`：跨场景持续影响未来互动的 Assistant 自身身份、人格、价值、能力或稳定行为特征；
- `relationship`：双方关系状态、称呼、互动模式、共同历史形成的关系特征，以及彼此如何理解和回应对方。

当一句话同时包含多个边界下可以独立成立的断言时使用 `splitMove`，不得只按主语或高频关键词把整条内容机械移动。关系中的可执行长期规则优先进入 `standingAgreements`；尚未形成规则的个人偏好仍属于对应 Profile；客观世界设定不得因句中提及 User 或 Assistant 就进入 Profile。

首期明确排除：

- `scene`：具有当前值、过期场景和 TTL 语义；
- `todos`：具有 actor、requester、dueAt、active/overdue 和终结状态；
- `recentEpisodes`：具有滑动窗口与确定性淘汰语义；
- `milestones`：虽然是自然语言 item，但具有事件转折和时间阶段语义，首期不纳入跨类别整理。

合法操作包括：

- `move`：保持条目含义不变，将其移动到正确的 section；
- `merge`：将明确重叠的多个条目合并；
- `dropDuplicate`：保留一个 keeper，删除已经被它完整覆盖的重复项；
- `splitMove`：将一个混合条目拆成至少两个原子部分，并分别放入首期允许的 section。

操作契约：

- `move` 保留原 item ID、text、sourceRefs、createdAtMessageId 与 updatedAtMessageId，只改变所在 section。Item ID 是不透明身份，不因历史前缀与新 section 名称不同而重新分配。
- `merge` 可以发生在同一 section 或不同 section。输出必须指定唯一目标 section 和完整合并文本；Reducer 生成新 item ID，合并所有 sourceRefs，createdAtMessageId 取所有来源条目的最早创建来源，updatedAtMessageId 取合并后 sourceRefs 的最大 messageId。
- `dropDuplicate` 必须显式指定 keeper 和被覆盖条目。Keeper 的 ID、text 与 createdAtMessageId 保持不变，sourceRefs 与所有被删除重复项取并集，updatedAtMessageId 按合并后 sourceRefs 的最大 messageId 重新计算；不得把 Librarian 运行时间写入来源时间字段。
- `splitMove` 必须引用唯一原条目，并输出至少两个 `{ toSection, text }` 部分，其中至少一部分改变 section。原条目被删除，每个部分生成新 item ID，并继承原条目的完整 sourceRefs、createdAtMessageId 与 updatedAtMessageId。
- 一个 item 在一轮中只能参加一个顶层操作；作为 merge/dropDuplicate 来源或 splitMove 原条目的 item，不能同时被 move 或其他操作再次引用。
- 所有来源 section、目标 section 和拆分部分都必须位于首期白名单。

图书管理员不提供自由的 `add`。`splitMove` 产生的新 item 必须能逐项追溯到唯一原条目，不属于自由新增；除此之外，不允许脱离现有条目进行大范围重写。

## Semantic 输出

图书管理员只接收带短引用的全局 Memory 文本，不接收 raw messages，也看不到真实 item ID、contentHash 或持久化字段。所有首期 section 都属于 writable namespace。

建议的语义动作形态：

```json
{ "action": "move", "ref": "W1", "toSection": "userProfile" }
```

```json
{
  "action": "merge",
  "refs": ["W1", "UP1"],
  "toSection": "userProfile",
  "text": "用户正在学习 RAG 与滚动记忆技术，以构建具有连贯记忆与成长轨迹的虚拟人格。"
}
```

```json
{ "action": "dropDuplicate", "keeperRef": "R1", "duplicateRefs": ["W2", "UP2"] }
```

```json
{
  "action": "splitMove",
  "ref": "UP3",
  "parts": [
    { "toSection": "userProfile", "text": "用户现实生活中是男性。" },
    { "toSection": "relationship", "text": "用户在与莉娜的设定中扮演女性角色。" }
  ]
}
```

没有足够明确且安全的整理动作时返回 `noop`。输出数组不设置人为操作数量上限，但仍受 Provider 最大输出 token、严格 JSON Schema 和整轮原子校验约束；截断或 schema 不完整的输出不能部分执行。

## 运行方式

图书管理员周期性运行，不在每次 Memory 更新后立即执行。触发方式固定为：

1. 同一 `userId/presetId/sourceGeneration` 每新增 96 个完整 User→Assistant 对话 turn，触发一次；
2. rebuild 按相同的每 96 turn 边界同步触发，并在 rebuild 最终 boundary 再运行一次；若最终 boundary 恰好已经完成一次 Librarian，则去重，不重复调用；
3. 通过专用 CLI 手动触发，预期入口为 `npm run librarian:memory-v2 -- --userId <id> --presetId <id>`。

“完整 turn”以现有 Chat turn 契约为准：User message 与唯一 Assistant message 通过同一 `turn_id` 和 `parent_user_message_id` 形成完整配对。只有 User message、Assistant 尚未成功落库的未完成 turn 不计数。缺少现行 turn metadata 的历史消息不参与周期计数，但仍会在 rebuild 最终 boundary 的 Librarian 运行中被整理。

每个 scope/sourceGeneration 持久化独立的 Librarian 调度 checkpoint，至少记录已完成的 turn ordinal 与对应 boundaryMessageId。Source generation 变化后重新建立本 generation 的调度水位，旧 generation checkpoint 不得抑制 rebuild 中的周期运行。

### Boundary barrier

Librarian 不能在参与 section 的普通 proposer 处于不同历史进度时运行。到达一个周期或 rebuild final boundary 后，必须先让以下普通 target 全部追平该 boundary：

- `standingAgreements`；
- `worldFacts`；
- `profileRelationship`。

随后在同一 scope 串行 lane 中同步等待 Librarian 得到终局，再继续该 boundary 之后的 Memory 推进。这里的“同步”约束 Memory 后台流水线的顺序，不要求阻塞主聊天 HTTP 响应。

手动 CLI 默认以执行时捕获的最新有效 source boundary 为目标，也必须先满足相同 barrier。CLI 不直接修改普通 target cursor；需要追平时复用正常 force-drain 流程。

## 与现有 Compaction / Hygiene 的关系

当前系统有两种共享 `compactionProposer` 的单 section 维护行为：

1. 主动 high-watermark hygiene：普通 task 提交后，section 达到容量水位且相对上次又增长一定 item 数时，尝试在单个 section 内合并重复项；
2. 容量超限应急 compaction：普通 proposal 因 section 容量超限而 deferred 时，先压缩该 section，再 replay 原 proposal。

Librarian 上线后：

- 删除或禁用主动 high-watermark hygiene，避免与 Librarian 重复调用、重复整理；
- 保留容量超限应急 compaction。Librarian 每 96 turn 才运行一次，不能替代写入路径上的容量安全阀；
- 应急 compaction 仍只允许单 section merge，不获得 move、dropDuplicate 或 splitMove 权限；
- Librarian 不作为 capacity-blocked normal task 的 child，也不负责 replay 被阻塞的普通 proposal。

Librarian 的失败不能 halt 或降级任何普通 target。正常推进时保留 durable task 供恢复或在下一次触发时重判；rebuild 中的同步 Librarian 若未得到成功或 noop 终局，则 rebuild 不得宣告完成。

## 一致性要求

图书管理员应基于同一个 Memory revision 查看全局条目，并将一次整理作为完整的维护操作提交。

执行过程中需要保证：

- 被引用的条目在提交时仍然存在；
- 同一个条目不会在一轮中参与互相冲突的操作；
- `move`、`merge`、`dropDuplicate` 和 `splitMove` 作为整轮 proposal 全成全败，不允许部分接受或部分拒绝；
- 整理后的状态仍满足 section 容量和 Memory schema；
- 任一 ref 失效、操作冲突、目标 section 超容量、来源或 schema invariant 不满足时，整轮不写 revision、event 或 snapshot；
- revision 已变化时放弃旧提案，基于最新 revision 重新 render 并重新判断，绝不把旧短引用或旧 proposal 套用到新 state；
- 所有变更保留可追踪的维护事件。

## 全局 Task 与持久化

新增独立的 `librarianProposer` 和全局 maintenance task：

- `task_type=maintenance`；
- `target_key=librarian` 只作为 task、ops log 与 event group 的维护身份，不加入普通 `TARGETS`、target status 或 target cursor；
- 没有 parent normal task，也没有 `cursorBefore/targetMessageId` 消费语义；
- task 固化 `sourceGeneration`、`baseRevision`、触发类型、turn checkpoint/boundary、全局 Renderer artifact 与私有 ref map；
- event group 使用维护语义，允许在同一 group 中记录首期白名单内多个 section 的全局操作；
- normalized operation 必须完整保存来源 section、目标 section、source item IDs、keeper/result item ID 和整理后的权威 item，使 event replay 可以确定性重建；
- 一次成功 changes 提交一个新 revision、完整 snapshot 与全局维护 event group；`noop` 保存可审计 task 终局和调度 checkpoint，但不要求制造空 state revision；
- Provider、schema、编译或事务失败不改变普通 target status/cursor，也不推进成功 checkpoint。

全局 Librarian 需要专用 Compiler 与 Reducer 边界。不能把它伪装成现有单 section `compactionProposer`，也不能把跨 section proposal 拆成多个独立 revision，否则无法满足整轮原子性。

## 质量目标

方案实施后重点观察：

- 跨 section 错放条目的数量是否下降；
- 相同或近似 Memory 的重复率是否下降；
- 合并后是否保留原有有效信息；
- 是否出现错误合并、错误移动或条目来回移动；
- 图书管理员多次运行后能否稳定收敛到 `noop`；
- 使用低成本模型时，整理收益是否稳定高于误操作风险和调用成本。

## 非目标

本方案不追求：

- 替代普通 Memory proposer；
- 从原始消息重新生成 Memory；
- 恢复上游已经遗漏的信息；
- 构建新的实体系统或知识图谱；
- 对所有事实进行真实性审核；
- 通过自由改写统一所有条目的文风。

图书管理员的价值在于以较低改造成本缓解现有 Memory 的重复和错位问题。更上游的 Draft 方案作为独立方向暂时保留在 [deferred/memory-control-v2.1/draft.md](deferred/memory-control-v2.1/draft.md)。
