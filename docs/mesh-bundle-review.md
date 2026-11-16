# Mesh Bundle 设计评审（Review Findings）

> 评审对象：`mesh-bundle-design.md`（摘要层 v1）、`mesh-bundle-issues.md`（P1–P5 登记簿）、`mesh-bundle-detailed-design.md`（详设 v1.1）。
> 评审方式：**代码级核验**——对三份文档的每处引用，回到 `dsh-superagent-prototype/src/`、`deepseek-harness/packages/`、`deepseek-harness/docs/` 逐条比对。
> 评审结论：**方向成立，v1 不可直接开工**。登记 13 项，其中 2 项阻塞（装上去是空壳），4 项高（语义错误/未设计），7 项中（配置与取舍）。
> 修复状态：本文件登记的问题已在同批修订中全部落入三份设计文档（v2）。修订点见每条的「修复」栏。

## 编号对照（本文 R 编号 ↔ 问题登记簿 P 编号）

评审按发现顺序编 R 号；登记簿按并入顺序编 P 号（P1–P5 是 v1 原有的）。两套编号指向同一批问题：

| 本文 | 登记簿 | 一句话 |
| --- | --- | --- |
| R1 | **P6** | `cordis.patch.yml` 缺 `- insert:`，Engine 不加载【阻塞】 |
| R2 | **P7** | preset 的 group 结构错，worker 没有 shell【阻塞】 |
| R3 | **P1（理由重写）** | 「Worker 是独立进程」是错的 |
| R4 | **P8（前半）** | 2s 轮询延迟无预算 |
| R5 | **P10** | 常驻 4 个 vs 槽位 3 个 |
| R6 | **P11** | 常驻=缓存 与 压缩是原生的 自相矛盾 |
| R7 | **P16** | `engines.dsh` 预发布 range 挡住下个 rc |
| R8 | **P8（后半）** | usage 写库阻塞主线程 |
| R9 | **P9** | Gate 死锁未设计 |
| R10 | **P14** | 铁律 2 出处错误（superagent Router 有 bash） |
| R11 | **P15** | 数据模型两个版本不兼容 |
| R12 | **P12** | 「前两级 0 token」是成本转移 |
| R13 | **P13** | Coalition 剧本前提自相矛盾 |

下文用 R 编号叙述（保持发现顺序的叙事），落到设计文档时以 P 编号为准。

## 0. 总评

文档的**工程纪律在平均线以上很多**：带行号的源码引用（抽查 20 处，18 处准确）、六项显式裁决、P1–P5 风险登记簿、可判定的验收标准、tracer bullet 里程碑。这套纪律比多数真实项目的设计文档更严格。

问题不在写得糙，而在**写得太顺**——把"从源码抄来的"和"自己推断的"混在同一叙述里，且三个全新构件（Coalition / Gate / Directory）承载了 70% 的篇幅，却没有任何一处论证它们比"不做"更好。

---

## 1. 阻塞项（按 v1 落地会得到一个空壳）

### R1 — `cordis.patch.yml` 整体语法错误，Engine 不会加载　【阻塞】

**v1 写法**（详设 §2.2）：

```yaml
- id: mesh-engine
  name: mesh-engine
  config: { ... }
- name: '@deepseek-ai/dsh-agent-preset'
  config: { ... }
```

**实际要求**：bundle patch 是**外层 `- insert:` 包裹**的层，所有 row 缩进在 `insert` 之下。

三处独立证据：

| 证据 | 内容 |
| --- | --- |
| `[DSH] docs/user/develop/basic/publish.md:37-44` | bundle 示例即 `- insert:` / `  - id: hello` / `    name: dsh-hello-plugin` |
| `[SA] cordis.patch.yml:4` | 全文 193 行，**只有第 4 行一个顶层元素 `- insert:`**，其余全部缩进 |
| `[DSH] packages/boot/app-boot/src/config-schema/document.ts:29` | "Other patches replace supplied fields… **Unknown targets and non-insert patches without a nonempty id are warned and skipped**" |

**后果**：`- id: mesh-engine` 不带 `insert` 会被解析为"覆盖已有 row"的补丁；全新 mesh profile 没有这个 id → unknown target → **警告后跳过** → Engine 插件永不挂载 → 整个 Mesh 是空的。`--dump-config` 只在 stderr 打一行 warning（`apps/cli/reference/README.md:35` 明确 unmatched target 走 stderr），极易被忽略。

**修复**：详设 §2.2 整段重写为 `- insert:` 结构，并在注释里写明反例与判据。

### R2 — preset row 的插件名与 group 结构错误，worker 会没有 shell　【阻塞】

v1 与 `[SA] cordis.patch.yml:60-193`（同一份被引用的文件）逐行比对：

| 项 | v1 写法 | 实际写法 | 后果 |
| --- | --- | --- | --- |
| 插件名 | `dsh-persona` / `dsh-tool-fs` / `dsh-shell` | `@deepseek-ai/dsh-persona` / `@deepseek-ai/dsh-tool-fs` | 裸名无 scope，Node 解析失败 |
| shell | `{ name: dsh-shell, group: true, isolate: {shell: true} }` 一行 | `name: cordis:group` + `config:` 嵌套子行 `dsh-bash-sandbox`/`dsh-pwsh-sandbox` + `dsh-tool-bash`/`dsh-tool-pwsh`（按平台 `!!js` 二选一） | **`dsh-shell` 是 shell 服务，不是工具**；不写子行 → worker **没有 bash/pwsh**，写不了代码 |
| compaction | `{ name: dsh-compaction, group: true, ... }` | `cordis:group` + `dsh-compaction-basic` / `dsh-command-compact` / `dsh-compaction-tool-result-pruner`（带 `thresholdChars/headChars/tailChars`） | 无压缩、无 tool-result 剪枝 → 长票爆上下文 |

已核实这些包**真实存在**（`packages/shell/shell`、`packages/compaction/compaction`、`packages/context/persona`），但**都是服务/基础件，不是工具**。v1 抄的是名字，不是结构——直接违反自己定的铁律 5（"superagent 的 router/worker 模式直接抄"）。

**修复**：详设 §2.2 按真实 preset 结构重写两个 preset，group 行改为 `cordis:group` + 子行数组。

### R3 — 「Worker 是独立进程」是错的，裁决 1 的论证因此悬空　【高】

问题簿 P1 原文：「SQLite 在主会话进程，Worker 是独立 DSH session（**独立进程**）——Worker 怎么把消息写进 bus？」

**事实**：DSH 的 session 与 agent 都是**同进程内存对象**。

| 证据 | 内容 |
| --- | --- |
| `[DSH] api-catalog.ts:3384-3447` `ctx.sessions` | `get(id)` 返回 live Session，`list()` 返回全部 live session；内存 store，注释明说 "Persistence is intentionally not implemented here" |
| `[DSH] api-catalog.ts:263-352` `ctx.agents` | `get(id)` 返回 live Agent，同进程注册表 |
| `[DSH] api-catalog.ts:5477` `session/event` | 同进程 `emit`，post-commit 追加feed |
| `[SA] app/sessions.ts:116-121` | superagent 自己就是 `ctx.on('session/event', (session, event) => { const agent = ctx.agents.get(session.id) ... })`——从未跨进程 |

**为什么这不是抠字眼**，两个连带后果：

1. **裁决 1 的理由要换**。"不能直写 SQLite" 不成立——同一进程、同一个 `DatabaseSync` 句柄。真正成立的理由是审计、单事务入口、预算闸门。这些是好理由，但它们是**设计选择**，不是物理约束；v1 把选择题写成了必答题。
2. **它排除掉了正确的简化方案**。既然同进程，worker↔worker 通信本来可以走直接函数调用（零延迟、零序列化）。v1 硬塞进 SQLite + 2s pass loop，等于给一次内存调用加了磁盘写入和最多 2 秒延迟。

**修复**：问题簿 P1 改为「同进程、但写者唯一是**架构选择**」，理由重写为审计/事务/预算；摘要 §4 与详设 §0.3 铁律 1 同步；新增 §15 记录传输接缝事实。

### R4 — 2s 轮询延迟没有预算，而 Mesh 的目标场景是交互式　【高】

`[SA] passes.ts` 的 `setInterval(2000)` 被原样照抄。superagent 用它没问题——GitHub issue bot，分钟级异步。但 Mesh 的 M1 验收标准是「人主会话说『让 researcher 调研 X』→ worker 收到票」。

实际链路：

```
人消息 → intake → pass(≤2s) → assess effect → 投主会话 → Router LLM turn（数秒）
      → mesh_route → create → launch effect → pass(≤2s) → session ensure（数秒）→ 投 worker
```

**纯轮询地板 ≈ 4s**，再叠两次 LLM 与 session 创建。worker 间一次 ask/gate 往返（问→等→答→恢复）每跳再 +2s，多跳协作轻松 6–10s 纯等待。v1 完全没有延迟预算，也没有"哪些路径可以跳过轮询"的设计。

**修复**：详设新增 §4.4「延迟预算」，给出各路径的轮询跳数与可接受的端到端上界，并把"receive 即踢"从"优化项"升为"交互路径的必需项"。

### R5 — 默认配置跑不起来设计的拓扑　【中】

- §6.1：researcher / coder / reviewer / ops **四个都标常驻**；
- §2.2：`executor: { maxWorkers: 3 }`；
- §5.4：「总数 = `executor.maxWorkers`（默认 3，**含常驻**）」。

**4 常驻 > 3 槽位**，第一个 `launch` 就排不上。superagent 的槽位模型是为"按票即焚、槽位=并发票数"设计的，套到"4 常驻 + 若干临时"上语义不匹配。

**修复**：详设 §5.4 拆分「常驻预留槽 + 临时槽」，默认 `residentWorkers: 2`（researcher + coder）+ `tempSlots: 2`，并说明为什么常驻不宜一次上四个（每个常驻都是持续缓存成本）。

### R6 — 「常驻=缓存」与「压缩是原生的」自相矛盾　【中】

§3.3 同段并列两句：常驻 worker「上下文当缓存」，且「压缩是原生的，worker 自带 billion-context 压缩」。

但 DSH 压缩会**重写 surface**（`[DSH]` compaction 家族即改写 model-visible 上下文），也就是改变 prompt 前缀——而前缀缓存的前提恰恰是前缀不变。压缩一发生，下次请求就是全量 cache miss。

"每票再定向 note"是 append，不破坏前缀，这个设计是对的；压缩不是。v1 把两个互斥的东西写成了互补。

**修复**：§3.3 改为三分：再定向 note（append，保前缀）、压缩（重写 surface，**明确接受一次 cache miss**，并给出"压缩后重新预热"的说明）、Watchdog（只管异常）。同时把"常驻=缓存"降级为"常驻=避免冷启动重扫"，不承诺缓存命中。

### R7 — `engines.dsh` 的预发布 range 会挡住下一个 rc　【中】

§2.1 写 `"engines": { "dsh": ">=0.2.2-rc.1" }`。

SemVer 预发布规则：`X.Y.Z-pre` 只有在 range 里存在**同一 `[X,Y,Z]` 元组**的预发布比较符时才被接纳。所以：

| 目标版本 | `>=0.2.2-rc.1` | 说明 |
| --- | --- | --- |
| `0.2.2-rc.2`（当前 `deepseek-harness/package.json` 实测值） | ✅ | 同 tuple，有 prerelease 比较符 |
| `0.2.3-rc.1` | ❌ **拒绝** | 不同 tuple，无对应 prerelease 比较符 |

这正是 §14 避坑第 3 条自己列的坑（superagent 卡 `^0.2.1-alpha.2` 装不上），换了个形式又踩进去。

**修复**：§2.1 改为 `">=0.2.2-rc.2 <0.2.3"`（钉死已验证 minor），并在注释里写明"每次 DSH 发新 rc 必须手动抬 range"，附上 semver tuple 规则的一句话解释。

### R8 — 同步 SQLite + `synchronous=FULL` 在主线程上被 4+ worker 共享　【中】

`node:sqlite` 的 `DatabaseSync` 是**同步阻塞**的（`[SA] app/store.ts:58-60` 即 `new DatabaseSync(path)`）。§9.1 要求 Engine 订阅每个 worker 的 `session/event` 并 upsert usage，也就是每条 `assistant/message` 一次写库。WAL + `synchronous=FULL` 意味着每次提交都 fsync，全部落在主线程。

superagent 单 bot 状态量小，无所谓；Mesh 是 4+ worker 共用一条事件循环，且 usage 是**热路径**（每条 assistant 消息）。

**修复**：§9.1 增加写入策略——usage 先在内存聚合、按 pass 周期批量 flush（一个事务一次 fsync），并明确"不要在 `session/event` 回调里直接 upsert"。

### R9 — Gate 是死锁温床，环检测被声称但未设计　【高】

§7.2/§7.3 的 gate 机制没有解三个问题：

1. **互锁**：coder 挂起等 reviewer approve；若 reviewer 自身也被 gate 挂起 → 双方永等；
2. **裁决循环**：gate 超时 escalate，若判为"实质冲突"转 reviewer——**而 reviewer 正是超时的那一方**；
3. **环检测缺失**：§7.3 把"循环依赖"列为程序冲突交 Router，但 §4.1 的 `sweep('gates')` **只检查 deadline**，没有任何依赖图或环检测实现。

**修复**：§7.2 增加 gate 依赖图与三条规则（持有者不可被挂起 / 同票同时至多一个开放 gate / 超时升级目标必须强于当前持有者且未参与本票），`sweep('gates')` 增加环检测；§7.3 补"reviewer 不可作为自身超时案的裁决者"。

### R10 — 铁律 2 的出处错误：superagent 的 Router **有** bash　【中】

§0.3 铁律 2 与 §5.3 声称「Router 无 Bash 是**有意为之**（superagent 同款）」。

核对 `[SA] cordis.patch.yml:148-174`（router preset 段）：**包含完整 shell group**——`bash-sandbox`（`timeoutMs: 5000`）/ `pwsh-sandbox` / `tool-bash` / `tool-pwsh`。superagent 的 Router 只是把前台命令 5 秒后转后台，**并没有去掉 shell**。

所以"Router 无 Bash"是 **Mesh 的主动偏离**，不是继承。偏离本身合理（调度面不该干活），但把偏离写成"抄"，会让后续实现者以为漏了东西又加回去。

**修复**：§0.3 铁律 2 与 §5.3 改为"Mesh 主动偏离 superagent：去掉 shell"，并注明 superagent 的做法与它保留 shell 的原因（5s 转后台，避免长命令卡住人的消息）。

### R11 — 数据模型两个版本不兼容，摘要那份是废弃稿但未标注　【中】

- 摘要 §7：`tickets(id, thread_id, spec_json, worker_id, state)` / `workers(id, kind, session_id, status, offers[], budget)` ——**关系型列式**；
- 详设 §3.2：`ticket(id, value TEXT)` / `worker(id, value TEXT)` ——**JSON 列式**。

两套不兼容。摘要那份没有任何废弃标注，读者会按错的那份建表。

**修复**：摘要 §7 改为指向详设 §3.2，并标注"v1 关系型草案已废弃，实际实现为 JSON 列 + 生成列索引"。

### R12 — 「前两级匹配 0 token」是成本转移，不是消除　【中】

§8.2 三级匹配声称前两级零 token。但第一级要求 worker「按 sharedPrompt 约定的 `keyword: xxx` 语法显式点将」，这意味着：

- 每个 worker 的 system prompt 都要写清这套语法 → **成本预付在每一个 worker 上**；
- worker 是否想起用它、keyword 选什么 → **本身就是一次 LLM 判断**。

不是"0 token 自发现"，而是"把路由成本摊进每个 worker 的 prompt"。这个 trade-off 可能划算，但 v1 把成本藏起来了。

**修复**：§8.2 补成本归属说明，并把"三级"降为"两级 + 显式降级"（keyword 命中 → 直接开 advisory ask；未命中 → 直接上 Router 轻模型，不再维护 tags 中间层——中间层需要离线算 embedding，是额外设施而非零成本）。

### R13 — Coalition 剧本的前提自相矛盾　【中】

裁决 2 把"下一轮谁发言"压回 Router 在建票时预写剧本。机制上确实堵住了 LLM 渗透，但**前提**是：Router 在建票那一刻就能预测协作形状（谁先说、答什么、几轮）。

而需要多 agent 辩论的场景，恰恰是形状不可预测的场景。能提前写清剧本的任务，一个强模型 worker 自己做完更快。于是这个机制**只在"你不需要它的时候"有效**——这是设计层面的自相矛盾，不是实现问题。

**修复**：不删机制（它仍适用于"形状已知的多步核验"），但降级为**可选**：`coalition_script` 允许为空，为空时走"单轮收集 + 程序合并"（所有成员各答一次，无轮转），并在 §8.3 写明适用边界与不适用场景。路线图里把它排到最后。

---

## 2. 价值判断

### 真正值得做（且便宜）

| 构件 | 价值 | 理由 |
| --- | --- | --- |
| 类型化 worker + preset + 权限分层 | ⭐⭐⭐⭐⭐ | 直接解决"一个通用 bot 什么都干、什么都干不好"。DSH 现成设施，`permissionPresets.set` 一行 |
| **预算计量接线** | ⭐⭐⭐⭐⭐ | DSH 有 `tokenMeter` + `usage` 事件，superagent **主动丢弃**（`[SA] app/context.ts:28`）。接上就是净收益，几乎零成本 |
| 审计全咽喉（Engine 唯一写者） | ⭐⭐⭐⭐ | 信任与调试的基础。理由要换（R3），结论仍对 |
| 每票再定向 note | ⭐⭐⭐⭐ | 几十 token 换掉陈旧信念，非常聪明 |
| Effects/Passes 崩溃续跑 | ⭐⭐⭐⭐ | 可直接抄，已被 superagent 验证 |

### 不值得现在做

| 构件 | 问题 |
| --- | --- |
| Coalition 临时小群 | 最复杂、最无证据、只在不需要时有效（R13） |
| Gate 强制过闸 | 同模型互签，用延迟和 token 买可追溯；死锁未解（R9） |
| Directory 三级匹配 | 成本被转移而非消除（R12）；第三级又回到 Router LLM |

### 文档没问的那个问题

DSH 已有 `@deepseek-ai/dsh-tool-subagent`（`provider`、`agentPreset` 按需指定、`modelSelection`、in-process 分叉）。**"带 preset 的类型化 worker"这件事，subagent 已经给了**。Mesh 相对 subagent 真正缺的只有三样：**独立生命周期、跨 worker 消息、预算记账**。而 v1 写了 10 个域模块。

---

## 3. 修订后的实施建议（已落入详设 §14）

v1 的 M0→M6 把最难、最没证据的排前面（M2 Directory、M3 Coalition），把最便宜最有价值的排后面（M5 预算）。改为：

| 新序 | 内容 | 为什么这个顺序 |
| --- | --- | --- |
| **M0** | 骨架 + Store/Effects/Passes + **patch 真能装上的验证** | R1/R2 是阻塞项，必须先证伪；顺带证明崩溃续跑 |
| **M1** | WorkerExecutor + 常驻池 + 直通投递 + 票骨架 | 最小可用闭环：人→Router→worker→report |
| **M2** | **预算计量接线**（从 v1 的 M5 提前） | 最便宜、最确定有收益；越早有数据越早能判断后面要不要做 |
| **M3** | 慢速通道（evals + assessment + dispatch 工件） | 没有它只能靠人显式点将 |
| **M4** | Watchdog + HTTP 状态 API | 可观测，让 M2 的数据能被看见 |
| **M5** | Directory（两级，R12）+ advisory ask | 只有 M1–M4 跑出"确实需要临时拉人"的证据才做 |
| **M6** | Gate（含 R9 的环检测） | 只有审计表里出现"两个 worker 真分歧"的案例才做 |
| **M7** | Coalition（剧本可选，R13） | 最后。没有真实多轮辩论案例就不做 |

**判断标准**（写进文档，避免自我说服）：M5/M6/M7 是否开工，由 `audit` 表里的**实际计数**决定，不由设计意愿决定。

---

## 4. 修复清单（本批已落地的文档改动）

| 文档 | 改动 |
| --- | --- |
| `mesh-bundle-detailed-design.md` | v2 修订：§0.3 铁律 1/2 理由与出处重写（R3/R10）；§2.1 engines range（R7）；**§2.2 全文重写**（R1/R2，含反例与 `--dump-config` 验证命令）；§3.4 新增上下文经济学三分（R6）；§3.5 新增数据模型单一权威（R11）；§4.4 新增延迟预算（R4）；§5.3 Router 工具面偏离说明（R10）；§5.4 槽位拆分 resident/temp（R5）；§6.1 常驻表 4→2（R5）；§7.2 gate 死锁三规则（R9）；§7.3 升级目标不参与本票（R9）；§8.2 两级匹配 + 成本归属（R12）；§8.4 剧本可选（R13）；§9.1 usage 批量写 + 口径澄清（R8）；§11.1 schedule 调用签名修正（`{kind:'session'}`）；§13 单测面与验收表重写；§14 里程碑重排 + 6 条验证项 + 避坑扩充；**§15 新增传输接缝事实**（R3）；附录 B 补证据 |
| `mesh-bundle-design.md` | v2 修订：头部状态（不再是"尚未实现"）；§2 同进程事实 + Router 有 shell 的事实（R3/R10）；§3.1 常驻数 4→2（R5）；§3.3 上下文经济学修正（R6）；§4 裁决 1 理由重写（R3）；§4 裁决 3 补"未参与本票"（R9）；§5.1 两级匹配 + 成本（R12）；§5.2 gate 死锁三规则（R9）；§5.3 剧本可选（R13）；§6 usage 口径与批量写（R8）；**§7 数据模型改为指向详设**（R11）；§10 路线图重排 + 6 条验证项 + 避坑扩充 |
| `mesh-bundle-issues.md` | v2 重写：P1 理由重写（R3）；P2/P4 加降级说明；P3/P5 加 v2 补充；**新增 P6–P16**（对应 R1–R13 的全部发现） |
| `mesh-bundle-review.md` | 本文件：新增（R1–R13 + 编号对照表 + 价值判断 + 实施建议） |

**一致性检查已做**：三份文档的 R/P 编号通过本文件 §0 的对照表互指；详设的 `- insert:` YAML 已用脚本验证结构（顶层唯一元素为 `insert`，无游离顶层 row）；摘要 §7 不再提供 DDL，改为指向详设。

---

*评审于 2026-11-15；核验基线：`dsh-superagent-prototype` @ 工作区快照、`deepseek-harness` 0.2.2-rc.2、`DeepSeekBot` @ 工作区快照。所有结论均可按本文件给出的文件:行号复现。*
