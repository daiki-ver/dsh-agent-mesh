/**
 * The pass loop: a clock and a serializer, nothing more.
 *
 * Every 2 seconds (and immediately when new work arrives) one pass runs. Its whole
 * job is to advance the effect queue and re-check budgets. It holds no business
 * logic, which is why the interval is a fallback beat rather than a correctness
 * guarantee — interactive paths must call `request()` so they never wait for it.
 */

/** What one pass step does. Supplied by the Engine so the loop stays generic. */
export interface PassSteps {
  /** Advance the effect queue. */
  kickEffects: () => Promise<void>
  /** Re-check budget thresholds. */
  checkBudgets: () => void
  /** Report pass health. */
  report: (state: 'ready' | 'error', detail: string) => void
}

/** Passes: the tick. */
export class Passes {
  private timer: ReturnType<typeof setInterval> | undefined
  private pumping: Promise<void> | undefined
  private queued = false
  private started = false
  private stopped = false
  private lastAt = 0
  private lastError = ''

  constructor(
    private readonly steps: PassSteps,
    private readonly intervalMs: number,
  ) {}

  /** Start the interval. Idempotent. */
  start(): void {
    if (this.started || this.stopped) return
    this.started = true
    this.timer = setInterval(() => {
      void this.pump()
    }, this.intervalMs)
    // Do not hold the process open for the beat alone.
    this.timer.unref?.()
  }

  /**
   * Ask for a pass now. This is the interactive path: after a command stores work,
   * call this so the next step does not wait for the interval.
   */
  request(): void {
    if (this.stopped) return
    void this.pump()
  }

  /** Wait until no pass is in flight and the queue has settled. */
  async idle(): Promise<void> {
    while (this.pumping || this.queued) {
      if (this.pumping) await this.pumping
      else await new Promise(resolve => setTimeout(resolve, 10))
    }
  }

  /** Stop the interval and wait for the current pass. */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    await this.idle()
  }

  /** Milliseconds since the last completed pass. Used by the status API. */
  get sinceLastPassMs(): number {
    return this.lastAt === 0 ? -1 : Date.now() - this.lastAt
  }

  /** Last pass error, or empty. */
  get error(): string {
    return this.lastError
  }

  /** True while a pass is running. */
  get running(): boolean {
    return this.pumping !== undefined
  }

  /**
   * Run one pass, coalescing concurrent requests.
   *
   * At most one pass runs at a time and at most one more is queued behind it, so a
   * burst of `request()` calls cannot pile up.
   */
  private async pump(): Promise<void> {
    if (this.stopped) return
    if (this.pumping) {
      this.queued = true
      return this.pumping
    }
    this.pumping = (async () => {
      do {
        this.queued = false
        try {
          await this.steps.kickEffects()
          this.steps.checkBudgets()
          this.lastError = ''
          this.lastAt = Date.now()
          this.steps.report('ready', '')
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error)
          this.steps.report('error', this.lastError)
        }
      } while (this.queued && !this.stopped)
    })().finally(() => {
      this.pumping = undefined
    })
    return this.pumping
  }
}
