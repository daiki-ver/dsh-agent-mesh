/**
 * The Engine: the only place state changes.
 *
 * Every public method opens exactly one transaction, applies its domain change, and
 * enqueues the side effects that change implies. That is the whole contract, and it
 * buys three things at once:
 *
 * - **Audit completeness** — one command, one transaction, one audit row. Nothing
 *   changes state without leaving a record.
 * - **Crash consistency** — state and intent commit together, so a restart resumes
 *   instead of guessing.
 * - **Budget enforcement** — every dispatch passes through here, so a token ceiling
 *   can be checked before work starts rather than after it is paid for.
 *
 * The domain modules below never call each other; the Engine composes them. That keeps
 * each command a single transaction with a single audit trail.
 */

import {
  type AuditEntry, type Coalition, type DispatchArtifact, type Gate, type Mandate,
  type Message, type ReportState, type StructuredAnswer, type Ticket, type Usage,
  type Worker, type WorkerKind, type WorkerReport, newId, now,
} from './model.ts'
import { type Effects, Later } from './effects.ts'
import type { Store } from './store.ts'
import { Budget, type BudgetAction } from './budget.ts'
import { Bus, type SendRequest, topicKey } from './bus.ts'
import { Coalitions, type CoalitionStep, type ProposeCoalitionRequest } from './coalitions.ts'
import { Directory } from './directory.ts'
import { Evals, type Candidate } from './evals.ts'
import { GateRefused, Gates, MAX_GATE_DEPTH } from './gates.ts'
import { Intake, type Incoming, type IntakeResult } from './intake.ts'
import { Tickets } from './tickets.ts'

/** Effect kinds the Engine enqueues. */
export const EFFECT = {
  assess: 'assess',
  launch: 'launch',
  deliver: 'deliver',
  coalition: 'coalition',
  relay: 'relay',
  notice: 'notice',
  sweep: 'sweep',
} as const

/** The Engine's dependencies. */
export interface EngineOptions {
  store: Store
  effects: Effects
  evalTimeoutMs: number
  coalitionSoft: number
  inferredBlocking: boolean
}

/** What a decision produced. */
export interface DecisionResult {
  ticket: Ticket
  /** Worker the ticket was assigned to, when assignment was possible. */
  workerId?: string
}

/**
 * Engine: commands, one transaction each.
 */
export class Engine {
  readonly store: Store
  readonly effects: Effects
  readonly tickets: Tickets
  readonly intake: Intake
  readonly bus: Bus
  readonly directory: Directory
  readonly gates: Gates
  readonly coalitions: Coalitions
  readonly budget: Budget
  readonly evals: Evals
  private readonly inferredBlocking: boolean

  constructor(options: EngineOptions) {
    this.store = options.store
    this.effects = options.effects
    this.tickets = new Tickets(options.store)
    this.intake = new Intake(options.store, this.tickets)
    this.bus = new Bus(options.store)
    this.directory = new Directory(options.store)
    this.gates = new Gates(options.store)
    this.coalitions = new Coalitions(options.store)
    this.budget = new Budget(options.store, { coalitionSoft: options.coalitionSoft })
    this.evals = new Evals(options.store, options.evalTimeoutMs)
    this.inferredBlocking = options.inferredBlocking
  }

  // ── inbound ──────────────────────────────────────────────────────────────

  /**
   * Take in one message.
   *
   * Direct deliveries are enqueued as effects inside this transaction, so a crash
   * between "stored" and "delivered" resumes delivery rather than dropping it.
   */
  receive(input: Incoming): IntakeResult {
    const result = this.store.atomic(() => {
      const intake = this.intake.receive(input)
      if (intake.disposition === 'duplicate') return intake
      for (const delivery of intake.directDeliveries) {
        this.effects.enqueue(EFFECT.deliver, `${delivery.ticketId}:${delivery.inputId}`, delivery)
      }
      return intake
    })
    // Interactive path: kick the loop so delivery does not wait for the beat.
    if (result.directDeliveries.length > 0) this.effects.kick().catch(() => {})
    return result
  }

  /** Queue a Router assessment for a thread, if it is ready. */
  assess(threadKey: string): Candidate | undefined {
    const candidate = this.store.atomic(() => {
      const started = this.evals.start(threadKey)
      if (!started) return undefined
      this.effects.enqueue(EFFECT.assess, started.evalId, { threadKey, evalId: started.evalId })
      return started.candidate
    })
    if (candidate) this.effects.kick().catch(() => {})
    return candidate
  }

  /** Mark an assessment card as delivered, starting its deadline. */
  assessmentDelivered(threadKey: string): void {
    this.store.atomic(() => this.evals.delivered(threadKey))
  }

  /**
   * A person submits a task to the mesh.
   *
   * This is the inbound entry point for human work. It takes the message in, and when
   * nothing claimed it directly it queues a Router assessment — because a new task with
   * no subscriber is exactly the case the slow channel exists for.
   *
   * @param text - what the person asked for.
   * @param options - an explicit thread key, so follow-ups land on the same thread.
   * @returns the intake result and whether an assessment was queued.
   */
  submit(text: string, options: { thread?: string; id?: string } = {}): {
    intake: IntakeResult
    assessment: Candidate | undefined
    thread: string
  } {
    const id = options.id ?? newId('human')
    const thread = options.thread ?? `thread:${id}`
    const intake = this.receive({
      id,
      text,
      human: true,
      from: 'human',
      thread,
    })
    // Keep the person's words addressable: the assessment card quotes them, so the
    // Router decides from the request itself rather than from a summary of it.
    this.store.kvSet(`intake.text.${id}`, text)
    // A directly-delivered message already reached its worker; anything else needs the
    // Router to decide what it is for.
    const assessment = intake.disposition === 'delivered' ? undefined : this.assess(thread)
    this.store.audit('human', 'task.submit', {
      id, thread, disposition: intake.disposition, assessed: assessment !== undefined,
      chars: text.length,
    })
    return { intake, assessment, thread }
  }

  // ── tickets ──────────────────────────────────────────────────────────────

  /** Create a ticket and assign it, all in one transaction. */
  create(spec: DispatchArtifact, mandate: Mandate, origin: { human: boolean; thread?: string; triggerIds?: string[] }): DecisionResult {
    const result = this.store.atomic(() => {
      const ticket = this.tickets.create({
        spec,
        mandate,
        human: origin.human,
        ...(origin.thread === undefined ? {} : { thread: origin.thread }),
        ...(origin.triggerIds === undefined ? {} : { triggerIds: origin.triggerIds }),
      })
      const worker = this.pickWorker(spec.workerKind, ticket.id)
      if (!worker) {
        // Nothing can take this. Say so loudly rather than leaving the ticket sitting in
        // `waiting` with no explanation — a silent stall is the worst failure mode here.
        this.store.audit('program', 'ticket.unassigned', { ticket: ticket.id, kind: spec.workerKind })
        this.effects.enqueue(EFFECT.notice, `unassigned:${ticket.id}`, {
          name: `ticket:${ticket.id}`,
          summary: `No worker for kind "${spec.workerKind}" — ticket ${ticket.id} is waiting`,
          value: {
            ticketId: ticket.id,
            requestedKind: spec.workerKind,
            available: this.store.listWorkers().map(w => `${w.id}(${w.kind})`),
            hint: 'Retry with mesh_ticket_retry after a matching worker exists, or reassign the kind.',
          },
        })
        return { ticket }
      }
      const assigned = this.tickets.assign(ticket.id, worker.id)
      const assignment = assigned.assignments[assigned.assignments.length - 1]
      if (assignment) {
        this.effects.enqueue(EFFECT.launch, ticket.id, {
          ticketId: ticket.id,
          assignmentId: assignment.id,
          workerId: worker.id,
        })
      }
      if (origin.thread !== undefined) {
        // Subscribe only. A ticket must not follow the thread it was created from, or it
        // would wait forever for a thread of its own making to close.
        this.intake.subscribe(ticket.id, origin.thread, spec.title)
      }
      return { ticket: assigned, workerId: worker.id }
    })
    this.effects.kick().catch(() => {})
    return result
  }

  /** Apply a worker's report. Ends the ticket when the report says so. */
  report(ticketId: string, report: WorkerReport): Ticket {
    const ticket = this.store.atomic(() => {
      const updated = this.tickets.report(ticketId, report)
      // A worker's answer must reach the Router. A worker's closing message stays in its
      // own Session, so without this the Router sees a ticket end with no content and
      // asks again — which is exactly the loop this relay prevents.
      if (report.state === 'ready' || report.state === 'dropped') {
        const answer = report.result ?? report.text
        this.effects.enqueue(EFFECT.relay, `report:${ticketId}:${report.state}`, {
          text: [
            `Ticket ${ticketId} reported ${report.state}.`,
            answer === '' ? '(the worker gave no result text)' : answer,
            updated.ended === undefined ? '' : `Outcome: ${updated.ended.outcome}.`,
          ].filter(line => line !== '').join('\n\n'),
        })
      }
      if (report.state === 'blocked' || report.state === 'failed' || updated.ended) {
        // Surface it to the person without waking the Router.
        this.effects.enqueue(EFFECT.notice, `ticket:${ticketId}:${report.state}`, {
          name: `ticket:${ticketId}`,
          summary: `Ticket ${ticketId} ${updated.ended ? `ended (${updated.ended.outcome})` : report.state}`,
          value: {
            ticketId,
            state: report.state,
            text: report.text,
            humanAction: report.humanAction ?? null,
          },
        })
      }
      return updated
    })
    this.effects.kick().catch(() => {})
    return ticket
  }

  /** A person's message on a ticket: revive if needed, then deliver. */
  note(ticketId: string, text: string): Ticket {
    const ticket = this.store.atomic(() => {
      let current = this.store.getTicket(ticketId)
      if (!current) throw new Error(`mesh: unknown ticket ${ticketId}`)
      if (current.ended) {
        if (current.ended.outcome === 'stopped') {
          throw new Error(`mesh: ticket ${ticketId} was stopped by a person and cannot be revived`)
        }
        current = this.tickets.revive(ticketId)
      }
      const { inputId } = this.tickets.addInput(ticketId, { kind: 'human', text, delivered: false })
      this.effects.enqueue(EFFECT.deliver, `${ticketId}:${inputId}`, { ticketId, inputId })
      return this.store.getTicket(ticketId) ?? current
    })
    this.effects.kick().catch(() => {})
    return ticket
  }

  /** Retry an ended ticket on the same worker session. */
  retryTicket(ticketId: string): Ticket {
    const ticket = this.store.atomic(() => {
      const current = this.tickets.require(ticketId)
      const workerId = current.assignments.at(-1)?.workerId
      if (!workerId) throw new Error(`mesh: ticket ${ticketId} has no prior assignment to retry`)
      const retried = this.tickets.retry(ticketId, workerId)
      const assignment = retried.assignments[retried.assignments.length - 1]
      if (assignment) {
        this.effects.enqueue(EFFECT.launch, ticketId, { ticketId, assignmentId: assignment.id, workerId })
      }
      return retried
    })
    this.effects.kick().catch(() => {})
    return ticket
  }

  /** Stop a ticket. The only outcome a person cannot undo. */
  stopTicket(ticketId: string, reason?: string): Ticket {
    return this.store.atomic(() => this.tickets.stop(ticketId, reason))
  }

  // ── bus ──────────────────────────────────────────────────────────────────

  /** Write a message and enqueue its delivery. */
  send(request: SendRequest): Message {
    const message = this.store.atomic(() => {
      const stored = this.bus.send(request)
      for (const worker of this.bus.recipients(stored)) {
        this.effects.enqueue(EFFECT.deliver, `${worker.id}:${stored.id}`, {
          workerId: worker.id,
          messageId: stored.id,
        })
      }
      return stored
    })
    this.effects.kick().catch(() => {})
    return message
  }

  /** A worker asks a peer something. `gate: true` parks the ticket. */
  ask(from: string, question: string, options: { to?: string; ttlMin?: number; gate?: boolean; ticketId?: string } = {}): { message?: Message; gate?: Gate; needsReview?: boolean } {
    return this.store.atomic(() => {
      // A gate must be resolvable to a concrete holder before it can park anything.
      if (options.gate && options.ticketId) {
        const target = options.to ?? this.directory.matchKeyword(question).matched?.id
        if (!target) return { needsReview: true }
        try {
          const gate = this.gates.open({
            ticketId: options.ticketId,
            fromWorker: from,
            toWorker: target,
            question,
            ...(options.ttlMin === undefined ? {} : { timeoutMin: options.ttlMin }),
          })
          this.tickets.gate(options.ticketId)
          const message = this.bus.send({
            from,
            to: target,
            type: 'gate',
            body: question,
            gate: { gateId: gate.id, blocking: true },
          })
          for (const worker of this.bus.recipients(message)) {
            this.effects.enqueue(EFFECT.deliver, `${worker.id}:${message.id}`, { workerId: worker.id, messageId: message.id })
          }
          return { message, gate }
        } catch (error) {
          if (error instanceof GateRefused) {
            // Rules A/C refused the gate: escalate rather than park.
            this.escalate(from, 'gate-refused', { ticketId: options.ticketId, reason: error.reason, detail: error.message })
            return { needsReview: true }
          }
          throw error
        }
      }

      const message = this.bus.send({
        from,
        ...(options.to === undefined ? {} : { to: options.to }),
        type: 'ask',
        body: question,
      })
      for (const worker of this.bus.recipients(message)) {
        this.effects.enqueue(EFFECT.deliver, `${worker.id}:${message.id}`, { workerId: worker.id, messageId: message.id })
      }
      return { message }
    })
  }

  /** One-way delivery. */
  tell(from: string, to: string, body: string, refs: string[] = []): Message {
    return this.send({ from, to, type: 'tell', body, refs })
  }

  /** Broadcast a summary to a topic's subscribers. */
  publish(from: string, topic: string, summary: string, options: { detailRef?: string; ttl?: number } = {}): Message {
    return this.send({
      from,
      topic,
      type: 'publish',
      body: summary,
      summary,
      ttl: options.ttl ?? 3,
      refs: options.detailRef === undefined ? [] : [options.detailRef],
    })
  }

  /** Resolve a need to a worker using the two-level match plus the explicit fallback. */
  needs(from: string, text: string, routerPick?: (candidates: Worker[]) => Worker | undefined): { matched?: Worker; source: string } {
    return this.store.atomic(() => {
      const result = this.directory.resolve(text, routerPick)
      this.store.audit('worker', 'needs.match', {
        from, source: result.source, matched: result.matched?.id ?? null, keyword: result.keyword ?? null,
      })
      return { ...(result.matched === undefined ? {} : { matched: result.matched }), source: result.source }
    })
  }

  /** Answer a gate. */
  decideGate(gateId: string, decision: 'approve' | 'reject', options: { alternative?: string; note?: string } = {}): Gate {
    const gate = this.store.atomic(() => {
      const decided = this.gates.decide(gateId, decision, options)
      if (decided.state === 'approved') {
        this.tickets.ungate(decided.ticketId)
      } else if (decided.state === 'rejected') {
        // A rejection still releases the ticket: the worker must act on the alternative.
        this.tickets.ungate(decided.ticketId)
        if (options.alternative) {
          const { inputId } = this.tickets.addInput(decided.ticketId, {
            kind: 'gate',
            text: `Gate ${gateId} rejected. Alternative: ${options.alternative}`,
            delivered: false,
          })
          this.effects.enqueue(EFFECT.deliver, `${decided.ticketId}:${inputId}`, {
            ticketId: decided.ticketId,
            inputId,
          })
        }
      }
      return decided
    })
    this.effects.kick().catch(() => {})
    return gate
  }

  /** Record a coalition member's structured answer. */
  coalitionAnswer(coalitionId: string, speaker: string, answer: StructuredAnswer): Coalition {
    const coalition = this.store.atomic(() => {
      const updated = this.coalitions.record(coalitionId, speaker, answer)
      if (updated.state === 'merging') {
        const summary = this.coalitions.merge(coalitionId)
        this.coalitions.dissolve(coalitionId, 'complete', true)
        this.effects.enqueue(EFFECT.notice, `coalition:${coalitionId}:merged`, {
          name: `coalition:${coalitionId}`,
          summary: `Coalition ${updated.topic} merged`,
          value: { coalitionId, summary },
        })
      } else {
        this.effects.enqueue(EFFECT.coalition, coalitionId, { coalitionId })
      }
      return this.store.getCoalition(coalitionId) ?? updated
    })
    this.effects.kick().catch(() => {})
    return coalition
  }

  /** Propose a coalition. */
  proposeCoalition(request: ProposeCoalitionRequest): Coalition {
    const coalition = this.store.atomic(() => {
      const proposed = this.coalitions.propose(request, { inferredBlocking: this.inferredBlocking })
      if (proposed.state === 'approved') {
        this.effects.enqueue(EFFECT.coalition, proposed.id, { coalitionId: proposed.id })
      }
      return proposed
    })
    this.effects.kick().catch(() => {})
    return coalition
  }

  /** Approve a proposed coalition (a person or the Router). */
  approveCoalition(coalitionId: string, by: 'human' | 'router'): Coalition {
    const coalition = this.store.atomic(() => {
      const approved = this.coalitions.approve(coalitionId, by)
      this.effects.enqueue(EFFECT.coalition, coalitionId, { coalitionId })
      return approved
    })
    this.effects.kick().catch(() => {})
    return coalition
  }

  // ── escalation ───────────────────────────────────────────────────────────

  /**
   * Raise a conflict.
   *
   * Procedural conflicts (deadlock, budget, TTL, a cycle) go to the light Router. A
   * substantive disagreement between two workers goes to the reviewer, because an
   * adjudicator must never be weaker than the parties. If the only reviewer is itself a
   * party, it goes to a person instead of being self-reviewed.
   */
  escalate(actor: string, kind: string, detail: Record<string, unknown>): void {
    this.store.atomic(() => {
      const substantive = kind === 'substantive'
      this.store.audit(actor, 'escalate', { kind, ...detail })
      if (substantive) {
        const ticketId = typeof detail.ticketId === 'string' ? detail.ticketId : undefined
        const reviewer = this.store.listWorkers().find(w => w.kind === 'reviewer' && w.status !== 'stopped')
        const reviewerIsParty = ticketId !== undefined && reviewer !== undefined
          ? this.gates.isPartyToTicket(ticketId, reviewer.id)
          : false
        if (reviewer && !reviewerIsParty) {
          this.effects.enqueue(EFFECT.notice, `escalate:${newId('esc')}`, {
            name: 'escalate',
            summary: `Substantive conflict escalated to ${reviewer.id}`,
            value: { kind, ...detail, target: reviewer.id },
          })
          return
        }
        // No disinterested reviewer: a person must decide.
        this.effects.enqueue(EFFECT.notice, `escalate:${newId('esc')}`, {
          name: 'escalate',
          summary: 'Substantive conflict needs a person (no disinterested reviewer)',
          value: { kind, ...detail, target: 'human' },
        })
        return
      }
      this.effects.enqueue(EFFECT.notice, `escalate:${newId('esc')}`, {
        name: 'escalate',
        summary: `Procedural conflict: ${kind}`,
        value: { kind, ...detail, target: 'router' },
      })
    })
  }

  // ── budget ───────────────────────────────────────────────────────────────

  /** Record a usage delta. Memory only; a pass flushes it. */
  recordUsage(scope: Usage['scope'], scopeId: string, sessionId: string, delta: Partial<Usage>): void {
    this.budget.record(scope, scopeId, sessionId, delta)
  }

  /** Flush accumulated usage. Called once per pass. */
  flushUsage(): number {
    return this.budget.flush()
  }

  /** Charge a coalition and report what its budget calls for. */
  chargeCoalition(coalitionId: string, tokens: number): BudgetAction {
    return this.store.atomic(() => {
      const coalition = this.coalitions.charge(coalitionId, tokens)
      const action = this.budget.check(coalition.budget)
      if (action === 'hard') {
        const summary = this.coalitions.merge(coalitionId)
        this.coalitions.dissolve(coalitionId, 'budget', true)
        this.effects.enqueue(EFFECT.notice, `coalition:${coalitionId}:budget`, {
          name: `coalition:${coalitionId}`,
          summary: `Coalition ${coalition.topic} hit its budget and dissolved`,
          value: { coalitionId, summary },
        })
      } else if (action === 'soft') {
        this.store.audit('program', 'budget.soft', { coalition: coalitionId, used: coalition.budget.used, of: coalition.budget.tokens })
      }
      return action
    })
  }

  /**
   * Re-check every budget. Called once per pass, so it stays allocation-light and only
   * writes when a threshold is actually crossed.
   */
  checkBudgets(): void {
    const coalitions = this.store.listCoalitions(true)
    for (const coalition of coalitions) {
      const used = this.budget.used('coalition', coalition.id)
      if (used === coalition.budget.used) continue
      this.chargeCoalition(coalition.id, used - coalition.budget.used)
    }
    for (const ticket of this.store.listTickets(true)) {
      const spec = ticket.spec.budget
      if (!spec) continue
      const used = this.budget.used('ticket', ticket.id)
      if (used / spec.tokens < 1) continue
      if (ticket.stage === 'person') continue
      this.store.atomic(() => {
        this.store.audit('program', 'budget.ticket-blocked', { ticket: ticket.id, used, of: spec.tokens })
        const parked = { ...ticket, stage: 'person' as const, updatedAt: now() }
        this.store.putTicket(parked)
        this.effects.enqueue(EFFECT.notice, `ticket:${ticket.id}:budget`, {
          name: `ticket:${ticket.id}`,
          summary: `Ticket ${ticket.id} exhausted its budget`,
          value: { ticketId: ticket.id, used, of: spec.tokens },
        })
      })
    }
  }

  /** Sweep: TTL, gates, expired evaluations. Called once per pass. */
  sweep(): { ttl: number; gates: number; evals: number } {
    return this.store.atomic(() => {
      const ttl = this.bus.sweepTtl()
      const gates = this.gates.sweep().length
      const expired = this.evals.expired()
      for (const item of expired) {
        if (item.requeued) {
          this.effects.enqueue(EFFECT.assess, `requeue:${item.threadKey}:${Date.now()}`, {
            threadKey: item.threadKey,
            evalId: newId('eval'),
          })
        }
      }
      for (const coalition of this.coalitions.expired()) {
        const summary = this.coalitions.merge(coalition.id)
        this.coalitions.dissolve(coalition.id, 'deadline', true)
        this.effects.enqueue(EFFECT.notice, `coalition:${coalition.id}:deadline`, {
          name: `coalition:${coalition.id}`,
          summary: `Coalition ${coalition.topic} reached its deadline`,
          value: { coalitionId: coalition.id, summary },
        })
      }
      return { ttl, gates, evals: expired.length }
    })
  }

  // ── workers ──────────────────────────────────────────────────────────────

  /** Register a worker with its static offers. */
  registerWorker(worker: Worker): Worker {
    return this.store.atomic(() => {
      this.directory.register(worker)
      this.store.audit('program', 'worker.register', {
        worker: worker.id, kind: worker.kind, resident: worker.resident,
      })
      return this.store.getWorker(worker.id) ?? worker
    })
  }

  /** Update a worker's status. */
  setWorkerStatus(workerId: string, status: Worker['status'], ticketId?: string): void {
    this.store.atomic(() => {
      const worker = this.store.getWorker(workerId)
      if (!worker) return
      const next: Worker = {
        ...worker,
        status,
        lastSeenAt: now(),
        ...(ticketId === undefined ? {} : { ticketId }),
      }
      this.store.putWorker(next)
    })
  }

  /** Unregister a worker (a temporary one whose ticket ended). */
  unregisterWorker(workerId: string): void {
    this.store.atomic(() => {
      this.store.deleteWorker(workerId)
      this.store.audit('program', 'worker.unregister', { worker: workerId })
    })
  }

  /**
   * Pick a worker for a kind: an idle one first, then any live one.
   *
   * `temp` is a per-ticket worker with no standing record, so it is created on demand
   * rather than looked up. Without this a Router that picks `temp` for a one-off task
   * would get a ticket that can never be assigned.
   */
  pickWorker(kind: WorkerKind, ticketId?: string): Worker | undefined {
    if (kind === 'temp') {
      if (ticketId === undefined) return undefined
      return this.createTempWorker(ticketId, 'temp', `mesh-temp-${ticketId}`)
    }
    const candidates = this.store.listWorkers().filter(w => w.kind === kind && w.status !== 'stopped')
    return candidates.find(w => w.status === 'idle') ?? candidates[0]
  }

  /** Create a temporary worker record for a per-ticket session. */
  createTempWorker(ticketId: string, kind: WorkerKind, sessionId: string): Worker {
    const worker: Worker = {
      id: `mesh-temp-${ticketId}`,
      kind,
      sessionId,
      status: 'starting',
      offers: { keywords: this.directory.offersFor(kind) },
      resident: false,
      ticketId,
      registeredAt: now(),
    }
    return this.registerWorker(worker)
  }

  // ── reads ────────────────────────────────────────────────────────────────

  /** All audit rows, newest first. */
  audit(limit = 100): AuditEntry[] {
    return this.store.listAudit(limit)
  }

  /** Whether an optional subsystem has enough evidence to be worth building on. */
  evidence(kind: string, threshold: number): { count: number; ready: boolean } {
    const count = this.store.countAudit(kind)
    return { count, ready: count >= threshold }
  }

  /** Snapshot for the status API and the Router's `mesh_read`. */
  state(): {
    tickets: { open: number; active: number }
    workers: number
    coalitions: number
    gates: number
    effects: number
    usagePending: number
  } {
    return {
      tickets: {
        open: this.store.listTickets(true).length,
        active: this.store.listTickets(true).filter(t => t.stage === 'working').length,
      },
      workers: this.store.listWorkers().length,
      coalitions: this.store.listCoalitions(true).length,
      gates: this.store.listGates(true).length,
      effects: this.store.countEffects(),
      usagePending: this.budget.pendingCount,
    }
  }

  /** Next coalition step for the moderator. */
  coalitionStep(coalitionId: string): CoalitionStep {
    return this.coalitions.nextStep(coalitionId)
  }

  /** Topic key helper for subscriptions. */
  static topicKey(topic: string): string {
    return topicKey(topic)
  }
}

/** Re-exported so callers do not reach into `gates` for a constant. */
export { MAX_GATE_DEPTH, Later, GateRefused }
export type { ReportState }
