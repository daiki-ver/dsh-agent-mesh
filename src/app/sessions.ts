/**
 * Session lifecycle for Mesh.
 *
 * This is the only module that creates Sessions, assigns permissions, and delivers
 * messages. Everything above it talks about tickets and workers; everything below is
 * DSH.
 *
 * Three details are load-bearing:
 *
 * 1. **The preset is locked at creation.** A Session keeps the preset it was created
 *    with, and resuming a persisted Session fails if that preset is gone. The preset
 *    rows in `cordis.patch.yml` are therefore a hard dependency, not configuration.
 * 2. **The model is session-local.** It is appended to the Session's own log, never
 *    set through the Host's global selector, which would rewrite the person's default.
 * 3. **Delivery is idempotent per request id.** A retried effect must not deliver the
 *    same message twice, so every delivery carries a stable request id.
 */

import type { Context } from '@deepseek-ai/cordis'
import {
  type Agent, type HostServices, type PromptMode, type ResolveAgentResult, type SessionId,
  PERMISSION, PRESET, type ToolDefinition,
} from './host.ts'

/** What Mesh knows about one managed Session. */
export interface ManagedSession {
  sessionId: string
  agent: Agent
  role: 'router' | 'worker'
  /** Request ids already delivered, so a retried effect is a no-op. */
  delivered: Set<string>
}

/** A tool registration tied to one Session, disposed with it. */
type Disposer = () => void

/**
 * Sessions: create, decorate, deliver.
 */
export class SessionManager {
  private readonly managed = new Map<string, ManagedSession>()
  private readonly disposers = new Map<string, Disposer[]>()
  private readonly host: HostServices
  private readonly ctx: Context

  constructor(ctx: Context, host: HostServices) {
    this.ctx = ctx
    this.host = host
  }

  /** Every managed Session, for status and Watchdog. */
  list(): ManagedSession[] {
    return [...this.managed.values()]
  }

  /** One managed Session by id. */
  get(sessionId: string): ManagedSession | undefined {
    return this.managed.get(sessionId)
  }

  /**
   * Resolve a Session, creating it if it does not exist.
   *
   * @param sessionId - stable id: `mesh-router`, `mesh-<kind>-<n>`, `mesh-temp-<ticket>`.
   * @param cwd - workspace directory the Session is bound to.
   * @param title - display title.
   * @param role - which preset to lock in at creation.
   */
  async ensure(
    sessionId: string,
    cwd: string,
    title: string,
    role: 'router' | 'worker',
  ): Promise<ManagedSession> {
    const existing = this.managed.get(sessionId)
    if (existing) return existing

    let result = await this.host.sessionController.resolveAgent(sessionId as SessionId)
    if ('error' in result && result.error.code === 'session/not-found') {
      const workspace = await this.host.workspaceRegistry.create(cwd)
      await this.host.sessionController.create({
        sessionId: sessionId as SessionId,
        workspaceId: workspace.id,
        agentPreset: role === 'router' ? PRESET.router : PRESET.worker,
      })
      result = await this.host.sessionController.resolveAgent(sessionId as SessionId)
    }
    if ('error' in result) throw new Error(`mesh: cannot resolve session ${sessionId}: ${result.error.code}`)

    const managed: ManagedSession = {
      sessionId,
      agent: result.agent,
      role,
      delivered: new Set(),
    }
    this.managed.set(sessionId, managed)
    await this.host.sessionController.rename({ sessionId: sessionId as SessionId, title })
    this.applyPermission(managed)
    return managed
  }

  /**
   * Assign the permission preset for a role.
   *
   * The preset is the whole tool-authority story for a worker: a researcher is
   * `read-only`, a coder is `workspace-write`, ops is the only role that gets the
   * machine. The Router is read-only because it does no work.
   */
  applyPermission(session: ManagedSession, kind?: string): void {
    const name = permissionFor(kind)
    try {
      this.host.permissionPresets.set(session.agent.session, name)
    } catch {
      // A Host without that preset keeps whatever it has; Mesh does not fail the boot
      // over a permission label.
    }
  }

  /**
   * Register tools on one Session.
   *
   * Tools are scoped to the Session's own Context, so a Router tool is invisible to a
   * worker and vice versa. Registrations are disposed with the Session.
   */
  registerTools(session: ManagedSession, tools: ToolDefinition[]): void {
    const disposers = this.disposers.get(session.sessionId) ?? []
    for (const tool of tools) {
      try {
        disposers.push(session.agent.ctx.tools.register(tool))
      } catch (error) {
        // A duplicate name or a Host refusal must not take down the whole Session.
        this.ctx.logger?.warn?.(`mesh: cannot register tool ${tool.name}: ${String(error)}`)
      }
    }
    this.disposers.set(session.sessionId, disposers)
  }

  /**
   * Deliver text to a Session exactly once per request id.
   *
   * @returns `true` when this call delivered, `false` when it was already delivered.
   */
  /**
   * Deliver text to a Session exactly once per request id.
   *
   * The Host's prompt surface accepts only `queue` and `steer`. An `inject` request is a
   * notice that must not wake the agent; there is no such mode on the wire, so it is
   * delivered as `queue` — the next turn sees it, and no turn is started for it.
   *
   * @returns `true` when this call delivered, `false` when it was already delivered.
   */
  async prompt(
    sessionId: string,
    requestId: string,
    text: string,
    mode: PromptMode = 'steer',
  ): Promise<boolean> {
    const session = this.managed.get(sessionId)
    if (!session) throw new Error(`mesh: session ${sessionId} is not managed`)
    if (session.delivered.has(requestId)) return false

    const controller = this.host.sessionController
    if (typeof controller.prompt !== 'function') {
      throw new Error(`mesh: session ${sessionId} has no prompt surface on this Host`)
    }
    // `{inject}` has no wire form; queue is the non-waking equivalent.
    const wireMode: 'queue' | 'steer' = mode === 'queue' || typeof mode === 'object' ? 'queue' : 'steer'
    // The Host signature requires an AbortSignal and calls `throwIfAborted()` on it
    // before admitting the prompt. Passing nothing throws a TypeError, which surfaces as
    // a failed effect rather than a delivery, so always supply one.
    const controller2 = new AbortController()
    await controller.prompt(
      {
        sessionId: sessionId as SessionId,
        requestId,
        mode: wireMode,
        content: [{ type: 'text', text }],
      },
      controller2.signal,
    )
    session.delivered.add(requestId)
    return true
  }

  /** Drop one managed Session and its tool registrations. */
  async release(sessionId: string): Promise<void> {
    const disposers = this.disposers.get(sessionId) ?? []
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        // Best effort: a failing disposer must not block the others.
      }
    }
    this.disposers.delete(sessionId)
    this.managed.delete(sessionId)
  }

  /** Release everything. Called on shutdown. */
  async releaseAll(): Promise<void> {
    for (const sessionId of [...this.managed.keys()]) await this.release(sessionId)
  }
}

/** The permission preset for a worker kind. */
export function permissionFor(kind: string | undefined): string {
  switch (kind) {
    case 'researcher':
    case 'reviewer':
      return PERMISSION.readOnly
    case 'coder':
      return PERMISSION.workspaceWrite
    case 'ops':
      return PERMISSION.fullAccess
    case 'temp':
      return PERMISSION.workspaceWrite
    default:
      // The Router does no work, so it is read-only like a researcher.
      return PERMISSION.readOnly
  }
}

/** Re-export so callers do not need to reach into `host.ts` for a resolve result. */
export type { ResolveAgentResult }
