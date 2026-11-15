/**
 * The status API.
 *
 * Read-only, and deliberately small. It exposes the two signals that tell an operator
 * what is actually wrong, which are easy to confuse:
 *
 * - `pass.lastAt` — is the loop alive?
 * - `effect.waiting` — is work stuck behind a `Later`?
 *
 * If the loop is alive but effects are waiting, raising `pass.intervalMs` will not help;
 * the bottleneck is a busy slot or a busy target Session.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Engine } from '../core/engine.ts'
import type { Effects } from '../core/effects.ts'
import type { Passes } from '../core/passes.ts'
import type { WorkerExecutor } from '../executor/dsh.ts'
import type { SessionManager } from './sessions.ts'

/** What the status API reads. */
export interface StatusDeps {
  engine: Engine
  effects: Effects
  passes: Passes
  executor: WorkerExecutor
  sessions: SessionManager
}

/** A minimal request. Only the URL and method are used. */
interface RequestLike {
  url?: string
  method?: string
}

/** A minimal response. */
interface ResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** A minimal server surface. */
interface ServerLike {
  on(event: 'request', listener: (req: RequestLike, res: ResponseLike) => void): void
}

/** Register the status routes on a server, if the Host offers one. */
export function registerStatusRoutes(server: ServerLike, deps: StatusDeps): void {
  server.on('request', (req, res) => {
    const url = req.url ?? '/'
    if (!url.startsWith('/mesh/api/')) return
    if (req.method !== undefined && req.method !== 'GET') {
      res.statusCode = 405
      res.end('method not allowed')
      return
    }
    try {
      const body = route(url, deps)
      res.statusCode = 200
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.setHeader('x-mesh-request', '1')
      res.end(JSON.stringify(body, null, 2))
    } catch (error) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    }
  })
}

/** Resolve one route to its JSON body. */
function route(url: string, deps: StatusDeps): unknown {
  const parsed = new URL(url, 'http://mesh.local')
  switch (parsed.pathname) {
    case '/mesh/api/state':
      return state(deps)
    case '/mesh/api/tickets':
      return deps.engine.store.listTickets(false).map(t => ({
        id: t.id,
        title: t.title,
        stage: t.stage,
        kind: t.spec.workerKind,
        mandate: t.mandate,
        ended: t.ended?.outcome ?? null,
        assignments: t.assignments.length,
        gates: t.gates.length,
      }))
    case '/mesh/api/coalitions':
      return deps.engine.store.listCoalitions(false).map(c => ({
        id: c.id,
        topic: c.topic,
        state: c.state,
        mandate: c.mandate,
        round: c.round,
        budget: c.budget,
        members: c.memberIds,
      }))
    case '/mesh/api/usage':
      return deps.engine.store.listUsage({
        ...(parsed.searchParams.get('scope') ? { scope: parsed.searchParams.get('scope') as never } : {}),
        ...(parsed.searchParams.get('id') ? { scopeId: parsed.searchParams.get('id')! } : {}),
      })
    case '/mesh/api/workers':
      return deps.engine.store.listWorkers()
    case '/mesh/api/gates':
      return deps.engine.store.listGates(false)
    case '/mesh/api/audit':
      return deps.engine.store.listAudit(Number(parsed.searchParams.get('limit') ?? 100))
    case '/mesh/api/health':
      return health(deps)
    default:
      throw new Error(`unknown route ${parsed.pathname}`)
  }
}

/** The overview. */
function state(deps: StatusDeps): unknown {
  return {
    ...deps.engine.state(),
    pass: {
      running: deps.passes.running,
      sinceLastPassMs: deps.passes.sinceLastPassMs,
      error: deps.passes.error,
    },
    effects: deps.effects.health(),
    executor: deps.executor.health(),
    sessions: deps.sessions.list().map(s => ({ sessionId: s.sessionId, role: s.role })),
    time: new Date().toISOString(),
  }
}

/** The health view: the two signals that diagnose a stall. */
function health(deps: StatusDeps): unknown {
  const effects = deps.effects.health()
  const waiting = effects.reduce((sum, h) => sum + h.waiting, 0)
  const errored = effects.reduce((sum, h) => sum + h.errored, 0)
  const sinceLast = deps.passes.sinceLastPassMs
  return {
    pass: {
      alive: sinceLast >= 0 && sinceLast < 30_000,
      sinceLastPassMs: sinceLast,
      error: deps.passes.error,
    },
    effects: { waiting, errored, kinds: effects },
    diagnosis: sinceLast >= 0 && sinceLast < 30_000 && waiting > 10
      ? 'the loop is alive but effects are waiting; check slots and busy targets, not the interval'
      : sinceLast < 0 || sinceLast >= 30_000
        ? 'the loop has not run recently; the interval or the process is the problem'
        : 'healthy',
  }
}

/**
 * Mount the status routes when the profile has a web server.
 *
 * `webServer` is not a required service, and reaching for it from a context that never
 * declared it throws. A nested `inject` keeps it optional: a headless profile simply
 * never fires the callback.
 */
export function attachIfPossible(ctx: Context, deps: StatusDeps): void {
  try {
    ctx.inject(['webServer'], webCtx => {
      const candidate = (webCtx as unknown as Record<string, unknown>).webServer as
        { server?: ServerLike } | undefined
      if (!candidate?.server) return
      registerStatusRoutes(candidate.server, deps)
      webCtx.logger?.info?.('[mesh] status API mounted at /mesh/api/')
    })
  } catch (error) {
    // No web server in this profile: the status API is a convenience, not a dependency.
    ctx.logger?.info?.(`[mesh] status API not mounted: ${String(error)}`)
  }
}
