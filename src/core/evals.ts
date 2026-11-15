/**
 * The slow channel: deciding what a queued message is for.
 *
 * A message nobody subscribed to needs a judgement: is this work, and for whom? That
 * is the one place the Router earns its keep. The design goal is to reach it as rarely
 * as possible — the fast path in `intake` handles everything already attributed.
 *
 * Two details that are easy to get wrong:
 *
 * - **The deadline starts when the candidate is delivered**, not when it is created.
 *   Otherwise a Router turn queued behind other work looks like a timeout.
 * - **A requeue is bounded.** After `REQUEUES` attempts the thread is marked
 *   unavailable rather than retried forever.
 */

import { type Thread, newId, now } from './model.ts'
import type { Store } from './store.ts'

/** How many times a candidate may be requeued before it is abandoned. */
export const REQUEUES = 2

/** Strength ordering: a person outranks a worker's explicit ask, which outranks an inference. */
export const STRENGTH = {
  human: 3,
  workerExplicit: 2,
  inferred: 1,
} as const

/** A pending candidate for the Router. */
export interface Candidate {
  threadKey: string
  evalId: string
  triggerIds: string[]
  primary: string
  strength: number
  text: string
}

/** What starting an evaluation produced. */
export interface EvalStart {
  threadKey: string
  evalId: string
  candidate: Candidate
}

/**
 * Evals: pick the strongest pending message per thread and hand it to the Router.
 */
export class Evals {
  constructor(
    private readonly store: Store,
    private readonly timeoutMs: number,
  ) {}

  /**
   * Start an evaluation on a thread that has pending work and none in flight.
   *
   * @returns the candidate to deliver, or `undefined` when there is nothing to do.
   */
  start(threadKey: string): EvalStart | undefined {
    const thread = this.store.getThread(threadKey)
    if (!thread) return undefined
    if (thread.evaluating) return undefined
    if (thread.pending.length === 0) return undefined

    const triggerIds = [...thread.pending]
    const primary = triggerIds[0] ?? ''
    const strength = STRENGTH.inferred
    const evalId = newId('eval')
    thread.evaluating = {
      id: evalId,
      triggerIds,
      primary,
      strength,
      startedAt: now(),
      // Provisional: replaced when the candidate is actually delivered.
      deadline: new Date(Date.now() + this.timeoutMs).toISOString(),
      requeues: 0,
    }
    thread.pending = []
    this.store.putThread(thread)
    this.store.audit('program', 'eval.start', { thread: threadKey, eval: evalId, count: triggerIds.length })
    return {
      threadKey,
      evalId,
      candidate: { threadKey, evalId, triggerIds, primary, strength, text: '' },
    }
  }

  /**
   * Mark a candidate as delivered, starting its deadline clock.
   *
   * Called when the assessment card actually reaches the Router Session, which is why
   * the deadline is set here and not in `start`.
   */
  delivered(threadKey: string): void {
    const thread = this.store.getThread(threadKey)
    if (!thread?.evaluating) return
    thread.evaluating.deadline = new Date(Date.now() + this.timeoutMs).toISOString()
    this.store.putThread(thread)
  }

  /** Clear an evaluation after a decision. */
  finish(threadKey: string): void {
    const thread = this.store.getThread(threadKey)
    if (!thread) return
    thread.evaluating = undefined
    this.store.putThread(thread)
  }

  /**
   * Find evaluations past their deadline.
   *
   * Each one is requeued at most `REQUEUES` times, then the thread is left
   * unavailable: the pending items stay stored so a person can still see them, but the
   * Router is not asked again.
   */
  expired(): { threadKey: string; requeued: boolean }[] {
    const out: { threadKey: string; requeued: boolean }[] = []
    const nowMs = Date.now()
    for (const thread of this.store.listThreads()) {
      const evaluating = thread.evaluating
      if (!evaluating) continue
      if (Date.parse(evaluating.deadline) > nowMs) continue
      const requeues = evaluating.requeues + 1
      if (requeues > REQUEUES) {
        // Give up on routing this thread, but keep the messages.
        thread.evaluating = undefined
        this.store.putThread(thread)
        this.store.audit('program', 'eval.unavailable', { thread: thread.key, requeues })
        out.push({ threadKey: thread.key, requeued: false })
        continue
      }
      // Put the work back and let a fresh evaluation start.
      thread.pending = [...evaluating.triggerIds, ...thread.pending]
      thread.evaluating = undefined
      this.store.putThread(thread)
      this.store.audit('program', 'eval.requeue', { thread: thread.key, attempt: requeues })
      out.push({ threadKey: thread.key, requeued: true })
    }
    return out
  }

  /** Threads that have pending work and no evaluation in flight. */
  ready(): Thread[] {
    return this.store.listThreads().filter(t => t.pending.length > 0 && !t.evaluating)
  }
}
