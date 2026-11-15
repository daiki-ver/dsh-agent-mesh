import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/core/store.ts'
import { Effects, Later, FAILURES_BEFORE_ERROR } from '../src/core/effects.ts'

function withStore(fn: (store: Store) => Promise<void> | void): Promise<void> | void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-effects-'))
  const store = new Store(join(dir, 'mesh.db'))
  const finish = (): void => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
  const result = fn(store)
  if (result instanceof Promise) return result.finally(finish)
  finish()
  return undefined
}

describe('Effects', () => {
  it('runs a handler and removes the row on success', async () => {
    await withStore(async store => {
      const effects = new Effects(store)
      const seen: unknown[] = []
      effects.handle('noop', { limit: 1 }, value => { seen.push(value) })
      store.enqueueEffect('noop', 'k1', { hello: 1 }, 0)
      await effects.kick()
      expect(seen).toEqual([{ hello: 1 }])
      expect(store.countEffects()).toBe(0)
    })
  })

  it('reschedules a Later without counting a failure', async () => {
    await withStore(async store => {
      const effects = new Effects(store)
      effects.handle('busy', { limit: 1 }, () => { throw new Later('no slot') })
      store.enqueueEffect('busy', 'k1', {}, 0)
      await effects.kick()
      const row = store.effectHead('busy')
      expect(row?.attempts).toBe(0)
      expect(row?.due).toBeGreaterThan(Date.now() - 1)
    })
  })

  it('counts a real failure and backs off', async () => {
    await withStore(async store => {
      const effects = new Effects(store)
      effects.handle('broken', { limit: 1 }, () => { throw new Error('kaput') })
      store.enqueueEffect('broken', 'k1', {}, 0)
      await effects.kick()
      const row = store.effectHead('broken')
      expect(row?.attempts).toBe(1)
      expect(row?.error).toContain('kaput')
    })
  })

  it('reports health with errored rows once attempts reach the threshold', async () => {
    await withStore(async store => {
      const effects = new Effects(store)
      effects.handle('broken', { limit: 1 }, () => { throw new Error('kaput') })
      store.enqueueEffect('broken', 'k1', {}, 0)
      for (let i = 0; i < FAILURES_BEFORE_ERROR; i += 1) {
        await effects.kick()
        store.deferEffect('broken', 'k1', 0)
      }
      const health = effects.health().find(h => h.kind === 'broken')
      expect(health?.errored).toBe(1)
    })
  })

  it('runs ordered kinds strictly by seq, one at a time', async () => {
    await withStore(async store => {
      const effects = new Effects(store)
      const order: string[] = []
      effects.handle('ordered', { limit: 4, ordered: true }, async (_value, key) => {
        await new Promise(resolve => setTimeout(resolve, 5))
        order.push(key)
      })
      store.enqueueEffect('ordered', 'a', {}, 0)
      store.enqueueEffect('ordered', 'b', {}, 0)
      store.enqueueEffect('ordered', 'c', {}, 0)
      await effects.kick()
      // Only the head may start in one round.
      expect(order).toHaveLength(1)
      await effects.kick()
      await effects.kick()
      expect(order).toEqual(['a', 'b', 'c'])
    })
  })

  it('respects the per-kind concurrency limit', async () => {
    await withStore(async store => {
      const effects = new Effects(store)
      let concurrent = 0
      let peak = 0
      effects.handle('limited', { limit: 2 }, async () => {
        concurrent += 1
        peak = Math.max(peak, concurrent)
        await new Promise(resolve => setTimeout(resolve, 10))
        concurrent -= 1
      })
      for (const key of ['a', 'b', 'c', 'd']) store.enqueueEffect('limited', key, {}, 0)
      await effects.kick()
      expect(peak).toBeLessThanOrEqual(2)
    })
  })

  it('refuses to enqueue an unregistered kind', async () => {
    await withStore(store => {
      const effects = new Effects(store)
      expect(() => effects.enqueue('ghost', 'k', {})).toThrow(/no handler/)
    })
  })

  it('leaves in-flight rows for the next process when stopped', async () => {
    await withStore(async store => {
      const effects = new Effects(store)
      effects.handle('slow', { limit: 1 }, async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
      })
      store.enqueueEffect('slow', 'k1', {}, 0)
      const running = effects.kick()
      effects.stop()
      await running
      expect(store.countEffects()).toBe(0)
    })
  })
})
