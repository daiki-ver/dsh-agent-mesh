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

**这个地址就是 Mesh 的界面。** 用浏览器打开它，你会在左侧会话列表看到三个会话：

| 会话 | 角色 | 说明 |
| --- | --- | --- |
| `mesh-router` | Router | 调度面。它决定"这是什么活、派给谁"，自己不动手 |
| `mesh-researcher-1` | 常驻 worker | 只读权限，负责调研、读代码、比较方案 |
| `mesh-coder-1` | 常驻 worker | 可写权限，负责改文件、验证改动 |

想换端口加 `--port 3099`，不想自动开浏览器加 `--no-open`。

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

浏览器打开 Mesh 界面，点 `mesh-router` 会话，像平时聊天一样说你要什么。

Router 会自己决定：**建票派给 worker**，还是**自己直接回答**。实测中它判断"1+1 等于几"这种问题不值得花一张票，会直接答并说明理由——这是设计意图，不是偷懒。

### 方式 C：`--profile mesh` 之后用 DSH 自己的界面

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

`/mesh/api/health` 的两个关键字段：

- `pass.alive: true` — 调度循环在跑
- `effects.waiting` — 有多少活卡在队列里

**如果 `alive` 是 true 但 `waiting` 一直大于 10**，问题不在循环速度，在槽位或目标会话忙。调 `pass.intervalMs` 没用。

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

## 六、改代码之后

```bash
cd D:/CodeSpace/DSH-AgentMesh/dsh-agent-mesh

pnpm typecheck    # 类型检查
pnpm test         # 96 个单测
pnpm build        # 构建到 lib/

# 或者一次跑完
pnpm check
```

改完代码**必须重新 build**，因为 DSH 加载的是 `lib/index.mjs`，不是 `src/`。

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

改 `cordis.patch.yml` 里 `mesh-engine` 的 `config`：

```yaml
- id: mesh-engine
  name: dsh-agent-mesh
  config:
    stateDir: ~/.dsh/state/mesh
    pass:
      intervalMs: 2000          # 调度心跳，2 秒
    executor:
      residentWorkers: 2        # 常驻 worker 数量（researcher + coder）
      tempSlots: 2              # 临时 worker 并发上限
    budget:
      coalitionSoft: 0.8        # 小群预算用到 80% 时收敛
    watchdog:
      enabled: true
      everySeconds: 3600        # 每小时巡检一次
```

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
