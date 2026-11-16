# Mesh bundle 问题登记簿（issues registry）

> **v2（2026-11-15 评审修订）**：v1 登记 5 条（P1–P5），评审新增 8 条（P6–P13），共 13 条。每条：问题 → 现实分析（源码证据）→ 解决方案（裁决）→ 状态。
> 评审的完整论证见 `mesh-bundle-review.md`；裁决编号与 `mesh-bundle-design.md` 一致；裁决 4、6 为用户亲自定夺。

## 登记表

| # | 问题 | 严重度 | 裁决 | 状态 |
| --- | --- | --- | --- | --- |
| P1 | Worker↔Bus 传输接缝（**理由已重写**） | 高（原"阻塞"） | 裁决 1 | ✅ 已裁决并修正理由 |
| P2 | moderator"纯程序"是 LLM 渗透起点 | 高 | 裁决 2 | ✅ 已裁决，**降级为可选**（P13） |
| P3 | escalate 能力倒挂 | 高 | 裁决 3 | ✅ 已裁决 + P9 补充 |
| P4 | Directory 诚实性（offers 谁写） | 中 | 裁决 4（用户定） | ✅ 已裁决，**降为两级**（P12） |
| P5 | 预算可测性 + 摘要成本 | 中 | 裁决 5 | ✅ 已裁决 + P8 补写入策略 |
| **P6** | **`cordis.patch.yml` 语法错误，Engine 不加载** | **阻塞** | — | ✅ 已修复（详设 §2.2） |
| **P7** | **preset 结构错误，worker 没有 shell** | **阻塞** | — | ✅ 已修复（详设 §2.2） |
| **P8** | **2s 轮询延迟无预算 + usage 写库阻塞主线程** | 高 | — | ✅ 已修复（详设 §4.4 / §9.1） |
| **P9** | **Gate 死锁未设计（互锁/裁决循环/环检测缺失）** | 高 | — | ✅ 已修复（详设 §7.2） |
| **P10** | **常驻 4 个 vs 槽位 3 个，跑不起来** | 中 | — | ✅ 已修复（详设 §5.4） |
| **P11** | **常驻=缓存 与 压缩是原生的 自相矛盾** | 中 | — | ✅ 已修复（详设 §3.4） |
| **P12** | **「前两级 0 token」是成本转移 + 中间级无必要** | 中 | — | ✅ 已修复（详设 §8.2） |
| **P13** | **Coalition 剧本前提自相矛盾** | 中 | — | ✅ 已修复（详设 §8.4） |
| **P14** | 铁律 2 出处错误（superagent Router 有 bash） | 中 | — | ✅ 已修复（详设 §0.3/§5.3） |
| **P15** | 数据模型两个版本不兼容 | 中 | — | ✅ 已修复（摘要 §7） |
| **P16** | `engines.dsh` 预发布 range 挡住下个 rc | 中 | — | ✅ 已修复（详设 §2.1） |

---

## P1：Worker↔Bus 传输接缝

**问题（v1 原表述）**：MessageBus 是 Router 主会话里的 Cordis 插件（SQLite 在主会话进程），Worker 是独立 DSH session（**独立进程**）——Worker 怎么把消息写进 bus？

**现实分析（v2 修正）**：**"独立进程"是错的。** DSH 的 session 与 agent 都是同进程内存对象：

- `ctx.sessions.get(id)` 返回 live Session，注释明说 persistence 不在这一层（`[DSH] api-catalog.ts:3384-3447`）；
- `ctx.agents.get(id)` 返回 live Agent（`api-catalog.ts:263-352`）；
- `session/event` 是同进程 post-commit emit（`api-catalog.ts:5477`）；
- superagent 自己就是同进程订阅：`ctx.on('session/event', (session, event) => { const agent = ctx.agents.get(session.id) … })`（`[SA] app/sessions.ts:116-121`）。

所以"不能直写 SQLite"**不成立**——同一进程、同一个 `DatabaseSync` 句柄，技术上完全可以直接写。

**解决方案（裁决 1，理由重写）**：bus 的唯一写者仍是 Engine，但理由是**架构选择**而非物理约束：

1. **审计完整**——所有状态变更过 `atomic()`，一条命令 = 一个事务 = 一个 audit 行。worker 直写就有洞。
2. **崩溃一致**——状态变更与 effect 意图**同事务**提交。worker 直写做不到（要么写状态不写 effect，崩溃后状态变了但活没派）。
3. **预算可卡**——token 消耗在派发前就能被拦。绕过 Engine 就绕过预算。

**代价（诚实记录）**：一次内存调用变成"写库 + ≤2s 被 pass 捡起"。缓解靠"receive 即踢"（P8 延迟预算），不靠换通信机制。

**状态**：✅ 已裁决并修正理由。开工验证项见详设 §14 第 4 条——注意 v1 写的 `{global:true}` 是错的选项（`global` 是 Cordis 的 context-filter 绕过，与 DSH scope filter 无关，`vendor/cordis/src/events.ts:110-116`）；根级未打 scope tag 的 listener 天然收全部（`packages/core/scope/README.md` Event filtering）。

## P2：moderator"纯程序"的 LLM 渗透

**问题**：结构化轮转的 moderator 声称是纯程序，但"下一轮谁发言、答什么"本身就是判断。纯程序 = 轮次表建群时就定死——而建群时恰恰缺乏这个信息（这正是建群要解决的）。

**现实分析**：判断的完整信息只在两个时刻存在：Router 建群时（它刚做完 dispatch 裁决）和发言进行中（分散在各 worker）。轮转中做判断必然要么上 LLM 要么瞎猜。

**解决方案（裁决 2）**：把判断一次性压回 Router——dispatch 工件里**预写轮转剧本**，moderator 纯程序只做两件事：执行剧本、处理剧本外情况 → escalate。轮转中零推理。

**状态**：✅ 已裁决。**但 P13 证明这个方案有前提缺陷，v2 已降级为可选。**

## P3：escalate 能力倒挂

**问题**：两个强模型 worker 的技术冲突上抛给轻模型 Router 裁决——裁决者弱于被裁决者。

**解决方案（裁决 3）**：escalate 分两级——程序冲突（死锁/预算/TTL/环）Router 轻模型裁；实质冲突转 **reviewer**（强模型只读）裁，Router 只执行其结论。

**v2 补充（P9 规则 B）**：裁决者必须**未参与本票**。若本票唯一 reviewer 已被 gate 占用或是争议方，不自动升级，改由人裁决。

**状态**：✅ 已裁决 + v2 补充。

## P4：Directory 诚实性（offers 谁写）

**问题**：offers/needs 谁声明？LLM 启动时自写会漂移、每次花 token；preset 手写则"自发现"退化为静态注册表；needs 匹配还有"不知道自己不知道"的天花板。

**解决方案（裁决 4，用户定）**：offers 与 needs 拆开——offers 静态声明（preset，人写，零漂移零 token）；needs 运行时发起（worker 干活中发现需要更专业的同事）。配套咨询协议（advisory + mandatory gate）。

**状态**：✅ 已裁决。**匹配机制已按 P12 从三级降为两级。**

## P5：预算可测性 + 摘要成本

**问题**：预算条款（80% 降级、100% 散群）的前提是能测到真实 token 消耗；另外每轮 merged summary 谁写。

**现实分析**：DSH 本体自带全套计量设施，问题实为"没人去测"——`assistant/message.usage`（`TokenUsage`）、`ctx.tokenMeter.measure`（surface 语义）、ACP 包已在用；superagent **主动丢弃** usage（`[SA] app/context.ts:28`）。

**解决方案（裁决 5）**：Engine 订阅 worker session 事件、聚合 usage 写入预算列，每轮 pass 核账；摘要由发言者按 schema 交结构化产出、moderator 程序合并字段，不做独立 LLM 摘要轮。

**v2 补充（P8）**：① 口径不能混——`measure()` 是 surface 压力，预算要用累计；② 写入不能在事件回调里（同步 SQLite + FULL = 每条消息一次主线程 fsync），改为内存累加 + pass 批量 flush。

**状态**：✅ 已裁决 + v2 补写入策略。

---

## 评审新增（P6–P16）

### P6：`cordis.patch.yml` 语法错误，Engine 根本不会加载　【阻塞，已修复】

**问题**：详设 §2.2 写成扁平 row 数组（`- id: mesh-engine`），但 bundle patch 必须是**外层 `- insert:` 包裹**。

**证据**：`publish.md:37-44`（示例即 `- insert:`）；`[SA] cordis.patch.yml:4`（全文 193 行只有第 4 行一个顶层元素）；`app-boot/src/config-schema/document.ts:29`（"Unknown targets and **non-insert patches without a nonempty id are warned and skipped**"）。

**后果**：不带 `insert` 的 `- id: mesh-engine` 被当成"覆盖已有 row"，全新 profile 没这个 id → unknown target → **警告后跳过** → Engine 永不挂载 → 整个 Mesh 空壳。`--dump-config` 只往 stderr 打一行 warning（`apps/cli/reference/README.md:35`）。

**修复**：详设 §2.2 整段重写为 `- insert:`，保留错误形态作反例，并给出两条 `--dump-config` 验证命令。M0 第一件事就是过这道关。

### P7：preset 结构错误，worker 会没有 shell　【阻塞，已修复】

**问题**：v1 的 preset 插件名裸写（`dsh-persona`）、group 行写成 `{name: dsh-shell, group: true}` 一行。

**证据**：`[SA] cordis.patch.yml:20-120` 同构结构——插件名带 `@deepseek-ai/` scope；group 行是 `name: cordis:group` + `config:` 子行数组；shell 子行是 `dsh-bash-sandbox`/`dsh-pwsh-sandbox` + `dsh-tool-bash`/`dsh-tool-pwsh`（按平台 `!!js` 二选一）；compaction 子行是 `dsh-compaction-basic`/`dsh-command-compact`/`dsh-compaction-tool-result-pruner`。

**后果**：`dsh-shell` / `dsh-compaction` 是**服务不是工具**（包真实存在：`packages/shell/shell`、`packages/compaction/compaction`）。只写它们 → worker 没有 bash/pwsh（写不了代码）、没有压缩（长票爆上下文）。

**修复**：详设 §2.2 按真实结构重写两个 preset；铁律 5 加"抄结构不抄名字"。

### P8：2s 轮询延迟无预算 + usage 写库阻塞主线程　【高，已修复】

**问题**：`[SA] passes.ts` 的 `setInterval(2000)` 被原样照抄，但 Mesh 是交互式场景（superagent 是 GitHub bot，分钟级异步）。且 §9.1 要求订阅每个 worker 的 `session/event` 并 upsert usage——`node:sqlite` 同步阻塞 + `synchronous=FULL` = 每条 assistant 消息一次主线程 fsync。

**延迟估算**：人消息 → worker 收到票，纯轮询地板 ≈ 4s（两跳 pass），再叠两次 LLM 与 session 创建。ask/gate 往返每跳再 +2s。

**修复**：详设新增 §4.4 延迟预算（六条路径的轮询跳数与目标上界），三条硬约束（交互路径必须 receive 即踢 / intervalMs 是兜底不是节拍 / 禁止在 pass 里做 LLM 调用）。§9.1 加写入策略表（事件回调只内存累加，pass 批量 flush 一次 fsync，崩溃最坏丢 ≤2s 计量，可接受）。

### P9：Gate 死锁未设计　【高，已修复】

**三个未解问题**：① 互锁（coder 等 reviewer，reviewer 自己也被 gate 挂起）；② 裁决循环（超时 escalate → 转 reviewer，而 reviewer 正是超时方）；③ 环检测被声称（§7.3 列"循环依赖"为程序冲突）但 `sweep('gates')` 只查 deadline。

**修复**：详设 §7.2 三条规则——A 持有者不可被挂起（自己正在等的人不能签字）；B 升级目标不得参与本票（违反则升级到人）；C `sweep('gates')` 做 DFS 环检测 + `depth > 3` 直接 escalate。另加"同票同时至多 1 个 open gate"。

**同时纠正定位**：gate 的价值不是"两个模型互相校验"（没用），而是把"改方案/交付"变成显式、有审计、不能偷偷做的——价值来自留痕与强制停顿，不来自更强判断。

### P10：常驻 4 个 vs 槽位 3 个　【中，已修复】

**问题**：§6.1 标 4 个常驻，§2.2 `maxWorkers: 3`，§5.4 说"含常驻"——4 > 3，第一个 launch 就排不上。

**修复**：§5.4 拆 `residentSlots`（预留，不参与票排队）+ `tempSlots`（参与排队）；默认 `residentWorkers: 2`（researcher + coder）+ `tempSlots: 2`；reviewer/ops 改按需拉起。理由不只槽位：每个常驻持续付三份成本，而 reviewer/ops 调用频次无数据支撑。

### P11：常驻=缓存 与 压缩是原生的 自相矛盾　【中，已修复】

**问题**：§3.3 同段并列"上下文当缓存"与"压缩是原生的"。但 DSH 压缩**重写 surface** = 改变 prompt 前缀，而前缀缓存前提是前缀不变 → 压缩一发生就全量 cache miss。

**修复**：§3.4 三分表——再定向 note（append，保前缀，**这才是缓存命中的真实来源**）/ 压缩（重写 surface，**显式接受一次 miss**）/ Watchdog（不碰上下文）。把"常驻=缓存"降级为"**常驻=避免冷启动重扫**，不承诺缓存命中"。加"压缩后精简 note 重新定向，不做补偿性全量重读"。

### P12：「前两级 0 token」是成本转移 + 中间级无必要　【中，已修复】

**问题**：§8.2 声称三级匹配前两级零 token。但第一级要求 worker 按约定语法点将——这段语法要写进每个 worker 的 system prompt（**预付，常驻**），且 worker 决定要不要用、点谁（**一次 LLM 判断**）。不是"0 token 自发现"，是"把路由成本摊进每个 worker 的 prompt"。

**中间级的额外问题**：预计算 tags 需离线 embedding（一次性可接受），但 needs 每次求助也要 embedding（**这就不便宜了**），且向量阈值是无数据的玄学。

**修复**：降为**两级 + 显式降级**（keyword 命中 → advisory；未命中 → Router 轻模型；都空手 → `deferred` 挂 thread pending 不阻塞）。加成本归属表，把说法改为"**匹配本身 0 token**，不是自发现 0 token"。明确"规模到 20+ worker 再考虑加回中间级"。

### P13：Coalition 剧本前提自相矛盾　【中，已修复】

**问题**：裁决 2 要求 Router 建票时预写剧本，前提是形状可预测。但需辩论的场景恰恰形状不可预测；形状可预测的任务单 worker 更快。**机制只在"你不需要它的时候"有效。**

**修复**：不删机制，降级为**可选**。`coalition_script` 允许为空（默认）→ 形态 B：单轮收集 + 程序合并（无轮转无顺序依赖）。形态 B 也能"零推理"，因为它根本不需要轮转——这比预写剧本更诚实。非空剧本仅用于"步骤角色开工前已确定"的多步核验，Router 只在有明确依据时写。

### P14：铁律 2 出处错误　【中，已修复】

**问题**：§0.3 铁律 2 与 §5.3 声称"Router 无 Bash 是 superagent 同款、有意为之"。

**事实**：`[SA] cordis.patch.yml:148-174` 的 router preset **有完整 shell group**（`bash-sandbox`/`pwsh-sandbox` + `tool-bash`/`tool-pwsh`，仅 `timeoutMs: 5000` 让前台命令转后台）。superagent 保留 shell 是为了在主会话跑 `git`/`gh` 做轻量状态查询。

**修复**：改为"Mesh 主动偏离"，给出三条偏离理由（工具面成本是乘数 / 路由状态全在 `mesh_read` / 调度面能干活就会干活），并加警告"发现 Router 没有 bash 不是 bug，别补上去"。

### P15：数据模型两个版本不兼容　【中，已修复】

**问题**：摘要 §7 是关系型列式（`tickets(id, thread_id, spec_json, worker_id, state)`），详设 §3.2 是 JSON 列式（`ticket(id, value TEXT)`）。摘要那份没标废弃。

**修复**：摘要 §7 改为指向详设 §3.2/§3.3，保留概念层表清单 + "为什么 JSON 列"的理由，明写 v1 关系型草案已废弃。

### P16：`engines.dsh` 预发布 range 挡住下个 rc　【中，已修复】

**问题**：§2.1 写 `">=0.2.2-rc.1"`。SemVer 预发布规则：`X.Y.Z-pre` 只在 range 里存在**同一 `[X,Y,Z]` 元组**的预发布比较符时才被接纳。所以它接受 `0.2.2-rc.2`（当前版本），但**拒绝 `0.2.3-rc.1`**——下一个 rc 就装不上。这正是避坑第 3 条自己列的坑换了形式。

**修复**：改为 `">=0.2.2-rc.2 <0.2.3"`（钉死已验证 minor），注释写明"每次 DSH 发新 rc 必须手动抬 range"。

---

## 补登记：v1 评审发现的三个缺块（已补进设计文档）

| 缺块 | 补进位置 | 内容 |
| --- | --- | --- |
| Mandate 强度 | 设计文档 §8.1 | explicit 全额预算 / inferred 预算减半 TTL 减半超界报 dropped；配合裁决 6 的通知开关 |
| Worker 崩溃恢复 | 设计文档 §8.2 | 照抄 superagent retry-health：退避重试 [5000, 300_000]、session 自动重建、投递失败记票、prepare 失败等人、RETRIED 语义 |
| 常驻上下文腐化 | 设计文档 §3.3 | 每票再定向 note + DSH 原生压缩 + Watchdog 只管异常（**P11 已修正其内在矛盾**） |

## 用户裁决记录（2026-11-15）

1. **推断建群模式（裁决 6）**：默认通知不阻塞——自动建群 + 立即通知（谁、为什么、预算多少），用户随时可 stop；提供开关 `coalitions.inferredBlocking`（默认 `false`）切换为阻塞式先问再建。
2. **能力目录来源（裁决 4）**：offers 静态声明（preset，人写）；needs 不写死，worker 运行时主动寻求对应专业的 worker（类比：coder 交付页面前必咨询 UX 拿设计；改实现方案必咨询 SE，SE 同意才能改）。

---

*登记簿 v2（2026-11-15）：v1 的 P1 理由已重写（同进程事实），新增 P6–P16。全部 16 条状态为已裁决/已修复。评审论证见 `mesh-bundle-review.md`。*
