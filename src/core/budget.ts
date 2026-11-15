/**
 * The budget ledger.
 *
 * Two rules make this work, and both exist because of one fact: `node:sqlite` is
 * synchronous and `synchronous=FULL` fsyncs on commit. Writing usage inside the
 * `session/event` callback would fsync once per assistant message on the main thread,
 * and every worker shares that thread.
 *
 * 1. **Accumulate in memory, flush per pass.** The event callback only adds numbers to
 *    a map. One pass writes the whole batch in one transaction.
 * 2. **Budgets count cumulative usage, never surface pressure.**
 *    `tokenMeter.measure()` reports how full the current context is, which is a
 *    different quantity. Mixing them makes every threshold meaningless.
 *
 * Losing the last pass's usage on a crash is accepted: a budget is a soft brake, not
 * a ledger of record.
 */

import { type Usage, usageTotal, now } from './model.ts'
import type { Store } from './store.ts'

/** A delta waiting to be flushed. Keyed by scope + scopeId + sessionId. */
type PendingKey = string

/** Thresholds for one coalition. */
export interface CoalitionBudget {
  tokens: number
  used: number
}

/** What a budget check decided for one coalition. */
export type BudgetAction = 'none' | 'soft' | 'hard'

/**
 * Budget: accumulation, flushing, and threshold decisions.
 */
export class Budget {
  private readonly pending = new Map<PendingKey, Usage>()
  private softRatio: number

  constructor(
    private readonly store: Store,
    options: { coalitionSoft?: number } = {},
  ) {
    this.softRatio = options.coalitionSoft ?? 0.8
  }

  /**
   * Record one usage delta in memory. Called from the `session/event` listener, so it
   * must stay allocation-only: no IO, no transaction, no await.
   */
  record(scope: Usage['scope'], scopeId: string, sessionId: string, delta: Partial<Omit<Usage, 'scope' | 'scopeId' | 'sessionId' | 'updatedAt'>>): void {
    const key = `${scope}\u0000${scopeId}\u0000${sessionId}`
    const current = this.pending.get(key)
    const next: Usage = current ?? {
      scope, scopeId, sessionId,
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      updatedAt: now(),
    }
    next.inputTokens += Math.max(0, Math.trunc(delta.inputTokens ?? 0))
    next.outputTokens += Math.max(0, Math.trunc(delta.outputTokens ?? 0))
    next.cacheReadTokens += Math.max(0, Math.trunc(delta.cacheReadTokens ?? 0))
    next.cacheWriteTokens += Math.max(0, Math.trunc(delta.cacheWriteTokens ?? 0))
    next.reasoningTokens += Math.max(0, Math.trunc(delta.reasoningTokens ?? 0))
    next.updatedAt = now()
    this.pending.set(key, next)
  }

  /** How many deltas are waiting. Used by health. */
  get pendingCount(): number {
    return this.pending.size
  }

  /**
   * Write everything accumulated so far in one transaction.
   * @returns total tokens written in this flush.
   */
  flush(): number {
    if (this.pending.size === 0) return 0
    const rows = [...this.pending.values()]
    this.pending.clear()
    const result = this.store.flushUsage(rows)
    return result.totalTokens
  }

  /** Cumulative tokens charged to a scope. */
  used(scope: Usage['scope'], scopeId: string): number {
    // Include not-yet-flushed deltas so a threshold check does not lag a pass behind.
    const flushed = this.store.usedTokens(scope, scopeId)
    let inMemory = 0
    for (const row of this.pending.values()) {
      if (row.scope === scope && row.scopeId === scopeId) inMemory += usageTotal(row)
    }
    return flushed + inMemory
  }

  /**
   * Decide what a coalition's budget calls for.
   *
   * At `softRatio` (default 80%) remaining rounds collapse into one; at 100% the group
   * must dissolve and produce its summary.
   */
  check(budget: CoalitionBudget): BudgetAction {
    if (budget.tokens <= 0) return 'none'
    const ratio = budget.used / budget.tokens
    if (ratio >= 1) return 'hard'
    if (ratio >= this.softRatio) return 'soft'
    return 'none'
  }

  /** Decide what a ticket's budget calls for. A ticket blocks; it does not dissolve. */
  checkTicket(budget: CoalitionBudget): 'none' | 'blocked' {
    if (budget.tokens <= 0) return 'none'
    return budget.used / budget.tokens >= 1 ? 'blocked' : 'none'
  }

  /** All usage rows, for the status API. */
  report(): Usage[] {
    return this.store.listUsage()
  }
}
