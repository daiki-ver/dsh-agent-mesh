/**
 * The capability directory.
 *
 * Two halves with different sources, which is the whole design:
 *
 * - **offers** are static. They come from the worker template table in code, are
 *   registered at startup, and never drift. A worker cannot inflate its own listing.
 * - **needs** are runtime. A worker discovers mid-task that it lacks a specialty and
 *   asks. The Engine matches that text against the static offers.
 *
 * Matching is **two levels plus an explicit fallback**, not three:
 *
 * 1. **Keyword** — the worker names a role directly (`@reviewer: ...`). Zero inference.
 * 2. **Router** — nothing matched, so a light model gets the need text plus the
 *    directory. Costs a little.
 * 3. **Deferred** — even the Router found nothing. The need is parked on the thread
 *    instead of blocking the asker, because an advisory ask is not a gate.
 *
 * The cost story matters and is easy to misstate: this is **not** "discovery costs
 * zero tokens". The `@role:` convention is written into every worker's prompt, so the
 * grammar is prepaid on every request, and deciding *whether* and *whom* to ask is one
 * inference the worker already performs. What is free is the *matching* itself.
 */

import type { Worker, WorkerKind } from './model.ts'
import type { Store } from './store.ts'

/** The static template for one kind. `keywords` are what a need can name. */
export interface WorkerTemplate {
  kind: WorkerKind
  keywords: string[]
  resident: boolean
}

/**
 * The capability table. This is the "org chart": who exists and what each is for.
 *
 * It is code, not configuration, because it must not drift and must cost nothing at
 * runtime. Adding a kind means editing this table and the preset together.
 */
export const WORKER_TEMPLATES: readonly WorkerTemplate[] = [
  { kind: 'researcher', keywords: ['research', 'survey', 'docs', 'investigate', 'compare'], resident: true },
  { kind: 'coder', keywords: ['implement', 'refactor', 'debug', 'test', 'fix'], resident: true },
  { kind: 'reviewer', keywords: ['review', 'decision', 'gate', 'arbitrate', 'verify'], resident: false },
  { kind: 'ops', keywords: ['deploy', 'env', 'ci', 'cleanup', 'infra'], resident: false },
]

/** Where a match came from. */
export type MatchSource = 'keyword' | 'router' | 'deferred'

/** Result of trying to satisfy a need. */
export interface MatchResult {
  matched: Worker | undefined
  source: MatchSource
  /** The keyword that hit, when `source` is `keyword`. */
  keyword?: string
}

/**
 * Directory: static offers, runtime needs.
 */
export class Directory {
  constructor(private readonly store: Store) {}

  /** The offers for one kind, or an empty list for a kind with no template. */
  offersFor(kind: WorkerKind): string[] {
    return WORKER_TEMPLATES.find(t => t.kind === kind)?.keywords ?? []
  }

  /** Whether a kind is meant to stay resident. */
  isResidentKind(kind: WorkerKind): boolean {
    return WORKER_TEMPLATES.find(t => t.kind === kind)?.resident ?? false
  }

  /** Every kind the directory knows. */
  kinds(): WorkerKind[] {
    return WORKER_TEMPLATES.map(t => t.kind)
  }

  /**
   * Level 1: keyword match. The need text names a role explicitly.
   *
   * The convention is `@<kind>:` or a bare keyword. Matching is deliberately literal:
   * no stemming, no scoring. A near-miss falls through to the Router, which is the
   * right place for judgement.
   */
  matchKeyword(needs: string): MatchResult {
    const text = needs.toLowerCase()
    const workers = this.store.listWorkers().filter(w => w.status !== 'stopped')

    // Explicit naming wins: `@reviewer:` or `@review:`.
    const explicit = /@([a-z]+)\s*:/.exec(text)
    if (explicit?.[1]) {
      const token = explicit[1]
      const byKind = workers.find(w => w.kind === token)
      if (byKind) return { matched: byKind, source: 'keyword', keyword: token }
    }

    // Otherwise the first keyword that appears in the text.
    for (const worker of workers) {
      for (const keyword of worker.offers.keywords) {
        if (text.includes(keyword.toLowerCase())) {
          return { matched: worker, source: 'keyword', keyword }
        }
      }
    }
    return { matched: undefined, source: 'deferred' }
  }

  /**
   * Resolve a need to a worker.
   *
   * `routerPick` is supplied by the caller when it has already asked the Router; this
   * keeps the Directory free of any model dependency while still letting the Engine
   * run the three-step order.
   */
  resolve(needs: string, routerPick?: (candidates: Worker[]) => Worker | undefined): MatchResult {
    const keyword = this.matchKeyword(needs)
    if (keyword.matched) return keyword
    if (routerPick) {
      const picked = routerPick(this.store.listWorkers().filter(w => w.status !== 'stopped'))
      if (picked) return { matched: picked, source: 'router' }
    }
    return { matched: undefined, source: 'deferred' }
  }

  /** Register a worker's static offers. Never called with runtime self-reports. */
  register(worker: Worker): void {
    const offers = this.offersFor(worker.kind)
    this.store.putWorker({ ...worker, offers: { keywords: offers } })
  }

  /** A compact directory listing for a Router prompt or a `mesh_read`. */
  listing(): { kind: WorkerKind; keywords: string[]; workers: string[] }[] {
    const workers = this.store.listWorkers()
    return WORKER_TEMPLATES.map(template => ({
      kind: template.kind,
      keywords: template.keywords,
      workers: workers.filter(w => w.kind === template.kind).map(w => w.id),
    }))
  }
}
