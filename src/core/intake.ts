/**
 * Intake: classify everything that arrives.
 *
 * One transaction, five steps, in this order:
 *
 * 1. **Deduplicate** — the same trigger twice is a no-op.
 * 2. **Attribute to a thread** — a message with no thread and no subscriber is
 *    stored but filtered.
 * 3. **Fan out to subscribers** — every subscribed ticket gets the message, and only
 *    a *person's* message may revive an ended ticket.
 * 4. **Deliver directly when possible** — the fast path. A message on a thread with a
 *    live subscribed ticket goes straight to that worker with zero inference.
 * 5. **Queue the rest** — anything unclaimed waits for the Router.
 *
 * Step 4 is why the Router is not on the hot path. Without it every message would pay
 * for a routing decision.
 */

import { type Ticket, newId, now } from './model.ts'
import type { Store } from './store.ts'
import type { Tickets } from './tickets.ts'

/** Anything that can arrive. */
export interface Incoming {
  /** Stable identity for deduplication. */
  id: string
  /** The text a worker or the Router will see. */
  text: string
  /** Thread this belongs to, when known. */
  thread?: string
  /** Whether a person produced this. Only people revive tickets. */
  human: boolean
  /** Who sent it: `human`, a worker id, or `system`. */
  from: string
  at?: string
}

/** What intake decided. */
export type Disposition = 'stored' | 'duplicate' | 'filtered' | 'delivered'

/** Result of one intake, enough for the caller to act. */
export interface IntakeResult {
  disposition: Disposition
  /** Tickets that received this message, in fan-out order. */
  ticketIds: string[]
  /** Tickets whose input can go out immediately (fast path). */
  directDeliveries: { ticketId: string; inputId: string }[]
  /** Thread key this was attributed to. */
  thread?: string
}

/**
 * Intake: the inbound classifier.
 *
 * It mutates thread and ticket aggregates through the store and the tickets module;
 * it never enqueues effects itself. The Engine does that, inside the same transaction.
 */
export class Intake {
  constructor(
    private readonly store: Store,
    private readonly tickets: Tickets,
  ) {}

  /**
   * Classify one inbound item.
   *
   * Must run inside an Engine command's transaction.
   */
  receive(input: Incoming): IntakeResult {
    const at = input.at ?? now()
    const threadKey = input.thread ?? `thread:${hash(input.id)}`

    // ── 1. Deduplicate ──────────────────────────────────────────────────────
    const thread = this.store.getThread(threadKey)
    if (thread && thread.pending.includes(input.id)) {
      return { disposition: 'duplicate', ticketIds: [], directDeliveries: [], thread: threadKey }
    }

    // ── 2. Attribute ────────────────────────────────────────────────────────
    const current = thread ?? {
      key: threadKey,
      topic: '',
      pending: [] as string[],
      subscribers: [] as string[],
      correlated: [] as string[],
      lastAt: at,
    }

    // ── 3. Fan out to subscribers ───────────────────────────────────────────
    const ticketIds: string[] = []
    const directDeliveries: { ticketId: string; inputId: string }[] = []
    for (const ticketId of current.subscribers) {
      const ticket = this.store.getTicket(ticketId)
      if (!ticket) continue
      const live = this.acceptForTicket(ticket, input, at)
      if (!live) continue
      ticketIds.push(ticketId)
      if (live.direct) directDeliveries.push({ ticketId, inputId: live.inputId })
    }

    // ── 4/5. Direct or queue ────────────────────────────────────────────────
    // A message that reached at least one live subscribed ticket was delivered
    // directly. Anything else waits for the Router, which is the slow path.
    const claimed = directDeliveries.length > 0
    if (!claimed) {
      current.pending.push(input.id)
    }
    current.lastAt = at
    current.correlated = unique([...current.correlated, input.id]).slice(-50)
    this.store.putThread(current)

    if (!claimed && current.subscribers.length === 0 && !input.thread) {
      // Nothing owns this thread and nobody subscribed: store it so it is not lost,
      // but do not spend a routing decision on it.
      return { disposition: 'filtered', ticketIds, directDeliveries, thread: threadKey }
    }
    return {
      disposition: directDeliveries.length > 0 ? 'delivered' : 'stored',
      ticketIds,
      directDeliveries,
      thread: threadKey,
    }
  }

  /**
   * Attach an inbound item to one ticket, reviving it first when a person speaks.
   * @returns the new input id and whether it can go out on the fast path, or
   *   `undefined` when the ticket must not receive it.
   */
  private acceptForTicket(
    ticket: Ticket,
    input: Incoming,
    at: string,
  ): { inputId: string; direct: boolean } | undefined {
    if (ticket.ended) {
      // Only a person revives, and never a stopped ticket.
      if (!input.human) return undefined
      if (ticket.ended.outcome === 'stopped') return undefined
      this.tickets.revive(ticket.id)
    }
    const live = this.store.getTicket(ticket.id)
    if (!live) return undefined
    const { inputId } = this.tickets.addInput(ticket.id, {
      kind: input.human ? 'human' : 'worker',
      text: input.text,
      delivered: false,
    })
    // The fast path: a subscribed ticket on this thread takes the message with no
    // inference at all. Delivery itself is an effect, enqueued by the Engine.
    this.store.audit('program', 'intake.fanout', {
      ticket: ticket.id, from: input.from, human: input.human, at,
    })
    return { inputId, direct: true }
  }

  /** Subscribe a ticket to a thread so future messages reach it directly. */
  subscribe(ticketId: string, threadKey: string, topic = ''): void {
    this.tickets.assertOpen(ticketId)
    const thread = this.store.getThread(threadKey) ?? {
      key: threadKey,
      topic,
      pending: [],
      subscribers: [],
      correlated: [],
      lastAt: now(),
    }
    if (!thread.subscribers.includes(ticketId)) thread.subscribers.push(ticketId)
    this.store.putThread(thread)
  }

  /**
   * Subscribe a ticket to a thread *and* wait for that thread to close before ending.
   *
   * Subscription and following are deliberately separate. A ticket that owns the thread
   * it was created from subscribes to it but must not follow it: waiting for a thread
   * you own to close would mean never finishing.
   */
  subscribeAndFollow(ticketId: string, threadKey: string, topic = ''): void {
    this.subscribe(ticketId, threadKey, topic)
    this.tickets.follow(ticketId, threadKey)
  }

  /** Remove a ticket's subscription. Already-delivered messages are unaffected. */
  unsubscribe(ticketId: string, threadKey: string): void {
    const thread = this.store.getThread(threadKey)
    if (thread) {
      thread.subscribers = thread.subscribers.filter(id => id !== ticketId)
      this.store.putThread(thread)
    }
    const ticket = this.store.getTicket(ticketId)
    if (ticket && !ticket.ended) this.tickets.unfollow(ticketId, threadKey)
  }

  /** Take the pending queue off a thread and clear it. Used when the Router evaluates. */
  drainPending(threadKey: string): string[] {
    const thread = this.store.getThread(threadKey)
    if (!thread) return []
    const pending = [...thread.pending]
    thread.pending = []
    this.store.putThread(thread)
    return pending
  }

  /** Put items back at the front of a thread's pending queue. */
  requeue(threadKey: string, ids: string[]): void {
    const thread = this.store.getThread(threadKey)
    if (!thread) return
    thread.pending = unique([...ids, ...thread.pending])
    this.store.putThread(thread)
  }

  /** Mark a thread's evaluation finished. */
  finishEvaluation(threadKey: string): void {
    const thread = this.store.getThread(threadKey)
    if (!thread) return
    thread.evaluating = undefined
    this.store.putThread(thread)
  }
}

/** Deterministic short hash, so an id without a thread still gets a stable thread. */
function hash(value: string): string {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(36)
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

/** Generate an intake id. */
export function intakeId(): string {
  return newId('in')
}
