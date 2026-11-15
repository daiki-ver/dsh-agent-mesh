import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store, SCHEMA_VERSION } from '../src/core/store.ts'
import { now, type Usage } from '../src/core/model.ts'

function withStore(fn: (store: Store, dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-store-'))
  const store = new Store(join(dir, 'mesh.db'))
  try {
    fn(store, dir)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('Store', () => {
  it('creates the schema and records its version', () => {
    withStore(store => {
      expect(store.kvGet('store.schema')).toBe(String(SCHEMA_VERSION))
    })
  })

  it('reopens an existing database without recreating it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mesh-store-'))
    const path = join(dir, 'mesh.db')
    const first = new Store(path)
    first.kvSet('probe', 'kept')
    first.close()

    const second = new Store(path)
    expect(second.kvGet('probe')).toBe('kept')
    expect(second.kvGet('store.schema')).toBe(String(SCHEMA_VERSION))
    second.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rolls back the whole transaction on throw', () => {
    withStore(store => {
      expect(() => store.atomic(() => {
        store.kvSet('a', '1')
        throw new Error('boom')
      })).toThrow('boom')
      expect(store.kvGet('a')).toBeUndefined()
    })
  })

  it('commits an inner savepoint failure without losing the outer work', () => {
    withStore(store => {
      store.atomic(() => {
        store.kvSet('outer', 'kept')
        expect(() => store.atomic(() => {
          store.kvSet('inner', 'dropped')
          throw new Error('inner')
        })).toThrow('inner')
      })
      expect(store.kvGet('outer')).toBe('kept')
      expect(store.kvGet('inner')).toBeUndefined()
    })
  })

  it('drops after-commit callbacks when the transaction rolls back', () => {
    withStore(store => {
      let ran = 0
      expect(() => store.atomic(() => {
        store.afterCommit(() => { ran += 1 })
        throw new Error('boom')
      })).toThrow()
      expect(ran).toBe(0)
    })
  })

  it('runs after-commit callbacks only once the outermost transaction commits', () => {
    withStore(store => {
      const order: string[] = []
      store.atomic(() => {
        store.afterCommit(() => order.push('commit'))
        store.atomic(() => {
          store.afterCommit(() => order.push('inner'))
          order.push('inner-body')
        })
        order.push('outer-body')
      })
      expect(order).toEqual(['inner-body', 'outer-body', 'commit', 'inner'])
    })
  })

  it('keeps audit append-only and counts by kind', () => {
    withStore(store => {
      store.audit('router', 'ticket.create', { ticket: 't1' })
      store.audit('router', 'ticket.create', { ticket: 't2' })
      store.audit('worker', 'gate.open', { gate: 'g1' })
      expect(store.countAudit('ticket.create')).toBe(2)
      expect(store.countAudit('gate.open')).toBe(1)
      expect(store.listAudit(1)[0]?.kind).toBe('gate.open')
    })
  })

  it('flushes a usage batch in one transaction and accumulates across flushes', () => {
    withStore(store => {
      const row = (input: number, output: number): Usage => ({
        scope: 'ticket', scopeId: 't1', sessionId: 's1',
        inputTokens: input, outputTokens: output,
        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
        updatedAt: now(),
      })
      const first = store.flushUsage([row(100, 20), row(1, 2)])
      expect(first.totalTokens).toBe(123)
      store.flushUsage([row(10, 5)])
      expect(store.usedTokens('ticket', 't1')).toBe(138)
      expect(store.listUsage({ scope: 'ticket', scopeId: 't1' })).toHaveLength(1)
    })
  })

  it('refreshes an enqueued effect in place and bumps its generation', () => {
    withStore(store => {
      store.enqueueEffect('deliver', 'k1', { n: 1 }, 0)
      const first = store.effectHead('deliver')
      expect(first?.generation).toBe(0)
      store.enqueueEffect('deliver', 'k1', { n: 2 }, 0)
      const second = store.effectHead('deliver')
      expect(second?.generation).toBe(1)
      expect(JSON.parse(second?.value ?? '{}')).toEqual({ n: 2 })
      expect(store.countEffects()).toBe(1)
    })
  })

  it('refuses to delete an effect whose intent was refreshed', () => {
    withStore(store => {
      store.enqueueEffect('deliver', 'k1', { n: 1 }, 0)
      const stale = store.effectHead('deliver')!
      store.enqueueEffect('deliver', 'k1', { n: 2 }, 0)
      // The old generation must not remove the refreshed row.
      expect(store.deleteEffect('deliver', 'k1', stale.seq, stale.generation)).toBe(false)
      expect(store.countEffects()).toBe(1)
    })
  })

  it('exposes generated working-set columns', () => {
    withStore(store => {
      const base = {
        id: 't1', title: 'x',
        spec: {
          title: 'x', workerKind: 'coder' as const, goal: 'g',
          boundaries: [], acceptance: [], gates: [], coalitionScript: [], routingNote: '',
        },
        origin: { triggerIds: [], human: true },
        mandate: 'explicit' as const,
        assignments: [], inputs: [], undelivered: [], follows: [], gates: [],
        stage: 'working' as const,
        createdAt: now(), updatedAt: now(),
      }
      store.putTicket(base)
      expect(store.listTickets(true).map(t => t.id)).toEqual(['t1'])
      store.putTicket({ ...base, stage: 'ended', ended: { at: now(), by: 'worker', outcome: 'completed' } })
      expect(store.listTickets(true)).toHaveLength(0)
    })
  })
})
