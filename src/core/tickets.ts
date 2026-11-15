/**
 * The ticket state machine.
 *
 * A ticket is the unit of work. Its lifecycle is deliberately small but has two
 * subtleties that are easy to get wrong and expensive to debug:
 *
 * - **`followsDone`**: a ticket that reported `ready` while following a thread stays
 *   in `person` until that thread closes. Reporting done is not the same as being done.
 * - **`unfinished`**: a thread closing does not end a ticket whose worker is still
 *   handling a person's message. The ending waits.
 *
 * Ending is "burn the ticket, keep the session": the ticket stops accepting input and
 * kills background work, but the worker Session stays alive so a person's follow-up
 * resumes with full history. Only a person's message can revive an ended ticket, and
 * `stopped` is the one outcome that never revives.
 */

import {
  type Assignment, type DispatchArtifact, type Mandate, type ReportState, type Ticket,
  type TicketInput, type WorkerReport, newId, now,
} from './model.ts'
import type { Store } from './store.ts'

/** Why a ticket ended. */
export interface EndTicketRequest {
  ticketId: string
  by: 'worker' | 'human' | 'system'
  outcome: Ticket['ended'] extends { outcome: infer O } | undefined ? O : never
  reason?: string
}

/** What creating a ticket needs. */
export interface CreateTicketRequest {
  spec: DispatchArtifact
  mandate: Mandate
  human: boolean
  thread?: string
  triggerIds?: string[]
}

/**
 * Tickets: creation, assignment, reporting, ending, revival.
 *
 * Every method is called inside an Engine command's transaction; none of them open
 * their own.
 */
export class Tickets {
  constructor(private readonly store: Store) {}

  /** Create a ticket in `waiting`. */
  create(request: CreateTicketRequest): Ticket {
    const timestamp = now()
    const ticket: Ticket = {
      id: newId('ticket'),
      title: request.spec.title,
      spec: request.spec,
      origin: {
        triggerIds: request.triggerIds ?? [],
        human: request.human,
        ...(request.thread === undefined ? {} : { thread: request.thread }),
      },
      mandate: request.mandate,
      assignments: [],
      inputs: [],
      undelivered: [],
      follows: [],
      gates: request.spec.gates.map(g => g.id),
      stage: 'waiting',
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.store.putTicket(ticket)
    this.store.audit('router', 'ticket.create', {
      ticket: ticket.id, mandate: ticket.mandate, workerKind: ticket.spec.workerKind,
      gates: ticket.gates.length,
    })
    return ticket
  }

  /** Append an assignment and move the ticket to `working`. */
  assign(ticketId: string, workerId: string, note?: string): Ticket {
    const ticket = this.require(ticketId)
    if (ticket.ended) throw new Error(`mesh: ticket ${ticketId} has ended`)
    const assignment: Assignment = {
      id: newId('assign'),
      workerId,
      state: 'pending',
      startedAt: now(),
      ...(note === undefined ? {} : { note }),
    }
    ticket.assignments.push(assignment)
    ticket.stage = 'working'
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    this.store.audit('program', 'ticket.assign', { ticket: ticketId, worker: workerId, assignment: assignment.id })
    return ticket
  }

  /** Mark an assignment as running. */
  startAssignment(ticketId: string, assignmentId: string): Ticket {
    const ticket = this.require(ticketId)
    const assignment = ticket.assignments.find(a => a.id === assignmentId)
    if (assignment) {
      assignment.state = 'running'
      ticket.updatedAt = now()
      this.store.putTicket(ticket)
    }
    return ticket
  }

  /**
   * Apply a worker's report.
   *
   * `ready` ends the ticket unless it follows a thread; `dropped` ends it as
   * out-of-scope; `blocked`/`failed` move it to `person` so a human sees it.
   */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.require(ticketId)
    if (ticket.ended) return ticket

    const assignment = [...ticket.assignments].reverse().find(a => a.state === 'running' || a.state === 'pending')
    if (assignment) {
      assignment.state = report.state === 'progress' ? 'running' : 'ended'
      if (report.state !== 'progress') assignment.endedAt = now()
    }

    switch (report.state) {
      case 'progress':
        ticket.stage = 'working'
        break
      case 'ready':
        // Reporting ready while following a thread parks the ticket in `person`
        // until the thread closes. The worker is done; the work is not.
        ticket.stage = ticket.follows.length > 0 ? 'person' : 'working'
        if (ticket.follows.length === 0) {
          this.endInPlace(ticket, 'worker', 'completed', report.text)
        }
        break
      case 'dropped':
        this.endInPlace(ticket, 'worker', 'dropped', report.text || report.humanAction)
        break
      case 'blocked':
      case 'failed':
        ticket.stage = 'person'
        break
    }
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    this.store.audit('worker', 'ticket.report', {
      ticket: ticketId, state: report.state, hasHumanAction: report.humanAction !== undefined,
    })
    return ticket
  }

  /** Attach an inbound item. Undelivered items are queued for the worker. */
  addInput(ticketId: string, input: Omit<TicketInput, 'id' | 'at'>): { ticket: Ticket; inputId: string } {
    const ticket = this.require(ticketId)
    if (ticket.ended) throw new Error(`mesh: ticket ${ticketId} has ended`)
    const item: TicketInput = { ...input, id: newId('input'), at: now() }
    ticket.inputs.push(item)
    if (!item.delivered) ticket.undelivered.push(item.id)
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    return { ticket, inputId: item.id }
  }

  /** Mark queued inputs as delivered. */
  markDelivered(ticketId: string, inputIds: string[]): Ticket {
    const ticket = this.require(ticketId)
    const delivered = new Set(inputIds)
    ticket.undelivered = ticket.undelivered.filter(id => !delivered.has(id))
    for (const input of ticket.inputs) {
      if (delivered.has(input.id)) input.delivered = true
    }
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    return ticket
  }

  /** Subscribe a ticket to a thread. A followed thread gates its ending. */
  follow(ticketId: string, thread: string): Ticket {
    const ticket = this.require(ticketId)
    if (!ticket.follows.includes(thread)) ticket.follows.push(thread)
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    return ticket
  }

  /** Drop a follow. */
  unfollow(ticketId: string, thread: string): Ticket {
    const ticket = this.require(ticketId)
    ticket.follows = ticket.follows.filter(key => key !== thread)
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    return ticket
  }

  /**
   * Note that a followed thread closed.
   *
   * If every followed thread is now closed and the ticket was only waiting on them,
   * it ends. If the worker is still handling a person's message the ticket stays
   * alive (`unfinished`).
   */
  threadClosed(ticketId: string, thread: string): Ticket {
    const ticket = this.require(ticketId)
    if (ticket.ended) return ticket
    ticket.follows = ticket.follows.filter(key => key !== thread)
    if (ticket.follows.length > 0) {
      ticket.updatedAt = now()
      this.store.putTicket(ticket)
      return ticket
    }
    // Every follow closed. Only end if the ticket was parked waiting on them.
    if (ticket.stage === 'person' && ticket.undelivered.length === 0) {
      this.endInPlace(ticket, 'system', 'closed', 'all followed threads closed')
    }
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    return ticket
  }

  /** Park a ticket on a gate. */
  gate(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    const assignment = [...ticket.assignments].reverse().find(a => a.state === 'running' || a.state === 'pending')
    if (assignment) assignment.state = 'gated'
    ticket.stage = 'idle'
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    return ticket
  }

  /** Release a ticket from a gate back to running. */
  ungate(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    const assignment = [...ticket.assignments].reverse().find(a => a.state === 'gated')
    if (assignment) assignment.state = 'running'
    ticket.stage = 'working'
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    return ticket
  }

  /** End a ticket by a person's explicit stop. The one outcome that never revives. */
  stop(ticketId: string, reason?: string): Ticket {
    const ticket = this.require(ticketId)
    if (ticket.ended) return ticket
    this.endInPlace(ticket, 'human', 'stopped', reason)
    this.store.putTicket(ticket)
    return ticket
  }

  /**
   * Revive an ended ticket because a person spoke.
   *
   * Only a human message may do this, and never a `stopped` ticket. The worker
   * Session and its history survive, so this restores full context.
   */
  revive(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    if (!ticket.ended) return ticket
    if (ticket.ended.outcome === 'stopped') {
      throw new Error(`mesh: ticket ${ticketId} was stopped by a person and cannot be revived`)
    }
    ticket.ended = undefined
    ticket.stage = 'working'
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    this.store.audit('human', 'ticket.revive', { ticket: ticketId })
    return ticket
  }

  /** Retry an ended ticket with a fresh assignment on the same session. */
  retry(ticketId: string, workerId: string): Ticket {
    const ticket = this.require(ticketId)
    ticket.ended = undefined
    ticket.stage = 'working'
    const assignment: Assignment = {
      id: newId('assign'),
      workerId,
      state: 'pending',
      startedAt: now(),
      note: 'RETRIED',
    }
    ticket.assignments.push(assignment)
    ticket.updatedAt = now()
    this.store.putTicket(ticket)
    this.store.audit('human', 'ticket.retry', { ticket: ticketId, worker: workerId })
    return ticket
  }

  /** Reject input to an ended ticket, matching the `ticketEnded` user error. */
  assertOpen(ticketId: string): Ticket {
    const ticket = this.require(ticketId)
    if (ticket.ended) throw new Error(`mesh: ticket ${ticketId} has ended (${ticket.ended.outcome})`)
    return ticket
  }

  /** Read a ticket or throw. */
  require(ticketId: string): Ticket {
    const ticket = this.store.getTicket(ticketId)
    if (!ticket) throw new Error(`mesh: unknown ticket ${ticketId}`)
    return ticket
  }

  /** End in place without an extra write, so callers can batch the put. */
  private endInPlace(
    ticket: Ticket,
    by: 'worker' | 'human' | 'system',
    outcome: NonNullable<Ticket['ended']>['outcome'],
    reason?: string,
  ): void {
    ticket.ended = { at: now(), by, outcome, ...(reason === undefined ? {} : { reason }) }
    ticket.stage = 'ended'
    // Ending rejects further input and drops anything still queued.
    ticket.undelivered = []
    for (const assignment of ticket.assignments) {
      if (assignment.state !== 'ended') {
        assignment.state = 'ended'
        assignment.endedAt = assignment.endedAt ?? now()
      }
    }
    this.store.audit(by === 'human' ? 'human' : 'program', 'ticket.end', {
      ticket: ticket.id, outcome, by,
    })
  }
}

/** Whether a report state ends a ticket. */
export function endsTicket(state: ReportState): boolean {
  return state === 'ready' || state === 'dropped'
}
