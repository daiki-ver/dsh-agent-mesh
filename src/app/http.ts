/**
 * The Mesh HTTP API.
 *
 * Mounted through the Host's route table rather than by listening on its `request`
 * event: the Host owns that event for its own client, and two handlers writing one
 * response throws `ERR_HTTP_HEADERS_SENT`, which takes the process down.
 *
 * The API is mostly read-only, and exposes the two signals that diagnose a stall, which
 * are easy to confuse:
 *
 * - `pass.sinceLastPassMs` — is the loop alive?
 * - `effects.waiting` — is work stuck behind a `Later`?
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

/** What the API reads. */
export interface StatusDeps {
  engine: Engine
  effects: Effects
  passes: Passes
  executor: WorkerExecutor
  sessions: SessionManager
}

/** A minimal request. */
interface RequestLike {
  url?: string
  method?: string
  on?: (event: string, listener: (chunk?: unknown) => void) => void
  body?: unknown
}

/** A minimal response. */
interface ResponseLike {
  statusCode: number
  headersSent?: boolean
  writableEnded?: boolean
  setHeader(name: string, value: string): void
  end(body?: string): void
}

/** The Host's route table. */
interface WebServerLike {
  register(route: {
    kind: 'prefix' | 'exact'
    path: string
    handler: (req: RequestLike, res: ResponseLike) => void | Promise<void>
  }): () => void
}

/** The API's mount point. */
export const API_PREFIX = '/mesh/api'

/**
 * Mount the API through the Host's route table.
 *
 * @param ctx - the injected context that owns `webServer`.
 * @param deps - the runtime pieces the routes read.
 * @returns whether the API was mounted.
 */
export function mountApi(ctx: Context, deps: StatusDeps): boolean {
  const webServer = (ctx as unknown as Record<string, unknown>).webServer as WebServerLike | undefined
  if (!webServer || typeof webServer.register !== 'function') return false
  try {
    webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: (req, res) => handle(req, res, deps),
    })
    ctx.logger?.info?.(`[mesh] status API mounted at ${API_PREFIX}/`)
    return true
  } catch (error) {
    // A duplicate registration means another Mesh instance already owns the prefix.
    ctx.logger?.warn?.(`[mesh] status API not mounted: ${String(error)}`)
    return false
  }
}

/** Route one request. */
async function handle(req: RequestLike, res: ResponseLike, deps: StatusDeps): Promise<void> {
  const url = req.url ?? '/'
  try {
    if (url.startsWith(`${API_PREFIX}/task`) && req.method === 'POST') {
      await handleTask(req, res, deps)
      return
    }
    if (req.method !== undefined && req.method !== 'GET') {
      reply(res, 405, { error: 'method not allowed' })
      return
    }
    reply(res, 200, route(url, deps))
  } catch (error) {
    reply(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Resolve one GET route. */
function route(url: string, deps: StatusDeps): unknown {
  const parsed = new URL(url, 'http://mesh.local')
  const path = parsed.pathname
  switch (path) {
    case `${API_PREFIX}/state`:
      return state(deps)
    case `${API_PREFIX}/health`:
      return health(deps)
    case `${API_PREFIX}/tickets`:
      return deps.engine.store.listTickets(false).map(t => ({
        id: t.id,
        title: t.title,
        stage: t.stage,
        kind: t.spec.workerKind,
        mandate: t.mandate,
        ended: t.ended?.outcome ?? null,
        assignments: t.assignments.length,
        gates: t.gates.length,
        goal: t.spec.goal,
      }))
    case `${API_PREFIX}/coalitions`:
      return deps.engine.store.listCoalitions(false).map(c => ({
        id: c.id, topic: c.topic, state: c.state, mandate: c.mandate,
        round: c.round, budget: c.budget, members: c.memberIds,
      }))
    case `${API_PREFIX}/usage`:
      return deps.engine.store.listUsage({
        ...(parsed.searchParams.get('scope') ? { scope: parsed.searchParams.get('scope') as never } : {}),
        ...(parsed.searchParams.get('id') ? { scopeId: parsed.searchParams.get('id')! } : {}),
      })
    case `${API_PREFIX}/workers`:
      return deps.engine.store.listWorkers()
    case `${API_PREFIX}/gates`:
      return deps.engine.store.listGates(false)
    case `${API_PREFIX}/audit`:
      return deps.engine.store.listAudit(Number(parsed.searchParams.get('limit') ?? 100))
    case `${API_PREFIX}/evidence`:
      return {
        gate: deps.engine.evidence('gate.open', 3),
        needs: deps.engine.evidence('needs.match', 5),
        coalition: deps.engine.evidence('coalition.propose', 3),
        escalate: deps.engine.evidence('escalate', 3),
      }
    default:
      throw new Error(`unknown route ${path}`)
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
  const alive = sinceLast >= 0 && sinceLast < 30_000
  return {
    pass: { alive, sinceLastPassMs: sinceLast, error: deps.passes.error },
    effects: { waiting, errored, kinds: effects },
    diagnosis: alive && waiting > 10
      ? 'the loop is alive but effects are waiting; check slots and busy targets, not the interval'
      : !alive
        ? 'the loop has not run recently; the interval or the process is the problem'
        : 'healthy',
  }
}

/**
 * Accept a task from a person.
 *
 * Body: `{ "text": "...", "thread": "optional-thread-key" }`. This is how work enters
 * the mesh; every other route is read-only.
 */
async function handleTask(req: RequestLike, res: ResponseLike, deps: StatusDeps): Promise<void> {
  try {
    const body = await readJson(req)
    const text = typeof body.text === 'string' ? body.text.trim() : ''
    if (text === '') throw new Error('"text" is required')
    const thread = typeof body.thread === 'string' && body.thread !== '' ? body.thread : undefined
    const result = deps.engine.submit(text, thread === undefined ? {} : { thread })
    reply(res, 202, {
      thread: result.thread,
      disposition: result.intake.disposition,
      assessed: result.assessment !== undefined,
      ticketIds: result.intake.ticketIds,
    })
  } catch (error) {
    reply(res, 400, { error: error instanceof Error ? error.message : String(error) })
  }
}

/** Write a response once. */
function reply(res: ResponseLike, status: number, body: unknown): void {
  if (res.headersSent || res.writableEnded) return
  try {
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('x-mesh-request', '1')
    res.end(JSON.stringify(body, null, 2))
  } catch {
    // The peer may already be gone; a status route must not take Mesh down.
  }
}

/** Read and parse a JSON request body, with a size cap. */
function readJson(req: RequestLike): Promise<Record<string, unknown>> {
  if (typeof req.body === 'object' && req.body !== null) {
    return Promise.resolve(req.body as Record<string, unknown>)
  }
  if (typeof req.on !== 'function') return Promise.resolve({})
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on?.('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > 1_000_000) {
        reject(new Error('request body too large'))
        return
      }
      chunks.push(buffer)
    })
    req.on?.('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim() === '') return resolve({})
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch (error) {
        reject(new Error(`invalid JSON body: ${String(error)}`))
      }
    })
    req.on?.('error', error => reject(error))
  })
}
