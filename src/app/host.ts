/**
 * The slice of the DSH Host API this bundle actually uses.
 *
 * These are structural declarations, not imports: the Host supplies the real objects
 * through `ctx.inject`, and this bundle never imports a `@deepseek-ai/dsh-*` runtime
 * package. Declaring the shape here keeps `app/` and `executor/` type-safe without
 * pinning a Host version, and documents exactly which surface Mesh depends on.
 *
 * Every member below was verified against a running Host (dsh 0.2.2-rc.1):
 * `sessions.get/list`, `agents.get/list`, `sessionController.resolveAgent/create`,
 * `permissionPresets.presets/set` (`read-only`, `workspace-write`,
 * `danger-full-access`), `workspaceRegistry.create`, `tools.register`,
 * `schedule.create`, `tokenMeter.measure`.
 */

import type { Context } from '@deepseek-ai/cordis'

/** A message id. Opaque to Mesh. */
export type MessageId = string & { readonly __brand?: 'MessageId' }
/** A session id. Opaque to Mesh. */
export type SessionId = string & { readonly __brand?: 'SessionId' }

/** Token accounting for one assistant message. */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  reasoningTokens?: number
}

/** The events Mesh observes. Only `assistant/message` carries usage. */
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data?: {
    usage?: TokenUsage
    turn?: number
    step?: number
    [key: string]: unknown
  }
}

/** A live Session. Mesh reads `id` and listens for events; it does not mutate the log. */
export interface Session {
  id: SessionId
  append?: (type: string, data: unknown) => void
  [key: string]: unknown
}

/** A live Agent, which owns a Session and a scoped Context. */
export interface Agent {
  id: SessionId
  session: Session
  ctx: Context
  [key: string]: unknown
}

/** Result of resolving a Session: the Agent, or a typed failure. */
export type ResolveAgentResult =
  | { agent: Agent }
  | { error: { code: string; message?: string } }

/** How a message is handed to a Session. */
export type PromptMode = 'queue' | 'steer' | { inject: string }

/** The workspace record a Session belongs to. */
export interface Workspace {
  id: string
  path?: string
  [key: string]: unknown
}

/** `ctx.sessions`: the in-memory Session store. */
export interface SessionsService {
  get(id: SessionId): Session | undefined
  list(): Session[]
}

/** `ctx.agents`: the in-memory Agent registry. */
export interface AgentsService {
  get(id: SessionId): Agent | undefined
  list(): Agent[]
}

/** `ctx.sessionController`: create, resolve, and drive Sessions. */
export interface SessionControllerService {
  resolveAgent(sessionId: SessionId): Promise<ResolveAgentResult>
  create(request: {
    sessionId?: SessionId
    workspaceId?: string
    agentPreset?: string
  }): Promise<{ sessionId?: SessionId; error?: { code: string; message?: string } }>
  rename(request: { sessionId: SessionId; title: string }): Promise<unknown>
  prompt?(
    request: {
      sessionId: SessionId
      requestId: string
      mode?: 'queue' | 'steer'
      content: { type: 'text'; text: string }[]
    },
    signal?: AbortSignal,
  ): Promise<unknown>
}

/** `ctx.permissionPresets`: the runtime permission dial. */
export interface PermissionPresetsService {
  presets: Record<string, unknown>
  catalog(): unknown
  set(session: Session, name: string): void
  current(session: Session): string
}

/** `ctx.workspaceRegistry`: durable workspace records. */
export interface WorkspaceRegistryService {
  create(path: string, title?: string): Promise<Workspace>
}

/** A tool's JSON-Schema parameter description. */
export interface ToolParameters {
  type: 'object'
  properties?: Record<string, unknown>
  required?: string[]
  [key: string]: unknown
}

/** How a tool renders its result. */
export interface ToolOutput {
  schema?: Record<string, unknown>
  render?: (args: unknown, value: unknown) => { type: 'text'; text: string }[]
}

/** Execution context handed to a tool. */
export interface ToolExecution {
  signal?: AbortSignal
  agent?: Agent
}

/** A registered tool. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: ToolParameters
  output?: ToolOutput
  execute: (args: unknown, execution: ToolExecution) => Promise<unknown> | unknown
}

/** `ctx.tools`: the per-Agent tool registry. */
export interface ToolsService {
  register(definition: ToolDefinition): () => void
}

/** A schedule timing. `every` is the only one Mesh uses. */
export type ScheduleTiming =
  | { kind: 'every'; every_seconds: number }
  | { kind: 'after'; after_seconds: number }
  | { kind: 'rrule'; rrule: string }

/** A schedule delivery target. */
export type ScheduleTarget =
  | { kind: 'session'; sessionId: SessionId }
  | { kind: 'new' }
  | { kind: 'new_once' }

/** `ctx.schedule`: durable timed prompts. */
export interface ScheduleService {
  create(
    request: { title: string; prompt: string; timing: ScheduleTiming; target?: ScheduleTarget },
    actorSessionId?: SessionId,
  ): Promise<{ id: string; [key: string]: unknown }>
  edit(request: {
    id: string
    action: 'update'
    patch: Record<string, unknown>
    expectedUpdatedAt?: string | null
  }): Promise<unknown>
  run(request: { id: string }): Promise<unknown>
  list?(request?: unknown): Promise<unknown>
}

/** `ctx.tokenMeter`: context pressure, NOT cumulative spend. */
export interface TokenMeterService {
  measure(session: Session): { totalTokens: number; surfaceTokens: number; nodes?: unknown }
}

/** The Host services Mesh needs, all resolvable inside one `ctx.inject`. */
export interface HostServices {
  sessions: SessionsService
  agents: AgentsService
  sessionController: SessionControllerService
  workspaceRegistry: WorkspaceRegistryService
  permissionPresets: PermissionPresetsService
  tools: ToolsService
}

/** The services Mesh uses when present but can live without. */
export interface OptionalHostServices {
  schedule?: ScheduleService
  tokenMeter?: TokenMeterService
}

/** Every service name Mesh requires. Passing this to `ctx.inject` defers startup. */
export const REQUIRED_SERVICES = [
  'sessions',
  'agents',
  'sessionController',
  'workspaceRegistry',
  'permissionPresets',
  'tools',
] as const

/** Permission preset names Mesh assigns. */
export const PERMISSION = {
  /** Researchers and reviewers: read the repo, change nothing. */
  readOnly: 'read-only',
  /** Coders: write inside the workspace. */
  workspaceWrite: 'workspace-write',
  /** Ops: the full machine, granted only to ops tickets. */
  fullAccess: 'danger-full-access',
} as const

/** Presets Mesh creates for its own Sessions. */
export const PRESET = {
  router: 'mesh-router',
  worker: 'mesh-worker',
} as const

/** Session id prefix for a resident worker. */
export function residentSessionId(kind: string, seq = 1): string {
  return `mesh-${kind}-${seq}`
}

/** Session id for a per-ticket worker. */
export function tempSessionId(ticketId: string): string {
  return `mesh-temp-${ticketId}`
}

/**
 * Declare the Host services and events Mesh consumes on the Cordis Context.
 *
 * These augmentations are type-only: the real objects are supplied by the Host at
 * runtime through `ctx.inject`. Declaring them here is what lets `app/` and `executor/`
 * call `ctx.sessions.get()` and `ctx.on('session/event', …)` without importing a Host
 * runtime package.
 */
declare module '@deepseek-ai/cordis' {
  interface Context {
    sessions: SessionsService
    agents: AgentsService
    sessionController: SessionControllerService
    workspaceRegistry: WorkspaceRegistryService
    permissionPresets: PermissionPresetsService
    tools: ToolsService
    schedule?: ScheduleService
    tokenMeter?: TokenMeterService
  }

  interface Events {
    'session/event': (session: Session, event: SessionEvent) => void
    dispose: () => void
  }
}
