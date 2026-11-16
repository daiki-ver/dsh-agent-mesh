# dsh-agent-mesh

A DSH bundle that turns one Router Session plus typed Worker Sessions into a disciplined mesh.

The Router decides what work exists and who gets it. Workers do the work in their own Sessions. Everything in between — the ticket, the message bus, the budget ledger, the audit log — is program state in one SQLite database, so the Router is never on the hot path and never pays to forward a message.

- **New here?** Read [USAGE.md](USAGE.md) — three commands to a running mesh.
- **Deciding whether to adopt it?** Read [What each piece actually buys](#what-each-piece-actually-buys) and [Known limits](#known-limits) first.
- **Changing the code?** Read [The five rules](#the-five-rules), then [ARCHITECTURE.md](ARCHITECTURE.md) for how it actually runs, then [Development](#development).

## Why this exists

Two things in DSH are individually good and jointly incomplete:

- A single agent with every tool does everything adequately and nothing well. It has no notion of "this task wants a reviewer, not a coder".
- A subagent spawn gives you a typed worker, but not a lifecycle, a message bus, or a budget.

Mesh adds exactly the three things subagent does not have: **independent Session lifecycle**, **cross-worker messaging**, and **per-ticket token accounting**. Everything else is deliberately left out until evidence says it is needed (see [Scope discipline](#scope-discipline)).

## Install

```bash
# From the checkout. Use a Windows-style path on Windows: Git Bash rewrites /d/ to /c/d/.
dsh plugin --profile mesh add "link:D:\\CodeSpace\\DSH-AgentMesh\\dsh-agent-mesh"

# Verify the layer actually loaded — this is the check that catches a broken patch
dsh --profile mesh --dump-config | grep -c mesh-engine          # must be >= 1
dsh --profile mesh --dump-config 2>&1 >/dev/null | grep -i "unknown\|skipped"   # must be empty
```

The second check matters: a `cordis.patch.yml` row without the `- insert:` wrapper is treated as an override patch, finds no target, and is **skipped silently**. `grep -c` is what catches that.

Then boot it:

```bash
dsh --profile mesh
```

It prints a token-bearing URL; open it to get the mesh UI with its three Sessions. The status API is mounted at `/mesh/api/`.

> **The `mesh` profile requires `@deepseek-ai/dsh-web-app`.** `sessionController`, `sessions`, `agents`, and `tools` are all provided by it. A profile with only `dsh-base` has none of them, and Mesh waits on `ctx.inject` forever. See [Why the profile needs web-app](#why-the-profile-needs-web-app).

## The shape

```
profile "mesh"                       scope = hash(workspace), e.g. yv5qr8
├── Router Session (mesh-<scope>-router)
│     └── tools: mesh_read / mesh_route / mesh_eval_* / mesh_ticket_* / mesh_coalition_* / mesh_evidence
├── Engine (this bundle, pure program)
│     ├── Store      one SQLite db per scope: ticket, message, worker, coalition, gate, effect, audit, usage
│     ├── Effects    persistent side-effect queue; state and intent commit together
│     └── Passes     2s beat + immediate kick on new work
├── Workers (own Sessions, own permission preset)
│     ├── resident: mesh-<scope>-researcher-1, mesh-<scope>-coder-1
│     └── temp:     mesh-<scope>-temp-<ticketId>, burned with the ticket
└── Watchdog         hourly schedule into the Router; reports anomalies, kills nothing
```

The `scope` is what lets several workspaces run their own team on one host. It is derived from the workspace path, so ids are stable across restarts and distinct per directory. See [Multiple workspaces](#multiple-workspaces).

## The five rules

These are load-bearing. Breaking one is a design failure, not a bug.

1. **The Engine is the only writer.** A worker never writes the database. State changes go through one command, one transaction, one audit row. This is a *choice*, not a physical limit — Sessions share this process — and it buys audit completeness, crash consistency, and a place to enforce budgets. See [Why the Engine is the only writer](#why-the-engine-is-the-only-writer).

2. **The Router has no shell and no file write.** This is a deliberate deviation from the superagent prototype, whose Router keeps a full shell. Every tool the Router carries is paid for on every routing decision, so its toolset stays minimal. If you find the Router cannot run a command, that is the design.

3. **The Router is off the hot path.** A message on a thread with a live subscribed ticket goes straight to that worker with zero inference. Only unattributed messages reach the Router.

4. **An adjudicator is never weaker than the parties.** Procedural conflicts (deadlock, budget, TTL, a cycle) go to the Router. A substantive disagreement between workers goes to a reviewer, and a reviewer that is a party to the ticket is skipped in favour of a person.

5. **A ticket's preset is locked at creation.** A Session keeps the preset it was created with, and resuming a persisted Session fails if that preset is gone. The preset rows in `cordis.patch.yml` are a hard dependency.

## The two surfaces

Mesh has exactly two tool surfaces, and which one you are looking at tells you what kind of Session you are in.

**Router surface — 14 tools, all scheduling.** No shell, no file write, no subagent.

| Tool | What it answers |
| --- | --- |
| `mesh_read` | Read mesh state: tickets, threads, messages, workers, coalitions, gates, usage, audit, state, directory, prompts, settings |
| `mesh_route` | Act on queued work: `accept` (spec becomes the ticket contract), `ignore`, `stop`. Batches up to 20 |
| `mesh_eval_read` | Read the candidate waiting for a routing decision |
| `mesh_eval_decide` | Decide an inferred candidate: accept or ignore |
| `mesh_ticket_status` | Ask a worker for a status update |
| `mesh_ticket_note` | Send guidance to a ticket's worker |
| `mesh_ticket_retry` | Retry an ended ticket on the same Session, continuing from its state |
| `mesh_thread_unsubscribe` | Stop routing a thread to a ticket |
| `mesh_coalition_propose` | Assemble a temporary group for one question |
| `mesh_coalition_approve` | Approve a proposed coalition |
| `mesh_gate_escalate_decide` | Decide a gate that escalated to a person or the Router |
| `mesh_settings_save` | Persist a settings override |
| `mesh_prompts_save` | Persist a prompt override, with a revision |
| `mesh_evidence` | Count how often each subsystem was actually needed |

**Worker surface — 11 tools, all doing or reporting.**

| Tool | What it answers |
| --- | --- |
| `mesh_read` | Read mesh state and ticket detail |
| `mesh_report` | Report on a ticket. **`result` carries the deliverable** |
| `mesh_ack` | Acknowledge a message |
| `mesh_tell` | One-way message to another worker |
| `mesh_ask` | Ask another worker; `gate: true` parks the ticket |
| `mesh_needs` | Declare a specialty you lack; advisory, does not block |
| `mesh_publish` | Broadcast a short summary to a topic |
| `mesh_subscribe` | Subscribe to a topic |
| `mesh_gate_decide` | Decide a gate someone raised to you |
| `mesh_coalition_answer` | Answer a coalition question |
| `mesh_handback` | Give a ticket back because it exceeds your authority |

Everything else a worker needs — shell, files, search, compaction — comes from the `mesh-worker` preset, not from Mesh.

## The HTTP API

Read-only except one route. Mounted through the Host's route table, not by listening on its `request` event: the Host owns that event, and two handlers writing one response throws `ERR_HTTP_HEADERS_SENT`, which takes the process down.

| Route | Method | Returns |
| --- | --- | --- |
| `/mesh/api/state` | GET | Overview: ticket counts, workers, sessions, effect health, pass state |
| `/mesh/api/health` | GET | The two stall signals, plus a `diagnosis` string |
| `/mesh/api/tickets` | GET | Ticket list with stage, kind, mandate, gates, goal |
| `/mesh/api/workers` | GET | Worker records |
| `/mesh/api/coalitions` | GET | Coalition list with round and budget |
| `/mesh/api/gates` | GET | Gate list |
| `/mesh/api/usage` | GET | Token usage, filterable by `?scope=` and `?id=` |
| `/mesh/api/audit` | GET | Audit rows, `?limit=` (default 100) |
| `/mesh/api/evidence` | GET | The four evidence counters |
| `/mesh/api/task` | **POST** | Accept a task from a person |

```bash
# The one write route: this is how work enters the mesh
curl -X POST localhost:3080/mesh/api/task \
  -H "content-type: application/json" \
  -d '{"text":"统计 src 下有多少个 .ts 文件"}'
# -> {"thread":"thread:human-...","disposition":"stored","assessed":true,"ticketIds":[]}
```

`/mesh/api/health` reports `pass.sinceLastPassMs` (is the loop alive?) and `effects.waiting` (is work stuck behind a `Later`?). **If the loop is alive but effects are waiting, raising `pass.intervalMs` will not help** — the bottleneck is a busy slot or a busy target Session. That distinction is the whole reason the route exists.

## Scope discipline

Mesh ships three subsystems that a smaller design would omit. Each is gated on evidence, not enthusiasm:

| Subsystem | Gate before relying on it |
| --- | --- |
| `mesh_needs` (capability directory) | ≥ 5 real requests that needed a peer |
| Gates (mandatory consultation) | ≥ 3 real disagreements or out-of-scope changes |
| Coalitions (temporary groups) | ≥ 3 questions that genuinely needed 3+ viewpoints |

`mesh_evidence` reports these counts from the audit log. The counts are the point: a subsystem nobody uses is complexity you are paying for and not collecting on.

The subsystems are implemented, tested, and reachable — they are simply not advertised in the prompts. Nothing auto-enables them: `mesh_needs` runs only when a worker calls it, a gate opens only when a dispatch artifact lists `gates`, a coalition forms only when the Router proposes one. Run for a week, read the counters, then decide whether to guide workers toward them.

## What each piece actually buys

| Piece | Buys | Does not buy |
| --- | --- | --- |
| Typed workers + permission presets | A researcher that cannot write, an ops worker that is the only one with the machine | Better judgement — every worker is the same model |
| Budget ledger | A visible, enforceable ceiling per ticket and per coalition | Cheaper tokens — it makes spend visible, not smaller |
| Message bus | Crash-safe delivery: state and intent commit together | Lower latency — it trades latency for durability |
| Gates | An explicit, audited pause before a plan changes or a page ships | Better decisions — two signatures from one model is one signature |
| Coalitions | Several independent reads merged by a program | Debate — there is no free-form chat, on purpose |
| Reorientation note | Stale beliefs cleared for a few dozen tokens per ticket | Cache hits from residency — see below |
| Workspace scope | Several teams on one host, none able to discover another's workers | Security isolation — see [Multiple workspaces](#multiple-workspaces) |

## The two things people get wrong

**Residency is not a token cache.** A resident worker avoids a cold restart: it keeps its knowledge of the repo, its tool habits, its past failures. It does *not* promise prompt-cache hits, because DSH compaction rewrites the surface, which invalidates the prefix. What preserves the cache is that the per-ticket reorientation note is an *append* — the prefix above it is byte-identical across tickets. Read `src/app/prompts.ts` before optimising anything here.

**Usage is cumulative, not surface pressure.** `tokenMeter.measure()` reports how full the current context is. A budget needs the *sum of `assistant/message.usage` over the ticket's life*. Mixing the two makes every threshold meaningless. `src/core/budget.ts` accumulates in memory and flushes one batch per pass, because `node:sqlite` is synchronous and `synchronous=FULL` fsyncs on commit — writing per assistant message would stall the loop for every worker at once.

## Why the Engine is the only writer

Sessions and Agents are same-process objects. A worker *could* write the database directly; nothing physically stops it. The Engine is the sole writer anyway because:

- **Audit completeness** — one command, one transaction, one audit row. A direct write leaves a hole in "who changed what".
- **Crash consistency** — a state change and its side-effect intent commit together. A direct write cannot do both, so a crash leaves either a ticket that advanced with nobody told, or an intent with no state.
- **Budget enforcement** — every dispatch passes through the Engine, so a ceiling can be checked before work starts rather than after it is paid for.

The cost is latency: an in-memory call becomes a database write plus a pass. That is what `submit()` calling `effects.kick()` is for — interactive paths never wait for the beat.

## Why the profile needs web-app

`sessionController`, `sessions`, `agents`, `tools`, and `permissionPresets` are all published by `@deepseek-ai/dsh-web-app`, not by `dsh-base`. There is no in-box bundle that provides only the session services. So the `mesh` profile carries the whole web UI plugin set:

- The cost is a heavier startup and web plugins Mesh never calls.
- The alternative — no web-app — means no Sessions at all, and Mesh waits on `ctx.inject` forever with no error.

The npm build of `dsh-web-app` is `0.0.1-rc.1` while DSH is `0.2.2-rc.1`, so adding it needs `dsh plugin allow-version` once.

## Multiple workspaces

Each workspace gets its own team, with no visibility between them. This is verified, not intended: see the isolation table in [USAGE.md §多工作区](USAGE.md).

```yaml
# patch-a.yml
- insert:
    - id: mesh-engine
      name: dsh-agent-mesh
      config:
        workspace: D:\\CodeSpace\\repo-a
```

Only `workspace` needs setting; `stateDir` and `scope` derive from it.

**Why ids are scoped at all.** DSH resolves a Session by id alone and allows one active writer per id. With hardcoded ids the second workspace fails at startup:

```
cannot resolve session mesh-router: session/writer-held
```

`workspaceScope()` hashes the normalised absolute path — separators and case folded, trailing separator ignored — so the scope is stable across restarts (a resumed Session is found again) and distinct per directory, while short enough to read inside an id (`mesh-yv5qr8-router`).

**The isolation is logical, not a security boundary.** A worker in one workspace cannot see or address another's workers: `mesh_tell` / `mesh_ask` read the local worker table, and `pickWorker` reads the local store, so there is no shared table to filter. But the filesystem is confined only by the Session's `cwd`, not by a kernel sandbox — a coder that hardcodes another repo's absolute path can still read it. If you need "must not be able to read another repo", that is a DSH sandbox policy, not a Mesh feature.

## Configuration

Every field, with its default:

```yaml
- id: mesh-engine
  name: dsh-agent-mesh
  config:
    workspace: null            # default: process.cwd(); the Session working directory
    scope: null                # default: hash(workspace); overrides the id namespace
    stateDir: null             # default: ~/.dsh/state/mesh-<scope>
    pass:
      intervalMs: 2000         # fallback beat; a kick makes interactive paths immediate
    executor:
      residentWorkers: 2       # researcher + coder; each costs a live Session
      tempSlots: 2             # concurrency for per-ticket workers
      prepareTimeoutMs: 600000 # background work left after a turn is killed after this
    budget:
      coalitionSoft: 0.8       # a coalition converges at 80% of its budget
    coalitions:
      inferredBlocking: false  # an inferred coalition notifies, it does not block
    eval:
      model: null              # reserved; currently every Session uses the default model
      timeoutMs: 300000        # a candidate with no decision by now is re-queued
    watchdog:
      enabled: true
      everySeconds: 3600
```

Two notes that are not obvious from the field names:

**Two slot pools, not one.** A resident worker holds a reserved slot for its lifetime and does not compete with tickets, so adding a resident does not shrink the number of tickets that can run at once.

**`eval.model` does nothing yet.** The field is reserved for session-local model selection. Until it is wired, every Session uses the profile's default model.

**Ticket budgets are floored at 50,000 tokens.** A Router asked to size a budget answers with numbers too small to cover one turn — 200 is a plausible guess and a guaranteed false alarm. `MIN_TICKET_BUDGET` raises anything below it, because a brake that stops work which would have finished is worse than no brake.

## Development

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm build        # tsdown -> lib/
pnpm check        # all three
```

`src/core/` has no DSH dependency and is fully unit-tested. `src/app/` and `src/executor/` hold every Host call. That split is what lets the state machine be tested without a running Harness.

**`pnpm build` is not optional.** DSH loads `lib/index.mjs`, not `src/`. Editing TypeScript without rebuilding changes nothing at runtime, which is a confusing way to spend twenty minutes.

Set `MESH_TRACE=1` to append startup checkpoints to `<stateDir>/mesh-boot.log`. The Host captures plugin logs into its own diagnostics file, which makes startup order hard to see; this trace is one line per checkpoint, and the last line written is the step that failed.

### Six Host facts that cost real debugging time

Each of these produced a failure that no unit test could catch, because each lives at a seam between Mesh and the Host.

1. **`ctx.inject`'s callback must be `async`, and every Host call must happen inside it.** A synchronous body completes immediately, the fiber deactivates, and any later Host call throws `cannot get required service "x" in inactive context`. All of `bringUp` is awaited inside the callback for this reason.

2. **The Context is a proxy that rejects unknown property writes.** `ctx.mesh = {...}` throws. Runtime handles live in a module-level `Map` keyed by `stateDir`.

3. **Optional services need their own nested `ctx.inject`.** Reaching for `ctx.schedule` or `ctx.webServer` from a context that never declared it throws `cannot get property "x" without inject`. The Watchdog and the HTTP API each mount through a nested inject so a profile without them still runs.

4. **`sessionController.prompt(request, signal)` requires the signal.** The Host calls `throwIfAborted()` before admitting a prompt; passing nothing throws a `TypeError` that surfaces as a failed effect rather than a delivery. `mode` accepts only `'queue' | 'steer'` — `{inject}` has no wire form and maps to `queue`.

5. **A worker's closing message never leaves its Session.** The Router only sees what `mesh_report` sends. This is why the assignment message spells out the contract ("put the deliverable in `result`, or this ticket never completes") instead of mentioning reporting in passing, and why a `ready` report relays its result back to the Router.

6. **Three preset plugins have `required()` fields with no default.** `tool-fs-search.sampleOverCapGlobResults`, `tool-todo.allowParallelInProgress`, and `tool-subagent.provider` must be set or **the whole worker Session fails to create**. `tool-subagent` is omitted from the worker preset for this reason: its `provider` needs a registered provider bundle that the default profile does not have.

## Known limits

- **One open gate per ticket.** Parallel gates are a deadlock breeding ground, and two signatures from one model are not stronger than one.
- **Coalition scripts are usually empty.** A script is valid only when the shape was known up front; an empty one collects one answer per member and merges the fields, which is the honest default when the shape is not known.
- **The Watchdog reports, never acts.** A timer that kills things is how you lose a nearly-finished ticket.
- **`engines.dsh` pins a minor range.** SemVer rejects `0.2.3-rc.1` for a `>=0.2.2-rc.1 <0.2.3` range, so a Host minor bump needs this line raised deliberately.
- **Isolation is logical, not a sandbox.** See [Multiple workspaces](#multiple-workspaces).
- **No migration path yet.** The store is schema v1 with a `migrate()` hook reserved; there is no v2 to migrate to.
- **`eval.model` is not wired.** Every Session uses the profile's default model.
- **The desktop app cannot load Mesh.** The `desktop` profile is managed exclusively by the Electron app (`error: profile "desktop" is managed exclusively by the Electron application`), so Mesh runs as its own instance on its own port. The two coexist.
