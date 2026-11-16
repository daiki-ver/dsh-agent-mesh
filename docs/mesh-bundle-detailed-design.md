# Mesh Bundle 开发级详细设计（Detailed Design）

> 状态：**详设 v2**（2026-11-15 修订）。v1 曾自称"可直接开工"，**这是错的**——评审发现 2 个阻塞级缺陷（§2.2 的 patch 语法与 preset 结构都装不上，见 `mesh-bundle-review.md` R1/R2）。v2 已修复 13 项登记问题，里程碑重排，现在才具备开工条件。
> 设计决策与裁决依据见 `mesh-bundle-design.md`（摘要层）与 `mesh-bundle-issues.md`（P1–P13 登记簿）；评审发现与代码证据见 `mesh-bundle-review.md`。
> 证据标注：`[SA]` = `dsh-superagent-prototype/src/`（已逐行核实的可照抄实现）；`[TB]` = `DeepSeekBot/packages/` + `docs/architecture/`（Tobs 生产模式）；`[DSH]` = `deepseek-harness/packages/`（DSH 本体设施）。
> 未标注的行为均为 Mesh 的**新设计**（有依据的增量，不是发明——每个新构件都注明它替换/扩展了参考系统的哪个部件）。
> **v2 修订原则**：凡"抄 [SA]"的断言，必须能指出被抄文件里的**同构结构**，不能只指出同名符号。R2 就是这么出错的（抄了 `dsh-shell` 这个名字，漏了它的 group 子行）。

## 0. 导读

### 0.1 文档关系

```
mesh-bundle-review.md            评审发现 R1–R13（代码级核验 + 修复状态）  ← 先读这个
mesh-bundle-design.md            设计摘要 + 六项裁决（为什么）
mesh-bundle-issues.md            问题登记簿 P1–P13（风险与对策）
mesh-bundle-detailed-design.md   ← 本文：怎么写代码（模块/接口/DDL/状态机/验收）
```

### 0.2 一句话架构

**Mesh = superagent 的 Engine/Effects/票 调度内核 + Tobs 的常驻多会话形态 + 群聊协作纪律**：一个专用 DSH profile，主会话是 Router（轻上下文、只有路由工具），常驻/临时 Worker 是独立 DSH session（**同一进程内的独立 session，不是独立进程**，见 §15），全部通信经 Engine（SQLite 单库 + 2s pass loop），LLM 只出现在两个窄缝（Router 建票裁决、worker 干活），其余全是程序。

### 0.3 铁律（违反即设计失败）

1. **bus 的唯一写者是 Engine**（裁决 1，P1）：Worker 不直写 SQLite，出站走工具→Engine，入站走 `session/event` 订阅。`[SA] executor/dsh.ts:203-205, 342`
   > **理由澄清（v2，R3）**：这不是物理约束——worker session 与 Engine 同进程、同一个 `DatabaseSync` 句柄，技术上完全可以直接写（`[DSH] api-catalog.ts:3384-3447` `ctx.sessions.get()` 返回同进程 live Session；`[SA] app/sessions.ts:116-121` 自己就是同进程订阅）。唯一写者是**架构选择**，买的是三样东西：审计完整（每条状态变更一个事务一个 audit 行）、崩溃一致（状态与副作用意图同事务）、预算可卡（所有 token 消耗都过 Engine 记账）。**选这条就别绕过它**，但不要说它是"做不到"。
2. **Router 上下文必须轻**：无 Bash、无文件写，只有路由/评估/回复工具。
   > **主动偏离（v2，R10）**：superagent 的 Router **有完整 shell**（`[SA] cordis.patch.yml:148-174`：`bash-sandbox`/`pwsh-sandbox` + `tool-bash`/`tool-pwsh`，只是前台命令 5s 转后台）。Mesh 去掉 shell 是**主动偏离**，不是继承。偏离理由：调度面不该自己干活，且 Router 的工具越多、system prompt 越长、每次路由越贵。不要把"补上 shell"当成修 bug。
3. **轮转中零推理**（裁决 2，P2）：剧本在 dispatch 工件里预写，moderator 纯程序执行；剧本外情况一律 escalate，不偷偷上 LLM。
4. **裁决者不弱于被裁决者**（裁决 3，P3）：程序冲突 Router 裁，实质冲突 reviewer（强模型只读）裁。
5. **worker 预设进 `cordis.patch.yml`**：session 创建时锁定 preset，否则历史 session resume 失败（`agent-preset/not-found`）。`[SA] app/sessions.ts:122-131, 143-145`
   > **抄结构不抄名字（v2，R2）**：preset 的 `plugins` 数组里，group 行必须是 `name: cordis:group` + `config:` 子行数组，子行才是真实插件。`dsh-shell`/`dsh-compaction` 是**服务**，不是工具；只写它们等于没有 shell、没有压缩。
6. **生命周期管理不用外部进程**：无 tmux/Python，全部 DSH 内（schedule 插件 + session API）。

## 1. 系统总览

### 1.1 运行形态

```
专用 profile「mesh」
├── 主会话 = Router（装 mesh bundle，mesh-router preset）
│     └── 工具面：mesh_route / mesh_eval* / mesh_ticket_* / mesh_read / mesh_settings_* …（§5.3）
├── Engine（bundle 主插件，纯 TS，不占任何 LLM 上下文）
│     ├── Store：SQLite 单库 ~/.dsh/state/mesh/mesh.db（§3）
│     ├── Effects：持久副作用队列（§4.1）
│     ├── Passes：2s 时钟 + 串行化（§4.2）
│     └── 域模块：Intake / Evals / Tickets / Assignments / Bus / Directory / Coalitions / Gates / Budget（§4.3）
├── Worker 池（独立 DSH session，mesh-worker preset）
│     ├── 常驻：mesh-<kind>-<seq>（researcher/coder/reviewer/ops）
│     └── 临时：mesh-temp-<ticketId>（按票即焚——焚票不焚 session）
└── Watchdog：日常 profile 的 schedule 定时任务（每小时，§11.1）
```

### 1.2 概念表

| 概念 | 定义 | 出处 |
| --- | --- | --- |
| Router | mesh profile 的主会话，调度面：路由/评估/建票/escalate 裁决 | superagent master session `[SA]` |
| Engine | bundle 主插件里的纯程序状态机，一切状态变更唯一入口 | superagent Engine `[SA] core/engine.ts` |
| Worker | 独立 DSH session，数据面；分常驻（上下文当缓存）与临时（按票） | superagent worker + Tobs 常驻 |
| Ticket | 一件被受理的事的工单；临时 worker 按票命名 | superagent ticket `[SA] core/model.ts` |
| Thread | 一个话题线程（人消息话题 / Topic 订阅），订阅直通的挂点 | superagent thread |
| Message | bus 上的一条结构化消息（tell/ask/publish/escalate） | Mesh 新增 |
| Gate | 强制过闸的咨询：挂起票直到持有者 approve/reject | 裁决 4 配套，Mesh 新增 |
| Coalition | 临时小群：成员 + 剧本 + 预算 + deadline | Mesh 新增（反 Tobs 全员群） |
| Directory | offers 静态注册表 + needs 两级匹配 | 裁决 4，Mesh 新增 |
| Effects/Pass | 持久副作用队列 + 2s 推进循环 | superagent `[SA] app/effects.ts, passes.ts` |

### 1.3 构件映射：抄什么、改什么、新增什么

| Mesh 构件 | 直抄 [SA] | 改造 | 新增 |
| --- | --- | --- | --- |
| Store/atomic/迁移 | store.ts:58-162 模式（WAL+FULL、0600、savepoint、afterCommit、kv 存 schema 版本） | 表集合换成 Mesh（§3.2） | — |
| Effects | effects.ts 全套（Later 语义、generation、退避、health） | kind 注册表换 Mesh 集合（§4.1） | — |
| Passes | passes.ts（2s interval + receive 即踢 + coalescing + pumpOnce 两步） | pumpOnce 加 budget 检查（§4.2） | — |
| Sessions | sessions.ts:138-155（resolveAgent→create→decorate→permission→rename）、124-131 preset 重选守卫、162-167 prompt 三态 | master 固定为 mesh 主会话；worker 命名规则分常驻/临时 | — |
| DshExecutor | dsh.ts 骨架（worker-<ticketId>、capped/read、PREPARE_TIMEOUT、瞬时退避、槽位） | worktree 改为 mesh workspace 目录 | — |
| Ticket 状态机 | 四 outcome、followsDone、unfinished、复活语义（design.md §8） | follows 绑定从 PR 换成 mesh thread/topic | — |
| Router 工具面 | orchestrator_route/eval*/ticket_* 的 shape（§5.3） | 换 mesh_ 前缀 + 群/门工具 | — |
| Worker 工具面 | report/ack 的 shape（§6.3） | — | ask/tell/publish/subscribe/gate_decide |
| MessageBus | — | — | §7 全新 |
| Directory | — | — | §8.1-8.2 全新（v2：两级，R12） |
| Coalition | — | — | §8.3-8.5 全新（v2：剧本可选，R13） |
| Gate | — | — | §7.2 全新（v2：含死锁三规则，R9） |
| Budget | — | usage 事件接线抄 `[DSH]`（tokenMeter 已存在） | 预算动作 §9（v2：批量写，R8） |
| Watchdog | superagent 的 Watchdog 思路（日常 profile 定时任务） | 跨平台用 schedule 插件 | §11 |

### 1.4 目录拓扑（bundle 仓库）

```
mesh-bundle/
├── package.json               # dsh.bundle 字段 + engines.dsh（§2.2）
├── cordis.patch.yml            # mesh-router / mesh-worker 两个 preset（§2.3）
├── src/
│   ├── index.ts               # 插件入口：装配 Store/Effects/Passes/Engine/Sessions/Watchdog
│   ├── core/                  # 域逻辑，零 DSH 依赖，可全量单测
│   │   ├── model.ts           # 领域类型 + zod schema（§3.3）
│   │   ├── store.ts           # SQLite + atomic + afterCommit + 迁移（§3.1）
│   │   ├── effects.ts         # 副作用队列（§4.1）
│   │   ├── passes.ts          # 时钟 + 串行化（§4.2）
│   │   ├── engine.ts          # 唯一事务入口，组合 9 个域模块（§4.3）
│   │   ├── intake.ts          # 进站分类（§5.1）
│   │   ├── evals.ts           # Router 评估调度（§5.2）
│   │   ├── tickets.ts         # 票状态机（§10）
│   │   ├── assignments.ts     # 派发（§5.4）
│   │   ├── bus.ts             # 消息匹配/投递/TTL（§7）
│   │   ├── directory.ts        # offers + needs 两级匹配（§8.2）
│   │   ├── coalitions.ts      # 群状态机 + 剧本步进（§8.3）
│   │   ├── gates.ts           # 咨询协议状态机（§7.2）
│   │   └── budget.ts          # usage 聚合 + 预算动作（§9）
│   ├── app/                   # DSH 接线层（core 之外的世界只允许出现在这里）
│   │   ├── sessions.ts        # session 生命周期 + 工具注册 + 投递（§5.4）
│   │   ├── tools/
│   │   │   ├── main.ts        # Router 工具（§5.3）
│   │   │   ├── executor.ts    # Worker 工具（§6.3）
│   │   │   └── tool.ts        # tool() 包装：zod→JSON schema + JSON 渲染
│   │   ├── assessment.ts      # 候选卡 → 主会话（§5.2）
│   │   ├── prompts.ts         # prompt 组装（§6.2）
│   │   ├── resources.ts       # read 资源分页（§6.4）
│   │   ├── http.ts            # 状态 API（§11.2）
│   │   └── cards.ts           # 卡片视图
│   └── executor/dsh.ts        # WorkerExecutor（会话拉起/投递/重试/槽位，§6.4）
├── test/                      # vitest；core/* 全量单测，app/* 用假 Context
└── docs/
```

分层纪律：`core/` 不 import `@deepseek-ai/cordis` / `@deepseek-ai/dsh-agent`；所有 DSH API 触碰限制在 `app/` 与 `executor/`。`[TB]` 的 CLI parity 纪律收窄版：每个 Engine 公开方法必须有 vitest 覆盖（无 UI 无模型可测）。

## 2. 工程结构

### 2.1 package.json

```jsonc
{
  "name": "mesh-bundle",
  "version": "0.1.0",
  "type": "module",
  // ⚠ v2（R7）：不要写 ">=0.2.2-rc.1"。SemVer 预发布规则：X.Y.Z-pre 只在 range 里存在
  // 同一 [X,Y,Z] 元组的预发布比较符时才被接纳。所以 ">=0.2.2-rc.1" 接受 0.2.2-rc.2，
  // 但【拒绝 0.2.3-rc.1】——下一个 rc 就装不上。钉死 minor，每次 DSH 发新 rc 手动抬。
  "engines": { "dsh": ">=0.2.2-rc.2 <0.2.3" },
  "files": ["cordis.patch.yml", "lib"],          // bundle 声明文件必须包含 cordis.patch.yml [DSH] publish.md:26-44
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" }  // patch 可为有序数组，相对路径逐文件解析
  },
  "dependencies": { "zod": "^3.x" },
  "peerDependencies": { "@deepseek-ai/dsh": ">=0.2.2-rc.2 <0.2.3" },   // peer 声明同时放 peer+dev [DSH] publish.md:105
  "devDependencies": { "@deepseek-ai/dsh": ">=0.2.2-rc.2 <0.2.3" }
}
```

TypeScript ESM；**Node ≥ 24.9.0**（DSH 本体 engines 要求；`node:sqlite` 直接 `import { DatabaseSync } from 'node:sqlite'`——superagent 同款，零运行时依赖）。构建产出 ESM + dts，入口 `.`→lib/index.js。

### 2.2 cordis.patch.yml（v2 全文重写 —— R1/R2）

> **v1 这里是错的，两个阻塞级缺陷。** 保留错误形态作为反例，因为它是很容易犯的错：
>
> ```yaml
> # ❌ 反例：v1 的写法（装上去是空壳）
> - id: mesh-engine          # 顶层 row → 被当成"覆盖已有 row"的补丁
>   name: mesh-engine        # 全新 profile 没这个 id → unknown target → 警告后跳过
> - name: '@deepseek-ai/dsh-agent-preset'
>   config:
>     plugins:
>       - { name: dsh-shell, group: true }   # dsh-shell 是服务不是工具 → 没有 shell
> ```
>
> 判据（三条独立证据）：
> 1. `[DSH] docs/user/develop/basic/publish.md:37-44` —— bundle 示例就是 `- insert:` 包裹；
> 2. `[SA] cordis.patch.yml:4` —— 全文 193 行**只有第 4 行一个顶层元素 `- insert:`**，其余全部缩进；
> 3. `[DSH] packages/boot/app-boot/src/config-schema/document.ts:29` —— "**Unknown targets and non-insert patches without a nonempty id are warned and skipped**"。
>
> `--dump-config` 只往 stderr 打一行 warning（`apps/cli/reference/README.md:35`），极易漏看。**M0 的第一件事就是用 `--dump-config` 确认 mesh-engine 出现在合成结果里。**

```yaml
# —— 结构：整个 bundle 层是一个【单元素数组】，元素为 {insert: [...]} ——
# 加载序：dsh.profile.bundles 各 patch → profile 自身 patch → $DSH_HOME patch → --patch；
# 后层【整对象替换】前层 row 的 config（非深合并），所以覆盖时要把每个 key 都重写。
- insert:
    # —— Engine 插件：顶层 row，根级 listener 收全部 session 的事件 ——
    # （session/event 是 scope-filtered 事件；根级未打 scope tag 的 listener 收全部，
    #   打 tag 的只收该 key 及其后代。Engine 在 bundle 根插件里注册，故天然收全部 worker 事件。
    #   证据：[DSH] packages/core/scope/README.md「Event filtering」节）
    - id: mesh-engine
      name: mesh-bundle                # 发布后为包名；开发期可用绝对路径 '/…/src/index.ts'
      config:
        stateDir: ~/.dsh/state/mesh
        pass: { intervalMs: 2000 }
        executor:
          maxWorkers: 4                # v2（R5）：常驻 2 + 临时 2，见 §5.4
          residentWorkers: 2           # researcher + coder 常驻；reviewer/ops 按需
          tempSlots: 2
          prepareTimeoutMs: 600000
        budget: { coalitionSoft: 0.8 }
        coalitions: { inferredBlocking: false }   # 裁决 6：inferred 群默认通知不阻塞
        eval: { model: <轻模型>, timeoutMs: 300000 }

    # —— preset 定义（铁律 5）。name 固定 '@deepseek-ai/dsh-agent-preset'，
    #    config 即 PresetDefinition（[DSH] api-catalog.ts:8149-8151）。
    #    工具白名单 = plugins 数组里行的增删；preset row 不可删，
    #    删则历史 session resume 报 agent-preset/not-found ——
    - id: mesh-router-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: mesh-router
        name: Mesh Router
        description: Mesh 的调度面，不供手动选择。无 shell、无文件写，只含路由与评估工具。
        order: 90
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: 'You are the Router of a Mesh of coding agents. You route and assess; you never do the work.' }
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config: { maxBytes: 65536 }
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
            config: { write: false, edit: false }    # 只读：靠 config 收窄，不是靠删行
          # 铁律 2：无 shell / 无 subagent / 无 web —— 不写行即无工具（v2 主动偏离，见 §0.3）

    # —— Worker preset：真实结构照抄 [SA] cordis.patch.yml:20-120 ——
    - id: mesh-worker-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: mesh-worker
        name: Mesh Worker
        description: Mesh 的执行器 Session 专用，不供手动选择。前台命令超 5 秒转入后台。
        order: 91
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config: { prefix: 'You are a coding agent powered by the {{model}} model.' }
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config: { maxBytes: 65536 }
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'

          # —— shell group：name 必须是 cordis:group，工具在子行里（R2 的核心）——
          - id: shell
            name: cordis:group
            group: true
            isolate:
              shell: true
            config:
              - id: bash-sandbox
                name: '@deepseek-ai/dsh-bash-sandbox'
                disabled: !!js process.platform === 'win32'
                config: { timeoutMs: 5000, maxTimeoutMs: 5000 }
              - id: pwsh-sandbox
                name: '@deepseek-ai/dsh-pwsh-sandbox'
                disabled: !!js process.platform !== 'win32'
                config: { timeoutMs: 5000, maxTimeoutMs: 5000 }
              - id: tool-bash
                name: '@deepseek-ai/dsh-tool-bash'
                disabled: !!js process.platform === 'win32'
              - id: tool-pwsh
                name: '@deepseek-ai/dsh-tool-pwsh'
                disabled: !!js process.platform !== 'win32'

          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
            config: { waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'

          # —— compaction group：同样是 cordis:group + 子行 ——
          - id: compaction
            name: cordis:group
            group: true
            isolate:
              compaction: true
              toolResultPruner: true
            config:
              - id: compaction-basic
                name: '@deepseek-ai/dsh-compaction-basic'
              - id: command-compact
                name: '@deepseek-ai/dsh-command-compact'
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }

          # —— subagent group：worker 内允许再嵌 subagent（两层并发不冲突）——
          - id: subagent
            name: cordis:group
            group: true
            config:
              - id: tool-subagent-control
                name: '@deepseek-ai/dsh-tool-subagent-control'
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'

          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
```

要点（v2 修订后）：

- **`insert` 是硬要求**：整个文件是一个数组，唯一元素是 `{ insert: [...] }`。不是"可选写法"。
- **group 行 `name: cordis:group`**：`dsh-shell` / `dsh-compaction` 是服务；写它们作为 row 只会挂载服务而不挂载工具。工具在子行（`dsh-tool-bash` 等）。
- **平台二选一用 `!!js`**：`disabled: !!js process.platform === 'win32'` 是 `[SA]` 的原样用法（`cordis.patch.yml:50, 56`），跨平台必需。
- **mesh 工具不进 preset**：`mesh_route` / `mesh_report` 等由 Engine 运行时按角色装饰（`agent.ctx.tools.register`，zod→JSON schema，`[SA]` sessions.ts registerTool）；preset 只定义平台工具面。
- **模型不进 preset**：模型选型是 session-local（§5.4 `initializeRoleModel`），preset 只管工具与隔离。
- **权限不进 preset**：`ctx.permissionPresets.set(session, …)` 运行时设置（§5.4）。
- **peer 声明**：`@deepseek-ai/dsh` 同时进 peerDependencies + devDependencies（`publish.md:105`）。

**开工验证（M0 第一件事，半天内）**：

```bash
dsh plugin --profile mesh add "link:$PWD"
dsh --profile mesh --dump-config | grep -c mesh-engine    # 必须 ≥1，否则 patch 语法错
dsh --profile mesh --dump-config 2>&1 >/dev/null | grep -i "unknown\|skipped"   # 必须为空
```

第二条命令是关键：**patch 静默跳过是这个项目最容易踩且最贵的坑**——它不报错，只是什么都不加载。

安装（专用 profile，与日常 profile 隔离）：

```bash
dsh mesh --from-default-profile web --dump-config > /dev/null   # 建 mesh profile
dsh plugin --profile mesh add "link:$PWD"                        # 装 bundle（标准 dsh plugin 命令）
```

### 2.3 profile 隔离

与 superagent 同理 [SA] docs/006-deployment.md:79-85：mesh bundle 改进程级状态（stateDir、schedule 任务），必须与日常 profile 隔离；主会话、全部 worker session 都活在 mesh profile 里。

## 3. 数据层（SQLite 单库）

### 3.1 打开流程与事务模型 `[SA] store.ts:58-162 直抄`

- `new DatabaseSync(path)` → `chmod 0600` → `PRAGMA journal_mode=WAL; synchronous=FULL`；
- 建表在一个原子事务内（§3.2 全部 DDL）；
- `SCHEMA_VERSION = 1`（首发），`OLDEST_SCHEMA = 1`；版本存 `kv` 表，`migrate()` 钩子保留扩展位（superagent 已到 11，证明这个迁移模式扛得住演进）；
- `atomic(fn)`：savepoint 嵌套 + commit 后回调队列 `afterCommit`（回滚即丢弃）——**Engine 所有命令必须在 atomic 内跑**，副作用 enqueue 与状态变更同事务，崩溃后由 effect 表恢复一致；
- 每张域表 = 主键 + `value` JSON（域对象整体序列化）+ 少量排序列；需要索引的域字段用**生成列 + 部分索引**（`ON t(col) WHERE col IS NOT NULL`）。

### 3.2 全库 DDL

```sql
-- 通用键值：schema 版本 / settings 快照 / revision 计数
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 持久副作用队列（§4.1；语义照抄 [SA] effects.ts，kind 集合见 §4.1 表）
CREATE TABLE effect (
  kind TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
  seq INTEGER NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
  due INTEGER NOT NULL, since TEXT NOT NULL,
  PRIMARY KEY (kind, key)
);
CREATE INDEX effect_due ON effect(kind, due, seq);

-- 话题线程：pending 队列 / evaluating / subscriptions / correlated
CREATE TABLE thread (key TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 工单：spec(dispatch 工件) / assignments / inputs / undelivered / origin / ended
CREATE TABLE ticket (id TEXT PRIMARY KEY, value TEXT NOT NULL);

-- bus 消息（Mesh 新增；value 见 §3.3 MessageSchema）
CREATE TABLE message (id TEXT PRIMARY KEY, seq INTEGER NOT NULL, value TEXT NOT NULL);

-- worker 注册（常驻开工注册；临时拉起时注册、结束时注销）
CREATE TABLE worker (id TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 临时群：成员/剧本/预算/状态
CREATE TABLE coalition (id TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 咨询闸（Mesh 新增）
CREATE TABLE gate (id TEXT PRIMARY KEY, value TEXT NOT NULL);

-- 审计：追加式，只 INSERT（裁决 3/4 的追溯载体）
CREATE TABLE audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL,
  actor TEXT NOT NULL, kind TEXT NOT NULL, value TEXT NOT NULL
);

-- token 计量聚合（§9.1；scope ∈ ticket|coalition|worker|system）
CREATE TABLE usage (
  scope TEXT NOT NULL, scope_id TEXT NOT NULL, session_id TEXT NOT NULL,
  value TEXT NOT NULL,                      -- {input,output,cacheRead,cacheWrite,total} 累计
  PRIMARY KEY (scope, scope_id, session_id)
);

-- —— 生成列 + 部分索引（先 DROP 再 ADD + 建部分索引，[SA] store.ts:103-118 reconcile 模式）——
-- ticket.open  = (json_extract(value,'$.ended') IS NULL)
-- ticket.active = (undelivered 非空 OR 最新 assignment.state IN ('pending','running'))
-- thread.active = (pending 非空 OR evaluating 非空)
-- message.pending = (state = 'pending')           -- 未投递消息扫描
-- coalition.open = (state NOT IN ('dissolved','archived'))
-- gate.open = (state = 'pending')
-- 对应部分索引：CREATE INDEX <t>_<col> ON <t>(<col>) WHERE <col> IS NOT NULL;
```

### 3.3 域对象 schema（zod，core/model.ts）
```ts
// Ticket —— 照抄 [SA] core/model.ts 票结构，follows 从 PR 换成 thread
interface Ticket {
  id: string; title: string;
  spec: DispatchArtifact;                 // §5.2 dispatch 工件（含轮转剧本 + gate 清单）
  origin: { triggerIds: string[]; human: boolean };
  mandate: 'explicit' | 'inferred';       // §8.1：inferred 预算减半
  assignments: Assignment[];              // 重试换人 = 新 Assignment，票不变
  inputs: Input[]; undelivered: string[];  // 人追加 → undelivered 排队
  follows: string[];                      // 订阅的 thread key（直通挂点）
  gates: string[];                        // 本票 gate id 清单（worker 不可删）
  ended?: { at: string; by: string; outcome: 'completed'|'dropped'|'merged'|'closed'|'stopped' };
}

interface Assignment { id: string; workerId: string; state: 'pending'|'running'|'idle'|'ended';
  startedAt: string; note?: string }

// Message —— Mesh 新增
interface Message {
  id: string; seq: number;
  from: string; to?: string;              // worker id 或 topic
  thread: string;                         // 挂靠线程（直通判定）
  type: 'tell'|'ask'|'publish'|'escalate'|'report'|'needs'|'gate';
  body: string;                           // ≤1500 字符，超长 capped+read 路径（§6.4）
  summary?: string;                       // 合并摘要（token 经济物理载体）
  ttl?: number;                           // publish 默认 3 轮
  refs?: string[];                        // 资源路径
  needs?: { text: string; urgency: 'advisory'|'blocking' };   // needs 求助（裁决 4）
  gate?: { gateId: string; blocking: boolean };               // gate 求助（§7.2）
  state: 'pending'|'delivered'|'archived'|'dropped';
  at: string;
}

// Worker —— offers 静态（裁决 4）
interface Worker {
  id: string;                            // mesh-researcher-1 / mesh-temp-<ticketId>
  kind: 'researcher'|'coder'|'reviewer'|'ops'|'temp';
  sessionId: string; status: 'starting'|'idle'|'busy'|'stopped';
  offers: Offer[];                        // preset 来源，人写，零漂移
  resident: boolean;                      // 常驻 vs 按票
}

interface Offer { keywords: string[] }   // §8.2 两级匹配料（v2 删掉 tags/embKey，R12）

// Coalition —— Mesh 新增
interface Coalition {
  id: string; topic: string; memberIds: string[]; leadId: string;
  mandate: 'explicit'|'inferred';         // §5.3 建群授权两型
  budget: { tokens: number; used: number };
  deadline: string; state: 'proposed'|'approved'|'round'|'merging'|'dissolved'|'archived';
  script: RoundScript[]; round: number;   // §8.4 剧本；【v2/R13：允许为空数组】
  outputs: { round: number; speaker: string; summary: string }[];
}

// Gate —— Mesh 新增
interface Gate {
  id: string; ticketId: string; fromWorker: string; toWorker: string;
  question: string; state: 'pending'|'approved'|'rejected'|'escalated';
  deadline: string; decision?: { at: string; alternative?: string; note?: string };
  // v2（R9）：死锁防护所需的三个字段
  depth: number;                          // 本 gate 在依赖链上的深度，超 MAX_GATE_DEPTH=3 直接 escalate
  blocksGateId?: string;                  // 谁在等本 gate（环检测：不得回指祖先）
  escalationTarget?: string;              // 超时升级目标（必须是强模型 reviewer 且未参与本票）
}
```

### 3.4 常驻 worker 的上下文经济学（v2 修订 —— R6）

v1 §3.3 并列了两句互斥的话：「常驻 = 上下文当缓存」和「压缩是原生的」。这两件事不能同时成立，必须分开说：

| 机制 | 对 prompt 前缀的影响 | 缓存后果 | 结论 |
| --- | --- | --- | --- |
| **每票再定向 note**（§6.4） | **append**（追加在末尾） | 前缀不变 → **cache hit 保留** | ✅ 这才是"缓存复用"的真实来源 |
| **DSH 原生压缩** | **重写 surface**（改写 model-visible 上下文） | 前缀变化 → **一次全量 cache miss** | ⚠️ 必须显式接受，不能假装免费 |
| Watchdog 巡检 | 不触碰 worker 上下文（只读 Engine 表） | 无影响 | ✅ |

**因此把"常驻 = 缓存"降级为准确表述：**

> **常驻 = 避免冷启动重扫**（worker 保留 repo 认知、工具习惯、失败教训），**不承诺 token 缓存命中**。缓存命中是"再定向 note 是 append"这个设计的副产品，不是常驻本身的性质。

**压缩后重新预热的纪律**（v2 新增）：

- 压缩发生的下一个 turn，Engine 检测到 surface 收缩（`ctx.tokenMeter.measure(session).surfaceTokens` 突降）→ 在投递首条消息时**额外附带一份精简再定向 note**（比常规 note 多两行：当前票目标 + 上一票结论一句话）；
- 不为压缩做任何"补偿性全量重读"——那是拿 token 换虚假的安全感。

### 3.5 数据模型只有一份权威（v2 修订 —— R11）

**v1 的 `mesh-bundle-design.md` §7 有一份关系型 DDL（`tickets(id, thread_id, spec_json, …)`），与本文 §3.2 的 JSON 列式不兼容。那份是废弃稿。**

**权威定义 = 本文 §3.2 + §3.3**：每张域表 = 主键 + `value TEXT`（域对象整体 zod 序列化）+ 少量排序列；需要索引的域字段用**生成列 + 部分索引**（`ON t(col) WHERE col IS NOT NULL`，照抄 `[SA] store.ts:103-118` 的 reconcile 模式）。

理由：域对象是嵌套结构（ticket 里嵌 assignments / inputs / gates），关系型要拆 5 张表 + 手写 join，而 Mesh 的读路径几乎都是"按 id 取整个聚合"——JSON 列 + 生成列索引在正确性上更简单，在查询上够用（唯一的聚合查询是 usage 汇总，它本来就是扁平的）。

摘要文档已同步改为指向本节。

## 4. 运行时：Effects + Passes + Engine

### 4.1 Effects 队列（`core/effects.ts`，161 行语义照抄 `[SA] app/effects.ts`）

**机制**：副作用在命令事务内持久化进 `effect` 表，commit 后由 dispatch 分发。这是「崩溃安全」的根基——状态变更与副作用意图同事务，进程崩了 effect 行还在，重启后续跑。

- `Later` 错误 = 暂不能跑（槽满 / 目标 session 忙）→ 重排 `due = now + retry[0]`，**不增失败计数**；真失败 `attempts+1` 指数退避 `retry[1]` 封顶 `2^min(attempts,16)` 乘；`FAILURES_BEFORE_ERROR = 3` 后标 error。
- `enqueue` 用 `ON CONFLICT(kind,key) DO UPDATE value/generation+1/attempts=0`——同 key 新副作用覆盖旧的并保 seq 队位；`ordered: true` 的 kind 严格按 seq 一次一条，旧行未到期也阻塞后续。
- dispatch 每轮最多取 `16 + running.size` 行（`due <= now`）；attempt 成功删行时 match `seq+generation` 防误删新行；停机 drain 留运行行下次重试；health 每类汇报 waiting/attempts/error，`quiet` 类失败不标 error。

**Mesh 的 kind 注册表**：

| kind | payload | handler 行为 | limit | retry | ordered |
| --- | --- | --- | --- | --- | --- |
| `assess` | `{threadKey, evalId, candidate}` | 候选卡投主会话（`prompt(masterId, …, 'steer')`）触发 Router 评估 | 1 | [5s, 60s] | ✓ |
| `launch` | `{ticketId, assignmentId}` | `sessions.ensure` + 首条 assignment 消息（§6.4） | 空闲槽位数 [SA] dsh.ts:232 | [5s, 300s] | |
| `deliver` | `{ticketId, inputId}` | worker `prompt(…, 'steer')` | 4, quiet [SA] dsh.ts:235 | [5s, 300s] | |
| `coalition` | `{coalitionId, round}` | 群剧本步进（§8.4：取 speaker → 投轮次问题） | 每 coalition 1（key=coalitionId） | [5s, 60s] | |
| `relay` | `{text}` | 主会话 steer 中继 [SA] sessions.ts:104 | 1 | [5s, 300s] | ✓ |
| `notice` | `{name, value, summary}` | 主会话 inject（不唤醒）[SA] sessions.ts:105 | 1 | [5s, 60s] | ✓ |
| `sweep` | `{what: 'ttl'\|'gates'\|'budget'}` | §7.4 TTL 归档 / §7.2 gate 超时+环检测 / §9 预算降级 | 各 1 | [5s, 60s] | |

### 4.2 Passes（`core/passes.ts`，69 行语义照抄 `[SA] app/passes.ts`）

- 触发：① `start()` 起 `setInterval(2000)`；② `Passes.receive()` 在新工作到达时立即 `request()` 一轮（Engine 命令返回 `'stored'` 才踢）。
- 合并：`pump()` 若已有 pump 在跑，并发调用合并进一次后续 pass（同刻至多一轮 + 至多一轮排队）。
- 每轮 `pumpOnce()`：守卫（`!configured() || closing()` 直接返回）→ ① `effects.kick()` → ② `engine.evaluateDue()`（推进 Router 评估）→ ③ **`budget.checkAll()`**（Mesh 增补：每轮核账，§9.2）。Pass 本身仍只做「时钟 + 串行化」，零业务逻辑。
- 失败 → health error；恢复 → ready。`idle()` 等 pump + effects 全落定。

### 4.3 Engine（`core/engine.ts`，唯一事务入口 `[SA] core/engine.ts` 结构照抄）

每个公开方法包 `repo.atomic(...)`；组合 9 个域模块，调用方（工具层/executor/HTTP）拿 role-scoped `Pick` 接口：

```ts
class Engine {
  constructor(private repo: Store, parts: {
    intake: Intake; evals: Evals; tickets: Tickets; assignments: Assignments;
    bus: Bus; directory: Directory; coalitions: Coalitions; gates: Gates; budget: Budget;
  }) {}
  // 进站（人消息 / worker 消息 / 定时任务消息统一入口）
  receive(msg: Incoming): 'stored' | 'duplicate' | 'filtered'
  // Router 评估（候选 → 主会话；决策回传见 mesh_route/mesh_eval_decide）
  decide(triggerId: string, outcome: DecisionOutcome): Decision
  candidate(key: string): Candidate | undefined
  // 票
  create(spec: DispatchArtifact, origin: Origin): Ticket
  report(ticketId: string, report: WorkerReport): Ticket
  retryTicket(id: string): Ticket          // RETRIED：新 Assignment，同 session [SA] dsh.ts:136
  note(ticketId: string, text: string): void
  // bus / 协作
  tell(from, to, body, refs?): void
  ask(from, to, question, opts: { ttlMin?, gate? }): string  // gate:true → §7.2 挂起
  publish(from, topic, summary, detailRef): void
  subscribe(ticketId | workerId, thread): void
  // needs → Directory 两级匹配（裁决 4，v2/R12）
  needs(from: WorkerId, needs: NeedsText): { matched: WorkerId | undefined; deferred: boolean }
  // 群 / 预算 / 审计读
  proposeCoalition(...): Coalition; approveCoalition(id): Coalition   // 裁决 6：inferred 通知不阻塞
  usage(scope, id): UsageRow[]
}
```

域模块间禁止互调（只经 Engine 命令组合）——保持每条命令一个事务、一个审计行。

### 4.4 延迟预算（v2 新增 —— R4）

**这是 v1 完全缺失的一节，也是 Mesh 与 superagent 最大的场景差异。**

`[SA] passes.ts` 的 `setInterval(2000)` 是给 GitHub issue bot 用的——分钟级异步，2 秒无所谓。但 Mesh 的目标场景是**人坐在主会话前面等**。不设预算就会出现"每步都只慢 2 秒，加起来一次协作 30 秒"的情况。

**每条路径的轮询跳数**（跳 = 需要等一次 pass 或一次 effect 重试）：

| 路径 | 轮询跳数 | 主导成本 | 目标上界 |
| --- | --- | --- | --- |
| 人消息 → 直通投递（订阅命中） | **0**（`receive` 即踢） | 无 LLM | **< 200ms** |
| 人消息 → Router 评估 → 建票 → worker 收到 | 2 | 2×LLM turn + session ensure | **< 15s** |
| worker `report` → 主会话 notice | 1 | 无 LLM（inject 不唤醒） | **< 3s** |
| worker `ask` advisory 往返 | 2 | 1×LLM（对方答） | **< 20s** |
| worker `ask` gate 往返 | 2 + 挂起 | 1×LLM + 恢复 | **< 60s** |
| coalition 一轮 | 1 | 1×LLM/发言者 | 每轮 < 30s |

**由此推出的三条硬约束：**

1. **交互路径必须"receive 即踢"**：`receive`/`decide`/`report` 返回 `'stored'` 后必须 `passes.request()`。v1 只把这条写成"优化项"，v2 升为**必需项**——没有它，上表每个数字都 +2s。
2. **`pass.intervalMs` 是兜底，不是节拍**：2s 只用于兜住"漏踢"和定时 sweep。任何依赖 2s 节拍做正确性保证的设计都是错的。
3. **禁止在 pass 里做 LLM 调用**：pass 是同步推进 + enqueue effect；所有 LLM 都走 effect（`assess`/`relay`/`deliver`），否则一轮 pass 会被 LLM 延迟拖住，后续所有路径全部排队。

**可观测**：`GET /mesh/api/state` 暴露 `pass.lastAt` / `pass.pending` / `effect.waiting`（§11.2）。若 `effect.waiting` 持续 > 10 而 `pass.lastAt` 正常，说明有 effect 卡在 `Later`（槽满/目标忙），不是轮询问题——这两个信号必须分开看，否则会误调 `intervalMs`。

**不做什么**：不引入 WebSocket / 事件推送 / 第二传输。延迟靠"即时踢 + effect 而非轮询"，不靠换通信机制。

## 5. 调度：双通道 + Router 工具面

### 5.1 Intake：进站分类（`core/intake.ts`，流程照抄 `[SA] intake.ts:19-62`）

任何进站消息（主会话人消息、worker 工具产出、定时任务）单事务内五步：

1. 时间戳归一；重复 → `'duplicate'`（幂等）。
2. `scope.scope()` 判定归属线程；无归属且无人订阅 → 存 + filtered disposition → `'filtered'`。
3. 遍历相关 threads：更新 `lastAt`/`correlated`；对每个 thread 的订阅票做 fanout——**只有人的消息可复活已结束票**（`human && ended.by !== 'human'`；`stopped` 票永不复活 [SA] model.ts:85）。
4. fanout 命中的票 `addInput`；**直通判定（双通道的快通道）**：消息 thread 有活跃票/订阅 worker → 直接 `deliver` effect 投递，**0 推理 0 token**。
5. 无人认领的消息（含 worker 的 needs/escalate 产物）→ `queueForEval` 进 thread pending，等 Router 评估。

### 5.2 慢速通道：Router 评估（`core/evals.ts` + `app/assessment.ts`，流程照抄 `[SA] evals.ts:71-118` + `assessment.ts`）

- thread 有 pending 且无 evaluating 时 `Evals.start`：选最强 strength 消息作 actor/basis（人消息 > worker 显式 > 推断）；写 `thread.evaluating = {id, triggerIds, primary, strength, startedAt, deadline}`，清空 pending；`effects.enqueue('assess', …)` 把候选卡投给主会话。
- **`deadline = startedAt + eval.timeoutMs`；交付后才计时**；过期重排队至多 `REQUEUES = 2` 次后记 unavailable [SA] evals.ts:19, 60-69。
- Router（主会话模型）收到候选卡后调 `mesh_route`（explicit）或 `mesh_eval_decide`（inferred 候选）回传决策——**工具调用就是回传通道**，无需第二传输 [SA] tools/main.ts:126-222。
- accept → `Tickets.create(spec)`：Router 的输出就是 **dispatch 工件**（结构化建票），这是 Mesh 慢速通道与 superagent 的唯一实质差异点（superagent 的 dispatch 只有 title/scope；Mesh 附带剧本与 gate 清单）。

**dispatch 工件 schema（`mesh_route` 的 `accept` 项 + `mesh_eval_decide` 共用）**：

```jsonc
{
  "title": "≤200 字符，原始请求的短标签",
  "worker_kind": "researcher | coder | reviewer | ops | temp",
  "goal": "目标一句话",
  "boundaries": ["边界，逐条"],
  "acceptance": ["验收标准，逐条"],
  "budget": { "tokens": 200000 },            // explicit 全额；inferred 自动减半（§8.1）
  "gates": [                                  // 裁决 4：必设闸清单，worker 不可删
    { "id": "ux-design", "holder_kind": "reviewer", "question": "…",
      "timeout_min": 30 }
  ],
  "coalition_script": [                       // 裁决 2：预写轮转剧本（建群时用，§8.4）
    { "speaker_kind": "researcher", "ask": "…", "schema": "结构化产出字段" }
  ],
  "routing_note": "≤NOTE_WORDS 路由备注，不含实现指示 [SA] tools/main.ts:17-19"
}
```

`mesh_route` 的批处理语义照抄 [SA]：一次调用最多 20 项、逐项独立执行、单项被拒不影响其余、`requestPass()` 收尾。

### 5.3 Router 工具面（`app/tools/main.ts`）

铁律 2 的落地——Router 全部工具，无一可干活：

> **v2 修正（R10）**：v1 声称"Router 无 Bash 是 superagent 同款、有意为之"。**这是错的**——`[SA] cordis.patch.yml:148-174` 的 router preset 里有完整 shell group（`bash-sandbox`/`pwsh-sandbox` + `tool-bash`/`tool-pwsh`，仅 `timeoutMs: 5000` 让前台命令 5 秒转后台）。superagent 保留 shell 的理由：它需要在主会话里跑 `git`/`gh` 做轻量状态查询。
>
> **Mesh 去掉 shell 是主动偏离，理由是**：① Router 每多一个工具就多一段 tool schema，而 Router 每票都要调用，工具面成本是**乘数**不是加数；② Mesh 的路由所需状态全在 Engine 的 `mesh_read` 资源里，不需要 shell；③ 调度面一旦能干活的诱惑太大，迟早会把活干在里面。
>
> **给后续实现者的警告**：发现 Router 没有 bash 不是 bug，别"补"上去。

| 工具 | 直抄 [SA] | Mesh 差异 |
| --- | --- | --- |
| `mesh_read` | orchestrator_read（资源分页） | 资源表见 §11.3 |
| `mesh_route` | orchestrator_route（批量 accept/attach/stop/ignore） | accept 产出 dispatch 工件（§5.2） |
| `mesh_eval` / `mesh_eval_read` / `mesh_eval_decide` | orchestrator_eval 三件套 | inferred 候选评估；approve 建群走 §5.2 工件 |
| `mesh_ticket_retry` | orchestrator_ticket_retry | — |
| `mesh_ticket_status` | orchestrator_ticket_request_status | — |
| `mesh_ticket_note` | orchestrator_ticket_note | — |
| `mesh_thread_unsubscribe` | orchestrator_thread_unsubscribe | — |
| `mesh_settings_save` / `mesh_prompts_save` | orchestrator_settings_save / prompts_save | — |
| `mesh_coalition_approve` | —（新） | inferred 建群确认 / 人直接建群入口 |
| `mesh_gate_escalate_decide` | —（新） | gate 超时 escalate 的人裁决入口 |

### 5.4 Worker 池与槽位（`app/sessions.ts` + `executor/dsh.ts`）

**Session 命名与生命周期**：

- 常驻：`mesh-<kind>-<seq>`（`mesh-researcher-1`）——开工注册、跨票复用、上下文当缓存；
- 临时：`mesh-temp-<ticketId>`——按票即焚（焚票不焚 session，§10）。

**`sessions.ensure(id, cwd, title, role)`** 照抄 [SA] sessions.ts:138-155：

```ts
let result = ctx.sessionController.resolveAgent(id)
if ('error' in result && result.error.code === 'session/not-found') {
  const workspace = await ctx.workspaceRegistry.create(cwd)
  await ctx.sessionController.create({ sessionId: id, workspaceId: workspace.id,
    agentPreset: 'mesh-worker' })        // preset 只在 create 时锁——铁律 5
  result = await ctx.sessionController.resolveAgent(id)
}
await initializeRoleModel(ctx, result.agent, settings.executor.model)
await decorate(result.agent)              // prompts + skills + 工具注册（§6.2/6.3）
ctx.permissionPresets.set(result.agent.session, permissionFor(role))  // worker 白名单
await ctx.sessionController.rename({ sessionId: id, title })
```

**`initializeRoleModel` 必须 session-local**（照抄 [SA] role-models.ts:8-43）：`agent.session.append('model/selection', selected)` + `ctx.llm.resolveCallConfig({provider, model, reasoningEffort})` 注入首个请求 + `ctx.sessionPersistence.flush()`。**禁止 `sessionController.selectModel`**——它改的是全局默认模型（会写 profile），会污染用户日常会话；Mesh 的 Router/各 worker 模型是票内事实，不是全局偏好。

**preset 重选守卫**（必抄 [SA] sessions.ts:122-131）：DSH Web 在 session 首轮前可能给它选默认 preset——订阅 `agent-preset/selected`，发现非 mesh preset 立即改回，否则历史 session resume 失败。

**槽位（WorkerSlots）**：v1 直接照抄 `[SA] dsh.ts:171-199`「总数 = `executor.maxWorkers`（含常驻）」——**在 Mesh 的拓扑下跑不起来**（R5）：

- v1 §6.1 标了 **4 个常驻**（researcher/coder/reviewer/ops），而 `maxWorkers` 默认 **3** → 第 4 个永远排不上，第一个 `launch` 就卡在 `Later`；
- superagent 的槽位模型是"槽位 = 并发票数"，没有常驻概念；套到"常驻 + 临时"上语义就不匹配了。

**v2 拆成两类槽位**：

| 槽位 | 数量 | 谁占 | 语义 |
| --- | --- | --- | --- |
| `residentSlots` | `executor.residentWorkers`（默认 2） | 常驻 worker 的**启动与存活** | 常驻占用是**预留**，不参与票的排队；它们不跑票时也占着 |
| `tempSlots` | `executor.tempSlots`（默认 2） | 临时 worker 的 `launch` | 真正参与排队的并发票数 |

- 总并发上限 = `residentWorkers + tempSlots`（默认 4）；
- **常驻不占临时槽**：常驻 worker 接票时，它的 turn 计入"运行中"，但不占用 `tempSlots`（否则常驻越多、临时越少，与"常驻是为了省冷启动"的初衷相反）；
- **人消息 wake 仍允许超限 1 槽且永不排在新 launch 后**（`[SA] dsh.ts:192-195, 303-310` 照抄）；
- **默认只上 2 个常驻**（researcher + coder），reviewer/ops 按需拉起：每个常驻都是持续成本（session 存活 + 缓存预热 + Watchdog 巡检），没有证据表明 4 个常驻比 2 个常驻 + 按需更好。要加常驻，先看 §9 的 usage 表说话。

**投递三态** 照抄 `[SA] sessions.ts:162-167` `prompt(sessionId, requestId, text, mode)`：`'queue'`（下一轮）/ `'steer'`（当前轮插话）/ `{inject}`（不唤醒）；每 requestId 至多一次（幂等，重试安全）。

## 6. Worker 层

### 6.1 Worker 模板（平台 preset 共用一个，kind 差异在权限与 prompt）

**实现纪律**：全部 worker 共用 `mesh-worker` 一个 preset row（§2.2）——preset row 是历史 session resume 的硬依赖，**不可删、越少越好**；kind 差异不新开 preset，而由两层运行时收窄：

1. `ctx.permissionPresets.set(session, name)`（[DSH] api-catalog 2374-2415，resolve 为 PresetSpec{sandbox, approval}）——researcher/reviewer `read-only`、coder `workspace-write`、ops `danger-full-access`；
2. 角色纪律 prompt（§6.2 roleSection）——researcher 只读调研、reviewer 只裁决不改动；web/搜索类平台工具对 researcher 开放即用 preset 的 dsh-tool-web 行。

| kind | 模型 | 权限档（permissionPresets） | offers 关键词（样例，静态） | 常驻（v2/R5） |
| --- | --- | --- | --- | --- |
| researcher | 强 | read-only（+ web 搜索平台工具） | research, survey, api-docs, 竞品 | ✓（默认上） |
| coder | 强 | workspace-write + subagent | implement, refactor, debug, test | ✓（默认上） |
| reviewer | 强 | read-only | review, decision, gate, arbitration | ✗ 按需拉起（v2 改） |
| ops | 中 | danger-full-access（最小授权：仅 ops 类票） | deploy, env, ci, cleanup | ✗ 按需拉起（v2 改） |
| temp | 按票 | 按票（dispatch 工件定） | 按票 | ✗ |

> **v2 改动（R5）**：v1 把四个 kind 全标常驻，与 `maxWorkers: 3` 冲突（4 > 3，第一个 launch 就排不上）。现改为**默认 2 个常驻**（researcher + coder），reviewer/ops 按需拉起。理由不只是槽位：每个常驻都持续付三份成本（session 存活、缓存预热、Watchdog 巡检），而 reviewer/ops 的真实调用频次在设计里没有任何数据支撑。**要不要加常驻，等 §9 的 usage 表跑出数据再决定。**

mesh 协作件 = §6.3 的 worker 工具集（所有 worker 都有：report/read/ask/tell/publish/subscribe/gate_decide，Engine 运行时装饰，不走 preset）。reviewer 的工具面故意最小——它存在的意义就是「强模型只读裁决者」（裁决 3）。

### 6.2 Prompt 组装（`app/prompts.ts`，分层照抄 `[SA] prompts.ts` 的 TEAM_SECTIONS 模式）

```
workerPrompt =
  sharedPrompt            # 纪律：结构化产出 schema、求助协议（needs 怎么写）、
                          #       read 资源语法、gate 清单不可删、report 时机
  + roleSection(kind)     # 角色纪律（researcher 只读；coder 改动前过 gate …）
  + 票 spec               # dispatch 工件 JSON（goal/boundaries/acceptance/gates）
  + reOrientationNote     # 每票再定向（§6.5）
  + 资源语法卡            # read 路径表（§6.4）
```

- 修改走 `mesh_prompts_save`（revision 管理 + preview，照抄 [SA] tools/main.ts:278-301）；prompt 版本记录进 kv，session 按版本追溯。
- 常驻 worker 跨票复用 session 时，新票首条消息 = 完整 dispatch 工件 + 再定向 note（旧票上下文仍在——这就是缓存，但要定向）。

### 6.3 Worker 工具面（`app/tools/executor.ts`）

| 工具 | 直抄 [SA] executor.ts | Mesh 差异 |
| --- | --- | --- |
| `mesh_worker_read` | orchestrator_ack 同位的 read（票内资源分页） | 资源 §11.3 |
| `mesh_ack` | orchestrator_ack（确认收到，IM_WORDS 限） | 人消息在主会话——ack 落 notice |
| `mesh_report` | orchestrator_report（state: progress/ready/blocked/failed/dropped + human_action） | pr_number 换 thread follow 语义 |
| — | orchestrator_thread_unrelated/follow（退订/订阅线程） | 换 `mesh_subscribe`/`mesh_unsubscribe`（topic 制） |
| — | orchestrator_trigger_handback（超范围交回） | 换 `mesh_handback`（超 Mandate 报 dropped 而不是交回重估） |
| `mesh_tell` | —（新） | 单向：`{to, body ≤1500, refs?}` → Engine.tell |
| `mesh_ask` | —（新） | 咨询协议统一入口：`{to, question, ttl_min?, gate?: boolean}` → Engine.ask（§7.2）；needs 求助也走这（`to` 省略 → Directory 匹配） |
| `mesh_publish` | —（新） | `{topic, summary ≤300, detail_ref}` 只发摘要进群，明细写 spill |
| `mesh_gate_decide` | —（新） | gate 持有者答复：`{gate_id, decision: approve\|reject, alternative?, note?}` |

**`mesh_report` 是 worker 的唯一状态回传咽喉**——`state: 'dropped'` 携带理由即超 Mandate 报废（§8.1）；`'ready'` 带 result 进票；`'blocked'`/`'failed'` 带 human_action 触发主会话 notice（不唤醒 Router）。

### 6.4 worker 消息格式（`executor/dsh.ts`，照抄 `[SA]` 全套常量）

```ts
const ASSIGNMENT_CHARS = 1500, TRIGGER_CHARS = 600       // [SA] dsh.ts:113
const PREPARE_TIMEOUT_MS = 10 * 60_000                   // [SA] dsh.ts:28
const TRANSIENT_TRIES = 3, TRANSIENT_BACKOFF_MS = 15_000 // [SA] dsh.ts:29-30
const BACKGROUND_LIMIT_MS = 30 * 60_000                  // [SA] dsh.ts:33
const SLOT_WAIT_MS = 5_000
```

- **capped + read（Inline & Spill）**：超长内容截为 `{text: 前 N 字符+'…', chars: 总长, read: 资源路径}`；worker 凭 `read` 路径按需取全文 [SA] dsh.ts:115-116。Mesh 资源路径：`message/<id>`、`ticket/<id>/spec`、`thread/<key>/page?cursor=<>`、`coalition/<id>/transcript`、`coalition/<id>/round/<n>`、`usage/<scope>/<id>`、`workers`、`tickets`。
- **assignmentCard**（首条，`requestId = 'assignment:<ticketId>'`）：`{ticket_id, title, spec: dispatch工件, note: RETRIED?}`；后续同票消息 `requestId = 'assignment:<ticketId>:<inputId>'` 增量投递 [SA] dsh.ts:424-470。
- **RESUMED**（复活注入）：`"The person resumed this ticket. Do not repeat completed work."` [SA] dsh.ts:132-135；**RETRIED**（人重试）：`"The person retried this ticket. Continue from the workspace/git state; previous work is in the worktree."` [SA] dsh.ts:136。
- **每票再定向 note**（§3.3 卫生，Mesh 新增格式）：`{date, branch/HEAD, 本票边界, 与上票的差异提示}`——固定几十 token，冲掉常驻 worker 的陈旧信念。

### 6.5 崩溃恢复（照抄 `[SA]` retry-health 五件套）

1. 瞬时错误（网络类）指数退避重试 ×3；
2. effect 层退避 `[5000, 300_000]`，按 assignment 计数 [SA] dsh.ts:210-233；
3. worker session 被外部删除 → `sessions.ensure` 自动重建，票不丢 [SA] dsh.ts:313-316；
4. 投递失败记在票的 inputs 状态（`quiet: true` 不炸 pass）[SA] dsh.ts:234-235；
5. prepare 失败不自动重试：目录非空视为半成品，标 failed 等人 [SA] dsh.ts:277-283。

turn 结束后的后台 job/subagent 超 `BACKGROUND_LIMIT_MS` 被 kill 并下次 turn 告知（槽位语义的一部分）。

## 7. 通信协议（MessageBus）

### 7.1 消息语义（`core/bus.ts`）

| type | 发起 | 语义 | 投递 | LLM |
| --- | --- | --- | --- | --- |
| `tell` | worker→worker | 单向陈述 | Engine 直接 `deliver` 到目标 worker 的票输入 | 0 |
| `ask` | worker→worker | 问答，带 `ttl_min` 截止 | 同上；到期未答 → 降级或 escalate | 0（advisory）/ 挂起（gate） |
| `publish` | worker→topic | 摘要广播 | 订阅 worker 各收 `summary + detail_ref`；TTL 3 轮后归档 | 0 |
| `needs` | worker→Directory | 求助（裁决 4） | 两级匹配（§8.2）；匹配本身 0 token，未命中则 Router 兜底或 deferred | 第 2 级 Router |
| `escalate` | worker/程序 | 上抛（两级，§7.3） | — | Router 或 reviewer |
| `report` | worker→票 | 状态回传 | §6.3 | 0 |

**全部消息在事务内落 `message` 表后才投递**（audit 咽喉先于行动）；Engine 是唯一写者（铁律 1）。

### 7.2 咨询协议 gate 状态机（`core/gates.ts`，Mesh 新增）

```
worker A（coder）: mesh_ask {to: reviewer, question, gate: true}
  → Engine.gates.open(A→R)     票 A 当前 assignment 挂起（state: 'gated'）
  → gate 行 {state: pending, deadline = now + timeout_min}
  → deliver 给 R（R 的协作输入，非新票）
R 回 mesh_gate_decide:
  approve  → gate.closed{approved} → 票 A 恢复 running，audit 记「谁同意了什么」
  reject   → gate.closed{rejected, alternative} → A 收 alternative，按替代方案走
  超时     → sweep('gates') 发现 → escalate 两级之一（§7.3）
```

- gate 清单在 dispatch 工件里（Router 建票时决定哪些环节必设闸）；worker 的 spec 输入里 gate 项**不可删**（prompt 纪律 + Engine 校验：spec 变更只允许加不许减）。
- 审计：每次 open/approve/reject/escalate 各一行 audit。

**死锁防护（v2 新增 —— R9）**

v1 的 gate 机制没有解三个真实问题，v2 必须补：

| 问题 | v1 状态 | v2 规则 |
| --- | --- | --- |
| **互锁**：coder 挂起等 reviewer approve，而 reviewer 自己也被 gate 挂起 | 未处理 | **规则 A：持有者不可被挂起。** 若 `toWorker` 当前有 open 的 gate（作为发起方），Engine 拒绝开新 gate，直接 `escalate`（程序冲突）。理由：一个自己都在等的人不能给别人签字。 |
| **裁决循环**：gate 超时 escalate → 判为实质冲突 → 转 reviewer，而 reviewer 正是超时方 | 未处理 | **规则 B：升级目标不得参与本票。** `escalationTarget` 必须在建票时确定，且不得等于本票任何已出现过的 gate 持有者。违反则升级到"人"（主会话 notice），不再自动升级。 |
| **环检测被声称但未实现**：§7.3 把"循环依赖"列为程序冲突，但 `sweep('gates')` 只查 deadline | 未实现 | **规则 C：`sweep('gates')` 增加环检测。** `blocksGateId` 构成有向图；每轮 sweep 对 open gate 做 DFS，发现环 → 全部相关 gate 标 `escalated` + 审计记环路径 + 主会话 notice。`depth > MAX_GATE_DEPTH(3)` 直接 escalate（不等人超时）。 |

**同票并发闸上限**：一张票同一时刻至多 **1 个 open gate**。要串行的闸排队，不并行——并行的闸是互锁的温床，而"必须同时等两个人签字"在 Mesh 里没有真实场景（所有 worker 都是同模型，两个签字不比一个签字更可信）。

**为什么仍然保留 gate（尽管它贵）**：它不是为了让两个模型互相校验（那没用），而是为了**把"改方案"和"交付"这两个动作变成显式的、有审计的、不能偷偷做的**。这个价值来自"留痕 + 强制停顿"，不来自"更强的判断"。认清这一点，就不会指望 gate 提高质量——它提高的是可追溯性。

### 7.3 escalate 两级路由（裁决 3）

| 判定 | 升给谁 | 机制 |
| --- | --- | --- |
| **程序冲突**：死锁、预算超限、TTL 到期、gate 超时、剧本外情况、**检测到环**（§7.2 规则 C） | Router（轻模型） | `escalate` effect → 主会话候选卡；Router 用 `mesh_route` 类工具裁决，程序执行 |
| **实质冲突**：两个 worker 的技术分歧、方案争议 | reviewer（强模型只读） | Engine 建**裁决票**（kind=reviewer 的临时票），双方论点 + 产物 ref 进 spec；reviewer `mesh_report` 出裁决；Router 只执行其结论 |

裁决者永远不弱于被裁决者——reviewer 是强模型 + 只读，无法被拉拢也无利益。

> **v2 补丁（R9 规则 B）**：实质冲突的裁决者必须**未参与本票**。若本票唯一的 reviewer 已被 gate 占用或本身是争议方，则不自动升级，改为 `escalate` 到人（主会话 notice，`mesh_gate_escalate_decide` 工具接人裁决）。宁可慢一步，不要出现"自己审自己"的假裁决。

### 7.4 TTL 与归档

- `publish` 默认 3 轮 TTL（一轮 = 一条该 topic 消息被消费）；到期 `sweep('ttl')` → state: `archived`（body 留库可查，不再投递）。
- worker `mesh_unsubscribe` 退订：只影响后续投递，已投递消息与历史归档不受影响。
- 归档消息的 `summary` 保留——审计可读，重建上下文不重放 body。

## 8. Directory 与 Coalition

### 8.1 offers 注册（静态，裁决 4）

- 常驻 worker：bundle 启动时按 §6.1 模板表（代码内常量，kind + offers 关键词/标签）**开工注册**，永不漂移、零 token；
- 临时 worker：dispatch 工件指定 offers，`launch` 时随注册、票终注销；
- Directory 不存 needs——needs 随求助消息走 `messages.needs`（裁决 4：needs 天然只能运行时产生）。

### 8.2 needs 匹配（`core/directory.ts`，Mesh 新增，方向 needs → offers）

**v2 从"三级"降为"两级 + 显式降级"（R12）**——v1 的中间级（预计算语义标签）需要离线算 embedding，是**额外设施**，不是零成本；且它的命中率与关键词级高度重叠。

```ts
match(needs: NeedsText): MatchResult {
  // 第 1 级：关键词点将（程序，0 推理）
  //   worker 求助时按 sharedPrompt 约定写「@kind: xxx」或显式 to:
  //   命中 offers.keywords → 直接开 advisory ask
  // 第 2 级：Router 轻模型兜底（少 token）
  //   needs 文本 + 静态 offers 名录（~10 行）→ 候选卡 → mesh_eval_decide
  //   只在第 1 级空手时被叫
  // 降级：两级都空手 → 返回 { matched: undefined, deferred: true }
  //   Engine 把 needs 挂进 thread pending，等 Router 在下次评估时顺带决定
  //   ——不阻塞当前 worker（它是 advisory，不是 gate）
}
```

**成本归属必须说清楚（v1 藏了这一点）**：

| 环节 | 谁付成本 | 什么时候付 |
| --- | --- | --- |
| 「`@kind:` 语法」写进每个 worker 的 system prompt | **预付**：每个 worker 每次请求都带这段说明 | 常驻，永久 |
| worker 决定"要不要求助、点谁" | 一次 LLM 判断（在 worker 自己的 turn 里） | 每次求助 |
| 第 1 级字符串匹配 | 0 | 命中时 |
| 第 2 级 Router 轻模型 | 少量 token | 仅未命中时 |

所以准确说法是：**"匹配本身 0 token"，不是"自发现 0 token"**。路由成本被摊进每个 worker 的 prompt 里，换来的是"不用维护中心化的路由表"。这个 trade-off 划算，但别把它宣传成免费。

**为什么删掉中间级**：预计算 tags 需要 ① 启动时对每个 offers 跑一次 embedding（一次性，可接受），② needs 也要 embedding（每次求助一次，**这就不便宜了**），③ 向量相似度阈值调参（无数据的玄学）。在只有 4–5 个 worker 的规模下，关键词 + Router 兜底完全够用。**规模到 20+ worker 再考虑加回中间级**，并且要先有数据说明第 2 级调用太频繁。

**"不知道自己不知道"的天花板**（v1 已识别，v2 保留）：worker 不知道自己缺什么专业，就不会发起 needs。缓解手段只有一条——在 sharedPrompt 里给**具体触发条件**（"需要跨仓库事实核对时"、"需要改公开 API 时"），而不是抽象的"需要帮助时"。这不是机制能解决的，只能靠 prompt 措辞。

### 8.3 Coalition 状态机（`core/coalitions.ts`，Mesh 新增）

```
proposed ──approve(人 or Router)──▶ approved ──launch──▶ round(0..n) ──末轮完──▶ merging ──▶ dissolved
   │                                │                      │  ▲                    │
   │                                │            剧本外情况(超时/缺答/越界)          │
   │                                │                      ├──── escalate ───────────┤
   └── inferred: 通知不阻塞（裁决 6 默认）                │                        │
       自动建群+立即通知(谁/为何/预算)；                     ├──── 预算80%: 降级合并 ◀─┤
       coalitions.inferredBlocking=true 切先问再建          └──── 预算100%/deadline: ▶─┘
                                                                  强制散群出摘要
```

- **建群条件**：一个 needs 涉及 ≥2 协作方，经 Router 批准（inferred 走裁决 6 的非阻塞默认）；
- **Mandate 两型作用在群上**：explicit（用户点名）全额预算标准 TTL；inferred 预算减半、TTL 减半、工具白名单只给必需项；超界即散群报 dropped——**不自行扩大范围**（superagent Mandate inferred 语义原样搬）；
- **解散**：任务完成 / deadline / 群预算耗尽（100% 强制散群**必须**出摘要），先到者。

### 8.4 轮转剧本（`coalitions.script`，裁决 2 的载体 —— v2 改为**可选**，R13）

**v1 的矛盾**：裁决 2 要求 Router 在建票时预写剧本（"谁先说、答什么、几轮"），前提是**协作形状可预测**。但需要多 agent 辩论的场景，恰恰是形状不可预测的场景；而形状可预测的任务，一个强模型 worker 自己做完更快。**于是这个机制只在"你不需要它的时候"有效。**

**v2 的处置：不删机制，但降级为可选，并明确适用边界。**

```jsonc
// 形态 A：形状已知的多步核验（剧本非空）——适用场景少但真实
[
  { "speaker_kind": "researcher", "ask": "盘点 X 的现状与风险", "schema": "findings, risks, refs" },
  { "speaker_kind": "coder",      "ask": "给出方案对比",       "schema": "options, tradeoffs, pick" },
  { "speaker_kind": "reviewer",   "ask": "裁决方案",           "schema": "decision, rationale" }
]

// 形态 B：形状未知（script = []，默认走这个）——单轮收集 + 程序合并
//   所有成员各答一次同一个问题（无轮转、无顺序依赖）
//   moderator 程序合并字段 → 群摘要
//   没有"下一轮"，所以也不需要判断"谁下一轮发言"
```

| 剧本 | 适用 | 不适用 |
| --- | --- | --- |
| **非空（形态 A）** | 步骤与角色在开工前就确定的多步核验（例：调研→方案→裁决）；步骤间有明确依赖 | 开放讨论、需要互相反驳、需要根据上一轮答案决定下一轮问什么 |
| **空（形态 B）** | 开放问题的多视角收集（"这个方案有哪些风险"）；并行独立评估 | 需要多轮迭代收敛的问题 |

**关键洞察**：形态 B 之所以也能"轮转中零推理"，是因为**它根本不需要轮转**——所有人答同一个问题，程序合并。这比"预写剧本"更诚实：承认形状不可预测时，就不要假装能预测。

moderator（纯程序）在两种形态下都只做两件事：**执行剧本**（形态 A：取 `script[round]`；形态 B：一次性广播）和**处理剧本外情况**（超时 / 缺答 / 越界 / 回答不合 schema）→ escalate。没有"下一轮谁发言"的运行时判断，LLM 无缝可渗。

**默认值**：`coalition_script` 在 dispatch 工件 schema 里标 `optional`，缺省 = 形态 B。Router 只有在**有明确依据**（人指定了流程 / 同类票历史成功过）时才写非空剧本——写剧本本身是一次推测，推测错了比不写更贵。

### 8.5 merged summary 合并规则（裁决 5 配套，程序合并）

- 每轮发言者按剧本 `schema` 交结构化产出（字段化 JSON，`mesh_report`-style 工具回传）；
- moderator **程序合并字段**：`outputs[round] = {speaker, 按schema字段}`；群消息 = 各轮字段的拼接视图——**不做独立 LLM 摘要轮**，token 只花在发言本身；
- 明细写各 worker 自己的 spill（`read` 资源路径），群里只流通摘要（分层可见性，三对冲之一）。

## 9. Token 经济

### 9.1 usage 计量接线（裁决 5，零新设施）

- Engine 在 `session/event` 订阅里拿每个 worker session 事件自带的 `usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, …}`（`[DSH] packages/extensions/tool-cordis/src/api-catalog.ts:10094` TokenUsage，挂在 `assistant/message` 事件的 `usage?` 字段上，见 `SessionEventMap`）；
- 聚合 upsert 进 `usage` 表（scope=ticket|coalition|worker|system 四维累计）；每轮 pass `budget.checkAll()` 核账；
- 对照：superagent 主动丢弃 usage（`[SA] app/context.ts:28`）；Tobs 同源机制在用（`[TB] packages/core/src/plugin.ts:3873` `core.usage?.handleSessionEvent`）。

**写入策略（v2 新增 —— R8，必须照做）**

`node:sqlite` 的 `DatabaseSync` 是**同步阻塞**的（`[SA] app/store.ts:58-60`），而 `synchronous=FULL` 每次提交都 fsync。若在 `session/event` 回调里直接 upsert，等于**每收到一条 assistant 消息就在主线程 fsync 一次**——4+ worker 共用一条事件循环，这会把 pass 和工具调用全部拖慢。

**规则**：

| 层 | 做什么 |
| --- | --- |
| `session/event` 回调 | **只做内存累加**：`this.pending.set(sessionId, add(prev, usage))`。零 IO、零事务、零 await。回调必须极短（事件是 post-commit fire-and-forget，`[DSH] api-catalog.ts:5477`） |
| `pass` 每轮 | 把 `pending` 里所有累加值**一个事务批量 flush** 进 `usage` 表，然后清空 `pending`。一次 fsync 抵 N 条 |
| 崩溃损失 | 最坏丢一轮 pass 的 usage（≤2s 的 token 计量）。**可接受**——预算是软闸，不是账本 |
| 停机 | `closing()` 时强制 flush 一次（不依赖下一轮 pass） |

**为什么不用 `synchronous=NORMAL`**：`[SA]` 用 FULL 是为了"状态变更不丢"。usage 是唯一允许丢一点的表，但**不建议**为它单独降级——`synchronous` 是库级 pragma，不是表级。用"内存聚合 + 批量 flush"达到同样效果，且不动其他表的保证。

**度量口径**：`ctx.tokenMeter.measure(session).totalTokens` 给的是**当前 surface 的估算压力**，不是累计消耗。预算要用**累计**（从 `assistant/message.usage` 求和），两者不能混用——这是很容易搞错的地方，`[DSH] packages/llm/token-meter/README.md:36-39` 与 `packages/acp/acp/src/updates.ts:99` 用的都是 surface 语义。

### 9.2 预算动作表（`core/budget.ts`）

| 信号（每轮 pass 核） | 动作 | 谁执行 |
| --- | --- | --- |
| coalition 预算 ≥ 80% | **降级合并**：剩余轮次合并为一轮直接要结论（剧本跳步） | 程序 |
| coalition 预算 ≥ 100% | **强制散群**：立刻出 merged summary、dissolved、成员通知 | 程序 |
| ticket 预算 ≥ 100% | 票标 `blocked` + human_action，等 Router/人 | 程序 |
| worker 持续空转（预算涨但无产出） | Watchdog 提醒（§11.1） | 程序 |

### 9.3 审计与可观测

- `audit` 表只 INSERT：每次建票/派发/gate 开闭/escalate/预算动作/建散群各一行（actor = 人|Router|worker|程序）；
- 预算页：`usage` 表按 scope 聚合，HTTP API 暴露（§11.2）——「烧钱」是显式可观测状态。

## 10. Ticket 生命周期（照抄 `[SA]` 语义，follows 换 thread）

### 10.1 状态机全图

```
                建（Router accept / mesh_eval_decide）
                          │
                          ▼
  waiting ◀──人消息复活──  working ──report──▶ idle(person) ──gate/needs/ask──▶ working
    │                        │                                    │
    │ 派 Assignment           │ report(ready + follows 未完成)      │ 结束判定
    ▼                        ▼                                    ▼
  working ──────────────▶ 五种 ended ────────────────────▶ stage: ended（session 保留 idle）
                          outcome: completed | dropped | merged | closed | stopped
```

五 stage（照抄 [SA] stage.ts:10）：`waiting / working / idle / person / ended`。

### 10.2 结束判定表

| 信号 | outcome | 例外 |
| --- | --- | --- |
| worker `mesh_report(ready)`（无 follows） | `completed` | 绑定 follows（自开 thread）→ 先停 `person/review`，thread 全关才 `followsDone` 结束（[SA] tickets.ts:92-95） |
| `mesh_report(dropped)`（无事可做 / 超 Mandate） | `dropped` | — |
| 关注 thread 自然关闭（任务类 thread 完成） | `merged` / `closed` | 关闭后 worker 又接人消息处理中 → `unfinished` 票活着（[SA] tickets.ts:365-370） |
| 人叫停（`mesh_route` stop 项） | `stopped` | **唯一不可复活**（[SA] model.ts:85） |

### 10.3 结束动作与复活

- **结束动作**（[SA] tickets.ts:339-361 + dsh.ts:354-367 照抄）：停未结束 assignments（取消 worker turn、杀 shell 后台任务与全部 subagent）→ `undelivered = []` → 之后输入 `UserError: ticketEnded` → 广播 `ticket.ended`（主会话 notice）；
- **焚票不焚 session**：临时 worker session 变 idle 保留——人追问一句即复活（删 `ended`、注入 RESUMED，完整历史上下文都在、命中缓存）；常驻 worker 只清票态、session 本来就跨票；
- **复活只认人**：worker/bot 消息只排队不复活；
- **重试**：`mesh_ticket_retry` → 新 Assignment 同 session + RETRIED note（从 workspace/git 续作）。

## 11. Watchdog 与可观测性

### 11.1 Watchdog（跨平台：DSH schedule 定时任务）

superagent 的 Watchdog 设计（定时消息检查 agent 是否真有进展）跨平台可抄；其 tmux+Python 部分弃用。Mesh 版直接用平台 API `[DSH] ctx.schedule（api-catalog 2808-2882）`：

- Engine 启动时（或首个主会话就绪后）`ctx.schedule.create({ title: 'Mesh Watchdog', prompt: <检查指令>, timing: { kind: 'every', every_seconds: 3600 }, target: { kind: 'session', sessionId: <主会话 id> } }, actorSessionId)`——**target 是判别式联合 `{kind:'session', sessionId}`**，v1 写的 `{session: id}` 是错的（`[DSH] api-catalog.ts:8705-8706`）；`timing` 同理是 `{kind:'every', every_seconds}`，不是裸字符串（`api-catalog.ts:8709-8710`）。`session` target 要求目标 session 已存在且非 delegated child，mesh profile 内自建即可，无需跨 profile 定时；
- 交付语义：delivery 时才 resume 目标 session（读与管理写不激活），prompt 进 Agent Inbox；`schedule/resolve-agent` waterfall 决定接收 Agent——Engine 不注册该 waterfall，走默认解析；
- `ctx.schedule.edit({id, action: 'update', patch, expectedUpdatedAt})` 乐观锁编辑（`api-catalog.ts:8653`；v1 写的 `remoteEdit` 是给 Remote 人类调用方的形式，插件内用 `edit`），用户在 DSH UI 改任务后不被 Engine 覆盖；`ctx.schedule.run({id})` 可立即触发一次不消耗排程；
- Router 收到即 `mesh_read` 三个资源：`workers`（空转判定：status/idle 时长/预算涨但无产出）、`coalitions`（死锁：同轮超 30min）、`usage`；
- 产出：主会话人可见的 notice + 建议（escalate/stop/散群）——**Watchdog 只管异常，不刷新上下文**（§3.3 卫生三件套分工）。

### 11.2 HTTP 状态 API（`app/http.ts`，照抄 `[SA] http.ts` registerHttp 模式）

| 路由 | 返回 |
| --- | --- |
| `GET /mesh/api/state` | 总览：workers / tickets(open/active) / coalitions(open) / effects health / 预算摘要 |
| `GET /mesh/api/tickets` | 票列表（分页卡片） |
| `GET /mesh/api/coalitions` | 群列表 + 预算用量 |
| `GET /mesh/api/usage?scope=&id=` | token 计量明细 |

`x-mesh-request: 1` 头（照抄 superagent 管理头模式），只读。

### 11.3 read 资源表（`app/resources.ts`，`mesh_read` / `mesh_worker_read` 共用）

`tickets` / `ticket/<id>`（spec+assignments+reports）/ `message/<id>` / `thread/<key>/page?cursor=` / `coalition/<id>`（剧本+轮次产出）/ `coalition/<id>/transcript` / `workers` / `usage/<scope>/<id>` / `settings` / `prompts`。分页语义照抄 [SA] resources.ts（`next_offset` / `next_resource`）。

### 11.4 日志纪律

结构化、有界（照 [TB] AGENTS.md 开发者诊断节）：initiator / phase / duration / refusal reason；永不泄密；`kv` 与 `audit` 是持久权威，日志只是过程证据。

## 12. 安全

- **Mandate 隔离**（§5.2/§8.3）：inferred 工作预算减半、超界 dropped、不自行扩大范围；
- **gate 不可删**：spec 变更只加不减，Engine 校验 + prompt 纪律双保险；
- **权限分层**：Router 无 Bash 无文件写（铁律 2）；worker 按 kind 白名单（`permissionPresets.set`）；临时 worker 只给必需项；
- **stateDir 0600 + WAL + synchronous=FULL**（[SA] store.ts:63-64）；凭证不进库不进 repo；
- **审计全咽喉**：一切状态变更过 Engine（唯一事务入口），audit 只 INSERT。

## 13. 测试与验收

### 13.1 单测面（core/* 全量，无 DSH 依赖）

- store：atomic 嵌套/回滚丢弃 afterCommit/迁移/生成列 reconcile/**usage 批量 flush 一次 fsync**（R8）；
- effects：Later 不增计数/退避封顶/generation 防误删/ordered 阻塞/停机 drain；
- intake：幂等/filtered/fanout/只有人消息复活/stopped 不可复活；
- evals：deadline 计时（交付后）/REQUEUES/unavailable；
- tickets：五 stage/四 outcome/两例外/焚票五件套；
- bus：tell/ask/publish 匹配投递/TTL 归档/退订；
- directory：**两级匹配**（keyword 命中 / 未命中降级 deferred），断言"不调 Router 时不产生 token 记账"（R12）；
- coalitions：**形态 B（空剧本）单轮收集**/形态 A 剧本步进/预算 80%/100% 动作/剧本外 escalate（R13）；
- gates：开闸挂起/approve/reject/超时 escalate/**规则 A 持有者不可被挂起**/**规则 B 升级目标未参与本票**/**规则 C 环检测 + depth 上限**（R9）；
- budget：usage upsert/阈值动作/**累计口径 vs surface 口径不混用**。

### 13.2 集成验收（每里程碑的 Human 可判定行为）

| 里程碑 | 端到端验收 |
| --- | --- |
| **M0 骨架+库+patch** | `--dump-config` 输出含 `mesh-engine`（R1）；stderr 无 unknown/skipped；worker session 里 `bash -c echo ok` 可跑（R2）；`GET /mesh/api/state` 返回 200；`dsh` 重启 effect 表续跑 |
| **M1 直通+票** | 人主会话说「让 researcher 调研 X」→ worker session 出现在 DSH 面板并收到票；**从发送到 worker 开始 turn < 15s**（§4.4） |
| **M2 预算**（v1 的 M5 提前） | 构造烧 token 的票，`/mesh/api/usage` 可见累计值；80%/100% 动作触发；**usage 表数值与 DSH 面板 token 数对得上**（口径验证） |
| **M3 慢速通道** | 新话题消息进 Router 候选卡；`mesh_route` 建票带完整 dispatch 工件；缺 `coalition_script` 时不报错（R13） |
| **M4 watchdog+API** | 空转 worker 被 Watchdog 发现并 notice；`/mesh/api/state` 暴露 `pass.lastAt`/`effect.waiting` 两个信号（§4.4） |
| **M5 directory+advisory** | coder 求助（needs）被 keyword 命中拉起 reviewer 并回 advisory；未命中时降级 deferred 且不阻塞 coder |
| **M6 gate** | 构造 coder→reviewer gate；approve 后恢复；**构造 reviewer 自己被 gate 挂起的场景，验证规则 A 拒绝开闸**（R9） |
| **M7 coalition** | 空剧本单轮收集出 merged summary；非空剧本三步走完；预算 100% 强制散群出摘要 |

## 14. 实现顺序（tracer bullet，[TB] AGENTS.md 纪律）与避坑

**v2 重排（R1–R13 的处置结果）**：v1 的 M0→M6 把最难、最没证据的排前面（M2 Directory、M3 Coalition），把最便宜最有价值的排后面（M5 预算）。现改为**先证明能装上、再证明能用、最后才做协作**：

| 新序 | 内容 | 为什么这个顺序 |
| --- | --- | --- |
| **M0** | 骨架 + Store/Effects/Passes + **patch 真能装上的验证** | R1/R2 是阻塞项：装不上就什么都没意义。半天内必须过 `--dump-config` + worker 有 shell 两道关 |
| **M1** | WorkerExecutor + 常驻池（2 个）+ 直通投递 + 票骨架 | 最小可用闭环：人 → Router → worker → report。这一步就该能干活 |
| **M2** | **预算计量接线**（从 v1 的 M5 提前到第 3 位） | 最便宜、最确定有收益。越早有数据，越早能判断 M5–M7 要不要做 |
| **M3** | 慢速通道（evals + assessment + dispatch 工件） | 没有它只能靠人显式点将，Router 形同虚设 |
| **M4** | Watchdog + HTTP 状态 API | 可观测性：让 M2 的数据能被看见，否则预算只是库里一行数 |
| **M5** | Directory（两级，R12）+ advisory ask | **只有 M1–M4 跑出"确实需要临时拉人"的证据才做** |
| **M6** | Gate（含 R9 的三条规则） | **只有 audit 表里出现"两个 worker 真分歧"的案例才做** |
| **M7** | Coalition（剧本可选，R13） | 最后。没有真实多轮辩论案例就不做 |

**判断标准（写进流程，避免自我说服）**：M5/M6/M7 是否开工，由 `audit` 表里的**实际计数**决定，不由设计意愿决定。具体门槛：

- M5 开工门槛：M1–M4 期间出现 ≥5 次 worker 主动 `needs` 且当前靠人转达；
- M6 开工门槛：≥3 次出现"worker 改了不该改的东西"或"两个 worker 结论冲突"；
- M7 开工门槛：≥3 次出现"一个问题需要 3 个以上视角才能答"。

达不到就不做。**这三块占了 v1 设计 70% 的篇幅，但它们不是 Mesh 的价值来源**——价值来源是 M1（类型化 worker）+ M2（预算可见）。

**开工前验证项**（先于 M1，半天内完成，**v2 扩为 6 条**）：

1. **`--dump-config` 里能看到 `mesh-engine`**（R1）——patch 语法对了没有；
2. **worker session 里 `bash`/`pwsh` 真能跑**（R2）——preset 的 group 子行对了没有；
3. Mesh bundle 插件上下文里 `ctx.sessionController` / `ctx.workspaceRegistry` / `ctx.permissionPresets` 可用（superagent 在同形态 bundle 内已用，预期直接过）；
4. **`ctx.on('session/event', …)` 在根级 bundle 插件里能收到所有 worker session 的事件**（R3；`[DSH] packages/core/scope/README.md` 的 Event filtering 节：未打 scope tag 的 listener 收全部。`[TB] plugin.ts:3859` 已验证该模式，但**注意 v1 写的 `{global:true}` 是错的选项**——`global` 是 Cordis 的"绕过 context filter"，与 DSH 的 scope filter 是两回事，`vendor/cordis/src/events.ts:110-116`）；
5. session 事件 `assistant/message.usage` 在插件上下文可读（裁决 5）；
6. `ctx.schedule.create({ target: { kind: 'session', sessionId } })` 可用、定时消息确实落入主会话 Inbox（§11.1 Watchdog；注意 `ScheduleTargetRequest` 是 **`{kind:'session', sessionId}`** 判别式联合，不是 v1 写的 `{session: id}`，见 `[DSH] api-catalog.ts:8705-8706`）。

**避坑**（全部来自三仓库源码教训 + 本次评审，铁律化）：

- **`cordis.patch.yml` 必须是 `- insert:` 包裹**（R1）——不带 insert 的 row 会被静默跳过，不报错；
- **preset 的 group 行必须是 `cordis:group` + 子行**（R2）——写 `dsh-shell`/`dsh-compaction` 只会挂服务，不挂工具；
- Router 无 Bash 是**Mesh 的主动偏离**（R10），不是抄 superagent；superagent 的 Router 有 shell；
- preset 必须写 `cordis.patch.yml` 且带 `agent-preset/selected` 重选守卫（铁律 5）；
- **`engines.dsh` 用 `>=0.2.2-rc.2 <0.2.3`**（R7）——`>=0.2.2-rc.1` 会拒绝下一个 rc；
- **常驻数 ≤ residentSlots**（R5）——默认 2 个常驻，不是 4 个；
- **usage 不在事件回调里写库**（R8）——内存累加 + pass 批量 flush；
- 无 tmux/Python 外部进程；Watchdog 用 schedule 插件（铁律 6）；
- 传输只走 superagent 已验证路径（`sessions.prompt` / `session/event` 订阅），不发明第二传输（铁律 1）——但理由要说对：这是**架构选择**，不是"做不到"（R3）。

---

## 15. 传输接缝的事实与选择（v2 新增 —— R3）

**这一节是为了防止后续实现者被 v1 的错误前提误导。**

### 15.1 事实

| 断言 | 事实 | 证据 |
| --- | --- | --- |
| "Worker 是独立进程" | ❌ **错**。session 与 agent 都是同进程内存对象 | `[DSH] api-catalog.ts:3384-3447`（`ctx.sessions.get(id)` 返回 live Session，注释明说 persistence 不在这一层）；`api-catalog.ts:263-352`（`ctx.agents.get(id)` 返回 live Agent） |
| "Worker 不能直写 SQLite" | ⚠️ 技术上**可以**（同一进程、同一 `DatabaseSync` 句柄），但**设计上禁止** | `[SA] app/store.ts:58-60` 单实例 `DatabaseSync`；`[SA] app/sessions.ts:116-121` superagent 自己就在同进程订阅 |
| "`session/event` 是跨进程事件" | ❌ 是同进程 `emit`，post-commit fire-and-forget | `[DSH] api-catalog.ts:5477` |

### 15.2 为什么仍然选"唯一写者"

既然同进程，为什么不直接让 worker 写库、互相直接调用？三条理由，都是真实的：

1. **审计完整性**：所有状态变更过 Engine 的 `atomic()`，一条命令 = 一个事务 = 一个 audit 行。若 worker 能直写，审计就有洞，"谁在什么时候改了什么"不再可答。
2. **崩溃一致性**：状态变更与副作用意图（`effect` 表）在**同一事务**内提交。worker 直写做不到这点——它要么写状态不写 effect（崩溃后状态变了但活没派），要么写 effect 不写状态。
3. **预算可卡**：token 消耗必须在派发前就能被预算判断拦住。绕过 Engine 的调用 = 绕过预算。

### 15.3 代价（诚实记录）

- **延迟**：一次内存调用变成"写库 + 2s 内被 pass 捡起"。这是 §4.4 延迟预算存在的原因；缓解手段是"receive 即踢"，不是"换通信机制"。
- **复杂度**：多了一层序列化 + 状态机。这是买审计/一致性/预算的价钱。

### 15.4 如果将来要改

**唯一可考虑的简化**：把 worker↔worker 的 `tell` 从"写 message 表 + pass 投递"改为"Engine 事务内直接 `sessions.prompt` 目标 session"（仍在 Engine 内，仍写 audit，但省掉一次 pass 往返）。这需要先有 §4.4 的延迟数据支撑——若实测 `tell` 往返已 < 500ms，就别改。

**不可考虑的**：让 worker 直写 SQLite。那会同时打掉上面三条理由。

---

## 附录 A：术语对照

| Mesh | superagent | Tobs |
| --- | --- | --- |
| Router（主会话） | master session | Orchestrator Session |
| Engine | Engine（App Engine 核心） | Bot Runtime（Assignment Runtime） |
| Worker（临时） | worker session（worker-<ticketId>） | Assignment Session |
| Worker（常驻） | —（无此概念） | PersonaBot 的 Orchestrator（弱化：无 IM 无 persona） |
| Ticket | ticket | Assignment（弱化：无 IM 汇报线） |
| Coalition | — | 群聊（全员常驻 vs 按需临时） |
| Gate | — | —（Tobs 无人审闸） |
| Effects/Passes | effects.ts/passes.ts | — |

## 附录 B：源码证据索引

- **[SA] superagent**：`src/app/store.ts:58-162`（库/事务/迁移）、`src/app/effects.ts`（副作用队列全文）、`src/app/passes.ts`（69 行全文）、`src/app/sessions.ts:95-234`（session 生命周期/preset 守卫/投递三态/工具注册）、`src/app/tools/main.ts`（Router 工具面）、`src/app/tools/executor.ts`（Worker 工具面）、`src/app/assessment.ts:20-112`（评估三件套）、`src/executor/dsh.ts:24-55, 97-131, 171-199, 210-235, 247-283, 313-343, 342, 424-470`（executor 全套）、`src/core/engine.ts`、`src/core/intake.ts:19-62`、`src/core/tickets.ts:74-95, 157, 254-262, 339-370`、`src/core/model.ts:85, 272-320`、`src/core/stage.ts:10`、`docs/006-deployment.md:79-85`、`docs/007-architecture.md:400`。
- **[TB] Tobs**：`docs/architecture/bot-runtime-architecture.md:48-143`（两层会话/并发 3）、`docs/architecture/botharness-architecture.md:277-279, 453, 705, 713, 768, 951`（记忆冻结/群审计/Orchestrator 工具/inbox/bot_subagent/assignmentReply）、`packages/core/src/plugin.ts:3844-3919`（global 事件订阅/usage/agent 生命周期）、`AGENTS.md`（tracer bullet/CLI parity/验证资源清理纪律）。
- **[DSH] deepseek-harness**：`packages/extensions/tool-cordis/src/api-catalog.ts`（API 权威目录；关键行：263-352 ctx.agents、230-262 agentPresets、2374-2415 permissionPresets、2766-2805 sandboxPolicy、2808-2882 ctx.schedule、2893-3055 sessionController、3097-3139 sessionPersistence、3252-3333 sessionQuery、3384-3447 ctx.sessions、3833-3880 storage/storageDomain、399-421 ctx.approval、5437-5485 schedule/changed·session/created·session/event 等、5477 session/event、5533 subagent/start、5929-5941 ApprovalPolicy、7765-7793 ModelCatalog、8149-8151 PresetDefinition、8157-8158 PresetSpec、8617-8653 ScheduleCreateRequest/EditRequest、8705-8706 ScheduleTargetRequest、8709-8710 ScheduleTiming、8841-8846 SessionCreateRequest/Value、8857-8874 SessionEvent/EventMap（`assistant/message.usage?`）、9189-9193 SessionPromptRequest、10094 TokenUsage）、`packages/llm/token-meter/README.md:36-39`（ctx.tokenMeter.measure，**surface 语义不是累计**）、`packages/acp/acp/src/updates.ts:99`（在用证据）、`docs/user/develop/basic/publish.md:26-131`（bundle manifest/三层安装/加载顺序/patch 整对象替换/**37-44 的 `- insert:` 示例**）、`packages/boot/app-boot/src/config-schema/document.ts:29`（**unknown target 与无 insert 的 patch 被警告后跳过**——R1 的判据）、`packages/core/scope/README.md`（Event filtering：未打 tag 的 listener 收全部——R3/R14 的判据）、`vendor/cordis/src/events.ts:110-116`（`global` 是 Cordis 的 context-filter 绕过，与 DSH scope filter 无关）、`docs/user/develop/basic/index.md:19-135`（插件三形态/inject/ctx.effect）、`apps/cli/reference/README.md:11-124`（profile CLI/--patch/--dump-config/**unmatched target 走 stderr**）、`package.json:8-9`（engines node≥24.9.0，version `0.2.2-rc.2`）。

---

*详设 v2（2026-11-15 第二次修订）：按 `mesh-bundle-review.md` 的 R1–R13 全部修复。主要改动——§2.2 重写为 `- insert:` 结构 + 真实 preset group（R1/R2，阻塞项）；§0.3 铁律 1/2 理由与出处修正（R3/R10）；§3.4 上下文经济学三分（R6）；§3.5 数据模型单一权威（R11）；§4.4 新增延迟预算（R4）；§5.4 槽位拆分（R5）；§7.2 gate 死锁三规则（R9）；§8.2 两级匹配 + 成本归属（R12）；§8.4 剧本可选（R13）；§9.1 usage 批量写 + 口径澄清（R8）；§2.1 engines range（R7）；§13/§14 里程碑重排；§15 新增传输接缝事实。*

*详设 v1.1（2026-11-15）历史记录：曾按 DSH 插件机制核查重写 §2.2、§5.4、§6.1、§11.1——但 §2.2 的重写本身仍有两个阻塞级缺陷（v2 修复）。这条历史保留下来，因为它说明一件事：**"按源码核查过"不等于"核查对了"**，核查必须能复现（给出文件:行号并真的打开看），而不是引用符号名。*

*证据基线：superagent @ 工作区快照 / DeepSeekBot @ 工作区快照 / deepseek-harness 0.2.2-rc.2。与 `mesh-bundle-design.md`（摘要+裁决）、`mesh-bundle-issues.md`（P1–P13 登记簿）、`mesh-bundle-review.md`（评审发现）配套阅读。*
