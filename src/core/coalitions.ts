/**
 * Coalitions: a temporary group for one question.
 *
 * The mechanism that keeps a group cheap is that the moderator is a program with
 * nothing to decide. It executes a script and merges fields. It never chooses who
 * speaks next.
 *
 * That only works if the script was written before the group existed, which is why
 * scripts are **optional**:
 *
 * - **Form A** — a non-empty script, valid when the shape was known up front (survey
 *   → options → adjudicate). Real but uncommon.
 * - **Form B** — an empty script, the default. Every member answers the same question
 *   once and the moderator merges the fields. There is no rotation, so there is no
 *   "who speaks next" to decide.
 *
 * Form B is the honest answer to "we cannot predict the shape": do not pretend to.
 * A predicted script that turns out wrong costs more than no script.
 */

import {
  type Coalition, type CoalitionState, type Mandate, type RoundScriptStep,
  type StructuredAnswer, newId, now,
} from './model.ts'
import type { Store } from './store.ts'

/** Default budget for an explicit coalition. Inferred ones are halved. */
export const DEFAULT_COALITION_TOKENS = 200_000
/** Default lifetime. */
export const DEFAULT_COALITION_MINUTES = 30

/** Why a coalition was created. */
export interface ProposeCoalitionRequest {
  topic: string
  memberIds: string[]
  leadId: string
  mandate: Mandate
  question: string
  script?: RoundScriptStep[]
  ticketId?: string
  budgetTokens?: number
  deadlineMinutes?: number
}

/**
 * Coalitions: propose, approve, step, merge, dissolve.
 */
export class Coalitions {
  constructor(private readonly store: Store) {}

  /**
   * Propose a group.
   *
   * An `inferred` group gets half the budget and half the lifetime of an explicit one,
   * and starts `approved` when non-blocking notification is configured — the default,
   * because a person can always stop it.
   */
  propose(request: ProposeCoalitionRequest, options: { inferredBlocking: boolean }): Coalition {
    const inferred = request.mandate === 'inferred'
    const baseTokens = request.budgetTokens ?? DEFAULT_COALITION_TOKENS
    const baseMinutes = request.deadlineMinutes ?? DEFAULT_COALITION_MINUTES
    const timestamp = now()
    const coalition: Coalition = {
      id: newId('coal'),
      topic: request.topic,
      ...(request.ticketId === undefined ? {} : { ticketId: request.ticketId }),
      memberIds: request.memberIds,
      leadId: request.leadId,
      mandate: request.mandate,
      budget: {
        tokens: inferred ? Math.floor(baseTokens / 2) : baseTokens,
        used: 0,
      },
      deadline: new Date(Date.now() + (inferred ? baseMinutes / 2 : baseMinutes) * 60_000).toISOString(),
      // Explicit work was asked for by a person, so it starts approved. An inferred
      // group also starts approved unless blocking confirmation is configured.
      state: inferred && options.inferredBlocking ? 'proposed' : 'approved',
      script: request.script ?? [],
      round: 0,
      question: request.question,
      outputs: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    }
    this.store.putCoalition(coalition)
    this.store.audit('router', 'coalition.propose', {
      coalition: coalition.id, mandate: coalition.mandate, members: coalition.memberIds.length,
      scriptSteps: coalition.script.length, budget: coalition.budget.tokens,
    })
    return coalition
  }

  /** Approve a proposed group so it may start. */
  approve(coalitionId: string, by: 'human' | 'router'): Coalition {
    const coalition = this.require(coalitionId)
    if (coalition.state !== 'proposed') return coalition
    coalition.state = 'approved'
    coalition.updatedAt = now()
    this.store.putCoalition(coalition)
    this.store.audit(by === 'human' ? 'human' : 'router', 'coalition.approve', { coalition: coalitionId })
    return coalition
  }

  /**
   * The next thing the moderator should do.
   *
   * Form A returns the next script step. Form B returns every member at once, once,
   * because there is no rotation to execute.
   */
  nextStep(coalitionId: string): CoalitionStep {
    const coalition = this.require(coalitionId)
    if (coalition.state !== 'approved' && coalition.state !== 'round') {
      return { kind: 'done', reason: `state ${coalition.state}` }
    }
    if (Date.parse(coalition.deadline) <= Date.now()) {
      return { kind: 'done', reason: 'deadline' }
    }
    if (coalition.budget.used >= coalition.budget.tokens) {
      return { kind: 'done', reason: 'budget' }
    }

    if (coalition.script.length === 0) {
      // Form B: collect once from everyone still outstanding.
      const answered = new Set(coalition.outputs.map(o => o.speaker))
      const outstanding = coalition.memberIds.filter(id => !answered.has(id))
      if (outstanding.length === 0) return { kind: 'done', reason: 'all-answered' }
      return { kind: 'collect', speakers: outstanding, ask: coalition.question, schema: '' }
    }

    // Form A: one script step at a time.
    const step = coalition.script[coalition.round]
    if (!step) return { kind: 'done', reason: 'script-complete' }
    const speaker = this.pickSpeaker(coalition, step)
    if (!speaker) return { kind: 'done', reason: `no member for kind ${step.speakerKind}` }
    return { kind: 'ask', speakers: [speaker], ask: step.ask, schema: step.schema }
  }

  /** Record one member's structured answer and advance the round when the step is complete. */
  record(coalitionId: string, speaker: string, answer: StructuredAnswer): Coalition {
    const coalition = this.require(coalitionId)
    coalition.outputs.push({
      round: coalition.round,
      speaker,
      fields: answer.fields,
      at: now(),
    })
    if (coalition.state === 'approved') coalition.state = 'round'

    if (coalition.script.length === 0) {
      // Form B advances only when every member has answered.
      const answered = new Set(coalition.outputs.map(o => o.speaker))
      if (coalition.memberIds.every(id => answered.has(id))) {
        coalition.state = 'merging'
      }
    } else {
      // Form A advances one script step at a time.
      const step = coalition.script[coalition.round]
      const expected = step ? this.membersOfKind(coalition, step.speakerKind) : []
      const answered = new Set(coalition.outputs.filter(o => o.round === coalition.round).map(o => o.speaker))
      if (expected.every(id => answered.has(id))) {
        coalition.round += 1
        if (coalition.round >= coalition.script.length) coalition.state = 'merging'
      }
    }
    coalition.updatedAt = now()
    this.store.putCoalition(coalition)
    this.store.audit('worker', 'coalition.record', { coalition: coalitionId, speaker, round: coalition.round })
    return coalition
  }

  /** Charge usage against a coalition. */
  charge(coalitionId: string, tokens: number): Coalition {
    const coalition = this.require(coalitionId)
    coalition.budget.used += Math.max(0, Math.trunc(tokens))
    coalition.updatedAt = now()
    this.store.putCoalition(coalition)
    return coalition
  }

  /**
   * Merge the fields into one summary. This is a program, not an inference round: it
   * concatenates each speaker's fields under their name. Detail stays in each worker's
   * own spill; only this summary travels.
   */
  merge(coalitionId: string): string {
    const coalition = this.require(coalitionId)
    if (coalition.outputs.length === 0) return `[${coalition.topic}] no answers`
    const lines = coalition.outputs.map(output => {
      const fields = Object.entries(output.fields)
        .map(([key, value]) => `${key}: ${render(value)}`)
        .join('; ')
      return `- ${output.speaker} (round ${output.round}): ${fields || '(empty)'}`
    })
    return `[${coalition.topic}] ${coalition.question}\n${lines.join('\n')}`
  }

  /** Dissolve a group. `archived` records that a summary was produced. */
  dissolve(coalitionId: string, reason: string, summarized = true): Coalition {
    const coalition = this.require(coalitionId)
    coalition.state = summarized ? 'archived' : 'dissolved'
    coalition.updatedAt = now()
    this.store.putCoalition(coalition)
    this.store.audit('program', 'coalition.dissolve', { coalition: coalitionId, reason, summarized })
    return coalition
  }

  /** Groups past their deadline. */
  expired(): Coalition[] {
    const nowMs = Date.now()
    return this.store.listCoalitions(true).filter(c => Date.parse(c.deadline) <= nowMs)
  }

  require(coalitionId: string): Coalition {
    const coalition = this.store.getCoalition(coalitionId)
    if (!coalition) throw new Error(`mesh: unknown coalition ${coalitionId}`)
    return coalition
  }

  private pickSpeaker(coalition: Coalition, step: RoundScriptStep): string | undefined {
    const answered = new Set(coalition.outputs.filter(o => o.round === coalition.round).map(o => o.speaker))
    return this.membersOfKind(coalition, step.speakerKind).find(id => !answered.has(id))
  }

  private membersOfKind(coalition: Coalition, kind: string): string[] {
    return coalition.memberIds.filter(id => this.store.getWorker(id)?.kind === kind)
  }
}

/** What the moderator should do next. */
export type CoalitionStep =
  | { kind: 'ask'; speakers: string[]; ask: string; schema: string }
  | { kind: 'collect'; speakers: string[]; ask: string; schema: string }
  | { kind: 'done'; reason: string }

/** Render one field value for the merged summary. */
function render(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(render).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** Whether a state means the group is still open. */
export function isOpen(state: CoalitionState): boolean {
  return state !== 'dissolved' && state !== 'archived'
}
