import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Store } from '../src/core/store.ts'
import { Bus, DEFAULT_PUBLISH_TTL, MAX_BODY_CHARS } from '../src/core/bus.ts'
import { Directory, WORKER_TEMPLATES } from '../src/core/directory.ts'
import { now, type Worker } from '../src/core/model.ts'

function withStore(fn: (store: Store) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-bus-'))
  const store = new Store(join(dir, 'mesh.db'))
  try {
    fn(store)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

function worker(id: string, kind: Worker['kind'], resident = false): Worker {
  return {
    id, kind, sessionId: id, status: 'idle',
    offers: { keywords: [] }, resident, registeredAt: now(),
  }
}

describe('Bus', () => {
  it('writes a message with a monotonic seq', () => {
    withStore(store => {
      const bus = new Bus(store)
      const first = bus.send({ from: 'a', to: 'b', type: 'tell', body: 'one' })
      const second = bus.send({ from: 'a', to: 'b', type: 'tell', body: 'two' })
      expect(second.seq).toBeGreaterThan(first.seq)
    })
  })

  it('truncates an over-long body rather than storing it whole', () => {
    withStore(store => {
      const bus = new Bus(store)
      const message = bus.send({ from: 'a', to: 'b', type: 'tell', body: 'x'.repeat(MAX_BODY_CHARS + 100) })
      expect(message.body.length).toBe(MAX_BODY_CHARS + 1)
      expect(message.body.endsWith('…')).toBe(true)
    })
  })

  it('resolves an explicit recipient and never the sender', () => {
    withStore(store => {
      const bus = new Bus(store)
      store.putWorker(worker('w1', 'coder'))
      store.putWorker(worker('w2', 'coder'))
      const message = bus.send({ from: 'w1', to: 'w2', type: 'tell', body: 'hi' })
      expect(bus.recipients(message).map(w => w.id)).toEqual(['w2'])
    })
  })

  it('resolves a topic to its subscribers', () => {
    withStore(store => {
      const bus = new Bus(store)
      store.putWorker(worker('w1', 'researcher'))
      store.putWorker(worker('w2', 'researcher'))
      store.putThread({
        key: 'topic:risks', topic: 'risks', pending: [], subscribers: ['w2'],
        correlated: [], lastAt: now(),
      })
      const message = bus.send({ from: 'w1', topic: 'risks', type: 'publish', body: 'found one' })
      expect(bus.recipients(message).map(w => w.id)).toEqual(['w2'])
    })
  })

  it('lists pending deliveries and marks them delivered', () => {
    withStore(store => {
      const bus = new Bus(store)
      store.putWorker(worker('w2', 'coder'))
      const message = bus.send({ from: 'w1', to: 'w2', type: 'tell', body: 'hi' })
      expect(bus.pendingDeliveries()).toHaveLength(1)
      bus.markDelivered(message.id, 'w2')
      expect(bus.pendingDeliveries()).toHaveLength(0)
      expect(store.getMessage(message.id)?.state).toBe('delivered')
    })
  })

  it('archives a message instead of deleting it, so the body stays queryable', () => {
    withStore(store => {
      const bus = new Bus(store)
      store.putWorker(worker('w2', 'coder'))
      const message = bus.send({ from: 'w1', to: 'w2', type: 'tell', body: 'keep me' })
      bus.archive(message.id)
      const stored = store.getMessage(message.id)
      expect(stored?.state).toBe('archived')
      expect(stored?.body).toBe('keep me')
    })
  })

  it('archives a publish whose TTL has run out', () => {
    withStore(store => {
      const bus = new Bus(store)
      store.putWorker(worker('w2', 'researcher'))
      const message = bus.send({ from: 'w1', topic: 't', type: 'publish', body: 's', ttl: 1 })
      // One consumption exhausts a TTL of one.
      bus.consumeTopic('t')
      expect(store.getMessage(message.id)?.state).toBe('archived')
    })
  })

  it('defaults a publish TTL to three consumptions', () => {
    withStore(store => {
      const bus = new Bus(store)
      const message = bus.send({ from: 'w1', topic: 't', type: 'publish', body: 's' })
      expect(message.ttl).toBeUndefined()
      bus.consumeTopic('t')
      bus.consumeTopic('t')
      expect(store.getMessage(message.id)?.state).toBe('pending')
      bus.consumeTopic('t')
      expect(store.getMessage(message.id)?.state).toBe('archived')
      expect(DEFAULT_PUBLISH_TTL).toBe(3)
    })
  })

  it('shows a worker its own inbox and not its own messages', () => {
    withStore(store => {
      const bus = new Bus(store)
      store.putWorker(worker('w1', 'coder'))
      store.putWorker(worker('w2', 'coder'))
      bus.send({ from: 'w1', to: 'w2', type: 'tell', body: 'for w2' })
      bus.send({ from: 'w2', to: 'w2', type: 'tell', body: 'to myself' })
      const inbox = bus.inbox('w2')
      expect(inbox.map(m => m.body)).toEqual(['for w2'])
    })
  })
})

describe('Directory', () => {
  it('derives offers from the static template, not from a worker', () => {
    withStore(store => {
      const directory = new Directory(store)
      expect(directory.offersFor('reviewer')).toEqual(
        WORKER_TEMPLATES.find(t => t.kind === 'reviewer')?.keywords,
      )
    })
  })

  it('marks only researcher and coder as resident by default', () => {
    withStore(store => {
      const directory = new Directory(store)
      expect(directory.isResidentKind('researcher')).toBe(true)
      expect(directory.isResidentKind('coder')).toBe(true)
      expect(directory.isResidentKind('reviewer')).toBe(false)
      expect(directory.isResidentKind('ops')).toBe(false)
    })
  })

  it('matches an explicitly named role', () => {
    withStore(store => {
      const directory = new Directory(store)
      directory.register(worker('mesh-reviewer-1', 'reviewer'))
      const result = directory.matchKeyword('@reviewer: is this safe?')
      expect(result.matched?.id).toBe('mesh-reviewer-1')
      expect(result.source).toBe('keyword')
      expect(result.keyword).toBe('reviewer')
    })
  })

  it('matches a bare keyword', () => {
    withStore(store => {
      const directory = new Directory(store)
      // Register through the directory so the worker carries its template offers, which
      // is the only way a real worker ever gets them.
      directory.register(worker('mesh-ops-1', 'ops'))
      const result = directory.matchKeyword('we need to deploy this')
      expect(result.matched?.id).toBe('mesh-ops-1')
    })
  })

  it('defers when nothing matches', () => {
    withStore(store => {
      const directory = new Directory(store)
      store.putWorker(worker('mesh-coder-1', 'coder'))
      const result = directory.matchKeyword('a question about marine biology')
      expect(result.matched).toBeUndefined()
      expect(result.source).toBe('deferred')
    })
  })

  it('falls back to the router pick as the second level', () => {
    withStore(store => {
      const directory = new Directory(store)
      directory.register(worker('mesh-ops-1', 'ops'))
      const result = directory.resolve('marine biology', candidates => candidates[0])
      expect(result.source).toBe('router')
      expect(result.matched?.id).toBe('mesh-ops-1')
    })
  })

  it('registers static offers on a worker, overwriting any self-report', () => {
    withStore(store => {
      const directory = new Directory(store)
      directory.register({ ...worker('mesh-coder-1', 'coder'), offers: { keywords: ['bogus'] } })
      const stored = store.getWorker('mesh-coder-1')
      expect(stored?.offers.keywords).toEqual(directory.offersFor('coder'))
      expect(stored?.offers.keywords).not.toContain('bogus')
    })
  })

  it('skips a stopped worker when matching', () => {
    withStore(store => {
      const directory = new Directory(store)
      store.putWorker({ ...worker('mesh-reviewer-1', 'reviewer'), status: 'stopped' })
      expect(directory.matchKeyword('@reviewer: help').matched).toBeUndefined()
    })
  })
})
