/**
 * Domain model: the shapes every other module agrees on.
 *
 * Nothing here imports a DSH package. `core/` stays a pure library so it can be
 * unit-tested without a running Harness, and so the state machine can be reasoned
 * about without knowing which process or Session it lives in.
 */

import { z } from 'zod'

/** A worker's specialty. `temp` is a per-ticket worker with no standing role. */
export const WorkerKind = z.enum(['researcher', 'coder', 'reviewer', 'ops', 'temp'])
export type WorkerKind = z.infer<typeof WorkerKind>

/** `explicit` work is what a person asked for; `inferred` is what Mesh deduced. */
export const Mandate = z.enum(['explicit', 'inferred'])
export type Mandate = z.infer<typeof Mandate>

/** Where a ticket sits. Mirrors superagent's five stages. */
export const TicketStage = z.enum(['waiting', 'working', 'idle', 'person', 'ended'])
export type TicketStage = z.infer<typeof TicketStage>

/** How a ticket ended. `stopped` is the only outcome a person can still undo. */
export const TicketOutcome = z.enum(['completed', 'dropped', 'merged', 'closed', 'stopped'])
export type TicketOutcome = z.infer<typeof TicketOutcome>

/** A message's intent on the bus. */
export const MessageType = z.enum([
  'tell', 'ask', 'publish', 'escalate', 'report', 'needs', 'gate',
])
export type MessageType = z.infer<typeof MessageType>

/** Delivery state of one bus message. */
export const MessageState = z.enum(['pending', 'delivered', 'archived', 'dropped'])
export type MessageState = z.infer<typeof MessageState>

/** A worker session's coarse state. */
export const WorkerStatus = z.enum(['starting', 'idle', 'busy', 'stopped'])
export type WorkerStatus = z.infer<typeof WorkerStatus>

/** Coalition lifecycle. */
export const CoalitionState = z.enum([
  'proposed', 'approved', 'round', 'merging', 'dissolved', 'archived',
])
export type CoalitionState = z.infer<typeof CoalitionState>

/** Gate lifecycle. */
export const GateState = z.enum(['pending', 'approved', 'rejected', 'escalated'])
export type GateState = z.infer<typeof GateState>

/** What a worker reports back about its ticket. */
export const ReportState = z.enum(['progress', 'ready', 'blocked', 'failed', 'dropped'])
export type ReportState = z.infer<typeof ReportState>

/**
 * One gate requirement declared by the Router in the dispatch artifact.
 * `holderKind` names the role that must approve; the Engine resolves it to a worker.
 */
export const GateSpec = z.object({
  id: z.string().min(1),
  holderKind: WorkerKind,
  question: z.string().min(1),
  timeoutMin: z.number().int().positive().default(30),
})
export type GateSpec = z.infer<typeof GateSpec>

/** One step of a pre-written rotation script (form A of a coalition). */
export const RoundScriptStep = z.object({
  speakerKind: WorkerKind,
  ask: z.string().min(1),
  schema: z.string().min(1),
})
export type RoundScriptStep = z.infer<typeof RoundScriptStep>

/**
 * The Router's structured decision when it accepts a request.
 *
 * This artifact IS the ticket spec: it carries the goal, the boundaries, the
 * acceptance bar, the budget, the mandatory gates, and (optionally) a rotation
 * script. Everything a worker needs to start is here, so starting one costs no
 * further inference.
 */
export const DispatchArtifact = z.object({
  title: z.string().min(1).max(200),
  workerKind: WorkerKind,
  goal: z.string().min(1),
  boundaries: z.array(z.string()).default([]),
  acceptance: z.array(z.string()).default([]),
  budget: z.object({ tokens: z.number().int().positive() }).optional(),
  gates: z.array(GateSpec).default([]),
  /**
   * Optional. An empty list means form B: every member answers the same question
   * once and the moderator merges the fields. A non-empty list means form A: a
   * pre-written rotation, valid only when the shape was known up front.
   */
  coalitionScript: z.array(RoundScriptStep).default([]),
  routingNote: z.string().max(600).default(''),
})
export type DispatchArtifact = z.infer<typeof DispatchArtifact>

/** One attempt at a ticket. Retrying a ticket appends an assignment; it never mutates one. */
export const Assignment = z.object({
  id: z.string().min(1),
  workerId: z.string().min(1),
  state: z.enum(['pending', 'running', 'idle', 'ended', 'gated']),
  startedAt: z.string(),
  endedAt: z.string().optional(),
  note: z.string().optional(),
})
export type Assignment = z.infer<typeof Assignment>

/** One inbound item attached to a ticket (a person's follow-up, a worker report, a gate answer). */
export const TicketInput = z.object({
  id: z.string().min(1),
  kind: z.enum(['human', 'worker', 'gate', 'system']),
  text: z.string(),
  at: z.string(),
  delivered: z.boolean().default(false),
})
export type TicketInput = z.infer<typeof TicketInput>

/** How a ticket ended. */
export const TicketEnding = z.object({
  at: z.string(),
  by: z.enum(['worker', 'human', 'system']),
  outcome: TicketOutcome,
  reason: z.string().optional(),
})
export type TicketEnding = z.infer<typeof TicketEnding>

/** A unit of work. */
export const Ticket = z.object({
  id: z.string().min(1),
  title: z.string(),
  spec: DispatchArtifact,
  origin: z.object({
    triggerIds: z.array(z.string()).default([]),
    human: z.boolean().default(false),
    thread: z.string().optional(),
  }),
  mandate: Mandate,
  assignments: z.array(Assignment).default([]),
  inputs: z.array(TicketInput).default([]),
  undelivered: z.array(z.string()).default([]),
  /** Thread keys this ticket follows. A ticket waits for these to close before ending. */
  follows: z.array(z.string()).default([]),
  /** Gate ids declared for this ticket. Workers may add but never remove. */
  gates: z.array(z.string()).default([]),
  stage: TicketStage.default('waiting'),
  createdAt: z.string(),
  updatedAt: z.string(),
  ended: TicketEnding.optional(),
})
export type Ticket = z.infer<typeof Ticket>

/** One message on the bus. */
export const Message = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  from: z.string().min(1),
  to: z.string().optional(),
  topic: z.string().optional(),
  thread: z.string().optional(),
  type: MessageType,
  body: z.string().default(''),
  summary: z.string().optional(),
  ttl: z.number().int().optional(),
  refs: z.array(z.string()).default([]),
  needs: z.object({
    text: z.string(),
    urgency: z.enum(['advisory', 'blocking']).default('advisory'),
  }).optional(),
  gate: z.object({ gateId: z.string(), blocking: z.boolean().default(false) }).optional(),
  state: MessageState.default('pending'),
  at: z.string(),
})
export type Message = z.infer<typeof Message>

/** A registered worker. `offers` is static (from the preset), never self-reported at runtime. */
export const Worker = z.object({
  id: z.string().min(1),
  kind: WorkerKind,
  sessionId: z.string().min(1),
  status: WorkerStatus.default('starting'),
  offers: z.object({ keywords: z.array(z.string()).default([]) }).default({ keywords: [] }),
  resident: z.boolean().default(false),
  ticketId: z.string().optional(),
  registeredAt: z.string(),
  lastSeenAt: z.string().optional(),
})
export type Worker = z.infer<typeof Worker>

/** A temporary group assembled for one question. */
export const CoalitionOutput = z.object({
  round: z.number().int().nonnegative(),
  speaker: z.string(),
  fields: z.record(z.string(), z.unknown()).default({}),
  at: z.string(),
})
export type CoalitionOutput = z.infer<typeof CoalitionOutput>

/** A coalition's full state. */
export const Coalition = z.object({
  id: z.string().min(1),
  topic: z.string(),
  ticketId: z.string().optional(),
  memberIds: z.array(z.string()).default([]),
  leadId: z.string(),
  mandate: Mandate,
  budget: z.object({ tokens: z.number().int().positive(), used: z.number().int().nonnegative().default(0) }),
  deadline: z.string(),
  state: CoalitionState.default('proposed'),
  script: z.array(RoundScriptStep).default([]),
  round: z.number().int().nonnegative().default(0),
  question: z.string().default(''),
  outputs: z.array(CoalitionOutput).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Coalition = z.infer<typeof Coalition>

/** A mandatory consultation gate. */
export const Gate = z.object({
  id: z.string().min(1),
  ticketId: z.string().min(1),
  fromWorker: z.string().min(1),
  toWorker: z.string().min(1),
  question: z.string(),
  state: GateState.default('pending'),
  deadline: z.string(),
  createdAt: z.string(),
  /** Depth in the gate dependency chain. Beyond MAX_GATE_DEPTH the Engine escalates. */
  depth: z.number().int().nonnegative().default(0),
  /** Which gate is waiting on this one. Used for cycle detection. */
  blocksGateId: z.string().optional(),
  /** Who adjudicates a timeout. Must not be a party to this ticket. */
  escalationTarget: z.string().optional(),
  decision: z.object({
    at: z.string(),
    alternative: z.string().optional(),
    note: z.string().optional(),
  }).optional(),
})
export type Gate = z.infer<typeof Gate>

/** Accumulated token usage for one scope. */
export const Usage = z.object({
  scope: z.enum(['ticket', 'coalition', 'worker', 'system']),
  scopeId: z.string(),
  sessionId: z.string(),
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  cacheReadTokens: z.number().int().nonnegative().default(0),
  cacheWriteTokens: z.number().int().nonnegative().default(0),
  reasoningTokens: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),
})
export type Usage = z.infer<typeof Usage>

/** Total tokens charged for one usage row. */
export function usageTotal(u: Pick<Usage, 'inputTokens' | 'outputTokens'>): number {
  return u.inputTokens + u.outputTokens
}

/** One thread: a conversation topic that subscriptions hang off. */
export const Thread = z.object({
  key: z.string().min(1),
  topic: z.string().default(''),
  pending: z.array(z.string()).default([]),
  evaluating: z.object({
    id: z.string(),
    triggerIds: z.array(z.string()).default([]),
    primary: z.string(),
    strength: z.number(),
    startedAt: z.string(),
    deadline: z.string(),
    requeues: z.number().int().nonnegative().default(0),
  }).optional(),
  subscribers: z.array(z.string()).default([]),
  correlated: z.array(z.string()).default([]),
  lastAt: z.string(),
})
export type Thread = z.infer<typeof Thread>

/** An audit row. Append-only; never updated, never deleted. */
export const AuditEntry = z.object({
  seq: z.number().int().nonnegative(),
  at: z.string(),
  actor: z.string(),
  kind: z.string(),
  value: z.record(z.string(), z.unknown()).default({}),
})
export type AuditEntry = z.infer<typeof AuditEntry>

/** A worker's structured report back to its ticket. */
export const WorkerReport = z.object({
  state: ReportState,
  text: z.string().default(''),
  result: z.string().optional(),
  humanAction: z.string().optional(),
  refs: z.array(z.string()).default([]),
})
export type WorkerReport = z.infer<typeof WorkerReport>

/** A structured answer a coalition member returns for one round. */
export const StructuredAnswer = z.object({
  fields: z.record(z.string(), z.unknown()).default({}),
  summary: z.string().default(''),
})
export type StructuredAnswer = z.infer<typeof StructuredAnswer>

/** Generate an id with a stable prefix. */
export function newId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10)
  return `${prefix}-${Date.now().toString(36)}-${rand}`
}

/** ISO timestamp for "now". */
export function now(): string {
  return new Date().toISOString()
}
