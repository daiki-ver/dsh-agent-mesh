# dsh-agent-mesh

A DSH bundle that turns one Router Session plus typed Worker Sessions into a disciplined mesh.

The Router decides what work exists and who gets it. Workers do the work in their own Sessions. Everything in between — the ticket, the message bus, the budget ledger, the audit log — is program state in one SQLite database, so the Router is never on the hot path and never pays to forward a message.

## Why this exists

Two things in DSH are individually good and jointly incomplete:

- A single agent with every tool does everything adequately and nothing well. It has no notion of "this task wants a reviewer, not a coder".
- A subagent spawn gives you a typed worker, but not a lifecycle, a message bus, or a budget.

Mesh adds exactly the three things subagent does not have: **independent Session lifecycle**, **cross-worker messaging**, and **per-ticket token accounting**. Everything else is deliberately left out until evidence says it is needed (see [Scope discipline](#scope-discipline)).

## Install

```bash
# From the checkout
dsh plugin --profile mesh add "link:$PWD"

# Verify the layer actually loaded — this is the check that catches a broken patch
dsh --profile mesh --dump-config | grep -c mesh-engine          # must be >= 1
dsh --profile mesh --dump-config 2>&1 >/dev/null | grep -i "unknown\|skipped"   # must be empty
```

Then boot it:

```bash
dsh --profile mesh
```

The status API answers at `/mesh/api/`:

```bash
curl -s localhost:3080/mesh/api/health
curl -s localhost:3080/mesh/api/state
curl -s localhost:3080/mesh/api/tickets
curl -s localhost:3080/mesh/api/usage
```

## The shape

```
profile "mesh"
├── Router Session (mesh-router)      scheduling plane: routes, assesses, arbitrates
│     └── tools: mesh_read / mesh_route / mesh_eval_* / mesh_ticket_* / mesh_coalition_*
├── Engine (this bundle, pure program)
│     ├── Store      one SQLite db: ticket, message, worker, coalition, gate, effect, audit, usage
│     ├── Effects    persistent side-effect queue; state and intent commit together
│     └── Passes     2s beat + immediate kick on new work
├── Workers (own Sessions, own permission preset)
│     ├── resident: mesh-researcher-1, mesh-coder-1
│     └── temp:     mesh-temp-<ticketId>, burned with the ticket
└── Watchdog         hourly schedule into the Router; reports anomalies, kills nothing
```

## The five rules

These are load-bearing. Breaking one is a design failure, not a bug.

1. **The Engine is the only writer.** A worker never writes the database. State changes go through one command, one transaction, one audit row. This is a *choice*, not a physical limit — Sessions share this process — and it buys audit completeness, crash consistency, and a place to enforce budgets. See [Why the Engine is the only writer](#why-the-engine-is-the-only-writer).

2. **The Router has no shell and no file write.** This is a deliberate deviation from the superagent prototype, whose Router keeps a full shell. Every tool the Router carries is paid for on every routing decision, so its toolset stays minimal. If you find the Router cannot run a command, that is the design.

3. **The Router is off the hot path.** A message on a thread with a live subscribed ticket goes straight to that worker with zero inference. Only unattributed messages reach the Router.

4. **An adjudicator is never weaker than the parties.** Procedural conflicts (deadlock, budget, TTL, a cycle) go to the Router. A substantive disagreement between workers goes to a reviewer, and a reviewer that is a party to the ticket is skipped in favour of a person.

5. **A ticket's preset is locked at creation.** A Session keeps the preset it was created with, and resuming a persisted Session fails if that preset is gone. The preset rows in `cordis.patch.yml` are a hard dependency.

## Scope discipline

Mesh ships three subsystems that a smaller design would omit. Each is gated on evidence, not enthusiasm:

| Subsystem | Gate before relying on it |
| --- | --- |
| `mesh_needs` (capability directory) | ≥ 5 real requests that needed a peer |
| Gates (mandatory consultation) | ≥ 3 real disagreements or out-of-scope changes |
| Coalitions (temporary groups) | ≥ 3 questions that genuinely needed 3+ viewpoints |

`mesh_evidence` reports these counts from the audit log. The counts are the point: a subsystem nobody uses is complexity you are paying for and not collecting on.

## What each piece actually buys

| Piece | Buys | Does not buy |
| --- | --- | --- |
| Typed workers + permission presets | A researcher that cannot write, an ops worker that is the only one with the machine | Better judgement — every worker is the same model |
| Budget ledger | A visible, enforceable ceiling per ticket and per coalition | Cheaper tokens — it makes spend visible, not smaller |
| Message bus | Crash-safe delivery: state and intent commit together | Lower latency — it trades latency for durability |
| Gates | An explicit, audited pause before a plan changes or a page ships | Better decisions — two signatures from one model is one signature |
| Coalitions | Several independent reads merged by a program | Debate — there is no free-form chat, on purpose |
| Reorientation note | Stale beliefs cleared for a few dozen tokens per ticket | Cache hits from residency — see below |

## The two things people get wrong

**Residency is not a token cache.** A resident worker avoids a cold restart: it keeps its knowledge of the repo, its tool habits, its past failures. It does *not* promise prompt-cache hits, because DSH compaction rewrites the surface, which invalidates the prefix. What preserves the cache is that the per-ticket reorientation note is an *append* — the prefix above it is byte-identical across tickets. Read [§The two things people get wrong](#the-two-things-people-get-wrong) and then `src/app/prompts.ts` before optimising anything here.

**Usage is cumulative, not surface pressure.** `tokenMeter.measure()` reports how full the current context is. A budget needs the *sum of `assistant/message.usage` over the ticket's life*. Mixing the two makes every threshold meaningless. `src/core/budget.ts` accumulates in memory and flushes one batch per pass, because `node:sqlite` is synchronous and `synchronous=FULL` fsyncs on commit — writing per assistant message would stall the loop for every worker at once.

## Why the Engine is the only writer

Sessions and Agents are same-process objects. A worker *could* write the database directly; nothing physically stops it. The Engine is the sole writer anyway because:

- **Audit completeness** — one command, one transaction, one audit row. A direct write leaves a hole in "who changed what".
- **Crash consistency** — a state change and its side-effect intent commit together. A direct write cannot do both, so a crash leaves either a ticket that advanced with nobody told, or an intent with no state.
- **Budget enforcement** — every dispatch passes through the Engine, so a ceiling can be checked before work starts rather than after it is paid for.

The cost is latency: an in-memory call becomes a database write plus a pass. That is what `receive()` calling `passes.request()` is for — interactive paths never wait for the beat.

## Configuration

```yaml
- id: mesh-engine
  name: dsh-agent-mesh
  config:
    stateDir: ~/.dsh/state/mesh
    pass: { intervalMs: 2000 }
    executor:
      residentWorkers: 2      # researcher + coder; each costs a live Session
      tempSlots: 2            # concurrency for per-ticket workers
    budget: { coalitionSoft: 0.8 }
    coalitions: { inferredBlocking: false }   # notify, do not block
    eval: { model: null, timeoutMs: 300000 }
    watchdog: { enabled: true, everySeconds: 3600 }
```

Two slots pools, not one: a resident worker holds a reserved slot for its lifetime and does not compete with tickets, so adding a resident does not shrink the number of tickets that can run at once.

## Development

```bash
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest
pnpm build        # tsdown -> lib/
pnpm check        # all three
```

`src/core/` has no DSH dependency and is fully unit-tested. `src/app/` and `src/executor/` hold every Host call. That split is what lets the state machine be tested without a running Harness.

Set `MESH_TRACE=1` to append startup checkpoints to `<stateDir>/mesh-boot.log`. The Host captures plugin logs into its own diagnostics file, which makes startup order hard to see; this trace is one line per checkpoint.

## Known limits

- **One open gate per ticket.** Parallel gates are a deadlock breeding ground, and two signatures from one model are not stronger than one.
- **Coalition scripts are usually empty.** A script is valid only when the shape was known up front; an empty one collects one answer per member and merges the fields, which is the honest default when the shape is not known.
- **The Watchdog reports, never acts.** A timer that kills things is how you lose a nearly-finished ticket.
- **`engines.dsh` pins a minor range.** SemVer rejects `0.2.3-rc.1` for a `>=0.2.2-rc.1 <0.2.3` range, so a Host minor bump needs this line raised deliberately.
