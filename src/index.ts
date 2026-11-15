/**
 * Plugin entry point.
 *
 * Startup order matters here, so it is explicit:
 *
 * 1. **Wait for Host services.** `ctx.inject` defers everything until the services Mesh
 *    needs exist. During `apply` none of them are available yet — verified against a
 *    running Host, not assumed.
 * 2. **Open the store, build the Engine.** Pure state, no Host calls.
 * 3. **Register effect handlers.** A command enqueues effects, so the handlers must exist
 *    before any command can run.
 * 4. **Observe usage.** The `session/event` listener only accumulates in memory; a pass
 *    flushes the batch.
 * 5. **Start the pass loop.** From here the machine advances on its own.
 * 6. **Bring up the Router Session and resident workers.** Sessions last, because they
 *    are the slowest and the most likely to fail; a failure here leaves a working store
 *    rather than a half-built one.
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { Engine, EFFECT } from './core/engine.ts'
import { Effects, Later } from './core/effects.ts'
import { Passes } from './core/passes.ts'
import { Store } from './core/store.ts'
import { newId, now, type Worker, type WorkerKind } from './core/model.ts'
import { WORKER_TEMPLATES } from './core/directory.ts'

import {
  REQUIRED_SERVICES, residentSessionId, type HostServices, type ScheduleService,
  type SessionEvent, type TokenMeterService, type SessionId,
} from './app/host.ts'
import { SessionManager } from './app/sessions.ts'
import { Resources } from './app/resources.ts'
import { routerTools } from './app/tools/main.ts'
import { workerTools } from './app/tools/executor.ts'
import { attachIfPossible } from './app/http.ts'
import { installWatchdog } from './app/watchdog.ts'
import { ROUTER_PROMPT, workerPrompt } from './app/prompts.ts'
import {
  WorkerExecutor, assignmentMessage, reorientationNote,
} from './executor/dsh.ts'

export const name = 'dsh-agent-mesh'

/** How often the pass loop wakes up. A fallback beat, never a correctness guarantee. */
export const DEFAULT_PASS_INTERVAL_MS = 2000

/** The Router's Session id. */
export const ROUTER_SESSION_ID = 'mesh-router'

/** Plugin config. */
export interface Config {
  stateDir?: string
  pass?: { intervalMs?: number }
  executor?: { residentWorkers?: number; tempSlots?: number; prepareTimeoutMs?: number }
  budget?: { coalitionSoft?: number }
  coalitions?: { inferredBlocking?: boolean }
  eval?: { model?: string | null; timeoutMs?: number }
  watchdog?: { enabled?: boolean; everySeconds?: number }
  workspace?: string
}

export const Config: Schema<Config> = Schema.object({
  stateDir: Schema.string().description('Directory holding the Mesh state database.'),
  pass: Schema.object({
    intervalMs: Schema.number().default(DEFAULT_PASS_INTERVAL_MS),
  }),
  executor: Schema.object({
    residentWorkers: Schema.number().default(2),
    tempSlots: Schema.number().default(2),
    prepareTimeoutMs: Schema.number().default(600_000),
  }),
  budget: Schema.object({
    coalitionSoft: Schema.number().default(0.8),
  }),
  coalitions: Schema.object({
    inferredBlocking: Schema.boolean().default(false),
  }),
  eval: Schema.object({
    model: Schema.union([Schema.string(), Schema.const(null)]).default(null),
    timeoutMs: Schema.number().default(300_000),
  }),
  watchdog: Schema.object({
    enabled: Schema.boolean().default(true),
    everySeconds: Schema.number().default(3600),
  }),
  workspace: Schema.string().description('Working directory for worker Sessions.'),
})

/** Everything Mesh builds at startup, kept together so shutdown can unwind it. */
interface Runtime {
  store: Store
  effects: Effects
  engine: Engine
  passes: Passes
  sessions: SessionManager
  resources: Resources
  executor: WorkerExecutor
  flushUsage: () => void
}

/**
 * Mount the bundle.
 * @param ctx - the bundle's root Cordis context.
 * @param config - resolved plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  const stateDir = resolveStateDir(config)
  const cwd = config.workspace ?? process.cwd()
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  traceStep(stateDir, 'apply')

  let runtime: Runtime | undefined
  let stopping = false

  // Everything below waits for the services Mesh actually needs. During `apply` the
  // Host has not published them yet, so touching them here would see undefined.
  ctx.inject([...REQUIRED_SERVICES], async injected => {
    traceStep(stateDir, 'inject:enter')
    // Every Host call must happen through `injected`, the context whose scope holds the
    // services, and this body must stay async so the fiber stays active across the
    // awaits below. A synchronous body completes immediately, and any later Host call
    // then throws "cannot get required service in inactive context".
    const host = injected as unknown as HostServices
    const built = boot(injected, host, config, stateDir, cwd)
    runtime = built
    traceStep(stateDir, 'inject:booted')

    const dispose = (): void => {
      if (stopping) return
      stopping = true
      built.flushUsage()
      void built.passes.stop()
      built.effects.stop()
      void built.sessions.releaseAll()
      built.store.close()
    }
    // Cordis disposes this with the injected scope.
    injected.effect(() => dispose)
    traceStep(stateDir, 'inject:effect-registered')

    // Expose the runtime for the status API and for tests. The Context is a proxy that
    // rejects unknown property writes, so the handle lives in a module-level registry
    // keyed by stateDir instead.
    exposeRuntime(stateDir, built)
    traceStep(stateDir, 'inject:exposed')

    // Await the slow part inside this fiber, so its Host calls stay in scope.
    try {
      await bringUp(injected, host, built.engine, built.sessions, built.resources, config, cwd, {
        passes: built.passes,
        effects: built.effects,
        executor: built.executor,
        stateDir,
      })
      traceStep(stateDir, 'inject:ready')
    } catch (error) {
      traceStep(stateDir, `inject:bringUp-threw ${String(error)}`)
      throw error
    }

    // The Watchdog needs `schedule`, which is not in the required set: a profile without
    // it should still run Mesh. A nested inject keeps it optional without touching
    // `ctx.schedule` from a context that never declared it.
    if (config.watchdog?.enabled !== false) {
      injected.inject(['schedule'], async scheduleCtx => {
        const schedule = (scheduleCtx as unknown as Record<string, unknown>).schedule as
          ScheduleService | undefined
        const handle = await installWatchdog(
          scheduleCtx,
          schedule,
          built.engine,
          ROUTER_SESSION_ID,
          config.watchdog?.everySeconds ?? 3600,
        )
        traceStep(stateDir, `watchdog:${handle.installed ? 'installed' : `skipped ${handle.reason}`}`)
      })
    }
  })

  ctx.on('dispose', () => {
    if (runtime && !stopping) {
      stopping = true
      runtime.flushUsage()
      void runtime.passes.stop()
      runtime.effects.stop()
      runtime.store.close()
    }
  })
}

/** Runtime handles by state directory, for inspection from outside the plugin. */
const RUNTIMES = new Map<string, Runtime>()

/** Record the runtime so a status reader or a test can reach it. */
function exposeRuntime(stateDir: string, runtime: Runtime): void {
  RUNTIMES.set(stateDir, runtime)
}

/** Read the runtime for a state directory, if this process mounted it. */
export function runtimeAt(stateDir: string): Runtime | undefined {
  return RUNTIMES.get(stateDir)
}

/** Every mounted runtime in this process. */
export function runtimes(): Runtime[] {
  return [...RUNTIMES.values()]
}

/**
 * Append a startup checkpoint to `mesh-boot.log` in the state directory.
 *
 * The Host captures plugin logs into its own diagnostics file, which makes a plugin's
 * startup order hard to inspect. This trace is one line per checkpoint, written only
 * when `MESH_TRACE` is set, so a boot can be diagnosed without a debugger.
 */
function traceStep(stateDir: string, step: string): void {
  if (!process.env.MESH_TRACE) return
  try {
    appendFileSync(join(stateDir, 'mesh-boot.log'), `${now()} ${step}\n`)
  } catch {
    // Tracing must never break a boot.
  }
}

/** Build every runtime piece and start the loop. */
function boot(
  ctx: Context,
  host: HostServices,
  config: Config,
  stateDir: string,
  cwd: string,
): Runtime {
  const store = new Store(join(stateDir, 'mesh.db'))
  const effects = new Effects(store)
  const engine = new Engine({
    store,
    effects,
    evalTimeoutMs: config.eval?.timeoutMs ?? 300_000,
    coalitionSoft: config.budget?.coalitionSoft ?? 0.8,
    inferredBlocking: config.coalitions?.inferredBlocking ?? false,
  })
  const sessions = new SessionManager(ctx, host)
  const resources = new Resources(store, engine)
  const executor = new WorkerExecutor(
    ctx,
    sessions,
    host,
    {
      residentWorkers: config.executor?.residentWorkers ?? 2,
      tempSlots: config.executor?.tempSlots ?? 2,
    },
    cwd,
  )

  const flushUsage = (): void => {
    try {
      engine.flushUsage()
    } catch (error) {
      ctx.logger?.warn?.(`[mesh] usage flush failed: ${String(error)}`)
    }
  }

  registerEffectHandlers(ctx, host, engine, effects, executor, sessions, resources)
  observeUsage(ctx, engine, sessions)
  const passes = new Passes(
    {
      kickEffects: async () => {
        // Flush first: one fsync per pass rather than one per assistant message.
        engine.flushUsage()
        await effects.kick()
      },
      checkBudgets: () => engine.checkBudgets(),
      report: (state, detail) => {
        if (state === 'error') ctx.logger?.warn?.(`[mesh] pass failed: ${detail}`)
      },
    },
    config.pass?.intervalMs ?? DEFAULT_PASS_INTERVAL_MS,
  )
  passes.start()

  // The Router and the resident workers come up inside the injected fiber (see `apply`),
  // because their Host calls need that scope. Nothing async is started from here.
  return { store, effects, engine, passes, sessions, resources, executor, flushUsage }
}

/** Register one handler per effect kind. */
function registerEffectHandlers(
  ctx: Context,
  host: HostServices,
  engine: Engine,
  effects: Effects,
  executor: WorkerExecutor,
  sessions: SessionManager,
  resources: Resources,
): void {
  effects.handle(EFFECT.assess, { limit: 1, ordered: true }, async (value, key) => {
    const payload = value as { threadKey: string; evalId: string }
    const candidate = engine.assess(payload.threadKey)
    if (!candidate) return
    const router = sessions.get(ROUTER_SESSION_ID)
    if (!router) throw new Later('router session not ready')
    const card = [
      `Candidate on thread ${payload.threadKey}.`,
      `Decide with mesh_route or mesh_eval_decide.`,
      `Read the thread with mesh_read resource "thread/${payload.threadKey}".`,
    ].join('\n')
    await sessions.prompt(ROUTER_SESSION_ID, `assess:${key}`, card, 'steer')
    engine.assessmentDelivered(payload.threadKey)
  })

  effects.handle(EFFECT.launch, { limit: 4 }, async value => {
    const payload = value as { ticketId: string; assignmentId: string; workerId: string }
    const ticket = engine.tickets.require(payload.ticketId)
    const assignment = ticket.assignments.find(a => a.id === payload.assignmentId)
    const worker = engine.store.getWorker(payload.workerId)
    if (!assignment || !worker) return
    const previous = engine.store.kvGet(`worker.lastTicket.${worker.id}`)
    const text = assignmentMessage(ticket, worker.kind, reorientationNote(previous ?? undefined))
    await executor.launch(ticket, assignment, worker, text)
    engine.store.kvSet(`worker.lastTicket.${worker.id}`, ticket.title)
    engine.setWorkerStatus(worker.id, 'busy', ticket.id)
    engine.tickets.startAssignment(ticket.id, assignment.id)
  })

  effects.handle(EFFECT.deliver, { limit: 4, quiet: true }, async value => {
    const payload = value as { ticketId?: string; inputId?: string; workerId?: string; messageId?: string }
    if (payload.messageId !== undefined && payload.workerId !== undefined) {
      const message = engine.store.getMessage(payload.messageId)
      const worker = engine.store.getWorker(payload.workerId)
      if (!message || !worker) return
      const text = `Message from ${message.from} (${message.type}):\n${message.body}`
      await executor.deliverTo(worker.sessionId, `msg:${message.id}:${worker.id}`, text)
      engine.bus.markDelivered(message.id, worker.id)
      return
    }
    if (payload.ticketId === undefined || payload.inputId === undefined) return
    const ticket = engine.tickets.require(payload.ticketId)
    const input = ticket.inputs.find(i => i.id === payload.inputId)
    const assignment = ticket.assignments.at(-1)
    const worker = assignment ? engine.store.getWorker(assignment.workerId) : undefined
    if (!input || !worker) return
    await executor.deliver(ticket, worker, input.id, input.text)
    engine.tickets.markDelivered(ticket.id, [input.id])
  })

  effects.handle(EFFECT.coalition, { limit: 2 }, async value => {
    const payload = value as { coalitionId: string }
    const step = engine.coalitionStep(payload.coalitionId)
    if (step.kind === 'done') {
      const coalition = engine.coalitions.require(payload.coalitionId)
      if (coalition.state !== 'archived' && coalition.state !== 'dissolved') {
        engine.coalitions.dissolve(payload.coalitionId, step.reason, true)
      }
      return
    }
    const coalition = engine.coalitions.require(payload.coalitionId)
    for (const workerId of step.speakers) {
      const worker = engine.store.getWorker(workerId)
      if (!worker) continue
      const text = [
        `Coalition question (${coalition.topic}): ${step.ask}`,
        step.schema ? `Fill these fields: ${step.schema}` : '',
        `Answer with mesh_coalition_answer for coalition ${coalition.id}.`,
      ].filter(Boolean).join('\n')
      await executor.deliverTo(worker.sessionId, `coalition:${coalition.id}:${workerId}:${coalition.round}`, text)
    }
  })

  effects.handle(EFFECT.relay, { limit: 1, ordered: true }, async value => {
    const payload = value as { text: string }
    const router = sessions.get(ROUTER_SESSION_ID)
    if (!router) throw new Later('router session not ready')
    await sessions.prompt(ROUTER_SESSION_ID, `relay:${hash(payload.text)}`, payload.text, 'steer')
  })

  effects.handle(EFFECT.notice, { limit: 1, ordered: true }, async value => {
    const payload = value as { name: string; summary: string; value: unknown }
    const router = sessions.get(ROUTER_SESSION_ID)
    if (!router) return
    // Inject rather than steer: a notice must not wake the Router or cost a turn.
    await sessions.prompt(
      ROUTER_SESSION_ID,
      `notice:${payload.name}:${hash(JSON.stringify(payload.value))}`,
      `${payload.summary}\n${JSON.stringify(payload.value)}`,
      { inject: payload.summary },
    )
  })

  effects.handle(EFFECT.sweep, { limit: 1 }, async () => {
    engine.sweep()
  })

  void host
  void resources
  void ctx
}

/**
 * Observe token usage.
 *
 * The listener must stay allocation-only: `session/event` is a post-commit,
 * fire-and-forget feed and every worker shares this thread.
 */
function observeUsage(ctx: Context, engine: Engine, sessions: SessionManager): void {
  ctx.on('session/event', (session: { id: string }, event: SessionEvent) => {
    if (event.type !== 'assistant/message') return
    const usage = event.data?.usage
    if (!usage) return
    const managed = sessions.list().find(s => s.sessionId === session.id)
    if (!managed) return
    // Charge the worker's current ticket when it has one; otherwise charge the worker.
    const worker = engine.store.listWorkers().find(w => w.sessionId === session.id)
    const scope = worker?.ticketId ? 'ticket' : 'worker'
    const scopeId = worker?.ticketId ?? session.id
    engine.recordUsage(scope, scopeId, session.id, {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadTokens: usage.cacheReadTokens ?? 0,
      cacheWriteTokens: usage.cacheWriteTokens ?? 0,
      reasoningTokens: usage.reasoningTokens ?? 0,
    })
  })
}

/** Create the Router Session, register its tools, and start resident workers. */
async function bringUp(
  ctx: Context,
  host: HostServices,
  engine: Engine,
  sessions: SessionManager,
  resources: Resources,
  config: Config,
  cwd: string,
  runtime: { passes: Passes; effects: Effects; executor: WorkerExecutor; stateDir: string },
): Promise<void> {
  const trace = (step: string): void => traceStep(runtime.stateDir, step)
  trace('bringUp:enter')
  try {
    const router = await sessions.ensure(ROUTER_SESSION_ID, cwd, 'Mesh Router', 'router')
    sessions.applyPermission(router)
    sessions.registerTools(router, routerTools({ engine, resources, routerSessionId: ROUTER_SESSION_ID }))
    engine.store.kvSet('router.prompt', ROUTER_PROMPT)
    engine.store.audit('program', 'router.ready', { sessionId: ROUTER_SESSION_ID })
    trace('bringUp:router-ready')
  } catch (error) {
    ctx.logger?.warn?.(`[mesh] router session unavailable: ${String(error)}`)
    trace(`bringUp:router-failed ${String(error)}`)
    return
  }
  // Resident workers: register their static offers, then create their Sessions.
  const residentKinds = WORKER_TEMPLATES.filter(t => t.resident).map(t => t.kind)
  const wanted = residentKinds.slice(0, config.executor?.residentWorkers ?? 2)
  for (const kind of wanted) {
    try {
      await registerResident(ctx, host, engine, sessions, resources, kind, cwd)
      trace(`bringUp:resident-${kind}`)
    } catch (error) {
      ctx.logger?.warn?.(`[mesh] resident ${kind} unavailable: ${String(error)}`)
      trace(`bringUp:resident-${kind}-failed ${String(error)}`)
    }
  }

  // Watchdog is installed by `apply` through a nested inject, because `schedule` is
  // optional and must not be reachable from a context that never declared it.

  // Status routes, when this profile has a web server.
  attachIfPossible(ctx, {
    engine,
    effects: runtime.effects,
    passes: runtime.passes,
    executor: runtime.executor,
    sessions,
  })

  runtime.passes.request()
}

/** Register and start one resident worker. */
async function registerResident(
  ctx: Context,
  host: HostServices,
  engine: Engine,
  sessions: SessionManager,
  resources: Resources,
  kind: WorkerKind,
  cwd: string,
): Promise<void> {
  const sessionId = residentSessionId(kind, 1)
  const worker: Worker = {
    id: `mesh-${kind}-1`,
    kind,
    sessionId,
    status: 'starting',
    offers: { keywords: engine.directory.offersFor(kind) },
    resident: true,
    registeredAt: now(),
  }
  engine.registerWorker(worker)

  const session = await sessions.ensure(sessionId, cwd, `Mesh ${kind}`, 'worker')
  sessions.applyPermission(session, kind)
  sessions.registerTools(session, workerTools({ engine, resources, workerId: worker.id }))
  engine.setWorkerStatus(worker.id, 'idle')
  engine.store.audit('program', 'worker.resident', { worker: worker.id, kind })
  void host
  void ctx
}

/** Resolve `stateDir`, expanding a leading `~` against the home directory. */
function resolveStateDir(config: Config): string {
  const raw = config.stateDir ?? join(homeDir(), '.dsh', 'state', 'mesh')
  if (raw === '~') return homeDir()
  if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(homeDir(), raw.slice(2))
  return raw
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? process.cwd()
}

/** A stable short hash, so a repeated notice deduplicates. */
function hash(value: string): string {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

/** Re-exported so a caller can construct an id without reaching into core. */
export { newId }
export type { TokenMeterService, SessionId }
