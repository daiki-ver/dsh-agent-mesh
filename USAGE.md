# 怎么用 Mesh

三条命令就能跑起来。下面的每一步都在你这台机器上实测过（dsh 0.2.2-rc.1，`D:\Program Files\DSH`）。

## 一、启动

```bash
"D:/Program Files/DSH/resources/runtime/cli/bin/dsh.cmd" --profile mesh
```

启动后终端会打印一行带 token 的地址，类似：

```
dsh web: http://127.0.0.1:3080/?token=xxxxx
```

**这个地址就是 Mesh 的界面。** 用浏览器打开它，你会在左侧会话列表看到三个会话。

会话名带一个工作区前缀（`scope`），因为它由工作区路径派生，让多个工作区能各自跑一套 team 而不撞名：

| 会话 | 角色 | 说明 |
| --- | --- | --- |
| `mesh-<scope>-router` | Router | 调度面。它决定"这是什么活、派给谁"，自己不动手 |
| `mesh-<scope>-researcher-1` | 常驻 worker | 只读权限，负责调研、读代码、比较方案 |
| `mesh-<scope>-coder-1` | 常驻 worker | 可写权限，负责改文件、验证改动 |

`<scope>` 是工作区路径的短哈希，例如工作区 `D:\CodeSpace\DSH-AgentMesh` 对应 `mesh-yv5qr8-router`。**这个名字在重启后不变**，所以历史会话能接上。

想换端口加 `--port 3099`，不想自动开浏览器加 `--no-open`。

不想猜 scope 是什么，直接查：

```bash
curl -s localhost:3080/mesh/api/state | python -c "import json,sys;print([s['sessionId'] for s in json.load(sys.stdin)['sessions']])"
```

## 二、交活给 Mesh

有三种方式，按顺手程度排序。

### 方式 A：HTTP 接口（最快，适合脚本）

```bash
curl -X POST localhost:3080/mesh/api/task \
  -H "content-type: application/json" \
  -d '{"text":"统计 src 目录下一共有多少个 .ts 文件"}'
```

返回：

```json
{
  "thread": "thread:human-xxx",
  "disposition": "stored",
  "assessed": true,
  "ticketIds": []
}
```

`assessed: true` 意思是 Router 已经收到并开始判断了。

### 方式 B：直接在 Router 会话里说

浏览器打开 Mesh 界面，点 `mesh-<scope>-router` 会话，像平时聊天一样说你要什么。

Router 会自己决定：**建票派给 worker**，还是**自己直接回答**。实测中它判断"1+1 等于几"这种问题不值得花一张票，会直接答并说明理由——这是设计意图，不是偷懒。

### 方式 C：用 DSH 原生界面

Mesh 界面本身就是标准 DSH 界面，工具、文件、审批都是原生的。

## 三、看进度

```bash
# 总览：pass 循环是否活着、effect 队列是否堵塞
curl -s localhost:3080/mesh/api/health

# 票列表
curl -s localhost:3080/mesh/api/tickets

# 每个 worker / 每张票烧了多少 token
curl -s localhost:3080/mesh/api/usage

# 完整审计流水（谁在什么时候改了什么）
curl -s localhost:3080/mesh/api/audit
```

### 全部接口

| 接口 | 方法 | 返回 |
| --- | --- | --- |
| `/mesh/api/state` | GET | 总览：票数、worker、会话、effect 健康、pass 状态 |
| `/mesh/api/health` | GET | 两个卡死信号 + `diagnosis` 结论 |
| `/mesh/api/tickets` | GET | 票列表（阶段、kind、mandate、gate 数、goal） |
| `/mesh/api/workers` | GET | worker 记录 |
| `/mesh/api/coalitions` | GET | 小群列表（轮次、预算） |
| `/mesh/api/gates` | GET | 闸列表 |
| `/mesh/api/usage` | GET | token 用量，可加 `?scope=` / `?id=` 过滤 |
| `/mesh/api/audit` | GET | 审计流水，可加 `?limit=`（默认 100） |
| `/mesh/api/evidence` | GET | 四个证据计数器（gate/needs/coalition/escalate 各被用了几次） |
| `/mesh/api/task` | **POST** | 接受一个人提交的任务（唯一的写接口） |

`/mesh/api/health` 的两个关键字段：

- `pass.sinceLastPassMs` — 上次心跳距今多少毫秒。小于 30000 算活着
- `effects.waiting` — 有多少活卡在队列里

**如果循环活着但 `waiting` 一直大于 10**，问题不在循环速度，在槽位或目标会话忙。调 `pass.intervalMs` 没用——这是这个接口存在的全部理由。

### 两个最有用的查询

**看谁在烧钱**（按 scope 分组看总量）：

```bash
curl -s "localhost:3080/mesh/api/usage" | python -c "
import json,sys
for u in json.load(sys.stdin):
    total = u['inputTokens'] + u['outputTokens']
    print(f\"{u['scope']:8} {u['scopeId'][:38]:38} {total:>8} tokens\")
"
```

**看证据计数**（决定要不要启用 Needs/Gates/Coalitions）：

```bash
curl -s localhost:3080/mesh/api/evidence
```

返回形如 `{"gate":{"count":0,"threshold":3},...}`。**跑一两周再看这个**，不要凭感觉决定。

## 四、一次完整的活长什么样

实测记录（真实发生，不是示意）：

```
1. 你: curl POST "统计 src 目录下一共有多少个 .ts 文件"
2. Router 收到候选卡 → 判断这是调研活 → 建票，选 researcher
3. researcher 用 pwsh 执行 Get-ChildItem 数文件
4. researcher 调 mesh_report，把完整答案放进 result
5. Engine 把答案 relay 给 Router
6. 票状态变 completed，你可以在 /mesh/api/tickets 看到
```

第 4 步是关键：worker 的**结束语只留在自己的会话里**，Router 看不到。所以答案必须走 `mesh_report` 的 `result` 字段。这条纪律已经写进每个 worker 的启动消息里了。

实际答案长这样：

```
Total: 24 .ts files under src (recursive, all subdirectories)
Per-directory breakdown:
src                     1
src/app                 6
src/app/tools           3
src/core               13
src/executor            1
TOTAL                  24
```

## 五、桌面端能用吗

**不能直接加载。** 我实测过：

```
$ dsh --profile desktop --patch ./mesh-on-desktop.yml --dump-config
error: profile "desktop" is managed exclusively by the Electron application
```

`desktop` profile 由 Electron 应用独占管理，CLI 改不了。所以：

- **桌面端**：你平时用的那个窗口，跑的是 `desktop` profile，里面没有 Mesh
- **Mesh**：必须用命令行 `--profile mesh` 单独启动，它会开自己的界面

两者可以**同时运行**，互不干扰（不同端口、不同状态目录）。实际用法就是：平时用桌面端干活，需要 Mesh 调度多 agent 时开一个 mesh 实例。

## 五点五、工具速查

你不需要记这些——Router 和 worker 自己会选。但**调试时知道有什么工具**能少走弯路。

### Router 有 14 个工具，全是调度，没有 shell

| 工具 | 干什么 |
| --- | --- |
| `mesh_read` | 读状态：tickets / ticket/&lt;id&gt; / thread/&lt;key&gt; / message/&lt;id&gt; / workers / coalitions / gates / usage / audit / state / directory / prompts / settings |
| `mesh_route` | 核心。`accept` 建票（你写的 spec 就是合同）、`ignore` 丢弃、`stop` 终止。一次最多 20 条 |
| `mesh_eval_read` | 读等待决策的候选 |
| `mesh_eval_decide` | 决策候选：accept / ignore |
| `mesh_ticket_status` | 问 worker 要进度 |
| `mesh_ticket_note` | 给票上的 worker 发指导 |
| `mesh_ticket_retry` | 重试已结束的票，沿用原会话 |
| `mesh_thread_unsubscribe` | 停止把某个 thread 路由给票 |
| `mesh_coalition_propose` | 组临时小群 |
| `mesh_coalition_approve` | 批准小群启动 |
| `mesh_gate_escalate_decide` | 裁决升级到人的闸 |
| `mesh_settings_save` | 存设置覆盖 |
| `mesh_prompts_save` | 存 prompt 覆盖（带 revision） |
| `mesh_evidence` | 看四个子系统各被真实用了几次 |

**Router 没有 shell、不能写文件、不能开 subagent。** 这不是缺功能，是设计——它每多一个工具，每次路由决策都要为它付 token。

### Worker 有 11 个工具，全是干活或报告

| 工具 | 干什么 |
| --- | --- |
| `mesh_read` | 读状态和票详情 |
| `mesh_report` | **最重要的一个。`result` 字段装交付物本身** |
| `mesh_ack` | 确认收到消息 |
| `mesh_tell` | 给别的 worker 发单向消息 |
| `mesh_ask` | 问别的 worker；`gate: true` 会让票停下等答复 |
| `mesh_needs` | 声明缺某个专长（建议性，不阻塞） |
| `mesh_publish` | 往主题广播短摘要 |
| `mesh_subscribe` | 订阅主题 |
| `mesh_gate_decide` | 裁决别人提给你的闸 |
| `mesh_coalition_answer` | 回答小群的问题 |
| `mesh_handback` | 交回票（超出授权范围时） |

worker 的 shell、文件、搜索、压缩**来自 preset，不来自 Mesh**。

### 调试时最常看的三条

```bash
# 1. Router 到底收到候选了吗
curl -s localhost:3080/mesh/api/audit | grep -E "assess|eval"

# 2. worker 到底报告了吗（没这条就说明卡在 working）
curl -s localhost:3080/mesh/api/audit | grep "ticket.report"

# 3. 派发出去了吗（没这条说明 pickWorker 找不到人）
curl -s localhost:3080/mesh/api/audit | grep "ticket.assign"
```

## 六、改代码之后

```bash
cd D:/CodeSpace/DSH-AgentMesh/dsh-agent-mesh

pnpm typecheck    # 类型检查
pnpm test         # 107 个单测
pnpm build        # 构建到 lib/

# 或者一次跑完
pnpm check
```

改完代码**必须重新 build**，因为 DSH 加载的是 `lib/index.mjs`，不是 `src/`。改了 TS 不 build，运行时行为一点不变——这是最容易浪费二十分钟的坑。

想干净重测（清掉历史票和会话）：

```bash
# 停掉所有实例
taskkill //F //IM "DeepSeek Harness.exe"

# 清状态（票、消息、审计、预算全部重置）
rm -rf ~/.dsh/state/mesh

# 清会话（Router 和 worker 的对话历史）
rm -rf ~/.dsh/sessions/--D-CodeSpace-DSH-AgentMesh-dsh-agent-mesh--
```

## 七、出问题怎么查

### 看启动有没有成功

```bash
MESH_TRACE=1 dsh --profile mesh
cat ~/.dsh/state/mesh/mesh-boot.log
```

正常应该看到这几行依次出现：

```
apply
inject:enter
inject:booted
inject:exposed
bringUp:enter
bringUp:router-ready
bringUp:resident-researcher
bringUp:resident-coder
inject:ready
watchdog:installed
```

**卡在哪一行，就是哪一步出问题。** 这是排查启动问题最快的方法。

### 看有没有活卡住

```bash
curl -s localhost:3080/mesh/api/state | python -m json.tool
```

看 `effects` 数组里有没有 `waiting > 0` 且 `attempts > 0` 的项——那说明某个 effect 在反复失败，`error` 字段里有原因。

### 看 worker 到底干了什么

worker 的完整对话记录在：

```
~/.dsh/sessions/--D-CodeSpace-DSH-AgentMesh-dsh-agent-mesh--/<sessionId>/session.v4.jsonl.zstd
```

这是**多帧 zstd 追加**文件，`zstdDecompressSync` 只能解第一帧。要按魔数 `28 B5 2F FD` 逐帧解：

```bash
node -e "
const zlib=require('zlib'), fs=require('fs');
const p=process.env.HOME+'/.dsh/sessions/--D-CodeSpace-DSH-AgentMesh-dsh-agent-mesh--/mesh-router/session.v4.jsonl.zstd';
const buf=fs.readFileSync(p), MAGIC=Buffer.from([0x28,0xB5,0x2F,0xFD]);
let pos=0, out='';
while(pos<buf.length){const i=buf.indexOf(MAGIC,pos);if(i<0)break;
 try{out+=zlib.zstdDecompressSync(buf.subarray(i)).toString('utf8')}catch(e){}
 const n=buf.indexOf(MAGIC,i+4);if(n<0)break;pos=n}
out.split('\n').filter(Boolean).forEach(l=>{try{const e=JSON.parse(l);
 if(e.type==='tool/call')console.log('CALL:',e.data.name);
 if(e.type==='user/message')console.log('MSG:',JSON.stringify(e.data.content).slice(0,200));
}catch(x){}});
"
```

把 `mesh-router` 换成 `mesh-researcher-1` 或 `mesh-coder-1` 就能看对应 worker。

## 八、常用配置

改 `cordis.patch.yml` 里 `mesh-engine` 的 `config`。全部字段带默认值：

```yaml
- id: mesh-engine
  name: dsh-agent-mesh
  config:
    workspace: null            # 默认 process.cwd()；worker 会话的工作目录
    scope: null                # 默认 hash(workspace)；只在想固定旧 id 时才设
    stateDir: null             # 默认 ~/.dsh/state/mesh-<scope>
    pass:
      intervalMs: 2000         # 调度心跳；交互路径靠 kick 立即响应，不等心跳
    executor:
      residentWorkers: 2       # 常驻 worker 数（researcher + coder），每个都占一条活会话
      tempSlots: 2             # 临时 worker 并发上限
      prepareTimeoutMs: 600000 # 一轮结束后残留的后台任务，超时被杀
    budget:
      coalitionSoft: 0.8       # 小群预算用到 80% 时开始收敛
    coalitions:
      inferredBlocking: false  # 推断出的小群只通知，不阻塞
    eval:
      model: null              # 预留；目前所有会话都用 profile 默认模型
      timeoutMs: 300000        # 候选超时未决策则重新排队
    watchdog:
      enabled: true
      everySeconds: 3600       # 每小时巡检一次
```

三个不明显的点：

**`workspace` 决定一切。** 它是 worker 的 cwd，也是 scope 的来源，还决定状态库路径。多工作区只需要设这一个字段。

**两个槽位池，不是一个。** 常驻 worker 占的是保留槽，不跟票抢；所以加常驻不会减少能同时跑的票数。

**`eval.model` 目前无效。** 字段留了但没接线，所有会话用 profile 默认模型。

**票预算有 50000 token 下限。** Router 被要求给预算时常给出盖不住一轮的数字（200 这种看着合理、必然误报的数）。低于下限会被自动抬到 `MIN_TICKET_BUDGET`——刹车刹死了比没刹车更糟。

改完要重新 build 才生效吗？**不用** —— `cordis.patch.yml` 是运行时读的，改完重启 `--profile mesh` 即可。

## 九、这套东西的边界

Mesh 不做什么，说清楚比说做什么更有用：

| 不做 | 为什么 |
| --- | --- |
| 不做自由讨论 | 小群（coalition）只有预写剧本或单轮收集，没有来回对话。讨论的 token 成本不可控 |
| 不做并行闸 | 一张票同时只有一个 open gate。并行闸是死锁温床，而两个签字不比一个更可信（都是同一个模型） |
| 不自动杀活 | Watchdog 只报告异常，不重启不终止。定时杀活是丢掉"快完成"的票的最快方式 |
| 不替你决定要不要用 | `mesh_evidence` 会告诉你 gate / needs / coalition 各被真实用了多少次。**先跑一周看数据，再决定要不要在 prompt 里引导 worker 用它们** |

最后一条是认真的。这三个子系统代码写完了、测试覆盖了、能跑，但设计文档的判断是对的：它们占 v1 设计 70% 篇幅，却不是价值来源。价值在**类型化 worker**（researcher 不能写文件，ops 才有机器权限）和**预算可见**（每张票烧多少 token 一目了然）。

现在就在 prompt 里引导 worker 用它们，等于自证需求。

## 十、多工作区：每个工作区一个独立 team

Mesh 支持多个工作区**同时运行**，每个工作区有自己的 Router 和 worker，互相看不到对方。

### 原理

每个实例的身份由工作区路径派生（`workspaceScope`），所有 Session 和 worker id 都带这个前缀：

```
D://CodeSpace//repo-a  →  mesh-yv5qr8-router / mesh-yv5qr8-coder-1
D://CodeSpace//repo-b  →  mesh-187b16q-router / mesh-187b16q-coder-1
状态库:                   ~/.dsh/state/mesh-yv5qr8 / ~/.dsh/state/mesh-187b16q
```

**为什么必须这样**：DSH 按 sessionId 定位会话，且同一 id 只允许一个写入句柄。如果 id 写死成 `mesh-router`，第二个工作区启动就会失败：

```
cannot resolve session mesh-router: session/writer-held
```

### 用法

用 `workspace` 指定工作区，其余走默认：

```bash
# 工作区 A
dsh --profile mesh --patch patch-a.yml --no-open --port 3251

# 工作区 B（可同时运行）
dsh --profile mesh --patch patch-b.yml --no-open --port 3252
```

`patch-a.yml` / `patch-b.yml`：

```yaml
- insert:
    - id: mesh-engine
      name: dsh-agent-mesh
      config:
        workspace: D://CodeSpace//repo-a
        executor: { residentWorkers: 2, tempSlots: 2 }
```

**只需要改 `workspace`**，`stateDir` 和 `scope` 都会自动派生。

### 隔离边界（实测确认）

| 项 | 隔离 | 说明 |
| --- | --- | --- |
| Router 会话 | ✅ | 各自的 `mesh-<scope>-router` |
| worker 会话 | ✅ | 各自的 `mesh-<scope>-<kind>-1` |
| worker 列表 | ✅ | `mesh_tell` / `mesh_ask` 只查本实例的表，跨区不可见 |
| 票与审计 | ✅ | 独立 SQLite 库，不是同一张表加过滤 |
| 预算计量 | ✅ | 各记各的 |
| 会话文件 | ✅ | 按 cwd 分目录存储 |
| 文件系统 | ⚠️ | 各 worker 的 cwd 是自己的工作区，但**没有内核级沙箱隔离** —— 一个 coder 仍可读到别的工作区的绝对路径。要强隔离得靠 `permissionPresets` 或容器 |

**最后一行是重点**：Mesh 的隔离是**逻辑隔离**（身份、状态、发现范围），不是**安全隔离**。A 的 worker 在 `mesh_tell` 里看不到 B 的 worker，但如果它硬编码 B 的绝对路径，文件系统层面是能读到的。

如果你的场景需要"绝对不能读到别的仓库"，那需要在 DSH 层加沙箱策略，Mesh 本身不做这件事。

### 什么时候不该开多个

- **同一个仓库开两个 Mesh**：没有意义，两个 team 会抢同一批文件
- **只是为了省钱**：每个常驻 worker 都是一条活会话，2 个工作区 × 2 常驻 = 4 条会话持续占内存

### 清理

```bash
# 看有哪些工作区的状态
ls ~/.dsh/state/ | grep mesh-

# 删掉某个工作区的状态
rm -rf ~/.dsh/state/mesh-<scope>
```
