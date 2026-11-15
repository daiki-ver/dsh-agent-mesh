/**
 * The persistent side-effect queue.
 *
 * A command writes its state change and its side-effect intent in the same
 * transaction. After commit the intent sits in the `effect` table until a handler
 * succeeds, so a crash between "decided to do X" and "did X" leaves X pending
 * rather than lost.
 *
 * Two failure modes are distinguished on purpose:
 *
 * - **`Later`** — the effect cannot run *yet* (no free slot, target session busy).
 *   It is rescheduled without counting as a failure, because retrying later is the
 *   expected outcome, not an error.
 * - **a thrown error** — a real failure. `attempts` grows, backoff grows, and after
 *   `FAILURES_BEFORE_ERROR` the row is flagged so health can report it.
 */

import type { EffectRow, Store } from './store.ts'

/** Thrown by a handler that cannot run now but should be retried without penalty. */
export class Later extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'Later'
  }
}

/** Backoff for a genuine failure: 5s doubling, capped at 5 minutes. */
export const RETRY_MIN_MS = 5_000
export const RETRY_MAX_MS = 300_000
/** Attempts before a row is flagged as errored rather than merely retrying. */
export const FAILURES_BEFORE_ERROR = 3
/** Attempts before a row is abandoned entirely. */
export const FAILURES_BEFORE_ABANDON = 20

/** One handler per effect kind. */
export type EffectHandler = (value: unknown, key: string) => Promise<void> | void

/** Per-kind behaviour. */
export interface EffectKindSpec {
  /** Concurrency limit for this kind. */
  limit: number
  /** Whether rows of this kind must run strictly in seq order. */
  ordered?: boolean
  /** A failure here should not raise health to error (routine, retryable). */
  quiet?: boolean
}

/** Health of one kind, as reported to the status API. */
export interface KindHealth {
  kind: string
  waiting: number
  running: number
  attempts: number
  errored: number
}

/**
 * Effects: dispatch loop over the persisted queue.
 *
 * Call `kick()` after committing a command (or on every pass) to make progress.
 * The loop is safe to call concurrently; extra calls coalesce.
 */
export class Effects {
  private readonly handlers = new Map<string, EffectHandler>()
  private readonly specs = new Map<string, EffectKindSpec>()
  private readonly running = new Map<string, Set<string>>()
  private pumping: Promise<void> | undefined
  private stopped = false

  constructor(private readonly store: Store) {}

  /** Register a handler and its limits. Registering the same kind twice replaces it. */
  handle(kind: string, spec: EffectKindSpec, handler: EffectHandler): void {
    this.specs.set(kind, spec)
    this.handlers.set(kind, handler)
    if (!this.running.has(kind)) this.running.set(kind, new Set())
  }

  /** Enqueue (or refresh) one intent. Must be called inside the command's transaction. */
  enqueue(kind: string, key: string, value: unknown, delayMs = 0): void {
    if (!this.handlers.has(kind)) throw new Error(`mesh: no handler registered for effect kind "${kind}"`)
    this.store.enqueueEffect(kind, key, value, Date.now() + Math.max(0, delayMs))
  }

  /** Run one dispatch round. Coalesces with an in-flight round. */
  async kick(): Promise<void> {
    if (this.stopped) return
    if (this.pumping) return this.pumping
    this.pumping = this.pumpOnce().finally(() => {
      this.pumping = undefined
    })
    return this.pumping
  }

  /** True while a round is in flight. */
  get busy(): boolean {
    return this.pumping !== undefined
  }

  /** Wait for the in-flight round, if any. */
  async idle(): Promise<void> {
    while (this.pumping) await this.pumping
  }

  /** Stop dispatching. In-flight rows stay for the next process to resume. */
  stop(): void {
    this.stopped = true
  }

  /** Health snapshot, one row per registered kind. */
  health(): KindHealth[] {
    const rows = this.store.dueEffects(Number.MAX_SAFE_INTEGER)
    const byKind = new Map<string, { waiting: number; attempts: number; errored: number }>()
    for (const row of rows) {
      const entry = byKind.get(row.kind) ?? { waiting: 0, attempts: 0, errored: 0 }
      entry.waiting += 1
      entry.attempts += row.attempts
      if (row.attempts >= FAILURES_BEFORE_ERROR) entry.errored += 1
      byKind.set(row.kind, entry)
    }
    return [...this.specs.keys()].map(kind => ({
      kind,
      waiting: byKind.get(kind)?.waiting ?? 0,
      running: this.running.get(kind)?.size ?? 0,
      attempts: byKind.get(kind)?.attempts ?? 0,
      errored: byKind.get(kind)?.errored ?? 0,
    }))
  }

  private async pumpOnce(): Promise<void> {
    const budget = 16 + this.totalRunning()
    const candidates = this.store.dueEffects(budget)
    if (candidates.length === 0) return

    const taken = new Map<string, Set<string>>()
    for (const [kind, keys] of this.running) taken.set(kind, new Set(keys))

    const work: Promise<void>[] = []
    for (const row of candidates) {
      const spec = this.specs.get(row.kind)
      const handler = this.handlers.get(row.kind)
      if (!spec || !handler) {
        // A row for a kind this build no longer handles: leave it alone rather than
        // silently destroying someone's pending work.
        continue
      }
      const inFlight = taken.get(row.kind) ?? new Set<string>()
      if (inFlight.size >= spec.limit) continue
      if (spec.ordered) {
        // Ordered kinds run strictly by seq: only the head may start, and only one at a time.
        const head = this.store.effectHead(row.kind)
        if (!head || head.seq !== row.seq) continue
        if (inFlight.size > 0) continue
      }
      inFlight.add(row.key)
      taken.set(row.kind, inFlight)
      work.push(this.runOne(row, spec, handler))
    }
    await Promise.all(work)
  }

  private async runOne(row: EffectRow, spec: EffectKindSpec, handler: EffectHandler): Promise<void> {
    const inFlight = this.running.get(row.kind) ?? new Set<string>()
    inFlight.add(row.key)
    this.running.set(row.kind, inFlight)
    try {
      const value = JSON.parse(row.value) as unknown
      await handler(value, row.key)
      this.store.deleteEffect(row.kind, row.key, row.seq, row.generation)
    } catch (error) {
      if (error instanceof Later) {
        // Not a failure: the work simply cannot start yet.
        const next = Math.max(RETRY_MIN_MS, Number(spec.quiet ? 1_000 : RETRY_MIN_MS))
        this.store.deferEffect(row.kind, row.key, Date.now() + next)
      } else {
        const attempts = row.attempts + 1
        const message = error instanceof Error ? error.message : String(error)
        if (attempts >= FAILURES_BEFORE_ABANDON) {
          // Give up on this intent, but keep the evidence.
          this.store.audit('program', 'effect.abandoned', { kind: row.kind, key: row.key, attempts, error: message })
          this.store.deleteEffect(row.kind, row.key, row.seq, row.generation)
        } else {
          const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.min(attempts, 16))
          this.store.retryEffect(row.kind, row.key, attempts, Date.now() + delay, message)
        }
      }
    } finally {
      inFlight.delete(row.key)
    }
  }

  private totalRunning(): number {
    let total = 0
    for (const keys of this.running.values()) total += keys.size
    return total
  }
}
