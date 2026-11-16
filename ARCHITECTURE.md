# 架构说明

这份文档回答"它是怎么运转的"，而不是"怎么用"（那是 [USAGE.md](USAGE.md)）或"为什么这样设计"（那是 [README.md](README.md)）。

---

## 一、三层结构

```
┌─ 会话层（DSH Session，同进程对象）──────────────────────────┐
│  Router Session          Worker Session × N                 │
│  14 个调度工具            11 个干活/报告工具                 │
└───────────────┬─────────────────────┬──────────────────────┘
                │ 工具调用              │ 工具调用
┌───────────────▼─────────────────────▼──────────────────────┐
│ 程序层（Engine，纯逻辑，无 DSH 依赖）                        │
│  Engine ─┬─ Tickets   票的五个阶段                           │
│          ├─ Intake    去重、归属、扇出                       │
│          ├─ Bus       消息与投递                             │
│          ├─ Budget    用量累计                               │
│          ├─ Gates     闸与三条死锁规则                        │
│          ├─ Directory 两级匹配                               │
│          ├─ Coalitions 小群                                 │
│          └─ Evals     候选评估                               │
└───────────────┬────────────────────────────────────────────┘
                │ 读写
┌───────────────▼────────────────────────────────────────────┐
│ 存储层（SQLite，每个 scope 一个库）                          │
│  ticket / message / worker / coalition / gate / effect      │
│  thread / audit / usage / kv                                │
└────────────────────────────────────────────────────────────┘
```

**关键约束**：只有 Engine 写存储层。会话层只能通过工具调用让 Engine 写。这是设计选择，理由见 [README §Why the Engine is the only writer](README.md#why-the-engine-is-the-only-writer)。

---

## 二、一张票的一生

```
                    ┌──────────┐
  人提交任务 ──────► │ waiting  │  ← 建票但还没派出去（或没有可用 worker）
                    └────┬─────┘
                         │ ticket.assign
                    ┌────▼─────┐
                    │ working  │  ← worker 正在干
                    └────┬─────┘
             ┌───────────┼───────────┐
             │           │           │
        report      report       ask(gate)
        progress    ready        blocked
             │           │           │
             ▼           │      ┌────▼────┐
        ┌────────┐       │      │ person  │ ← 等人决策
        │  idle  │       │      └────┬────┘
        └───┬────┘       │           │ 人裁决
            │            │           ▼
      继续干活           │      回到 working
            │            │
            └────────────┤
                         ▼
                   ┌──────────┐
                   │  ended   │
                   └──────────┘
```

**五个阶段**：`waiting` / `working` / `idle` / `person` / `ended`

**五种结局**：`completed` / `dropped` / `merged` / `closed` / `stopped`

- `completed` — worker 说干完了
- `dropped` — worker 说超出范围，交回
- `merged` — 合进了别的票
- `closed` — 人主动关掉
- `stopped` — 人喊停，或预算耗尽

### 结束的语义是"烧掉票，留下会话"

票结束后不再接受输入、杀掉后台任务，但 **worker 会话活着**。所以人追问时能带着完整历史继续——这是常驻 worker 的主要价值。

复活有两条路，语义不同：

| 动作 | 谁能做 | `stopped` 票 | 干什么 |
| --- | --- | --- | --- |
| `revive` | 只有人的消息 | ❌ 抛错 | 恢复原票，沿用原 assignment 和上下文 |
| `retry` | Router（`mesh_ticket_retry`） | ❌ 抛错 | 新开一个 assignment，标 `RETRIED` |

**`stopped` 是唯一永不复活的结局。** 一张被人叫停的票自己爬起来，是最难排查的一类故障，所以它需要人重新提交而不是复活。

---

## 三、Effect 队列：状态与意图同事务

任何改变票状态的操作，都在**同一个事务**里写一条 effect 记录。这是崩溃一致性的来源。

```
事务开始
  ├─ 更新 ticket.stage = 'working'
  └─ 插入 effect(kind='launch', key=ticketId, value={...})
事务提交
```

崩在这两步之间？不可能——SQLite 要么全成要么全败。所以重启后不会出现"票前进了一步但没人被告知"，也不会出现"有投递意图但票没变"。

### 七种 effect

| kind | 干什么 | 并发 | 有序 |
| --- | --- | --- | --- |
| `assess` | 把候选卡投给 Router | 1 | ✅ |
| `launch` | 启动 worker 会话并投递首个消息 | 4 | — |
| `deliver` | 把排队输入投给已在跑的 worker | 4 | — |
| `coalition` | 推进小群一轮 | 2 | — |
| `relay` | 把 worker 的报告转给 Router | 1 | ✅ |
| `notice` | 通知类，不唤醒 Router（`queue` 模式） | 1 | ✅ |
| `sweep` | 清扫过期项，见下 | 1 | — |

`sweep` 一个 effect 干四件事，都在同一事务里：

1. **TTL 过期** — 发布到主题的消息按消费次数到期归档
2. **闸超时** — 超过 `timeoutMin` 仍未裁决的闸升级
3. **候选重排** — 超时未决策的候选重新进 `assess`（带 `requeue:` 前缀的 key）
4. **小群超时** — 到 deadline 的小群先 `merge` 再 `dissolve`，并发通知

把四件事合成一个 effect 而不是四个，是因为它们都是"定期检查"，分四个只会让每轮多四次查询。

### `Later`：区分"暂时不能"和"失败了"

这是 effect 机制里最重要的一个区分：

```ts
throw new Later('no temp slot')      // 暂时不能：不计失败，下轮重试
throw new Error('boom')              // 真失败：退避重试，累计健康度
```

如果把"槽位满了"当失败，每次排队都在拉低健康度，最后整个系统看起来像病了。`Later` 让排队成为一种正常状态。

`/mesh/api/health` 的 `effects.waiting` 统计的就是排队的 effect。**循环活着但 waiting 一直涨，说明槽位或目标会话忙，不是循环慢。**

---

## 四、Pass 循环

```
每 2 秒（intervalMs）              或有新活时立即 kick
        │                                  │
        └──────────────┬───────────────────┘
                       ▼
              ┌─────────────────┐
              │ 1. flushUsage   │  内存累加的用量批量落库（一次 fsync）
              ├─────────────────┤
              │ 2. kickEffects  │  捞到期 effect，按 kind 并发执行
              ├─────────────────┤
              │ 3. checkBudgets │  超预算的票停掉
              └─────────────────┘
```

**为什么是"心跳 + kick"而不是纯心跳**：交互路径（人提交任务、worker 报告）不能等 2 秒。`submit()` 和 `report()` 结束时都调 `effects.kick()`，立即跑一轮。

**为什么用量要批量 flush**：`node:sqlite` 是同步的，且 `synchronous=FULL` 每次提交都 fsync。如果每条 assistant 消息都写库，所有 worker 会一起卡在这个线程上。所以内存累加，pass 时一次写完。

---

## 五、消息投递路径

```
worker 调 mesh_tell / mesh_ask / mesh_publish
        │
        ▼
   Bus.send()  ── 写一条 message 记录（pending）
        │
        ▼
   找收件人
        │
   ┌────┴─────┐
   │          │
有明确 to   按 topic
   │          │
   │          ▼
   │     查 thread.subscribers
   │          │
   └────┬─────┘
        ▼
  有订阅该 thread 的活跃票？
        │
   ┌────┴─────┐
   │是        │否
   ▼          ▼
直接投给     进 Router
那个 worker   （走 assess）
（零推理）
```

**"直接投递"是 Router 不在热路径上的实现**。一个 thread 已经有票在跟，新消息就该直接到那个 worker，不需要 Router 再判断一次——那是纯浪费。

---

## 六、闸（Gate）与三条死锁规则

闸是"必须有人签字才能继续"。它最容易写出死锁，所以三条规则写在代码里，不靠约定：

**规则一：被挂起的持有者不能签字。** 如果 worker A 的票停在等 B 裁决，而 B 的票又在等 A，两个都动不了。所以签字前先查：这个持有者自己是不是在等别人。

**规则二：升级目标不能是当事方。** 裁决者不能是本票的参与者，否则等于自己给自己签字。

**规则三：环和超深直接升级，不等待。** DFS 检测环，深度上限 3。检测到就交给 Router 或人，不进入等待——等待一个环是永远等不到。

**一张票同时只能有一个 open gate。** 并行闸是死锁温床，而"必须两个人同时签字"在 Mesh 里没有真实场景：所有 worker 都是同一个模型，两个签字不比一个更可信。

### 闸的生命周期

```
   worker 提 mesh_ask(gate:true)
              │
              ▼
        ┌──────────┐
        │ pending  │ ← 票进入 person 阶段
        └────┬─────┘
             │
      ┌──────┼──────┐
      │      │      │
   approve reject 超时/环
      │      │      │
      ▼      ▼      ▼
  approved rejected escalated
      │      │      │
      └──────┴──────┘
             │
       票回到 working
```

`reject` 时**必须给 alternative**，否则 worker 只知道不能做，不知道该做什么。

---

## 七、小群（Coalition）的两种形态

小群是"几个 worker 就一个问题各出一份答案，程序合并"。**没有自由讨论**——讨论的 token 成本不可控。

### 形态 A：预写剧本

轮次和问题在创建时就定好：

```yaml
script:
  - speakerKind: researcher
    ask: "有哪些风险？"
    schema: "risks[]"
  - speakerKind: reviewer
    ask: "这些风险严重吗？"
    schema: "severity"
```

适用：问题形状在开始前就清楚。

### 形态 B：空剧本（默认）

剧本为空时，所有成员回答同一个问题，程序合并字段：

```
propose(question="这个方案有什么风险", members=[r1, c1])
    ↓
每个成员回答一次（round 1）
    ↓
程序合并所有 fields → outputs
    ↓
dissolved
```

适用：不知道答案长什么样。这是更常见的诚实默认。

### 状态机

```
proposed ──approve──► approved ──► round ──► merging ──► dissolved
   │                                  ▲          │
   │                                  └──再来一轮─┘
   │                                             
   └──（inferredBlocking=false 时只通知，不阻塞）
```

预算到 `coalitionSoft`（默认 80%）时开始收敛，到 100% 强制 dissolved。

---

## 八、工作区隔离的实现

```
apply(config)
  │
  ├─ cwd = config.workspace ?? process.cwd()
  ├─ scope = config.scope ?? workspaceScope(cwd)
  └─ stateDir = config.stateDir ?? ~/.dsh/state/mesh-<scope>
        │
        ▼
   Engine({ store, effects, scope })
        │
        ├─ residentWorkerId(kind) → mesh-<scope>-<kind>-1
        ├─ tempWorkerId(ticket)   → mesh-<scope>-temp-<ticket>
        └─ routerSessionId()      → mesh-<scope>-router
```

`workspaceScope` 做的事：

```ts
// 归一化：分隔符折叠、大小写折叠、去尾部斜杠
"D:\CodeSpace\Repo-A"  ─┐
"d:/codespace/repo-a"  ─┼─► "d:/codespace/repo-a" ─► FNV-1a hash ─► "yv5qr8"
"D:/CodeSpace/repo-a/" ─┘
```

**为什么是哈希而不是路径本身**：id 会出现在 prompt 和审计行里，完整的 Windows 路径在那里是噪音。哈希也保证长度固定。

**为什么归一化**：`D:\a\b` 和 `d:/a/b` 是同一个工作区，如果算成两个 scope，重启后换个写法就找不到原来的会话了。

### 隔离的三个层次

| 层 | 隔离方式 | 强度 |
| --- | --- | --- |
| 会话身份 | id 带 scope 前缀 | 强（DSH 层面不会撞） |
| 状态数据 | 每个 scope 一个 SQLite 库 | 强（物理文件分开） |
| worker 发现 | `pickWorker` 只读本库 | 强（没有共享表可查） |
| 文件系统 | 只靠 Session 的 cwd | **弱**（没有内核沙箱） |

最后一层是真实的边界。见 [README §Multiple workspaces](README.md#multiple-workspaces)。

---

## 九、预算计量

```
assistant/message 事件（含 usage）
        │
        ▼
  observeUsage()  ── 只在内存累加（不能写库，会阻塞所有 worker）
        │
        ▼
  pass 时 flushUsage()  ── 批量写 usage 表（一次 fsync）
        │
        ▼
  checkBudgets()  ── 超限的票 stop
```

**计的是累计用量，不是上下文压力。** 这是最容易搞混的地方：

- `tokenMeter.measure()` 报的是"当前上下文有多满"——这是压力
- 预算需要的是"这张票一生烧了多少"——这是累计

混用会让所有阈值失去意义。`src/core/budget.ts` 用的是后者。

**票预算有 50000 下限。** Router 给预算时常给出盖不住一轮的数（200 这种）。低于下限自动抬升——刹车刹死在快完成的活上，比没刹车更糟。

---

## 十、目录（Directory）的两级匹配

worker 声明"我需要某个专长"时（`mesh_needs`），怎么找到人？

```
"我需要有人看一下 UX"
        │
        ▼
  ① 关键词匹配
     查 WORKER_TEMPLATES 的 keywords
     "@reviewer: ..." 直接命中角色
        │
   ┌────┴────┐
   │命中     │没命中
   ▼         ▼
 直接问    ② Router 挑
            （走 assess）
              │
         ┌────┴────┐
         │挑到了   │没挑到
         ▼         ▼
       派过去   deferred（记下来，等 Router 后续处理）
```

**只有两级，没有中间级。** 设计初稿里有第三级"embedding 相似度匹配"，被砍掉了：关键词 + Router 已经覆盖真实场景，中间那层只会增加不确定性和调试难度。

---

## 十一、代码结构

```
src/
├── core/                 无 DSH 依赖，可脱离 Harness 单测
│   ├── model.ts          zod schema：票、消息、worker、闸、小群
│   ├── store.ts          SQLite：WAL、savepoint、after-commit 回调
│   ├── effects.ts        持久化 effect 队列 + Later
│   ├── passes.ts         心跳循环
│   ├── engine.ts         命令入口，唯一写者
│   ├── tickets.ts        票的五个阶段
│   ├── intake.ts         去重、归属、扇出
│   ├── bus.ts            消息与投递
│   ├── budget.ts         用量累计
│   ├── gates.ts          闸 + 三条死锁规则
│   ├── directory.ts      两级匹配
│   ├── coalitions.ts     小群
│   └── evals.ts          候选评估
├── app/                  所有 Host 调用都在这里
│   ├── host.ts           Host API 类型声明 + scope/id 派生
│   ├── sessions.ts       会话生命周期、权限、投递
│   ├── resources.ts      mesh_read 能读什么
│   ├── prompts.ts        prompt 组装（前缀稳定）
│   ├── http.ts           HTTP API
│   ├── watchdog.ts       每小时巡检
│   └── tools/
│       ├── tool.ts       工具包装（zod → JSON Schema）
│       ├── main.ts       Router 的 14 个工具
│       └── executor.ts   worker 的 11 个工具
├── executor/dsh.ts       worker 启动与投递
└── index.ts              插件入口、启动顺序、effect handler 注册
```

**这个分层的意义**：`core/` 可以完全脱离 DSH 测试。107 个单测里绝大部分不需要启动 Harness，因为状态机是纯逻辑。

`app/` 和 `executor/` 里每一个 Host 调用都是踩过坑才写对的，那些坑记在 [README §Six Host facts](README.md#six-host-facts-that-cost-real-debugging-time)。

---

## 十二、启动顺序（以及为什么是这个顺序）

```
apply()
  └─ ctx.inject([必需服务], async injected => {
       ① boot()        建 Store / Engine / Effects，纯内存，快
       ② 注册 effect handler   ← 必须在任何命令之前
       ③ observeUsage()       ← 挂 session/event 监听
       ④ passes.start()       ← 循环开始跑
       ⑤ bringUp()            ← 建 Router 和常驻 worker（最慢，最后做）
       ⑥ mountApi()           ← HTTP 路由
       ⑦ installWatchdog()    ← 需要 Router 会话存在
     })
```

**为什么 Router 最后建**：它最容易失败（依赖 preset、权限、workspace 注册）。如果先建它再建 Store，失败会留下一个半成品。现在的顺序是：即使 ⑤ 全失败，①②③④ 仍然工作，`/mesh/api/health` 仍然能告诉你哪里坏了。

**为什么整个回调必须 `async`**：Cordis 的 fiber 在同步回调返回后立即失活，之后任何 Host 调用都抛 `inactive context`。这是踩过的坑，不是风格选择。
