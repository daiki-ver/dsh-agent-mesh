/**
 * The worker executor: launches Sessions and delivers work.
 *
 * Slots are split into two pools on purpose. A resident worker holds a *reserved*
 * slot for its lifetime and does not compete with tickets; a temporary worker holds a
 * *temp* slot, which is what a ticket queues on. Sharing one pool would mean each
 * resident worker shrinks the number of tickets that can run, which is the opposite of
 * why residents exist.
 *
 * Failure handling distinguishes three cases, because they need different responses:
 *
 * - **No slot free** → `Later`. Not a failure; retry on the next pass.
 * - **Transient delivery error** → back off and retry, counted per assignment.
 * - **Session gone** → recreate it. The ticket survives; only its Session was lost.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Later } from '../core/effects.ts'
import { type Assignment, type Ticket, type Worker, type WorkerKind } from '../core/model.ts'
import { residentSessionId, tempSessionId, type HostServices } from '../app/host.ts'
import type { SessionManager } from '../app/sessions.ts'

/** Attempts before a delivery is treated as failed rather than transient. */
export const TRANSIENT_TRIES = 3
/** Backoff between transient retries. */
export const TRANSIENT_BACKOFF_MS = 15_000
/** Background work left running after a turn is killed after this long. */
export const BACKGROUND_LIMIT_MS = 30 * 60_000

/** Slot accounting. */
export interface SlotConfig {
  residentWorkers: number
  tempSlots: number
}

/**
 * WorkerExecutor: the launch and delivery mechanics.
 *
 * It never decides *what* to do; the Engine does. This class only answers "can this
 * run now" and "how does it reach the Session".
 */
export class WorkerExecutor {
  private readonly residentBusy = new Set<string>()
  private readonly tempBusy = new Set<string>()
  private readonly transient = new Map<string, number>()

  constructor(
    private readonly ctx: Context,
    private readonly sessions: SessionManager,
    private readonly host: HostServices,
    private readonly slots: SlotConfig,
    private readonly cwd: string,
  ) {}

  /** Free resident slots. */
  get residentFree(): number {
    return Math.max(0, this.slots.residentWorkers - this.residentBusy.size)
  }

  /** Free temp slots. */
  get tempFree(): number {
    return Math.max(0, this.slots.tempSlots - this.tempBusy.size)
  }

  /**
   * Launch a worker for one assignment.
   *
   * A resident worker reuses its standing Session, so its context is a warm cache. A
   * temporary worker gets a per-ticket Session, which is discarded with the ticket.
   *
   * @throws {Later} when no slot is free.
   */
  async launch(ticket: Ticket, assignment: Assignment, worker: Worker, firstMessage: string): Promise<void> {
    const resident = worker.resident
    if (resident) {
      if (this.residentFree <= 0 && !this.residentBusy.has(worker.id)) throw new Later('no resident slot')
      this.residentBusy.add(worker.id)
    } else {
      if (this.tempFree <= 0) throw new Later('no temp slot')
      this.tempBusy.add(worker.id)
    }

    try {
      const sessionId = resident
        ? residentSessionId(worker.kind, 1)
        : tempSessionId(ticket.id)
      const session = await this.sessions.ensure(
        sessionId,
        this.cwd,
        resident ? `Mesh ${worker.kind}` : `Mesh ${ticket.title.slice(0, 40)}`,
        'worker',
      )
      this.sessions.applyPermission(session, worker.kind)
      await this.sessions.prompt(
        sessionId,
        `assignment:${assignment.id}`,
        firstMessage,
        'steer',
      )
      this.transient.delete(assignment.id)
    } catch (error) {
      this.countTransient(assignment.id)
      throw error
    } finally {
      if (resident) this.residentBusy.delete(worker.id)
      else this.tempBusy.delete(worker.id)
    }
  }

  /**
   * Deliver one queued input to a worker.
   *
   * Delivery is idempotent per request id, so a retried effect is harmless.
   */
  async deliver(ticket: Ticket, worker: Worker, inputId: string, text: string): Promise<void> {
    const assignment = ticket.assignments.at(-1)
    if (!assignment) throw new Later('ticket has no assignment')
    // The Session id comes from the worker record: a resident worker keeps a standing
    // Session across tickets, a temporary one is bound to this ticket.
    const session = this.sessions.get(worker.sessionId)
    if (!session) {
      // The Session was deleted outside Mesh. Recreating it is the recovery path, and
      // the ticket is untouched.
      throw new Later(`worker session ${worker.sessionId} not live; will relaunch`)
    }
    await this.sessions.prompt(worker.sessionId, `assignment:${assignment.id}:${inputId}`, text, 'steer')
  }

  /** Send a message to a worker by session id, used for bus deliveries. */
  async deliverTo(sessionId: string, requestId: string, text: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) throw new Later(`session ${sessionId} not live`)
    await this.sessions.prompt(sessionId, requestId, text, 'steer')
  }

  /** Note a transient failure for one assignment. */
  countTransient(assignmentId: string): number {
    const next = (this.transient.get(assignmentId) ?? 0) + 1
    this.transient.set(assignmentId, next)
    return next
  }

  /** Whether an assignment has exhausted its transient retries. */
  exhausted(assignmentId: string): boolean {
    return (this.transient.get(assignmentId) ?? 0) >= TRANSIENT_TRIES
  }

  /** Clear transient state once an assignment succeeds. */
  clear(assignmentId: string): void {
    this.transient.delete(assignmentId)
  }

  /** Snapshot for the status API. */
  health(): { residentFree: number; tempFree: number; transient: number } {
    return {
      residentFree: this.residentFree,
      tempFree: this.tempFree,
      transient: this.transient.size,
    }
  }
}

/**
 * Format the first message a worker receives for a ticket.
 *
 * This message carries the whole reporting contract, not a pointer to it. A worker told
 * only "report when done" will often answer in its closing message and stop, and that
 * message never leaves its own Session — the ticket then sits in `working` forever. The
 * instruction has to be explicit about where the deliverable goes.
 */
export function assignmentMessage(ticket: Ticket, kind: WorkerKind, reorientation: string): string {
  const spec = ticket.spec
  const lines = [
    `# Ticket ${ticket.id}: ${spec.title}`,
    '',
    `Goal: ${spec.goal}`,
  ]
  if (spec.boundaries.length > 0) {
    lines.push('', 'Boundaries:', ...spec.boundaries.map(b => `- ${b}`))
  }
  if (spec.acceptance.length > 0) {
    lines.push('', 'Acceptance:', ...spec.acceptance.map(a => `- ${a}`))
  }
  if (spec.gates.length > 0) {
    lines.push('', 'Mandatory gates (you may not remove these):')
    for (const gate of spec.gates) {
      lines.push(`- ${gate.id} (holder: ${gate.holderKind}): ${gate.question}`)
    }
  }
  if (spec.routingNote) lines.push('', `Routing note: ${spec.routingNote}`)
  lines.push(
    '',
    `You are a ${kind} worker.`,
    '',
    '## How to finish — read this before you answer',
    'Your closing message stays inside this Session and nobody outside sees it. The Router',
    'only sees what `mesh_report` sends. So:',
    '',
    `1. Do the work.`,
    `2. Call \`mesh_report\` with \`ticketId: "${ticket.id}"\`, \`state: "ready"\`, and put the`,
    '   complete deliverable in `result` — the actual answer, not a summary of it.',
    '3. Only then write your closing message.',
    '',
    'If you skip step 2, this ticket never completes and a person sees nothing.',
  )
  if (reorientation) lines.push('', reorientation)
  return lines.join('\n')
}

/**
 * Build the per-ticket reorientation note.
 *
 * This is an append, so the prompt prefix stays intact and cache hits survive. It
 * costs a few dozen tokens per ticket and clears stale beliefs from a resident
 * worker's long-lived context.
 */
export function reorientationNote(previousTitle: string | undefined): string {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [`Reorientation: today is ${today}.`]
  if (previousTitle) {
    lines.push(`Your previous ticket was "${previousTitle}". Do not assume its state still holds.`)
  } else {
    lines.push('This is your first ticket.')
  }
  return lines.join(' ')
}
