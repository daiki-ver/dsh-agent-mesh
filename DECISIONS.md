# 需要你决策的事项

> 你在休息，我把所有能自己判断的都做完了。这里只记**真正需要你拍板**的，每条都写了我的默认选择和理由，你回来只需看「要不要改」。

## 文档导航

四份文档，各管一件事，别混着看：

| 文档 | 回答什么 | 什么时候读 |
| --- | --- | --- |
| [USAGE.md](USAGE.md) | **怎么用**。启动、交活、看进度、排障、配置 | 第一次用；忘了命令时 |
| [README.md](README.md) | **为什么这样设计**。五条铁律、每个部件买什么、六条 Host 坑 | 决定要不要采用；改设计前 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | **怎么运转的**。状态机、effect 队列、投递路径、死锁规则 | 改代码前；排查诡异行为时 |
| 本文 | **需要你拍板什么**。七个决策点 + 我没做的事 | 现在 |

---

## ✅ 真实 LLM 端到端测试：已跑通（2026-11-16 上午）

用你本机的 `D:\Program Files\DSH`（0.2.2-rc.1）真实跑了两轮任务，**全链路验证成功**：

```
人提交任务 → Router 评估 → 建票 → 派给 researcher → worker 用 pwsh 读文件
→ mesh_report 带回答案 → relay 送达 Router
```


**证据**（第二张票，`completed`）：

```
Ticket ... reported ready.
Count: 13 .ts files under src/core
Paths: src/core/budget.ts, bus.ts, coalitions.ts, directory.ts, effects.ts,
       engine.ts, evals.ts, gates.ts, intake.ts, model.ts, passes.ts,
       store.ts, tickets.ts
Evidence: src/core EXISTS; it contains no subdirectories...
```

worker 真的用 pwsh 执行了 `Get-ChildItem`，答案带证据说明。

**另外验证了 Router 的调度智能**：我提交「用一句话说明 1+1 等于几」，Router 判断这类问题不值得建票，直接自己回答并说明理由（"这类一句话即可回答的问题不需要派给 worker，否则会多花一个工单和预算"）。这是**正确行为**，不是 bug。

**这轮测试暴露并修复了 5 个只有真跑才会发现的缺陷**（已 commit `0ffbef9`）：

| 缺陷 | 后果 | 修复 |
| --- | --- | --- |
| `Engine.receive()` 无人调用 | 人的任务进不来 | 新增 `Engine.submit()` + `POST /mesh/api/task` |
| HTTP 挂 `request` 事件与 Host 抢响应 | `ERR_HTTP_HEADERS_SENT` 直接崩进程 | 改用 `webServer.register()` 路由表 |
| `prompt()` 缺 AbortSignal 参数 | 每次投递 TypeError，消息全丢 | 补 signal；`{inject}` 映射为 `queue` |
| assess effect 重复开评估 | 拿到 undefined 直接 return，卡片从不投递 | 改为读 thread 后直接投递 |
| worker 的答案从不回传 Router | 票结束了 Router 看不到内容，无限重问 | report 时 relay result 给 Router + assignment 消息里写明报告契约 |

---

## ⚠️ 需要你动手的一件事：推送代码

代码已完整提交到本地 `main`（3 个 commit），但**推送到 GitHub 失败**。

**原因**：`git config credential.helper = manager`，推送时 Git 要弹 GUI 凭据窗口，在非交互环境下阻塞超时。这是环境限制，不是代码问题。

**你需要做的**（任选其一）：

```bash
# 方式一：在桌面终端里直接推（会弹窗让你登录）
cd D:/CodeSpace/DSH-AgentMesh/dsh-agent-mesh
git push -u origin main

# 方式二：用 token
git push https://<你的token>@github.com/daiki-ver/dsh-agent-mesh.git main
```

推完 `git log --oneline -1` 应看到 `0ffbef9 fix: make the end-to-end path actually work...`。

---

## 怎么自己再跑一次

```bash
cd D:/CodeSpace/DSH-AgentMesh/dsh-agent-mesh
pnpm check                     # typecheck + 96 tests + build

# 启动（用你本机的 dsh）
"D:/Program Files/DSH/resources/runtime/cli/bin/dsh.cmd" --profile mesh --no-open --port 3227

# 另一个终端：提交任务
curl -X POST localhost:3227/mesh/api/task \
  -H "content-type: application/json" \
  -d '{"text":"在 src/core 里数一下有多少个 .ts 文件"}'

# 看进度
curl -s localhost:3227/mesh/api/tickets
curl -s localhost:3227/mesh/api/health
```

---

## 状态速览

**已完成并实测通过**（不是"写完了"，是真跑起来了）：

| 项 | 证据 |
| --- | --- |
| patch 能被加载 | `dsh --profile mesh --dump-config \| grep -c mesh-engine` = 1，stderr 无 unknown/skipped |
| worker 真有 shell | preset 的 group 子行完整，`dsh-tool-bash`/`dsh-tool-pwsh` 按平台挂载 |
| Router Session 就绪 | audit 有 `router.ready {"sessionId":"mesh-router"}` |
| 2 个常驻 worker | audit 有 `worker.resident`，DB 里两条 idle 记录 |
| Watchdog 已排程 | audit 有真实 schedule id `schedule-c2e65378-...` |
| pass 循环在跑 | `/mesh/api/health` → `alive: true`, `sinceLastPassMs: 121`, `diagnosis: "healthy"` |
| HTTP API | `/mesh/api/state` 返回真实数据（2 workers、7 effect kinds） |
| 单元测试 | 90 个测试全绿 |

---

## D1. mesh profile 依赖 `@deepseek-ai/dsh-web-app`（需要你知道）

**情况**：`sessionController` / `sessions` / `agents` / `tools` 这些服务全部由 `dsh-web-app` 提供。只装 `dsh-base` 的 profile 里这些服务都不存在，Mesh 会在 `ctx.inject` 上永久挂起。

**我做了什么**：往 `~/.dsh/profiles/mesh/package.json` 的 `bundles` 里加了 `@deepseek-ai/dsh-web-app`，并执行了 `dsh plugin allow-version`（因为 npm 上的 web-app 是 `0.0.1-rc.1`，与 dsh `0.2.2-rc.1` 版本不匹配）。

**要不要改**：这意味着 mesh profile 会连带加载整套 web UI 插件。如果你想要一个**纯 headless 的 Mesh**（不要 web UI），需要另找一个只提供 session/agent 服务的 bundle —— 但我查过，目前没有这样的 in-box bundle。**默认保留 web-app**，代价是启动稍重，但这是唯一能让 Mesh 跑起来的路径。

---

## D2. 三个预设插件必须有显式配置（已处理，告知你）

`dsh-tool-fs-search`、`dsh-tool-todo`、`dsh-tool-subagent` 的某些字段是 `required()` 而非有默认值，缺了就**整个 worker session 创建失败**。我已补齐：

```yaml
tool-fs-search: { sampleOverCapGlobResults: true }
tool-todo:      { allowParallelInProgress: false }
```

**`tool-subagent` 我直接删了** —— 它的 `provider` 必须指向一个已注册的 provider bundle，而默认 profile 里没有注册任何 provider。要恢复 worker 内的 subagent 能力，需要额外装 `@deepseek-ai/dsh-subagent-spawn-in-process` 之类。**默认不要**：一个 ticket 一件事，worker 内再开 subagent 会让预算和审计变复杂。

**要不要改**：如果你需要 worker 内能再分派子任务，告诉我，我加 provider bundle。

---

## D3. `engines.dsh` 的版本范围（我的选择可能偏保守）

我写的是 `">=0.2.2-rc.1 <0.2.3"`。

**理由**：你本机装的是 `0.2.2-rc.1`。SemVer 预发布规则下，`>=0.2.2-rc.2` 会**拒绝** rc.1，装不上；而 `>=0.2.2-rc.1` 单独写会接受 `0.2.3-rc.1`（不同 tuple，规则不允许），所以必须加上 `<0.2.3` 封顶。

**要不要改**：如果你计划升级到更新的 rc，这行要手动抬。这是**故意**的——让版本升级变成一个有意识的动作，而不是静默漂移。

---

## D4. 常驻 worker 数量（默认 2，且**实际最多只能 2**）

设计文档 v1 标了 4 个常驻（researcher/coder/reviewer/ops），但那与槽位数冲突，而且每个常驻都在持续付成本（session 存活 + 缓存预热 + Watchdog 巡检）。

**默认 2 个**：researcher + coder。reviewer/ops 按需拉起。

**⚠️ 一个我最初写错的地方，已核实修正**：`executor.residentWorkers` 调大到 3 或 4 **不会多起任何 worker**。因为启动逻辑是：

```ts
const residentKinds = WORKER_TEMPLATES.filter(t => t.resident).map(t => t.kind)
const wanted = residentKinds.slice(0, config.executor?.residentWorkers ?? 2)
```

而 `WORKER_TEMPLATES` 里只有 `researcher` 和 `coder` 标了 `resident: true`，所以 `residentKinds` 长度恒为 2，`slice(0, 4)` 还是 2 个。

**要让 reviewer/ops 也常驻**，需要在 `src/core/directory.ts` 里给它们加 `resident: true`，然后重新 build。这是个代码改动，不是配置改动。

**要不要改**：如果你的场景里 reviewer 被频繁调用（看 `/mesh/api/usage` 里是否有大量 temp reviewer），再改代码。现在没必要。

---

## D5. 三个可选子系统：我全部实现了，但**建议先不用**

`mesh_needs`（能力目录）、Gates（强制咨询闸）、Coalitions（临时小群）—— 代码写完了、测试覆盖了、能跑。但设计文档的判断我认为是对的：

> 这三块占 v1 设计 70% 的篇幅，但不是 Mesh 的价值来源。价值来源是「类型化 worker」+「预算可见」。

**我的默认行为**：三者都不自动启用。`mesh_needs` 只在 worker 主动调用时才走；Gate 只在 dispatch 工件里显式写了 `gates` 才开；Coalition 只在 Router 显式 `mesh_coalition_propose` 才建。

**要不要改**：`mesh_evidence` 工具会返回真实计数（gate / needs / coalition / escalate 各被用了几次）。**建议跑一两周，看计数再决定要不要在 prompt 里主动引导 worker 使用它们。** 现在就引导等于自证需求。

---

## D6. Gate 的一个设计取舍（我选了严格）

同一张票**同时只能有 1 个 open gate**。

**理由**：并行闸是死锁温床（A 等 B、B 等 A），而"必须同时等两个人签字"在 Mesh 里没有真实场景——所有 worker 都是同一个模型，两个签字不比一个更可信。

**代价**：如果确实需要"UX 和 SE 都签"，得串行两次，慢一轮。

**要不要改**：如果实际用起来发现串行太慢，告诉我，但我会先要求给出「为什么两个签字确实比一个强」的证据。

---

## D7. 多工作区隔离：已实现（原列为"不支持"，现已改）

**你问的**：多个工作区能否各有独立 team、互不发现。

**原来的答案**：不能。sessionId 硬编码为 `mesh-router`，DSH 按 id 定位且只允许一个写入句柄，第二个工作区启动直接失败（`session/writer-held`）。

**现在的答案**：能。已实现并实测（commit `002eca3`）。

```
A (DSH-AgentMesh):     mesh-yv5qr8-router / -researcher-1 / -coder-1
B (dsh-agent-mesh):    mesh-187b16q-router / -researcher-1 / -coder-1
状态库:                 ~/.dsh/state/mesh-yv5qr8 / mesh-187b16q
```

三项实测确认：
- 两个实例**同时运行**，无冲突
- A 的 worker 表只有自己的 2 个，B 同理，**互相不可见**
- 各自 worker 的 cwd 正确（A 读 `DSH-AgentMesh`，B 读 `dsh-agent-mesh`）

**实现方式**：`workspaceScope()` 把工作区绝对路径归一化后哈希，得到短 scope，所有 sessionId / workerId / stateDir 都带这个前缀。

**必须说清的边界**：这是**逻辑隔离**（身份、状态、发现范围），不是**安全隔离**。A 的 worker 在 `mesh_tell` 里看不到 B 的 worker，但文件系统层面没有内核沙箱——如果 A 的 coder 硬编码 B 仓库的绝对路径，它能读到。要强隔离得在 DSH 层加沙箱策略。

---

## D8. 我没有做的事（明确记录）

| 没做 | 为什么 |
| --- | --- |
| Router 的 `initializeRoleModel`（session-local 模型选型） | 需要 `ctx.llm` 的完整 API，而当前 profile 的 llm 服务可见性未验证。**目前所有 Session 用默认模型**，`eval.model` 配置项已留但未生效 |
| web 前端的 Mesh 面板（可视化） | HTTP API 已完整（10 个路由）。做 UI 是另一件事，且没有你的审美输入我不该猜 |
| ~~真实的端到端 LLM 跑通~~ | ✅ **已完成**（见本文顶部），发现并修复 5 个缺陷 |
| ~~多工作区隔离~~ | ✅ **已完成**（见 D7），107 个单测含 11 个隔离断言 |
| worker 崩溃后的 session 自动重建 | `Later` 机制已就位（投递失败会重试），但"session 被外部删除 → `sessions.ensure` 重建"这条路径没有实测，因为没法在不破坏环境的前提下模拟 |
| 迁移（schema v1 → v2） | 首发只有 v1，`migrate()` 钩子已留 |
| Gate / Coalition 的真实场景实测 | 代码写完、单测覆盖、能跑，但没在真实任务里触发过。**这是故意的**——按 D5 的判断，应该等 `mesh_evidence` 有真实计数再决定要不要引导使用 |

---

## 你回来后建议的第一步

```bash
cd D:/CodeSpace/DSH-AgentMesh/dsh-agent-mesh
pnpm check                    # typecheck + 90 tests + build
dsh --profile mesh --dump-config | grep -c mesh-engine    # 应为 1
dsh --profile mesh            # 启动，看 /mesh/api/health 是否 healthy
```

然后**在 DSH 的 Mesh Router 会话里说一句真实任务**，看它是否建票、是否派给 coder、worker 是否收到。这是唯一还没验证的环节，也是唯一需要你的模型账号的环节。

如果那一步出问题，把 `~/.dsh/state/mesh/mesh-boot.log` 和 `/mesh/api/state` 的输出给我，我能定位。
