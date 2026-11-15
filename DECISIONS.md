# 需要你决策的事项

> 你在休息，我把所有能自己判断的都做完了。这里只记**真正需要你拍板**的，每条都写了我的默认选择和理由，你回来只需看「要不要改」。

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

## D4. 常驻 worker 数量（默认 2，不是 4）

设计文档 v1 标了 4 个常驻（researcher/coder/reviewer/ops），但那与槽位数冲突，而且每个常驻都在持续付成本（session 存活 + 缓存预热 + Watchdog 巡检）。

**默认 2 个**：researcher + coder。reviewer/ops 按需拉起。

**要不要改**：如果你发现 reviewer 被调用得很频繁（看 `/mesh/api/usage`），把 `executor.residentWorkers` 改成 3 或 4 即可，槽位会自动让出。

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

## D7. 我没有做的事（明确记录）

| 没做 | 为什么 |
| --- | --- |
| Router 的 `initializeRoleModel`（session-local 模型选型） | 需要 `ctx.llm` 的完整 API，而当前 profile 的 llm 服务可见性未验证。**目前所有 Session 用默认模型**，`eval.model` 配置项已留但未生效 |
| web 前端的 Mesh 面板（可视化） | HTTP API 已完整（state/tickets/coalitions/usage/workers/gates/audit/health）。做 UI 是另一件事，且没有你的审美输入我不该猜 |
| 真实的端到端 LLM 跑通（人→Router→worker→report） | 需要配置模型 API key 并发起真实对话。**这一步必须你来做**，因为涉及你的账号和额度 |
| worker 崩溃后的 session 自动重建 | `Later` 机制已就位（投递失败会重试），但"session 被外部删除 → `sessions.ensure` 重建"这条路径没有实测，因为没法在不破坏环境的前提下模拟 |
| 迁移（schema v1 → v2） | 首发只有 v1，`migrate()` 钩子已留 |

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
