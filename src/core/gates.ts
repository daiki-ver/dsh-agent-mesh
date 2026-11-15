/**
 * Consultation gates.
 *
 * A gate parks a ticket until a specific holder approves or rejects. Its value is
 * **not** that two models check each other — every worker is the same model, so that
 * would buy nothing. Its value is that changing a plan or delivering a page becomes
 * explicit, audited, and impossible to do quietly. The benefit is traceability and a
 * forced pause, not a better judgement.
 *
 * Because gates park work, they are a deadlock hazard, and three rules keep them from
 * deadlocking. All three are enforced here rather than trusted to prompts:
 *
 * - **A: the holder cannot itself be parked.** Someone waiting for an answer cannot
 *   sign for someone else. Opening such a gate is refused and escalated instead.
 * - **B: the escalation target cannot be a party to this ticket.** Otherwise a
 *   timeout is "reviewed" by the very worker that timed out.
 * - **C: cycles are detected.** Gate dependencies form a graph; a cycle is escalated
 *   rather than waited on, and depth beyond `MAX_GATE_DEPTH` escalates immediately.
 *
 * Also: at most **one** open gate per ticket. Parallel gates are a deadlock breeding
 * ground, and "two signatures" from one model is not stronger than one.
 */

import { type Gate, type GateState, newId, now } from './model.ts'
import type { Store } from './store.ts'

/** How deep a gate chain may go before it is escalated instead of waited on. */
export const MAX_GATE_DEPTH = 3
/** Default gate timeout. */
export const DEFAULT_GATE_TIMEOUT_MIN = 30

/** Why a gate could not be opened. */
export class GateRefused extends Error {
  constructor(readonly reason: 'holder-parked' | 'gate-open' | 'depth' | 'unknown-ticket', message: string) {
    super(message)
    this.name = 'GateRefused'
  }
}

/** Opening request. */
export interface OpenGateRequest {
  ticketId: string
  fromWorker: string
  toWorker: string
  question: string
  timeoutMin?: number
  escalationTarget?: string
}

/**
 * Gates: open, decide, escalate, and sweep.
 */
export class Gates {
  constructor(private readonly store: Store) {}

  /**
   * Open a gate, enforcing rules A and C.
   * @throws {GateRefused} when the gate must not be opened; the caller escalates.
   */
  open(request: OpenGateRequest): Gate {
    const ticket = this.store.getTicket(request.ticketId)
    if (!ticket) throw new GateRefused('unknown-ticket', `unknown ticket ${request.ticketId}`)
    if (ticket.ended) throw new GateRefused('unknown-ticket', `ticket ${request.ticketId} has ended`)

    // Rule: one open gate per ticket.
    const existing = this.openGatesForTicket(request.ticketId)
    if (existing.length > 0) {
      throw new GateRefused(
        'gate-open',
        `ticket ${request.ticketId} already has an open gate (${existing[0]?.id}); gates are serial per ticket`,
      )
    }

    // Rule A: the holder must not itself be parked on a gate.
    const holderParked = this.openGatesForWorker(request.toWorker)
    if (holderParked.length > 0) {
      throw new GateRefused(
        'holder-parked',
        `holder ${request.toWorker} is itself waiting on gate ${holderParked[0]?.id}; it cannot sign`,
      )
    }

    // Rule B: the escalation target must not be a party to this ticket.
    if (request.escalationTarget !== undefined && this.isPartyToTicket(request.ticketId, request.escalationTarget)) {
      throw new GateRefused(
        'holder-parked',
        `escalation target ${request.escalationTarget} is a party to ticket ${request.ticketId}`,
      )
    }

    const depth = this.depthFor(request.ticketId, request.fromWorker)
    if (depth >= MAX_GATE_DEPTH) {
      throw new GateRefused('depth', `gate chain depth ${depth} reached MAX_GATE_DEPTH ${MAX_GATE_DEPTH}`)
    }

    const timeoutMin = request.timeoutMin ?? DEFAULT_GATE_TIMEOUT_MIN
    const gate: Gate = {
      id: newId('gate'),
      ticketId: request.ticketId,
      fromWorker: request.fromWorker,
      toWorker: request.toWorker,
      question: request.question,
      state: 'pending',
      deadline: new Date(Date.now() + timeoutMin * 60_000).toISOString(),
      createdAt: now(),
      depth,
      ...(request.escalationTarget === undefined ? {} : { escalationTarget: request.escalationTarget }),
    }
    this.store.putGate(gate)
    ticket.gates = unique([...ticket.gates, gate.id])
    this.store.putTicket(ticket)
    this.store.audit('worker', 'gate.open', {
      gate: gate.id, ticket: gate.ticketId, from: gate.fromWorker, to: gate.toWorker, depth,
    })
    return gate
  }

  /** Record an approval or rejection. */
  decide(gateId: string, decision: 'approve' | 'reject', options: { alternative?: string; note?: string } = {}): Gate {
    const gate = this.requireGate(gateId)
    if (gate.state !== 'pending') return gate
    gate.state = decision === 'approve' ? 'approved' : 'rejected'
    gate.decision = {
      at: now(),
      ...(options.alternative === undefined ? {} : { alternative: options.alternative }),
      ...(options.note === undefined ? {} : { note: options.note }),
    }
    this.store.putGate(gate)
    this.store.audit('worker', `gate.${gate.state}`, {
      gate: gate.id, ticket: gate.ticketId, by: gate.toWorker,
      hasAlternative: options.alternative !== undefined,
    })
    return gate
  }

  /** Escalate a gate: a person or the Router must decide. */
  escalate(gateId: string, reason: string): Gate {
    const gate = this.requireGate(gateId)
    if (gate.state !== 'pending') return gate
    gate.state = 'escalated'
    this.store.putGate(gate)
    this.store.audit('program', 'gate.escalate', { gate: gate.id, ticket: gate.ticketId, reason })
    return gate
  }

  /**
   * Rule C: find pending gates past their deadline, and detect cycles.
   * @returns gates that were escalated this sweep.
   */
  sweep(): Gate[] {
    const open = this.store.listGates(true)
    if (open.length === 0) return []
    const escalated: Gate[] = []
    const nowMs = Date.now()

    for (const gate of open) {
      if (Date.parse(gate.deadline) <= nowMs) {
        escalated.push(this.escalate(gate.id, 'deadline'))
      }
    }

    // Cycle detection over `blocksGateId`.
    for (const cycle of findCycles(this.store.listGates(false))) {
      for (const gate of cycle) {
        if (gate.state !== 'pending') continue
        escalated.push(this.escalate(gate.id, `cycle:${cycle.map(g => g.id).join('>')}`))
      }
    }
    return escalated
  }

  /** Open gates for one ticket. */
  openGatesForTicket(ticketId: string): Gate[] {
    return this.store.listGates(true).filter(g => g.ticketId === ticketId)
  }

  /** Gates one worker is currently waiting on (as the asker). */
  openGatesForWorker(workerId: string): Gate[] {
    return this.store.listGates(true).filter(g => g.fromWorker === workerId)
  }

  /** Gates one worker must decide. */
  gatesAwaiting(workerId: string): Gate[] {
    return this.store.listGates(true).filter(g => g.toWorker === workerId)
  }

  requireGate(gateId: string): Gate {
    const gate = this.store.getGate(gateId)
    if (!gate) throw new Error(`mesh: unknown gate ${gateId}`)
    return gate
  }

  /**
   * Whether a worker has already appeared in this ticket's gate history. Rule B uses
   * this to keep a dispute's adjudicator from being a participant.
   */
  isPartyToTicket(ticketId: string, workerId: string): boolean {
    const ticket = this.store.getTicket(ticketId)
    if (ticket) {
      if (ticket.assignments.some(a => a.workerId === workerId)) return true
    }
    return this.store.listGates(false).some(
      g => g.ticketId === ticketId && (g.fromWorker === workerId || g.toWorker === workerId),
    )
  }

  /** Depth of a new gate opened by `fromWorker` on `ticketId`. */
  private depthFor(ticketId: string, fromWorker: string): number {
    const ticket = this.store.getTicket(ticketId)
    const own = ticket ? 0 : 0
    const history = this.store.listGates(false).filter(g => g.ticketId === ticketId)
    const maxDepth = history.reduce((max, g) => Math.max(max, g.depth), own)
    // A worker that has already been a holder in this ticket's chain adds one level.
    const holderBefore = history.some(g => g.toWorker === fromWorker)
    return maxDepth + (holderBefore ? 1 : 0)
  }
}

/** Walk `blocksGateId` edges and return every cycle found. */
export function findCycles(gates: Gate[]): Gate[][] {
  const byId = new Map(gates.map(g => [g.id, g]))
  const cycles: Gate[][] = []
  const seen = new Set<string>()

  for (const start of gates) {
    const path: Gate[] = []
    let current: Gate | undefined = start
    const onPath = new Set<string>()
    while (current) {
      if (onPath.has(current.id)) {
        const index = path.findIndex(g => g.id === current!.id)
        const cycle = path.slice(index)
        const signature = cycle.map(g => g.id).sort().join(',')
        if (!seen.has(signature)) {
          seen.add(signature)
          cycles.push(cycle)
        }
        break
      }
      onPath.add(current.id)
      path.push(current)
      const nextId: string | undefined = current.blocksGateId
      current = nextId === undefined ? undefined : byId.get(nextId)
    }
  }
  return cycles
}

/** Whether a gate state means the ticket may proceed. */
export function gateAllows(state: GateState): boolean {
  return state === 'approved'
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}
