/**
 * The message bus.
 *
 * Messages are rows, not calls. That is the point: a message is written in the same
 * transaction as the state change that motivated it, so a crash cannot produce "the
 * ticket advanced but nobody was told". Delivery happens afterwards, as an effect.
 *
 * TTL is counted in *consumptions* of the topic, not wall time. A publish with
 * `ttl: 3` stays deliverable until three messages on that topic have been consumed,
 * which is a much better proxy for relevance than a clock.
 */

import {
  type Message, type MessageState, type MessageType, type Worker,
  newId, now,
} from './model.ts'
import type { Store } from './store.ts'

/** What sending needs. */
export interface SendRequest {
  from: string
  to?: string
  topic?: string
  thread?: string
  type: MessageType
  body?: string
  summary?: string
  ttl?: number
  refs?: string[]
  needs?: { text: string; urgency: 'advisory' | 'blocking' }
  gate?: { gateId: string; blocking: boolean }
}

/** Default TTL for a publish, in topic consumptions. */
export const DEFAULT_PUBLISH_TTL = 3
/** Bodies longer than this are truncated and referenced. */
export const MAX_BODY_CHARS = 1500
/** Summaries longer than this are truncated. */
export const MAX_SUMMARY_CHARS = 300

/**
 * Bus: matching, delivery bookkeeping, TTL, and subscription.
 *
 * It never calls a Session. The Engine turns `pendingDeliveries()` into effects.
 */
export class Bus {
  constructor(private readonly store: Store) {}

  /** Write one message. Returns the stored row. */
  send(request: SendRequest): Message {
    const body = truncate(request.body ?? '', MAX_BODY_CHARS)
    const message: Message = {
      id: newId('msg'),
      seq: this.store.nextMessageSeq(),
      from: request.from,
      ...(request.to === undefined ? {} : { to: request.to }),
      ...(request.topic === undefined ? {} : { topic: request.topic }),
      ...(request.thread === undefined ? {} : { thread: request.thread }),
      type: request.type,
      body,
      ...(request.summary === undefined ? {} : { summary: truncate(request.summary, MAX_SUMMARY_CHARS) }),
      ...(request.ttl === undefined ? {} : { ttl: request.ttl }),
      refs: request.refs ?? [],
      ...(request.needs === undefined ? {} : { needs: request.needs }),
      ...(request.gate === undefined ? {} : { gate: request.gate }),
      state: 'pending',
      at: now(),
    }
    this.store.putMessage(message)
    this.store.audit('worker', 'message.send', {
      id: message.id, type: message.type, from: message.from,
      to: message.to ?? null, topic: message.topic ?? null,
    })
    return message
  }

  /**
   * Resolve who a message should reach.
   *
   * A `tell`/`ask` with an explicit `to` reaches exactly that worker. A `publish`
   * reaches every worker subscribed to its topic. Nothing reaches the sender.
   */
  recipients(message: Message): Worker[] {
    const workers = this.store.listWorkers()
    if (message.to !== undefined) {
      const direct = workers.find(w => w.id === message.to)
      return direct ? [direct] : []
    }
    if (message.topic !== undefined) {
      const topic = this.store.getThread(topicKey(message.topic))
      const subscribed = new Set(topic?.subscribers ?? [])
      return workers.filter(w => subscribed.has(w.id) && w.id !== message.from)
    }
    return []
  }

  /** Pending messages that have a resolvable recipient. */
  pendingDeliveries(): { message: Message; to: string }[] {
    const out: { message: Message; to: string }[] = []
    for (const message of this.store.listMessages({ state: 'pending' })) {
      for (const worker of this.recipients(message)) {
        if (worker.id === message.from) continue
        out.push({ message, to: worker.id })
      }
    }
    return out
  }

  /** Mark a message delivered to one recipient. */
  markDelivered(messageId: string, _to: string): void {
    this.consume(messageId, 'delivered')
  }

  /** Archive a message. The body stays queryable; it is simply not delivered again. */
  archive(messageId: string): void {
    this.consume(messageId, 'archived')
  }

  /** Drop a message without delivering it. */
  drop(messageId: string): void {
    this.consume(messageId, 'dropped')
  }

  /** Consume one unit of a topic's TTL, expiring whatever has run out. */
  consumeTopic(topic: string): void {
    const key = topicKey(topic)
    // One consumption per call. The counter lives in kv so it survives a restart, which
    // matters because a TTL measured in consumptions must not reset when the process does.
    const count = this.bumpTopicCounter(key, 1)
    for (const message of this.store.listMessages({ state: 'pending', type: 'publish' })) {
      if (message.topic !== topic) continue
      const ttl = message.ttl ?? DEFAULT_PUBLISH_TTL
      if (count >= ttl) this.archive(message.id)
    }
  }

  /** Archive every publish whose TTL has run out. Called by the sweep. */
  sweepTtl(): number {
    let archived = 0
    for (const message of this.store.listMessages({ state: 'pending', type: 'publish' })) {
      const ttl = message.ttl ?? DEFAULT_PUBLISH_TTL
      const consumed = this.topicCounter(topicKey(message.topic ?? ''))
      if (consumed >= ttl) {
        this.archive(message.id)
        archived += 1
      }
    }
    return archived
  }

  /** Messages addressed to one worker and still pending. */
  inbox(workerId: string): Message[] {
    return this.store.listMessages({ state: 'pending' })
      .filter(m => m.to === workerId || (m.topic !== undefined && this.isSubscribed(workerId, m.topic)))
      .filter(m => m.from !== workerId)
  }

  private isSubscribed(workerId: string, topic: string): boolean {
    const thread = this.store.getThread(topicKey(topic))
    return thread?.subscribers.includes(workerId) ?? false
  }

  private consume(messageId: string, state: MessageState): void {
    const message = this.store.getMessage(messageId)
    if (!message || message.state !== 'pending') return
    message.state = state
    this.store.putMessage(message)
  }

  private bumpTopicCounter(key: string, delta: number): number {
    const current = this.topicCounter(key)
    const next = current + delta
    this.store.kvSet(`topic.count.${key}`, String(next))
    return next
  }

  private topicCounter(key: string): number {
    return Number(this.store.kvGet(`topic.count.${key}`) ?? 0)
  }
}

/** The thread key a topic maps to. */
export function topicKey(topic: string): string {
  return `topic:${topic}`
}

/** Truncate with an explicit marker so a reader knows text was cut. */
function truncate(value: string, max: number): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}…`
}
