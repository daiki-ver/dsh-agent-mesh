# Mesh Bundle — Router + Worker + 自组织临时群协作架构设计

> 状态：设计蓝图（**v2，2026-11-15 评审修订**）。架构图见 `.archify/architecture-mesh-bundle-20261114-115542/mesh-bundle-architecture.html`。
> 定位：把 DeepSeek superagent 原型的 Router+Worker 调度架构，与 DSH bot 的多 bot 群聊/私聊模式杂交，做成一个可安装的 DSH bundle。
> 参考来源（均已克隆在本工作区）：`dsh-superagent-prototype/`（superagent 原型）、`DeepSeekBot/`（Tobs，bot 模式）、`deepseek-harness/`（DSH 本体）。
> **v2 修订说明**：13 项代码级核验问题已修复，登记与证据见 `mesh-bundle-review.md`（R1–R13）。最重要的一条：v1 声称"Worker 是独立进程"**是错的**——见 §2 与详设 §15，裁决 1 的理由已改写。

## 1. 背景与目标

用户需求（原始三条）：

1. **路由更智能**：任务应路由到类型化的专用 Worker（preset + 模型 + 工具白名单），而不是一个通用 bot 什么都干。
2. **通信有纪律**：Worker 之间需要协作通信，但通信必须经 Router 分发——Router 是审计咽喉、预算闸门、缓存层。
3. **省 token 的协作**：多 bot 群聊模式全员在线烧 token；Worker 应能通过能力目录自发现协作方，按需拉起临时小群（Coalition），不必项目开局就手动拉一堆 bot。

命名约定：**Router = 调度面，Worker = 数据面，Coalition = 临时控制面**。

## 2. 总体形态

与 superagent 同型：**DSH bundle + 专用 profile**。

```
专用 profile（mesh）
└── 主会话 = Router（装 mesh bundle）
    ├── Engine 域核心：纯 TS Cordis 插件（不占 Router 模型上下文）
    ├── MessageBus 插件：SQLite message 表 + pass loop
    ├── Directory 插件：能力目录
    └── Worker 池 = 独立 DSH session（session-controller API 拉起）
        ├── 常驻 Worker：researcher / coder / reviewer / ops
        └── 临时 Worker：按需拉起，用完即焚
```

关键决定与理由：

- **主会话 = Router，只装 mesh bundle**：Router 上下文必须轻。superagent 的 Router **有** Bash（`[SA] cordis.patch.yml:148-174`，只是前台命令 5 秒转后台）——Mesh 去掉 shell 是**主动偏离**，不是继承（R10）。偏离理由：Router 每票都要调用，工具面成本是乘数；路由所需状态全在 `mesh_read` 资源里；调度面一旦能干活，迟早会干在里面。
- **Engine 域核心是纯 Cordis 插件**：状态机、派发、预算判断全是程序逻辑，不进任何 LLM 上下文。
- **Worker = 独立 DSH session**：上下文隔离，用 session-controller API 拉起；内部可以再嵌 DSH 原生 subagent（两层并发不冲突——superagent 的 worker 内也允许 subagent）。**注意：session 是同进程内存对象，不是独立进程**（R3；`[DSH] api-catalog.ts:3384-3447` `ctx.sessions.get()` 返回同进程 live Session，`[SA] app/sessions.ts:116-121` 自己就是同进程订阅）。这直接影响裁决 1 的理由——见 §4。
- **生命周期管理留在 DSH 内**（schedule 插件 + session API）。superagent 用外部 tmux + Python 脚本管生命周期，仅限 Unix（fcntl/ps/tmux），Windows 不可用——这是我们要避的坑。其 Watchdog（日常 profile 里的每小时定时任务）反而跨平台，可以借鉴。

## 3. 调度：类型化 Worker + 双通道派发

### 3.1 Worker 模板（preset + 模型 + 工具白名单）

| 类型 | 工具 | 模型 | 生命周期 |
| --- | --- | --- | --- |
| researcher | 只读 + web | 强模型 | 常驻（默认上） |
| coder | 读写 + subagent | 强模型 | 常驻（默认上） |
| reviewer | 只读 | 轻→强（初审轻，分歧升级强） | 按需拉起（v2，R5） |
| ops | 中等 | 中 | 按需拉起（v2，R5） |
| temp | 按票指定 | 按票指定 | 用完即焚 |

> **v2 改动（R5）**：v1 标了 4 个常驻，但槽位默认只有 3——**第一个 launch 就排不上**。现改为默认 2 个常驻（researcher + coder），reviewer/ops 按需。每个常驻都持续付三份成本（session 存活、缓存预热、Watchdog 巡检），reviewer/ops 的调用频次在设计里没有数据支撑。加常驻前先看 §6 的 usage 表。

### 3.2 双通道（抄 superagent 的命根子）

- **订阅直通（快速通道）**：已知 Topic/Thread 的消息由程序规则直接投给订阅的 Worker，0 推理。superagent 实测：去掉直通后 Router 决策 +30%、读 token 2323万→3177万——直通是省 token 的关键。
- **慢速通道**：新任务才进 Router（轻模型），输出**结构化 dispatch 工件**（JSON）：目标 / 边界 / 预算 / 验收标准。这个工件就是 Ticket 的 spec。

### 3.3 常驻 Worker 的上下文卫生

常驻 = 上下文当缓存，缓存会腐化——常驻 researcher 几周后满脑陈旧状态。三道卫生纪律：

1. **每票再定向**：常驻 worker 接新票时，Engine 在投递的首条消息注入 re-orientation note（当前日期、repo/branch 现状、本票边界）——成本固定在每票几十 token，把陈旧信念冲掉；
2. **压缩是原生的**：worker 是 DSH session，自带 billion-context 压缩——历史折叠不需要 Mesh 自己实现；
3. **Watchdog 只管异常**：定时任务（DSH schedule 插件）检查 worker 是否有进展、是否长期空转；不负责刷新上下文（刷新由每票再定向完成，避免无谓的整段重扫）。

> **v2 修正（R6）：这三条不能都算"缓存收益"，必须分开。** v1 把"常驻=缓存"和"压缩是原生的"并列，但两者互斥——DSH 压缩会**重写 surface**，即改变 prompt 前缀，而前缀缓存的前提恰恰是前缀不变。压缩一发生，下次请求就是全量 cache miss。
>
> 准确表述：**常驻 = 避免冷启动重扫**（保留 repo 认知、工具习惯、失败教训），**不承诺 token 缓存命中**。缓存命中是"再定向 note 是 append"这个设计的副产品（append 不改前缀），不是常驻本身的性质。压缩后下一个 turn 额外附一份精简 note 重新定向，但不做"补偿性全量重读"。详见详设 §3.4。

## 4. 通信：走 Router，程序转发，LLM 只管例外

**传输接缝（裁决 1）**：Worker 是独立 DSH session（**同进程内存对象，不是独立进程**，R3），两个方向都经 Engine：出站 Engine 调 `sessions.prompt(workerSessionId, …)` 投递；入站 Engine 订阅 Cordis context 的 `session/event` / `agent/status` / `agent/error` 事件流。这不是发明，是照抄 superagent `DshExecutor` 的已验证路径（`executor/dsh.ts:203-205` 事件监听、`dsh.ts:342` prompt 投递、`dsh.ts:313-316` worker session 被外部删除时自动重建）。**bus 的唯一写者是 Engine**，Worker 的全部输入输出过 Engine 中转。

> **裁决 1 的理由（v2 改写 —— R3）**：v1 写的"Worker 不能直写 SQLite（跨进程）"**不成立**——同一进程、同一个 `DatabaseSync` 句柄，技术上完全可以直接写。唯一写者是**架构选择**，买的是三样东西：① **审计完整**（每条状态变更 = 一个事务 = 一个 audit 行，worker 直写就有洞）；② **崩溃一致**（状态变更与 effect 意图同事务提交，worker 直写做不到）；③ **预算可卡**（token 消耗在派发前就能被拦，绕过 Engine 就绕过预算）。
>
> 代价也要诚实记：一次内存调用变成"写库 + 2s 内被 pass 捡起"。缓解靠"receive 即踢"（详设 §4.4 延迟预算），不靠换通信机制。**选择唯一写者，就别绕过它；但不要说它是"做不到"。**

- **MessageBus**：SQLite `message` 表 + pass loop（每 2s 一轮，superagent 的 Effects/Passes 模式）。
- **转发是纯程序动作**：订阅匹配、投递、TTL 归档都不过 LLM。token 消耗与消息量解耦。
- **escalate 两级（裁决 3，防能力倒挂）**：
  - **程序冲突**（死锁、预算超限、TTL 到期、循环依赖）→ Router 轻模型裁决 + 程序执行；
  - **实质冲突**（两个强模型 worker 的技术分歧）→ 转 **reviewer**（强模型只读）裁决，Router 只负责执行其结论——裁决者永远不弱于被裁决者。
  - **v2 补充（R9）**：实质冲突的裁决者必须**未参与本票**。若本票唯一 reviewer 已被 gate 占用或是争议方，不自动升级，改由人裁决（`mesh_gate_escalate_decide`）。宁可慢一步，不要"自己审自己"的假裁决。
- **消息语义**：
  - `tell`：单向投递；
  - `ask`：问答，带截止时间；
  - `publish`：Topic 广播，订阅者各取所需；
  - `escalate`：上抛 Router 裁决。

## 5. 自组织：能力目录 + 临时群

### 5.1 Directory 能力目录（offers 静态，needs 运行时）

**裁决 4（用户定）**：`offers` 与 `needs` 拆开，不同来源——

- **offers 静态声明**：每个 worker 的能力来自 preset 模板（人写，进 `cordis.patch.yml`），零漂移零 token。Directory 就是一张组织架构图/专家名录：公司里有哪些同事、各自负责什么，开工即注册，永不漂移。
- **needs 运行时发起**：不写死任何 worker 的 needs。worker 干活过程中自己发现"这需要更专业的同事"，发起求助消息；Engine 拿 needs 文本去匹配静态 offers。

匹配**两级 + 显式降级**（v2 改，R12）：关键词点将（0 推理）→ Router 轻模型兜底（少 token）→ 都空手则 `deferred` 挂进 thread pending，不阻塞当前 worker。方向统一为 **needs 文本 → 静态 offers**。

> **v2 删掉了 v1 的中间级（预计算语义标签）**：它需要离线算 embedding，是**额外设施**而非零成本；needs 每次求助也要 embedding（这就不便宜了）；且向量阈值是没数据的玄学。4–5 个 worker 的规模下，关键词 + Router 兜底完全够用。**规模到 20+ worker 再考虑加回。**
>
> **成本归属要说清（v1 藏了这点）**：不是"0 token 自发现"，而是"**匹配本身 0 token**"。`@kind:` 语法要写进每个 worker 的 system prompt（**预付成本，常驻**），worker 决定要不要求助、点谁（**一次 LLM 判断**）。路由成本被摊进每个 worker 的 prompt，换来的是不用维护中心化路由表。划算，但不免费。

### 5.2 咨询协议（consultation）

比照公司里干活的两种求助：

- **advisory（问完就走）**：`ask` 语义，带截止时间；答案到了合并进上下文，等不到按 escalate 或降级处理。
- **mandatory gate（过闸才能动）**：worker 发起 `ask` 标记 `gate: true`，该票当前阶段**挂起**，直到目标 worker 批准（`approve`）或否决（`reject` 附替代方案）。典型场景：
  - coder 做交付页面前**必须**先过 UX 的设计闸——拿到设计才开工；
  - coder 发现原实现方案有问题**不能偷偷改**，必须过 SE 的方案分析闸——SE 批准了才能改，否决则按 SE 的替代方案走。
- gate 超时 = escalate（Router 裁决放行还是改道）；gate 的批准/否决记录进 bus 审计表——"谁同意了什么"全程可追溯。
- 哪些环节必设 gate，写进 dispatch 工件的验收标准（Router 建票时决定）；worker 不可自行删除 gate。
- **v2 死锁三规则（R9）**：① **持有者不可被挂起**——若目标 worker 自己正有 open gate，拒绝开新闸，直接 escalate；② **升级目标不得参与本票**——超时升级的裁决者不能是本票已出现过的 gate 持有者；③ **环检测**——`sweep('gates')` 对 open gate 的 `blocksGateId` 图做 DFS，发现环则全部 escalate；`depth > 3` 直接 escalate。**同票同时至多 1 个 open gate**（并行的闸是互锁温床，且"两个同模型签字"不比一个更可信）。
- **gate 的真实价值要说对**：它不是让两个模型互相校验（那没用），而是把"改方案"和"交付"变成**显式的、有审计的、不能偷偷做的**。价值来自"留痕 + 强制停顿"，不来自"更强的判断"。

### 5.3 Coalition 临时小群

这是与 Tobs 全员群的本质区别，也是省 token 的核心机制。

- **建群授权分两型（Mandate，详见 §8.1）**：
  - **explicit**：用户明确要求的群——全额预算、标准 TTL；
  - **inferred**：worker needs 触发、Router 推断建的群——**默认通知不阻塞**：自动建群并立即通知用户（谁、为什么、预算多少），用户随时可 stop；提供开关 `coalitions.inferredBlocking`（默认 `false`）切换为先问再建（**裁决 6，用户定**）。inferred 群预算减半、TTL 更短。
- **拉起条件**：一个 `needs` 涉及 ≥2 个协作方，经 Router 批准建群。
- **解散条件**：任务完成 / deadline / 群预算耗尽，先到者。
- **群内纪律**（省 token 的三道闸）：
  1. **结构化轮转，不自由聊天**（**裁决 2**）：moderator 是纯程序，只做两件事——执行 dispatch 工件里预写的**轮转剧本**（建群时 Router 一次性生成：谁先说、答什么、几轮），和处理剧本外情况（超时、缺答、越界）→ escalate。把"谁该发言"的判断一次性压回 Router，轮转中零推理，不给 LLM 渗透留缝；
  2. **merged summary，不广播全 history**：发言者按 schema 交结构化产出（结论/依据/引用），moderator 程序合并字段成群消息——**不做独立的 LLM 摘要轮**；明细写进各 Worker 自己的 spill（superagent 的 Inline & Spill）；
  3. **publish 消息默认 3 轮 TTL**，到期降级归档；Worker 可自由 unsubscribe。

> **v2 修正（R13）：剧本改为可选，并承认它的适用边界。** 裁决 2 的前提是"Router 建票时能预测协作形状"。但需要多 agent 辩论的场景，恰恰是形状不可预测的；而形状可预测的任务，一个强模型 worker 自己做完更快。**于是这个机制只在"你不需要它的时候"有效。**
>
> 处置：**不删机制，降级为可选**。`coalition_script` 允许为空（默认）——为空时走**形态 B：单轮收集 + 程序合并**（所有成员答同一个问题，无轮转无顺序依赖）。形态 B 之所以也能"轮转中零推理"，是因为它**根本不需要轮转**。这比"预写剧本"更诚实：承认形状不可预测时，就不要假装能预测。
>
> 非空剧本只用于"步骤与角色在开工前就确定"的多步核验（调研→方案→裁决）。Router 只有在**有明确依据**时才写剧本——写剧本本身是一次推测，推测错了比不写更贵。详见详设 §8.4。

## 6. Token 经济（三对冲）

| 手段 | 机制 | superagent 实测依据 |
| --- | --- | --- |
| 分层可见性 | 群里只发摘要，明细进个人 spill | 读缓存 token 2323万 vs 605万——拿 token 换时间，但必须是缓存命中 |
| 预算账户 | 每 Coalition 一个：80% 开始合并降级，100% 强制散群出摘要 | 把"烧钱"变成显式、可观测的状态 |
| 常驻 vs 即焚 | 高频专家常驻（上下文复用=缓存），低频临时工用完即焚 | 多任务 p95 29.5min → 15.7min |

**预算可测性与摘要成本（裁决 5，已核实）**：预算不是纸面纪律，DSH 本体自带计量设施——每个 session 事件自带 `usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, …}`（`deepseek-harness/packages/extensions/tool-cordis/src/api-catalog.ts:10094` 的 `TokenUsage` 接口，挂在 `assistant/message` 事件的 `usage?` 字段），且 Cordis context 暴露 `ctx.tokenMeter.measure(session)` → `{totalTokens, surfaceTokens, nodes}`（`deepseek-harness/packages/llm/token-meter/README.md:36-39`；ACP 包已在用：`packages/acp/acp/src/updates.ts:99`）。superagent 是**主动丢弃** usage（`src/app/context.ts:28` "omitting … usage accounting"）——没人测，不是测不到。Mesh 的 Engine 订阅 worker 的 session 事件、聚合 usage 写入预算列，每轮 pass 核账；摘要侧不做独立 LLM 摘要轮（见 §5.3 纪律 2），token 只花在发言本身。

> **v2 两条必须照做的补充（R8）**：
> 1. **口径不能混**：`tokenMeter.measure()` 给的是**当前 surface 的估算压力**，不是累计消耗。预算要用**累计**（从 `assistant/message.usage` 求和）。混用会让预算判断完全失真。
> 2. **写入不能在事件回调里做**：`node:sqlite` 的 `DatabaseSync` 是同步阻塞的，`synchronous=FULL` 每次提交都 fsync。若在 `session/event` 回调直接 upsert，等于每收到一条 assistant 消息就在主线程 fsync 一次——4+ worker 共用一条事件循环会被拖死。正确做法：**事件回调只做内存累加（零 IO），每轮 pass 一个事务批量 flush**。最坏丢一轮（≤2s）的计量，可接受——预算是软闸不是账本。详见详设 §9.1。

## 7. 数据模型

> **⚠ v2 修正（R11）：本节 v1 的关系型 DDL 已废弃。** v1 写的是 `workers(id, kind, session_id, status, offers[], budget)` / `tickets(id, thread_id, spec_json, worker_id, state)` 这类**列式**结构，与详设 §3.2 的 **JSON 列式**（`ticket(id, value TEXT)`）不兼容。两套并存会让实现者按错的那份建表。
>
> **权威定义 = `mesh-bundle-detailed-design.md` §3.2（全库 DDL）+ §3.3（域对象 zod schema）。** 本节只保留概念清单，不再给 DDL。

**表集合（概念层）**：

| 表 | 存什么 | 为什么这么存 |
| --- | --- | --- |
| `kv` | schema 版本 / settings 快照 / revision 计数 | 通用键值 |
| `effect` | 持久副作用队列（唯一有独立列的表：kind/key/seq/generation/attempts/due） | 崩溃续跑的根基；需要按 due 排序扫描，故不用 JSON |
| `thread` | 话题线程：pending / evaluating / subscriptions / correlated | 聚合读 |
| `ticket` | 工单：spec（dispatch 工件）/ assignments / inputs / undelivered / origin / ended / gates | 聚合读（嵌套结构，拆表要 5 张 + join） |
| `message` | bus 消息（tell/ask/publish/escalate/report/needs/gate） | 按 id 读 + 按 state 扫 |
| `worker` | worker 注册（offers 静态声明） | 聚合读 |
| `coalition` | 临时群：成员/剧本/预算/状态 | 聚合读 |
| `gate` | 咨询闸（含 v2 的 depth / blocksGateId / escalationTarget） | 聚合读 + 环检测扫 |
| `audit` | 追加式审计，**只 INSERT** | 追溯载体；有独立列（seq/at/actor/kind）便于按时间/角色查 |
| `usage` | token 计量聚合（scope/scope_id/session_id 主键） | 唯一的扁平聚合表，本来就是列式 |

**为什么 JSON 列而不是关系型**：Mesh 的读路径几乎都是"按 id 取整个聚合"（取一张票要看 spec + assignments + inputs + gates），关系型要拆表 + 手写 join；唯一的聚合查询是 usage 汇总，它本来扁平。需要索引的域字段用**生成列 + 部分索引**（`ON t(col) WHERE col IS NOT NULL`，照抄 `[SA] store.ts:103-118` 的 reconcile 模式）——`ticket.open` / `ticket.active` / `message.pending` / `gate.open` 等。

**Token 经济的两个物理载体**：`ticket.value.spec`（dispatch 工件，含剧本与 gate 清单）与 `message.value.summary`（合并摘要）。这两列是省 token 的落点，不是附属字段。

## 8. Ticket 生命周期（照抄 superagent 语义，含源码结论）

superagent 的 Worker 按**票**组织（`worker-<ticketId>`），票的结束/复活语义非常精巧，Mesh 直接采用：

- **四种结局** `ended = {at, by, outcome}`（`src/core/model.ts:272`）：
  - Worker 交 `ready` 报告 → `completed`；
  - 交 `dropped`（无事可做 / 超出 Mandate 范围）→ `dropped`；
  - 关注的 PR merge / 未合并关闭 → `merged` / `closed`（`github-pull.ts:83`）；
  - 人叫停 → `stopped`（唯一不可复活的一种，`model.ts:85`）。
- **两个例外**：报 `ready` 但绑定了自己开的 PR 时先停 `person/review` 等人审，PR 全关才真正结束（`followsDone`，`tickets.ts:92-95`）；PR 关闭后若 Worker 又接了人消息处理中，票继续活着（`unfinished`，`tickets.ts:365-370`）。
- **"用完即焚"焚的是票，不是 session**：结束时拒收新输入（`ticketEnded`）、杀 shell 后台任务和全部 subagent、清空未投递消息（`tickets.ts:339-361`、`dsh.ts:354-367`），但 **worker session 闲置保留**——worker 是 "persistent per-ticket DSH worker sessions"（`dsh.ts:202`）。
- **复活**：只有人的消息能复活已结束的票——同一 session、删 `ended`、注入 RESUMED 提示，**完整历史上下文都在**，且明示"不要重复已完成的工作"（`tickets.ts:254-262`、`dsh.ts:132-135`）。并发槽满时人的追问还有一个额外优先槽，永远不用排在新任务后面（`dsh.ts:169-170`）。
- **上下文按票隔离、按票全量保留**：同票续问全带（稳定前缀命中缓存，续问便宜）；新票新 session 全新上下文。超长输入截断为预览 + 资源路径按需读（Inline & Spill，`dsh.ts:112-116`：assignment 1500 字符 / trigger 600 字符）。

对 Mesh 的映射：Temp Worker = 原教旨 superagent Worker（按票即焚）；常驻 Worker（researcher/coder）= 无 IM 入口的 bot-lite——复用上下文当缓存，但不与人对聊。

### 8.1 Mandate 强度（explicit / inferred）

superagent 最强的安全概念搬进 Mesh，作用在**建群**上：

- **explicit**：用户明确要求的工作/群——全额预算、标准 TTL、全工具白名单；
- **inferred**：由规则或 worker needs 推断出的工作/群——预算减半、TTL 减半、工具白名单只给必需项；超界即报 `dropped`，不自行扩大范围（照抄 superagent 的 Mandate inferred 语义：stop and report dropped; do not expand scope）；
- 与 §5.3 的通知开关配合：inferred 群默认"通知不阻塞"，开关 `coalitions.inferredBlocking` 可切"先问再建"。

### 8.2 Worker 崩溃恢复（照抄 retry-health）

worker session 是进程，会崩。恢复机制全部有现成代码可抄（superagent `executor/dsh.ts`）：

- **瞬时错误退避重试**：backoff `[5000, 300_000]`（5s 起、上限 5min），按 assignment 计数（`dsh.ts:210-211` 的 `transient` 表、`dsh.ts:233` 的 retry 队列）；
- **session 被外部删除自动重建**：`dsh.ts:313-316` "Recreate the worker session if it was externally deleted"——engine 发现 session 不在即 `sessions.ensure` 重建，票不丢；
- **投递失败记在票上**：失败不吞，记入 ticket 的 inputs 状态（`dsh.ts:234-235`，`quiet: true`）；
- **prepare 失败不自动重试**：目录非空视为半成品，标记 failed 等人来——防止把残目录当已就绪（`dsh.ts:277-283`）；
- **人重试**：`RETRIED` 语义，同 session 从 worktree/git 状态续作（`dsh.ts:136`）。

## 9. 与两个参考系统的对比定位

| 维度 | superagent Worker | Tobs bot | Mesh |
| --- | --- | --- | --- |
| 生命周期 | 按票即焚 `worker-<ticketId>` | 常驻 persona + Git 记忆 | 常驻专家 + 临时工两类并存 |
| 身份 | 无身份，票号命名 | 有人格，有 IM 名字，人直接 @ | 对人无 IM 入口；内部用能力目录互认 |
| 入口 | 只被 orchestrator 程序拉起，收 spec | 自己的 Inbox（飞书/Slack/Discord/QQ/微信，`@xmanrui/dsh-im`） | 只被 Router 拉起 |
| 层级 | 一层 | 两层（Orchestrator Session 管 Inbox + 并行 Assignment Sessions + subagent） | Worker 一层 + 群内程序调度 |
| 精确映射 | Tobs 的 Assignment Session ≈ superagent Worker；一个 Tobs bot ≈ superagent 系统迷你版 | | Mesh = 两者杂交 |

## 10. 实现路线与避坑

**路线（v2 重排 —— 见详设 §14）**：

v1 的顺序把最难、最没证据的排前面（Directory、Coalition），把最便宜最有价值的排后面（预算）。v2 改为**先证明能装上、再证明能用、最后才做协作**：

| 新序 | 内容 | 关键理由 |
| --- | --- | --- |
| M0 | 骨架 + SQLite + **patch 真能装上** | 评审发现 patch 语法与 preset 结构都错（R1/R2），装不上就什么都没意义 |
| M1 | WorkerExecutor + 2 个常驻 + 直通投递 + 票骨架 | 最小可用闭环：人 → Router → worker → report |
| M2 | **预算计量接线**（v1 排在第 6 位） | 最便宜、最确定有收益；越早有数据越早能判断后面要不要做 |
| M3 | 慢速通道（evals + dispatch 工件） | 没有它只能靠人显式点将 |
| M4 | Watchdog + HTTP 状态 API | 让 M2 的数据能被看见 |
| M5 | Directory（两级）+ advisory ask | **有证据才做**（≥5 次 worker 主动 needs） |
| M6 | Gate（含死锁三规则） | **有证据才做**（≥3 次真分歧或越界改动） |
| M7 | Coalition（剧本可选） | **有证据才做**（≥3 次需 3+ 视角） |

**判断标准写进流程**：M5/M6/M7 是否开工由 `audit` 表的实际计数决定，不由设计意愿决定。这三块占了 v1 设计 70% 的篇幅，但**不是 Mesh 的价值来源**——价值来源是 M1（类型化 worker）+ M2（预算可见）。

**开工前验证项（v2 扩为 6 条，半天内）**：

1. **`--dump-config` 里能看到 `mesh-engine`**（R1）；
2. **worker session 里 `bash`/`pwsh` 真能跑**（R2）；
3. `ctx.sessionController` / `ctx.workspaceRegistry` / `ctx.permissionPresets` 可用；
4. **根级 `ctx.on('session/event')` 能收到所有 worker session 事件**（R3；注意 v1 写的 `{global:true}` 是错的选项——`global` 是 Cordis 的 context-filter 绕过，与 DSH scope filter 是两回事，`vendor/cordis/src/events.ts:110-116`）；
5. `assistant/message.usage` 在插件上下文可读（裁决 5）；
6. `ctx.schedule.create({ target: { kind:'session', sessionId }, timing: { kind:'every', every_seconds } })` 可用——**v1 写的 `{session: id}` / 裸字符串 timing 都是错的**（`api-catalog.ts:8705-8710`）。

**避坑**（全部来自三仓库源码教训 + 本次评审）：

- **`cordis.patch.yml` 必须是 `- insert:` 包裹**（R1）——不带 insert 的 row 会被**静默跳过**，不报错，只在 stderr 打一行 warning；
- **preset 的 group 行必须是 `cordis:group` + 子行**（R2）——写 `dsh-shell`/`dsh-compaction` 只会挂服务，不挂工具（worker 会没有 shell）；
- **Router 无 Bash 是 Mesh 的主动偏离**（R10），不是抄 superagent——superagent 的 Router 有完整 shell；
- worker 预设必须写进 bundle 的 `cordis.patch.yml`——预设不在则历史 session resume 失败（`agent-preset/not-found`）；
- **`engines.dsh` 用 `>=0.2.2-rc.2 <0.2.3`**（R7）——`>=0.2.2-rc.1` 会拒绝下一个 rc（SemVer 预发布 tuple 规则）；
- **常驻数 ≤ residentSlots**（R5）——默认 2 个常驻，不是 4 个；
- **usage 不在事件回调里写库**（R8）——内存累加 + pass 批量 flush；
- 生命周期管理不用 tmux/Python 外部脚本（仅 Unix）；Watchdog 用 DSH schedule 插件的定时任务实现，跨平台。

---

*设计 v2（2026-11-15 评审修订）：13 项代码级核验问题全部修复，登记与证据见 `mesh-bundle-review.md`（R1–R13）。核心修正——Worker 不是独立进程（裁决 1 理由重写，R3）；Router 无 Bash 是主动偏离而非继承（R10）；常驻数 4→2（R5）；Directory 三级→两级（R12）；Coalition 剧本改可选（R13）；Gate 补死锁三规则（R9）；数据模型统一到详设（R11）；路线图重排。*

*设计 v1 历史：讨论定稿于 2026-11-14；Ticket 语义源码核查补于 2026-11-15；架构评审六项裁决与三块补齐（Mandate / 崩溃恢复 / 上下文卫生）补于 2026-11-15（superagent 证据指 `dsh-superagent-prototype/src/`，harness 证据指 `deepseek-harness/packages/`）。问题登记与裁决依据见 `mesh-bundle-issues.md`。*
